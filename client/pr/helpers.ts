/** PR H5 对话页小工具(无 React 依赖)。 */

/**
 * 本地消息 id。crypto.randomUUID 只在安全上下文(https/localhost)可用,
 * 局域网明文 http 打开时回退到时间戳 + 随机串(单端末单会话内足够唯一)。
 */
export function newId(): string {
  const c = globalThis.crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  return `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

/** 会话列表的相对时间:刚刚 / N 分钟前 / 今天 HH:mm / M-D */
export function relTime(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  const diff = Date.now() - d.getTime()
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (new Date().toDateString() === d.toDateString()) {
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
  }
  return `${d.getMonth() + 1}-${d.getDate()}`
}

/**
 * 复制文本。navigator.clipboard 需要安全上下文,不可用时回退隐藏 textarea + execCommand
 * (自部署常见明文 http 局域网访问,不做回退等于按钮失灵)。
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* 非安全上下文 / 权限拒绝 → 走 execCommand 兜底 */
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.top = '0'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}
