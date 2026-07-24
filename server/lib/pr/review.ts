import Anthropic from '@anthropic-ai/sdk'
import { and, desc, eq, inArray } from 'drizzle-orm'
import OpenAI from 'openai'

import { getActivitiesDb } from '@/lib/db/client'
import {
  activities,
  activityReviews,
  agentRuns,
  agentStateSnapshots,
  notificationDeliveries,
  reviewAnnotations,
} from '@/lib/db/schema'
import { getRuntimeSettings } from '@/lib/config'
import { generateId } from '@/lib/utils'

import { buildPrContext, PR_CONTEXT_BUILDER_VERSION, type PrContext } from './context'
import { evaluateActivityReview } from './evaluator'
import { recordPrMetricEvent } from './feedback-loop'
import { applyMemoryPatch, buildMemoryPatchesFromHabitSignals } from './memory'
import {
  buildPrActivityReviewSystemPrompt,
  buildPrActivityReviewUserPrompt,
  buildRuleBasedPrReview,
  PR_REVIEW_PROMPT_VERSION,
} from './prompts'

export interface PrReviewSummary {
  id: string
  kind: string
  subjectId: string
  activityId: string | null
  content: string
  model: string
  provider: string | null
  inputHash: string
  createdAt: string
}

/** PR review 类型:活动复盘 / 每日晨间反思 / 周总结。 */
export const PR_REVIEW_KINDS = ['pr_activity_review', 'pr_recovery_review', 'pr_weekly_review'] as const

export interface GeneratePrReviewOptions {
  force?: boolean
  enqueueNotification?: boolean
  trigger?: 'activity_synced' | 'manual_review'
}

interface AiTextResult {
  content: string
  model: string
  provider: string
}

const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-4-20250514'
const DEFAULT_OPENAI_MODEL = 'gpt-4o'

function toIsoDate(value: Date | string | number) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function toReviewSummary(row: typeof activityReviews.$inferSelect): PrReviewSummary {
  return {
    id: row.id,
    kind: row.kind,
    subjectId: row.subjectId,
    activityId: row.activityId,
    content: row.content,
    model: row.model,
    provider: row.provider,
    inputHash: row.inputHash,
    createdAt: toIsoDate(row.createdAt),
  }
}

