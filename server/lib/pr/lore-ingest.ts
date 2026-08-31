/**
 * pr-lore 采集接入(P4):lore.capture.v1 → 既有记忆漏斗。
 *
 * 关键决策:capture 不直连 traits,走 MemoryCurator 蒸馏为**候选记忆**——
 * 确认/多证据晋升后才出现在分身上,保证"爱好"永远只有记忆一个真相源
 * (不会出现 wiki 说爱好 A、记忆说爱好 B 两套并存)。
 *
 * 上游契约(pr-lore webhook deliverer):单条 capture JSON POST + Bearer token;
 * 非 2xx 会进对方 failed outbox 反复重投,所以「按策略拒收」也返回 200 + accepted:false,
 * 只有真正的坏请求(不是 capture)才 4xx。
 * 设计:claudedocs/persona-avatar-design.md §7
 */
import { applyMemoryPatch, curateMemoryPatches } from './memory'

/** lore.capture.v1 里本模块关心的子集(其余字段原样忽略,契约见 pr-lore README)。 */
interface LoreCapture {
  schema_version?: string
  id?: string
  connector?: string
  captured_at?: string
  subject?: { title?: string | null; url?: string | null; uri?: string | null }
  payload?: { text?: string | null }
  note?: string | null
  tags?: string[]
  privacy?: { level?: string; allow_cloud_llm?: boolean }
}

export interface LoreIngestResult {
  accepted: boolean
  reason?: string
  captureId?: string
  candidateIds: string[]
}

/** MemoryCurator 是一次云端模型调用,长文只喂开头(原子事实极少藏在长文中段)。 */
const TEXT_BUDGET = 3500

export async function ingestLoreCapture(body: unknown): Promise<LoreIngestResult | { badRequest: string }> {
  const capture = body as LoreCapture
  if (!capture || typeof capture !== 'object' || !String(capture.schema_version ?? '').startsWith('lore.capture')) {
    return { badRequest: 'body 不是 lore.capture.v1' }
  }
  const captureId = typeof capture.id === 'string' && capture.id.trim() ? capture.id.trim() : null
  if (!captureId) return { badRequest: '缺 capture id' }

  // 蒸馏 = 云端 LLM;采集侧声明不许上云就不碰,返回 200 让 lore 侧正常出队。
  if (capture.privacy?.allow_cloud_llm === false) {
    return { accepted: false, reason: 'privacy.allow_cloud_llm=false,跳过云端蒸馏', captureId, candidateIds: [] }
  }

  const text = [capture.subject?.title, capture.note, capture.payload?.text]
    .map(part => part?.trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, TEXT_BUDGET)
  if (!text) return { accepted: false, reason: '无可蒸馏文本', captureId, candidateIds: [] }

  // 私密级留痕在证据 source 上(lore-private),供将来公开页按来源过滤。
  const source = capture.privacy?.level === 'public' ? 'lore' : 'lore-private'
  const context = [capture.connector, capture.subject?.url ?? capture.subject?.uri].filter(Boolean).join(' · ') || null

  const patches = await curateMemoryPatches({
    source,
    refId: captureId,
    text,
    context,
    createdAt: capture.captured_at,
  })

  const candidateIds: string[] = []
  for (const [index, patch] of patches.entries()) {
    try {
      // 幂等键含 capture id:lore 重投同一条 capture 不会重复建记忆。
      const memoryId = await applyMemoryPatch(patch, {
        actor: 'agent',
        idempotencyKey: `lore:${captureId}:${index}`,
      })
      if (memoryId) candidateIds.push(memoryId)
    } catch (error) {
      console.warn('[lore-ingest] 记忆写入失败:', captureId, (error as Error).message)
    }
  }
  return { accepted: true, captureId, candidateIds }
}
