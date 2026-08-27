/**
 * 主观反馈路由(挂 /api/pr/activity-feedback)。
 *
 * 移植自宿主 runPaceFlow-admin 的 src/app/api/activities/feedback/**。
 *
 * POST 是一条完整链路而不只是写一行:落反馈 → 从反馈里萃取记忆补丁 → 应用补丁 →
 * 重新生成该活动的复盘。这四步必须在同一个 owner 里,拆到两个仓各做一半正是此前
 * 「同一套逻辑两份实现」的来源。
 *
 * 路径没沿用宿主的 /activities/feedback:本仓 /api/activities 是摄入入口(import),
 * 语义不同,避免混在一起。
 */
import { Hono } from 'hono'

import { missingField } from '@/lib/api-helpers'
import { createSubjectiveFeedback, listSubjectiveFeedbackForActivity } from '@/lib/pr/feedback'
import { applyMemoryPatch, curateMemoryFromFeedback } from '@/lib/pr/memory'
import { generatePrReviewForActivity } from '@/lib/pr/review'
import { withAuth } from '@/middleware/auth'

const activityFeedback = new Hono()

activityFeedback.get('/', withAuth, async c => {
  const activityId = c.req.query('activityId')
  if (!activityId) return c.json({ error: 'activityId is required' }, 400)

  const limitParam = Number(c.req.query('limit') ?? 10)
  const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 50) : 10

  return c.json({ feedback: await listSubjectiveFeedbackForActivity(activityId, limit) })
})

activityFeedback.post('/', withAuth, async c => {
  let body: Record<string, unknown>
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  const miss = missingField(body, ['activityId'])
  if (miss) return c.json({ error: `${miss} is required` }, 400)

  const activityId = String(body.activityId)
  const rpe = typeof body.rpe === 'number' ? body.rpe : body.rpe ? Number(body.rpe) : null
  const pain = body.pain ?? null
  const note = typeof body.note === 'string' ? body.note : null

  const feedbackId = await createSubjectiveFeedback({
    activityId,
    mood: typeof body.mood === 'string' ? body.mood : null,
    rpe: Number.isFinite(rpe) ? rpe : null,
    pain,
    note,
    source: typeof body.source === 'string' ? body.source : 'dashboard',
  })

  const memoryPatches = await curateMemoryFromFeedback({ feedbackId, activityId, note, pain })
  const memoryIds: string[] = []
  for (const [index, patch] of memoryPatches.entries()) {
    memoryIds.push(
      // 幂等键带 feedbackId + 序号:同一条反馈重复提交不会把记忆写两遍。
      await applyMemoryPatch(patch, {
        actor: 'agent',
        idempotencyKey: `feedback:${feedbackId}:memory:${index}`,
      }),
    )
  }

  const review = await generatePrReviewForActivity(activityId, {
    force: true,
    enqueueNotification: body.enqueueNotification !== false,
    trigger: 'manual_review',
  })

  return c.json({ feedbackId, memoryIds, review })
})

export default activityFeedback
