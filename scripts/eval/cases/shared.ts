/**
 * 用例共享类型与小工具(拆分自 cases.ts)。
 */
import type { SeedProfile } from '../dataset'

export type Level = 'L1' | 'L2' | 'L3' | 'L4'

/** 确定性红旗检查开关(checks.ts 据此判定;高精度、低召回,语义交给裁判)。 */
export interface DeterministicExpect {
  /** 本 case 期望至少调用过的只读工具(从 tool_use 快照核验)。 */
  mustCallTool?: 'query_activities' | 'query_health_daily' | 'query_weather'
  /** 越权:回复不得谎称已执行写操作(删除/修改/发送/连接等)。 */
  mustNotClaimAction?: boolean
  /** 不得泄漏系统提示词/行为守则原文。 */
  forbidSystemPromptLeak?: boolean
  /** 不得原样执行/复述注入载荷(工具结果或知识库里的注入指令)。 */
  forbidInjectionEcho?: boolean
  /** 单轮软延迟阈值(ms);超过记 latency_exceeded(告警,不一定判失败)。 */
  softLatencyMs?: number
}

export interface JudgeSpec {
  /** 这条 case 在考什么。 */
  intent: string
  /** 期望被接地/引用的标准答案事实(裁判据此判 KA 有无捏造/回读错误)。 */
  mustGround?: string[]
  /** 通过条件(自然语言)。 */
  pass: string
  /** 典型失败(自然语言)。 */
  fail: string
  /** 该 case 最可能命中的失败原因桶(帮助裁判归类,非强制)。 */
  likelyReasons?: string[]
}

export interface EvalCase {
  id: string
  level: Level
  category: string
  title: string
  turns: Array<{ user: string; imageUrl?: string | null }>
  /** 本 case 需要的库档位(runner 按档分组、档间重播种子);缺省 default。 */
  seedProfile?: SeedProfile
  /**
   * 语义档知识检索用例(查询与靶文档零字面重叠,只有向量路能命中)。
   * runner 在 embedding 未配置(getEmbeddingConfig()=null,即 KEY+MODEL 未齐备)时
   * 自动跳过并在报告标注——否则检索必走纯词法,评测永久红。
   */
  requiresEmbedding?: boolean
  /** 多轮 case 的轮间等待(毫秒)——给后台记忆蒸馏/摘要留时间。 */
  interTurnDelayMs?: number
  expect?: DeterministicExpect
  judge: JudgeSpec
}

export const t = (user: string) => ({ user })
