import { SpanStatusCode, type Span } from '@opentelemetry/api'
import { desc, eq } from 'drizzle-orm'

import { getActivitiesDb } from '@/lib/db/client'
import { clip, OI, withSpan } from '@/lib/observability/trace'
import {
  agentRuns,
  conversationMessages,
  conversationThreads,
} from '@/lib/db/schema'
import { generateId } from '@/lib/utils'

import {
  curateChatMemoryInBackground,
  refreshThreadSummaryInBackground,
  writeSnapshot,
} from './chat-background'
import type { CompanionProfileContext } from './context'
import { evaluateChatReply, type ChatEvalContext } from './evaluator'
import type { MemoryContext } from './memory'
import { callPrModel, type PrModelMessage, type PrStreamEvent } from './model'
import {
  buildChatContextTurn,
  buildChatRewriteNote,
  buildChatSystemPrompt,
  buildRuleBasedChatReply,
} from './prompts-chat'
import { executeProviderTool, loadContextBlocks, providerTools } from './providers/registry'
import type { KnowledgeContext } from './rag'
import { readImageUpload, uploadNameFromUrl } from './uploads'

type ChatImage = { base64: string; mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' }

// v3:上下文装配收敛为 ContextProvider 注册表(providers/),新增环境感知维度。
const PR_CHAT_BUILDER_VERSION = 'pr-chat-v3'

// 对话生成的 token 预算。可用 PR_CHAT_MAX_TOKENS 覆盖。
// Reason: 现网关模型 mimo-v2.5-pro 是 thinking 型,会先把预算花在 thinking 上;旧值 500/160 太小
// → 频繁只产出 thinking 块、正文为空(生产日志刷「空响应,重试 stop=max_tokens blocks=[thinking]」+
// 会话摘要失败)。上调默认到 2000 让正文能完整产出(评测验证 2000+ 稳定出正文);仍保留
// 空响应重试兜底。若换回非 thinking 模型可用 env 调低。
const CHAT_MAX_TOKENS = Number(process.env.PR_CHAT_MAX_TOKENS) || 2000

function serialize(value: unknown) {
  return JSON.stringify(value)
}

function titleFromMessage(message: string) {
  return message.trim().slice(0, 36) || 'PR 对话'
}

/**
 * Latest thread updated within `withinMs` (default 24h), else null.
 * Reason: WeChat has no per-message thread id; for this single-user companion we keep
 * a rolling conversation so multi-turn context carries across messages, but start fresh
 * after a long gap so an old topic doesn't bleed into a new one.
 */
export async function getRecentThreadId(withinMs = 24 * 60 * 60 * 1000): Promise<string | null> {
  const db = await getActivitiesDb()
  const [row] = await db
    .select()
    .from(conversationThreads)
    .orderBy(desc(conversationThreads.lastMessageAt))
    .limit(1)
  if (!row?.lastMessageAt) return null
  return Date.now() - row.lastMessageAt.getTime() <= withinMs ? row.id : null
}

export interface ChatWithPrInput {
  message: string
  threadId?: string | null
  imageUrl?: string | null
  /** 流式增量回调(thinking/text/tool/text_reset),透传给 FriendPersona;重写轮不流。 */
  onStream?: (evt: PrStreamEvent) => void
}

export async function chatWithPr(input: ChatWithPrInput) {
  // 根 span:整条对话编排(Phoenix 里按 session.id=threadId 聚合成会话视图)
  return withSpan(
    'pr.chat',
    'AGENT',
    { [OI.INPUT]: clip(input.message, 2000), 'pr.has_image': Boolean(input.imageUrl) },
    rootSpan => chatWithPrInner(input, rootSpan),
  )
}

async function chatWithPrInner(input: ChatWithPrInput, rootSpan: Span) {
  const db = await getActivitiesDb()
  const now = new Date()
  let threadId = input.threadId ?? null

  // 图片附件(如有):读盘 → base64 供视觉模型;imageUrl 存进消息 contextJson 以便历史重现。
  const imageUrl = input.imageUrl || null
  let images: ChatImage[] = []
  if (imageUrl) {
    const name = uploadNameFromUrl(imageUrl)
    const img = name ? await readImageUpload(name) : null
    if (img) images = [{ base64: img.bytes.toString('base64'), mediaType: img.mediaType as ChatImage['mediaType'] }]
  }

  if (!threadId) {
    threadId = generateId('thread')
    await db.insert(conversationThreads).values({
      id: threadId,
      title: titleFromMessage(input.message),
      lastMessageAt: now,
    })
  } else {
    await db
      .update(conversationThreads)
      .set({ lastMessageAt: now, updatedAt: now })
      .where(eq(conversationThreads.id, threadId))
  }

  const runId = generateId('run')
  await db.insert(agentRuns).values({
    id: runId,
    idempotencyKey: `chat:${threadId}:${Date.now().toString(36)}`,
    trigger: 'user_question',
    subjectType: 'conversation',
    subjectId: threadId,
    status: 'running',
    builderVersion: PR_CHAT_BUILDER_VERSION,
    attempts: 1,
    lastStep: 'load_facts',
    startedAt: now,
  })

  rootSpan.setAttribute(OI.SESSION_ID, threadId)
  rootSpan.setAttribute('pr.run_id', runId)

  const userMessageId = generateId('msg')
  await db.insert(conversationMessages).values({
    id: userMessageId,
    threadId,
    runId,
    role: 'user',
    content: input.message.trim() || '[图片]',
    contextJson: imageUrl ? serialize({ imageUrl }) : null,
  })

  try {
    // 今天日期(Asia/Shanghai)——不给这行,模型的所有时间推理只能靠上下文里的日期反猜
    const todayDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date())
    const todayWeekday = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', weekday: 'long' }).format(new Date())
    const today = `${todayDate}（${todayWeekday}，Asia/Shanghai）`

    // ── build_context (ContextProvider 注册表统一装配 + 会话历史) ──
    // 每个 provider 在 registry 内独立超时/降级:任一失败都不该让对话挂掉。
    const [{ blocks, outcomes }, recentMessages] = await withSpan('pr.build_context', 'CHAIN', {}, async span => {
      const results = await Promise.all([
        loadContextBlocks({ message: input.message, today, hasImage: images.length > 0 }),
        db
          .select()
          .from(conversationMessages)
          .where(eq(conversationMessages.threadId, threadId))
          .orderBy(desc(conversationMessages.createdAt))
          .limit(6),
      ])
      span.setAttribute(
        OI.OUTPUT,
        JSON.stringify({
          blocks: results[0].blocks.map(block => block.key),
          outcomes: results[0].outcomes,
          historyRows: results[1].length,
        }),
      )
      return results
    })

    // 编排层按 key 取 provider 的结构化载荷(evalCtx / 持久化 / 快照;渲染只用 blocks 行)
    const blockData = new Map(blocks.map(block => [block.key, block.data]))
    const memoryItems = (blockData.get('memory') as MemoryContext[] | undefined) ?? []
    const knowledge = (blockData.get('knowledge') as KnowledgeContext[] | undefined) ?? []
    const profile = blockData.get('profile') as CompanionProfileContext | undefined
    const healthData = blockData.get('health') as { hasHealth: boolean } | undefined
    const activityData = blockData.get('activities') as
      | { recentActivityCount: number; lastRunDaysAgo: number | null }
      | undefined
    const goalData = blockData.get('goals') as { goalLines: string[] } | undefined
    const envData = blockData.get('environment') as { hasEnvironment: boolean } | undefined

    // 历史(不含刚插入的这条)→ 原生多轮 turns(参考 Claude Code,不再压平成文本):
    // 合并连续同角色(assistant 落库失败会产生连续 user)满足 API 交替要求,首条必须是 user;
    // 同时从历史 assistant 的 context_json 收集已执行过的工具调用,防止跨轮重复查。
    const historyRows = recentMessages.filter(message => message.id !== userMessageId).reverse()
    const turns: PrModelMessage[] = []
    const priorToolCalls: string[] = []
    for (const row of historyRows) {
      const role = row.role === 'assistant' ? ('assistant' as const) : ('user' as const)
      if (role === 'assistant' && row.contextJson) {
        try {
          const ctx = JSON.parse(row.contextJson) as {
            toolCalls?: Array<{ name: string; input: unknown; resultPreview?: string }>
          }
          for (const call of ctx.toolCalls ?? []) {
            priorToolCalls.push(
              `- ${call.name}(${JSON.stringify(call.input)})${call.resultPreview ? ` → ${call.resultPreview}` : ''}`,
            )
          }
        } catch {
          /* 老消息无此结构,忽略 */
        }
      }
      const prev = turns[turns.length - 1]
      if (prev && prev.role === role) prev.content += `\n${row.content}`
      else turns.push({ role, content: row.content })
    }
    while (turns.length && turns[0].role === 'assistant') turns.shift()
    const historyForCuration = historyRows.map(row => ({ role: row.role, content: row.content }))

    // 当前这轮 = <context> 背景块 + 用户原话;若历史末尾已是 user(上一轮 assistant 落库失败),合并进去保持交替
    const contextTurn = buildChatContextTurn({
      message: input.message,
      today,
      blocks: blocks.map(block => ({ title: block.title, lines: block.lines })),
      priorToolCalls: priorToolCalls.slice(-4),
      hasImage: images.length > 0,
    })
    const lastTurn = turns[turns.length - 1]
    if (lastTurn && lastTurn.role === 'user') lastTurn.content += `\n\n${contextTurn}`
    else turns.push({ role: 'user', content: contextTurn })

    await writeSnapshot(runId, 'build_context', {
      memoryIds: memoryItems.map(memory => memory.id),
      knowledgeCount: knowledge.length,
      historyTurns: historyRows.length,
      today,
      priorToolCallCount: Math.min(priorToolCalls.length, 4),
      hasHealth: healthData?.hasHealth ?? false,
      hasEnvironment: envData?.hasEnvironment ?? false,
      recentActivityCount: activityData?.recentActivityCount ?? 0,
      lastRunDaysAgo: activityData?.lastRunDaysAgo ?? null,
      raceGoals: goalData?.goalLines ?? [],
      profileVersion: profile?.projectionVersion ?? null,
      providers: outcomes,
    })

    // ── draft_response (FriendPersona) + evaluate_response (Evaluator, 最多重写一次) ──
    const evalCtx: ChatEvalContext = {
      hasHealth: healthData?.hasHealth ?? false,
      hasMemoryOrHabit: memoryItems.length > 0 || (profile?.trainingPreferences.length ?? 0) > 0,
      doNotAssume: profile?.doNotAssume ?? [],
      hasEnvironment: envData?.hasEnvironment ?? false,
    }
    // FriendPersona 带只读工具(providers 聚合):快照不够时自己查(每次调用写 tool_use 快照可回放)
    const toolCalls: Array<{ name: string; input: unknown; resultPreview?: string }> = []
    const modelOpts = {
      maxTokens: CHAT_MAX_TOKENS,
      images,
      tools: providerTools(),
      executeTool: executeProviderTool,
      onToolCall: (name: string, toolInput: unknown, result: string) => {
        toolCalls.push({ name, input: toolInput, resultPreview: result.slice(0, 300) })
        void writeSnapshot(runId, 'tool_use', { name, input: toolInput, result: result.slice(0, 600) }).catch(() => {})
      },
    }
    // persona 带流式回调;rewrite 不带 —— 二稿 delta 交错会把客户端已收起的思考/正文搅乱,
    // 改写场景由路由层对比 streamedText 与最终 answer 后发 replace 整段替换。
    const persona = () => callPrModel(buildChatSystemPrompt(), turns, { ...modelOpts, onStream: input.onStream })
    // 重写 = 追加一轮(assistant 初稿 + 系统评审),模型看着自己写的定向修,而不是丢稿盲写。
    // images 会附着到最后一条 user(评审轮),模型重写时仍看得到图。
    const rewrite = (draft: string, rewriteWarnings: string[]) =>
      callPrModel(
        buildChatSystemPrompt(),
        [...turns, { role: 'assistant', content: draft }, { role: 'user', content: buildChatRewriteNote(rewriteWarnings) }],
        modelOpts,
      )

    let answer = buildRuleBasedChatReply()
    let model = 'rule-based-chat-v1'
    let provider = 'local-rule'
    let warnings: string[] = []
    let attempts = 0

    try {
      const first = await persona()
      attempts = 1
      answer = first.content.trim() || buildRuleBasedChatReply('模型返回空内容')
      model = first.model
      provider = first.provider
      const firstEval = await withSpan(
        'pr.evaluate',
        'EVALUATOR',
        { 'pr.attempt': 1, [OI.INPUT]: clip(answer, 1500) },
        async span => {
          const evaluation = evaluateChatReply(answer, evalCtx)
          span.setAttribute(OI.OUTPUT, JSON.stringify(evaluation))
          return evaluation
        },
      )
      warnings = firstEval.warnings
      await writeSnapshot(runId, 'draft_response', { attempt: 1, model, provider, length: answer.length })
      await writeSnapshot(runId, 'evaluate_response', { attempt: 1, passed: firstEval.passed, warnings: firstEval.warnings })

      if (!firstEval.passed) {
        // Evaluator 不合格 → 把初稿和评审意见作为追加轮次让模型定向重写(最多一次)。
        try {
          const second = await rewrite(answer, firstEval.warnings)
          const rewritten = second.content.trim()
          const secondEval = await withSpan(
            'pr.evaluate',
            'EVALUATOR',
            { 'pr.attempt': 2, [OI.INPUT]: clip(rewritten, 1500) },
            async span => {
              const evaluation = evaluateChatReply(rewritten, evalCtx)
              span.setAttribute(OI.OUTPUT, JSON.stringify(evaluation))
              return evaluation
            },
          )
          await writeSnapshot(runId, 'draft_response', { attempt: 2, model: second.model, length: rewritten.length })
          await writeSnapshot(runId, 'evaluate_response', { attempt: 2, passed: secondEval.passed, warnings: secondEval.warnings })
          if (rewritten) {
            // 仅当重写真的产出内容、被采用时才算第二次尝试;空重写沿用初版,attempts 仍为 1
            attempts = 2
            answer = rewritten
            model = second.model
            provider = second.provider
            warnings = secondEval.warnings
          }
        } catch (rewriteError) {
          console.warn('[pr-chat] 重写失败，沿用初版:', (rewriteError as Error).message)
        }
      }
    } catch (personaError) {
      console.warn('[pr-chat] FriendPersona 生成失败，回退兜底:', (personaError as Error).message)
      answer = buildRuleBasedChatReply((personaError as Error).message)
      model = 'rule-based-chat-v1'
      provider = 'local-rule'
      await writeSnapshot(runId, 'draft_response', { fallback: true, error: (personaError as Error).message })
    }

    // ── persist_output (assistant message + context_json 可追溯) ──
    await db.insert(conversationMessages).values({
      id: generateId('msg'),
      threadId,
      runId,
      role: 'assistant',
      content: answer,
      memoryRefsJson: serialize(memoryItems.map(memory => memory.id)),
      contextJson: serialize({
        memoryItems,
        knowledge,
        raceGoals: goalData?.goalLines ?? [],
        evaluatorWarnings: warnings,
        attempts,
        model,
        provider,
        toolCalls,
      }),
    })
    await writeSnapshot(runId, 'persist_output', { model, provider, warnings, attempts, toolCallCount: toolCalls.length })

    await db
      .update(agentRuns)
      .set({
        status: 'succeeded',
        model,
        lastStep: 'persist_output',
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(agentRuns.id, runId))

    // ── curate_memory (MemoryCurator, LLM 蒸馏) ──
    // 回复落库后作为后台任务跑:既满足"输出之后再固化记忆"(不污染当前回复),又不让
    // 第二次模型调用拖慢用户拿到回复(微信/前端都不等它)。产出一律候选,晋升靠确认或多证据。
    void curateChatMemoryInBackground(runId, userMessageId, input.message, historyForCuration).catch(error =>
      console.warn('[pr-chat] 后台记忆蒸馏失败:', (error as Error).message),
    )

    // ── summarize_thread (会话标题/摘要,后台,按轮次节流) ──
    void refreshThreadSummaryInBackground(runId, threadId).catch(error =>
      console.warn('[pr-chat] 会话摘要失败:', (error as Error).message),
    )

    rootSpan.setAttribute(OI.OUTPUT, clip(answer, 2000))
    rootSpan.setAttribute('pr.model', model)
    rootSpan.setAttribute('pr.attempts', attempts)
    rootSpan.setAttribute('pr.tool_calls', toolCalls.length)
    if (warnings.length) rootSpan.setAttribute('pr.warnings', warnings.join('；'))
    return { threadId, runId, answer, model, provider, warnings, learnedMemoryIds: [] }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn('[pr-chat] 编排失败:', message)
    await writeSnapshot(runId, 'failed', { error: message }).catch(() => {})
    await db
      .update(agentRuns)
      .set({ status: 'failed', errorMessage: message, completedAt: new Date(), updatedAt: new Date() })
      .where(eq(agentRuns.id, runId))
      .catch(() => {})
    // 编排失败虽被吞(仍返回兜底话),但要在 trace 里标成 ERROR + 记异常,
    // 否则 Phoenix 里失败对话与成功对话无法区分——这正是可观测要抓的场景。
    rootSpan.recordException(error as Error)
    rootSpan.setStatus({ code: SpanStatusCode.ERROR, message })
    rootSpan.setAttribute('pr.orchestration_failed', true)
    // 对话必须有回复:即便编排出错,也返回兜底话(带真实报错),让微信/前端能给用户一个响应。
    const answer = buildRuleBasedChatReply(message)
    rootSpan.setAttribute(OI.OUTPUT, clip(answer, 2000))
    return { threadId, runId, answer, model: 'rule-based-chat-v1', provider: 'local-rule', warnings: ['orchestration_failed'], learnedMemoryIds: [] }
  }
}

export async function listConversationMessages(threadId: string, limit = 30) {
  const db = await getActivitiesDb()
  const rows = await db
    .select()
    .from(conversationMessages)
    .where(eq(conversationMessages.threadId, threadId))
    .orderBy(desc(conversationMessages.createdAt))
    .limit(limit)

  return rows.map(row => {
    let imageUrl: string | null = null
    if (row.contextJson) {
      try {
        const ctx = JSON.parse(row.contextJson) as { imageUrl?: string }
        if (typeof ctx.imageUrl === 'string') imageUrl = ctx.imageUrl
      } catch {
        /* ignore */
      }
    }
    return {
      id: row.id,
      threadId: row.threadId,
      role: row.role,
      content: row.content,
      imageUrl,
      createdAt: row.createdAt.toISOString(),
    }
  })
}

/** 列出会话(用于 H5 会话列表);按最近活动排序。 */
export async function listConversationThreads(limit = 50) {
  const db = await getActivitiesDb()
  const rows = await db
    .select()
    .from(conversationThreads)
    .orderBy(desc(conversationThreads.lastMessageAt))
    .limit(limit)
  return rows.map(row => ({
    id: row.id,
    title: row.title ?? 'PR 对话',
    summary: row.summary ?? null,
    lastMessageAt: row.lastMessageAt ? row.lastMessageAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  }))
}

/** 删除一个会话及其消息(硬删,不依赖 FK 级联)。 */
export async function deleteConversationThread(id: string): Promise<boolean> {
  const db = await getActivitiesDb()
  const existing = await db.select({ id: conversationThreads.id }).from(conversationThreads).where(eq(conversationThreads.id, id)).limit(1)
  if (!existing[0]) return false
  await db.delete(conversationMessages).where(eq(conversationMessages.threadId, id))
  await db.delete(conversationThreads).where(eq(conversationThreads.id, id))
  return true
}
