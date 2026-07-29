/**
 * Hono 认证中间件(移植自原仓 src/lib/api-helpers.ts 的 withAuth / withPrChatAuth /
 * withHealthImportAuth)。
 *
 * 差异:读会话从 next/headers cookies() 改为 Hono 请求 Cookie 头;token 源从 admin
 * app_settings 改为 env(getRuntimeSetting)。鉴权失败 → 401;处理器抛错 → 交由
 * app.onError 统一 500(与原仓每处理器 try/catch 的 500 行为等价)。
 */
import type { Context, MiddlewareHandler } from 'hono'
import { getCookie } from 'hono/cookie'

import { SESSION_COOKIE_NAME, verifySessionToken } from '@/lib/auth'
import { getRuntimeSetting } from '@/lib/config'
import { safeEqual } from '@/lib/crypto'

/** 从 Authorization 头提取 Bearer token;缺失/畸形返回 null。 */
function extractBearerToken(headerValue: string | null): string | null {
  const prefix = 'Bearer '
  if (!headerValue?.startsWith(prefix)) return null
  const token = headerValue.slice(prefix.length).trim()
  return token.length > 0 ? token : null
}

/** 当前请求是否持有效 admin 会话 cookie。 */
export function isAuthenticated(c: Context): boolean {
  return verifySessionToken(getCookie(c, SESSION_COOKIE_NAME))
}

/** admin 会话必需(管理端点;本仓无内置界面,由宿主界面或 curl 调用)。 */
export const withAuth: MiddlewareHandler = async (c, next) => {
  if (!isAuthenticated(c)) return c.json({ error: 'Unauthorized' }, 401)
  await next()
}

/**
 * admin 会话 或 Bearer <token> 二选一。上报设备(iOS 快捷指令)带不了会话 cookie,
 * 用共享 token 鉴权;管理端(宿主界面 / curl)走会话 cookie。token 读取失败不升级为 500
 * (降级到会话鉴权)。
 */
function tokenOrSessionAuth(settingKey: string, logTag: string): MiddlewareHandler {
  return async (c, next) => {
    let expectedToken = ''
    try {
      expectedToken = await getRuntimeSetting(settingKey)
    } catch (error) {
      console.warn(`[${logTag}] 读取 ${settingKey} 失败:`, (error as Error).message)
    }

    const providedToken = extractBearerToken(c.req.header('authorization') ?? null)
    const tokenOk =
      expectedToken.length > 0 && providedToken != null && safeEqual(providedToken, expectedToken)
    const sessionOk = tokenOk ? false : isAuthenticated(c)

    if (!tokenOk && !sessionOk) return c.json({ error: 'Unauthorized' }, 401)
    await next()
  }
}

/** H5 对话:admin 会话 或 Bearer PR_CHAT_TOKEN。 */
export const withPrChatAuth = tokenOrSessionAuth('PR_CHAT_TOKEN', 'pr-chat')

/** 健康数据上报:admin 会话 或 Bearer HEALTH_IMPORT_TOKEN。 */
export const withHealthImportAuth = tokenOrSessionAuth('HEALTH_IMPORT_TOKEN', 'health-import')
