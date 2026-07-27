import './isolate' // 必须最先 import:把所有 agent 读写隔离到 eval.db

import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import path from 'node:path'

import { chatWithPr } from '@/lib/pr/chat'
import { getEmbeddingConfig } from '@/lib/pr/embeddings'
import type { PrStreamEvent } from '@/lib/pr/model'
import { callPrModel } from '@/lib/pr/model'
import { getAgentRunDetail } from '@/lib/pr/state'

import { EVAL_DB_URL } from './isolate'
import { flushEvalTracing, initEvalTracing } from './otel'
import { filterCases, type EvalCase, type Level } from './cases'
import {
  maxSeverity,
  runDeterministicChecks,
  type FailureReason,
  type HardFlag,
  type Severity,
} from './checks'
import { shanghaiToday, ENV_FIXTURE, type SeedProfile } from './dataset'
import { judgeCase, type ToolCallRecord } from './judge'
import { seed } from './seed'
import { writeReport, type CaseResult, type CaseStatus, type RunMeta, type SnapshotRecord, type TurnResult } from './report'

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

function parseArgs(argv: string[]) {
  const opts: { only?: Level; ids?: string[]; smoke?: boolean; limit?: number; noSeed?: boolean; concurrency?: number } = {}
  for (const arg of argv) {
    if (arg.startsWith('--only=')) opts.only = arg.slice('--only='.length).toUpperCase() as Level
    else if (arg.startsWith('--case=')) opts.ids = arg.slice('--case='.length).split(',').map(s => s.trim()).filter(Boolean)
    else if (arg === '--smoke') opts.smoke = true
    else if (arg.startsWith('--limit=')) opts.limit = Math.max(1, Number(arg.slice('--limit='.length)) || 1)
    else if (arg === '--no-seed') opts.noSeed = true
    else if (arg.startsWith('--concurrency=')) opts.concurrency = Math.max(1, Number(arg.slice('--concurrency='.length)) || 1)
    else if (arg === '--serial') opts.concurrency = 1
  }
  return opts
}

/** 简单 worker pool:同档内并发跑 case,结果按原顺序回填。 */
async function runPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const n = Math.max(1, Math.min(limit, items.length))
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (true) {
        const i = next++
        if (i >= items.length) break
        results[i] = await fn(items[i])
      }
    }),
  )
  return results
}

/** 从 step 快照里抽出真实的工具调用(tool_use step)。 */
function toolCallsFromSnapshots(snapshots: SnapshotRecord[]): ToolCallRecord[] {
  return snapshots
    .filter(s => s.step === 'tool_use')
    .map(s => {
      const st = (s.state ?? {}) as { name?: string; input?: unknown; result?: string }
      const raw = typeof st.result === 'string' ? st.result : undefined
      // Reason: 快照层(chat.ts)已把工具返回截到 600 字符;这里必须原样透传并显式标注截断,
      // 之前再 slice(0,300) 让裁判看不到后半段真值,是 fabricated_fact 假阳性的机制性根源之一。
      const truncated = raw != null && raw.length >= 600
      return {
        name: String(st.name ?? 'unknown'),
        input: st.input,
        resultPreview: raw == null ? undefined : truncated ? `${raw} …(快照在600字符处截断,后续内容存在但此处不可见)` : raw,
      }
    })
}

/** 从 evaluate_response 快照 + 返回 warnings 收集 Evaluator 告警。 */
function evaluatorWarningsFromSnapshots(snapshots: SnapshotRecord[], resultWarnings: string[]): string[] {
  const set = new Set<string>(resultWarnings)
  for (const s of snapshots) {
    if (s.step === 'evaluate_response') {
      const st = (s.state ?? {}) as { warnings?: unknown }
      if (Array.isArray(st.warnings)) for (const w of st.warnings) set.add(String(w))
    }
  }
  return [...set]
}

