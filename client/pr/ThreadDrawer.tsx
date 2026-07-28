import { useEffect, useRef, useState } from 'react'

import { relTime } from './helpers'
import { PlusIcon, TrashIcon } from './icons'
import type { Thread } from './types'

interface Props {
  open: boolean
  threads: Thread[]
  activeId: string | null
  onClose: () => void
  onSwitch: (id: string) => void
  onNewChat: () => void
  onDelete: (id: string) => void
}

/** 会话抽屉:常驻渲染,spring 滑入滑出 + 背景淡入;关闭态用 inert 退出 tab 序列。 */
export default function ThreadDrawer({ open, threads, activeId, onClose, onSwitch, onNewChat, onDelete }: Props) {
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const deleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current)
  }, [])

  // 抽屉关掉时撤销待确认状态,免得下次打开还举着「确认删除」
  useEffect(() => {
    if (open) return
    if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current)
    setConfirmDeleteId(null)
  }, [open])

  /* 两段式删除:第一下把垃圾桶变成「确认删除」,3 秒不点自动还原(替代生硬的 window.confirm) */
  function armDelete(id: string) {
    if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current)
    setConfirmDeleteId(id)
    deleteTimerRef.current = setTimeout(() => setConfirmDeleteId(null), 3000)
  }

  function confirmDelete(id: string) {
    if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current)
    setConfirmDeleteId(null)
    onDelete(id)
  }

  return (
    <div className={`fixed inset-0 z-40 ${open ? '' : 'pointer-events-none'}`} inert={!open} onClick={onClose}>
      <div className="pr-backdrop absolute inset-0" style={{ opacity: open ? 1 : 0 }} />
      <div
        className="pr-drawer absolute left-0 top-0 flex h-full w-72 flex-col"
        style={{ background: 'var(--pr-bg)', transform: open ? 'translateX(0)' : 'translateX(-105%)' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="p-3" style={{ borderBottom: '1px solid var(--pr-line)', paddingTop: 'calc(var(--pr-safe-top) + 12px)' }}>
          <button type="button" onClick={onNewChat} className="pr-tap flex w-full items-center justify-center gap-1.5 rounded-xl px-3 py-2.5 text-sm font-medium" style={{ background: 'var(--pr-user-bg)', color: 'var(--pr-user-text)' }}>
            <PlusIcon size={18} />新对话
          </button>
        </div>
        <div className="pr-scroll flex-1 overflow-y-auto p-2">
          {threads.length === 0 && <p className="p-3 text-xs" style={{ color: 'var(--pr-muted)' }}>还没有会话</p>}
          {threads.map((t, i) => {
            const active = t.id === activeId
            const arming = confirmDeleteId === t.id
            return (
              <div
                key={t.id}
                className="pr-row flex items-center gap-2 rounded-xl px-3 py-2.5"
                style={{ background: active ? 'var(--pr-sel)' : 'transparent', animationDelay: open ? `${Math.min(i * 30, 240)}ms` : '0ms' }}
              >
                {active && <span className="pr-dot-solid shrink-0" style={{ background: 'var(--pr-accent)' }} />}
                <button type="button" onClick={() => onSwitch(t.id)} className="min-w-0 flex-1 text-left">
                  <div className="flex items-baseline gap-2">
                    <div className="min-w-0 flex-1 truncate text-sm" style={{ color: 'var(--pr-text)' }}>{t.title}</div>
                    <div className="shrink-0 text-[10px]" style={{ color: 'var(--pr-muted)' }}>{relTime(t.lastMessageAt)}</div>
                  </div>
                  {t.summary && <div className="mt-0.5 truncate text-[11px]" style={{ color: 'var(--pr-muted)' }}>{t.summary}</div>}
                </button>
                {arming ? (
                  <button type="button" onClick={() => confirmDelete(t.id)} className="pr-tap pr-pop shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium" style={{ background: 'var(--pr-accent)', color: 'var(--pr-accent-ink)' }}>
                    确认删除
                  </button>
                ) : (
                  <button type="button" onClick={() => armDelete(t.id)} className="pr-tap shrink-0 p-1" style={{ color: 'var(--pr-muted)' }} aria-label="删除会话">
                    <TrashIcon />
                  </button>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
