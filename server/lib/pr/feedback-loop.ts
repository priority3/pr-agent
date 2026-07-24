import { getActivitiesDb } from '@/lib/db/client'
import { prFeedbackEvents, prMetricEvents } from '@/lib/db/schema'
import { generateId } from '@/lib/utils'

import { applyMemoryPatch, curateMemoryPatches } from './memory'

export type PrFeedbackEventType =
  | 'thumbs_up'
  | 'thumbs_down'
  | 'correction'
  | 'regenerate'
  | 'memory_confirm'
  | 'memory_archive'
  | 'notification_open'
  | 'notification_ignore'

export async function recordPrFeedbackEvent(input: {
  targetType: string
  targetId: string
  eventType: PrFeedbackEventType
  value?: string | null
  note?: string | null
  metadata?: Record<string, unknown> | null
}) {
  const db = await getActivitiesDb()
  const id = generateId('pfe')
  await db.insert(prFeedbackEvents).values({
    id,
    targetType: input.targetType,
    targetId: input.targetId,
    eventType: input.eventType,
    value: input.value ?? null,
    note: input.note ?? null,
    metadataJson: input.metadata ? JSON.stringify(input.metadata) : null,
  })

  const memoryText = [input.note, input.value].filter(Boolean).join('\n')
  const memoryPatches = await curateMemoryPatches({
    source: 'pr_feedback_event',
    refId: id,
    text: memoryText,
  })
  const memoryIds: string[] = []
  for (const [index, patch] of memoryPatches.entries()) {
    memoryIds.push(
      await applyMemoryPatch(patch, {
        actor: 'user',
        idempotencyKey: `pr-feedback:${id}:memory:${index}`,
      }),
    )
  }

  return { eventId: id, memoryIds }
}

export async function recordPrMetricEvent(input: {
  runId?: string | null
  metricName: string
  metricValue: number
  dimensions?: Record<string, unknown> | null
}) {
  const db = await getActivitiesDb()
  const id = generateId('pme')
  await db.insert(prMetricEvents).values({
    id,
    runId: input.runId ?? null,
    metricName: input.metricName,
    metricValue: input.metricValue,
    dimensionsJson: input.dimensions ? JSON.stringify(input.dimensions) : null,
  })
  return id
}
