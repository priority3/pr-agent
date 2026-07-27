/**
 * 可选 tracing 引导(评测专用)。
 *
 * 配了 `PHOENIX_COLLECTOR_ENDPOINT` 才注册 OTLP provider,把评测 trace 导到任意
 * OTLP/http-protobuf 收集器(Arize Phoenix、Jaeger、Grafana Tempo…);留空则完全不接,
 * `@opentelemetry/api` 退化为 no-op tracer,业务里的 withSpan 零开销直通。
 *
 * 三个 SDK 包不是本仓依赖(见 README「可选 tracing」),用变量说明符 import:
 * 未安装时只打一行提示继续跑评测,不影响任何判据。
 */
import { setTracingEnabled } from '@/lib/observability/trace'

const PKG_SDK = '@opentelemetry/sdk-trace-node'
const PKG_EXPORTER = '@opentelemetry/exporter-trace-otlp-proto'
const PKG_RESOURCES = '@opentelemetry/resources'

let flushProvider: (() => Promise<void>) | null = null

export async function initEvalTracing(): Promise<void> {
  const endpoint = process.env.PHOENIX_COLLECTOR_ENDPOINT
  if (!endpoint) return

  try {
    const { BatchSpanProcessor, NodeTracerProvider } = await import(PKG_SDK)
    const { OTLPTraceExporter } = await import(PKG_EXPORTER)
    const { resourceFromAttributes } = await import(PKG_RESOURCES)

    const project = process.env.PHOENIX_PROJECT_NAME || 'pr-agent-eval'
    const apiKey = process.env.PHOENIX_API_KEY
    const provider = new NodeTracerProvider({
      resource: resourceFromAttributes({
        'service.name': 'pr-agent-eval',
        // Phoenix 按这个 resource 属性把 trace 归到对应 project(其它收集器忽略即可)
        'openinference.project.name': project,
      }),
      spanProcessors: [
        new BatchSpanProcessor(
          new OTLPTraceExporter({
            url: `${endpoint.replace(/\/$/, '')}/v1/traces`,
            ...(apiKey ? { headers: { authorization: `Bearer ${apiKey}` } } : {}),
          }),
        ),
      ],
    })
    provider.register()
    setTracingEnabled()
    flushProvider = () => provider.forceFlush()
    console.log(`[eval] tracing 已启用 → ${endpoint}(project ${project})`)
  } catch (error) {
    console.warn(
      `[eval] tracing 未启用(缺可选依赖或初始化失败:${(error as Error).message});` +
        `需要时安装:npm i -D ${PKG_SDK} ${PKG_EXPORTER} ${PKG_RESOURCES}`,
    )
  }
}

/** 短生命周期进程退出前主动 flush,否则 Batch 缓冲里的尾部 span 会丢。 */
export async function flushEvalTracing(): Promise<void> {
  if (!flushProvider) return
  try {
    await flushProvider()
  } catch (error) {
    console.warn('[eval] tracing flush 失败:', (error as Error).message)
  }
}
