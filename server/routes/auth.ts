/**
 * 管理登录/登出。POST /api/auth/login(口令换会话 cookie)、POST /api/auth/logout(清 cookie)。
 * 移植自原仓 src/app/api/auth/{login,logout}/route.ts —— 口令用 ADMIN_PASSWORD 校验,
 * 会话 cookie 签发/清除逻辑逐字保真,cookie 读写改用 Hono。
 */
import { Hono, type Context } from 'hono'
import { deleteCookie, setCookie } from 'hono/cookie'

import { createSessionToken, SESSION_COOKIE_NAME, SESSION_MAX_AGE_SECONDS, verifyPassword } from '@/lib/auth'

const auth = new Hono()

/**
 * 这次请求对浏览器而言是否走 HTTPS —— 决定会话 cookie 要不要打 Secure。
 *
 * Reason: 原先用 `NODE_ENV === 'production'` 判断,而发布的 compose 就设了
 * NODE_ENV=production。自部署者用 http://<内网IP>:3040 访问时,Secure cookie 会被
 * 浏览器直接丢弃 → 登录返回 200 但随后所有接口 401,前端 401 拦截又把它变成
 * 「登录已过期」的死循环,等于明文 HTTP 下根本无法登录。
 * 改为看实际协议:反代(cloudflared/nginx)到源站是明文但对外是 HTTPS,靠
 * X-Forwarded-Proto 识别;直连明文则不打 Secure,登录可用;直连 HTTPS 仍打。
 */
function isSecureRequest(c: Context): boolean {
  const forwarded = c.req.header('x-forwarded-proto')
  if (forwarded) return forwarded.split(',')[0].trim().toLowerCase() === 'https'
  try {
    return new URL(c.req.url).protocol === 'https:'
  } catch {
    return false
  }
}

auth.post('/login', async c => {
  let body: { password?: unknown }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid request' }, 400)
  }

  const password = typeof body?.password === 'string' ? body.password : ''
  if (!password) return c.json({ error: 'Invalid request' }, 400)

  if (!verifyPassword(password)) return c.json({ error: 'Invalid password' }, 401)

  setCookie(c, SESSION_COOKIE_NAME, createSessionToken(), {
    httpOnly: true,
    sameSite: 'Lax',
    secure: isSecureRequest(c),
    maxAge: SESSION_MAX_AGE_SECONDS,
    path: '/',
  })
  return c.json({ success: true })
})

auth.post('/logout', c => {
  deleteCookie(c, SESSION_COOKIE_NAME, { path: '/' })
  return c.json({ success: true })
})

export default auth
