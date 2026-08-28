/**
 * 数字分身投影(persona.v1)。
 *
 * 持久特征单漏斗:只读「已生效记忆 + 画像 + 健康 + 赛事目标 + 近期活动」,投影成
 * traits + renderManifest 写进 persona_state(单例);traits 变更 diff 进 persona_events
 * (成长回放)。渲染端(admin 数字分身页)只消费最终 JSON,不做业务判断。
 *
 * 两路提取:
 * - 确定性路(代码规则,无 LLM):state.* / goal.* / identity.* / injury.*
 * - LLM 蒸馏路:body.* / hobby.* —— 只从记忆原文提取显式陈述,禁止推测;
 *   memHash 不变不重跑,失败沿用上一版(页面永远有东西可渲染)。
 * 设计:claudedocs/persona-avatar-design.md
 */
import { createHash } from 'node:crypto'

import { desc, eq, gte, sql } from 'drizzle-orm'

import { getActivitiesDb } from '@/lib/db/client'
import { activities, personaEvents, personaState } from '@/lib/db/schema'
import { generateId } from '@/lib/utils'

import { getLatestHealthDailyMetrics } from './health'
import { getFriendProfile, listMemories, type MemoryContext } from './memory'
import { callPrModel, parseModelJson } from './model'
import { getRaceGoalContext } from './race-goals'

export const PERSONA_BUILDER_VERSION = 'persona-v1'

export interface PersonaTrait {
  key: string
  value: unknown
  confidence: number
  source: { kind: 'memory' | 'profile' | 'health' | 'race_goal' | 'activity' | 'llm'; refId?: string }
}

export interface PersonaTagBubble {
  id: string
  type: string
  /** 气泡短标签(内容截断);完整原文在 content。 */
  label: string
  content: string
  confidence: number
}

export interface PersonaRenderManifest {
  manifestVersion: 'rm.v1'
  user: {
    /** 模型变体 id;前端缺对应文件时回落 base。 */
    model: 'base' | 'body-slim' | 'body-strong'
    /** 身高映射整体缩放,clamp [0.92, 1.08]。 */
    scale: number
    expression: 'neutral' | 'happy' | 'tired'
    idle: 'breath'
    props: string[]
  }
  companion: {
    sprite: 'happy' | 'worried' | 'cheering' | 'neutral'
    bubble: string | null
  }
  tags: PersonaTagBubble[]
}

export interface PersonaPayload {
  schemaVersion: 'persona.v1'
  traits: PersonaTrait[]
  renderManifest: PersonaRenderManifest
  inputHash: string
  /** active 记忆原文哈希,单独存以便 LLM 路免重跑。 */
  memHash: string
  /** LLM 蒸馏结果缓存(已并入 traits;失败时沿用)。 */
  llmTraits: PersonaTrait[]
  builderVersion: string
  updatedAt: string
}

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

