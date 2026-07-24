/**
 * Provider 注册表 + 统一装配。
 *
 * 新增一路上下文的全部动作:providers/ 下建一个文件,在 PR_CONTEXT_PROVIDERS
 * 里加一行。加载(并行/超时/降级)、渲染顺序、工具聚合、结果观测都在这里统一处理,
 * chat.ts 与 prompt 模板不再随数据源增减而改。
 */
import type { PrModelToolSpec } from '../model'

import { activitiesProvider } from './activities'
import { environmentProvider } from './environment'
import { healthProvider } from './health'
import { knowledgeProvider } from './knowledge'
import { memoryProvider } from './memory'
import { profileProvider } from './profile'
import { raceGoalsProvider } from './race-goals'
import type { ChatContextInput, ContextBlock, ContextProvider } from './types'

export const PR_CONTEXT_PROVIDERS: ContextProvider[] = [
  memoryProvider,
  profileProvider,
  knowledgeProvider,
  healthProvider,
  activitiesProvider,
  raceGoalsProvider,
  environmentProvider,
]

/** 单个 provider 的装配结果观测(写进 build_context 快照,接管原 discardedContext 语义)。 */
export interface ProviderOutcome {
  key: string
  ok: boolean
  ms: number
  /** 失败/超时原因;成功时缺省。 */
  discarded?: string
}

const PROVIDER_TIMEOUT_MS = 5000

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超时(${ms}ms)`)), ms)
    promise.then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      error => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/**
 * 并行装配所有相关 provider;任一失败/超时只丢弃自己的区块并记录 outcome,
 * 不影响其他区块(沿用原来每路 `.catch(() => [])` 的独立降级语义,但统一收口)。
 */
export async function loadContextBlocks(
  input: ChatContextInput,
): Promise<{ blocks: ContextBlock[]; outcomes: ProviderOutcome[] }> {
  const active = PR_CONTEXT_PROVIDERS.filter(provider => provider.relevant?.(input) ?? true)
  const settled = await Promise.all(
    active.map(async provider => {
      const started = Date.now()
      try {
        const block = await withTimeout(provider.load(input), PROVIDER_TIMEOUT_MS, provider.key)
        return { provider, block, ms: Date.now() - started, error: null as string | null }
      } catch (error) {
        return { provider, block: null, ms: Date.now() - started, error: (error as Error).message }
      }
    }),
  )

  const blocks = settled
    .filter(item => item.block !== null)
    .sort((a, b) => a.provider.priority - b.provider.priority)
    .map(item => item.block as ContextBlock)
  const outcomes: ProviderOutcome[] = settled.map(item => ({
    key: item.provider.key,
    ok: item.block !== null,
    ms: item.ms,
    ...(item.error ? { discarded: item.error } : {}),
  }))
  return { blocks, outcomes }
}

/** 所有 provider 自带工具的聚合清单(给模型)。 */
export function providerTools(): PrModelToolSpec[] {
  return PR_CONTEXT_PROVIDERS.flatMap(provider => provider.tools ?? [])
}

/** 按工具名路由到所属 provider 执行;未知工具返回错误 JSON(让模型能继续)。 */
export async function executeProviderTool(name: string, input: unknown): Promise<string> {
  for (const provider of PR_CONTEXT_PROVIDERS) {
    if (provider.executeTool && provider.tools?.some(tool => tool.name === name)) {
      return provider.executeTool(name, input)
    }
  }
  return JSON.stringify({ error: `未知工具:${name}` })
}
