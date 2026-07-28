import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { LogOut, RefreshCw, ServerCrash } from 'lucide-react'

import { apiFetch, failureMessage, isUnauthorized, jsonBody } from '../lib/api'

import { ToastProvider, useToast } from '../components/ui/toast'
import { LoadingState } from '../components/shared'

import { PrPanel } from './panels/PrPanel'
import { SessionProvider } from './session'

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

/**
 * 探测结果三分:未登录(登录门)/ 已登录(面板)/ 服务不可用(重试卡)。
 * Reason: 原来 catch 一律 setAuthed(false),后端 502 或没起时也显示登录框,
 * 用户输对口令还是失败,诊断方向被带偏(S13)。
 */
type SessionState =
  | { kind: 'checking' }
  | { kind: 'anon' }
  | { kind: 'authed' }
  | { kind: 'offline'; message: string }

function DashboardInner() {
  const { error: toastError } = useToast()
  const [session, setSession] = useState<SessionState>({ kind: 'checking' })

  const probe = useCallback(async () => {
    setSession({ kind: 'checking' })
    try {
      // 任一 withAuth 端点即可作探针:带会话 cookie → 200,否则 401。
      await apiFetch('/api/pr/reviews?limit=1')
      setSession({ kind: 'authed' })
    } catch (error) {
      if (isUnauthorized(error)) {
        setSession({ kind: 'anon' })
        return
      }
      setSession({ kind: 'offline', message: failureMessage('连接服务', error) })
    }
  }, [])

  useEffect(() => {
    void Promise.resolve().then(probe)
  }, [probe])

  // 面板里任何请求撞上 401 都会走这里:提示一次 + 回登录门,不留四行红字。
  const handleExpired = useCallback(() => {
    toastError('登录已过期，请重新登录')
    setSession({ kind: 'anon' })
  }, [toastError])

  if (session.kind === 'checking') return <LoadingState />
  if (session.kind === 'offline') return <ServiceUnavailable message={session.message} onRetry={() => void probe()} />
  if (session.kind === 'anon') return <LoginGate onSuccess={() => setSession({ kind: 'authed' })} />
  return (
    <SessionProvider onExpired={handleExpired}>
      <PanelShell onLogout={() => setSession({ kind: 'anon' })} />
    </SessionProvider>
  )
}

function ServiceUnavailable({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex min-h-dvh items-center justify-center p-6">
      <div className="bg-card w-full max-w-sm space-y-4 rounded-lg border p-6 text-center shadow-sm">
        <ServerCrash className="text-muted-foreground mx-auto h-7 w-7" />
        <div>
          <h1 className="font-semibold">服务暂不可用</h1>
          <p className="text-muted-foreground mt-1 text-sm break-words">{message}</p>
          <p className="text-muted-foreground mt-1 text-xs">这不是登录问题——确认后端已启动后再重试。</p>
        </div>
        <button
          type="button"
          onClick={onRetry}
          className="bg-primary text-primary-foreground inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium"
        >
          <RefreshCw className="h-4 w-4" /> 重试
        </button>
      </div>
    </div>
  )
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
      await apiFetch('/api/auth/login', jsonBody('POST', { password }))
      onSuccess()
    } catch (error) {
      // 登录接口的 401 是「口令错误」,不是会话过期。
      toastError(isUnauthorized(error) ? '口令错误' : failureMessage('登录', error))
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
      await apiFetch('/api/auth/logout', { method: 'POST' })
      success('已登出')
      onLogout()
    } catch (error) {
      // 会话已经没了也算登出成功——回登录门,不给用户一个走不出去的报错。
      if (isUnauthorized(error)) onLogout()
      else toastError(failureMessage('登出', error))
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
