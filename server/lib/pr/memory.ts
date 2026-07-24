import { and, desc, eq, inArray, lt } from 'drizzle-orm'

import { getActivitiesDb } from '@/lib/db/client'
import { friendProfile, memoryEvents, memoryItems } from '@/lib/db/schema'
import { generateId } from '@/lib/utils'
import { getLatestHealthDailyMetrics } from './health'
import { callPrModel, parseModelJson } from './model'
import {
  buildMemoryCurationSystemPrompt,
  buildMemoryCurationUserPrompt,
  buildMemoryReconciliationSystemPrompt,
  buildMemoryReconciliationUserPrompt,
} from './prompts'
import { getRaceGoalContext, raceGoalSummary } from './race-goals'
import type { TrainingHabitSignal } from './context'

// 一条记忆晋升为 active 需要的独立证据条数(否则默认 candidate,只靠确认或多证据晋升)。
const EVIDENCE_PROMOTION_THRESHOLD = 3

export type MemoryItemType =
  | 'preference'
  | 'goal'
  | 'injury'
  | 'habit'
  | 'relationship_note'
  | 'correction'
  | 'risk_pattern'

export interface MemoryEvidence {
  source: string
  refId?: string
  quote?: string
  createdAt: string
}

export interface MemoryContext {
  id: string
  type: MemoryItemType
  status: string
  content: string
  confidence: number
  evidence: MemoryEvidence[]
  version: number
  lastSeenAt: string
}

export interface MemoryPatch {
  action: 'create' | 'confirm' | 'update' | 'decay' | 'archive'
  memoryId?: string
  type: MemoryItemType
  content: string
  evidence: MemoryEvidence[]
  confidence: number
  reason: string
  // 同族去重键(如 habit-signal:time_of_day:running)。命中已有记忆时取代旧内容而非新建,
  // 避免"午间/夜间"这类同族信号的矛盾条目并存。为空则退回按内容去重。
  dedupeKey?: string
}

export interface MemoryUpdateInput {
  type?: MemoryItemType
  content?: string
  evidence?: MemoryEvidence[]
  confidence?: number
  status?: 'candidate' | 'active' | 'decayed' | 'archived'
  reason: string
}

const MEMORY_TYPES = new Set<MemoryItemType>([
  'preference',
  'goal',
  'injury',
  'habit',
  'relationship_note',
  'correction',
  'risk_pattern',
])

function normalizeMemoryContent(content: string) {
  return content.trim().replace(/\s+/g, ' ').toLowerCase()
}

function mergeEvidence(existing: MemoryEvidence[], next: MemoryEvidence[]) {
  const seen = new Set<string>()
  const merged: MemoryEvidence[] = []
  for (const item of [...existing, ...next]) {
    const key = [item.source, item.refId ?? '', item.quote ?? ''].join('|')
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(item)
  }
  return merged.slice(-12)
}

