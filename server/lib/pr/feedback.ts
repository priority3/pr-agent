import { desc, eq } from 'drizzle-orm'

import { getActivitiesDb } from '@/lib/db/client'
import { subjectiveFeedback } from '@/lib/db/schema'
import { generateId } from '@/lib/utils'

export interface SubjectiveFeedbackInput {
  activityId: string
  mood?: string | null
  rpe?: number | null
  pain?: unknown
  note?: string | null
  source?: string
}

export interface SubjectiveFeedbackContext {
  id: string
  activityId: string | null
  mood: string | null
  rpe: number | null
  pain: unknown
  note: string | null
  source: string
  createdAt: string
}

function parsePain(value: string | null): unknown {
  if (!value) return null
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

export async function createSubjectiveFeedback(input: SubjectiveFeedbackInput) {
  const db = await getActivitiesDb()
  const id = generateId('fb')
  await db.insert(subjectiveFeedback).values({
    id,
    activityId: input.activityId,
    mood: input.mood?.trim() || null,
    rpe: typeof input.rpe === 'number' ? Math.min(Math.max(Math.round(input.rpe), 1), 10) : null,
    painJson: input.pain == null ? null : JSON.stringify(input.pain),
    note: input.note?.trim() || null,
    source: input.source || 'dashboard',
  })
  return id
}

export async function listSubjectiveFeedbackForActivity(
  activityId: string,
  limit = 5,
): Promise<SubjectiveFeedbackContext[]> {
  const db = await getActivitiesDb()
  const rows = await db
    .select()
    .from(subjectiveFeedback)
    .where(eq(subjectiveFeedback.activityId, activityId))
    .orderBy(desc(subjectiveFeedback.createdAt))
    .limit(limit)

  return rows.map(row => ({
    id: row.id,
    activityId: row.activityId,
    mood: row.mood,
    rpe: row.rpe == null ? null : Number(row.rpe),
    pain: parsePain(row.painJson),
    note: row.note,
    source: row.source,
    createdAt: row.createdAt.toISOString(),
  }))
}