function serialize(value: unknown) {
  return JSON.stringify(value)
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

async function generateWithClaude(context: PrContext, settings: Record<string, string>): Promise<AiTextResult> {
  const apiKey = settings.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured')

  const model = settings.PR_REVIEW_MODEL || settings.ANTHROPIC_MODEL || DEFAULT_CLAUDE_MODEL
  const client = new Anthropic({
    apiKey,
    ...(settings.ANTHROPIC_BASE_URL && { baseURL: settings.ANTHROPIC_BASE_URL }),
    // Reason: 配置的第三方网关要求 1M 上下文 beta 头,否则 /v1/messages 报"请启用 1m 上下文",
    // 导致 AI 复盘静默回退规则模板。官方 SDK 默认不带,这里显式补上。
    defaultHeaders: { 'anthropic-beta': 'context-1m-2025-08-07' },
  })
  const response = await client.messages.create({
    model,
    max_tokens: 900,
    stream: false, // Reason: 部分网关不显式传就回 SSE,SDK 会把流当字符串返回
    system: buildPrActivityReviewSystemPrompt(),
    messages: [{ role: 'user', content: buildPrActivityReviewUserPrompt(context) }],
  })
  const text = response.content.find(block => block.type === 'text')
  if (!text || text.type !== 'text') throw new Error('No text content in Claude response')
  return { content: text.text, model, provider: 'claude' }
}

async function generateWithOpenAI(context: PrContext, settings: Record<string, string>): Promise<AiTextResult> {
  const apiKey = settings.OPENAI_API_KEY
  if (!apiKey) throw new Error('OPENAI_API_KEY not configured')

  const model = settings.PR_REVIEW_MODEL || settings.OPENAI_MODEL || DEFAULT_OPENAI_MODEL
  const client = new OpenAI({
    apiKey,
    ...(settings.OPENAI_BASE_URL && { baseURL: settings.OPENAI_BASE_URL }),
  })

  if (settings.OPENAI_API_FORMAT === 'responses') {
    const response = await client.responses.create({
      model,
      instructions: buildPrActivityReviewSystemPrompt(),
      input: [
        {
          role: 'user',
          content: [{ type: 'input_text', text: buildPrActivityReviewUserPrompt(context) }],
        },
      ],
      store: false,
    })
    const messageOutput = response.output.find(item => item.type === 'message')
    const text = messageOutput?.content.find(item => item.type === 'output_text')
    if (!text || text.type !== 'output_text') throw new Error('No text content in Responses API output')
    return { content: text.text, model: response.model || model, provider: 'openai-compatible' }
  }

  const response = await client.chat.completions.create({
    model,
    max_tokens: 900,
    stream: false, // Reason: 同上,防网关默认回 SSE
    messages: [
      { role: 'system', content: buildPrActivityReviewSystemPrompt() },
      { role: 'user', content: buildPrActivityReviewUserPrompt(context) },
    ],
  })
  const content = response.choices[0]?.message?.content
  if (!content) throw new Error('No content in Chat Completions response')
  return { content, model: response.model || model, provider: 'openai-compatible' }
}

async function generateReviewText(context: PrContext): Promise<AiTextResult> {
  const settings = await getRuntimeSettings({ force: true })
  const provider = settings.PR_REVIEW_PROVIDER
  const providers =
    provider === 'claude'
      ? [() => generateWithClaude(context, settings), () => generateWithOpenAI(context, settings)]
      : provider === 'openai'
        ? [() => generateWithOpenAI(context, settings), () => generateWithClaude(context, settings)]
        : [() => generateWithClaude(context, settings), () => generateWithOpenAI(context, settings)]

  let lastError: Error | null = null
  for (const runProvider of providers) {
    try {
      return await runProvider()
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
    }
  }

  console.warn('[PR] AI generation unavailable, using rule-based review:', lastError?.message)
  return {
    content: buildRuleBasedPrReview(context),
    model: 'rule-based-v1',
    provider: 'local-rule',
  }
}

export async function getCurrentPrReview(activityId: string): Promise<PrReviewSummary | null> {
  const db = await getActivitiesDb()
  const rows = await db
    .select()
    .from(activityReviews)
    .where(
      and(
        eq(activityReviews.kind, 'pr_activity_review'),
        eq(activityReviews.subjectType, 'activity'),
        eq(activityReviews.subjectId, activityId),
        eq(activityReviews.isCurrent, true),
      ),
    )
    .orderBy(desc(activityReviews.createdAt))
    .limit(1)

  return rows[0] ? toReviewSummary(rows[0]) : null
}

export async function listCurrentPrReviews(
  limit = 20,
  kinds: readonly string[] = PR_REVIEW_KINDS,
): Promise<PrReviewSummary[]> {
  const db = await getActivitiesDb()
  const rows = await db
    .select()
    .from(activityReviews)
    .where(and(inArray(activityReviews.kind, [...kinds]), eq(activityReviews.isCurrent, true)))
    .orderBy(desc(activityReviews.createdAt))
    .limit(limit)

  return rows.map(toReviewSummary)
}

export async function enqueueReviewNotification(reviewId: string): Promise<string | null> {
  const db = await getActivitiesDb()
  const rows = await db.select().from(activityReviews).where(eq(activityReviews.id, reviewId)).limit(1)
  const review = rows[0]
  if (!review) return null

  const notificationId = generateId('noti')
  await db
    .insert(notificationDeliveries)
    .values({
      id: notificationId,
      reviewId,
      channel: 'pushplus',
      recipient: 'default',
      title: 'PR 跑后复盘',
      content: review.content,
      payloadJson: serialize({ activityId: review.activityId, inputHash: review.inputHash }),
      status: 'pending',
    })
    .onConflictDoNothing()

  return notificationId
}

export async function generatePrReviewForActivity(
  activityId: string,
  options: GeneratePrReviewOptions = {},
): Promise<PrReviewSummary | null> {
  const db = await getActivitiesDb()
  const context = await buildPrContext(activityId)
  if (!context) return null

  const baseInputHash = context.stateSnapshot.inputHash
  const currentRows = await db
    .select()
    .from(activityReviews)
    .where(
      and(
        eq(activityReviews.kind, 'pr_activity_review'),
        eq(activityReviews.subjectType, 'activity'),
        eq(activityReviews.subjectId, activityId),
        eq(activityReviews.isCurrent, true),
      ),
    )
    .limit(1)

  if (
    currentRows[0] &&
    !options.force &&
    (currentRows[0].inputHash === baseInputHash ||
      currentRows[0].inputHash.startsWith(`${baseInputHash}:regenerated:`))
  ) {
    return toReviewSummary(currentRows[0])
  }

  const runId = generateId('run')
  const inputHash = options.force
    ? `${baseInputHash}:regenerated:${Date.now().toString(36)}`
    : baseInputHash
  const idempotencyKey = `${options.trigger ?? 'manual_review'}:activity:${activityId}:${inputHash}`
  await db
    .insert(agentRuns)
    .values({
      id: runId,
      idempotencyKey,
      trigger: options.trigger ?? 'manual_review',
      subjectType: 'activity',
      subjectId: activityId,
      status: 'running',
      inputHash: baseInputHash,
      builderVersion: PR_CONTEXT_BUILDER_VERSION,
      attempts: 1,
      lastStep: 'build_context',
      startedAt: new Date(),
    })
    .onConflictDoNothing()

  await writeSnapshot(runId, 'build_context', {
    context: {
      activity: context.activity.summary,
      recentTraining: context.recentTraining,
      moments: context.activity.moments,
      companionProfile: {
        activeGoals: context.companionProfile.activeGoals,
        trainingPreferences: context.companionProfile.trainingPreferences,
        doNotAssume: context.companionProfile.doNotAssume,
        projectionVersion: context.companionProfile.projectionVersion,
      },
      trainingHabitSignals: context.trainingHabitSignals.map(signal => ({
        type: signal.type,
        label: signal.label,
        confidence: signal.confidence,
      })),
      discardedContext: context.discardedContext,
    },
    inputHash,
  })

  try {
    let generated = await generateReviewText(context)
    const evaluation = evaluateActivityReview(generated.content, context)
    if (!evaluation.passed) {
      await writeSnapshot(runId, 'evaluate_response', {
        passed: false,
        warnings: evaluation.warnings,
        fallback: 'rule-based-v1',
      })
      generated = {
        content: buildRuleBasedPrReview(context),
        model: 'rule-based-v1',
        provider: 'local-rule',
      }
    } else {
      await writeSnapshot(runId, 'evaluate_response', { passed: true, warnings: [] })
    }
    await writeSnapshot(runId, 'draft_response', {
      provider: generated.provider,
      model: generated.model,
      contentLength: generated.content.length,
    })

    const memoryPatches = buildMemoryPatchesFromHabitSignals({
      runId,
      activityId,
      activityType: context.activity.summary.type,
      signals: context.trainingHabitSignals,
    })
    const memoryIds: string[] = []
    for (const [index, patch] of memoryPatches.entries()) {
      memoryIds.push(
        await applyMemoryPatch(patch, {
          actor: 'agent',
          idempotencyKey: `review:${runId}:habit-memory:${index}`,
          runId,
        }),
      )
    }
    await writeSnapshot(runId, 'update_memory', {
      candidatePatches: memoryPatches.length,
      memoryIds,
      signalTypes: context.trainingHabitSignals.map(signal => signal.type),
    })

    const reviewId = generateId('review')
    if (currentRows.length > 0) {
      for (const row of currentRows) {
        await db
          .update(activityReviews)
          .set({ isCurrent: false, supersededBy: reviewId, updatedAt: new Date() })
          .where(eq(activityReviews.id, row.id))
      }
    }

    await db.insert(activityReviews).values({
      id: reviewId,
      runId,
      subjectType: 'activity',
      subjectId: activityId,
      activityId,
      kind: 'pr_activity_review',
      status: 'generated',
      featuresJson: serialize(context.activity),
      contextJson: serialize(context),
      content: generated.content,
      model: generated.model,
      provider: generated.provider,
      inputHash,
      builderVersion: PR_CONTEXT_BUILDER_VERSION,
      promptVersion: PR_REVIEW_PROMPT_VERSION,
      isCurrent: true,
    })

    const annotationRows = context.activity.moments.map(moment => ({
      id: generateId('anno'),
      reviewId,
      activityId,
      type: moment.type,
      kilometer: moment.kilometer ?? null,
      label: moment.label,
      content: moment.content,
    }))
    if (annotationRows.length > 0) {
      await db.insert(reviewAnnotations).values(annotationRows)
    }

    if (options.enqueueNotification !== false) {
      await db
        .insert(notificationDeliveries)
        .values({
          id: generateId('noti'),
          reviewId,
          channel: 'pushplus',
          recipient: 'default',
          title: `PR 跑后复盘：${context.activity.summary.title}`,
          content: generated.content,
          payloadJson: serialize({ activityId, inputHash }),
          status: 'pending',
        })
        .onConflictDoNothing()
    }

    await recordPrMetricEvent({
      runId,
      metricName: 'pr_review_quality_warnings',
      metricValue: evaluation.warnings.length,
      dimensions: {
        provider: generated.provider,
        model: generated.model,
        fallbackUsed: !evaluation.passed,
        warningTypes: evaluation.warnings,
        habitSignalCount: context.trainingHabitSignals.length,
        memoryPatchCount: memoryPatches.length,
      },
    })

    await db
      .update(agentRuns)
      .set({
        status: 'succeeded',
        model: generated.model,
        lastStep: 'enqueue_notification',
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(agentRuns.id, runId))

    await writeSnapshot(runId, 'persist_output', { reviewId, annotationCount: annotationRows.length })

    const reviewRows = await db.select().from(activityReviews).where(eq(activityReviews.id, reviewId)).limit(1)
    return reviewRows[0] ? toReviewSummary(reviewRows[0]) : null
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    await db
      .update(agentRuns)
      .set({
        status: 'failed',
        errorCode: 'review_generation_failed',
        errorMessage,
        lastStep: 'draft_response',
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(agentRuns.id, runId))
    await writeSnapshot(runId, 'failed', { errorMessage })
    throw error
  }
}

// 只有近 24h 完成的活动才推送微信;首次/批量同步的历史活动只生成复盘、不推送,
// 避免一次拉入几十条历史跑步时把用户微信刷屏。
const NOTIFY_RECENT_WINDOW_MS = 24 * 60 * 60 * 1000

export async function generatePrReviewsForActivities(
  activityIds: string[],
): Promise<{ generated: number; skipped: number; failed: number; notified: number }> {
  const db = await getActivitiesDb()
  let generated = 0
  let skipped = 0
  let failed = 0
  let notified = 0

  for (const activityId of Array.from(new Set(activityIds))) {
    try {
      // Reason: 按活动完成时间决定是否推送——历史回填静默(只入库复盘),新鲜跑步才推。
      const [act] = await db
        .select({ startTime: activities.startTime })
        .from(activities)
        .where(eq(activities.id, activityId))
        .limit(1)
      const isRecent = act?.startTime
        ? Date.now() - act.startTime.getTime() <= NOTIFY_RECENT_WINDOW_MS
        : false
      if (isRecent) notified++

      const before = await getCurrentPrReview(activityId)
      const review = await generatePrReviewForActivity(activityId, {
        trigger: 'activity_synced',
        enqueueNotification: isRecent,
      })
      if (!review) {
        skipped++
      } else if (!before || before.id !== review.id) {
        generated++
      } else {
        skipped++
      }
    } catch (error) {
      failed++
      console.warn(`[PR] Failed to generate review for ${activityId}:`, (error as Error).message)
    }
  }

  return { generated, skipped, failed, notified }
}
