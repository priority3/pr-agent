/**
 * 入口凭证:一次性链接(`?t=`)→ 设备令牌(localStorage)。
 *
 * 进页面的三种情形:
 * 1. 本地已有设备令牌 → 直接用(90 天滑动过期,天天用就不会掉);
 * 2. URL 带 `?t=` → 换一枚设备令牌,随后把 t 从地址栏抹掉;
 * 3. 两者都没有 → 空态,得去管理端另签一条链接。
 */
const STORAGE_KEY = 'pr_chat_token'

export type RedeemError = 'invalid' | 'expired' | 'used' | 'busy' | 'network'

export type RedeemOutcome = { ok: true; token: string } | { ok: false; reason: RedeemError }

// localStorage 在 Safari 无痕模式下可能直接抛错,一律降级成「没有令牌」。
export function readStoredToken(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

export function storeToken(token: string) {
  try {
    localStorage.setItem(STORAGE_KEY, token)
  } catch {
    // 存不下也不致命:本次会话内令牌还在内存里,下次进来重新走链接。
  }
}

export function clearStoredToken() {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* 同上 */
  }
}

/**
 * 同一枚 t 只发一次兑换请求。
 *
 * Reason: StrictMode 下 effect 会跑两遍,服务端虽有 10 分钟幂等窗口兜底,
 * 但没必要每次进页面都白打一次公开端点(它还带限流)。
 */
const inflight = new Map<string, Promise<RedeemOutcome>>()

export async function redeemInvite(t: string): Promise<RedeemOutcome> {
  const pending = inflight.get(t)
  if (pending) return pending

  const task = (async (): Promise<RedeemOutcome> => {
    try {
      const res = await fetch('/api/pr/access/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ t }),
      })

      if (res.status === 429) return { ok: false, reason: 'busy' }

      const body = (await res.json().catch(() => ({}))) as { token?: string; reason?: RedeemError }
      if (!res.ok || !body.token) return { ok: false, reason: body.reason ?? 'invalid' }

      return { ok: true, token: body.token }
    } catch {
      return { ok: false, reason: 'network' }
    } finally {
      inflight.delete(t)
    }
  })()

  inflight.set(t, task)
  return task
}

export const REDEEM_MESSAGES: Record<RedeemError, string> = {
  invalid: '这条链接无效,去管理端重新生成一条。',
  expired: '这条链接已经过期(签发后 7 天有效)。',
  used: '这条链接已经用过了 —— 一条链接只能进一次。',
  busy: '请求太频繁,过一会儿再打开。',
  network: '网络没连上,稍后重试。',
}
