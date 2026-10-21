import { getRaceGoalContext, raceGoalSummary } from '../race-goals'
import { listRacePlans } from '../race-plans'
import { raceResearchLines, researchRacePlan } from '../race-research'
import { z } from 'zod'

import type { ChatContextInput, ContextProvider } from './types'

/**
 * 相对今天的距离标注(Asia/Shanghai)。
 *
 * Reason: 赛事日期过去之后,模型极易把"下个月18号"这类原话按今天重新推算、再把已过去的
 * 日期顺移到下个月 —— 线上就出现过把 10-18 说成 11-18(2026-10-20 的对话)。把"已过去 N 天"
 * 显式写在日期旁边,模型没有顺移的空间。
 *
 * today 取注入值(与 prompt 里「今天」同一来源),评测/回放才可复现;解析失败回落真实时钟。
 */
function todayShanghai(injected?: string): string {
  const fromInjected = injected?.match(/\d{4}-\d{2}-\d{2}/)?.[0]
  if (fromInjected) return fromInjected
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date())
}

function dateTag(date: string | null, today: string): string {
  if (!date) return ''
  const diff = Math.round((Date.parse(date) - Date.parse(today)) / 86400000)
  if (!Number.isFinite(diff)) return ''
  if (diff === 0) return '（今天）'
  if (diff > 0) return `（还有 ${diff} 天）`
  return `（已过去 ${-diff} 天）`
}

/** 比赛目标(迁自 chat.ts goalLines)。data.goalLines 供回复落库/快照复用。 */
export const raceGoalsProvider: ContextProvider = {
  key: 'goals',
  priority: 60,
  load: async (input: ChatContextInput) => {
    const today = todayShanghai(input?.today)
    const [goals, plans] = await Promise.all([getRaceGoalContext(20), listRacePlans()])
    const goalLines = goals.map(goal => `${raceGoalSummary(goal)}；日期 ${goal.raceDate}${dateTag(goal.raceDate, today)}；${goal.distanceMeters / 1000} 公里；目标 ${goal.targetType}${goal.targetTimeSec ? ` ${goal.targetTimeSec} 秒` : ''}；优先级 ${goal.priority}`)
    const planLines = plans.flatMap(plan => [
      `用户赛事计划 ${plan.id}：${plan.name}；${plan.raceDate ?? '日期待确认'}${dateTag(plan.raceDate, today)}；${plan.city ?? '地点待确认'}；${plan.distanceMeters == null ? '距离待确认' : `${plan.distanceMeters / 1000} 公里`}；${plan.status}`,
      // 原话要保留(可追溯),但必须说明"已换算":否则模型会拿今天重算「下个月18号」。
      ...plan.evidence.slice(-2).map(evidence => `用户来源 ${evidence.source}，消息 ${evidence.messageId}，发送于 ${evidence.messageCreatedAt}，日期参考 ${evidence.dateReference ?? '未知'}；原话（其中相对日期已按发送时间换算成上面的绝对日期，勿按今天重算）：${JSON.stringify(evidence.quote)}`),
      ...raceResearchLines(plan.research),
    ])
    const upcoming = plans.filter(plan => plan.status === 'active' && plan.raceDate).sort((a, b) => a.raceDate!.localeCompare(b.raceDate!))
    const undated = plans.filter(plan => plan.status === 'active' && !plan.raceDate)
    // Reason: 模型会把用户原话里的「隔一周」「下周」当事实,和倒计时拼出互斥的时间线
    // (线上:南宁 29 天后 +「下周的成都赛」+「两场隔 7 天」)。修法是补事实,不是加守则:
    // 每场的倒计时计划行里已有(dateTag),这里只补它缺的两样 —— 场次间隔、日期待确认标记。
    // 间隔与周次的最终防线在 evaluator 的 checkRaceSchedule(硬校验,不占 prompt)。
    const gapLines = upcoming.slice(1).map((plan, index) => {
      const days = Math.round((Date.parse(plan.raceDate!) - Date.parse(upcoming[index].raceDate!)) / 86400000)
      return `- ${upcoming[index].name} → ${plan.name} 相隔 ${days} 天（按绝对日期算的间隔，回答先后/间隔用这个数，别用原话里的「隔一周」）`
    })
    const undatedLines = undated.map(plan => `- ${plan.name}：日期待确认（没有倒计时/周次可讲）`)
    return {
      key: 'goals',
      title: '# 比赛目标',
      lines: [
        ...(goalLines.length ? goalLines.map(line => `- ${line}`) : ['- 无正式目标']),
        ...planLines,
        ...gapLines,
        ...undatedLines,
      ],
      data: { goalLines, plans },
    }
  },
  tools: [{
    name: 'query_race_details',
    description: '查询已保存的赛事计划及带来源的路线、海拔、累计爬升、坡段、补给和关门时间。无参数列出计划及缓存；planId 查询单场并在缺资料时联网查证，refresh 可重新查询。sourceUrls 可提供用户给出的资料页链接。',
    inputSchema: { type: 'object', properties: {
      planId: { type: 'string' }, refresh: { type: 'boolean' },
      sourceUrls: { type: 'array', items: { type: 'string' }, maxItems: 6 },
    } },
  }],
  executeTool: async (_name, input) => {
    const parsed = z.object({ planId: z.string().optional(), refresh: z.boolean().optional(), sourceUrls: z.array(z.string().url()).max(6).optional() }).safeParse(input)
    if (!parsed.success) return JSON.stringify({ error: '赛事查询参数无效' })
    try {
      if (!parsed.data.planId) return JSON.stringify({ plans: await listRacePlans() })
      return JSON.stringify(await researchRacePlan(parsed.data.planId, { force: parsed.data.refresh, sourceUrls: parsed.data.sourceUrls }))
    } catch (error) {
      return JSON.stringify({ error: (error as Error).message })
    }
  },
}