async function runTurn(evalCase: EvalCase, turnIndex: number, threadId: string | null): Promise<{ turn: TurnResult; threadId: string | null }> {
  const spec = evalCase.turns[turnIndex]
  let thinking = ''
  let streamedText = ''
  const toolEvents: string[] = []
  const onStream = (evt: PrStreamEvent) => {
    if (evt.type === 'thinking') thinking += evt.delta
    else if (evt.type === 'text') streamedText += evt.delta
    else if (evt.type === 'tool') toolEvents.push(evt.name)
    else if (evt.type === 'text_reset') streamedText = ''
  }

  const t0 = Date.now()
  try {
    const result = await chatWithPr({ message: spec.user, threadId, imageUrl: spec.imageUrl ?? null, onStream })
    const latencyMs = Date.now() - t0
    const detail = await getAgentRunDetail(result.runId)
    const snapshots: SnapshotRecord[] = detail?.snapshots ?? []
    const toolCalls = toolCallsFromSnapshots(snapshots)
    const warnings = evaluatorWarningsFromSnapshots(snapshots, result.warnings ?? [])
    const turn: TurnResult = {
      turnIndex,
      user: spec.user,
      imageUrl: spec.imageUrl ?? null,
      answer: result.answer,
      thinking,
      toolEvents,
      runId: result.runId,
      model: result.model,
      provider: result.provider,
      warnings,
      latencyMs,
      runStatus: detail?.run.status ?? 'unknown',
      toolCalls,
      snapshots,
    }
    return { turn, threadId: result.threadId }
  } catch (error) {
    const latencyMs = Date.now() - t0
    const turn: TurnResult = {
      turnIndex,
      user: spec.user,
      imageUrl: spec.imageUrl ?? null,
      answer: '',
      thinking,
      toolEvents,
      runId: '',
      model: '',
      provider: '',
      warnings: [],
      latencyMs,
      runStatus: 'error',
      toolCalls: [],
      snapshots: [],
      error: (error as Error).message,
    }
    return { turn, threadId }
  }
}

async function runCase(evalCase: EvalCase): Promise<CaseResult> {
  const turns: TurnResult[] = []
  let threadId: string | null = null
  for (let i = 0; i < evalCase.turns.length; i++) {
    const { turn, threadId: next } = await runTurn(evalCase, i, threadId)
    turns.push(turn)
    threadId = next
    if (turn.error) break // 该 case 中途报错,停止后续轮
    // 纠正/记忆类多轮 case:给后台记忆蒸馏留点时间再发下一轮
    if (evalCase.interTurnDelayMs && i < evalCase.turns.length - 1) await sleep(evalCase.interTurnDelayMs)
  }
  await sleep(300) // 让后台记忆蒸馏/摘要收尾(隔离库,best-effort)

  const toolNames = Array.from(new Set(turns.flatMap(t => [...t.toolCalls.map(tc => tc.name), ...t.toolEvents])))
  const maxLatencyMs = Math.max(0, ...turns.map(t => t.latencyMs))
  const anyRunFailed = turns.some(t => t.runStatus === 'failed' || t.runStatus === 'error')
  const evaluatorWarnings = Array.from(new Set(turns.flatMap(t => t.warnings)))
  const finalAnswer = turns.length ? turns[turns.length - 1].answer : ''

  const hardFlags: HardFlag[] = runDeterministicChecks({
    case: evalCase,
    finalAnswer,
    allAnswers: turns.map(t => t.answer),
    toolNames,
    maxLatencyMs,
    anyRunFailed,
    evaluatorWarnings,
  })
  // 模型降级(persona 抛错走了规则兜底)也算一次可靠性问题
  if (turns.some(t => t.provider === 'local-rule')) {
    hardFlags.push({ reason: 'model_error', detail: '某轮回退到规则兜底(模型调用失败)', severity: 'medium', hard: false })
  }

  const transcript = turns.flatMap(t => [
    { role: 'user' as const, text: t.user },
    { role: 'pr' as const, text: t.answer || '(空)' },
  ])
  const allToolCalls = turns.flatMap(t => t.toolCalls)
  const judge = await judgeCase({
    case: evalCase,
    transcript,
    toolCalls: allToolCalls,
    // Reason: 硬/软分开标注——missing_tool_call 等软信号此前以「硬信号」名义喂裁判,会锚定压分。
    hardFlags: hardFlags.map(f => `[${f.hard ? '硬:已被确定性检查判失败' : '软:仅参考'}][${f.reason}] ${f.detail}`),
  })

  const hardFail = hardFlags.some(f => f.hard)
  let status: CaseStatus
  if (hardFail) status = 'fail'
  else if (!judge.judged) status = 'inconclusive'
  else status = judge.pass ? 'pass' : 'fail'

  const reasonSet = new Set<FailureReason>()
  let severity: Severity = 'none'
  if (status !== 'pass') {
    for (const f of hardFlags) {
      reasonSet.add(f.reason)
      severity = maxSeverity(severity, f.severity)
    }
    for (const r of judge.failureReasons) reasonSet.add(r)
    severity = maxSeverity(severity, judge.severity)
  }

  return {
    id: evalCase.id,
    level: evalCase.level,
    category: evalCase.category,
    title: evalCase.title,
    turns,
    toolNames,
    expectedTool: evalCase.expect?.mustCallTool,
    maxLatencyMs,
    hardFlags,
    judge,
    status,
    reasons: [...reasonSet],
    severity,
  }
}

