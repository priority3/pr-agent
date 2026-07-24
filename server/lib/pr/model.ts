import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'

import { clip, isTracingEnabled, OI, withSpan } from '@/lib/observability/trace'
import { getRuntimeSettings } from '@/lib/config'

/**
 * Shared PR text-generation entry point (Claude / OpenAI-compatible).
 *
 * Reason: several generators (daily reflection, chat, …) need the same model call.
 * The configured third-party gateway requires the 1M-context beta header on
 * /v1/messages (otherwise it returns "请启用 1m 上下文"), which the official SDK does
 * not send by default — so we add it here.
 */
export interface PrModelResult {
  content: string
  model: string
  provider: 'claude' | 'openai-compatible'
}

const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-4-20250514'
const DEFAULT_OPENAI_MODEL = 'gpt-4o'
const ANTHROPIC_BETA = 'context-1m-2025-08-07'

/** 供多模态输入:base64 图片(仅 Claude/Anthropic 路径支持,网关已验证可用)。 */
export interface PrModelImage {
  base64: string
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
}

/**
 * 从模型输出里稳健地取出 JSON 对象(容忍 ```json 围栏或前后杂字)。
 * 解析失败抛错,由调用方决定降级策略(记忆蒸馏跳过本次、会话摘要保持旧标题等)。
 */
export function parseModelJson(text: string): unknown {
  const cleaned = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  const slice = start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned
  return JSON.parse(slice)
}

