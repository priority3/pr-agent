import { eq, inArray } from 'drizzle-orm'

import { getActivitiesDb } from '@/lib/db/client'
import {
  knowledgeChunks,
  knowledgeDocuments,
  knowledgeEmbeddings,
  ragRetrievalLogs,
} from '@/lib/db/schema'
import { generateId } from '@/lib/utils'

import { cosineSimilarity, embedTexts, getEmbeddingConfig } from './embeddings'
import { lexicalTopK, tokenizeQuery } from './rag-lexical'

/**
 * PR 知识库检索入口:词法 BM25(永远在线)+ 可选向量路 + RRF 融合。
 *
 * 词法路零外部依赖(rag-lexical.ts 纯计算);embedding 配置齐备时叠加向量召回,
 * 任何向量侧失败(API 超时/无向量行/配置库抖动)都静默降级纯词法,绝不向上抛——
 * 消费方 buildPrContext / knowledgeProvider 无需感知检索模式。
 */
export interface KnowledgeContext {
  id: string
  documentId: string
  content: string
  metadata: Record<string, unknown> | null
  source: string | null
  score: number
}

/** RRF 融合常数 k=60:检索文献标准取值,头部排名差异敏感、长尾贡献平滑。 */
const RRF_K = 60

/** 两路各自送入 RRF 融合的候选池大小。 */
const CANDIDATE_POOL = 20

// Reason: bge 系 cosine 低于此基本是噪声,过滤掉才能保住「无命中」语义——
// 否则任意查询都会从向量路捞回 top-20 弱相关 chunk,污染融合结果。
// 注意该值按 bge 系(SiliconFlow bge-m3)标定;官方 OpenAI text-embedding-3 系
// 相关对 cosine 分布整体偏低(0.25-0.5),若换该系模型需结合 scoresJson 实测重校。
const VECTOR_MIN_COSINE = 0.35

function parseJson(value: string | null): Record<string, unknown> | null {
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

/** 解析库内向量 JSON;坏行(截断/非数组)返回 null 跳过,不让单行脏数据毁掉整次检索。 */
function parseVector(value: string): number[] | null {
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed as number[] : null
  } catch {
    return null
  }
}

export async function ingestKnowledgeDocument(input: {
  title: string
  source?: string | null
  content: string
  metadata?: Record<string, unknown> | null
}) {
  const db = await getActivitiesDb()
  const documentId = generateId('kdoc')
  const chunks = input.content
    .split(/\n{2,}/)
    .map(chunk => chunk.trim())
    .filter(Boolean)
    .flatMap(chunk => {
      if (chunk.length <= 1400) return [chunk]
      const parts: string[] = []
      for (let index = 0; index < chunk.length; index += 1200) {
        parts.push(chunk.slice(index, index + 1200))
      }
      return parts
    })

  await db.insert(knowledgeDocuments).values({
    id: documentId,
    title: input.title,
    source: input.source ?? null,
    metadataJson: input.metadata ? JSON.stringify(input.metadata) : null,
  })

  // 先生成 id 再落库:后面写 knowledge_embeddings 要引用同一批 chunkId
  const chunkRecords = chunks.map((chunk, index) => ({
    id: generateId('kchunk'),
    documentId,
    chunkIndex: index,
    content: chunk,
    metadataJson: input.metadata ? JSON.stringify(input.metadata) : null,
  }))

  if (chunkRecords.length > 0) {
    await db.insert(knowledgeChunks).values(chunkRecords)
  }

  // best-effort 生成向量:未配置/失败只影响向量路(词法路不受损),绝不阻塞入库。
  // 漏掉的向量可随时用 scripts/backfill-knowledge-embeddings.ts 幂等补齐。
  let embedded = 0
  if (chunkRecords.length > 0) {
    try {
      const config = await getEmbeddingConfig()
      if (config) {
        const vectors = await embedTexts(chunkRecords.map(record => record.content), config)
        await db.insert(knowledgeEmbeddings).values(
          vectors.map((vector, index) => ({
            id: generateId('kemb'),
            chunkId: chunkRecords[index].id,
            provider: 'openai-compatible',
            model: config.model,
            vectorJson: JSON.stringify(vector),
          })),
        )
        embedded = vectors.length
      }
    } catch (error) {
      console.warn('[PR] knowledge embedding 生成失败(词法检索不受影响):', (error as Error).message)
    }
  }

  return { documentId, chunks: chunks.length, embedded }
}

