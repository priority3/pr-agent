/**
 * 单用户会话签名(HMAC)。签发/校验算法与原仓 src/lib/auth.ts 逐字保真。
 *
 * Reason: 去 Next 后不再用 next/headers 的 cookies();读/写 cookie 交给 Hono 中间件与路由
 * (middleware/auth.ts + routes/auth.ts),本模块只保留纯逻辑(签名、校验、口令比对)。
 */
import { createHmac, randomBytes } from 'node:crypto'

import { safeEqual } from './crypto'

export const SESSION_COOKIE_NAME = 'runpaceflow_admin_session'
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7

function getSessionSecret() {
  const secret = process.env.ADMIN_SESSION_SECRET || process.env.SETTINGS_ENCRYPTION_KEY
  if (!secret) {
    throw new Error('ADMIN_SESSION_SECRET is required')
  }
  return secret
}

function sign(payload: string) {
  return createHmac('sha256', getSessionSecret()).update(payload).digest('base64url')
}

export function createSessionToken() {
  const payload = JSON.stringify({
    sub: 'admin',
    nonce: randomBytes(16).toString('base64url'),
    exp: Date.now() + SESSION_MAX_AGE_SECONDS * 1000,
  })
  const encodedPayload = Buffer.from(payload).toString('base64url')
  return `${encodedPayload}.${sign(encodedPayload)}`
}

export function verifySessionToken(token?: string) {
  if (!token) return false

  const [payload, signature] = token.split('.')
  if (!payload || !signature || !safeEqual(sign(payload), signature)) return false

  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      exp?: number
    }
    return typeof parsed.exp === 'number' && parsed.exp > Date.now()
  } catch {
    return false
  }
}

export function verifyPassword(password: string) {
  const expected = process.env.ADMIN_PASSWORD
  if (!expected) {
    throw new Error('ADMIN_PASSWORD is required')
  }
  return safeEqual(password, expected)
}
