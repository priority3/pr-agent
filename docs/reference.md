# 接口与配置参考

## 页面

| 路径 | 说明 |
|---|---|
| `/pr`(及 `/`) | H5 对话(手机优先)。`?t=<PR_CHAT_TOKEN>` 免登录进入,token 存 localStorage |

唯一的内置页面就是对话页(`/` 与 `/pr` 返回同一份 HTML)。管理界面不内置,见下「API」。
未命中的路径落到静态托管:命中 `client/dist` 里的文件就返回该文件(`/assets/*`、`/pr-logo.png`),
否则 404(无 SPA 兜底)。

## API

下表中标「会话」的是**管理端点:有接口、无内置界面**。用 `POST /api/auth/login` 拿会话 cookie
后即可调用(curl / 你自己的界面 / 宿主应用的面板均可);共库部署时宿主也可以直接读同一个库。

| 方法 & 路径 | 鉴权 | 说明 |
|---|---|---|
| `POST /api/auth/login` · `/logout` | 口令 | 管理接口登录(`ADMIN_PASSWORD`)/ 登出 |
| `GET·POST /api/pr/chat` | `PR_CHAT_TOKEN` | 拉历史 / 发消息(`stream:true` 走 SSE) |
| `GET·DELETE /api/pr/threads` | `PR_CHAT_TOKEN` | 会话列表 / 删除 |
| `POST /api/pr/upload` | `PR_CHAT_TOKEN` | 图片上传(≤10MB) |
| `GET /api/pr/image/:name` | 查询串 `?t=` | 取图(`<img>` 不能带 header,故走查询串) |
| `GET /api/pr/memories` · `PATCH /:id` · `POST /:id/confirm` · `/:id/archive` | 会话 | 长期记忆的查看 / 编辑 / 确认 / 归档 |
| `GET /api/pr/profile` · `GET·PUT·DELETE /api/pr/profile/home-location` | 会话 | 伙伴画像 / 常跑地点 |
| `GET /api/pr/reviews` · `POST /reviews/notify` · `/reviews/regenerate` | 会话 | 复盘列表 / 重发 / 重新生成 |
| `POST /api/pr/weekly-review` | 会话 | 手动触发周总结 |
| `GET /api/pr/diary` | 会话 | 老友日记 |
| `GET /api/pr/agent-runs` · `/agent-runs/:id` · `/context/:runId` | 会话 | 运行记录与上下文快照(排查用) |
| `GET /api/pr/metrics` · `/flywheel` | 会话 | 指标 / 飞轮 |
| `POST /api/pr/knowledge` | 会话 | 知识库文档导入(RAG) |
| `POST /api/pr/feedback` | 会话 | 反馈事件 |
| `GET /api/health` | 公开 | 存活探针 |
| `GET·POST /api/health/daily` | 会话 或 `HEALTH_IMPORT_TOKEN` | 健康指标查询 / 上报 |
| `POST /api/activities/import` | 会话 或 `HEALTH_IMPORT_TOKEN` | 通用活动导入 |

摄入两条的字段详见 [ingest.md](./ingest.md)。

## 配置项

完整键集与逐条注释在 [`.env.example`](../.env.example)。分组一览:

| 分组 | 键 |
|---|---|
| 数据库 | `DATABASE_URL`(默认 `file:./data/pr.db`)、`DATABASE_AUTH_TOKEN`(远程 libsql 才需) |
| 管理端 | `ADMIN_PASSWORD`、`ADMIN_SESSION_SECRET`(管理 API 鉴权,无内置界面)、`SETTINGS_ENCRYPTION_KEY` |
| AI 网关 | `ANTHROPIC_API_KEY` / `_BASE_URL` / `_MODEL` / `_VISION_MODEL`;`OPENAI_API_KEY` / `_BASE_URL` / `_MODEL` / `_API_FORMAT` |
| 对话 | `PR_CHAT_TOKEN`、`PR_CHAT_MAX_TOKENS`、`PR_UPLOAD_DIR` |
| 记忆 | `PR_MEMORY_DECAY_DAYS`、`PR_MEMORY_RECONCILE_APPLY` |
| 复盘 | `PR_REVIEW_MODEL`、`PR_REVIEW_PROVIDER`、`PR_RETENTION_DAYS` |
| RAG 向量 | `PR_EMBEDDING_API_KEY` / `_BASE_URL` / `_MODEL`(留空 = 纯 BM25) |
| 摄入 & 数据源 | `HEALTH_IMPORT_TOKEN`、`SYNC_SOURCE`、`KEEP_MOBILE` / `_PASSWORD`、`STRAVA_CLIENT_ID` / `_SECRET` / `_REFRESH_TOKEN` |
| 富化 | `ENRICH_WEATHER`、`ENRICH_RACE_MATCH`(默认关) |
| 通知 | `PUSHPLUS_TOKEN`、`PUBLIC_BASE_URL`(推送链接前缀) |
| 可观测 | `PHOENIX_COLLECTOR_ENDPOINT` / `_PROJECT_NAME` / `_API_KEY`(需自行注册 OTel provider) |
| 调度 | `PR_SCHEDULER`(`off` = 一个 job 都不注册)、`CRON_<JOB>`,如 `CRON_PR_DAILY_REVIEW="0 12 * * *"` |

