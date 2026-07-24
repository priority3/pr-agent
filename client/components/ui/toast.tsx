import { createContext, useCallback, useContext, useEffect, useState, type ComponentType, type ReactNode } from 'react'
import { CheckCircle2, Info, X, XCircle } from 'lucide-react'

import { cn } from '../../lib/utils'

// ─── Types ────────────────────────────────────────────────────────────────────

export type ToastVariant = 'success' | 'error' | 'info'

export interface ToastOptions {
  /** 提示标题/正文 */
  message: string
  /** 视觉变体，默认 info */
  variant?: ToastVariant
  /** 自动消失毫秒数，默认 4000；传 0 表示不自动消失 */
  duration?: number
}

interface ToastItem extends Required<Omit<ToastOptions, 'duration'>> {
  id: string
  duration: number
}

interface ToastContextValue {
  toast: (options: ToastOptions) => void
  success: (message: string, duration?: number) => void
  error: (message: string, duration?: number) => void
  info: (message: string, duration?: number) => void
}

// ─── Context ──────────────────────────────────────────────────────────────────

const ToastContext = createContext<ToastContextValue | null>(null)

/**
 * 读取全局 Toast 控制器。必须在 <ToastProvider> 内使用。
 */
export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext)
  if (!ctx) {
    throw new Error('useToast 必须在 <ToastProvider> 内部使用')
  }
  return ctx
}

// ─── Provider ─────────────────────────────────────────────────────────────────

// Reason: 用模块级自增计数器生成 id，避免 Math.random/Date.now 在并发渲染下重复
let toastSeq = 0

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])

  const dismiss = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id))
  }, [])

  const toast = useCallback((options: ToastOptions) => {
    const id = `toast-${++toastSeq}`
    const item: ToastItem = {
      id,
      message: options.message,
      variant: options.variant ?? 'info',
      duration: options.duration ?? 4000,
    }
    setToasts(prev => [...prev, item])
  }, [])

  const success = useCallback((message: string, duration?: number) => toast({ message, variant: 'success', duration }), [toast])
  const error = useCallback((message: string, duration?: number) => toast({ message, variant: 'error', duration }), [toast])
  const info = useCallback((message: string, duration?: number) => toast({ message, variant: 'info', duration }), [toast])

  return (
    <ToastContext.Provider value={{ toast, success, error, info }}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  )
}

// ─── Viewport & Item ──────────────────────────────────────────────────────────

function ToastViewport({ toasts, onDismiss }: { toasts: ToastItem[]; onDismiss: (id: string) => void }) {
  return (
    <div className="pointer-events-none fixed bottom-0 right-0 z-[100] flex w-full max-w-sm flex-col gap-2 p-4">
      {toasts.map(t => (
        <ToastCard key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>
  )
}

const VARIANT_STYLE: Record<ToastVariant, { container: string; icon: ComponentType<{ className?: string }> }> = {
  success: { container: 'border-emerald-200 bg-emerald-50 text-emerald-900', icon: CheckCircle2 },
  error: { container: 'border-red-200 bg-red-50 text-red-900', icon: XCircle },
  info: { container: 'border-blue-200 bg-blue-50 text-blue-900', icon: Info },
}

function ToastCard({ toast, onDismiss }: { toast: ToastItem; onDismiss: (id: string) => void }) {
  const [visible, setVisible] = useState(false)
  const style = VARIANT_STYLE[toast.variant]
  const Icon = style.icon

  // Reason: 入场后下一帧再切到 visible，触发滑入/淡入过渡
  useEffect(() => {
    const raf = requestAnimationFrame(() => setVisible(true))
    return () => cancelAnimationFrame(raf)
  }, [])

  // 自动消失（duration > 0 时）。onDismiss 是 Provider 里的稳定 useCallback，可安全作为依赖
  useEffect(() => {
    if (toast.duration <= 0) return
    const timer = setTimeout(() => onDismiss(toast.id), toast.duration)
    return () => clearTimeout(timer)
  }, [toast.id, toast.duration, onDismiss])

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'pointer-events-auto flex items-start gap-2 rounded-md border px-4 py-3 text-sm shadow-md transition-all duration-200 ease-out',
        style.container,
        visible ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0',
      )}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <span className="flex-1 break-words">{toast.message}</span>
      <button
        type="button"
        onClick={() => onDismiss(toast.id)}
        aria-label="关闭提示"
        className="-mr-1 -mt-0.5 shrink-0 rounded p-0.5 opacity-60 transition-opacity hover:opacity-100"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
