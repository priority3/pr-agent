/**
 * 管理面统一的 fetch 封装。把请求结果收敛成三类可判别的失败:
 *   unauthorized(401,会话过期 → 回登录门)/ network(服务不可达)/ http(其余状态码)。
 *
 * Reason: 面板原先各自 `if (res.ok) … else setError('加载X失败 (HTTP 401)')`,
 * 于是会话一过期就四条红字并列、且没有回登录的入口(S12);网络断了又被 catch 成
 * 「未登录」显示登录框(S13)。判别式失败类型让这两种情况在调用方各归各位。
 */

export type ApiErrorKind = 'unauthorized' | 'network' | 'http'

export class ApiError extends Error {
  readonly kind: ApiErrorKind
  /** 网络层失败没有状态码,记 0。 */
  readonly status: number

  constructor(kind: ApiErrorKind, status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.kind = kind
    this.status = status
  }
}

/** 是否会话过期。面板据此跳过本地错误渲染——统一由会话层切回登录门。 */
export function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiError && error.kind === 'unauthorized'
}

/** 服务不可达(断网/后端没起/网关 502)。 */
export function isUnavailable(error: unknown): boolean {
  return error instanceof ApiError && (error.kind === 'network' || error.status >= 500)
}

/** 后端 4xx/5xx 多带 { error: '…' };读得到就用它,读不到退回状态码。 */
async function readErrorMessage(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { error?: unknown } | null
    if (data && typeof data.error === 'string' && data.error.trim()) return data.error
  } catch {
    /* 非 JSON 响应(网关 HTML 错误页等),退回状态码 */
  }
  return `HTTP ${res.status}`
}

/** 发请求;非 2xx 一律抛 ApiError,调用方只需处理成功路径。 */
export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  let res: Response
  try {
    res = await fetch(path, { cache: 'no-store', ...init })
  } catch (error) {
    // Reason: fetch 只在网络层失败时 reject(断网/连接被拒/DNS),即「服务不可达」,
    // 与 401 是完全不同的处置方向,不能一起 catch 成未登录。
    throw new ApiError('network', 0, error instanceof Error ? error.message : '网络错误')
  }
  if (res.status === 401) throw new ApiError('unauthorized', 401, '登录已过期')
  if (!res.ok) throw new ApiError('http', res.status, await readErrorMessage(res))
  return res
}

/** 发请求并解析 JSON。 */
export async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(path, init)
  try {
    return (await res.json()) as T
  } catch {
    throw new ApiError('http', res.status, '响应解析失败')
  }
}

/** 统一失败文案:动作 + 人话原因,不再把 'Failed to fetch' 甩给用户。 */
export function failureMessage(action: string, error: unknown): string {
  if (error instanceof ApiError) {
    if (error.kind === 'unauthorized') return '登录已过期，请重新登录'
    if (error.kind === 'network') return `${action}失败: 服务暂不可用`
    if (error.status >= 500) return `${action}失败: 服务异常 (${error.message})`
    return `${action}失败: ${error.message}`
  }
  return `${action}失败: ${error instanceof Error ? error.message : '未知错误'}`
}

/** JSON 请求体的常用 init。 */
export function jsonBody(method: 'POST' | 'PATCH' | 'PUT', body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}
