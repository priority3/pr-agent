import OpenAI from 'openai'

import { getRuntimeSettings } from '@/lib/config'

/**
 * PR 知识库 embedding 客户端(OpenAI 兼容协议,SiliconFlow bge-m3 等均可)。
 *
 * 配置由 admin settings 驱动(PR_EMBEDDING_* 三键):KEY 与 MODEL 齐备才启用,
 * 否则消费方(rag.ts 检索管线 / ingest / 回填脚本)一律走纯词法路径。
 */
export interface EmbeddingConfig {
  apiKey: string
  baseUrl?: string
  model: string
}

/** 单次 embeddings 请求的最大条数:兼容 SiliconFlow 等服务的批量上限。 */
const EMBED_BATCH_SIZE = 32

/**
 * 读取 embedding 配置;KEY 与 MODEL 齐备才返回,否则 null(= 向量路未启用)。
 * BASE_URL 可空 = 官方 OpenAI 端点。
 */
export async function getEmbeddingConfig(): Promise<EmbeddingConfig | null> {
  const settings = await getRuntimeSettings({ force: true })
  // Reason: trim 掉粘贴带入的首尾空白——model 在库内做精确匹配,一个尾随空格
  // 就等效「换模型」,旧向量全部隐身且日志上与未回填不可区分。
  const apiKey = settings.PR_EMBEDDING_API_KEY?.trim()
  const model = settings.PR_EMBEDDING_MODEL?.trim()
  const baseUrl = settings.PR_EMBEDDING_BASE_URL?.trim()
  if (!apiKey || !model) return null
  return {
    apiKey,
    model,
    ...(baseUrl && { baseUrl }),
  }
}

/**
 * 批量向量化文本,返回顺序与输入一一对应。
 * @param config 调用方已读取的配置。省略时内部读取;已持有配置的调用方(检索/ingest/回填)
 *   必须传入——否则两次 settings 读取间 admin 改 PR_EMBEDDING_MODEL 会产生跨模型比对
 *   或向量行错标模型的竞态,且在线链路多付一次配置库往返。
 * 未配置 embedding 时抛错(调用方应先经 getEmbeddingConfig 判定,或捕获后降级词法)。
 */
export async function embedTexts(texts: string[], config?: EmbeddingConfig): Promise<number[][]> {
  const resolved = config ?? await getEmbeddingConfig()
  if (!resolved) throw new Error('未配置 embedding 服务（PR_EMBEDDING_API_KEY / PR_EMBEDDING_MODEL）')
  if (texts.length === 0) return []

  const client = new OpenAI({
    apiKey: resolved.apiKey,
    ...(resolved.baseUrl && { baseURL: resolved.baseUrl }),
    // Reason: 检索挂在在线聊天链路上,knowledgeProvider 整体只有 5s 预算——embedding
    // 3s 封顶且不重试,给词法结果与后续查库留出余量;失败由调用方捕获后静默降级词法。
    timeout: 3000,
    maxRetries: 0,
  })

  const vectors: number[][] = []
  for (let start = 0; start < texts.length; start += EMBED_BATCH_SIZE) {
    const batch = texts.slice(start, start + EMBED_BATCH_SIZE)
    // Reason: 不传 encoding_format 时 SDK 默认请求 base64 并在客户端解码;部分 OpenAI
    // 兼容网关不认 base64、照旧回 float 数组,SDK 拿数组当 base64 解会把向量搅成空数组
    // (静默存 "[]",召回全灭)。显式 float 是兼容面最大的格式,SDK 原样透传不做后处理。
    const response = await client.embeddings.create({
      model: resolved.model,
      input: batch,
      encoding_format: 'float',
    })
    // Reason: 协议不承诺 data 与 input 同序,item.index 才是权威位置——按 index 归位再拼接,
    // 保证返回向量与输入文本严格对齐。
    const batchVectors: (number[] | undefined)[] = new Array(batch.length)
    for (const item of response.data) {
      batchVectors[item.index] = item.embedding
    }
    for (let offset = 0; offset < batch.length; offset++) {
      const vector = batchVectors[offset]
      // 空向量与缺失同罪:存进库只会让该 chunk 对任何查询 cosine=0,宁可抛错让调用方降级
      if (!vector || vector.length === 0) throw new Error(`embedding 响应缺少第 ${start + offset} 条输入的向量`)
      vectors.push(vector)
    }
  }
  return vectors
}

/**
 * 余弦相似度。维度不等直接返回 0(而非按短边截断):唯二能走到这里的异构维度路径
 * 是「换模型竞态残留」与「网关返回错长向量」,都属脏数据——0 分会被检索阈值挡掉,
 * 静默截断则会产出看似合法的错误分数。任一为零向量(或空)同样返回 0,避免除零 NaN。
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}
