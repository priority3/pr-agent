import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'

import { ensureDatabaseReady } from '@/bootstrap'
import { startScheduler } from '@/lib/scheduler'
import activitiesRoutes from '@/routes/activities'
import authRoutes from '@/routes/auth'
import healthRoutes from '@/routes/health'
import prRoutes from '@/routes/pr'

// P3a:HTTP 层由 Next route handler 迁至 Hono。挂载 /api/auth、/api/pr、/api/health,
// 未命中的路径交给 client(Vite 构建产物)静态托管。
// P4a:启动序列 = 建表(消除首访 no such table)→ 显式启动调度器 → serve。
const app = new Hono()

// 处理器抛错统一 500 JSON(等价于原仓每处理器 try/catch 的 500 分支);
// 鉴权失败在中间件内直接 401,不会到这里。
app.onError((err, c) => c.json({ error: err instanceof Error ? err.message : 'Internal error' }, 500))

app.route('/api/auth', authRoutes)
app.route('/api/pr', prRoutes)
app.route('/api/health', healthRoutes)
app.route('/api/activities', activitiesRoutes)

// 静态资源(Vite 单入口构建产物)。唯一前端入口 = H5 对话页,/ 与 /pr 都服务它。
// 管理端点(withAuth 那批)保留但无内置界面,由宿主(如 runPaceFlow-admin 的「PR 伙伴」面板)提供。
// API 路由已在前,未命中才落到这里;assets(/assets/*、/pr-logo.png 等)由通配 serveStatic 提供。
app.get('/', serveStatic({ path: './client/dist/pr/index.html' }))
app.get('/pr', serveStatic({ path: './client/dist/pr/index.html' }))
app.use('/*', serveStatic({ root: './client/dist' }))

// 启动序列:先建表(消除首个带会话请求的 "no such table"),再显式启动调度器,最后 serve。
// scheduler 显式启动替代源仓"首个 GET /api/health 懒引导"。调度失败不阻断 HTTP 服务。
await ensureDatabaseReady()
await startScheduler().catch(err =>
  console.warn('[server] startScheduler failed:', err instanceof Error ? err.message : err),
)

const port = Number(process.env.PORT ?? 3030)
console.log(`[server] pr-agent listening on :${port}`)

export default { port, fetch: app.fetch }
