/**
 * Span 辅助层(OpenInference 语义约定,Phoenix 按这些属性渲染 AGENT/LLM/TOOL 视图与会话)。
 *
 * 用法:业务代码只调 withSpan(...),不关心 tracing 是否开启——未注册 provider 时
 * @opentelemetry/api 返回 no-op tracer,直通执行。
 */
import { SpanStatusCode, trace, type Span } from '@opentelemetry/api'

/** OpenInference 属性名(Phoenix 识别的语义约定)。 */
export const OI = {
  SPAN_KIND: 'openinference.span.kind',
  INPUT: 'input.value',
  OUTPUT: 'output.value',
  /** 同一会话的 trace 在 Phoenix Sessions 视图聚合(我们填 threadId)。 */
  SESSION_ID: 'session.id',
  LLM_MODEL: 'llm.model_name',
  LLM_TOKENS_PROMPT: 'llm.token_count.prompt',
  LLM_TOKENS_COMPLETION: 'llm.token_count.completion',
  LLM_TOKENS_CACHE_READ: 'llm.token_count.prompt_details.cache_read',
  TOOL_NAME: 'tool.name',
} as const

export type OISpanKind = 'AGENT' | 'CHAIN' | 'LLM' | 'TOOL' | 'EVALUATOR' | 'RETRIEVER'

// otel 初始化成功后置 true;调用方据此跳过仅用于 trace 的预览计算,让"未开启"真的零额外开销。
let tracingEnabled = false
export function setTracingEnabled() {
  tracingEnabled = true
}
export function isTracingEnabled() {
  return tracingEnabled
}

const tracer = trace.getTracer('pr-agent')

/** 截断长值:trace 里放预览,不放大对象全文(图片 base64 绝不入 trace)。 */
export function clip(value: unknown, max = 4000): string {
  let text: string
  if (typeof value === 'string') text = value
  else {
    try {
      text = JSON.stringify(value)
    } catch {
      text = String(value)
    }
  }
  if (!text) return ''
  return text.length > max ? `${text.slice(0, max)}…(截断)` : text
}

/** 包一段逻辑为 active span(子 span 自动挂到它下面);异常记录后原样抛出。 */
export async function withSpan<T>(
  name: string,
  kind: OISpanKind,
  attributes: Record<string, string | number | boolean | undefined>,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, async span => {
    span.setAttribute(OI.SPAN_KIND, kind)
    for (const [key, value] of Object.entries(attributes)) {
      if (value !== undefined) span.setAttribute(key, value)
    }
    try {
      const result = await fn(span)
      span.setStatus({ code: SpanStatusCode.OK })
      return result
    } catch (error) {
      span.recordException(error as Error)
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message })
      throw error
    } finally {
      span.end()
    }
  })
}
