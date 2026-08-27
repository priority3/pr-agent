/**
 * PR agent 路由(全部挂在 /api/pr 下)。移植自原仓 src/app/api/pr/**、以及
 * src/app/api/activities/reviews/**(重命名迁入为 /api/pr/reviews*)。
 *
 * 换外壳不改逻辑:NextResponse.json → c.json;request.json → c.req.json;
 * URL.searchParams → c.req.query;动态段 [id]/[runId] → c.req.param;
 * SSE 用 Web 标准 ReadableStream + 原生 Response(非 Next 专有)直接返回。
 */
import { Hono } from 'hono'

import { getRuntimeSetting } from '@/lib/config'
import { safeEqual } from '@/lib/crypto'
import { missingField } from '@/lib/api-helpers'
import { chatWithPr, deleteConversationThread, listConversationMessages, listConversationThreads } from '@/lib/pr/chat'
import { recordPrFeedbackEvent, type PrFeedbackEventType } from '@/lib/pr/feedback-loop'
import { getExplicitHomeLocation, upsertExplicitHomeLocation } from '@/lib/pr/home-location'
import { archiveMemory, confirmMemory, getFriendProfile, listMemories, type MemoryItemType, projectFriendProfile, updateMemory } from '@/lib/pr/memory'
import { getPrFlywheel, getPrMetrics } from '@/lib/pr/metrics'
import { getHomeLocation, invalidateHomeLocationCache } from '@/lib/pr/providers/environment'
import { ingestKnowledgeDocument } from '@/lib/pr/rag'
import { getAgentRunDetail, getContextSnapshotForRun, listAgentRuns } from '@/lib/pr/state'
import { readImageUpload, saveImageUpload, SUPPORTED_IMAGE_TYPES } from '@/lib/pr/uploads'
import { generateWeeklyReview, listFriendDiaryEntries } from '@/lib/pr/weekly'
import { withAuth, withPrChatAuth } from '@/middleware/auth'

const pr = new Hono()

// ── 对话(H5)──────────────────────────────────────────────────────────

// SSE 响应头:no-transform + X-Accel-Buffering 防反向代理/网关缓冲(已验证能穿反向代理增量到达)。
const SSE_HEADERS = {
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'Content-Type': 'text/event-stream; charset=utf-8',
  'X-Accel-Buffering': 'no',
}

pr.get('/chat', withPrChatAuth, async c => {
  const threadId = c.req.query('threadId')
  if (!threadId) return c.json({ error: 'threadId is required' }, 400)
  const messages = await listConversationMessages(threadId)
  return c.json({ messages })
})

pr.post('/chat', withPrChatAuth, async c => {
  let body: Record<string, unknown>
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  // message 或 imageUrl 至少有一个(允许只发图片)。
  const message = typeof body.message === 'string' ? body.message : ''
  const imageUrl = typeof body.imageUrl === 'string' ? body.imageUrl : null
  if (!message.trim() && !imageUrl) {
    return c.json({ error: 'message or imageUrl required' }, 400)
  }
  const threadId = typeof body.threadId === 'string' ? body.threadId : null

  // 非流式路径:原有行为,一次性 JSON(旧客户端/微信回调等继续可用)。
  if (body.stream !== true) {
    const result = await chatWithPr({ message, threadId, imageUrl })
    return c.json(result)
  }

  // 流式路径:SSE 转发 thinking/text/tool 增量,最后 done 带完整结果(与非流式同形)。
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false
      const send = (event: string, data: unknown) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
        } catch {
          closed = true // 客户端断开后 enqueue 会抛,置位后停止转发(服务端继续算完并落库)
        }
      }
      // 思考间隙可能超过反向代理默认空闲超时(常见 ~100s),15s 心跳保活
      const keepAlive = setInterval(() => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(': ka\n\n'))
        } catch {
          closed = true
        }
      }, 15_000)
      c.req.raw.signal.addEventListener('abort', () => (closed = true), { once: true })

      let streamedText = ''
      try {
        const result = await chatWithPr({
          message,
          threadId,
          imageUrl,
          onStream: evt => {
            if (evt.type === 'thinking') send('thinking', { delta: evt.delta })
            else if (evt.type === 'text') {
              streamedText += evt.delta
              send('text', { delta: evt.delta })
            } else if (evt.type === 'tool') send('tool', { name: evt.name })
            else if (evt.type === 'text_reset') {
              streamedText = ''
              send('text_reset', {})
            }
          },
        })
        // 评审改写/规则兜底/空响应等场景:最终答案与流出的不一致时整段替换
        if (result.answer !== streamedText) send('replace', { answer: result.answer })
        send('done', result)
      } catch (error) {
        send('error', { message: (error as Error).message })
      } finally {
        clearInterval(keepAlive)
        closed = true
        try {
          controller.close()
        } catch {
          /* 已关闭 */
        }
      }
    },
  })

  return new Response(stream, { headers: SSE_HEADERS })
})

// ── 会话列表 ────────────────────────────────────────────────────────────
pr.get('/threads', withPrChatAuth, async c => {
  const threads = await listConversationThreads(50)
  return c.json({ threads })
})

