import { useState } from 'react'

import type { CheckItem } from './tasklist'

/**
 * 可勾选的建议条目。
 *
 * 勾选状态存 localStorage,key 用**条目文本的哈希**而不是消息 id:消息 id 在
 * 「本地临时 id → 服务端 id」、以及历史重拉时会变,挂 id 上的勾会凭空消失;
 * 挂文本上则同一条建议(哪怕换了会话)依然记得勾过。
 */
const STORE_KEY = 'pr_checks'

function hash(text: string): string {
  let h = 5381
  for (let i = 0; i < text.length; i += 1) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0
  return h.toString(36)
}

function loadDone(): Record<string, true> {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, true>) : {}
  } catch {
    return {}
  }
}

function saveDone(next: Record<string, true>) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(next))
  } catch {
    // 隐私模式下写入会抛:勾选状态丢失不影响阅读,静默降级
  }
}

export default function Checklist({ items }: { items: CheckItem[] }) {
  const [done, setDone] = useState<Record<string, true>>(loadDone)
  const keys = items.map(it => hash(it.text))
  const checked = keys.filter(k => done[k]).length

  function toggle(key: string) {
    setDone(prev => {
      const next = { ...prev }
      if (next[key]) delete next[key]
      else next[key] = true
      saveDone(next)
      return next
    })
  }

  return (
    <div className="mt-3.5" style={{ borderTop: '1px solid var(--pr-line)' }}>
      {items.map((item, i) => {
        const key = keys[i]
        const on = Boolean(done[key]) || item.done
        return (
          <button
            type="button"
            key={key}
            onClick={() => toggle(key)}
            aria-pressed={on}
            className="pr-check flex w-full items-start gap-2.5 text-left"
            style={{ borderBottom: i < items.length - 1 ? '1px solid var(--pr-line)' : undefined }}
          >
            <span className="pr-tick" data-on={on ? '1' : '0'} aria-hidden="true">
              <svg width="9" height="9" viewBox="0 0 12 12" fill="none" stroke="var(--pr-accent-ink)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2.5 6.2 4.8 8.5 9.5 3.8" />
              </svg>
            </span>
            <span className="flex-1 break-words text-[13.5px] leading-[1.6]" style={{ color: on ? 'var(--pr-muted)' : 'var(--pr-text)' }}>
              {item.text}
            </span>
          </button>
        )
      })}
      <div className="mt-2 text-[11px]" style={{ color: 'var(--pr-muted)' }}>
        {items.length} 条建议 · {checked ? `已勾 ${checked} 条` : '点一下算做过'}
      </div>
    </div>
  )
}
