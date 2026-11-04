/**
 * 只读数据接口的请求封装(H5 用设备令牌,不是 admin 会话)。
 *
 * 和对话那条通路(sse.ts)分开:这里全是普通 JSON 请求,没有流。
 * 401 统一走 clearStoredToken —— 令牌过期后继续拿它请求只会一路 401,
 * 抹掉之后用户重新用一次性链接进来即可(与 PrChat 里的 onAuthError 一致)。
 */
import { clearStoredToken, readStoredToken } from './session'

/** 令牌缺失/失效:调用方展示「访问已失效」,而不是「加载失败,请重试」 */
export class AuthError extends Error {
  constructor() {
    super('unauthorized')
    this.name = 'AuthError'
  }
}

export class ApiError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

async function request<T>(path: string): Promise<T> {
  const token = readStoredToken()
  if (!token) throw new AuthError()

  let r: Response
  try {
    r = await fetch(path, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' })
  } catch {
    throw new ApiError(0, '网络不通')
  }

  if (r.status === 401) {
    clearStoredToken()
    throw new AuthError()
  }
  if (!r.ok) {
    const text = await r.text().catch(() => '')
    throw new ApiError(r.status, text.slice(0, 200) || `HTTP ${r.status}`)
  }
  return (await r.json()) as T
}

export const fetchRecords = () => request<{ week: import('./types').WeekSummary; activities: import('./types').RecordItem[] }>('/api/pr/data/records')
export const fetchRecord = (id: string) => request<import('./types').ActivityDetail>(`/api/pr/data/records/${encodeURIComponent(id)}`)
export const fetchAccount = () => request<import('./types').AccountInfo>('/api/pr/data/account')

/** 清空全部对话(危险区)。返回删掉的会话数。 */
export async function clearThreads(): Promise<number> {
  const token = readStoredToken()
  if (!token) throw new AuthError()
  const r = await fetch('/api/pr/data/threads', { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
  if (r.status === 401) {
    clearStoredToken()
    throw new AuthError()
  }
  if (!r.ok) throw new ApiError(r.status, `HTTP ${r.status}`)
  const j = (await r.json()) as { deleted?: number }
  return j.deleted ?? 0
}

/**
 * 导出 CSV。必须走 fetch 而不是 <a href>:接口要带 Authorization 头。
 * 拿到 blob 后用临时 a 标签触发下载,再 revoke。
 */
export async function downloadCsv() {
  const token = readStoredToken()
  if (!token) throw new AuthError()
  const r = await fetch('/api/pr/data/records/export.csv', { headers: { Authorization: `Bearer ${token}` } })
  if (r.status === 401) {
    clearStoredToken()
    throw new AuthError()
  }
  if (!r.ok) throw new ApiError(r.status, `HTTP ${r.status}`)

  const blob = await r.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `pr-records-${new Date().toISOString().slice(0, 10)}.csv`
  document.body.appendChild(a)
  a.click()
  a.remove()
  // 立刻 revoke 在部分浏览器会打断下载,延后一拍
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
