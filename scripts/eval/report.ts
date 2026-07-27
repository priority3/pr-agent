/**
 * 报告生成 —— summary.md / results.json / failures/<id>.md。
 *
 * failures/*.md 逐条渲染「完整 agent 调用日志」= agent_state_snapshots 的有序瀑布
 * (build_context → tool_use → draft_response → evaluate_response → persist_output),
 * 等价于 tracing UI 里那条 trace 的瀑布图,但不依赖任何 OTel 收集器。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import type { Level } from './cases'
import { FAILURE_REASONS, type FailureReason, type HardFlag, type Severity, SEVERITY_RANK } from './checks'
import type { JudgeVerdict, ToolCallRecord } from './judge'

export interface SnapshotRecord {
  step: string
  state: unknown
  createdAt: string | null
}

export interface TurnResult {
  turnIndex: number
  user: string
  imageUrl?: string | null
  answer: string
  thinking: string
  toolEvents: string[]
  runId: string
  model: string
  provider: string
  warnings: string[]
  latencyMs: number
  runStatus: string
  toolCalls: ToolCallRecord[]
  snapshots: SnapshotRecord[]
  error?: string
}

export type CaseStatus = 'pass' | 'fail' | 'inconclusive'

export interface CaseResult {
  id: string
  level: Level
  category: string
  title: string
  turns: TurnResult[]
  toolNames: string[]
  expectedTool?: string
  maxLatencyMs: number
  hardFlags: HardFlag[]
  judge: JudgeVerdict
  status: CaseStatus
  reasons: FailureReason[]
  severity: Severity
}

export interface RunMeta {
  startedAt: string
  finishedAt: string
  model: string
  provider: string
  seedVersion: string
  seed: Record<string, number>
  /** 各种子档位的用例数(default/stale/empty)。 */
  seedProfiles?: Record<string, number>
  /** 因未配 ANTHROPIC_VISION_MODEL 被跳过的视觉用例 id。 */
  skippedVision?: string[]
  /** 因 embedding 未配置(KEY+MODEL 未齐备)被跳过的语义档知识检索用例 id。 */
  skippedEmbedding?: string[]
  today: string
  evalDbUrl: string
  argv: string[]
}

function pct(n: number, d: number): string {
  return d === 0 ? '—' : `${((n / d) * 100).toFixed(0)}%`
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1))
  return sorted[idx]
}

function severityBadge(s: Severity): string {
  return { none: '·', low: '🟢', medium: '🟡', high: '🟠', critical: '🔴' }[s]
}

function statusBadge(s: CaseStatus): string {
  return { pass: '✅', fail: '❌', inconclusive: '⚠️' }[s]
}

