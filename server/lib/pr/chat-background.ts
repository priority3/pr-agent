/**
 * PR 对话的后台任务(回复已落库后异步跑,失败只记日志、不影响对话):
 * - writeSnapshot:agent run 的 step 快照(chat 主流程也用,一并放这)
 * - curateChatMemoryInBackground:MemoryCurator 蒸馏候选记忆
 * - refreshThreadSummaryInBackground:会话标题/摘要按轮次节流刷新
 * 自 chat.ts 拆出(该文件超 500 行红线)。
 */
import { desc, eq, sql } from 'drizzle-orm'

import { getActivitiesDb } from '@/lib/db/client'
import {
  agentStateSnapshots,
  conversationMessages,
  conversationThreads,
} from '@/lib/db/schema'
import { clip, OI, withSpan } from '@/lib/observability/trace'
import { generateId } from '@/lib/utils'

import { applyMemoryPatch, curateMemoryPatches } from './memory'
import { callPrModel, parseModelJson } from './model'
import { buildThreadSummarySystemPrompt, buildThreadSummaryUserPrompt } from './prompts'

// 与对话生成共用同一预算旋钮(thinking 模型正文预算见 chat.ts 注释)。
const THREAD_SUMMARY_MAX_TOKENS = Number(process.env.PR_CHAT_MAX_TOKENS) || 2000

export async function writeSnapshot(runId: string, step: string, state: unknown) {
  const db = await getActivitiesDb()
  await db.insert(agentStateSnapshots).values({
    id: generateId('snap'),
    runId,
    step,
    stateJson: JSON.stringify(state),
  })
}

/**
 * MemoryCurator 后台任务:把本轮用户消息交给 LLM 蒸馏成候选记忆并落库。
 * 独立于回复路径运行(见 chatWithPr 里的 void 调用),失败只记日志、不影响对话。
 */
export async function curateChatMemoryInBackground(
  runId: string,
  userMessageId: string,
  message: string,
  history: Array<{ role: string; content: string }>,
) {
  return withSpan('pr.curate_memory', 'CHAIN', { 'pr.run_id': runId, [OI.INPUT]: clip(message, 1000) }, async span => {
    const context = history.length
      ? history.map(turn => `${turn.role === 'assistant' ? 'PR' : '用户'}：${turn.content}`).join('\n')
      : null
    const patches = await curateMemoryPatches({
      source: 'conversation_message',
      refId: userMessageId,
      text: message,
      context,
    })
    const learnedMemoryIds: string[] = []
    for (const [index, patch] of patches.entries()) {
      try {
        learnedMemoryIds.push(
          await applyMemoryPatch(patch, {
            actor: 'user',
            idempotencyKey: `chat:${userMessageId}:memory:${index}`,
            runId,
          }),
        )
      } catch (error) {
        console.warn('[pr-chat] 记忆写入失败:', (error as Error).message)
      }
    }
    span.setAttribute(OI.OUTPUT, JSON.stringify({ patchCount: patches.length, learned: learnedMemoryIds.length }))
    await writeSnapshot(runId, 'curate_memory', { learnedMemoryIds, patchCount: patches.length })
  })
}

const THREAD_SUMMARY_REFRESH_EVERY = 10

/**
 * 会话标题/摘要后台任务:首轮结束后生成一次,之后每 5 轮(10 条消息)随话题漂移刷新,
 * 写回 conversation_threads.title/summary。失败只记日志——列表兜底显示首句截断标题。
 */
export async function refreshThreadSummaryInBackground(runId: string, threadId: string) {
  return withSpan('pr.thread_summary', 'CHAIN', { 'pr.run_id': runId, [OI.SESSION_ID]: threadId }, async span => {
    const db = await getActivitiesDb()
    const [countRow] = await db
      .select({ total: sql<number>`count(*)` })
      .from(conversationMessages)
      .where(eq(conversationMessages.threadId, threadId))
    const total = Number(countRow?.total ?? 0)
    // Reason: 每条消息都调 LLM 太贵;首轮(2 条)先给准确标题,其后仅在整刷新周期时重算。
    if (total !== 2 && (total === 0 || total % THREAD_SUMMARY_REFRESH_EVERY !== 0)) {
      span.setAttribute(OI.OUTPUT, `skipped (total=${total})`)
      return
    }

    const rows = await db
      .select()
      .from(conversationMessages)
      .where(eq(conversationMessages.threadId, threadId))
      .orderBy(desc(conversationMessages.createdAt))
      .limit(12)
    const transcript = rows
      .reverse()
      .map(message => `${message.role === 'assistant' ? 'PR' : '用户'}：${message.content.slice(0, 160)}`)
      .join('\n')
    if (!transcript) return

    const generated = await callPrModel(
      buildThreadSummarySystemPrompt(),
      buildThreadSummaryUserPrompt(transcript),
      { maxTokens: THREAD_SUMMARY_MAX_TOKENS },
    )
    const parsed = parseModelJson(generated.content) as { title?: unknown; summary?: unknown }
    const title = typeof parsed.title === 'string' ? parsed.title.trim().replace(/["「」『』]/g, '').slice(0, 16) : ''
    const summary = typeof parsed.summary === 'string' ? parsed.summary.trim().slice(0, 60) : ''
    if (!title && !summary) return

    await db
      .update(conversationThreads)
      .set({
        ...(title ? { title } : {}),
        ...(summary ? { summary } : {}),
        updatedAt: new Date(),
      })
      .where(eq(conversationThreads.id, threadId))
    span.setAttribute(OI.OUTPUT, JSON.stringify({ total, title, summary }))
    await writeSnapshot(runId, 'summarize_thread', { total, title, summary })
  })
}
