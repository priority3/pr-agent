import { desc, eq } from 'drizzle-orm'

import { getActivitiesDb } from '@/lib/db/client'
import { healthDailyMetrics } from '@/lib/db/schema'
import { generateId } from '@/lib/utils'

export interface HealthDailyMetricInput {
  date: string
  sleepMinutes?: number | null
  deepSleepMinutes?: number | null
  remSleepMinutes?: number | null
  hrv?: number | null
  restingHr?: number | null
  steps?: number | null
  envAudioDb?: number | null
  source?: string
  payload?: unknown
}

export interface HealthDailyMetricContext {
  id: string
  date: string
  sleepMinutes: number | null
  deepSleepMinutes: number | null
  remSleepMinutes: number | null
  hrv: number | null
  restingHr: number | null
  steps: number | null
  envAudioDb: number | null
  source: string
  payload: unknown
  recoveryLabel: 'good' | 'okay' | 'poor' | 'unknown'
}

function recoveryLabel(input: {
  sleepMinutes: number | null
  hrv: number | null
  restingHr: number | null
}) {
  // 睡眠是恢复标签的锚点:没有睡眠数据就无法判定恢复(避免把"没戴表"误判成 poor)。
  if (input.sleepMinutes == null) return 'unknown'
  if (input.sleepMinutes >= 420 && (input.hrv ?? 0) >= 60) return 'good'
  if (input.sleepMinutes >= 360) return 'okay'
  return 'poor'
}

function toContext(row: typeof healthDailyMetrics.$inferSelect): HealthDailyMetricContext {
  const sleepMinutes = row.sleepMinutes == null ? null : Number(row.sleepMinutes)
  const hrv = row.hrv == null ? null : Number(row.hrv)
  const restingHr = row.restingHr == null ? null : Number(row.restingHr)
  return {
    id: row.id,
    date: row.date,
    sleepMinutes,
    deepSleepMinutes: row.deepSleepMinutes == null ? null : Number(row.deepSleepMinutes),
    remSleepMinutes: row.remSleepMinutes == null ? null : Number(row.remSleepMinutes),
    hrv,
    restingHr,
    steps: row.steps == null ? null : Number(row.steps),
    envAudioDb: row.envAudioDb == null ? null : Number(row.envAudioDb),
    source: row.source,
    payload: row.payloadJson ? JSON.parse(row.payloadJson) : null,
    recoveryLabel: recoveryLabel({ sleepMinutes, hrv, restingHr }),
  }
}

/**
 * Idempotently upserts one day's recovery metrics keyed by (date, source).
 * Returns the stored row so callers get the persisted id (which, on update,
 * is the original row's id — not a newly generated one).
 */
export async function upsertHealthDailyMetric(
  input: HealthDailyMetricInput,
): Promise<HealthDailyMetricContext> {
  const db = await getActivitiesDb()
  const id = generateId('health')
  const [row] = await db
    .insert(healthDailyMetrics)
    .values({
      id,
      date: input.date,
      sleepMinutes: input.sleepMinutes ?? null,
      deepSleepMinutes: input.deepSleepMinutes ?? null,
      remSleepMinutes: input.remSleepMinutes ?? null,
      hrv: input.hrv ?? null,
      restingHr: input.restingHr ?? null,
      steps: input.steps ?? null,
      envAudioDb: input.envAudioDb ?? null,
      source: input.source ?? 'healthkit',
      payloadJson: input.payload == null ? null : JSON.stringify(input.payload),
    })
    .onConflictDoUpdate({
      target: [healthDailyMetrics.date, healthDailyMetrics.source],
      set: {
        sleepMinutes: input.sleepMinutes ?? null,
        deepSleepMinutes: input.deepSleepMinutes ?? null,
        remSleepMinutes: input.remSleepMinutes ?? null,
        hrv: input.hrv ?? null,
        restingHr: input.restingHr ?? null,
        steps: input.steps ?? null,
        envAudioDb: input.envAudioDb ?? null,
        payloadJson: input.payload == null ? null : JSON.stringify(input.payload),
      },
    })
    .returning()
  return toContext(row)
}

export async function listHealthDailyMetrics(limit = 14) {
  const db = await getActivitiesDb()
  const rows = await db
    .select()
    .from(healthDailyMetrics)
    .orderBy(desc(healthDailyMetrics.date))
    .limit(limit)
  return rows.map(toContext)
}

export async function getLatestHealthDailyMetrics(limit = 7) {
  return listHealthDailyMetrics(limit)
}