/** 模型可调用的只读工具(仅 Claude/Anthropic 路径生效)。 */
export interface PrModelToolSpec {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/** 原生多轮消息(参考 Claude Code:历史用真实 turns,不压成文本塞单条 user)。 */
export interface PrModelMessage {
  role: 'user' | 'assistant'
  content: string
}

/** 流式增量事件(仅 Claude/Anthropic 路径生效;OpenAI 兼容路径忽略 onStream)。 */
export type PrStreamEvent =
  | { type: 'thinking'; delta: string }
  | { type: 'text'; delta: string }
  | { type: 'tool'; name: string }
  | { type: 'text_reset' }

export interface PrModelCallOptions {
  maxTokens?: number
  /** 图片附着到最后一条 user 消息(即当前这轮)。 */
  images?: PrModelImage[]
  tools?: PrModelToolSpec[]
  /** 工具执行体;与 tools 同时提供才启用 tool use。 */
  executeTool?: (name: string, input: unknown) => Promise<string>
  /** 最多几轮工具往返(每轮一次 API 调用),默认 3。 */
  maxToolRounds?: number
  /** 每次工具执行后的观察钩子(写快照用),抛错不影响主流程。 */
  onToolCall?: (name: string, input: unknown, result: string) => void
  /**
   * 提供则 Anthropic 请求改为 stream:true,thinking/text 逐 delta 回调;
   * 缺省时行为与从前完全一致(非流式)。工具轮若已流出 text 又转入工具调用,
   * 会先发 text_reset 让客户端清掉半截文本。
   */
  onStream?: (evt: PrStreamEvent) => void
}

/**
 * 发起一次 Anthropic 请求:无 onStream 时与 client.messages.create 完全等价;
 * 有 onStream 时改为 stream:true,边转发 delta 边手工累积重建出同形的
 * Anthropic.Message —— 这样工具循环/降级链/空响应重试等下游逻辑零改动。
 * Reason: 不用 SDK 的 .stream() helper,保持 create 的 timeout/maxRetries 语义
 * (SDK 只在收到首字节前重试,不会产生重复 delta)。
 */
async function createMessageMaybeStream(
  client: Anthropic,
  params: Anthropic.MessageCreateParamsNonStreaming,
  onStream?: (evt: PrStreamEvent) => void,
): Promise<Anthropic.Message> {
  if (!onStream) return client.messages.create(params)

  const stream = await client.messages.create({ ...params, stream: true })
  let message: Anthropic.Message | null = null
  const blocks: Anthropic.ContentBlock[] = []
  const partialJson: string[] = [] // tool_use 的 input 以 JSON 碎片流入,block_stop 时整体 parse

  for await (const event of stream) {
    switch (event.type) {
      case 'message_start':
        message = { ...event.message, content: [] }
        break
      case 'content_block_start': {
        const block = event.content_block as Anthropic.ContentBlock
        blocks[event.index] = { ...block }
        partialJson[event.index] = ''
        if (block.type === 'tool_use') onStream({ type: 'tool', name: block.name })
        break
      }
      case 'content_block_delta': {
        const block = blocks[event.index]
        const delta = event.delta
        if (delta.type === 'thinking_delta') {
          if (block?.type === 'thinking') block.thinking += delta.thinking
          onStream({ type: 'thinking', delta: delta.thinking })
        } else if (delta.type === 'text_delta') {
          if (block?.type === 'text') block.text += delta.text
          onStream({ type: 'text', delta: delta.text })
        } else if (delta.type === 'input_json_delta') {
          partialJson[event.index] += delta.partial_json
        } else if (delta.type === 'signature_delta') {
          // thinking 块签名:历史回灌时 API 要求带上,照单累积
          if (block?.type === 'thinking') block.signature = (block.signature || '') + delta.signature
        }
        break
      }
      case 'content_block_stop': {
        const block = blocks[event.index]
        if (block?.type === 'tool_use') {
          try {
            block.input = JSON.parse(partialJson[event.index] || '{}')
          } catch {
            block.input = {}
          }
        }
        break
      }
      case 'message_delta':
        if (message) {
          message.stop_reason = event.delta.stop_reason ?? message.stop_reason
          message.stop_sequence = event.delta.stop_sequence ?? message.stop_sequence
          if (event.usage) {
            // MessageDeltaUsage 字段可空,只合并有值的(Usage 类型不接受 null)
            const usageDelta = event.usage
            message.usage = {
              ...message.usage,
              ...(usageDelta.input_tokens != null && { input_tokens: usageDelta.input_tokens }),
              ...(usageDelta.output_tokens != null && { output_tokens: usageDelta.output_tokens }),
              ...(usageDelta.cache_read_input_tokens != null && { cache_read_input_tokens: usageDelta.cache_read_input_tokens }),
              ...(usageDelta.cache_creation_input_tokens != null && { cache_creation_input_tokens: usageDelta.cache_creation_input_tokens }),
            }
          }
        }
        break
      // message_stop:无事可做,循环自然结束
    }
  }

  if (!message) throw new Error('Stream ended without message_start')
  message.content = blocks.filter(Boolean)
  return message
}

export async function callPrModel(
  system: string,
  input: string | PrModelMessage[],
  opts: PrModelCallOptions = {},
): Promise<PrModelResult> {
  const settings = await getRuntimeSettings({ force: true })
  const maxTokens = opts.maxTokens ?? 2000
  const images = opts.images ?? []
  const turns: PrModelMessage[] = typeof input === 'string' ? [{ role: 'user', content: input }] : input

  if (settings.ANTHROPIC_API_KEY) {
    // Reason: 主力模型不一定支持图片(部分模型遇图直接 404),带图请求切
    // ANTHROPIC_VISION_MODEL;走设置而非写死模型名,后续换模型组合零代码。
    const textModel = settings.PR_REVIEW_MODEL || settings.ANTHROPIC_MODEL || DEFAULT_CLAUDE_MODEL
    const model =
      images.length && settings.ANTHROPIC_VISION_MODEL ? settings.ANTHROPIC_VISION_MODEL : textModel
    const client = new Anthropic({
      apiKey: settings.ANTHROPIC_API_KEY,
      ...(settings.ANTHROPIC_BASE_URL && { baseURL: settings.ANTHROPIC_BASE_URL }),
      defaultHeaders: { 'anthropic-beta': ANTHROPIC_BETA },
      // Reason: 部分第三方网关会偶发挂起(实测单请求吊 296s),SDK 默认 timeout 10 分钟——
      // 请求被吊死时反向代理常在 ~100s 就切断客户端,H5 只看到"网络出错"。
      // 单次请求 60s 封顶(haiku 500 token 正常 <15s),重试交给上层降级链。
      timeout: 60_000,
      maxRetries: 1,
    })

    // 图片附着到最后一条 user 消息(图在前、文本在后),其余轮次纯文本。
    const lastUserIndex = turns.reduce((last, turn, i) => (turn.role === 'user' ? i : last), -1)
    const messages: Anthropic.MessageParam[] = turns.map((turn, i) => {
      if (turn.role === 'user' && i === lastUserIndex && images.length) {
        return {
          role: 'user' as const,
          content: [
            ...images.map(img => ({
              type: 'image' as const,
              source: { type: 'base64' as const, media_type: img.mediaType, data: img.base64 },
            })),
            { type: 'text' as const, text: turn.content },
          ],
        }
      }
      return { role: turn.role, content: turn.content }
    })

    let useTools = Boolean(opts.tools?.length && opts.executeTool)
    let useCache = true
    // 置位后 buildParams 追加 tool_choice:'none',协议层禁止模型再发起 tool_use,逼其产出正文。
    // Reason: 软 error tool_result 只是"请"模型收口,某些网关的模型会把它当工具失败而重试 → 空转到轮次耗尽报错。
    let forceFinalAnswer = false
    const tools: Anthropic.Tool[] | undefined = useTools
      ? opts.tools!.map(tool => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
        }))
      : undefined
    const maxToolRounds = opts.maxToolRounds ?? 3

