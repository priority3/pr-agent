/**
 * 存量知识库 chunk 的 embedding 回填(幂等,可反复重跑)。
 *
 * 找出「当前配置模型下还没有向量行」的 chunk,批量向量化后写入 knowledge_embeddings;
 * 已有该模型向量的 chunk 自动跳过,中途失败重跑即续传。换 embedding 模型后旧向量
 * 按 model 过滤自然失效,重跑本脚本即可为新模型补齐全量向量。
 *
 * 用法:
 *   bun run scripts/backfill-knowledge-embeddings.ts
 *
 * 数据库与凭据解析与服务进程完全一致:库连接走 getActivitiesDb()(DATABASE_URL),
 * embedding 凭据走 PR_EMBEDDING_API_KEY / PR_EMBEDDING_MODEL(env)。
 * 未配置 embedding 时以退出码 1 结束;有批次失败时以退出码 2 结束(幂等,重跑续传)——
 * cron/CI 挂本脚本可凭非零退出码感知回填未完成,避免「配置了但没向量→静默降级词法」被长期忽略。
 *
 * 从宿主 runPaceFlow-admin 迁入:知识库与 embedding 的 owner 是本仓,维护脚本跟着走。
 */
import { eq } from 'drizzle-orm'

import { getActivitiesDb } from '@/lib/db/client'
import { knowledgeChunks, knowledgeEmbeddings } from '@/lib/db/schema'
import { embedTexts, getEmbeddingConfig } from '@/lib/pr/embeddings'
import { generateId } from '@/lib/utils'

// 每批 embed + 落库的 chunk 数:与 embeddings.ts 的单请求批量上限对齐,
// 单批失败只损失这一批(幂等,重跑续传),不做整体回滚。
const BATCH_SIZE = 32

async function main() {
  const config = await getEmbeddingConfig()
  if (!config) {
    console.error('未配置 embedding 服务:请先填 PR_EMBEDDING_API_KEY / PR_EMBEDDING_MODEL')
    process.exit(1)
  }

  const db = await getActivitiesDb()
  const chunkRows = await db
    .select({ id: knowledgeChunks.id, content: knowledgeChunks.content })
    .from(knowledgeChunks)
  const embeddedRows = await db
    .select({ chunkId: knowledgeEmbeddings.chunkId })
    .from(knowledgeEmbeddings)
    .where(eq(knowledgeEmbeddings.model, config.model))
  const embeddedChunkIds = new Set(embeddedRows.map(row => row.chunkId))
  const missing = chunkRows.filter(row => !embeddedChunkIds.has(row.id))
  const existing = chunkRows.length - missing.length

  console.log(`模型 ${config.model}:总 chunk ${chunkRows.length},已有向量 ${existing},待回填 ${missing.length}`)

  let inserted = 0
  let failed = 0
  for (let start = 0; start < missing.length; start += BATCH_SIZE) {
    const batch = missing.slice(start, start + BATCH_SIZE)
    const progress = `[${Math.min(start + BATCH_SIZE, missing.length)}/${missing.length}]`
    try {
      // Reason: 传入启动时读定的 config——embedTexts 内部重读配置的话,回填中途
      // 改 PR_EMBEDDING_MODEL 会把新模型向量落成旧模型标签,污染幂等判定且重跑不修复。
      const vectors = await embedTexts(batch.map(row => row.content), config)
      await db.insert(knowledgeEmbeddings).values(
        vectors.map((vector, index) => ({
          id: generateId('kemb'),
          chunkId: batch[index].id,
          provider: 'openai-compatible',
          model: config.model,
          vectorJson: JSON.stringify(vector),
        })),
      )
      inserted += batch.length
      console.log(`${progress} 已写入 ${batch.length} 条`)
    } catch (error) {
      failed += batch.length
      console.warn(`${progress} 本批失败(重跑可续传): ${(error as Error).message}`)
    }
  }

  console.log(`\n完成:总 chunk ${chunkRows.length} / 已有 ${existing} / 新增 ${inserted} / 失败 ${failed}`)
  // Reason: 远程 libsql 客户端的连接会挂住事件循环,统计打印完显式退出;
  // 失败批次以退出码 2 上抛,自动化调用方能感知「回填未完成」。
  process.exit(failed > 0 ? 2 : 0)
}

main().catch(error => {
  console.error('回填失败:', error)
  process.exit(1)
})
