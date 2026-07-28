/**
 * 会话上下文:把「任何 401 → 回登录门」这条规则收在一处(S12)。
 *
 * 面板不再自己 fetch,而是用 useApi();读写一旦撞上 401,expire() 让 Dashboard
 * 切回登录门并提示一次「登录已过期」,而不是四个面板各渲染一行红字、用户只能靠猜。
 */
import { createContext, useCallback, useContext, useMemo, useRef, type ReactNode } from 'react'

import { ApiError, apiFetch, apiJson } from '../lib/api'

export interface SessionApi {
  /** 发请求,非 2xx 抛 ApiError。 */
  request: (path: string, init?: RequestInit) => Promise<Response>
  /** 发请求并解析 JSON,非 2xx 抛 ApiError。 */
  json: <T>(path: string, init?: RequestInit) => Promise<T>
}

const SessionContext = createContext<SessionApi | null>(null)

export function SessionProvider({ onExpired, children }: { onExpired: () => void; children: ReactNode }) {
  // Reason: 四个面板可能同时撞 401,ref 去重保证只切一次登录门、只弹一次提示。
  // Provider 只在已登录分支挂载,重新登录时是新实例,标记自然复位。
  const expiredRef = useRef(false)

  const intercept = useCallback(
    (error: unknown): never => {
      if (error instanceof ApiError && error.kind === 'unauthorized' && !expiredRef.current) {
        expiredRef.current = true
        onExpired()
      }
      // 继续抛出:调用方只负责收尾本地态(停 loading),不必再判 401。
      throw error
    },
    [onExpired],
  )

  const value = useMemo<SessionApi>(
    () => ({
      request: (path, init) => apiFetch(path, init).catch(intercept),
      json: <T,>(path: string, init?: RequestInit) => apiJson<T>(path, init).catch(intercept),
    }),
    [intercept],
  )

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export function useApi(): SessionApi {
  const ctx = useContext(SessionContext)
  if (!ctx) throw new Error('useApi 必须在 <SessionProvider> 内部使用')
  return ctx
}
