# 接口与配置参考

## 页面

| 路径 | 说明 |
|---|---|
| `/pr`(及 `/`) | H5 对话(手机优先)。`?t=<一次性令牌>` 进入 → 兑换成设备令牌存 localStorage |

唯一的内置页面就是对话页(`/` 与 `/pr` 返回同一份 HTML)。管理界面不内置,见下「API」。
未命中的路径落到静态托管:命中 `client/dist` 里的文件就返回该文件(`/assets/*`、`/pr-logo.png`),
否则 404(无 SPA 兜底)。

## API

下表中标「会话」的是**管理端点:有接口、无内置界面**。用 `POST /api/auth/login` 拿会话 cookie
后即可调用(curl / 你自己的界面 / 宿主应用的面板均可);共库部署时宿主也可以直接读同一个库。

| 方法 & 路径 | 鉴权 | 说明 |
|---|---|---|
| `POST /api/auth/login` · `/logout` | 口令 | 管理接口登录(`ADMIN_PASSWORD`)/ 登出 |
| `GET·POST /api/pr/chat` | 设备令牌 | 拉历史 / 发消息(`stream:true` 走 SSE) |
| `GET·DELETE /api/pr/threads` | 设备令牌 | 会话列表 / 删除 |
| `POST /api/pr/upload` | 设备令牌 | 图片上传(≤10MB) |
| `GET /api/pr/image/:name` | 设备令牌 | 取图(前端 fetch 成 blob,令牌只走请求头) |
| `POST /api/pr/access/session` | 公开 | 一次性令牌换设备令牌(限流 10 次/分钟/IP) |
| `POST·GET /api/pr/access/links` | 会话 | 签发一次性入口链接 / 看签发记录 |
| `GET /api/pr/access/devices` · `DELETE /devices/:id` | 会话 | 设备清单 / 吊销某台设备 |
| `GET /api/pr/memories` · `PATCH /:id` · `POST /:id/confirm` · `/:id/archive` | 会话 | 长期记忆的查看 / 编辑 / 确认 / 归档 |
| `GET /api/pr/profile` · `GET·PUT·DELETE /api/pr/profile/home-location` | 会话 | 伙伴画像 / 常跑地点 |
| `GET /api/pr/reviews` · `POST /reviews/notify` · `/reviews/regenerate` | 会话 | 复盘列表 / 重发 / 重新生成 |
| `POST /api/pr/weekly-review` | 会话 | 手动触发周总结 |
| `GET /api/pr/diary` | 会话 | 老友日记 |
| `GET /api/pr/agent-runs` · `/agent-runs/:id` · `/context/:runId` | 会话 | 运行记录与上下文快照(排查用) |
| `GET /api/pr/metrics` · `/flywheel` | 会话 | 指标 / 飞轮 |
| `GET /api/pr/persona` · `/persona/history` · `POST /persona/reproject` | 会话 | 数字分身投影(traits + 渲染清单)/ 特征变更史 / 手动重投影 |
| `GET /api/pr/persona/live` | 会话 | 实时状态(代理 priority.me presence,30s 缓存,永不落库) |
| `POST /api/pr/persona/ingest` | 会话 或 `LORE_INGEST_TOKEN` | pr-lore 采集投递(lore.capture.v1 → MemoryCurator 蒸馏为候选记忆) |
| `GET·PUT /api/pr/settings` | 会话 | AI 网关运行时配置(白名单 8 键,密文落库,改完即生效免重启) |
| `POST /api/pr/knowledge` | 会话 | 知识库文档导入(RAG) |
| `POST /api/pr/feedback` | 会话 | 反馈事件 |
| `GET /api/health` | 公开 | 存活探针 |
| `GET·POST /api/health/daily` | 会话 或 `HEALTH_IMPORT_TOKEN` | 健康指标查询 / 上报 |
| `POST /api/activities/import` | 会话 或 `HEALTH_IMPORT_TOKEN` | 通用活动导入 |

摄入两条的字段详见 [ingest.md](./ingest.md)。

## 拿入口链接

对话页没有共享密码,进门靠**一次性链接**。链接由管理接口签发,7 天内有效、**只能用一次**:

```bash
curl -c /tmp/pr.cookie -X POST localhost:3030/api/auth/login \
  -H 'Content-Type: application/json' -d '{"password":"<ADMIN_PASSWORD>"}'

curl -b /tmp/pr.cookie -X POST localhost:3030/api/pr/access/links \
  -H 'Content-Type: application/json' -d '{"note":"iPhone"}'
# → {"url":"https://…/pr?t=…","expiresAt":"…"}
```

