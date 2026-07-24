/**
 * 管理登录/登出。POST /api/auth/login(口令换会话 cookie)、POST /api/auth/logout(清 cookie)。
 * 移植自原仓 src/app/api/auth/{login,logout}/route.ts —— 口令用 ADMIN_PASSWORD 校验,
 * 会话 cookie 签发/清除逻辑逐字保真,cookie 读写改用 Hono。
 */
import { Hono } from 'hono'
import { deleteCookie, setCookie } from 'hono/cookie'

import { createSessionToken, SESSION_COOKIE_NAME, SESSION_MAX_AGE_SECONDS, verifyPassword } from '@/lib/auth'

const auth = new Hono()

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
    secure: process.env.NODE_ENV === 'production',
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
