# PR Agent

单用户、可自部署的**跑步陪伴 AI agent**(角色名「PR」)—— 每日恢复反思、跑后复盘、带
主动查证工具循环与长期记忆的对话、RAG 知识库。从 RunPaceFlow admin 抽离而来,
Hono (Bun) + Vite React,自有单文件本地库,LLM / 通知 / 数据源 / 向量检索全部可插拔、
config 驱动。一条 `docker compose up` 即起,无任何托管平台或第三方账号硬依赖。

## 技术栈

- **后端** Hono(跑在 Bun),Web 标准 `ReadableStream` SSE 流式对话,`node-cron` 定时任务
- **前端** Vite + React;H5 对话页(免登录 token)+ mini-admin dashboard,静态资源由 Hono 托管
- **数据** libsql / SQLite 单文件(`data/pr.db`,WAL),drizzle ORM
- **AI** Anthropic 协议为主链路(工具循环 / 图片 / 提示缓存),OpenAI 兼容为备用,均 config 驱动

## 快速开始(自部署)

```bash
cp .env.example .env      # 填必填项(见下),敏感项留空即降级
docker compose up -d      # 起服务(默认 :3030,数据落 ./data)
```

必填最小集:`ADMIN_PASSWORD`、`ADMIN_SESSION_SECRET`、`ANTHROPIC_API_KEY`(或 `OPENAI_*`)、
`PR_CHAT_TOKEN`、`HEALTH_IMPORT_TOKEN`。其余留空则走默认或优雅降级。

