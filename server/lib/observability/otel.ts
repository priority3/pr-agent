/**
 * 服务进程 tracing 引导(长驻进程版)。
 *
 * 配了 `PHOENIX_COLLECTOR_ENDPOINT` 才注册 OTLP provider,把**生产对话**的 trace 导到任意
 * OTLP/http-protobuf 收集器(Arize Phoenix、Jaeger、Grafana Tempo…);留空则完全不接,
 * `@opentelemetry/api` 退化为 no-op tracer,业务里的 withSpan 零开销直通。
 *
 * 与 `scripts/eval/otel.ts`(评测专用)的区别只有两点:默认 project 名不同(生产
 * `running-companion` vs 评测 `pr-agent-eval`,避免评测 trace 混进生产项目),以及这里
 * 是长驻进程 —— 要挂退出信号兜住最后一次 flush,否则 Batch 缓冲里的尾部 span 会丢。
 *
 * 三个 SDK 包是可选依赖:未安装时只打一行提示继续跑,不影响任何业务路径。
 */
import { setTracingEnabled } from './trace'

const PKG_SDK = '@opentelemetry/sdk-trace-node'
const PKG_EXPORTER = '@opentelemetry/exporter-trace-otlp-proto'
const PKG_RESOURCES = '@opentelemetry/resources'

let flushProvider: (() => Promise<void>) | null = null

/** 服务启动时调用一次;必须在任何请求进来之前。 */
export async function initTracing(): Promise<void> {
  const endpoint = process.env.PHOENIX_COLLECTOR_ENDPOINT
  if (!endpoint) return

  try {
    const { BatchSpanProcessor, NodeTracerProvider } = await import(PKG_SDK)
    const { OTLPTraceExporter } = await import(PKG_EXPORTER)
    const { resourceFromAttributes } = await import(PKG_RESOURCES)

    const project = process.env.PHOENIX_PROJECT_NAME || 'running-companion'
    const apiKey = process.env.PHOENIX_API_KEY
    const provider = new NodeTracerProvider({
      resource: resourceFromAttributes({
        'service.name': 'pr-agent',
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

    // Reason: 容器停止(SIGTERM)时 Batch 缓冲区里还有没导出的一批 span,不 flush 就丢了 ——
    // 丢的又偏偏是「进程生命周期末尾」那些最需要看的对话。
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      process.once(signal, () => {
        void provider
          .forceFlush()
          .catch(() => {})
          .finally(() => process.exit(0))
      })
    }

    console.log(`[tracing] 已启用 → ${endpoint}(project ${project})`)
  } catch (error) {
    console.warn(
      `[tracing] 未启用(缺可选依赖或初始化失败:${(error as Error).message});` +
        `需要时安装:npm i ${PKG_SDK} ${PKG_EXPORTER} ${PKG_RESOURCES}`,
    )
  }
}

/** 主动 flush(优雅关闭 / 单测收尾用);未启用 tracing 时是空操作。 */
export async function flushTracing(): Promise<void> {
  if (!flushProvider) return
  try {
    await flushProvider()
  } catch (error) {
    console.warn('[tracing] flush 失败:', (error as Error).message)
  }
}
