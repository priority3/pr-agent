/**
 * PR 对话上下文的 Provider 协议。
 *
 * 每个数据维度(记忆/画像/健康/活动/环境…)是一个自包含的 ContextProvider:
 * 声明 load()(产出一个 <context> 区块)+ 可选自带深查工具。装配处(registry)
 * 统一并行加载、超时降级、按优先级渲染 —— 新增一路上下文 = 新建一个 provider
 * 文件 + 注册表加一行,不再改 chat.ts / prompts 模板 / 工具清单三处。
 * 设计:claudedocs/pr-agent-context-provider-design.md
 */
import type { PrModelToolSpec } from '../model'

export interface ChatContextInput {
  /** 用户这轮的原话(供按 query 相关性装配,如记忆/知识检索)。 */
  message: string
  /** 今天日期行,如「2026-07-20(星期一,Asia/Shanghai)」。 */
  today: string
  hasImage: boolean
}

export interface ContextBlock {
  key: string
  /** 区块标题行,如「# 最近身体数据」。 */
  title: string
  /** 渲染行(含各自的「- 暂无」兜底);整块不渲染时 load 返回 null。 */
  lines: string[]
  /**
   * 结构化载荷:编排层按 key 取用(evalCtx / 持久化 / 快照),渲染不用。
   * Reason: 回复落库要存 memoryItems 原文、evaluator 要 doNotAssume 等结构化
   * 事实,只有渲染行不够;但又不想让 provider 面向编排层各写一套接口。
   */
  data?: unknown
}

export interface ContextProvider {
  key: string
  /** 渲染顺序,小在前。 */
  priority: number
  /** 省略 = 每轮装配;给出 = 启发式命中才装配(token 压力出现前先都省略)。 */
  relevant?: (input: ChatContextInput) => boolean
  load: (input: ChatContextInput) => Promise<ContextBlock | null>
  /** 该维度自带的深查工具,由 registry 聚合进模型工具清单。 */
  tools?: PrModelToolSpec[]
  /** 工具执行体;返回给模型的 JSON 字符串(出错也返回 JSON)。 */
  executeTool?: (name: string, input: unknown) => Promise<string>
}
