import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'

import authRoutes from '@/routes/auth'
import healthRoutes from '@/routes/health'
import prRoutes from '@/routes/pr'

// P3a:HTTP 层由 Next route handler 迁至 Hono。挂载 /api/auth、/api/pr、/api/health,
// 未命中的路径交给 client(Vite 构建产物)静态托管。
// 后续阶段:P4 → /api/activities/import + scheduler 引导 + 真实通知派发。
const app = new Hono()

// 处理器抛错统一 500 JSON(等价于原仓每处理器 try/catch 的 500 分支);
// 鉴权失败在中间件内直接 401,不会到这里。
app.onError((err, c) => c.json({ error: err instanceof Error ? err.message : 'Internal error' }, 500))

app.route('/api/auth', authRoutes)
app.route('/api/pr', prRoutes)
app.route('/api/health', healthRoutes)

// 静态资源(client/dist)。SPA 回退:未命中的路径交给 index.html。
app.use('/*', serveStatic({ root: './client/dist' }))
app.get('/*', serveStatic({ path: './client/dist/index.html' }))

const port = Number(process.env.PORT ?? 3030)
console.log(`[server] pr-agent listening on :${port}`)

export default { port, fetch: app.fetch }
