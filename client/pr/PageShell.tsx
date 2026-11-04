import type { ReactNode } from 'react'

import { ChevronLeftIcon } from './icons'
import { PrThemeStyle } from './theme'

interface Props {
  title: ReactNode
  /** 标题下的第二行(详情页用来放日期,列表页放说明) */
  subtitle?: string
  onBack?: () => void
  /** 顶栏右侧按钮 */
  right?: ReactNode
  /** 顶部固定区(汇总数字之类),跟着内容一起滚就放在 children 里 */
  children: ReactNode
}

/**
 * 记录 / 详情 / 设置三页共用的外壳。
 *
 * 和对话页刻意保持同一套帧:56px 毛玻璃顶栏、18px 左右内边距、底部按安全区留白。
 * 结构差异只在内容区——这是「笔触缝」的要求:换页时外壳不该跳。
 */
export default function PageShell({ title, subtitle, onBack, right, children }: Props) {
  return (
    <div
      className="pr fixed inset-x-0 top-0 flex flex-col overflow-hidden"
      style={{
        height: 'var(--pr-vh, 100dvh)',
        transform: 'translateY(var(--pr-vv-top, 0px))',
        background: 'var(--pr-bg)',
        color: 'var(--pr-text)',
      }}
    >
      <PrThemeStyle />

      <header
        className="pr-glass z-20 flex shrink-0 items-center gap-2 px-3.5"
        style={{
          height: 'calc(56px + var(--pr-safe-top))',
          paddingTop: 'var(--pr-safe-top)',
          borderBottom: '1px solid var(--pr-line)',
        }}
      >
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            className="pr-tap -ml-1 rounded-lg p-1.5"
            style={{ color: 'var(--pr-text-2)' }}
            aria-label="返回"
          >
            <ChevronLeftIcon />
          </button>
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-medium">{title}</div>
          {subtitle && (
            <div className="pr-meta truncate text-[11px]" style={{ color: 'var(--pr-muted)' }}>
              {subtitle}
            </div>
          )}
        </div>
        {right}
      </header>

      <div
        className="pr-scroll flex-1 overflow-y-auto px-[18px]"
        style={{
          paddingTop: 16,
          paddingBottom: 'calc(28px + var(--pr-safe-bottom))',
          overscrollBehavior: 'contain',
        }}
      >
        {children}
      </div>
    </div>
  )
}

/** 加载态:三行与列表行同形的骨架,不用转圈(转圈说不出「在等什么」) */
export function PageSkeleton() {
  return (
    <div className="pt-1">
      <div className="pr-skel mb-6 h-8 w-32 rounded" />
      {[0, 1, 2, 3].map(i => (
        <div key={i} className="flex items-start gap-3 py-3" style={{ borderBottom: '1px solid var(--pr-line)' }}>
          <div className="pr-skel h-[26px] w-[26px] shrink-0 rounded-[8px]" />
          <div className="flex-1">
            <div className="pr-skel mb-2 h-3.5 w-2/5 rounded" />
            <div className="pr-skel h-3 w-3/5 rounded" />
          </div>
        </div>
      ))}
    </div>
  )
}

/** 错误态:说清楚是「访问失效」还是「没拉到」,并给一个动作 */
export function PageError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-start gap-3 py-16">
      <div className="text-[14px]" style={{ color: 'var(--pr-text)' }}>
        {message}
      </div>
      {onRetry && (
        <button type="button" onClick={onRetry} className="pr-btn">
          重试
        </button>
      )}
    </div>
  )
}

/** 空态:一句话说清现在是什么状态 + 一个动作,不给插画 */
export function PageEmpty({ title, hint, action }: { title: string; hint: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-2.5 py-16">
      <div className="text-[14px]" style={{ color: 'var(--pr-text)' }}>
        {title}
      </div>
      <div className="text-[13px] leading-[1.7]" style={{ color: 'var(--pr-text-2)' }}>
        {hint}
      </div>
      {action}
    </div>
  )
}
