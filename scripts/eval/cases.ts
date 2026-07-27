/**
 * PR Agent 分级测试用例(L1–L4)聚合入口。
 *
 * 用例本体按等级/维度拆在 cases/ 目录:l1–l4 为原始 45 条,其余文件为扩容维度
 * (时间语义/写操作/退化态/纠正/医疗/注入/单位/视觉/伙伴/记忆/噪声/知识检索)。
 * 此处只做拼接、id 唯一性校验与过滤导出。
 *
 * 分级语义:
 *  L1 十分详细/参数明确 —— 判定近乎确定,重在工具选择 + 忠实回读(KA),禁捏造。
 *  L2 正常人白话、无歧义 —— 自然语言→正确落地、口语简短。
 *  L3 上下文/别名/黑话/复杂链路/结果回查 —— 术语、多轮指代、融合推理、跨记录聚合。
 *  L4 缺关键信息/权限边界/高风险/越权诱导 —— 澄清、能力边界、医疗安全、注入/外泄/施压。
 */
import { COMPANION_CASES } from './cases/companion'
import { CORRECTION_CASES } from './cases/correction'
import { DEGRADED_CASES } from './cases/degraded'
import { INJECTION2_CASES } from './cases/injection2'
import { L1_CASES } from './cases/l1'
import { L2_CASES } from './cases/l2'
import { L3_CASES } from './cases/l3'
import { L4_CASES } from './cases/l4'
import { MEDICAL2_CASES } from './cases/medical2'
import { MEMORY2_CASES } from './cases/memory2'
import { NOISE_CASES } from './cases/noise'
import { RETRIEVAL_CASES } from './cases/retrieval'
import { TIME_CASES } from './cases/time'
import { UNITS_CASES } from './cases/units'
import { VISION_CASES } from './cases/vision'
import { WRITE_BOUNDARY_CASES } from './cases/write-boundary'
import type { EvalCase, Level } from './cases/shared'

export type { DeterministicExpect, EvalCase, JudgeSpec, Level } from './cases/shared'

export const CASES: EvalCase[] = [
  ...L1_CASES,
  ...L2_CASES,
  ...L3_CASES,
  ...L4_CASES,
  // ── 扩容维度(2026-07-20) ──
  ...TIME_CASES,
  ...WRITE_BOUNDARY_CASES,
  ...DEGRADED_CASES,
  ...CORRECTION_CASES,
  ...MEDICAL2_CASES,
  ...INJECTION2_CASES,
  ...UNITS_CASES,
  ...VISION_CASES,
  ...COMPANION_CASES,
  ...MEMORY2_CASES,
  ...NOISE_CASES,
  // ── RAG 混合检索联动(2026-07-21)──
  ...RETRIEVAL_CASES,
]

// Reason: 拆多文件后最容易出的错就是 id 撞车/漏改——模块加载即断言,fail fast。
{
  const seen = new Set<string>()
  for (const c of CASES) {
    if (seen.has(c.id)) throw new Error(`[cases] 重复用例 id: ${c.id}`)
    seen.add(c.id)
  }
}

export function filterCases(opts: { only?: Level; ids?: string[]; smoke?: boolean; limit?: number }): EvalCase[] {
  let list = CASES
  if (opts.only) list = list.filter(c => c.level === opts.only)
  if (opts.ids && opts.ids.length) list = list.filter(c => opts.ids!.includes(c.id))
  if (opts.smoke) list = list.slice(0, 1)
  // 小样本抽查:跑满全量要 ~1 小时 + 大量 token,日常验证用 --limit=n 取前 n 条。
  if (opts.limit) list = list.slice(0, opts.limit)
  return list
}

export const LEVELS: Level[] = ['L1', 'L2', 'L3', 'L4']
