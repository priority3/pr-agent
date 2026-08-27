/**
 * 生活事件路由(挂 /api/pr/life-events)。
 *
 * 移植自宿主 runPaceFlow-admin 的 src/app/api/life-events:HTTP 入口补在本仓
 * (逻辑 owner 在这里),宿主改为转发过来。
 */
import { Hono } from 'hono'

import { missingField } from '@/lib/api-helpers'
import { createLifeEvent, listLifeEvents, type LifeEventType } from '@/lib/pr/life-events'
import { withAuth } from '@/middleware/auth'

const lifeEvents = new Hono()

lifeEvents.get('/', withAuth, async c => {
  const limitParam = Number(c.req.query('limit') ?? 20)
  const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 50) : 20

  return c.json({ events: await listLifeEvents(limit) })
})

lifeEvents.post('/', withAuth, async c => {
  let body: Record<string, unknown>
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  const miss = missingField(body, ['type'])
  if (miss) return c.json({ error: `${miss} is required` }, 400)

  const eventId = await createLifeEvent({
    type: String(body.type) as LifeEventType,
    occurredAt: typeof body.occurredAt === 'string' ? body.occurredAt : undefined,
    mediaUrl: typeof body.mediaUrl === 'string' ? body.mediaUrl : null,
    rawText: typeof body.rawText === 'string' ? body.rawText : null,
  })

  return c.json({ eventId })
})

export default lifeEvents
