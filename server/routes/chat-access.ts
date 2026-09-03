/**
 * H5 对话的访问令牌管理(挂在 /api/pr/access 下)。
 *
 * - `POST /session` 是**唯一的公开端点**:H5 页面拿一次性 t 换设备令牌。
 * - 其余是管理端点(withAuth):签发链接、看签发/设备清单、吊销设备。
 *
 * 独立成文件而不是塞进 routes/pr.ts,一是那个文件已近 500 行上限,
 * 二是这批端点的鉴权语义(公开 + 管理)与对话端点(设备令牌)本就不同。
 */
import { Hono, type Context } from 'hono'

import {
  createChatInvite,
  listChatDevices,
  listChatInvites,
  redeemChatInvite,
  revokeChatDevice,
} from '@/lib/pr/chat-access'
import { withAuth } from '@/middleware/auth'

const access = new Hono()

// ── 兑换(公开)────────────────────────────────────────────────────────────

const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX = 10
const attemptsByIp = new Map<string, number[]>()

function clientIp(c: Context): string {
  const forwarded = c.req.header('x-forwarded-for')
  if (forwarded) return forwarded.split(',')[0].trim()
  return c.req.header('x-real-ip') || 'unknown'
}

/**
 * 兑换端点的滑动窗口限流。
 *
 * Reason: 32 字节随机量本身已让爆破不现实,这里防的是有人拿这个公开端点刷日志/打库。
 * 内存态即可 —— 单进程自部署,重启后重新计数没有实际影响。
 */
function rateLimited(ip: string): boolean {
  const now = Date.now()

  // 顺手清掉已过期的 IP 条目,避免 Map 无界增长。
  if (attemptsByIp.size > 500) {
    for (const [key, hits] of attemptsByIp) {
      if (hits.every(t => now - t >= RATE_LIMIT_WINDOW_MS)) attemptsByIp.delete(key)
    }
  }

  const hits = (attemptsByIp.get(ip) ?? []).filter(t => now - t < RATE_LIMIT_WINDOW_MS)
  hits.push(now)
  attemptsByIp.set(ip, hits)
  return hits.length > RATE_LIMIT_MAX
}

/** 设备标签:User-Agent 摘要,只为在设备列表里认出是哪台机器,不参与鉴权。 */
function deviceLabel(c: Context): string | null {
  const ua = c.req.header('user-agent')?.trim()
  return ua ? ua.slice(0, 200) : null
}

access.post('/session', async c => {
  if (rateLimited(clientIp(c))) return c.json({ error: '请求过于频繁,稍后再试' }, 429)

  let body: { t?: unknown }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  const token = typeof body.t === 'string' ? body.t.trim() : ''
  if (!token) return c.json({ error: 't is required' }, 400)

  const result = await redeemChatInvite(token, deviceLabel(c))
  if (!result.ok) {
    // reason 透出给前端区分文案:链接失效 / 已过期 / 已被用过。
    return c.json({ error: 'Unauthorized', reason: result.reason }, 401)
  }

  return c.json({ token: result.grant.token, expiresAt: result.grant.expiresAt.toISOString() })
})

// ── 管理(admin 会话 或 PR_ADMIN_TOKEN)──────────────────────────────────

access.post('/links', withAuth, async c => {
  let note: string | null = null
  try {
    const body = (await c.req.json()) as { note?: unknown }
    if (typeof body?.note === 'string') note = body.note
  } catch {
    // 无 body 也合法:签一枚不带备注的链接。
  }

  const invite = await createChatInvite(note)
  return c.json({ url: invite.url, token: invite.token, expiresAt: invite.expiresAt.toISOString() })
})

access.get('/links', withAuth, async c => {
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 50) || 50, 1), 200)
  return c.json({ links: await listChatInvites(limit) })
})

access.get('/devices', withAuth, async c => {
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 50) || 50, 1), 200)
  return c.json({ devices: await listChatDevices(limit) })
})

access.delete('/devices/:id', withAuth, async c => {
  const ok = await revokeChatDevice(c.req.param('id'))
  if (!ok) return c.json({ error: 'Not found' }, 404)
  return c.json({ success: true })
})

export default access
