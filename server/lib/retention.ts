/**
 * 数据保留清理(单用户自部署版)。
 *
 * Reason: 源仓 retention.cleanupOldData 清的是 admin 专有的 page_views(访问分析),该表不在
 * standalone 24 表 schema 里。抽离后改清 PR-owned 的 agent_state_snapshots —— 每次 agent run
 * 逐步落的调试状态,随运行无界增长且非业务数据,按天数窗口裁剪即可控制库体积。
 * 窗口由 PR_RETENTION_DAYS 覆盖(默认 90)。
 */
import { getActivitiesClient } from '@/lib/db/client'

const DEFAULT_RETENTION_DAYS = 90

export interface RetentionResult {
  deleted: number
  retentionDays: number
}

export async function cleanupOldData(): Promise<RetentionResult> {
  const parsed = Number(process.env.PR_RETENTION_DAYS)
  const retentionDays = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RETENTION_DAYS
  const cutoff = Math.floor(Date.now() / 1000) - retentionDays * 86400

  const client = await getActivitiesClient()
  const result = await client.execute({
    sql: 'DELETE FROM agent_state_snapshots WHERE created_at < ?',
    args: [cutoff],
  })

  return { deleted: result.rowsAffected ?? 0, retentionDays }
}
