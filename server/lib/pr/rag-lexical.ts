/**
 * PR 知识库词法检索层:CJK 2-gram 分词 + BM25 打分(纯函数,不碰数据库)。
 *
 * Reason: 旧 tokenize 按非字母数字切分,中文整句成一个 token、靠 includes 子串兜底,
 * 近义短语几乎召回不到;2-gram 让中文短语之间有共享片段可命中,BM25 提供带词频与
 * 文档长度归一的可比分数。零外部依赖——评测隔离库、无 embedding 凭据的部署都能用,
 * 词法路是混合检索里永远在线的基线(rag.ts 负责调库与融合,本模块只做纯计算)。
 */

// ---------- 分词 ----------

// 按字符类别把文本切成 run:组 1 = Han 连续段,组 2 = 其他字母/数字连续段。
// Reason: [\p{L}\p{N}] 本身包含汉字,第二支必须用负向前瞻排除 Han,
// 否则 "跑量volume" 这类中英混排会被贪婪吞成同一个 run。
const RUN_PATTERN = /(\p{Script=Han}+)|((?:(?!\p{Script=Han})[\p{L}\p{N}])+)/gu

/**
 * 语料侧分词:保留重复出现(BM25 要词频 tf)。
 * - 拉丁/数字 run → lowercase 整词且长度 ≥2(与旧 tokenize 行为对齐);
 * - Han run → 相邻字符 2-gram(run 仅 1 字时保留该单字;注意这只让「语料里孤立的
 *   单字 run」可被命中——多字语料只产 2-gram,单字查询(如「疼」)对其零召回,
 *   是对称 2-gram 的固有取舍)。
 */
function tokenize(text: string): string[] {
  const tokens: string[] = []
  for (const match of text.matchAll(RUN_PATTERN)) {
    const hanRun = match[1]
    if (hanRun !== undefined) {
      // Reason: 用 Array.from 按码点切,扩展区汉字(代理对)不会被 slice 劈成半个字符
      const chars = Array.from(hanRun)
      if (chars.length === 1) {
        tokens.push(chars[0])
      } else {
        for (let index = 0; index < chars.length - 1; index++) {
          tokens.push(chars[index] + chars[index + 1])
        }
      }
    } else {
      const word = match[2].toLowerCase()
      if (word.length >= 2) tokens.push(word)
    }
  }
  return tokens
}

/** 查询侧分词:规则同语料侧,额外去重(BM25 每个查询词只计一次贡献)。 */
export function tokenizeQuery(text: string): string[] {
  return Array.from(new Set(tokenize(text)))
}

// ---------- BM25 索引与打分 ----------

const BM25_K1 = 1.2
const BM25_B = 0.75

interface Bm25Index {
  /** 倒排表:token → (chunk 下标 → 该 chunk 内词频 tf)。 */
  postings: Map<string, Map<number, number>>
  /** chunk 下标 → chunk id。 */
  ids: string[]
  /** chunk 下标 → 该 chunk 的 token 总数(BM25 长度归一用)。 */
  lengths: number[]
  avgLength: number
  /** 语料 chunk 总数 N。 */
  count: number
}

function buildIndex(chunks: Array<{ id: string; content: string }>): Bm25Index {
  const postings = new Map<string, Map<number, number>>()
  const ids: string[] = []
  const lengths: number[] = []
  let totalLength = 0
  chunks.forEach((chunk, index) => {
    ids.push(chunk.id)
    const tokens = tokenize(chunk.content)
    lengths.push(tokens.length)
    totalLength += tokens.length
    for (const token of tokens) {
      let entry = postings.get(token)
      if (!entry) {
        entry = new Map()
        postings.set(token, entry)
      }
      entry.set(index, (entry.get(index) ?? 0) + 1)
    }
  })
  return {
    postings,
    ids,
    lengths,
    avgLength: chunks.length > 0 ? totalLength / chunks.length : 0,
    count: chunks.length,
  }
}

/** BM25 累加:对每个查询 token 命中的 chunk 加上 idf × tf 饱和项。 */
function scoreByIndex(index: Bm25Index, queryTokens: string[]): Map<number, number> {
  const scores = new Map<number, number>()
  for (const token of queryTokens) {
    const entry = index.postings.get(token)
    if (!entry) continue
    const df = entry.size
    // idf = ln(1 + (N−df+0.5)/(df+0.5)),恒 >0,命中即有正贡献
    const idf = Math.log(1 + (index.count - df + 0.5) / (df + 0.5))
    for (const [chunkIndex, tf] of entry) {
      // 倒排非空 ⇒ 语料至少含一个 token ⇒ avgLength > 0,除法安全
      const lengthNorm = 1 - BM25_B + (BM25_B * index.lengths[chunkIndex]) / index.avgLength
      const gain = (idf * tf * (BM25_K1 + 1)) / (tf + BM25_K1 * lengthNorm)
      scores.set(chunkIndex, (scores.get(chunkIndex) ?? 0) + gain)
    }
  }
  return scores
}

// 模块级单槽缓存:知识库为管理端手工灌入、量级 ≤ 数千 chunk,整库重建毫秒级,
// 不做增量。调用方用 `count:maxCreatedAt:maxChunkId` 生成 cacheKey,任一变化即全量重建。
let cachedKey: string | null = null
let cachedIndex: Bm25Index | null = null

/**
 * 词法检索:对 chunks 建(或复用)BM25 索引,返回分数 >0 的降序 top-K。
 *
 * @param chunks 全量语料(cacheKey 命中缓存时忽略,不重复建索引)
 * @param cacheKey 语料版本键,变化即重建索引
 */
export function lexicalTopK(
  chunks: Array<{ id: string; content: string }>,
  cacheKey: string,
  query: string,
  topK: number,
): Array<{ id: string; score: number }> {
  if (cachedIndex === null || cachedKey !== cacheKey) {
    cachedIndex = buildIndex(chunks)
    cachedKey = cacheKey
  }
  const index = cachedIndex
  const queryTokens = tokenizeQuery(query)
  if (queryTokens.length === 0) return []

  return Array.from(scoreByIndex(index, queryTokens).entries())
    .filter(([, score]) => score > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK)
    .map(([chunkIndex, score]) => ({ id: index.ids[chunkIndex], score }))
}