async function preflight(): Promise<{ model: string; provider: string }> {
  process.stdout.write('[eval] 预检模型网关…')
  // maxTokens 给足:thinking 型模型会先花预算思考,预算太小会只出 thinking、无正文。
  try {
    const res = await callPrModel('健康检查助手。只回一个词。', '回复:ok', { maxTokens: 1024 })
    console.log(` ok(${res.provider} / ${res.model})`)
    return { model: res.model, provider: res.provider }
  } catch (error) {
    const msg = (error as Error).message
    // 「无正文/thinking-only/max_tokens」= 网关鉴权其实是通的,只是模型思考吃满预算。
    // 这是被测 agent 的真实退化状态,应让评测继续跑并如实暴露,而不是这里就退出。
    if (/No text content|stop=max_tokens|blocks=\[thinking\]|空响应/.test(msg)) {
      console.log(' 可达但退化(模型 thinking 吃满预算 → 空正文;评测将如实记录)')
      return { model: process.env.ANTHROPIC_MODEL || 'unknown', provider: 'claude' }
    }
    console.log(' 失败')
    console.error('\n[eval] ❌ 模型网关不可用:', msg)
    console.error('  隔离评测仍需一个可用模型。请在 env-file(PR_EVAL_ENV,默认 .env)里配好其一,然后重跑:')
    console.error('   A) Anthropic 协议(主链路):ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL / ANTHROPIC_MODEL')
    console.error('   B) OpenAI 兼容网关:OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL')
    process.exit(1)
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  let cases = filterCases(opts)
  const startedAt = new Date().toISOString()

  // 可选 tracing:配了 PHOENIX_COLLECTOR_ENDPOINT 才接(默认进 pr-agent-eval 项目),留空则不接。
  await initEvalTracing()

  // 环境 fixture:种子活动没有 GPS 轨迹,常跑地点推导不出来 → 走 provider 预留的
  // PR_ENV_FIXTURE_JSON 通道,天气/空气数据可复现且不出外网(值与裁判事实块同源)。
  if (!process.env.PR_ENV_FIXTURE_JSON) process.env.PR_ENV_FIXTURE_JSON = JSON.stringify(ENV_FIXTURE)

  console.log(`[eval] 隔离库 ${EVAL_DB_URL}｜今天 ${shanghaiToday()}｜用例 ${cases.length}${opts.only ? `(仅 ${opts.only})` : ''}`)
  const pf = await preflight()

  // 视觉用例需要 ANTHROPIC_VISION_MODEL;未配则跳过并如实记录,不算失败。
  const visionCases = cases.filter(c => c.turns.some(turn => turn.imageUrl))
  let skippedVision: string[] = []
  if (visionCases.length && !process.env.ANTHROPIC_VISION_MODEL) {
    skippedVision = visionCases.map(c => c.id)
    cases = cases.filter(c => !c.turns.some(turn => turn.imageUrl))
    console.log(`[eval] ⚠️ 未配 ANTHROPIC_VISION_MODEL,跳过 ${skippedVision.length} 条视觉用例:${skippedVision.join(', ')}`)
  }

  // 语义档知识检索用例(查询与靶文档零字面重叠)只有向量路能命中;embedding 未配置时
  // 检索必走纯词法,跑了就是永久红——跳过并如实记录,不算失败(词法档用例不受影响,必须过)。
  // Reason: 判定必须与应用层同源同强度,直接问 getEmbeddingConfig()(KEY+MODEL 齐备才算配好)——
  // 只看 env PR_EMBEDDING_API_KEY 会在半配置(缺 MODEL)时放行,跑了必红。
  const embeddingCases = cases.filter(c => c.requiresEmbedding)
  let skippedEmbedding: string[] = []
  if (embeddingCases.length && !(await getEmbeddingConfig())) {
    skippedEmbedding = embeddingCases.map(c => c.id)
    cases = cases.filter(c => !c.requiresEmbedding)
    console.log(`[eval] ⚠️ embedding 未配置(需 PR_EMBEDDING_API_KEY + PR_EMBEDDING_MODEL),跳过 ${skippedEmbedding.length} 条语义档知识检索用例:${skippedEmbedding.join(', ')}`)
  }

  // 多模态资产 → uploads 目录(chatWithPr 按 imageUrl 从 PR_UPLOAD_DIR 读盘)。
  const assetsDir = path.join(import.meta.dirname, 'assets')
  const uploadDir = process.env.PR_UPLOAD_DIR || './data/eval-uploads'
  if (existsSync(assetsDir)) {
    mkdirSync(uploadDir, { recursive: true })
    for (const f of readdirSync(assetsDir)) {
      if (/\.(png|jpe?g|gif|webp)$/i.test(f)) copyFileSync(path.join(assetsDir, f), path.join(uploadDir, f))
    }
  }

  let seedInfo: Record<string, number> = {}
  let seedVersion = 'skipped'
  const seedProfiles: Record<string, number> = {}

  // 按种子档分组:default → stale → empty;档间重播种子(全量清表重播,幂等)。
  const SEED_ORDER: SeedProfile[] = ['default', 'stale', 'empty']
  const groups = SEED_ORDER.map(profile => ({
    profile,
    list: cases.filter(c => (c.seedProfile ?? 'default') === profile),
  })).filter(g => g.list.length > 0)

  // Reason: 默认串行。并发 ≥3 时网关不稳会触发 Bun 侧偶发崩溃,且多 case 共用同一
  // 单用户库(会话/记忆/快照)——并发跑会互相污染上下文,判据不可复现。要提速用 --concurrency=n 自担风险。
  const concurrency = Math.max(1, opts.concurrency ?? 1)
  const results: CaseResult[] = []
  let done = 0

  for (const g of groups) {
    seedProfiles[g.profile] = g.list.length
    if (!opts.noSeed) {
      process.stdout.write(`[eval] 播种 eval.db(档位 ${g.profile},${g.list.length} 条)…`)
      const s = await seed(g.profile)
      if (g.profile === 'default' || seedVersion === 'skipped') {
        seedVersion = s.version
        seedInfo = { activities: s.activities, healthDays: s.healthDays, raceGoals: s.raceGoals, memories: s.memories, knowledgeDocs: s.knowledgeDocs }
      }
      console.log(' 完成')
    }
    const groupResults = await runPool(g.list, concurrency, async c => {
      const r = await runCase(c)
      done += 1
      const badge = r.status === 'pass' ? '✅' : r.status === 'fail' ? '❌' : '⚠️'
      console.log(`[eval] (${done}/${cases.length}) ${c.level} ${c.id} … ${badge} ${r.status}${r.reasons.length ? ` [${r.reasons.join(',')}]` : ''} ${r.maxLatencyMs}ms`)
      return r
    })
    results.push(...groupResults)
  }

  const finishedAt = new Date().toISOString()
  const meta: RunMeta = {
    startedAt,
    finishedAt,
    model: pf.model,
    provider: pf.provider,
    seedVersion,
    seed: seedInfo,
    seedProfiles,
    skippedVision: skippedVision.length ? skippedVision : undefined,
    skippedEmbedding: skippedEmbedding.length ? skippedEmbedding : undefined,
    today: shanghaiToday(),
    evalDbUrl: EVAL_DB_URL ?? '(unset)',
    argv: process.argv.slice(2),
  }
  const out = writeReport(meta, results)

  const pass = results.filter(r => r.status === 'pass').length
  const fail = results.filter(r => r.status === 'fail').length
  const incon = results.filter(r => r.status === 'inconclusive').length
  console.log('\n========== 评测完成 ==========')
  console.log(`通过 ${pass} / 失败 ${fail} / 无法判定 ${incon}（共 ${results.length}）`)
  console.log(`报告目录:${out.dir}`)
  console.log(`摘要:${out.summaryPath}`)
  console.log(`失败详情(完整调用日志):${out.failureCount} 份 → ${out.dir}/failures/`)

  // tracing 开着时把缓冲里的尾部 span 冲出去再退出,否则最后几条 case 的 trace 会丢。
  await flushEvalTracing()
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error('[eval] 运行失败:', error)
    process.exit(1)
  })
