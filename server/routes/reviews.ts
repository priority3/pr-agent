/**
 * 跑后复盘路由(挂 /api/pr/reviews)。
 *
 * 从 routes/pr.ts 迁出:那个文件已到 500 行约束边缘,而本轮又要给它加批量生成端点。
 * 复盘只负责「生成 + 入库」;外发推送能力(通知渠道/派发)已整体摘除,
 * 复盘结果只在管理端与对话上下文里消费。
 */
import { Hono } from 'hono'

import { missingField } from '@/lib/api-helpers'
import { recordPrFeedbackEvent } from '@/lib/pr/feedback-loop'
import {
  generatePrReviewForActivity,
  generatePrReviewsForActivities,
  listCurrentPrReviews,
} from '@/lib/pr/review'
import { withAuth } from '@/middleware/auth'

const reviews = new Hono()

reviews.get('/', withAuth, async c => {
  const limitParam = Number(c.req.query('limit') ?? 20)
  const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 50) : 20
  const kinds = c.req.query('kind')?.split(',').filter(Boolean)
  const list = kinds && kinds.length ? await listCurrentPrReviews(limit, kinds) : await listCurrentPrReviews(limit)

  return c.json({ reviews: list }, 200, { 'Cache-Control': 'no-store' })
})

reviews.post('/regenerate', withAuth, async c => {
  let body: Record<string, unknown>
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  const miss = missingField(body, ['activityId'])
  if (miss) return c.json({ error: `${miss} is required` }, 400)

  const activityId = String(body.activityId)
  const review = await generatePrReviewForActivity(activityId, {
    force: true,
    trigger: 'manual_review',
  })

  if (!review) {
    return c.json({ error: 'Activity not found' }, 404)
  }

  await recordPrFeedbackEvent({
    targetType: 'activity',
    targetId: activityId,
    eventType: 'regenerate',
    metadata: { reviewId: review.id },
  })

  return c.json({ review })
})

/**
 * 批量生成(同步流程用):一次同步拉回 N 条活动,逐条生成复盘。
 *
 * Reason: 宿主(runPaceFlow-admin)拥有数据摄入(Keep/Strava adapters、webhook),
 * 同步完拿到 activityIds 后需要触发复盘。此前它是直接 import 本仓的等价实现,
 * 现改为调本端点 —— 复盘逻辑只此一份。与 /regenerate 的区别:批量不 force,
 * 已有复盘的活动会被跳过(见 generatePrReviewsForActivities)。
 */
reviews.post('/generate-batch', withAuth, async c => {
  let body: Record<string, unknown>
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  const ids = Array.isArray(body.activityIds) ? body.activityIds.map(String).filter(Boolean) : []
  if (ids.length === 0) {
    return c.json({ error: 'activityIds is required' }, 400)
  }

  return c.json(await generatePrReviewsForActivities(ids))
})

export default reviews
