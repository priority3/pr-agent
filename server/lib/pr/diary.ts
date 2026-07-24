import { desc, eq, gte } from 'drizzle-orm'

import { getActivitiesDb } from '@/lib/db/client'
import { agentRuns, agentStateSnapshots, friendDiaryEntries } from '@/lib/db/schema'
import { generateId } from '@/lib/utils'

import { buildDailyContext, getRecentActivityContext, PR_DAILY_BUILDER_VERSION } from './context'
import { applyMemoryPatch, type MemoryItemType, type MemoryPatch } from './memory'
import { callPrModel, parseModelJson } from './model'
import { buildFriendDiarySystemPrompt, buildFriendDiaryUserPrompt } from './prompts'

const DIARY_MEMORY_TYPES = new Set<MemoryItemType>([
  'preference',
  'habit',
  'goal',
  'injury',
  'relationship_note',
  'risk_pattern',
])

function serialize(value: unknown) {
  return JSON.stringify(value)
}

function todayShanghai(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date())
}

function clampConfidence(value: number) {
  return Number.isFinite(value) ? Math.min(0.95, Math.max(0.1, value)) : 0.5
}

async function writeSnapshot(runId: string, step: string, state: unknown) {
  const db = await getActivitiesDb()
  await db.insert(agentStateSnapshots).values({
    id: generateId('snap'),
    runId,
    step,
    stateJson: serialize(state),
  })
}

/** 把日记 LLM 产出的 memories 数组转成 create 候选 patch(和 MemoryCurator 同样的把关)。 */
function toMemoryPatches(raw: unknown, periodLabel: string): MemoryPatch[] {
  const items = Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : []
  const createdAt = new Date().toISOString()
  const patches: MemoryPatch[] = []
  for (const item of items.slice(0, 3)) {
    const content = typeof item?.content === 'string' ? item.content.trim() : ''
    // durable 必须显式为 true;拿不准的不记(与 curateMemoryPatches 一致)。
    if (!content || item?.durable !== true) continue
    const rawType = String(item?.type ?? 'relationship_note') as MemoryItemType
    const type = DIARY_MEMORY_TYPES.has(rawType) ? rawType : 'relationship_note'
    patches.push({
      action: 'create',
      type,
      content: content.length > 140 ? `${content.slice(0, 139)}…` : content,
      evidence: [{ source: 'friend_diary', refId: periodLabel, createdAt }],
      confidence: clampConfidence(Number(item?.confidence)),
      reason:
        typeof item?.reason === 'string' && item.reason.trim()
          ? item.reason.trim()
          : '老友日记从本期脉络中提炼的候选记忆，等待多证据或用户确认。',
    })
  }
  return patches
}

/**
 * 老友日记(friend diary)。周期性把最近一段的训练/恢复/记忆脉络交给 LLM,
 * 以老跑友口吻写一段有连续性的周记,并提炼观察与 0-3 条候选记忆。
 *
 * 这是 roadmap "原子记忆 + 日记摘要 + 画像" 里长期缺失的"日记摘要"一层:
 * 日记 → memory patches → projectFriendProfile,让 PR 对用户的理解带上时间脉络。
 * 失败不影响其它链路;记忆写入走 applyMemoryPatch(候选,晋升仍靠证据/确认)。
 */
export async function generateFriendDiary(
  options: { periodDays?: number; force?: boolean } = {},
): Promise<{ diaryId: string; generated: boolean; learnedMemoryIds: string[]; model?: string }> {
  const db = await getActivitiesDb()
  const periodDays = options.periodDays ?? 7
  const end = new Date()
  const start = new Date(end.getTime() - periodDays * 86_400_000)
  const endDate = todayShanghai()
  const periodLabel = `${new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(start)}~${endDate}`

  // 幂等:同一天已生成过本期日记则跳过(除非 force)。
  if (!options.force) {
    const existing = await db
      .select()
      .from(friendDiaryEntries)
      .where(gte(friendDiaryEntries.periodEnd, new Date(end.getTime() - 12 * 3_600_000)))
      .orderBy(desc(friendDiaryEntries.periodEnd))
      .limit(1)
    if (existing[0]) {
      return { diaryId: existing[0].id, generated: false, learnedMemoryIds: [] }
    }
  }

  const [daily, activities] = await Promise.all([
    buildDailyContext(endDate),
    getRecentActivityContext(12),
  ])

  const runId = generateId('run')
  await db
    .insert(agentRuns)
    .values({
      id: runId,
      idempotencyKey: `friend_diary:${periodLabel}:${Date.now().toString(36)}`,
      trigger: 'friend_diary',
      subjectType: 'diary_period',
      subjectId: periodLabel,
      status: 'running',
      builderVersion: PR_DAILY_BUILDER_VERSION,
      attempts: 1,
      lastStep: 'build_context',
      startedAt: new Date(),
    })
    .onConflictDoNothing()

  await writeSnapshot(runId, 'build_context', {
    periodLabel,
    activities: activities.length,
    memories: daily.memoryItems.length,
    health: daily.recentHealth.length,
  })

  try {
    const generated = await callPrModel(
      buildFriendDiarySystemPrompt(),
      buildFriendDiaryUserPrompt({ periodLabel, daily, activities }),
      { maxTokens: 2000 },
    )
    const parsed = parseModelJson(generated.content) as {
      diary?: unknown
      observations?: unknown
      memories?: unknown
    }
    const diaryText = typeof parsed?.diary === 'string' ? parsed.diary.trim() : ''
    if (!diaryText) throw new Error('日记生成为空')
    const observations = Array.isArray(parsed?.observations)
      ? (parsed.observations as unknown[]).filter(o => typeof o === 'string').slice(0, 5)
      : []

    const patches = toMemoryPatches(parsed?.memories, periodLabel)

    await writeSnapshot(runId, 'draft_response', {
      provider: generated.provider,
      model: generated.model,
      diaryLength: diaryText.length,
      patchCount: patches.length,
    })

    const diaryId = generateId('diary')
    await db.insert(friendDiaryEntries).values({
      id: diaryId,
      periodStart: start,
      periodEnd: end,
      content: diaryText,
      observationsJson: serialize(observations),
      memoryPatchesJson: serialize(patches),
      model: generated.model,
    })

    // 日记 → 候选记忆 → profile(applyMemoryPatch 内部会刷新 friend_profile)。
    const learnedMemoryIds: string[] = []
    for (const [index, patch] of patches.entries()) {
      try {
        learnedMemoryIds.push(
          await applyMemoryPatch(patch, {
            actor: 'agent',
            idempotencyKey: `friend_diary:${diaryId}:memory:${index}`,
            runId,
          }),
        )
      } catch (error) {
        console.warn('[friend-diary] 记忆写入失败:', (error as Error).message)
      }
    }

    await db
      .update(agentRuns)
      .set({
        status: 'succeeded',
        model: generated.model,
        lastStep: 'persist_output',
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(agentRuns.id, runId))
    await writeSnapshot(runId, 'persist_output', { diaryId, learnedMemoryIds })

    return { diaryId, generated: true, learnedMemoryIds, model: generated.model }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    await db
      .update(agentRuns)
      .set({
        status: 'failed',
        errorCode: 'friend_diary_failed',
        errorMessage,
        lastStep: 'persist_output',
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(agentRuns.id, runId))
    await writeSnapshot(runId, 'failed', { errorMessage })
    throw error
  }
}
