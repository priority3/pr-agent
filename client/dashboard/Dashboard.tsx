import { useEffect, useState, type FormEvent } from 'react'
import { LogOut } from 'lucide-react'

import { ToastProvider, useToast } from '../components/ui/toast'
import { LoadingState } from '../components/shared'

import { PrPanel } from './panels/PrPanel'

/**
 * mini-admin:单用户 PR 管理面(登录门 + PrPanel)。不含原仓 DashboardView 的分析/
 * 监控/设置等 tab —— 那些属 admin,不随 PR agent 抽离。ToastProvider 包裹整棵树。
 * 会话 cookie 为 httpOnly,前端读不到,故挂载时探一次受保护端点判断登录态。
 */
export function Dashboard() {
  return (
    <ToastProvider>
      <DashboardInner />
    </ToastProvider>
  )
}

function DashboardInner() {
  // null = 探测中;false = 未登录(显示登录门);true = 已登录(显示面板)
  const [authed, setAuthed] = useState<boolean | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        // 任一 withAuth 端点即可作探针:带会话 cookie → 200,否则 401。
        const res = await fetch('/api/pr/reviews?limit=1', { cache: 'no-store' })
        setAuthed(res.ok)
      } catch {
        setAuthed(false)
      }
    })()
  }, [])

  if (authed === null) return <LoadingState />
  if (!authed) return <LoginGate onSuccess={() => setAuthed(true)} />
  return <PanelShell onLogout={() => setAuthed(false)} />
}

function LoginGate({ onSuccess }: { onSuccess: () => void }) {
  const { error: toastError } = useToast()
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!password || busy) return
    setBusy(true)
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      if (res.ok) {
        onSuccess()
      } else if (res.status === 401) {
        toastError('口令错误')
      } else {
        toastError(`登录失败 (HTTP ${res.status})`)
      }
    } catch (err) {
      toastError(`登录失败: ${err instanceof Error ? err.message : '网络错误'}`)
    }
    setBusy(false)
  }

  return (
    <div className="flex min-h-dvh items-center justify-center p-6">
      <form onSubmit={submit} className="bg-card w-full max-w-sm space-y-4 rounded-lg border p-6 shadow-sm">
        <div>
          <h1 className="text-lg font-semibold">PR Agent 管理面</h1>
          <p className="text-muted-foreground mt-1 text-sm">输入管理口令登录</p>
        </div>
        <input
          type="password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          placeholder="管理口令"
          autoFocus
          className="border-input w-full rounded-md border bg-transparent px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
        <button
          type="submit"
          disabled={busy || !password}
          className="bg-primary text-primary-foreground w-full rounded-md px-3 py-2 text-sm font-medium disabled:opacity-50"
        >
          {busy ? '登录中…' : '登录'}
        </button>
      </form>
    </div>
  )
}

function PanelShell({ onLogout }: { onLogout: () => void }) {
  const { success, error: toastError } = useToast()
  const [busy, setBusy] = useState(false)

  async function logout() {
    setBusy(true)
    try {
      const res = await fetch('/api/auth/logout', { method: 'POST' })
      if (res.ok) {
        success('已登出')
        onLogout()
      } else {
        toastError(`登出失败 (HTTP ${res.status})`)
      }
    } catch (err) {
      toastError(`登出失败: ${err instanceof Error ? err.message : '网络错误'}`)
    }
    setBusy(false)
  }

  return (
    <div className="mx-auto min-h-dvh max-w-3xl px-4 py-6">
      <header className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">PR Agent 管理面</h1>
          <p className="text-muted-foreground text-sm">记忆 · 反思 · 恢复 · 常跑地点</p>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={logout}
          className="text-muted-foreground hover:bg-muted flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors disabled:opacity-50"
        >
          <LogOut className="h-4 w-4" /> 登出
        </button>
      </header>
      <PrPanel />
    </div>
  )
}
