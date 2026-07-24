/**
 * 同步服务:协调「拉取数据源 → 写库」的流程。
 * 移植自源仓 src/lib/sync/service.ts,按 standalone 收敛边界改造:
 * - Nike/Garmin 剔除(死/stub) → 仅保留 Keep / Strava 两个 opt-in 适配器。
 * - 凭据来源改 env(经 config.getRuntimeSettings),不建/不读 userProfile 表。
 * - 不建 syncLogs 表:同步 run 日志改 console(保持 24 表 schema 不变)。
 * - 不引 race-matcher(Playwright 依赖不移植);增量游标仍基于 activities 表最新 startTime。
 */
import { desc, eq } from 'drizzle-orm'

import { getDb } from '@/lib/db/client'
import { activities } from '@/lib/db/schema'
import { getRuntimeSettings } from '@/lib/config'
import { generateId } from '@/lib/utils'

import type { SyncAdapter } from './adapters/base'
import { KeepAdapter } from './adapters/keep'
import { StravaAdapter } from './adapters/strava'
import { syncActivities } from './processor'

export type SyncSource = 'strava' | 'keep'

/**
 * 同步选项
 */
export interface SyncOptions {
  /** 数据源 */
  source: SyncSource
  /** 开始日期 */
  startDate?: Date
  /** 结束日期 */
  endDate?: Date
  /** 限制数量 */
  limit?: number
  /** 全量同步:忽略增量游标,从头拉 limit 条(默认 false = 增量) */
  fullSync?: boolean
}

/**
 * 同步结果
 */
export interface SyncResult {
  /** 是否成功 */
  success: boolean
  /** 同步的活动数量 */
  activitiesCount: number
  /** 本轮同步涉及的活动 ID */
  activityIds: string[]
  /** 错误信息 */
  errorMessage?: string
  /** 同步 run 标识(仅日志用,不落库) */
  logId: string
}

/**
 * 判断某数据源的凭据是否已在 env 中配置(调用端可据此决定是否触发同步)。
 */
export function isSourceCredentialed(source: SyncSource, settings: Record<string, string>): boolean {
  switch (source) {
    case 'strava':
      return Boolean(
        settings.STRAVA_CLIENT_ID && settings.STRAVA_CLIENT_SECRET && settings.STRAVA_REFRESH_TOKEN,
      )
    case 'keep':
      return Boolean(settings.KEEP_MOBILE && settings.KEEP_PASSWORD)
    default:
      return false
  }
}

/**
 * 创建适配器实例(凭据全部来自 env via settings)。
 * @param source 数据源
 * @param settings 运行时配置(process.env 快照)
 * @returns 适配器实例
 */
export function createAdapter(source: SyncSource, settings: Record<string, string>): SyncAdapter {
  switch (source) {
    case 'strava': {
      const clientId = settings.STRAVA_CLIENT_ID
      const clientSecret = settings.STRAVA_CLIENT_SECRET
      const refreshToken = settings.STRAVA_REFRESH_TOKEN
      if (!clientId || !clientSecret || !refreshToken) {
        throw new Error(
          'No OAuth credentials found for strava (需配 STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET / STRAVA_REFRESH_TOKEN)',
        )
      }
      return new StravaAdapter(clientId, clientSecret, refreshToken)
    }
    case 'keep': {
      const mobile = settings.KEEP_MOBILE
      const password = settings.KEEP_PASSWORD
      if (!mobile || !password) {
        throw new Error('No credentials found for keep (需配 KEEP_MOBILE / KEEP_PASSWORD)')
      }
      return new KeepAdapter(mobile, password)
    }
    default: {
      throw new Error(`Unknown sync source: ${source}`)
    }
  }
}

/**
 * 执行数据同步
 * @param options 同步选项
 * @returns 同步结果
 */
export async function performSync(options: SyncOptions): Promise<SyncResult> {
  const { source, startDate, endDate, limit, fullSync } = options
  const db = await getDb()
  const settings = await getRuntimeSettings({ force: true })

  // Reason: syncLogs 表不在 standalone 24 表 schema 中,run 日志改 console(不落库)。
  const logId = generateId('log')
  const startedAt = new Date()
  console.info(`[sync] start source=${source} run=${logId} at ${startedAt.toISOString()}`)

  try {
    // 创建适配器(凭据来自 env)
    const adapter = createAdapter(source, settings)

    // 健康检查
    const isHealthy = await adapter.healthCheck()
    if (!isHealthy) {
      throw new Error(`${source} service is not available`)
    }

    // Reason: 真增量同步 —— 查库内该 source 最新活动的 startTime 作为 after 游标,
    // 只拉游标之后的新活动。库空(首次)或 fullSync 时不传游标,退化为全量拉 limit 条。
    let after: number | undefined
    if (!fullSync && !startDate) {
      const latest = await db
        .select({ startTime: activities.startTime })
        .from(activities)
        .where(eq(activities.source, source))
        .orderBy(desc(activities.startTime))
        .limit(1)
      if (latest.length > 0 && latest[0].startTime) {
        // +1 秒避免把最新那条自己又拉回来
        after = Math.floor(latest[0].startTime.getTime() / 1000) + 1
        console.info(`[sync] 增量游标 after=${after} (${latest[0].startTime.toISOString()})`)
      } else {
        console.info(`[sync] 库内无 ${source} 活动,执行首次全量同步`)
      }
    }

    // 获取活动列表（传入 after 游标 + 拉详情前去重回调,最大化省请求）
    console.info(`Fetching activities from ${source}...`)
    const rawActivities = await adapter.getActivities({
      startDate,
      endDate,
      limit,
      after,
      // 拉详情前按 sourceId 查重:库里已有就跳过,避免浪费详情/streams 请求
      shouldFetchDetail: async (sourceId: string) => {
        const existing = await db
          .select({ id: activities.id })
          .from(activities)
          .where(eq(activities.sourceId, sourceId))
          .limit(1)
        return existing.length === 0
      },
    })

    console.info(`Found ${rawActivities.length} activities from ${source}`)

    // 同步活动到数据库
    const activityIds = await syncActivities(rawActivities)

    const elapsed = ((Date.now() - startedAt.getTime()) / 1000).toFixed(1)
    console.info(
      `[sync] done source=${source} run=${logId}: ${activityIds.length} new activities in ${elapsed}s`,
    )

    return {
      success: true,
      activitiesCount: activityIds.length,
      activityIds,
      logId,
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    console.error(`[sync] failed source=${source} run=${logId}:`, errorMessage)

    return {
      success: false,
      activitiesCount: 0,
      activityIds: [],
      errorMessage,
      logId,
    }
  }
}
