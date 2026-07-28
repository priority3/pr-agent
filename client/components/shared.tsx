import { useState, type ReactNode } from 'react'
import { RefreshCw, TriangleAlert } from 'lucide-react'

import { cn } from '../lib/utils'

// mini-admin 需要的共享片段(cherry-pick 自原仓 dashboard/components/shared.tsx):
// 首屏加载态 + 刷新按钮 + 加载失败态 + 可折叠分区。
// 其余分析类卡片(StatCard/ServiceCard/…)不属 PR 管理面,不搬。

export function LoadingState() {
  return (
    <div className="flex items-center justify-center py-20">
      <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
    </div>
  )
}

/**
 * 面板通用刷新按钮:忙时图标自转 + 禁用,替代「整块内容换成 spinner」(E1)。
 */
export function RefreshButton({ busy, onClick, label = '刷新' }: { busy?: boolean; onClick: () => void; label?: string }) {
  return (
    <button
      type="button"
      disabled={busy}
      onClick={onClick}
      className="inline-flex items-center gap-1 rounded bg-white/5 px-2 py-1 text-xs text-white/60 transition-colors hover:bg-white/10 disabled:opacity-50"
    >
      <RefreshCw className={cn('h-3 w-3', busy && 'animate-spin')} /> {label}
    </button>
  )
}

/**
 * 加载失败态:错误文案 + 重试按钮。有它时调用方不要再渲染空态(E2)——
 * 「加载失败」和「暂无数据」并排出现会让用户不知道该重试还是该去补数据。
 */
export function ErrorState({ message, onRetry, retrying }: { message: string; onRetry?: () => void; retrying?: boolean }) {
  return (
    <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3">
      <p className="flex items-start gap-2 text-sm text-rose-300">
        <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
        <span className="break-words">{message}</span>
      </p>
      {onRetry && (
        <button
          type="button"
          disabled={retrying}
          onClick={onRetry}
          className="mt-2 inline-flex items-center gap-1 rounded bg-white/10 px-2 py-1 text-xs text-white/80 transition-colors hover:bg-white/20 disabled:opacity-50"
        >
          <RefreshCw className={cn('h-3 w-3', retrying && 'animate-spin')} /> 重试
        </button>
      )}
    </div>
  )
}

export function CollapsibleSection({ title, defaultOpen = true, children }: { title: string; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="bg-card rounded-lg border shadow-sm overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between px-4 py-3 text-sm font-semibold hover:bg-muted/50 transition-colors"
      >
        {title}
        <svg className={cn('h-4 w-4 text-muted-foreground transition-transform', open && 'rotate-180')} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && <div className="border-t px-4 py-4">{children}</div>}
    </div>
  )
}