function parseEvidence(value: string): MemoryEvidence[] {
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function normalizeType(type: string): MemoryItemType {
  return MEMORY_TYPES.has(type as MemoryItemType) ? (type as MemoryItemType) : 'relationship_note'
}

function rowToMemory(row: typeof memoryItems.$inferSelect): MemoryContext {
  return {
    id: row.id,
    type: normalizeType(row.type),
    status: row.status,
    content: row.content,
    confidence: Number(row.confidence ?? 0),
    evidence: parseEvidence(row.evidenceJson),
    version: Number(row.version ?? 1),
    lastSeenAt: row.lastSeenAt.toISOString(),
  }
}

/** 独立证据条数(按 source|refId|quote 去重),用于多证据晋升判定。 */
function distinctEvidenceCount(evidence: MemoryEvidence[]) {
  return new Set(evidence.map(item => [item.source, item.refId ?? '', item.quote ?? ''].join('|'))).size
}

function clampConfidence(value: number) {
  return Number.isFinite(value) ? Math.min(0.95, Math.max(0.1, value)) : 0.5
}

/**
 * 自动晋升为 active 的判定。满足任一即可,否则留 candidate 等确认。
 * 1) 多证据:独立证据累计达阈值(多样本习惯信号、反复出现的事实)。
 * 2) 用户明示高置信:用户亲口说的稳定事实(目标/偏好/关系),单条即可——不必再手动确认。
 *    Reason: injury 仍保守(疼痛敏感,需多证据/确认);correction 走"candidate 即投影"的既有特例。
 */
function shouldAutoPromote(input: {
  actor: 'user' | 'agent'
  type: MemoryItemType
  confidence: number
  evidence: MemoryEvidence[]
}): boolean {
  if (distinctEvidenceCount(input.evidence) >= EVIDENCE_PROMOTION_THRESHOLD) return true
  if (
    input.actor === 'user' &&
    input.confidence >= 0.8 &&
    (input.type === 'goal' || input.type === 'preference' || input.type === 'relationship_note')
  ) {
    return true
  }
  return false
}

/**
 * MemoryCurator(LLM 蒸馏 + 结构化判断)。把一段用户文字交给模型判断有没有值得长期
 * 记住的、关于用户的持久事实,并蒸馏成干净的原子记忆候选(type/durable/confidence)。
 *
 * 替代原来的关键词正则:不再把瞬时状态/疑问句/原话直接落库(那是之前脏记忆的根因)。
 * 失败或无产出时返回 [](不回退正则),记忆非实时,可后续再学。所有产出都是 create 候选,
 * 是否晋升为 active 交给 applyMemoryPatch 的证据阈值或用户确认。
 */
export async function curateMemoryPatches(input: {
  source: string
  refId: string
  text?: string | null
  context?: string | null
  createdAt?: string
}): Promise<MemoryPatch[]> {
  const raw = input.text?.trim()
  if (!raw) return []

  let parsed: { memories?: unknown }
  try {
    const generated = await callPrModel(
      buildMemoryCurationSystemPrompt(),
      buildMemoryCurationUserPrompt(raw, input.source, input.context),
      { maxTokens: 2000 },
    )
    parsed = parseModelJson(generated.content) as { memories?: unknown }
  } catch (error) {
    console.warn('[memory-curator] LLM 蒸馏失败，跳过本次(不回退正则):', (error as Error).message)
    return []
  }

  const items = Array.isArray(parsed?.memories) ? (parsed.memories as Array<Record<string, unknown>>) : []
  const createdAt = input.createdAt ?? new Date().toISOString()
  const patches: MemoryPatch[] = []
  for (const item of items.slice(0, 3)) {
    const content = typeof item?.content === 'string' ? item.content.trim() : ''
    // durable 必须显式为 true;拿不准的不记。
    if (!content || item?.durable !== true) continue
    const type = normalizeType(String(item?.type ?? 'relationship_note'))
    patches.push({
      action: 'create',
      type,
      content: content.length > 140 ? `${content.slice(0, 139)}…` : content,
      evidence: [{ source: input.source, refId: input.refId, quote: raw.slice(0, 180), createdAt }],
      confidence: clampConfidence(Number(item?.confidence)),
      reason:
        typeof item?.reason === 'string' && item.reason.trim()
          ? item.reason.trim()
          : 'MemoryCurator 蒸馏出的候选记忆，等待用户确认或多证据晋升。',
    })
  }
  return patches
}

export async function curateMemoryFromFeedback(input: {
  feedbackId: string
  activityId: string
  note?: string | null
  pain?: unknown
}): Promise<MemoryPatch[]> {
  const createdAt = new Date().toISOString()
  const patches = await curateMemoryPatches({
    source: 'subjective_feedback',
    refId: input.feedbackId,
    text: input.note,
    createdAt,
  })

  if (input.pain) {
    patches.push({
      action: 'create',
      type: 'injury',
      content: `用户反馈本次活动存在不适: ${JSON.stringify(input.pain)}`,
      evidence: [{ source: 'subjective_feedback', refId: input.feedbackId, createdAt }],
      confidence: 0.45,
      reason: '疼痛反馈属于敏感信息，只作为候选观察，等待多证据或用户确认。',
    })
  }

  return patches
}

export function buildMemoryPatchesFromHabitSignals(input: {
  runId: string
  activityId: string
  activityType: string
  signals: TrainingHabitSignal[]
}) {
  return input.signals
    .filter(signal => signal.confidence >= 0.7)
    .map((signal): MemoryPatch => ({
      action: 'create',
      type: signal.type === 'recovery_risk' ? 'risk_pattern' : 'habit',
      content: signal.content,
      evidence: signal.evidence.map(item => ({
        source: item.source,
        refId: item.refId ?? input.activityId,
        quote: item.quote,
        createdAt: item.createdAt,
      })),
      confidence: signal.confidence,
      // 同族收敛键:每种(信号族 × 活动类型)只保留一条,新信号取代旧内容。
      // 这样"训练时段""常见距离基线"各自唯一,不再出现午间/夜间或多条距离并存。
      dedupeKey: `habit-signal:${signal.type}:${input.activityType}`,
      reason: `从本次 PR 上下文抽取到「${signal.label}」信号，先沉淀为候选记忆，等待后续事实或用户确认。`,
    }))
}

export async function applyMemoryPatch(
  patch: MemoryPatch,
  options: { actor: 'user' | 'agent'; idempotencyKey: string; runId?: string | null },
) {
  const db = await getActivitiesDb()
  const existingEventRows = await db
    .select()
    .from(memoryEvents)
    .where(eq(memoryEvents.idempotencyKey, options.idempotencyKey))
    .limit(1)
  if (existingEventRows[0]?.memoryId) return existingEventRows[0].memoryId

  if (patch.action !== 'create' && !patch.memoryId) {
    throw new Error('memoryId is required for non-create memory patch')
  }

  if (patch.action === 'create') {
    // 命中已有记忆:优先按 dedupeKey(同族信号收敛为一条),否则退回按归一化内容去重。
    let similar: typeof memoryItems.$inferSelect | undefined
    if (patch.dedupeKey) {
      const rows = await db
        .select()
        .from(memoryItems)
        .where(
          and(
            eq(memoryItems.dedupeKey, patch.dedupeKey),
            inArray(memoryItems.status, ['candidate', 'active', 'decayed']),
          ),
        )
        .orderBy(desc(memoryItems.lastSeenAt))
        .limit(1)
      similar = rows[0]
    } else {
      const normalizedContent = normalizeMemoryContent(patch.content)
      const similarRows = await db
        .select()
        .from(memoryItems)
        .where(and(eq(memoryItems.type, patch.type), inArray(memoryItems.status, ['candidate', 'active', 'decayed'])))
        .limit(100)
      similar = similarRows.find(row => normalizeMemoryContent(row.content) === normalizedContent)
    }

    if (similar) {
      const nextVersion = similar.version + 1
      const nextEvidence = mergeEvidence(parseEvidence(similar.evidenceJson), patch.evidence)
      const nextConfidence = Math.max(Number(similar.confidence ?? 0), patch.confidence)
      // 晋升:已 active 保持;否则满足多证据或用户明示高置信才晋升;decayed 遇新证据先回 candidate。
      const promote = shouldAutoPromote({
        actor: options.actor,
        type: patch.type,
        confidence: nextConfidence,
        evidence: nextEvidence,
      })
      const nextStatus =
        similar.status === 'active'
          ? 'active'
          : promote
            ? 'active'
            : similar.status === 'decayed'
              ? 'candidate'
              : similar.status
      // dedupeKey 命中时把内容取代为最新(如最新主导时段/距离基线);内容去重命中则内容不变。
      const supersededContent = patch.dedupeKey ? patch.content : similar.content
      await db
        .update(memoryItems)
        .set({
          content: supersededContent,
          type: patch.type,
          dedupeKey: patch.dedupeKey ?? similar.dedupeKey,
          evidenceJson: JSON.stringify(nextEvidence),
          confidence: nextConfidence,
          status: nextStatus,
          version: nextVersion,
          lastSeenAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(memoryItems.id, similar.id))
      await db
        .insert(memoryEvents)
        .values({
          id: generateId('mevt'),
          memoryId: similar.id,
          runId: options.runId ?? null,
          idempotencyKey: options.idempotencyKey,
          action: 'update',
          status: 'applied',
          patchJson: JSON.stringify({
            ...patch,
            action: 'update',
            deduplicatedFrom: patch.dedupeKey ? 'dedupe_key' : 'content',
          }),
          actor: options.actor,
          expectedVersion: similar.version,
          resultingVersion: nextVersion,
          reason: patch.dedupeKey
            ? `${patch.reason} 已收敛到同族记忆(${patch.dedupeKey})，取代旧内容为最新。`
            : `${patch.reason} 已合并到同内容记忆，避免重复候选。`,
        })
        .onConflictDoNothing()
      await projectFriendProfile()
      return similar.id
    }

    const memoryId = generateId('mem')
    await db.insert(memoryItems).values({
      id: memoryId,
      type: patch.type,
      // 新记忆:满足多证据(如多样本习惯信号)或用户明示高置信 → 直接 active;否则先 candidate。
      status: shouldAutoPromote({
        actor: options.actor,
        type: patch.type,
        confidence: patch.confidence,
        evidence: patch.evidence,
      })
        ? 'active'
        : 'candidate',
      content: patch.content,
      evidenceJson: JSON.stringify(patch.evidence),
      confidence: patch.confidence,
      source: options.actor,
      dedupeKey: patch.dedupeKey ?? null,
    })
    await db
      .insert(memoryEvents)
      .values({
        id: generateId('mevt'),
        memoryId,
        runId: options.runId ?? null,
        idempotencyKey: options.idempotencyKey,
        action: patch.action,
        status: 'applied',
        patchJson: JSON.stringify(patch),
        actor: options.actor,
        resultingVersion: 1,
        reason: patch.reason,
      })
      .onConflictDoNothing()
    await projectFriendProfile()
    return memoryId
  }

  const rows = await db.select().from(memoryItems).where(eq(memoryItems.id, patch.memoryId!)).limit(1)
  const existing = rows[0]
  if (!existing) throw new Error('Memory not found')

  const nextStatus =
    patch.action === 'confirm'
      ? 'active'
      : patch.action === 'archive'
        ? 'archived'
        : patch.action === 'decay'
          ? 'decayed'
          : existing.status
  const nextVersion = existing.version + 1
  // 乐观锁:仅当库内 version 仍等于读到的值时才写入。若为 0 行,说明有并发更新抢先改过,
  // 记 status='conflict' 的事件并放弃覆盖(旧 patch 不能盖新画像),而不是静默 last-write-wins。
  const updateResult = await db
    .update(memoryItems)
    .set({
      type: patch.type,
      content: patch.content,
      evidenceJson: JSON.stringify(patch.evidence),
      confidence: patch.confidence,
      status: nextStatus,
      version: nextVersion,
      lastSeenAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(memoryItems.id, existing.id), eq(memoryItems.version, existing.version)))

  if (updateResult.rowsAffected === 0) {
    await db
      .insert(memoryEvents)
      .values({
        id: generateId('mevt'),
        memoryId: existing.id,
        runId: options.runId ?? null,
        idempotencyKey: options.idempotencyKey,
        action: patch.action,
        status: 'conflict',
        patchJson: JSON.stringify(patch),
        actor: options.actor,
        expectedVersion: existing.version,
        resultingVersion: null,
        reason: patch.reason,
        conflictReason: `乐观锁冲突:期望 version=${existing.version}，记忆已被并发更新，未覆盖。`,
      })
      .onConflictDoNothing()
    return existing.id
  }

  await db
    .insert(memoryEvents)
    .values({
      id: generateId('mevt'),
      memoryId: existing.id,
      runId: options.runId ?? null,
      idempotencyKey: options.idempotencyKey,
      action: patch.action,
      status: 'applied',
      patchJson: JSON.stringify(patch),
      actor: options.actor,
      expectedVersion: existing.version,
      resultingVersion: nextVersion,
      reason: patch.reason,
    })
    .onConflictDoNothing()
  await projectFriendProfile()
  return existing.id
}

export async function listMemories(statuses: string[] = ['candidate', 'active'], limit = 50) {
  const db = await getActivitiesDb()
  const rows = await db
    .select()
    .from(memoryItems)
    .where(inArray(memoryItems.status, statuses))
    .orderBy(desc(memoryItems.lastSeenAt))
    .limit(limit)

  return rows.map(rowToMemory)
}

export async function listContextMemories(limit = 8) {
  const db = await getActivitiesDb()
  const rows = await db
    .select()
    .from(memoryItems)
    .where(and(inArray(memoryItems.status, ['active']), inArray(memoryItems.type, ['correction', 'goal', 'injury', 'habit', 'preference', 'relationship_note', 'risk_pattern'])))
    .orderBy(desc(memoryItems.lastSeenAt))
    .limit(limit)

  return rows.map(rowToMemory)
}

/** 中文友好的轻量词法相关度:查询的 2-gram 子串在内容里命中的比例(无需分词/依赖)。 */
function lexicalOverlapScore(query: string, content: string): number {
  const q = query.trim()
  if (q.length < 2) return 0
  const grams = new Set<string>()
  for (let i = 0; i < q.length - 1; i += 1) grams.add(q.slice(i, i + 2))
  if (grams.size === 0) return 0
  let hit = 0
  for (const g of grams) if (content.includes(g)) hit += 1
  return hit / grams.size
}

/**
 * 按"与当前问题的相关度 + 新鲜度"挑选进上下文的记忆(roadmap L284-341 的 Context Budget/relevance)。
 * 替代纯按时间近度取 top-k:先取较大 active 池,再按 相关度×2 + 新鲜度 打分排序;
 * correction/injury(避坑/安全)强制置顶,永远进上下文。
 */
export async function listRelevantContextMemories(query: string, limit = 6): Promise<MemoryContext[]> {
  const pool = await listContextMemories(30)
  if (pool.length <= limit) return pool
  const now = Date.now()
  const scored = pool.map(memory => {
    const ageDays = (now - new Date(memory.lastSeenAt).getTime()) / 86_400_000
    const recency = 1 / (1 + ageDays / 14) // 约两周半衰
    const relevance = lexicalOverlapScore(query, memory.content)
    const priority = memory.type === 'correction' || memory.type === 'injury' ? 1 : 0
    return { memory, score: priority * 10 + relevance * 2 + recency }
  })
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit).map(s => s.memory)
}

export async function confirmMemory(memoryId: string) {
  // 生命周期只有 candidate/active/decayed/archived —— 不设独立的 'confirmed' 档位:
  // 单用户场景下 candidate 已充当"待人工审核"的门,confirmed 与 active 区分边际价值低(YAGNI)。
  // 用户确认 = 直接晋升 active。此处不再查从不写入的 'confirmed'(清理死引用)。
  const rows = await listMemories(['candidate', 'active'], 100)
  const memory = rows.find(item => item.id === memoryId)
  if (!memory) return null
  await applyMemoryPatch(
    {
      action: 'confirm',
      memoryId,
      type: memory.type,
      content: memory.content,
      evidence: memory.evidence,
      confidence: Math.max(memory.confidence, 0.8),
      reason: '用户确认候选记忆。',
    },
    { actor: 'user', idempotencyKey: `confirm:${memoryId}:${Date.now()}` },
  )
  return memoryId
}

export async function archiveMemory(memoryId: string) {
  const rows = await listMemories(['candidate', 'active', 'decayed'], 100)
  const memory = rows.find(item => item.id === memoryId)
  if (!memory) return null
  await applyMemoryPatch(
    {
      action: 'archive',
      memoryId,
      type: memory.type,
      content: memory.content,
      evidence: memory.evidence,
      confidence: memory.confidence,
      reason: '用户归档记忆。',
    },
    { actor: 'user', idempotencyKey: `archive:${memoryId}:${Date.now()}` },
  )
  return memoryId
}

export async function updateMemory(
  memoryId: string,
  input: MemoryUpdateInput,
  options: { actor: 'user' | 'agent'; idempotencyKey: string; runId?: string | null },
) {
  const db = await getActivitiesDb()
  const rows = await db.select().from(memoryItems).where(eq(memoryItems.id, memoryId)).limit(1)
  const existing = rows[0]
  if (!existing) return null

  const nextVersion = existing.version + 1
  await db
    .update(memoryItems)
    .set({
      type: input.type ?? normalizeType(existing.type),
      content: input.content ?? existing.content,
      evidenceJson: JSON.stringify(input.evidence ?? parseEvidence(existing.evidenceJson)),
      confidence: input.confidence ?? Number(existing.confidence ?? 0),
      status: input.status ?? existing.status,
      version: nextVersion,
      lastSeenAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(memoryItems.id, existing.id))

  await db
    .insert(memoryEvents)
    .values({
      id: generateId('mevt'),
      memoryId: existing.id,
      runId: options.runId ?? null,
      idempotencyKey: options.idempotencyKey,
      action: 'update',
      status: 'applied',
      patchJson: JSON.stringify(input),
      actor: options.actor,
      expectedVersion: existing.version,
      resultingVersion: nextVersion,
      reason: input.reason,
    })
    .onConflictDoNothing()
  await projectFriendProfile()
  return existing.id
}

// 记忆维护:文档 spec 的"新鲜度优先/衰减"(roadmap L227,L349)。定时把长期无新证据的记忆
// 降到 decayed,降低其引用优先级。与 dedupeKey 协同:同族被新条目接管更新后,旧副本 lastSeenAt
// 逐渐变旧,最终在这里退役——从而清掉历史遗留的重复/矛盾条目(如老库里的多条距离/午间夜间)。
const STALE_CANDIDATE_DAYS = Number(process.env.PR_MEMORY_DECAY_DAYS) || 30
const STALE_ACTIVE_HABIT_DAYS = 45

export async function runMemoryMaintenance(
  now: Date = new Date(),
): Promise<{ decayed: number; scanned: number }> {
  const db = await getActivitiesDb()
  const candidateCutoff = new Date(now.getTime() - STALE_CANDIDATE_DAYS * 86_400_000)
  const activeCutoff = new Date(now.getTime() - STALE_ACTIVE_HABIT_DAYS * 86_400_000)

  // 弱推断候选(低置信)长期无新证据 → 衰减。
  // Reason: 纠正要长期避坑、伤病涉安全、目标属用户明示,一律不按时间衰减。
  const staleCandidates = (
    await db
      .select()
      .from(memoryItems)
      .where(and(eq(memoryItems.status, 'candidate'), lt(memoryItems.lastSeenAt, candidateCutoff)))
      .limit(200)
  ).filter(
    row => Number(row.confidence ?? 0) < 0.5 && !['correction', 'injury', 'goal'].includes(row.type),
  )

  // agent 统计出的习惯/风险长期未被新信号强化 → 衰减(用户确认过的 source=user 不动)。
  const staleActives = await db
    .select()
    .from(memoryItems)
    .where(
      and(
        eq(memoryItems.status, 'active'),
        eq(memoryItems.source, 'agent'),
        inArray(memoryItems.type, ['habit', 'risk_pattern']),
        lt(memoryItems.lastSeenAt, activeCutoff),
      ),
    )
    .limit(200)

  const targets = [...staleCandidates, ...staleActives]
  let decayed = 0
  for (const row of targets) {
    const memory = rowToMemory(row)
    try {
      await applyMemoryPatch(
        {
          action: 'decay',
          memoryId: row.id,
          type: memory.type,
          content: memory.content,
          evidence: memory.evidence,
          confidence: memory.confidence,
          reason: '长期无新证据，自动衰减以降低引用优先级(新鲜度维护)。',
        },
        { actor: 'agent', idempotencyKey: `decay:${row.id}:v${row.version}` },
      )
      decayed++
    } catch (error) {
      console.warn('[memory-maintenance] 衰减失败:', row.id, (error as Error).message)
    }
  }
  return { decayed, scanned: targets.length }
}

/**
 * MemoryReconciler(LLM 语义记忆调和 —— 自我进化核心)。
 * dedupeKey 只能收敛"字面同族"的信号;跨族、对话类、以及历史遗留的语义冗余/矛盾
 * (如老库里 4 条距离、午间 vs 夜间)靠这里:把 active+candidate 交给 LLM,让它识别
 * "讲同一件事"的条目,产出 decay/supersede 动作,由 PR 自主整理自己的记忆。
 *
 * 红线(与 prompt 双重约束):只能动给定 id、绝不新增事实、只 decay/supersede、拿不准不动。
 * 失败只记日志不抛。所有写入走 applyMemoryPatch(actor='agent'),事件账本可追溯。
 */
export async function reconcileMemories(
  opts: { apply?: boolean } = {},
): Promise<{ proposed: number; applied: number; dryRun: boolean }> {
  // 默认 apply=true;首轮上线由调用方(job)按 PR_MEMORY_RECONCILE_APPLY 设置传 apply=false,
  // 先 dry-run:只把模型建议打进容器日志、绝不写库,人工确认判断靠谱后再开 apply。
  const apply = opts.apply !== false
  const memories = await listMemories(['active', 'candidate'], 60)
  if (memories.length < 2) return { proposed: 0, applied: 0, dryRun: !apply }

  const listing = memories
    .map(m => `[${m.id} | ${m.type} | ${m.status} | conf${m.confidence.toFixed(2)} | ev${m.evidence.length}] ${m.content}`)
    .join('\n')

  let actions: Array<Record<string, unknown>> = []
  try {
    const generated = await callPrModel(
      buildMemoryReconciliationSystemPrompt(),
      buildMemoryReconciliationUserPrompt(listing),
      { maxTokens: 2000 },
    )
    const parsed = parseModelJson(generated.content) as { actions?: unknown }
    actions = Array.isArray(parsed?.actions) ? (parsed.actions as Array<Record<string, unknown>>) : []
  } catch (error) {
    console.warn('[memory-reconcile] LLM 调和失败，跳过本次:', (error as Error).message)
    return { proposed: 0, applied: 0, dryRun: !apply }
  }

  const byId = new Map(memories.map(m => [m.id, m]))
  let applied = 0
  for (const [index, action] of actions.slice(0, 12).entries()) {
    const op = String(action?.op ?? '')
    const memoryId = String(action?.memoryId ?? '')
    const memory = byId.get(memoryId)
    if (!memory) continue // 只动给定 id;杜撰的 id 一律忽略
    const reason =
      typeof action?.reason === 'string' && action.reason.trim()
        ? action.reason.trim()
        : 'MemoryReconciler 收敛冗余/矛盾记忆。'
    const supersedeContent = typeof action?.content === 'string' ? action.content.trim() : ''
    if (op === 'supersede' && !supersedeContent) continue

    if (!apply) {
      // dry-run:只把建议打进日志(SSH `docker logs ... | grep reconcile-preview` 可读),不写库。
      console.log(
        `[reconcile-preview] ${op.toUpperCase()} ${memoryId} [${memory.type}/${memory.status}] "${memory.content.slice(0, 50)}"` +
          (op === 'supersede' ? ` → "${supersedeContent}"` : '') +
          ` | 理由: ${reason}`,
      )
      continue
    }

    try {
      if (op === 'decay') {
        await applyMemoryPatch(
          {
            action: 'decay',
            memoryId,
            type: memory.type,
            content: memory.content,
            evidence: memory.evidence,
            confidence: memory.confidence,
            reason,
          },
          { actor: 'agent', idempotencyKey: `reconcile:${memoryId}:v${memory.version}:${index}` },
        )
        applied++
      } else if (op === 'supersede') {
        await applyMemoryPatch(
          {
            action: 'update',
            memoryId,
            type: memory.type,
            content: supersedeContent.length > 140 ? `${supersedeContent.slice(0, 139)}…` : supersedeContent,
            evidence: memory.evidence,
            confidence: memory.confidence,
            reason,
          },
          { actor: 'agent', idempotencyKey: `reconcile:${memoryId}:v${memory.version}:${index}` },
        )
        applied++
      }
    } catch (error) {
      console.warn('[memory-reconcile] 应用失败:', memoryId, (error as Error).message)
    }
  }
  if (!apply && actions.length) {
    console.log(`[reconcile-preview] 共 ${actions.length} 条建议(dry-run,未写库)。开 PR_MEMORY_RECONCILE_APPLY 后生效。`)
  }
  return { proposed: actions.length, applied, dryRun: !apply }
}

export async function getFriendProfile() {
  const db = await getActivitiesDb()
  const rows = await db.select().from(friendProfile).limit(1)
  const profile = rows[0]
  if (!profile) return null

  return {
    id: profile.id,
    displayName: profile.displayName,
    companionStyleJson: profile.companionStyleJson,
    activeGoalsJson: profile.activeGoalsJson,
    trainingPreferencesJson: profile.trainingPreferencesJson,
    injuryWatchlistJson: profile.injuryWatchlistJson,
    recentStateJson: profile.recentStateJson,
    doNotAssumeJson: profile.doNotAssumeJson,
    projectionVersion: profile.projectionVersion,
    sourceDiaryId: profile.sourceDiaryId,
    updatedAt: profile.updatedAt.toISOString(),
  }
}

/** 从「用户希望被称呼为 X / 叫我 X / 我叫 X / 名字是 X」类记忆里抽出称呼,供投影到 display_name。 */
function deriveDisplayName(memories: MemoryContext[]): string | null {
  const re = /(?:希望被称呼为|请?称呼为|请叫我|叫我|名字是|我叫)\s*([^\s,，。.、!！?？]+)/
  for (const memory of memories) {
    const hit = memory.content.match(re)
    if (hit?.[1]) return hit[1].trim()
  }
  return null
}

export async function projectFriendProfile() {
  const active = await listMemories(['active'], 100)
  const injuryWatchlist = active.filter(memory => memory.type === 'injury')
  // do_not_assume 只取 **active** 的 correction:候选纠错必须经用户确认或多证据晋升为 active 才影响行为,
  // 不再"候选即投影"——否则一句反问/玩笑被误判成 correction 就会误伤(闸门看确认/证据,不看自评置信度)。
  const doNotAssumeContents = Array.from(
    new Set(active.filter(memory => memory.type === 'correction').map(memory => memory.content)),
  )
  const preferences = active.filter(memory => memory.type === 'preference' || memory.type === 'relationship_note')
  const goals = active.filter(memory => memory.type === 'goal')
  const habits = active.filter(memory => memory.type === 'habit' || memory.type === 'risk_pattern')
  // 称呼:从 active 的 relationship_note 抽出,投影到 display_name(取最近一条;无则保持原值不动)。
  const displayName = deriveDisplayName(preferences)
  const activeRaceGoals = await getRaceGoalContext(3)
  const healthMetrics = await getLatestHealthDailyMetrics(3)
  const recentState = {
    latestHealth: healthMetrics[0] ?? null,
    activeRaceGoals,
  }

  const db = await getActivitiesDb()
  await db
    .insert(friendProfile)
    .values({
      id: 'default',
      ...(displayName ? { displayName } : {}),
      companionStyleJson: JSON.stringify(preferences.map(memory => memory.content)),
      activeGoalsJson: JSON.stringify([
        ...goals.map(memory => memory.content),
        ...activeRaceGoals.map(raceGoalSummary),
      ]),
      trainingPreferencesJson: JSON.stringify(habits.map(memory => memory.content)),
      injuryWatchlistJson: JSON.stringify(injuryWatchlist.map(memory => memory.content)),
      recentStateJson: JSON.stringify(recentState),
      doNotAssumeJson: JSON.stringify(doNotAssumeContents),
      projectionVersion: 1,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: friendProfile.id,
      set: {
        ...(displayName ? { displayName } : {}),
        companionStyleJson: JSON.stringify(preferences.map(memory => memory.content)),
        activeGoalsJson: JSON.stringify([
          ...goals.map(memory => memory.content),
          ...activeRaceGoals.map(raceGoalSummary),
        ]),
        trainingPreferencesJson: JSON.stringify(habits.map(memory => memory.content)),
        injuryWatchlistJson: JSON.stringify(injuryWatchlist.map(memory => memory.content)),
        recentStateJson: JSON.stringify(recentState),
        doNotAssumeJson: JSON.stringify(doNotAssumeContents),
        updatedAt: new Date(),
      },
    })
}
