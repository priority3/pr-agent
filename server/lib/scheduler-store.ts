/**
 * 定时任务的运行时配置与执行历史。
 *
 * 职责划分:job 清单(id / 显示名 / 默认 cron / handler)是**代码**的事,住在
 * scheduler.ts 的 DEFAULT_JOBS;这里只管「用户改过什么」与「跑过什么」。
 * 因此新增或删掉一个 job 不需要任何迁移,表里的孤儿行读的时候直接忽略。
 *
 * cron 的三级优先:面板改的(DB) > 部署时给的(CRON_<ID> env) > 代码默认。
 * DB 排在 env 前面是刻意的 —— 面板上改完必须真生效,否则又是个「保存成功但没用」
 * 的假开关(admin 侧曾经踩过这个坑)。返回 source 字段让面板能标出当前值来自哪。
 */
import { CronExpressionParser } from 'cron-parser'
import cron from 'node-cron'

import { getActivitiesClient } from './db/client'

/** 每个 job 保留的执行历史条数。 */
export const JOB_RUN_HISTORY_LIMIT = 10

export type CronSource = 'db' | 'env' | 'default'

export interface JobRun {
  startedAt: number
  durationMs: number | null
  ok: boolean
  message: string | null
}

export interface JobOverride {
  cronExpression: string | null
  enabled: boolean
}

/**
 * 调度器生效的时区。
 *
 * Reason: 不传 timezone 时 node-cron 用**进程本地时区**,而容器里 TZ 通常没设 = UTC,
 * 于是「0 21 * * *」会在北京时间凌晨 5 点触发 —— 这是个真实踩过的坑。这里显式化:
 * 由 SCHEDULER_TIMEZONE 决定,缺省回落进程时区(即保持既有行为,不静默改变已部署实例的
 * 触发时刻),并把最终值透出给面板,让人看得见 cron 是按哪个时区解释的。
 */
export function schedulerTimezone(): string {
  const explicit = (process.env.SCHEDULER_TIMEZONE || '').trim()
  if (explicit) return explicit
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

/** 读全部覆盖行,按 job id 索引。表不存在或读失败时返回空表(降级为纯代码默认)。 */
export async function loadOverrides(): Promise<Map<string, JobOverride>> {
  const out = new Map<string, JobOverride>()
  try {
    const client = await getActivitiesClient()
    const res = await client.execute('SELECT id, cron_expression, enabled FROM scheduler_jobs')
    for (const row of res.rows) {
      out.set(String(row.id), {
        cronExpression: row.cron_expression == null ? null : String(row.cron_expression),
        enabled: Boolean(row.enabled),
      })
    }
  } catch (err) {
    console.warn(`[Scheduler] 读取 job 覆盖失败,回落代码默认: ${(err as Error).message}`)
  }
  return out
}

/**
 * 解析某个 job 最终生效的 cron 与它的来源。
 * 非法表达式一律忽略并降级到下一级,避免一个笔误让 job 静默消失。
 */
export function resolveCron(
  id: string,
  fallback: string,
  override?: JobOverride,
): { expression: string; source: CronSource } {
  const fromDb = override?.cronExpression?.trim()
  if (fromDb) {
    if (cron.validate(fromDb)) return { expression: fromDb, source: 'db' }
    console.warn(`[Scheduler] 忽略非法 cron(来自面板) ${id}=${fromDb}`)
  }

  const fromEnv = process.env[`CRON_${id.toUpperCase()}`]?.trim()
  if (fromEnv) {
    if (cron.validate(fromEnv)) return { expression: fromEnv, source: 'env' }
    console.warn(`[Scheduler] 忽略非法 cron 覆盖 CRON_${id.toUpperCase()}=${fromEnv}`)
  }

  return { expression: fallback, source: 'default' }
}

/** 按当前时区算下次触发时刻(unix 秒);表达式非法则返回 null。 */
export function nextRunAt(expression: string): number | null {
  try {
    const it = CronExpressionParser.parse(expression, { tz: schedulerTimezone() })
    return Math.floor(it.next().getTime() / 1000)
  } catch {
    return null
  }
}

/** 写入一条执行记录,并把该 job 的历史裁到 JOB_RUN_HISTORY_LIMIT 条。 */
export async function recordJobRun(
  jobId: string,
  run: { startedAt: number; durationMs: number; ok: boolean; message: string },
): Promise<void> {
  try {
    const client = await getActivitiesClient()
    await client.execute({
      sql: `INSERT INTO scheduler_job_runs (job_id, started_at, duration_ms, ok, message)
            VALUES (?, ?, ?, ?, ?)`,
      args: [jobId, run.startedAt, run.durationMs, run.ok ? 1 : 0, run.message.slice(0, 500)],
    })
    // Reason: 只留最近 N 条 —— 面板只展示这么多,无上限增长没意义还会拖慢查询。
    await client.execute({
      sql: `DELETE FROM scheduler_job_runs
            WHERE job_id = ?
              AND id NOT IN (
                SELECT id FROM scheduler_job_runs WHERE job_id = ?
                ORDER BY started_at DESC, id DESC LIMIT ?
              )`,
      args: [jobId, jobId, JOB_RUN_HISTORY_LIMIT],
    })
  } catch (err) {
    // 记账失败不能影响任务本身 —— 任务已经跑完了。
    console.warn(`[Scheduler] 记录 ${jobId} 执行历史失败: ${(err as Error).message}`)
  }
}

/** 取某批 job 的执行历史(新→旧)。 */
export async function loadRuns(jobIds: string[]): Promise<Map<string, JobRun[]>> {
  const out = new Map<string, JobRun[]>()
  if (!jobIds.length) return out
  try {
    const client = await getActivitiesClient()
    const placeholders = jobIds.map(() => '?').join(', ')
    const res = await client.execute({
      sql: `SELECT job_id, started_at, duration_ms, ok, message FROM scheduler_job_runs
            WHERE job_id IN (${placeholders}) ORDER BY started_at DESC, id DESC`,
      args: jobIds,
    })
    for (const row of res.rows) {
      const id = String(row.job_id)
      const list = out.get(id) ?? []
      if (list.length >= JOB_RUN_HISTORY_LIMIT) continue
      list.push({
        startedAt: Number(row.started_at),
        durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
        ok: Boolean(row.ok),
        message: row.message == null ? null : String(row.message),
      })
      out.set(id, list)
    }
  } catch (err) {
    console.warn(`[Scheduler] 读取执行历史失败: ${(err as Error).message}`)
  }
  return out
}

/** 写入覆盖(部分更新);两个字段都不给则什么也不做。 */
export async function saveOverride(
  id: string,
  patch: { cronExpression?: string | null; enabled?: boolean },
): Promise<void> {
  const client = await getActivitiesClient()
  const sets: string[] = []
  const args: Array<string | number | null> = []

  if (patch.cronExpression !== undefined) {
    sets.push('cron_expression = ?')
    args.push(patch.cronExpression)
  }
  if (patch.enabled !== undefined) {
    sets.push('enabled = ?')
    args.push(patch.enabled ? 1 : 0)
  }
  if (!sets.length) return

  // 先保证行存在(默认 enabled=1),再打补丁 —— 免得 UPDATE 打在不存在的行上静默无效。
  await client.execute({
    sql: 'INSERT OR IGNORE INTO scheduler_jobs (id, cron_expression, enabled) VALUES (?, NULL, 1)',
    args: [id],
  })
  await client.execute({
    sql: `UPDATE scheduler_jobs SET ${sets.join(', ')}, updated_at = unixepoch() WHERE id = ?`,
    args: [...args, id],
  })
}
