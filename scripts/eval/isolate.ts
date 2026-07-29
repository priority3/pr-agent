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

// Reason: 播种会清表,手滑把 PR_EVAL_DATABASE_URL 指到真实库(或指到远程 libsql)会不可逆地
// 抹掉数据 —— 这里 fail fast,不给「跑一半才发现」的机会。
if (!evalDbUrl.startsWith('file:')) {
  throw new Error(`[eval] 隔离库必须是本地 file: 库,拿到:${evalDbUrl}`)
}

const asAbsFilePath = (url: string) => path.resolve(url.replace(/^file:/, ''))

// 最强的一道:直接跟**本进程实际拿到的** DATABASE_URL 比对(此刻还没被覆盖)。
// Reason: 早先只黑名单文件名 `pr.db`,但库名会变 —— 与宿主共库部署时它就叫 shared.db,
// 那次改名让这道守卫瞬间失效(而那个库装着真实历史)。比对真实目标才不会随命名漂移。
const productionDbUrl = process.env.DATABASE_URL
if (productionDbUrl?.startsWith('file:') && asAbsFilePath(productionDbUrl) === asAbsFilePath(evalDbUrl)) {
  throw new Error(`[eval] 隔离库与当前 DATABASE_URL 指向同一个文件,拒绝运行:${evalDbUrl}`)
}

// 兜底黑名单:已知的生产库文件名(即便本次没设 DATABASE_URL 也别踩)。
if (['pr.db', 'shared.db', 'admin.db'].includes(path.basename(asAbsFilePath(evalDbUrl)))) {
  throw new Error(`[eval] 隔离库不能用生产库文件名:${evalDbUrl}`)
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
