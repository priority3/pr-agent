/**
 * 同步触发:让 PR 在对话里现拉一次最新运动数据。
 *
 * 这是唯一一个**会产生副作用**的工具 —— 其余 provider 的工具全是只读查询。
 *
 * Reason: 同步的执行体不在本仓(见 89bdcad:同步职责归 admin),但依赖方向是
 * admin → pr-agent 单向,本仓反过来认识 admin 会把这个方向搞成环、也毁掉「单跑」的
 * 定位。所以这里只认一个 webhook URL + token:对面是 admin 还是别的什么、同步的是
 * Keep 还是 Strava,本仓一概不知道 —— URL 指向哪儿就同步什么。未配置时工具压根不
 * 出现在清单里(见下面的 getter),模型也就不会承诺自己做不到的事。
 */
import type { PrModelToolSpec } from '../model'

import { queryActivityContext } from '../context'
import { getChatTurn, markChatTurnWatchRegistered } from '../chat-turn'
import { registerSyncWatch } from '../sync-watch'
import type { ContextProvider } from './types'

/** 同步是慢操作(拉外部 API + 写库 + 触发复盘),但对话不能陪着一起挂。 */
const CALL_TIMEOUT_MS = 20_000
/** 冷却窗口:防模型一轮里反复调、也防连说几句把上游账号打进风控。 */
const COOLDOWN_MS = 60_000

/** 上一次调用的时刻与结果摘要(单用户单进程,内存态足够;重启后重来无妨)。 */
let lastCall: { at: number; summary: string } | null = null

function webhookUrl(): string {
  return (process.env.SYNC_WEBHOOK_URL ?? '').trim()
}

const SYNC_TOOL: PrModelToolSpec = {
  name: 'sync_activities',
  description:
    '立刻去拉一次最新的运动数据(手表/APP 侧新记录同步进库)。用户说「同步一下」「拉一下最新的」「更新下数据」「刚跑完怎么还没有」时用它。返回是条数(没有新行入库时会同时带上库里最新一条,用来核对「他说的那次」在不在库)。说具体某条的距离配速要调 query_activities 查。慢操作,可能十几秒;返回 pending 表示还在后台跑、没跑完 —— 这时按返回里的 note 说:note 说已登记观察,就可以告诉他「等好了我来说一声」;没登记就只能让他过一会儿回来再问一次。任何情况下都别说已经拉好了,也别把「没有新行」说成「手表没上传」。',
  inputSchema: { type: 'object', properties: {} },
}

export const syncProvider: ContextProvider = {
  key: 'sync',
  priority: 90,
  // 这一路不产出上下文区块,只提供工具。
  load: async () => null,

  // Reason: 用 getter 而不是静态数组 —— 未配 SYNC_WEBHOOK_URL 的部署(比如独立
  // 自部署,压根没有同步上游)不该让模型看见这个工具,否则它会答应下来然后失败。
  get tools(): PrModelToolSpec[] {
    return webhookUrl() ? [SYNC_TOOL] : []
  },

  executeTool: async () => {
    const url = webhookUrl()
    if (!url) return JSON.stringify({ ok: false, error: '本部署没有配置同步入口' })

    // 冷却期内直接回上次结果,不再打上游。
    if (lastCall && Date.now() - lastCall.at < COOLDOWN_MS) {
      const agoSec = Math.round((Date.now() - lastCall.at) / 1000)
      return JSON.stringify({
        ok: true,
        skipped: true,
        note: `${agoSec} 秒前刚同步过,这次没有重复拉。上次结果:${lastCall.summary}`,
      })
    }

    const token = (process.env.SYNC_WEBHOOK_TOKEN ?? '').trim()
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ limit: 50 }),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      })

      if (!response.ok) {
        // 上游的错误原文对模型有用(「Keep 登录失败」比「HTTP 401」好解释),但只取一小段。
        const detail = (await response.text().catch(() => '')).slice(0, 200)
        return JSON.stringify({
          ok: false,
          error: `同步入口返回 ${response.status}${detail ? `:${detail}` : ''}`,
        })
      }

      const json = (await response.json().catch(() => ({}))) as {
        success?: boolean
        count?: number
        errorMessage?: string
      }
      if (json.success === false) {
        return JSON.stringify({ ok: false, error: json.errorMessage || '上游报告同步失败' })
      }

      const count = typeof json.count === 'number' ? json.count : 0
      lastCall = {
        at: Date.now(),
        summary: count > 0 ? `拉到 ${count} 条新记录` : '这次没有新的入库行',
      }
      if (count > 0) {
        return JSON.stringify({
          ok: true,
          count,
          note: '新记录已入库;要说具体哪次跑了多少,调 query_activities 查。',
        })
      }

      // Reason: count=0 只代表「这次没有新行写进库」，他刚跑的那次往往早就同步过了。
      // 这里必须把库里最新一条一起带回去 —— 否则模型只能照着 note 猜「手表还没上传」，
      // 而上下文里又明明列着那次，同一段话里前后打架（线上真实事故）。
      const latest = await queryActivityContext({ limit: 1 }).catch(() => [])
      const latestRow = latest[0]
      return JSON.stringify({
        ok: true,
        count: 0,
        latest: latestRow
          ? {
              date: latestRow.date,
              daysAgo: latestRow.daysAgo,
              type: latestRow.type,
              distanceKm: latestRow.distanceKm,
              durationMin: latestRow.durationMin,
              pace: latestRow.paceText ? `${latestRow.paceText}/km` : null,
              avgHeartRate: latestRow.avgHeartRate,
            }
          : null,
        note: latestRow
          ? `同步成功,但这次没有新行入库 —— 常见原因是这条之前已经同步过了,不等于手表没上传。库里最新的仍是 ${latestRow.date} 那次 ${latestRow.distanceKm} km。他问「刚跑那次怎么样」就直接按库里这条答,别说「还没上传」。`
          : '同步成功,这次没有新行入库,库里也没有任何记录 —— 可以如实说没查到新的。',
      })
    } catch (error) {
      // Reason: 超时不等于失败 —— 请求已经打过去了,上游会自己跑完(客户端断连不会
      // 中止它的处理)。所以标 pending 而不是 error,让模型说「正在拉」而不是「拉失败了」。
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
        lastCall = { at: Date.now(), summary: '上次那趟还在后台跑' }
        // 同步真正落地在这 20s 超时之后 —— 登记一次观察,结果到了由 sync-watch 往本会话回一条。
        // Reason: 只有这样「等好了我来说一声」才是**能兑现**的承诺;登记不上就退回如实说做不了。
        const turn = getChatTurn()
        const watch = turn ? registerSyncWatch({ threadId: turn.threadId, runId: turn.runId }) : null
        if (watch) markChatTurnWatchRegistered()
        return JSON.stringify({
          ok: true,
          pending: true,
          note: watch
            ? '同步已经开始,还没跑完。结果落地后我会主动在这个会话里回你一条 —— 就照这个意思说(别夸大成"随时盯"),他要愿意也可以先聊聊别的。'
            : '同步已经开始,但还没跑完(数据多的时候会慢)。让他过一会儿回来再问一次 —— 别说已经拉好了,也别承诺你会主动告诉他结果。',
        })
      }
      return JSON.stringify({
        ok: false,
        error: `连不上同步入口:${error instanceof Error ? error.message : '未知错误'}`,
      })
    }
  },
}
