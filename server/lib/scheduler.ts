/**
 * 调度器(单用户自部署版)。
 *
 * 从源仓 src/lib/scheduler.ts + scheduler-config.ts 移植,去 admin 耦合:
 * - job 配置改静态 DEFAULT_JOBS(不建 scheduler_jobs 表、不读 admin.db);cron 可被同名 env 覆盖。
 * - 去掉 recordJobRun(scheduler_jobs 表不在 standalone schema),改控制台日志记录。
 * - 只保留 PR-agent 相关 job;删掉 admin 专属的 insights(ai.ts 未移植)/daily_report(访问分析)。
 * - 不含运动数据同步:直采 Keep/Strava 的职责归 runPaceFlow-admin(它写 activities,本进程读同一个库)。
 *   活动进入本进程的通路是 POST /api/activities/import —— 谁来喂都行,不绑定具体数据源。
 * - 显式 startScheduler()(server 启动时调),替代源仓"首个 GET /api/health 懒启动"。
 * - 总开关 PR_SCHEDULER(默认开;off/false/0 = 一个 job 都不注册),供共库部署用,见下。
 */
import cron from 'node-cron'

import { dispatchPendingNotifications } from './notifications/dispatcher'
import { generateDailyReview } from './pr/daily'
import { generateFriendDiary } from './pr/diary'
import { reconcileMemories, runMemoryMaintenance } from './pr/memory'
import { projectPersona } from './pr/persona'
import { generatePrReviewsForActivities } from './pr/review'
import { reclaimStaleRuns } from './pr/state'
import { generateWeeklyReview } from './pr/weekly'
import { getRuntimeSetting, getRuntimeSettings } from './config'
import { cleanupOldData } from './retention'

let schedulerStarted = false
let scheduledTasks: cron.ScheduledTask[] = []

// ─── Jobs ─────────────────────────────────────────────────────────────────

async function jobPrDailyReview() {
  console.log('[Scheduler] Running PR daily reflection job...')
  const startTime = Date.now()
  try {
    const result = await generateDailyReview({ enqueueNotification: true })
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
    console.log(
      `[Scheduler] pr_daily_review ${result.generated ? 'generated' : 'skipped'}: ${result.subjectId} in ${elapsed}s`,
    )
  } catch (err) {
    console.warn(`[Scheduler] pr_daily_review error: ${(err as Error).message}`)
  }
}

async function jobWeeklyReview() {
  console.log('[Scheduler] Running PR weekly review job...')
  const startTime = Date.now()
  try {
    const result = await generateWeeklyReview({ enqueueNotification: true })
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
    console.log(
      `[Scheduler] weekly_review ${result.generated ? 'generated' : 'skipped'}: ${result.subjectId} in ${elapsed}s`,
    )
  } catch (err) {
    console.warn(`[Scheduler] weekly_review error: ${(err as Error).message}`)
  }
}

async function jobFriendDiary() {
  console.log('[Scheduler] Running PR friend diary job...')
  const startTime = Date.now()
  try {
    const result = await generateFriendDiary()
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
    console.log(
      `[Scheduler] friend_diary ${result.generated ? 'generated' : 'skipped'}: ${result.learnedMemoryIds.length} memories in ${elapsed}s`,
    )
  } catch (err) {
    console.warn(`[Scheduler] friend_diary error: ${(err as Error).message}`)
  }
}

async function jobMemoryMaintenance() {
  console.log('[Scheduler] Running PR memory maintenance job...')
  const startTime = Date.now()
  try {
    // 先确定性衰减陈旧条目,再让 LLM 语义调和冗余/矛盾(调和失败不影响衰减结果)。
    const decay = await runMemoryMaintenance()
    // 默认 dry-run:PR_MEMORY_RECONCILE_APPLY 未开时只把建议打进日志、不写库。
    const applyFlag = (await getRuntimeSetting('PR_MEMORY_RECONCILE_APPLY').catch(() => '')).toLowerCase()
    const applyReconcile = ['1', 'true', 'yes', 'on'].includes(applyFlag)
    const reconcile = await reconcileMemories({ apply: applyReconcile }).catch(err => {
      console.warn('[Scheduler] memory reconcile failed:', (err as Error).message)
      return { proposed: 0, applied: 0, dryRun: !applyReconcile }
    })
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
    console.log(
      `[Scheduler] memory_maintenance: decay ${decay.decayed}/${decay.scanned}, reconcile ${reconcile.applied}/${reconcile.proposed}${reconcile.dryRun ? ' (dry-run)' : ''} in ${elapsed}s`,
    )
  } catch (err) {
    console.warn(`[Scheduler] memory_maintenance error: ${(err as Error).message}`)
  }
}

async function jobNotificationDispatch() {
  console.log('[Scheduler] Running PR notification dispatch job...')
  const startTime = Date.now()
  try {
    const result = await dispatchPendingNotifications(10)
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
    console.log(
      `[Scheduler] notification_dispatch: ${result.sent} sent, ${result.failed} failed, ${result.skipped} skipped in ${elapsed}s`,
    )
  } catch (err) {
    console.warn(`[Scheduler] notification_dispatch error: ${(err as Error).message}`)
  }
}

async function jobRetentionCleanup() {
  console.log('[Scheduler] Running retention cleanup job...')
  const startTime = Date.now()
  try {
    const result = await cleanupOldData()
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
    console.log(
      `[Scheduler] retention_cleanup: deleted ${result.deleted} rows (retention ${result.retentionDays}d) in ${elapsed}s`,
    )
  } catch (err) {
    console.warn(`[Scheduler] retention_cleanup error: ${(err as Error).message}`)
  }
}

