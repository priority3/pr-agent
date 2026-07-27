/**
 * 库隔离守卫 —— 必须在任何 `@/lib/*` 模块之前 import(它们在模块加载期就读 env)。
 *
 * 抽离版只有一个库入口(server/lib/db/client.ts 读 `DATABASE_URL`),而那正是生产库的
 * 变量名:直接跑评测会把种子数据灌进 `data/pr.db`。所以这里**无条件覆盖** DATABASE_URL,
 * 指向独立的 eval 库(可用 PR_EVAL_DATABASE_URL 换路径),并清掉远程库 token,
 * 保证评测永远只写本地隔离文件。
 */
import path from 'node:path'

const DEFAULT_EVAL_DB = 'file:./data/eval.db'

const evalDbUrl = process.env.PR_EVAL_DATABASE_URL || DEFAULT_EVAL_DB

// Reason: 生产库是 file:./data/pr.db。手滑把 PR_EVAL_DATABASE_URL 指过去(或指到远程 libsql)
// 会污染真实数据且不可逆 —— 这里 fail fast,不给「跑一半才发现」的机会。
if (!evalDbUrl.startsWith('file:')) {
  throw new Error(`[eval] 隔离库必须是本地 file: 库,拿到:${evalDbUrl}`)
}
if (path.basename(evalDbUrl.replace(/^file:/, '')) === 'pr.db') {
  throw new Error(`[eval] 隔离库不能是生产库 pr.db:${evalDbUrl}`)
}

process.env.DATABASE_URL = evalDbUrl
delete process.env.DATABASE_AUTH_TOKEN

// 多模态用例的图片从这里读(uploads.ts 在模块加载时取 PR_UPLOAD_DIR)——绝不落到生产 uploads 卷。
if (!process.env.PR_UPLOAD_DIR) {
  process.env.PR_UPLOAD_DIR = './data/eval-uploads'
}

// 通知渠道:评测绝不真发推送(种子跑复盘/日报时派发器可能被触发)。
delete process.env.PUSHPLUS_TOKEN

// tracing 可选:配了 PHOENIX_COLLECTOR_ENDPOINT 才接,且默认进独立项目,避免与生产 trace 混在一起。
if (!process.env.PHOENIX_PROJECT_NAME) {
  process.env.PHOENIX_PROJECT_NAME = 'pr-agent-eval'
}

// 宿主机若装了 Claude Code 之类的工具,全局会带 ANTHROPIC_AUTH_TOKEN / 自定义头 / 默认模型,
// 它们会串进评测用的 SDK 请求:x-api-key 之外再塞一个 Authorization: Bearer,网关多半直接 403。
// 评测走 ANTHROPIC_API_KEY(x-api-key)路径,这些一律清掉。
// (ANTHROPIC_BASE_URL 的宿主覆盖无法在此区分来源——见 run.sh 在启动前 unset。)
for (const key of [
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
]) {
  delete process.env[key]
}

export const EVAL_DB_URL = evalDbUrl