本地开发(需 [Bun](https://bun.sh)):

```bash
npm install          # 装依赖(本仓用 npm 锁定,勿 bun install)
bun run dev:client   # Vite 前端(HMR)
bun run dev          # Hono 后端(--watch,:3030)
# 生产构建 + 运行:
bun run build        # vite build → client/dist
bun run start        # bun run server/index.ts
```

## env 速查(分组)

完整键集与逐条注释见 [`.env.example`](./.env.example)。分组一览:

| 分组 | 键 |
|---|---|
| 数据库 | `DATABASE_URL`(默认 `file:./data/pr.db`)、`DATABASE_AUTH_TOKEN`(远程 libsql 才需) |
| 管理端会话 | `ADMIN_PASSWORD`、`ADMIN_SESSION_SECRET`、`SETTINGS_ENCRYPTION_KEY` |
| AI 网关 | `ANTHROPIC_API_KEY/_BASE_URL/_MODEL/_VISION_MODEL`、`OPENAI_API_KEY/_BASE_URL/_MODEL/_API_FORMAT` |
| PR agent | `PR_CHAT_TOKEN`、`PR_CHAT_MAX_TOKENS`、`PR_MEMORY_DECAY_DAYS`、`PR_MEMORY_RECONCILE_APPLY`、`PR_REVIEW_MODEL/_PROVIDER`、`PR_UPLOAD_DIR`、`PR_RETENTION_DAYS` |
| RAG 向量 | `PR_EMBEDDING_API_KEY/_BASE_URL/_MODEL`(留空 = 纯 BM25) |
| 摄入 & 数据源 | `HEALTH_IMPORT_TOKEN`、`SYNC_SOURCE`、`KEEP_MOBILE/_PASSWORD`、`STRAVA_CLIENT_ID/_SECRET/_REFRESH_TOKEN` |
| 富化开关 | `ENRICH_WEATHER`、`ENRICH_RACE_MATCH`(默认关) |
| 通知 | `PUSHPLUS_TOKEN`、`PUBLIC_BASE_URL`(推送链接前缀) |
| 可观测 | `PHOENIX_COLLECTOR_ENDPOINT/_PROJECT_NAME/_API_KEY`(需自接 OTel provider) |
| 调度覆盖 | `CRON_<JOB>`(如 `CRON_PR_DAILY_REVIEW`,覆盖默认 cron) |

## 数据摄入契约

两条零第三方账号即可用的入口,均支持 **Bearer `HEALTH_IMPORT_TOKEN`** 或 dashboard 管理端会话鉴权。

### 健康数据 — `POST /api/health/daily`

Apple「健康」快捷指令上报入口(睡眠 / HRV / 静息心率 / 步数 / 环境音量)。`(date, source)`
幂等 upsert;`date` 省略时默认按 Asia/Shanghai 取今天。落库即非阻塞触发当日反思。
支持两种形状:

- **富(推荐)**:上报原始睡眠分段,服务端 `deriveSleep` 派生聚合。
  ```jsonc
  {
    "date": "2026-07-24",              // 可选,YYYY-MM-DD,省略=今天(CST)
    "source": "apple_health",          // 可选,与 date 组成幂等键
    "sleepSegments": [                  // 或 sleepSegmentsText:每行 "stage|startISO|endISO|durSec"
      { "stage": "core", "start": "2026-07-23T23:10:00+08:00", "end": "2026-07-24T06:40:00+08:00" }
    ],
    "napSegments": [],                  // 可选,白天小睡
    "hrv": 62, "restingHr": 48, "steps": 8213,
    "audioAvgDb": 41, "audioMaxDb": 78  // 可选,环境音量
  }
  ```
- **直**:调用端已算好聚合值,直接上报 `sleepMinutes` / `deepSleepMinutes` / `remSleepMinutes` /
  `hrv` / `restingHr` / `steps`,可附 `payload` 原始事实。

### 活动数据 — `POST /api/activities/import`

无 Keep/Strava 账号时的默认通路。直接喂 `RawActivity`(单个对象、数组,或 `{ "activities": [...] }`),
按 `(source, id)` 去重后写 `activities` + `splits`(有 GPX 则解析生成每公里明细)。字段:

```jsonc
{
  "id": "run-2026-07-24",     // 必填,数据源内唯一 id(幂等键)
  "source": "manual",          // 必填,来源标识
  "startTime": "2026-07-24T06:30:00+08:00",  // 必填,ISO 字符串或 epoch 毫秒
  "type": "running",           // running|cycling|walking|swimming|other,默认 running
  "distance": 10230,           // 米
  "duration": 3180,            // 秒
  "title": "晨跑",             // 可选
  "isIndoor": false,           // 可选
  "gpxData": "<gpx>…</gpx>",   // 可选,提供则解析轨迹/split
  "averagePace": 311, "bestPace": 288,        // 可选,秒/公里
  "elevationGain": 42,                         // 可选,米
  "averageHeartRate": 152, "maxHeartRate": 171,// 可选
  "calories": 640                              // 可选
}
```

返回 `{ imported, skipped, errors? }`。

## 可插拔边界

- **数据源**:默认无自动同步。设 `SYNC_SOURCE=keep|strava`(并填对应凭据)即启用调度器每小时增量拉取;
  否则用上面的通用导入端点。Keep / Strava 为 opt-in 适配器。
- **通知**:`PUSHPLUS_TOKEN` 配置时启用 pushplus(China-only 微信/邮件/短信);留空则派发器优雅
  no-op,不报错。渠道经 `NotificationChannel` 接口抽象,可扩展。
- **LLM 网关**:配 `ANTHROPIC_*` 走 Anthropic 协议主链路;未配则降级到 `OPENAI_*` 兼容网关。
  `*_BASE_URL` 留空 = 官方端点,填则指向任意兼容代理。
- **RAG 向量**:配 `PR_EMBEDDING_*` 启用向量 + BM25 混合检索;留空则纯 BM25 lexical,无需任何 embedding 服务。
- **富化**:`ENRICH_WEATHER`(open-meteo,keyless)、`ENRICH_RACE_MATCH`(依赖 Playwright,standalone
  未打包,置开仅告警)默认关,避免每次同步打外部。
- **可观测**:tracing 层基于 `@opentelemetry/api`,未注册 provider 时为 no-op 零开销;接入
  Phoenix / OTLP 收集器需自行注册 OTel SDK。

## 端点一览

**页面(静态)**

| 路径 | 说明 |
|---|---|
| `/pr` | H5 对话(手机优先,`?t=<PR_CHAT_TOKEN>` 免登录进入) |
| `/dashboard`(及 `/`) | mini-admin:PR 运行 / 记忆 / 复盘 / 恢复 / 家庭位置面板 |

**API**

| 方法 & 路径 | 鉴权 | 说明 |
|---|---|---|
| `POST /api/auth/login` · `/logout` | 口令 | dashboard 登录(`ADMIN_PASSWORD`)/ 登出 |
| `GET·POST /api/pr/chat` | `PR_CHAT_TOKEN` | 拉历史 / 发消息(`stream:true` 走 SSE) |
| `GET·DELETE /api/pr/threads` | `PR_CHAT_TOKEN` | 会话列表 / 删除 |
| `POST /api/pr/upload` · `GET /api/pr/image/:name` | `PR_CHAT_TOKEN` | 图片上传 / 取图 |
| `GET /api/pr/agent-runs`、`/diary`、`/reviews`、`/memories`、`/profile`、`/metrics`、`/flywheel` … | 会话 | dashboard 数据源 |
| `POST /api/pr/weekly-review`、`/reviews/regenerate`、`/reviews/notify`、`/knowledge`、`/feedback` | 会话 | 手动触发 / 写入 |
| `GET /api/health` | 公开 | 存活探针 |
| `GET·POST /api/health/daily` | 会话 或 `HEALTH_IMPORT_TOKEN` | 健康指标查询 / 上报(见摄入契约) |
| `POST /api/activities/import` | 会话 或 `HEALTH_IMPORT_TOKEN` | 通用活动导入(见摄入契约) |

## 目录

```
server/   Hono 后端:routes/ + middleware/ + lib/(pr agent 核心、db、config、ingest、notifications、scheduler)
client/   Vite React:pr/(H5 对话)+ dashboard/(mini-admin)
data/     单文件库 pr.db + uploads(持久卷,备份即拷此目录)
```

> 抽离蓝图见 [.trellis 任务](../runPaceFlow-admin/.trellis/tasks/07-23-pr-agent-extraction/)。