    // system 挂缓存断点:tools + system 是跨轮/跨会话的稳定前缀,命中后按 0.1 倍计费。
    // Reason: stream:false 必须显式传——部分网关不带该字段默认回 SSE,
    // SDK 会把整个流当字符串返回,content 解析直接崩;官方 API 对显式 false 无感。
    const buildParams = (): Anthropic.MessageCreateParamsNonStreaming => ({
      model,
      max_tokens: maxTokens,
      stream: false,
      system: useCache
        ? [{ type: 'text' as const, text: system, cache_control: { type: 'ephemeral' as const } }]
        : system,
      messages,
      ...(useTools && tools ? { tools } : {}),
      // 轮次耗尽后硬禁工具:tools 仍须保留(历史含 tool_use 时 API 强制要求),改用 tool_choice 关闭调用。
      ...(forceFinalAnswer && useTools ? { tool_choice: { type: 'none' as const } } : {}),
    })

    // Agent 循环:模型要调工具 → 本地执行 → 结果喂回 → 直到产出正式回答。
    // 注意:消息里一旦出现 tool_use 块,后续请求必须继续带 tools 参数,不能删。
    // 所以轮次耗尽时不去掉 tools,而是置 forceFinalAnswer → 用 tool_choice:'none' 硬禁调用逼模型作答
    // (只塞文本 tool_result "请直接回答" 是软约束,某些网关的模型会无视并重试,故改硬约束)。
    // trace 里放消息预览:文本原样、tool_result 摘要、图片等块只留类型标记(base64 绝不入 trace)
    const previewMessage = (message: Anthropic.MessageParam): string =>
      clip(
        typeof message.content === 'string'
          ? message.content
          : message.content
              .map(block =>
                block.type === 'text'
                  ? block.text
                  : block.type === 'tool_result'
                    ? `[tool_result] ${typeof block.content === 'string' ? block.content : ''}`
                    : `[${block.type}]`,
              )
              .join('\n'),
        2000,
      )

    // 仅当疑似"请求参数被拒"(HTTP 400)时才逐级降级:网关不透传 cache_control/tools 就是 400。
    // 429/401/5xx/网络错误降级也没用,反而放大请求量、掩盖真因,应直接抛(SDK 已对瞬时错误自重试)。
    const isBadRequest = (error: unknown) => (error as { status?: number } | null)?.status === 400

    let interimText = '' // 工具轮里模型顺带说的话;空响应兜底时好过整句丢掉
    let emptyRetries = 0
    const MAX_EMPTY_RETRIES = 2 // 容忍网关偶发空响应的突发,但有上限保证终止

    // 流式:跟踪本轮是否已流出 text;转入工具轮/降级重试/空响应重试时,
    // 先发 text_reset 让客户端清掉半截文本,只保留最终轮的正文。
    let textEmittedThisRound = false
    const streamHook: PrModelCallOptions['onStream'] = opts.onStream
      ? evt => {
          if (evt.type === 'text') textEmittedThisRound = true
          opts.onStream!(evt)
        }
      : undefined
    const resetStreamedText = () => {
      if (textEmittedThisRound && opts.onStream) {
        opts.onStream({ type: 'text_reset' })
        textEmittedThisRound = false
      }
    }