function clip(text: string, max = 14) {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

// ─── 输入采集 ───────────────────────────────────────────────────────────────

interface ProjectionInputs {
  memories: MemoryContext[]
  profile: Awaited<ReturnType<typeof getFriendProfile>>
  health: Awaited<ReturnType<typeof getLatestHealthDailyMetrics>>
  raceGoals: Awaited<ReturnType<typeof getRaceGoalContext>>
  recent: { runs7d: number; runs14d: number; km14d: number; lastRunDaysAgo: number | null }
}

async function collectInputs(): Promise<ProjectionInputs> {
  const db = await getActivitiesDb()
  const since = new Date(Date.now() - 14 * 86_400_000)
  const rows = await db
    .select({ startTime: activities.startTime, distance: activities.distance })
    .from(activities)
    .where(gte(activities.startTime, since))
    .orderBy(desc(activities.startTime))
    .limit(60)
  const now = Date.now()
  const runs7d = rows.filter(row => now - row.startTime.getTime() <= 7 * 86_400_000).length
  const km14d = rows.reduce((sum, row) => sum + Number(row.distance || 0), 0) / 1000
  const lastRunDaysAgo = rows.length ? Math.floor((now - rows[0].startTime.getTime()) / 86_400_000) : null

  const [memories, profile, health, raceGoals] = await Promise.all([
    listMemories(['active'], 100),
    getFriendProfile(),
    getLatestHealthDailyMetrics(3),
    getRaceGoalContext(3),
  ])
  return { memories, profile, health, raceGoals, recent: { runs7d, runs14d: rows.length, km14d, lastRunDaysAgo } }
}

/** 输入指纹:任何会影响投影结果的字段都要进来(daysUntilRace 随日期变,天然让 cron 兜底日更)。 */
function computeInputHash(inputs: ProjectionInputs) {
  return sha256(
    JSON.stringify({
      mem: inputs.memories.map(m => [m.id, m.content, m.confidence]),
      name: inputs.profile?.displayName ?? null,
      health: inputs.health.map(h => [h.date, h.recoveryLabel]),
      goals: inputs.raceGoals.map(g => [g.id, g.daysUntilRace, g.status]),
      recent: inputs.recent,
    }),
  )
}

// ─── 确定性路 ───────────────────────────────────────────────────────────────

type TrainingLoad = 'idle' | 'recovering' | 'steady' | 'high'

function deriveTrainingLoad(inputs: ProjectionInputs): TrainingLoad {
  const recovery = inputs.health[0]?.recoveryLabel ?? 'unknown'
  if (recovery === 'poor') return 'recovering'
  if (inputs.recent.runs14d === 0) return 'idle'
  if (inputs.recent.runs7d >= 4) return 'high'
  return 'steady'
}

function buildDeterministicTraits(inputs: ProjectionInputs): PersonaTrait[] {
  const traits: PersonaTrait[] = []
  if (inputs.profile?.displayName) {
    traits.push({
      key: 'identity.nickname',
      value: inputs.profile.displayName,
      confidence: 0.9,
      source: { kind: 'profile' },
    })
  }
  for (const goal of inputs.raceGoals) {
    traits.push({
      key: `goal.race.${goal.id}`,
      value: { name: goal.name, daysUntilRace: goal.daysUntilRace, phaseLabel: goal.phaseLabel },
      confidence: 1,
      source: { kind: 'race_goal', refId: goal.id },
    })
  }
  const recovery = inputs.health[0]?.recoveryLabel ?? 'unknown'
  if (recovery !== 'unknown') {
    traits.push({ key: 'state.recovery', value: recovery, confidence: 1, source: { kind: 'health', refId: inputs.health[0]?.id } })
  }
  traits.push({ key: 'state.training_load', value: deriveTrainingLoad(inputs), confidence: 1, source: { kind: 'activity' } })
  for (const memory of inputs.memories.filter(m => m.type === 'injury')) {
    traits.push({
      key: `injury.watch.${memory.id}`,
      value: memory.content,
      confidence: memory.confidence,
      source: { kind: 'memory', refId: memory.id },
    })
  }
  return traits
}

// ─── LLM 蒸馏路(body.* / hobby.*)────────────────────────────────────────────

const LLM_NUMERIC_BOUNDS: Record<string, [number, number]> = {
  'body.height_cm': [100, 230],
  'body.weight_kg': [30, 200],
}
const LLM_BUILD_VALUES = new Set(['slim', 'standard', 'strong'])
const LLM_MAX_HOBBIES = 6

function buildPersonaDistillPrompt(memories: MemoryContext[]) {
  const listing = memories.map(m => `[${m.id}] ${m.content}`).join('\n')
  const system = `你是 RunPaceFlow 里 PR Agent 的「分身投影器」。给你一批关于用户的已确认长期记忆,提取其中**显式陈述**的身体数值与爱好,输出 JSON。
红线:只提取记忆原文里明说的事实,禁止从跑步表现推测身高体重体型;没有就不输出该键。
可用键(其余一律忽略):
- body.height_cm(数字,厘米)
- body.weight_kg(数字,公斤)
- body.build("slim"|"standard"|"strong",仅当原文明确描述体型)
- hobby.<英文slug>(值为中文短标签,如 hobby.photography → "摄影";最多 ${LLM_MAX_HOBBIES} 条,跑步本身不算爱好)
只输出 JSON,形如 {"traits":[{"key":"body.height_cm","value":178,"confidence":0.9,"memoryId":"mem_x"}]}。`
  return { system, user: `记忆列表:\n${listing}` }
}

function sanitizeLlmTraits(raw: unknown): PersonaTrait[] {
  const list = Array.isArray((raw as { traits?: unknown })?.traits)
    ? ((raw as { traits: unknown[] }).traits as Array<Record<string, unknown>>)
    : []
  const out: PersonaTrait[] = []
  let hobbies = 0
  for (const item of list) {
    const key = String(item?.key ?? '')
    const confidence = Math.min(1, Math.max(0, Number(item?.confidence ?? 0.7)))
    const refId = typeof item?.memoryId === 'string' ? item.memoryId : undefined
    if (key in LLM_NUMERIC_BOUNDS) {
      const value = Number(item?.value)
      const [min, max] = LLM_NUMERIC_BOUNDS[key]
      if (Number.isFinite(value) && value >= min && value <= max) {
        out.push({ key, value, confidence, source: { kind: 'llm', refId } })
      }
    } else if (key === 'body.build') {
      const value = String(item?.value ?? '')
      if (LLM_BUILD_VALUES.has(value)) out.push({ key, value, confidence, source: { kind: 'llm', refId } })
    } else if (/^hobby\.[a-z0-9-]+$/.test(key) && hobbies < LLM_MAX_HOBBIES) {
      const value = String(item?.value ?? '').trim()
      if (value && value.length <= 12) {
        out.push({ key, value, confidence, source: { kind: 'llm', refId } })
        hobbies++
      }
    }
  }
  return out
}

async function distillLlmTraits(
  memories: MemoryContext[],
  memHash: string,
  previous: PersonaPayload | null,
): Promise<PersonaTrait[]> {
  const flag = (process.env.PR_PERSONA_LLM ?? '').trim().toLowerCase()
  if (['off', 'false', '0'].includes(flag)) return previous?.llmTraits ?? []
  if (!memories.length) return []
  // memHash 不变不重跑:LLM 只在记忆集合真的变化时花钱。
  if (previous && previous.memHash === memHash) return previous.llmTraits
  try {
    const prompt = buildPersonaDistillPrompt(memories)
    const generated = await callPrModel(prompt.system, prompt.user, { maxTokens: 800 })
    return sanitizeLlmTraits(parseModelJson(generated.content))
  } catch (error) {
    console.warn('[persona] LLM 蒸馏失败，沿用上一版:', (error as Error).message)
    return previous?.llmTraits ?? []
  }
}

// ─── renderManifest 解析(纯规则)─────────────────────────────────────────────

const COMPANION_BUBBLE: Record<TrainingLoad, string> = {
  idle: '好久没一起跑了,今天出去走走?',
  recovering: '最近先把觉睡够,强度缓一缓。',
  steady: '这周节奏不错,照计划来。',
  high: '跑量拉起来了,记得留恢复日!',
}

function resolveManifest(traits: PersonaTrait[], inputs: ProjectionInputs): PersonaRenderManifest {
  const byKey = new Map(traits.map(t => [t.key, t]))
  const height = Number(byKey.get('body.height_cm')?.value)
  const build = String(byKey.get('body.build')?.value ?? '')
  const recovery = String(byKey.get('state.recovery')?.value ?? 'unknown')
  const load = String(byKey.get('state.training_load')?.value ?? 'steady') as TrainingLoad

  // 气泡:已生效记忆按 伤病/纠正 置顶 + 新鲜度取前 10。
  const prioritized = [...inputs.memories].sort((a, b) => {
    const pa = a.type === 'injury' || a.type === 'correction' ? 1 : 0
    const pb = b.type === 'injury' || b.type === 'correction' ? 1 : 0
    if (pa !== pb) return pb - pa
    return new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime()
  })
  const tags: PersonaTagBubble[] = prioritized.slice(0, 10).map(memory => ({
    id: memory.id,
    type: memory.type,
    label: clip(memory.content),
    content: memory.content,
    confidence: memory.confidence,
  }))

  return {
    manifestVersion: 'rm.v1',
    user: {
      model: build === 'slim' ? 'body-slim' : build === 'strong' ? 'body-strong' : 'base',
      // Reason: 172cm 作缩放基准(VRoid 样板身高),clamp 防极端值把人物撑出场景。
      scale: Number.isFinite(height) ? Math.min(1.08, Math.max(0.92, height / 172)) : 1,
      expression: recovery === 'poor' ? 'tired' : recovery === 'good' ? 'happy' : 'neutral',
      idle: 'breath',
      props: inputs.raceGoals.some(g => g.daysUntilRace >= 0) ? ['race-bib'] : [],
    },
    companion: {
      sprite: load === 'recovering' ? 'worried' : load === 'high' ? 'cheering' : load === 'idle' ? 'neutral' : 'happy',
      bubble: COMPANION_BUBBLE[load] ?? null,
    },
    tags,
  }
}

// ─── diff → persona_events ──────────────────────────────────────────────────

async function writeTraitEvents(previous: PersonaTrait[], next: PersonaTrait[]) {
  const db = await getActivitiesDb()
  const prevByKey = new Map(previous.map(t => [t.key, t]))
  const nextByKey = new Map(next.map(t => [t.key, t]))
  const rows: Array<typeof personaEvents.$inferInsert> = []
  for (const [key, trait] of nextByKey) {
    const before = prevByKey.get(key)
    if (!before) {
      rows.push({ id: generateId('pevt'), kind: 'trait_added', traitKey: key, afterJson: JSON.stringify(trait.value), sourceRef: trait.source.refId ?? null })
    } else if (JSON.stringify(before.value) !== JSON.stringify(trait.value)) {
      rows.push({
        id: generateId('pevt'),
        kind: 'trait_changed',
        traitKey: key,
        beforeJson: JSON.stringify(before.value),
        afterJson: JSON.stringify(trait.value),
        sourceRef: trait.source.refId ?? null,
      })
    }
  }
  for (const [key, trait] of prevByKey) {
    if (!nextByKey.has(key)) {
      rows.push({ id: generateId('pevt'), kind: 'trait_removed', traitKey: key, beforeJson: JSON.stringify(trait.value), sourceRef: trait.source.refId ?? null })
    }
  }
  if (rows.length) await db.insert(personaEvents).values(rows)
  return rows.length
}

// ─── 入口 ───────────────────────────────────────────────────────────────────

export async function getPersonaState(): Promise<PersonaPayload | null> {
  const db = await getActivitiesDb()
  const rows = await db.select().from(personaState).where(eq(personaState.id, 'singleton')).limit(1)
  if (!rows[0]) return null
  try {
    return JSON.parse(rows[0].payloadJson) as PersonaPayload
  } catch {
    return null
  }
}

export async function listPersonaEvents(limit = 50) {
  const db = await getActivitiesDb()
  const rows = await db.select().from(personaEvents).orderBy(desc(personaEvents.createdAt)).limit(limit)
  return rows.map(row => ({
    id: row.id,
    kind: row.kind,
    traitKey: row.traitKey,
    before: row.beforeJson ? (JSON.parse(row.beforeJson) as unknown) : null,
    after: row.afterJson ? (JSON.parse(row.afterJson) as unknown) : null,
    sourceRef: row.sourceRef,
    createdAt: row.createdAt.toISOString(),
  }))
}

/**
 * 幂等重算:输入指纹不变(且非 force)直接跳过。
 * 挂点:projectFriendProfile 尾部 fire-and-forget(覆盖记忆变更/健康上报/周总结全部触发源)+ cron 兜底。
 */
export async function projectPersona(opts: { force?: boolean } = {}): Promise<{ updated: boolean; events: number }> {
  const inputs = await collectInputs()
  const inputHash = computeInputHash(inputs)
  const previous = await getPersonaState()
  if (!opts.force && previous?.inputHash === inputHash) return { updated: false, events: 0 }

  const memHash = sha256(inputs.memories.map(m => `${m.id}:${m.content}`).join('\n'))
  const llmTraits = await distillLlmTraits(inputs.memories, memHash, previous)
  const traits = [...buildDeterministicTraits(inputs), ...llmTraits]
  const renderManifest = resolveManifest(traits, inputs)

  const events = await writeTraitEvents(previous?.traits ?? [], traits).catch(error => {
    console.warn('[persona] 变更史写入失败:', (error as Error).message)
    return 0
  })

  const payload: PersonaPayload = {
    schemaVersion: 'persona.v1',
    traits,
    renderManifest,
    inputHash,
    memHash,
    llmTraits,
    builderVersion: PERSONA_BUILDER_VERSION,
    updatedAt: new Date().toISOString(),
  }
  const db = await getActivitiesDb()
  await db
    .insert(personaState)
    .values({ id: 'singleton', payloadJson: JSON.stringify(payload), projectionVersion: 1, builderVersion: PERSONA_BUILDER_VERSION, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: personaState.id,
      set: {
        payloadJson: JSON.stringify(payload),
        projectionVersion: sql`${personaState.projectionVersion} + 1`,
        builderVersion: PERSONA_BUILDER_VERSION,
        updatedAt: new Date(),
      },
    })
  return { updated: true, events }
}