export async function retrieveKnowledge(query: string, limit = 4): Promise<KnowledgeContext[]> {
  const db = await getActivitiesDb()
  const queryTokens = tokenizeQuery(query)
  if (queryTokens.length === 0) return []

  // 全量加载语料:去掉旧的「最近 200 条」上限,知识库变大后旧文档不再永久失联。
  // 量级 ≤ 数千 chunk,词法索引在 rag-lexical 内按 cacheKey 缓存,语料不变不重建。
  const [chunkRows, config] = await Promise.all([
    db.select().from(knowledgeChunks),
    // Reason: 配置库抖动按「未配置」处理降级词法,检索主链路不因 settings 读取失败而挂
    getEmbeddingConfig().catch(() => null),
  ])
  const maxCreatedAtEpoch = chunkRows.reduce((max, row) => Math.max(max, row.createdAt.getTime()), 0)
  // Reason: 缓存键掺入最大 chunk id——count:maxCreatedAt 是秒级的,同秒等量删除重灌
  // 或同进程切库(activities-client 30s TTL 换目标库)时两者可能恰好不变,索引会钉死
  // 旧 id 集导致检索静默清零;id 由 generateId 生成,重灌/换库必变,根治碰撞。
  let maxChunkId = ''
  for (const row of chunkRows) if (row.id > maxChunkId) maxChunkId = row.id
  const cacheKey = `${chunkRows.length}:${maxCreatedAtEpoch}:${maxChunkId}`

  // 词法路(永远在线):BM25 top-20
  const lexicalTop = lexicalTopK(chunkRows, cacheKey, query, CANDIDATE_POOL)
  const lexicalScoreById = new Map(lexicalTop.map(item => [item.id, item.score]))

  // 向量路:embedding 配置齐备才走;任何失败 warn 后按空候选处理,绝不向上抛
  let vectorTop: Array<{ id: string; score: number }> = []
  let queryEmbedded = false
  if (config && chunkRows.length > 0) {
    try {
      const embeddingRows = await db
        .select({ chunkId: knowledgeEmbeddings.chunkId, vectorJson: knowledgeEmbeddings.vectorJson })
        .from(knowledgeEmbeddings)
        .where(eq(knowledgeEmbeddings.model, config.model))
      // Reason: 当前模型无向量行(未回填/刚换模型)时跳过查询向量化——没有可打分对象,
      // 白花一次 embedding API 调用还拖聊天链路延迟;此时按纯词法处理。
      if (embeddingRows.length > 0) {
        const [queryVector] = await embedTexts([query], config)
        queryEmbedded = true
        const chunkIds = new Set(chunkRows.map(row => row.id))
        // 按 chunkId 聚合打分:Map 天然去掉同 chunk 重复向量行,避免 RRF 双重计分
        const scoreByChunk = new Map<string, number>()
        for (const row of embeddingRows) {
          const vector = parseVector(row.vectorJson)
          // 只保留当前语料快照里存在的 chunk(两次 select 间语料可能变化)
          if (!vector || !chunkIds.has(row.chunkId)) continue
          const score = cosineSimilarity(queryVector, vector)
          if (score >= VECTOR_MIN_COSINE) scoreByChunk.set(row.chunkId, score)
        }
        vectorTop = Array.from(scoreByChunk.entries())
          .map(([id, score]) => ({ id, score }))
          .sort((a, b) => b.score - a.score)
          .slice(0, CANDIDATE_POOL)
      }
    } catch (error) {
      console.warn('[PR] 向量检索失败,降级纯词法:', (error as Error).message)
    }
  }
  const vectorScoreById = new Map(vectorTop.map(item => [item.id, item.score]))
  // hybrid 判定看「向量路实际参与」(配置在且查询 embedding 成功),与候选数无关:
  // 阈值筛到 0 条也是 hybrid,降级/未配置/无向量行才是 lexical
  const mode: 'lexical' | 'hybrid' = queryEmbedded ? 'hybrid' : 'lexical'

  // RRF 融合:fused = Σ_路 1/(k + rank),rank 从 1 起;两路 top-20 并集按融合分排序
  const fusedById = new Map<string, number>()
  for (const path of [lexicalTop, vectorTop]) {
    path.forEach((item, index) => {
      fusedById.set(item.id, (fusedById.get(item.id) ?? 0) + 1 / (RRF_K + index + 1))
    })
  }

  const chunkById = new Map(chunkRows.map(row => [row.id, row]))
  const selectedEntries = Array.from(fusedById.entries())
    .sort((a, b) => b[1] - a[1])
    // 词法缓存键极端情况下可能滞后于语料(改内容不改行数+时间戳),兜底丢弃幽灵 id
    .flatMap(([id, rrf]) => {
      const chunk = chunkById.get(id)
      return chunk ? [{ chunk, rrf }] : []
    })
    .slice(0, limit)

  // documents source 映射:只查入选 chunk 涉及的 documentId
  const documentIds = Array.from(new Set(selectedEntries.map(entry => entry.chunk.documentId)))
  const documentRows = documentIds.length
    ? await db.select().from(knowledgeDocuments).where(inArray(knowledgeDocuments.id, documentIds))
    : []
  const documents = new Map(documentRows.map(row => [row.id, row]))

  const results: KnowledgeContext[] = selectedEntries.map(entry => ({
    id: entry.chunk.id,
    documentId: entry.chunk.documentId,
    content: entry.chunk.content,
    metadata: parseJson(entry.chunk.metadataJson),
    source: documents.get(entry.chunk.documentId)?.source ?? null,
    score: entry.rrf,
  }))

  try {
    await db.insert(ragRetrievalLogs).values({
      id: generateId('raglog'),
      query,
      queryPlanJson: JSON.stringify({
        mode,
        queryTokens,
        // embeddingModel 在「配置了但降级」时也保留:方便从日志区分未配置 vs 降级
        ...(config && { embeddingModel: config.model }),
        rrfK: RRF_K,
        limit,
        lexicalCandidates: lexicalTop.length,
        vectorCandidates: vectorTop.length,
      }),
      resultChunkIdsJson: JSON.stringify(results.map(row => row.id)),
      scoresJson: JSON.stringify(
        results.map(row => {
          const lexical = lexicalScoreById.get(row.id)
          const vector = vectorScoreById.get(row.id)
          return {
            id: row.id,
            // 双路原始分只在该 chunk 实际入选该路 top-20 时记录
            ...(lexical !== undefined && { lexical }),
            ...(vector !== undefined && { vector }),
            rrf: row.score,
          }
        }),
      ),
      selectedChunkIdsJson: JSON.stringify(results.map(row => row.id)),
    })
  } catch (error) {
    console.warn('[PR] failed to write rag retrieval log:', (error as Error).message)
  }

  return results
}
