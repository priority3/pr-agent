# PR Agent

单用户、可自部署的跑步陪伴 AI agent —— 每日恢复反思、跑后复盘、带主动查证工具循环
与长期记忆的对话、RAG 知识库。从 RunPaceFlow admin 抽离而来,Hono (Bun) + Vite React,
自有单文件本地库,LLM / 通知 / 数据源全部可插拔、config 驱动。

> 状态:抽离进行中(P0 脚手架)。见 [.trellis 抽离蓝图](../runPaceFlow-admin/.trellis/tasks/07-23-pr-agent-extraction/)。

## 技术栈

- **后端** Hono(跑在 Bun),Web 标准 `ReadableStream` SSE 流式对话
- **前端** Vite + React,H5 对话页(免登录 token)+ mini-admin dashboard,静态资源由 Hono 托管
- **数据** libsql/SQLite 单文件(`data/pr.db`),drizzle ORM
- **AI** Anthropic 协议为主链路(工具/图片/缓存),OpenAI 兼容为备用,均 config 驱动

## 快速开始(自部署)

```bash
cp .env.example .env      # 填 ANTHROPIC_API_KEY、PR_CHAT_TOKEN、HEALTH_IMPORT_TOKEN 等
docker compose up -d      # 起服务(默认 :3030)
```

本地开发:

```bash
bun install
bun run dev:client   # Vite 前端(HMR)
bun run dev          # Hono 后端(:3030)
```

## 数据摄入

- **健康数据**(睡眠/HRV/静息心率/步数):`POST /api/health/daily`,Bearer `HEALTH_IMPORT_TOKEN`,
  Apple 健康快捷指令 JSON(通用,推荐)。
- **活动数据**:通用导入端点(规划中)或可选数据源适配器(Keep / Strava,默认关)。

## 目录

```
server/   Hono 后端:routes/ + middleware/ + lib/(pr agent 核心、db、config、ingest、notifications)
client/   Vite React:pr/(H5 对话)+ dashboard/(mini-admin)
data/     单文件库 pr.db + uploads(持久卷,备份即拷此目录)
```
