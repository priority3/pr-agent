import { desc, gte } from 'drizzle-orm'

import { getActivitiesDb } from '@/lib/db/client'
import { lifeEvents } from '@/lib/db/schema'
import { generateId } from '@/lib/utils'

export type LifeEventType = 'morning_photo' | 'meal_photo' | 'gear_photo' | 'injury_photo' | 'manual_note'

export interface LifeEventInput {
  type: LifeEventType
  occurredAt?: string | Date
  mediaUrl?: string | null
  rawText?: string | null
}

export interface LifeEventContext {
  id: string
  type: LifeEventType
  occurredAt: string
  mediaUrl: string | null
  rawText: string | null
  observation: Record<string, unknown> | null
  model: string | null
  createdAt: string
}

const LIFE_EVENT_TYPES = new Set<LifeEventType>([
  'morning_photo',
  'meal_photo',
  'gear_photo',
  'injury_photo',
  'manual_note',
])

function normalizeType(value: string): LifeEventType {
  return LIFE_EVENT_TYPES.has(value as LifeEventType) ? (value as LifeEventType) : 'manual_note'
}

function buildRuleObservation(input: LifeEventInput) {
  const text = input.rawText?.trim() ?? ''
  const memoryCandidate = /(喜欢|偏好|以后|不要|疼|痛|受伤|比赛|目标)/.test(text)

  return {
    type: input.type,
    summary: text || (input.mediaUrl ? '收到一条生活媒体输入，尚未接入多模态识别。' : '收到一条生活记录。'),
    training_relevance:
      input.type === 'injury_photo'
        ? '可能与伤痛或恢复风险相关，进入日记前保持低置信度观察。'
        : input.type === 'meal_photo'
          ? '可能与补给和恢复有关，当前仅作为生活观察。'
          : '作为近期状态背景，不直接形成训练结论。',
    memory_candidate: memoryCandidate,
  }
}

function parseObservation(value: string | null): Record<string, unknown> | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function toContext(row: typeof lifeEvents.$inferSelect): LifeEventContext {
  return {
    id: row.id,
    type: normalizeType(row.type),
    occurredAt: row.occurredAt.toISOString(),
    mediaUrl: row.mediaUrl,
    rawText: row.rawText,
    observation: parseObservation(row.observationJson),
    model: row.model,
    createdAt: row.createdAt.toISOString(),
  }
}

export async function createLifeEvent(input: LifeEventInput) {
  const db = await getActivitiesDb()
  const id = generateId('life')
  const type = normalizeType(input.type)
  const observation = buildRuleObservation({ ...input, type })

  await db.insert(lifeEvents).values({
    id,
    type,
    occurredAt: input.occurredAt ? new Date(input.occurredAt) : new Date(),
    mediaUrl: input.mediaUrl?.trim() || null,
    rawText: input.rawText?.trim() || null,
    observationJson: JSON.stringify(observation),
    model: 'rule-based-life-event-v1',
  })

  return id
}

export async function listLifeEvents(limit = 20) {
  const db = await getActivitiesDb()
  const rows = await db.select().from(lifeEvents).orderBy(desc(lifeEvents.occurredAt)).limit(limit)
  return rows.map(toContext)
}

export async function getRecentLifeEvents(days = 7, limit = 8) {
  const db = await getActivitiesDb()
  const start = new Date()
  start.setDate(start.getDate() - days)
  const rows = await db
    .select()
    .from(lifeEvents)
    .where(gte(lifeEvents.occurredAt, start))
    .orderBy(desc(lifeEvents.occurredAt))
    .limit(limit)
  return rows.map(toContext)
}