    for (let round = 0; round <= maxToolRounds + 1; round++) {
      textEmittedThisRound = false
      const response: Anthropic.Message = await withSpan(
        'llm.claude',
        'LLM',
        {
          [OI.LLM_MODEL]: model,
          'llm.round': round,
          [OI.INPUT]: isTracingEnabled() ? previewMessage(messages[messages.length - 1]) : '',
        },
        async span => {
          let res: Anthropic.Message
          try {
            res = await createMessageMaybeStream(client, buildParams(), streamHook)
          } catch (error) {
            if (round === 0 && useCache && isBadRequest(error)) {
              console.warn('[pr-model] 400,疑似 cache_control 不被支持,去缓存重试:', (error as Error).message)
              useCache = false
              resetStreamedText()
              try {
                res = await createMessageMaybeStream(client, buildParams(), streamHook)
              } catch (retryError) {
                if (!useTools || !isBadRequest(retryError)) throw retryError
                console.warn('[pr-model] 仍 400,疑似 tools 不被支持,去工具重试:', (retryError as Error).message)
                useTools = false
                resetStreamedText()
                res = await createMessageMaybeStream(client, buildParams(), streamHook)
              }
            } else if (round === 0 && useTools && isBadRequest(error)) {
              console.warn('[pr-model] 400,疑似 tools 不被支持,去工具重试:', (error as Error).message)
              useTools = false
              resetStreamedText()
              res = await createMessageMaybeStream(client, buildParams(), streamHook)
            } else {
              throw error
            }
          }
          const usage = res.usage as
            | { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number | null }
            | undefined
          if (usage?.input_tokens != null) span.setAttribute(OI.LLM_TOKENS_PROMPT, usage.input_tokens)
          if (usage?.output_tokens != null) span.setAttribute(OI.LLM_TOKENS_COMPLETION, usage.output_tokens)
          if (usage?.cache_read_input_tokens != null) span.setAttribute(OI.LLM_TOKENS_CACHE_READ, usage.cache_read_input_tokens)
          span.setAttribute('llm.stop_reason', res.stop_reason ?? '')
          if (span.isRecording()) {
            span.setAttribute(
              OI.OUTPUT,
              clip(
                res.content
                  .map(block => (block.type === 'text' ? block.text : `[${block.type}${block.type === 'tool_use' ? `:${block.name}` : ''}]`))
                  .join('\n'),
                2000,
              ),
            )
          }
          return res
        },
      )

      // 有 tool_use 块就按工具轮处理(不依赖 stop_reason——网关偶见 stop_reason 失真)
      const toolUseBlocks = useTools
        ? response.content.filter(block => block.type === 'tool_use')
        : []
      const textBlock = response.content.find(block => block.type === 'text')

      if (toolUseBlocks.length > 0) {
        if (textBlock && textBlock.type === 'text' && textBlock.text.trim()) interimText = textBlock.text.trim()
        resetStreamedText() // 本轮流出的 text 只是工具前的过场白,客户端清掉等最终轮
        messages.push({ role: 'assistant', content: response.content })
        const exhausted = round >= maxToolRounds
        if (exhausted) forceFinalAnswer = true // 下一轮 tool_choice:'none' 硬禁工具,逼出正文
        const results: Anthropic.ToolResultBlockParam[] = []
        for (const block of toolUseBlocks) {
          let result: string
          if (exhausted) {
            // 用正常文本而非 error:某些网关的模型会把 error 当"工具失败"而重试;下一轮已 tool_choice:'none' 兜底。
            result = '已获取足够信息,请立即基于以上结果用最终结论直接回答用户,不要再调用任何工具。'
          } else {
            try {
              result = await withSpan(
                `tool.${block.name}`,
                'TOOL',
                { [OI.TOOL_NAME]: block.name, [OI.INPUT]: isTracingEnabled() ? clip(block.input, 1000) : '' },
                async span => {
                  const output = await opts.executeTool!(block.name, block.input)
                  if (span.isRecording()) span.setAttribute(OI.OUTPUT, clip(output, 2000))
                  return output
                },
              )
            } catch (error) {
              result = JSON.stringify({ error: (error as Error).message })
            }
            try {
              opts.onToolCall?.(block.name, block.input, result)
            } catch {
              /* 观察钩子不影响主流程 */
            }
          }
          results.push({ type: 'tool_result', tool_use_id: block.id, content: result })
        }
        messages.push({ role: 'user', content: results })
        continue
      }

      if (textBlock && textBlock.type === 'text' && textBlock.text.trim()) {
        return { content: textBlock.text, model, provider: 'claude' }
      }

      // 空响应(既无文本也无工具块,网关/模型偶发抽风):重试(累计上限内,round-- 不占工具轮);
      // 超限用工具轮攒的文本兜底,再没有才抛。
      if (emptyRetries < MAX_EMPTY_RETRIES) {
        emptyRetries++
        round--
        resetStreamedText() // 万一空响应前流出过空白 delta,一并清掉
        console.warn('[pr-model] 空响应,重试 (%d/%d, stop=%s)', emptyRetries, MAX_EMPTY_RETRIES, response.stop_reason)
        continue
      }
      if (interimText) return { content: interimText, model, provider: 'claude' }
      throw new Error(
        `No text content in Claude response (stop=${response.stop_reason}, blocks=[${response.content.map(block => block.type).join(',')}])`,
      )
    }
    // 工具轮用尽仍没拿到正式回答:优先返回途中攒的文本(镜像空响应兜底)。
    if (interimText) return { content: interimText, model, provider: 'claude' }
    // 兜底:tool_choice:'none' 正常已能逼出正文;真走到这说明模型连硬约束都无视且全程无文本。
    // 与其抛错让前端显示"网络出错",不如回一句可读文案,保证 PR 对话永不因此报错。
    console.warn('[pr-model] 工具轮用尽且无任何正文,返回兜底文案 (model=%s)', model)
    return { content: '抱歉,我这次没能得出结论,请再问我一次或换个说法。', model, provider: 'claude' }
  }

  // OpenAI 兼容路径:多轮 turns 一一映射;不支持 tools/图片/缓存(网关实际走 Anthropic)。
  if (settings.OPENAI_API_KEY) {
    const model = settings.PR_REVIEW_MODEL || settings.OPENAI_MODEL || DEFAULT_OPENAI_MODEL
    const client = new OpenAI({
      apiKey: settings.OPENAI_API_KEY,
      ...(settings.OPENAI_BASE_URL && { baseURL: settings.OPENAI_BASE_URL }),
    })
    if (settings.OPENAI_API_FORMAT === 'responses') {
      // Responses 的多轮 input 类型要求完整 ResponseOutputMessage;该路径不承载对话,多轮时降级为转写文本
      const transcript =
        turns.length === 1
          ? turns[0].content
          : turns.map(turn => `[${turn.role}] ${turn.content}`).join('\n\n')
      const response = await client.responses.create({
        model,
        instructions: system,
        input: [{ role: 'user', content: [{ type: 'input_text', text: transcript }] }],
        store: false,
      })
      const message = response.output.find(item => item.type === 'message')
      const text = message?.content.find(item => item.type === 'output_text')
      if (!text || text.type !== 'output_text') throw new Error('No text content in Responses API output')
      return { content: text.text, model: response.model || model, provider: 'openai-compatible' }
    }
    const response = await client.chat.completions.create({
      model,
      max_tokens: maxTokens,
      stream: false, // Reason: 同 Anthropic 路径,防网关默认回 SSE
      messages: [
        { role: 'system', content: system },
        ...turns.map(turn => ({ role: turn.role, content: turn.content })),
      ],
    })
    const content = response.choices[0]?.message?.content
    if (!content) throw new Error('No content in Chat Completions response')
    return { content, model: response.model || model, provider: 'openai-compatible' }
  }

  throw new Error('未配置任何 AI 服务（ANTHROPIC_API_KEY / OPENAI_API_KEY）')
}
