import { useEffect, useState } from 'react'

// P0 占位页:验证 Vite→Hono serveStatic 链路 + /api/health 可达。
// P3 迁入 PR 对话 H5(client/pr)与 mini-admin dashboard(client/dashboard)。
export function App() {
  const [health, setHealth] = useState<string>('…')
  useEffect(() => {
    fetch('/api/health')
      .then(r => r.json())
      .then(d => setHealth(d.status ?? 'unknown'))
      .catch(() => setHealth('unreachable'))
  }, [])
  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', padding: 24, maxWidth: 640 }}>
      <h1>PR Agent</h1>
      <p>P0 脚手架 — Hono (Bun) + Vite React。</p>
      <p>
        后端健康探针:<strong>{health}</strong>
      </p>
      <p style={{ color: '#888' }}>PR 对话 H5 与 dashboard 将在 P3 迁入。</p>
    </div>
  )
}