## 定时任务

启动时注册,全部可用 `CRON_<JOB_ID>` 覆盖;`PR_SCHEDULER=off` 则一个都不注册
(与宿主共用一个库部署时必须设,否则同一份数据被两边各复盘一遍、通知推两次):

| Job | 默认 cron | 做什么 |
|---|---|---|
| `pr_daily_review` | `0 12 * * *` | 晨间反思兜底(正常由健康数据上报即时触发) |
| `weekly_review` | `0 20 * * 0` | 周总结 |
| `friend_diary` | `31 21 * * 0` | 老友日记 |
| `memory_maintenance` | `33 3 * * *` | 记忆衰减 / 新鲜度维护 |
| `notification_dispatch` | `*/10 * * * *` | 派发待发通知 |
| `retention_cleanup` | `0 3 * * 0` | 清理过期的运行快照 |
| `sync` | `0 * * * *` | 增量拉取活动(**仅当配置了数据源凭据才注册**) |

## 目录结构

```
server/
  index.ts          Hono app:路由挂载 + 静态托管 + 启动序列
  bootstrap.ts      启动建表
  routes/           auth / pr / health / activities
  middleware/       三种鉴权中间件
  lib/
    pr/             agent 核心:对话状态机、记忆、复盘、上下文装配、工具、RAG、提示词
    db/             schema(24 表)+ 单文件 libsql client
    ingest/         GPX 解析、活动写入、Keep/Strava 适配器
    notifications/  渠道接口 + pushplus 实现
    scheduler.ts    静态 job 配置
client/
  pr/               H5 对话页(唯一前端入口)
scripts/
  eval/             行为评测 harness(109 条 L1–L4 用例,隔离库跑真实编排)
data/               pr.db + uploads(持久化目录,备份即拷此处)
```

## 本地开发

```bash
npm install          # 本仓用 npm 锁定依赖(勿 bun install)
bun run dev          # Hono 后端,--watch,:3030
bun run dev:client   # Vite 前端,HMR
bun run build        # vite build → client/dist
bun run start        # 生产模式跑
bun run typecheck    # tsc --noEmit
npm run eval -- --limit=5   # 行为评测小样本(详见 scripts/eval/README.md)
```

## 设计取舍

- **单用户**:`friend_profile` 是单例,没有租户维度。这是刻意的——它是"一个人的搭子"。
- **只做对话页,管理界面外置**:管理动作(记忆确认/编辑、复盘重发、画像、常跑地点)全部保留为
  带会话鉴权的 API,但不内置界面。理由是这些界面天生属于宿主应用(如 runPaceFlow-admin 的
  「PR 伙伴」面板),内置一份就要维护两份;宿主既可调 API,也可直接读同一个库。
- **共库部署时关掉本进程调度**:`PR_SCHEDULER=off`。定时任务是幂等性最弱的一环,同一个库被
  两个进程调度会生成重复复盘、重复推送,所以做成显式开关而不是自动探测。
- **Anthropic 协议为主链路**:工具循环、图片、提示缓存都在这条路上;OpenAI 兼容通道是纯文本备用。
- **工具轮次耗尽时硬停**:用 `tool_choice: none` 在协议层禁止再调工具,而不是靠提示词"请你别调了"
  ——后者依赖模型配合,不同模型表现不一。
- **记忆需确认**:新记忆一律候选态,用户确认或累计足够独立证据才转正。