// 数字分身投影兜底:事件驱动为主(projectFriendProfile 尾部挂钩);此处日更一次,
// 让 daysUntilRace / 训练负荷这类"随日期自然变化"的 state.* 不依赖记忆变更也能刷新。
async function jobPersonaProjection() {
  console.log('[Scheduler] Running persona projection job...')
  try {
    const result = await projectPersona()
    console.log(`[Scheduler] persona_projection ${result.updated ? `updated (${result.events} trait events)` : 'skipped (input unchanged)'}`)
  } catch (err) {
    console.warn(`[Scheduler] persona_projection error: ${(err as Error).message}`)
  }
}

// ─── 静态 job 配置 ──────────────────────────────────────────────────────────

interface JobDef {
  id: string
  name: string
  cron: string
  handler: () => Promise<void>
}

// 单用户静态配置(替代源仓 admin.db 的 scheduler_jobs 表)。cron 可被 CRON_<ID> env 覆盖。
const DEFAULT_JOBS: JobDef[] = [
  // 事件驱动(健康上报触发)为主;此处是缺失时的正午幂等兜底。
  { id: 'pr_daily_review', name: 'PR 每日反思(兜底)', cron: '0 12 * * *', handler: jobPrDailyReview },
  { id: 'weekly_review', name: 'PR 周总结', cron: '0 20 * * 0', handler: jobWeeklyReview },
  // 老友日记:每周日 21:31(周总结之后),把本周脉络蒸馏成日记 + 候选记忆 → 刷新画像。
  { id: 'friend_diary', name: 'PR 老友日记', cron: '31 21 * * 0', handler: jobFriendDiary },
  // 记忆维护:每天 3:33 衰减长期无新证据的弱候选/陈旧习惯。
  { id: 'memory_maintenance', name: 'PR 记忆维护(衰减/新鲜度)', cron: '33 3 * * *', handler: jobMemoryMaintenance },
  // 数字分身投影兜底:每天 3:47(记忆维护之后,顺带吸收其衰减结果)。
  { id: 'persona_projection', name: 'PR 数字分身投影(兜底)', cron: '47 3 * * *', handler: jobPersonaProjection },
  { id: 'notification_dispatch', name: 'PR 通知分发', cron: '*/10 * * * *', handler: jobNotificationDispatch },
  { id: 'retention_cleanup', name: '数据保留清理', cron: '0 3 * * 0', handler: jobRetentionCleanup },
]

/** cron 表达式:优先取 CRON_<ID> env(校验通过才用),否则用静态默认。 */
function resolveCron(id: string, fallback: string): string {
  const override = process.env[`CRON_${id.toUpperCase()}`]
  if (override && cron.validate(override)) return override
  if (override) console.warn(`[Scheduler] 忽略非法 cron 覆盖 CRON_${id.toUpperCase()}=${override}`)
  return fallback
}

/**
 * 调度总开关。默认开启(独立自部署时后台任务必须自己跑)。
 *
 * Reason: 与宿主(如 runPaceFlow-admin)共用同一个库部署时,宿主那边已经在跑同一批任务
 * (晨间反思/周总结/日记/记忆维护/通知派发/清理),两边都跑 = 同一份数据被复盘两遍、
 * 通知推两次。此时把 PR_SCHEDULER 设成 off,本进程只当 HTTP + agent 服务。
 */
function isSchedulerDisabled(): boolean {
  const flag = (process.env.PR_SCHEDULER ?? '').trim().toLowerCase()
  return ['off', 'false', '0'].includes(flag)
}

function setupJobs() {
  for (const task of scheduledTasks) task.stop()
  scheduledTasks = []

  const jobs: JobDef[] = [...DEFAULT_JOBS]

  for (const job of jobs) {
    const expr = resolveCron(job.id, job.cron)
    const task = cron.schedule(expr, job.handler)
    scheduledTasks.push(task)
    console.log(`[Scheduler] Registered "${job.name}" with cron: ${expr}`)
  }
}

export async function startScheduler() {
  if (schedulerStarted) return
  schedulerStarted = true

  // 启动即收回上次进程崩溃遗留的孤儿 run(status='running' 太久),避免它们永久卡住。
  // Reason: 这是启动时的一次性修复,不是定时任务 —— 幂等、便宜,且对本进程自己崩溃遗留的
  // run 也该负责,所以**不受 PR_SCHEDULER 开关影响**(否则关了调度就没人清,即便是
  // 用外部 cron 驱动的独立部署)。共库时与宿主重复执行也无害(只是把超时的锁清掉)。
  try {
    const reclaimed = await reclaimStaleRuns()
    if (reclaimed > 0) console.log(`[Scheduler] Reclaimed ${reclaimed} stale running agent run(s)`)
  } catch (err) {
    console.warn('[Scheduler] reclaimStaleRuns failed:', (err as Error).message)
  }

  if (isSchedulerDisabled()) {
    console.log(
      `[Scheduler] Disabled by PR_SCHEDULER=${process.env.PR_SCHEDULER} - 不注册任何定时任务(共库部署时交由宿主调度)`,
    )
    return
  }

  setupJobs()
  console.log('[Scheduler] Started - static single-user job config')
}

/** 重载调度(env 改动后可调;单用户场景一般无需)。 */
export function reloadScheduler() {
  if (isSchedulerDisabled()) {
    console.log('[Scheduler] PR_SCHEDULER=off - 跳过重载')
    return
  }

  setupJobs()
  console.log('[Scheduler] Reloaded')
}
