/**
 * 活动导入路由(全部挂在 /api/activities 下)。
 *
 * POST /api/activities/import —— 通用活动导入入口(一等公民)。
 * 无第三方账号(Keep/Strava)的用户可直接构造 RawActivity(单个或数组)喂入,
 * 复用 ingest processor.syncActivity 按 (source, sourceId) 去重后写 activities + splits。
 * 这是 standalone「零第三方账号也能进数据」的默认通路,配合 POST /api/health/daily(Apple 健康)。
 *
 * 鉴权:admin 会话 或 Bearer HEALTH_IMPORT_TOKEN(与健康上报同一把 token,复用 withHealthImportAuth)。
 */
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'

import { getDb } from '@/lib/db/client'
import { activities } from '@/lib/db/schema'
import type { RawActivity } from '@/lib/ingest/adapters/base'
import { syncActivity } from '@/lib/ingest/processor'
import { withHealthImportAuth } from '@/middleware/auth'

const activitiesRoutes = new Hono()

const ACTIVITY_TYPES = ['running', 'cycling', 'walking', 'swimming', 'other'] as const
type ActivityType = (typeof ACTIVITY_TYPES)[number]

/** 宽松取正数值(容忍字符串数字);无效返回 undefined。 */
function optionalNumber(value: unknown): number | undefined {
  if (value == null || value === '') return undefined
  const num = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(num) ? num : undefined
}

/**
 * 把请求体中的一条原始记录规整为 RawActivity。
 * startTime 支持 ISO 字符串或 epoch 毫秒;缺关键字段则抛错(由调用端计入 errors)。
 */
function coerceRawActivity(input: unknown): RawActivity {
  if (typeof input !== 'object' || input == null) {
    throw new Error('activity must be an object')
  }
  const o = input as Record<string, unknown>

  const id = typeof o.id === 'string' && o.id.trim() ? o.id.trim() : ''
  if (!id) throw new Error('activity.id (source id) is required')

  const source = typeof o.source === 'string' && o.source.trim() ? o.source.trim() : ''
  if (!source) throw new Error('activity.source is required')

  // startTime:ISO 字符串或 epoch 毫秒。
  const rawStart = o.startTime
  const startTime =
    rawStart instanceof Date
      ? rawStart
      : typeof rawStart === 'number'
        ? new Date(rawStart)
        : typeof rawStart === 'string' && rawStart.trim()
          ? new Date(rawStart.trim())
          : null
  if (!startTime || Number.isNaN(startTime.getTime())) {
    throw new Error('activity.startTime must be an ISO string or epoch milliseconds')
  }

  const type: ActivityType = ACTIVITY_TYPES.includes(o.type as ActivityType)
    ? (o.type as ActivityType)
    : 'running'

  const distance = optionalNumber(o.distance) ?? 0
  const duration = optionalNumber(o.duration) ?? 0
  const title =
    typeof o.title === 'string' && o.title.trim() ? o.title.trim() : `${source} activity ${id}`

  return {
    id,
    source,
    title,
    type,
    isIndoor: typeof o.isIndoor === 'boolean' ? o.isIndoor : undefined,
    startTime,
    duration,
    distance,
    gpxData: typeof o.gpxData === 'string' && o.gpxData ? o.gpxData : undefined,
    averagePace: optionalNumber(o.averagePace),
    bestPace: optionalNumber(o.bestPace),
    elevationGain: optionalNumber(o.elevationGain),
    averageHeartRate: optionalNumber(o.averageHeartRate),
    maxHeartRate: optionalNumber(o.maxHeartRate),
    calories: optionalNumber(o.calories),
  }
}

activitiesRoutes.post('/import', withHealthImportAuth, async c => {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  // 单个对象或数组皆可。数组里也允许包一层 { activities: [...] }。
  const rawList: unknown[] = Array.isArray(body)
    ? body
    : typeof body === 'object' && body != null && Array.isArray((body as Record<string, unknown>).activities)
      ? ((body as Record<string, unknown>).activities as unknown[])
      : [body]

  if (rawList.length === 0) {
    return c.json({ error: 'request body must contain at least one activity' }, 400)
  }

  const db = await getDb()
  let imported = 0
  let skipped = 0
  const errors: string[] = []

  for (const raw of rawList) {
    let activity: RawActivity
    try {
      activity = coerceRawActivity(raw)
    } catch (error) {
      skipped++
      errors.push((error as Error).message)
      continue
    }

    try {
      // Reason: 先查重以给出准确的 imported/skipped 计数;syncActivity 内部也会再去重(幂等,无害)。
      const existing = await db
        .select({ id: activities.id })
        .from(activities)
        .where(and(eq(activities.source, activity.source), eq(activities.sourceId, activity.id)))
        .limit(1)

      if (existing.length > 0) {
        skipped++
        continue
      }

      await syncActivity(activity)
      imported++
    } catch (error) {
      skipped++
      errors.push(`${activity.source}:${activity.id} → ${(error as Error).message}`)
    }
  }

  return c.json({ imported, skipped, ...(errors.length > 0 ? { errors } : {}) })
})

export default activitiesRoutes