手机打开那条 `url`,页面会把一次性令牌换成**这台设备专属**的令牌存进 localStorage
(90 天,每次使用滑动续期),链接随即作废,地址栏里的 `t` 也会被抹掉。之后从书签或推送里
点 `/pr` 直接就能聊 —— 推送链接本身不再携带任何令牌。

丢了手机或想踢掉某台设备:`GET /api/pr/access/devices` 找到它,
`DELETE /api/pr/access/devices/:id` 吊销(最迟一分钟内生效 —— 校验结果有 60s 内存缓存)。

> 兑换有 10 分钟幂等窗口:同一条链接在这段时间内重复兑换会拿到同一枚设备令牌
> (页面刷新、弱网重试不至于把人锁在门外)。窗口之外再点就是「已用过」。

## 配置项

完整键集与逐条注释在 [`.env.example`](../.env.example)。分组一览:

| 分组 | 键 |
|---|---|
| 数据库 | `DATABASE_URL`(默认 `file:./data/pr.db`)、`DATABASE_AUTH_TOKEN`(远程 libsql 才需) |
| 管理端 | `ADMIN_PASSWORD`、`ADMIN_SESSION_SECRET`(管理 API 鉴权,无内置界面)、`SETTINGS_ENCRYPTION_KEY` |
| AI 网关 | `ANTHROPIC_API_KEY` / `_BASE_URL` / `_MODEL` / `_VISION_MODEL`;`OPENAI_API_KEY` / `_BASE_URL` / `_MODEL` / `_API_FORMAT`(这 8 键可被 `/api/pr/settings` 运行时覆盖,库内值优先) |
| 对话 | `PR_CHAT_MAX_TOKENS`、`PR_UPLOAD_DIR`(访问令牌不走 env,见上「拿入口链接」) |
| 记忆 | `PR_MEMORY_DECAY_DAYS`、`PR_MEMORY_RECONCILE_APPLY` |
| 数字分身 | `PR_PERSONA_LLM`(`off` = 只跑确定性投影)、`PR_PRESENCE_URL`(实时状态上游,留空关闭)、`LORE_INGEST_TOKEN`(pr-lore 投递令牌) |
| 复盘 | `PR_REVIEW_MODEL`、`PR_REVIEW_PROVIDER`、`PR_RETENTION_DAYS` |
| RAG 向量 | `PR_EMBEDDING_API_KEY` / `_BASE_URL` / `_MODEL`(留空 = 纯 BM25) |
| 摄入 | `HEALTH_IMPORT_TOKEN`(通用导入接口的鉴权;不直连 Keep/Strava,那是 admin 的职责) |
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
| `persona_projection` | `47 3 * * *` | 数字分身投影兜底(平时由记忆/健康变更即时触发) |
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
    pr/             agent 核心:对话状态机、记忆、复盘、上下文装配、工具、RAG、提示词、
                    数字分身投影(persona.ts,供宿主「数字分身」面板消费)
    db/             schema(26 表)+ 单文件 libsql client
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
- **配置以 env 为基底,仅 AI 网关 8 键可运行时覆盖**:宿主面板改网关(url/key/model)免重启;
  鉴权与拓扑类键刻意排除在白名单外——库内数据被篡改也动不了鉴权与数据面。覆盖值
  aes-256-gcm 密文落库,备份链路(快照/实时复制)接触不到明文密钥。
- **常跑地点靠推导,不靠设置项**:没有显式设置时,从最近有轨迹的户外活动起点按 0.02°(≈2 km)
  网格聚类推。三条规则都写成代码常量(`STALE_AFTER_DAYS=90` / `ALTERNATE_MIN_SHARE=0.25` /
  `ALTERNATE_MIN_SEPARATION_KM=1.5`)而不是配置:① 主簇最新活动超过 90 天就标 `stale`,上下文与
  `query_weather` 返回都带上"这是旧轨迹推的、可能已经变了",天气结论随之带不确定;② 占比 ≥25%
  且离主簇 ≥1.5 km 的次簇作为"也常去"一并呈现(天气仍按主簇,避免歧义);③ 系统只有坐标没有地名
  (刻意不接反地理编码:精度不够、要限流、还得把坐标外发),所以上下文里让 PR 别猜地名、聊到时
  顺口问一次——用户答了由记忆系统自然沉淀,不再多加设置项。
