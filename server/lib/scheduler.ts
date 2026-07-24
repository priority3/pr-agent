/**
 * 调度器(单用户自部署版)。
 *
 * 从源仓 src/lib/scheduler.ts + scheduler-config.ts 移植,去 admin 耦合:
 * - job 配置改静态 DEFAULT_JOBS(不建 scheduler_jobs 表、不读 admin.db);cron 可被同名 env 覆盖。
 * - 去掉 recordJobRun(scheduler_jobs 表不在 standalone schema),改控制台日志记录。
 * - 只保留 PR-agent 相关 job;删掉 admin 专属的 insights(ai.ts 未移植)/daily_report(访问分析)。
 * - sync(Keep/Strava)属 P4b:performSync 尚未移植 → 仅当数据源 env 配置时以 no-op+warn 占位注册,
 *   默认不注册,保证 tsc/启动不因缺 performSync 失败。
 * - 显式 startScheduler()(server 启动时调),替代源仓"首个 GET /api/health 懒启动"。
 */
import cron from 'node-cron'

import { dispatchPendingNotifications } from './notifications/dispatcher'
import { generateDailyReview } from './pr/daily'
import { generateFriendDiary } from './pr/diary'
import { reconcileMemories, runMemoryMaintenance } from './pr/memory'
import { reclaimStaleRuns } from './pr/state'
import { generateWeeklyReview } from './pr/weekly'
import { getRuntimeSetting } from './config'
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

// P4b 占位:数据源适配器(Keep/Strava 的 performSync)尚未移植。仅当数据源 env 配置时注册,
// 且这里只 warn 不做实事,保证不拖入未移植依赖、不因缺 performSync 编译/启动失败。
async function jobSync() {
  console.warn('[Scheduler] sync 数据源适配器未接(P4b 待接),本次跳过')
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

/** 是否配置了活动数据源(决定是否注册 P4b 的 sync job)。 */
function isSyncConfigured(): boolean {
  return Boolean(process.env.SYNC_SOURCE || process.env.KEEP_MOBILE || process.env.STRAVA_REFRESH_TOKEN)
}

function setupJobs() {
  for (const task of scheduledTasks) task.stop()
  scheduledTasks = []

  const jobs: JobDef[] = [...DEFAULT_JOBS]
  // sync 是可选数据源 job(P4b);仅当配置了数据源才注册,默认不注册。
  if (isSyncConfigured()) {
    jobs.push({ id: 'sync', name: '运动数据同步(P4b 占位)', cron: '0 * * * *', handler: jobSync })
  }

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
  try {
    const reclaimed = await reclaimStaleRuns()
    if (reclaimed > 0) console.log(`[Scheduler] Reclaimed ${reclaimed} stale running agent run(s)`)
  } catch (err) {
    console.warn('[Scheduler] reclaimStaleRuns failed:', (err as Error).message)
  }

  setupJobs()
  console.log('[Scheduler] Started - static single-user job config')
}

/** 重载调度(env 改动后可调;单用户场景一般无需)。 */
export function reloadScheduler() {
  setupJobs()
  console.log('[Scheduler] Reloaded')
}
