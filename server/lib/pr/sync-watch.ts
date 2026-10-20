/**
 * 同步观察者:把「后台同步的结果」送回对话里。
 *
 * 因果链(为什么要它):对话里说「同步一下」触发的是 admin 侧的慢同步,pr-agent 的
 * sync_activities 工具 20 秒就超时返回 pending。同步真正落地在这之后 —— 此前这条线就断在
 * 这里:模型只能说「还在拉」,系统里没有任何机制在结果到位后回来说一声。外发推送(pushplus)
 * 已整体下线,唯一可用的投递面就是对话本身,所以在结果落地后往该会话写一条 PR 消息。
 *
 * 观察方式:与 admin 共库部署时直接读 activities 表(本轮同步写入的行 createdAt 必定晚于
 * 触发时刻),不引入跨服务回调。独立部署(各写各的库)时读不到新行,会按「没有新记录」如实
 * 收尾 —— 不撒谎,只是能力受限,注释在此说明以免后人误判。
 *
 * 单用户单进程:状态放内存即可,进程重启丢一次观察(用户可以再说一次「同步一下」)。
 * 落库始终只有一条(terminal 守卫),失败只记日志。
 */
import { eq, gte } from 'drizzle-orm'

import { getActivitiesDb } from '@/lib/db/client'
import { activities, conversationMessages, conversationThreads } from '@/lib/db/schema'
import { generateId } from '@/lib/utils'

import { writeSnapshot } from './chat-background'

/** 轮询间隔:同步本身是几十秒级,8 秒足够及时且不压库。 */
const POLL_INTERVAL_MS = 8_000
/** 观察上限:超过就收尾说清(默认 6 分钟,可用 PR_SYNC_WATCH_TIMEOUT_MS 覆盖)。 */
const DEFAULT_DEADLINE_MS = 6 * 60 * 1000

interface ActiveWatch {
  threadId: string
  runId: string
  /** 只看 createdAt 晚于此刻的行 —— 同步是这次调用触发的,写入必然晚于它。 */
  since: Date
  deadline: number
  timer: ReturnType<typeof setTimeout> | null
  /** 至少成功读过一次库:用于区分「确实没有新记录」与「库压根没读通」。 */
  queryOk: boolean
  done: boolean
}

const watches = new Map<string, ActiveWatch>()

function deadlineMs(): number {
  const configured = Number(process.env.PR_SYNC_WATCH_TIMEOUT_MS)
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_DEADLINE_MS
}

function clearWatch(watch: ActiveWatch) {
  if (watch.timer) clearTimeout(watch.timer)
  watch.timer = null
  watch.done = true
  if (watches.get(watch.threadId) === watch) watches.delete(watch.threadId)
}

function shanghaiStamp(date: Date): string {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(date)
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
  return `${day.slice(5)} ${time}`
}

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
  return `${minutes}:${String(secs).padStart(2, '0')}`
}

function formatPace(secondsPerKm: number | null): string | null {
  if (!secondsPerKm || !Number.isFinite(secondsPerKm)) return null
  const mins = Math.floor(secondsPerKm / 60)
  const secs = Math.round(secondsPerKm % 60)
  return `${mins}'${String(secs).padStart(2, '0')}"/km`
}

function typeLabel(type: string): string {
  if (type === 'cycling') return '骑'
  if (type === 'walking') return '走'
  return '跑'
}

function metricsLine(row: {
  distance: number
  duration: number
  averagePace: number | null
}): string {
  const parts = [`${(row.distance / 1000).toFixed(2)} km`]
  if (row.duration > 0) parts.push(formatDuration(row.duration))
  const pace = formatPace(row.averagePace)
  if (pace) parts.push(pace)
  return parts.join(' · ')
}

function activityLine(row: {
  type: string
  distance: number
  duration: number
  averagePace: number | null
  startTime: Date
}): string {
  return `${typeLabel(row.type)} · ${metricsLine(row)}`
}

/** 结果文案:确定性模板,不调模型 —— 投递要快、要准,不能因为 LLM 抖动而迟到或改口。 */
function composeSuccessText(
  rows: Array<{ title: string; type: string; distance: number; duration: number; averagePace: number | null; startTime: Date }>,
): string {
  const sorted = [...rows].sort((a, b) => b.startTime.getTime() - a.startTime.getTime())
  if (sorted.length === 1) {
    const row = sorted[0]
    return `同步好了 —— ${shanghaiStamp(row.startTime)} 那次${typeLabel(row.type)}记进来了：${metricsLine(row)}。`
  }
  const lines = sorted.slice(0, 5).map(row => `· ${activityLine(row)}`)
  return `同步好了，进来 ${sorted.length} 条：\n${lines.join('\n')}`
}