function mdEscape(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

// ── summary.md ──
function buildSummary(meta: RunMeta, results: CaseResult[]): string {
  const total = results.length
  const pass = results.filter(r => r.status === 'pass').length
  const fail = results.filter(r => r.status === 'fail').length
  const incon = results.filter(r => r.status === 'inconclusive').length

  const levels: Level[] = ['L1', 'L2', 'L3', 'L4']
  const byLevel = levels.map(lv => {
    const rs = results.filter(r => r.level === lv)
    return {
      lv,
      total: rs.length,
      pass: rs.filter(r => r.status === 'pass').length,
      fail: rs.filter(r => r.status === 'fail').length,
      incon: rs.filter(r => r.status === 'inconclusive').length,
    }
  })

  const cats = Array.from(new Set(results.map(r => r.category))).sort()
  const byCat = cats.map(cat => {
    const rs = results.filter(r => r.category === cat)
    return { cat, total: rs.length, pass: rs.filter(r => r.status === 'pass').length }
  })

  // 失败原因直方图(只统计非 pass 的 case)
  const hist = new Map<FailureReason, number>()
  for (const r of results) {
    if (r.status === 'pass') continue
    for (const reason of r.reasons) hist.set(reason, (hist.get(reason) ?? 0) + 1)
  }
  const histSorted = [...hist.entries()].sort((a, b) => b[1] - a[1])

  const latencies = results.flatMap(r => r.turns.map(t => t.latencyMs)).filter(n => n > 0)

  // 工具准确率
  const toolCases = results.filter(r => r.expectedTool)
  const toolHit = toolCases.filter(r => r.toolNames.includes(r.expectedTool!)).length

  const notable = results
    .filter(r => r.status !== 'pass')
    .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity])

  const lines: string[] = []
  lines.push('# PR 运动伙伴 Agent —— 分级鲁棒性评测报告', '')
  lines.push('## 运行信息', '')
  lines.push(`- 时间:${meta.startedAt} → ${meta.finishedAt}`)
  lines.push(`- 模型 / 提供方:\`${meta.model}\` / ${meta.provider}`)
  lines.push(`- 今天(Asia/Shanghai):${meta.today}`)
  lines.push(`- 种子:${meta.seedVersion} —— ${JSON.stringify(meta.seed)}`)
  if (meta.seedProfiles && Object.keys(meta.seedProfiles).length > 1) lines.push(`- 种子档位分布:${JSON.stringify(meta.seedProfiles)}`)
  if (meta.skippedVision?.length) lines.push(`- ⚠️ 跳过视觉用例(未配 ANTHROPIC_VISION_MODEL):${meta.skippedVision.join(', ')}`)
  if (meta.skippedEmbedding?.length) lines.push(`- ⚠️ 跳过语义档知识检索用例(embedding 未配置,需 PR_EMBEDDING_API_KEY + PR_EMBEDDING_MODEL):${meta.skippedEmbedding.join(', ')}`)
  lines.push(`- 隔离库:\`${meta.evalDbUrl}\`(零生产污染)`)
  lines.push(`- 参数:\`${meta.argv.join(' ') || '(全量)'}\``)
  lines.push('')
  lines.push('## 总体结果', '')
  lines.push(`| 指标 | 值 |`, `|---|---|`)
  lines.push(`| 用例总数 | ${total} |`)
  lines.push(`| ✅ 通过 | ${pass}(${pct(pass, total)}) |`)
  lines.push(`| ❌ 失败 | ${fail}(${pct(fail, total)}) |`)
  lines.push(`| ⚠️ 无法判定(裁判解析失败) | ${incon} |`)
  lines.push('')
  lines.push('## 分级通过率', '')
  lines.push(`| 等级 | 总数 | 通过 | 失败 | 无法判定 | 通过率 |`, `|---|---|---|---|---|---|`)
  for (const b of byLevel) {
    lines.push(`| ${b.lv} | ${b.total} | ${b.pass} | ${b.fail} | ${b.incon} | ${pct(b.pass, b.total)} |`)
  }
  lines.push('')
  lines.push('## 分类别通过率', '')
  lines.push(`| 类别 | 总数 | 通过 | 通过率 |`, `|---|---|---|---|`)
  for (const b of byCat) lines.push(`| ${b.cat} | ${b.total} | ${b.pass} | ${pct(b.pass, b.total)} |`)
  lines.push('')
  lines.push('## 失败原因直方图(降序,仅统计未通过用例)', '')
  if (histSorted.length === 0) {
    lines.push('_无失败原因_', '')
  } else {
    lines.push(`| 失败原因 | 次数 |`, `|---|---|`)
    for (const [reason, count] of histSorted) lines.push(`| \`${reason}\` | ${count} |`)
    lines.push('')
  }
  lines.push('## 延迟 / 工具', '')
  lines.push(`- 单轮延迟(ms):p50 ${percentile(latencies, 0.5)} · p95 ${percentile(latencies, 0.95)} · max ${Math.max(0, ...latencies)}`)
  lines.push(`- 工具使用准确率:${toolHit}/${toolCases.length}(期望调用指定工具的用例中,实际调用到的比例)`)
  lines.push('')
  lines.push('## 未通过用例(按严重度降序)', '')
  if (notable.length === 0) {
    lines.push('_全部通过_', '')
  } else {
    lines.push(`| 用例 | 等级 | 严重度 | 状态 | 失败原因 | 完整日志 |`, `|---|---|---|---|---|---|`)
    for (const r of notable) {
      lines.push(
        `| ${r.id}<br/>${mdEscape(r.title)} | ${r.level} | ${severityBadge(r.severity)} ${r.severity} | ${statusBadge(r.status)} | ${r.reasons.map(x => `\`${x}\``).join(' ') || '—'} | [log](failures/${r.id}.md) |`,
      )
    }
    lines.push('')
  }
  lines.push('## 全部用例一览', '')
  lines.push(`| 用例 | 等级 | 状态 | KA | BA | 任务 | 工具 | 延迟(ms) |`, `|---|---|---|---|---|---|---|---|`)
  for (const r of results) {
    const j = r.judge
    lines.push(
      `| ${r.id} | ${r.level} | ${statusBadge(r.status)} | ${j.scores.ka} | ${j.scores.ba} | ${j.scores.task} | ${r.toolNames.join(',') || '—'} | ${r.maxLatencyMs} |`,
    )
  }
  lines.push('')
  return lines.join('\n')
}

// ── failures/<id>.md:完整 agent 调用日志(trace 式瀑布) ──
function renderSnapshotWaterfall(turn: TurnResult): string {
  const lines: string[] = []
  // agent_state_snapshots 落库为 createdAt 倒序,这里正序展示编排步骤
  const ordered = [...turn.snapshots].sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''))
  for (const snap of ordered) {
    const ts = snap.createdAt ? snap.createdAt.slice(11, 19) : '--:--:--'
    const state = JSON.stringify(snap.state, null, 2)
    const clipped = state.length > 2600 ? `${state.slice(0, 2600)}\n…(截断)` : state
    lines.push(`- \`${ts}\` **${snap.step}**`)
    lines.push('  ```json')
    lines.push(clipped.split('\n').map(l => `  ${l}`).join('\n'))
    lines.push('  ```')
  }
  return lines.join('\n')
}

