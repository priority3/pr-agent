import { useState, type ReactNode } from 'react'
import { RefreshCw } from 'lucide-react'

import { cn } from '../lib/utils'

// mini-admin 需要的共享片段(cherry-pick 自原仓 dashboard/components/shared.tsx):
// 折叠面板加载态 + 可折叠分区。其余分析类卡片(StatCard/ServiceCard/…)不属 PR 管理面,不搬。

export function LoadingState() {
  return (
    <div className="flex items-center justify-center py-20">
      <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
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
