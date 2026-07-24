import { asc, desc, eq, inArray } from 'drizzle-orm'

import { getActivitiesDb } from '@/lib/db/client'
import { raceGoals } from '@/lib/db/schema'
import { generateId } from '@/lib/utils'

export interface RaceGoalInput {
  name: string
  raceDate: string | Date
  distanceMeters: number
  targetType: string
  targetTimeSec?: number | null
  priority?: string
  status?: string
  notes?: string | null
}

export interface RaceGoalUpdateInput {
  name?: string
  raceDate?: string | Date
  distanceMeters?: number
  targetType?: string
  targetTimeSec?: number | null
  priority?: string
  status?: string
  notes?: string | null
}

export type RacePhase = 'base' | 'build' | 'peak' | 'taper' | 'post_race'

const PHASE_LABEL: Record<RacePhase, string> = {
  base: '基础期',
  build: '强化期',
  peak: '专项期',
  taper: '减量期',
  post_race: '赛后恢复',
}

/**
 * 按赛前天数估算备赛周期位置(通用马拉松/半马周期的粗分)。
 * Reason: 让 PR 的反思/日记/对话能说出"现在在哪个备赛阶段",而不只是倒计时天数。
 */
export function racePhase(daysUntilRace: number): RacePhase {
  if (daysUntilRace < 0) return 'post_race'
  if (daysUntilRace <= 10) return 'taper'
  if (daysUntilRace <= 28) return 'peak'
  if (daysUntilRace <= 56) return 'build'
  return 'base'
}

/** 统一的比赛目标一行摘要:名称（还有 N 天 · 周期），供画像/反思/日记/对话复用。 */
export function raceGoalSummary(goal: RaceGoalContext): string {
  if (goal.daysUntilRace < 0) return `${goal.name}（已结束 · 赛后恢复）`
  return `${goal.name}（还有 ${goal.daysUntilRace} 天 · ${goal.phaseLabel}）`
}

export interface RaceGoalContext {
  id: string
  name: string
  raceDate: string
  distanceMeters: number
  targetType: string
  targetTimeSec: number | null
  priority: string
  status: string
  notes: string | null
  daysUntilRace: number
  phase: RacePhase
  phaseLabel: string
}

function toIso(value: Date | string | number) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function daysUntil(date: string) {
  const diff = new Date(date).getTime() - Date.now()
  return Math.ceil(diff / 86_400_000)
}

function toContext(row: typeof raceGoals.$inferSelect): RaceGoalContext {
  const days = daysUntil(toIso(row.raceDate))
  const phase = racePhase(days)
  return {
    id: row.id,
    name: row.name,
    raceDate: toIso(row.raceDate),
    distanceMeters: Number(row.distanceMeters),
    targetType: row.targetType,
    targetTimeSec: row.targetTimeSec == null ? null : Number(row.targetTimeSec),
    priority: row.priority,
    status: row.status,
    notes: row.notes ?? null,
    daysUntilRace: days,
    phase,
    phaseLabel: PHASE_LABEL[phase],
  }
}

export async function createRaceGoal(input: RaceGoalInput) {
  const db = await getActivitiesDb()
  const id = generateId('goal')
  await db.insert(raceGoals).values({
    id,
    name: input.name,
    raceDate: new Date(input.raceDate),
    distanceMeters: input.distanceMeters,
    targetType: input.targetType,
    targetTimeSec: input.targetTimeSec ?? null,
    priority: input.priority ?? 'primary',
    status: input.status ?? 'active',
    notes: input.notes ?? null,
  })
  return id
}

export async function updateRaceGoal(id: string, input: RaceGoalUpdateInput) {
  const db = await getActivitiesDb()
  await db
    .update(raceGoals)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.raceDate !== undefined ? { raceDate: new Date(input.raceDate) } : {}),
      ...(input.distanceMeters !== undefined ? { distanceMeters: input.distanceMeters } : {}),
      ...(input.targetType !== undefined ? { targetType: input.targetType } : {}),
      ...(input.targetTimeSec !== undefined ? { targetTimeSec: input.targetTimeSec } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      updatedAt: new Date(),
    })
    .where(eq(raceGoals.id, id))
  return id
}

export async function deleteRaceGoal(id: string) {
  const db = await getActivitiesDb()
  await db.delete(raceGoals).where(eq(raceGoals.id, id))
  return id
}

export async function listRaceGoals(statuses: string[] = ['active']) {
  const db = await getActivitiesDb()
  const rows = await db
    .select()
    .from(raceGoals)
    .where(inArray(raceGoals.status, statuses))
    .orderBy(asc(raceGoals.raceDate))
  return rows.map(toContext)
}

export async function getRaceGoalContext(limit = 3): Promise<RaceGoalContext[]> {
  const db = await getActivitiesDb()
  const rows = await db
    .select()
    .from(raceGoals)
    .where(eq(raceGoals.status, 'active'))
    .orderBy(asc(raceGoals.raceDate))
    .limit(limit)
  return rows.map(toContext)
}