function buildFailureDoc(r: CaseResult): string {
  const lines: string[] = []
  lines.push(`# ${statusBadge(r.status)} ${r.id} — ${r.title}`, '')
  lines.push(`- 等级:${r.level}｜类别:${r.category}｜严重度:${severityBadge(r.severity)} ${r.severity}`)
  lines.push(`- 失败原因:${r.reasons.map(x => `\`${x}\``).join(' ') || '—'}`)
  lines.push(`- 实际工具调用:${r.toolNames.join(', ') || '(无)'}${r.expectedTool ? `(期望:${r.expectedTool})` : ''}`)
  lines.push('')
  lines.push('## 裁判裁定', '')
  lines.push(`- 判定:${r.judge.judged ? (r.judge.pass ? 'pass' : 'fail') : '无法判定(解析失败)'}`)
  lines.push(`- 打分:KA ${r.judge.scores.ka} · BA ${r.judge.scores.ba} · 任务 ${r.judge.scores.task}`)
  lines.push(`- 说明:${r.judge.rationale || '—'}`)
  if (r.judge.error) lines.push(`- 裁判错误:${r.judge.error}`)
  lines.push('')
  if (r.hardFlags.length) {
    lines.push('## 确定性红旗', '')
    for (const f of r.hardFlags) lines.push(`- ${f.hard ? '🔴 硬' : '·软'} \`${f.reason}\`(${f.severity}):${f.detail}`)
    lines.push('')
  }
  lines.push('## 对话与思考', '')
  for (const turn of r.turns) {
    lines.push(`### 第 ${turn.turnIndex + 1} 轮`, '')
    lines.push(`**用户**：${turn.user}${turn.imageUrl ? `  [图片:${turn.imageUrl}]` : ''}`, '')
    if (turn.thinking.trim()) {
      lines.push('<details><summary>PR 思考(实时流)</summary>', '', '```', turn.thinking.trim(), '```', '', '</details>', '')
    }
    lines.push(`**PR**：${turn.answer || '(空)'}`, '')
    lines.push(`_模型 ${turn.model} · 提供方 ${turn.provider} · 延迟 ${turn.latencyMs}ms · run ${turn.runId} · 状态 ${turn.runStatus}${turn.warnings.length ? ` · 告警 ${turn.warnings.join('/')}` : ''}${turn.error ? ` · 错误 ${turn.error}` : ''}_`, '')
    lines.push('#### 完整 agent 调用日志(step 快照瀑布)', '')
    lines.push(renderSnapshotWaterfall(turn) || '_(无快照)_', '')
  }
  return lines.join('\n')
}

export interface WriteReportResult {
  dir: string
  summaryPath: string
  failureCount: number
}

export function writeReport(meta: RunMeta, results: CaseResult[]): WriteReportResult {
  const stamp = meta.startedAt.replace(/[:.]/g, '-')
  // 报告落 eval-runs/(已 gitignore);可用 PR_EVAL_OUT_DIR 改到别处(CI 产物目录等)。
  const baseDir = process.env.PR_EVAL_OUT_DIR || path.join(process.cwd(), 'eval-runs')
  const dir = path.join(baseDir, `eval-${stamp}`)
  const failuresDir = path.join(dir, 'failures')
  mkdirSync(failuresDir, { recursive: true })

  writeFileSync(path.join(dir, 'summary.md'), buildSummary(meta, results), 'utf8')
  writeFileSync(path.join(dir, 'results.json'), JSON.stringify({ meta, results }, null, 2), 'utf8')

  const failing = results.filter(r => r.status !== 'pass')
  for (const r of failing) {
    writeFileSync(path.join(failuresDir, `${r.id}.md`), buildFailureDoc(r), 'utf8')
  }

  return { dir, summaryPath: path.join(dir, 'summary.md'), failureCount: failing.length }
}

// 确保 FAILURE_REASONS 被引用(类型/直方图共用),避免 tree-shake 误删
export const KNOWN_REASONS = FAILURE_REASONS