pr.delete('/threads', withPrChatAuth, async c => {
  const id = c.req.query('id')
  if (!id) return c.json({ error: 'id is required' }, 400)
  const ok = await deleteConversationThread(id)
  if (!ok) return c.json({ error: 'Thread not found' }, 404)
  return c.json({ deleted: id })
})

// ── 图片上传 / 读取 ─────────────────────────────────────────────────────
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024

pr.post('/upload', withPrChatAuth, async c => {
  let form: Record<string, string | File>
  try {
    form = await c.req.parseBody()
  } catch {
    return c.json({ error: '需要 multipart/form-data' }, 400)
  }
  const file = form.file
  if (!(file instanceof File)) {
    return c.json({ error: '缺少 file 字段' }, 400)
  }
  if (!SUPPORTED_IMAGE_TYPES.includes(file.type)) {
    return c.json(
      { error: `不支持的图片类型: ${file.type || '未知'}(支持 jpg/png/gif/webp)` },
      400,
    )
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return c.json({ error: '图片太大(上限 10MB)' }, 400)
  }
  const bytes = Buffer.from(await file.arrayBuffer())
  const { url } = await saveImageUpload(bytes, file.type)
  return c.json({ url })
})

// 认证走查询串 token(浏览器 <img> 无法带 Authorization 头),与 PR_CHAT_TOKEN 比对。
pr.get('/image/:name', async c => {
  const name = c.req.param('name')
  const t = c.req.query('t') ?? ''

  let expected = ''
  try {
    expected = await getRuntimeSetting('PR_CHAT_TOKEN')
  } catch {
    /* token 读取失败即视为未授权 */
  }
  if (!expected || !safeEqual(t, expected)) {
    return c.text('Unauthorized', 401)
  }

  const img = await readImageUpload(name)
  if (!img) return c.text('Not found', 404)

  return new Response(new Uint8Array(img.bytes), {
    status: 200,
    headers: { 'Content-Type': img.mediaType, 'Cache-Control': 'private, max-age=86400' },
  })
})

// ── agent runs / 上下文 ────────────────────────────────────────────────
pr.get('/agent-runs', withAuth, async c => {
  const limitParam = Number(c.req.query('limit') ?? 30)
  const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 100) : 30
  return c.json({ runs: await listAgentRuns(limit) })
})

pr.get('/agent-runs/:id', withAuth, async c => {
  const id = c.req.param('id')
  if (!id) return c.json({ error: 'id is required' }, 400)
  const detail = await getAgentRunDetail(id)
  if (!detail) return c.json({ error: 'Agent run not found' }, 404)
  return c.json(detail)
})

pr.get('/context/:runId', withAuth, async c => {
  const runId = c.req.param('runId')
  if (!runId) return c.json({ error: 'runId is required' }, 400)
  const snapshot = await getContextSnapshotForRun(runId)
  if (!snapshot) return c.json({ error: 'Context snapshot not found' }, 404)
  return c.json(snapshot)
})

// ── 日记 / 反馈 / 飞轮 / 指标 ───────────────────────────────────────────
pr.get('/diary', withAuth, async c => {
  const limitParam = Number(c.req.query('limit') ?? 20)
  const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 50) : 20
  const entries = await listFriendDiaryEntries(limit)
  return c.json({ entries })
})

pr.post('/feedback', withAuth, async c => {
  let body: Record<string, unknown>
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  const miss = missingField(body, ['targetType', 'targetId', 'eventType'])
  if (miss) return c.json({ error: `${miss} is required` }, 400)

  const result = await recordPrFeedbackEvent({
    targetType: String(body.targetType),
    targetId: String(body.targetId),
    eventType: String(body.eventType) as PrFeedbackEventType,
    value: typeof body.value === 'string' ? body.value : null,
    note: typeof body.note === 'string' ? body.note : null,
    metadata:
      body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
        ? (body.metadata as Record<string, unknown>)
        : null,
  })

  return c.json(result)
})

pr.get('/flywheel', withAuth, async c => {
  const daysParam = Number(c.req.query('days') ?? 30)
  const days = Number.isFinite(daysParam) ? Math.min(Math.max(daysParam, 1), 365) : 30
  const flywheel = await getPrFlywheel(days)
  return c.json({ flywheel })
})

pr.get('/metrics', withAuth, async c => {
  const daysParam = Number(c.req.query('days') ?? 30)
  const days = Number.isFinite(daysParam) ? Math.min(Math.max(daysParam, 1), 365) : 30
  const metrics = await getPrMetrics(days)
  return c.json({ metrics })
})

// ── 知识库摄入 ──────────────────────────────────────────────────────────
pr.post('/knowledge', withAuth, async c => {
  let body: Record<string, unknown>
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  const miss = missingField(body, ['title', 'content'])
  if (miss) return c.json({ error: `${miss} is required` }, 400)

  const result = await ingestKnowledgeDocument({
    title: String(body.title),
    content: String(body.content),
    source: typeof body.source === 'string' ? body.source : null,
    metadata:
      body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
        ? (body.metadata as Record<string, unknown>)
        : null,
  })

  return c.json(result)
})