/**
 * 往会话里写一条 PR 的消息(主动投递)。
 * contextJson 标 proactive,便于事后区分「用户在问 / PR 主动说」——面板与排查都要用。
 */
async function deliver(threadId: string, runId: string, content: string, meta: Record<string, unknown>) {
  const db = await getActivitiesDb()
  const now = new Date()
  await db.insert(conversationMessages).values({
    id: generateId('msg'),
    threadId,
    runId,
    role: 'assistant',
    content,
    contextJson: JSON.stringify({ proactive: true, kind: 'sync_watch', ...meta }),
  })
  // 会话列表按 lastMessageAt 排序:不更新的话这条主动消息会把会话沉下去,用户根本看不到。
  await db
    .update(conversationThreads)
    .set({ lastMessageAt: now, updatedAt: now })
    .where(eq(conversationThreads.id, threadId))
}

async function finishSuccess(watch: ActiveWatch, rows: Awaited<ReturnType<typeof queryNewActivities>>) {
  const text = composeSuccessText(rows)
  clearWatch(watch)
  try {
    await deliver(watch.threadId, watch.runId, text, { activityIds: rows.map(row => row.id) })
    await writeSnapshot(watch.runId, 'sync_watch_result', {
      delivered: rows.length,
      activityIds: rows.map(row => row.id),
    }).catch(() => {})
  } catch (error) {
    console.warn('[sync-watch] 投递失败:', (error as Error).message)
  }
}

async function finishEmpty(watch: ActiveWatch) {
  const text = watch.queryOk
    ? '同步跑完了，但没有新记录 —— 手表那边可能还没上传。过会儿你再说一声「同步一下」，我再拉一次。'
    : '同步那边我没确认到结果，过会儿你再说一声「同步一下」，我再拉一次。'
  clearWatch(watch)
  try {
    await deliver(watch.threadId, watch.runId, text, { delivered: 0, queryOk: watch.queryOk })
    await writeSnapshot(watch.runId, 'sync_watch_result', { delivered: 0, queryOk: watch.queryOk }).catch(() => {})
  } catch (error) {
    console.warn('[sync-watch] 投递失败:', (error as Error).message)
  }
}

async function queryNewActivities(since: Date) {
  const db = await getActivitiesDb()
  return db
    .select({
      id: activities.id,
      title: activities.title,
      type: activities.type,
      distance: activities.distance,
      duration: activities.duration,
      averagePace: activities.averagePace,
      startTime: activities.startTime,
    })
    .from(activities)
    .where(gte(activities.createdAt, since))
    .limit(10)
}

async function tick(watch: ActiveWatch) {
  if (watch.done) return
  watch.timer = null
  let rows: Awaited<ReturnType<typeof queryNewActivities>> = []
  try {
    rows = await queryNewActivities(watch.since)
    watch.queryOk = true
  } catch (error) {
    console.warn('[sync-watch] 查询新活动失败:', (error as Error).message)
  }
  if (watch.done) return
  if (rows.length > 0) {
    await finishSuccess(watch, rows)
    return
  }
  if (Date.now() >= watch.deadline) {
    await finishEmpty(watch)
    return
  }
  watch.timer = setTimeout(() => void tick(watch), POLL_INTERVAL_MS)
}

/**
 * 登记一次同步观察。同一会话重复登记时以后者为准(清掉旧的,避免两条消息都落)。
 * 返回观察截止时间,供工具文案说明「大约多久内会回你」。
 */
export function registerSyncWatch(input: { threadId: string; runId: string }): { deadlineMs: number } | null {
  const existing = watches.get(input.threadId)
  if (existing) clearWatch(existing)

  const window = deadlineMs()
  const watch: ActiveWatch = {
    threadId: input.threadId,
    runId: input.runId,
    // Reason: 少退 5 秒 —— 工具调用与登记之间有几十毫秒到几秒的差(模型生成 + 落库),
    // 卡在登记时刻会把同步最初写进去的那条漏掉。
    since: new Date(Date.now() - 5_000),
    deadline: Date.now() + window,
    timer: null,
    queryOk: false,
    done: false,
  }
  watches.set(input.threadId, watch)
  watch.timer = setTimeout(() => void tick(watch), POLL_INTERVAL_MS)
  return { deadlineMs: window }
}

/** 仅供测试与排查:当前是否有观察在跑。 */
export function hasActiveSyncWatch(threadId: string): boolean {
  return watches.has(threadId)
}
