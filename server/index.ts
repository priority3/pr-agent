import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'

// P0 骨架:健康探针 + 静态托管(client Vite 构建产物)。
// 后续阶段挂载:P3 → /api/pr、/api/health、/pr(H5);P4 → /api/activities/import。
const app = new Hono()

app.get('/api/health', c =>
  c.json({ status: 'ok', service: 'pr-agent', ts: Date.now() }),
)

// 静态资源(client/dist)。SPA 回退:未命中的路径交给 index.html。
app.use('/*', serveStatic({ root: './client/dist' }))
app.get('/*', serveStatic({ path: './client/dist/index.html' }))

const port = Number(process.env.PORT ?? 3030)
console.log(`[server] pr-agent listening on :${port}`)

export default { port, fetch: app.fetch }