// ── 记忆 ────────────────────────────────────────────────────────────────
pr.get('/memories', withAuth, async c => {
  const statuses = c.req.query('status')?.split(',').filter(Boolean) ?? ['candidate', 'active']
  const memories = await listMemories(statuses, 100)
  return c.json({ memories })
})

pr.patch('/memories/:id', withAuth, async c => {
  const id = c.req.param('id')
  if (!id) return c.json({ error: 'id is required' }, 400)

  let body: Record<string, unknown>
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  const memoryId = await updateMemory(
    id,
    {
      type: typeof body.type === 'string' ? (body.type as MemoryItemType) : undefined,
      content: typeof body.content === 'string' ? body.content : undefined,
      confidence: typeof body.confidence === 'number' ? body.confidence : undefined,
      status:
        body.status === 'candidate' ||
        body.status === 'active' ||
        body.status === 'decayed' ||
        body.status === 'archived'
          ? body.status
          : undefined,
      reason: typeof body.reason === 'string' ? body.reason : '用户更新记忆。',
    },
    { actor: 'user', idempotencyKey: `update:${id}:${Date.now()}` },
  )

  if (!memoryId) return c.json({ error: 'Memory not found' }, 404)
  return c.json({ memoryId })
})

pr.post('/memories/:id/confirm', withAuth, async c => {
  const id = c.req.param('id')
  if (!id) return c.json({ error: 'id is required' }, 400)

  const memoryId = await confirmMemory(id)
  if (!memoryId) return c.json({ error: 'Memory not found' }, 404)

  await recordPrFeedbackEvent({ targetType: 'memory', targetId: memoryId, eventType: 'memory_confirm' })
  return c.json({ memoryId })
})

pr.post('/memories/:id/archive', withAuth, async c => {
  const id = c.req.param('id')
  if (!id) return c.json({ error: 'id is required' }, 400)

  const memoryId = await archiveMemory(id)
  if (!memoryId) return c.json({ error: 'Memory not found' }, 404)

  await recordPrFeedbackEvent({ targetType: 'memory', targetId: memoryId, eventType: 'memory_archive' })
  return c.json({ memoryId })
})

// ── 画像 / 常跑地点 ─────────────────────────────────────────────────────
pr.get('/profile', withAuth, async c => {
  let profile = await getFriendProfile()
  if (!profile) {
    await projectFriendProfile()
    profile = await getFriendProfile()
  }
  return c.json({ profile })
})

/**
 * 读当前地点状态,GET/PUT/DELETE 共用响应形状。
 * Reason: 面板看的是当下真相而非 TTL 缓存旧地点——取 effective 前先失效缓存;写路径复用同一入口,
 * 失效发生在 upsert 之后,天然满足"写后失效"。
 */
async function readLocationState() {
  invalidateHomeLocationCache()
  const [explicit, effective] = await Promise.all([getExplicitHomeLocation(), getHomeLocation()])
  return {
    explicit,
    effective,
    source: explicit ? ('explicit' as const) : effective ? ('derived' as const) : ('none' as const),
  }
}

/**
 * 宽松取坐标:接受 number 或非空数字字符串,其余一律 NaN。
 * Reason: Number('') 与 Number(null) 都是 0——空字段静默落成 (0,0) 海上坐标,必须挡掉。
 */
function toCoord(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value === 'string' && value.trim() !== '') return Number(value)
  return Number.NaN
}

pr.get('/profile/home-location', withAuth, async c => c.json(await readLocationState()))

pr.put('/profile/home-location', withAuth, async c => {
  let body: Record<string, unknown>
  try {
    body = (await c.req.json()) as Record<string, unknown>
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  const lat = toCoord(body.lat)
  const lng = toCoord(body.lng)
  if (!Number.isFinite(lat) || Math.abs(lat) > 90) {
    return c.json({ error: '纬度需为 -90 ~ 90 的数字' }, 400)
  }
  if (!Number.isFinite(lng) || Math.abs(lng) > 180) {
    return c.json({ error: '经度需为 -180 ~ 180 的数字' }, 400)
  }
  const label = typeof body.label === 'string' ? body.label.trim() : ''
  if (label.length > 30) {
    return c.json({ error: '地点名称最多 30 字' }, 400)
  }

  await upsertExplicitHomeLocation({ lat, lng, ...(label ? { label } : {}) })
  return c.json(await readLocationState())
})

pr.delete('/profile/home-location', withAuth, async c => {
  await upsertExplicitHomeLocation(null)
  return c.json(await readLocationState())
})

// ── 周报 ────────────────────────────────────────────────────────────────
pr.post('/weekly-review', withAuth, async c => {
  let body: Record<string, unknown> = {}
  try {
    body = await c.req.json()
  } catch {
    // 允许空 body
  }

  const result = await generateWeeklyReview({
    force: body.force === true,
    enqueueNotification: body.enqueueNotification !== false,
  })

  return c.json(result)
})

// ── 复盘(reviews:自 /api/activities/reviews* 迁入并重命名)─────────────
export default pr
