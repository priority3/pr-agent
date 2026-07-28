/**
 * 极简 SSE 帧解析(纯逻辑,无 React/闭包依赖):按 \n\n 分帧,残包跨 chunk 缓冲,
 * 心跳注释行(`: ka`)与不可解析的 data 直接跳过。
 * 调用方只负责语义分发,不再关心分帧细节。
 */

export interface SseFrame<T> {
  event: string
  data: T
}

/** 用 Response['body'] 推导字节流类型,避开 DOM / @types/node 两套 ReadableStream 定义打架 */
type ByteStream = NonNullable<Response['body']>

export async function* parseSSE<T = unknown>(body: ByteStream): AsyncGenerator<SseFrame<T>> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let sep: number
      while ((sep = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, sep)
        buf = buf.slice(sep + 2)
        const parsed = parseFrame<T>(frame)
        if (parsed) yield parsed
      }
    }
  } finally {
    // 消费方提前 break(切会话/中断)时也要放锁,否则底层流无法被 abort 回收
    try {
      reader.releaseLock()
    } catch {
      /* 已释放 */
    }
  }
}

function parseFrame<T>(frame: string): SseFrame<T> | null {
  if (!frame || frame.startsWith(':')) return null
  let event = 'message'
  let data = ''
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) data += line.slice(5).trim()
  }
  if (!data) return { event, data: {} as T }
  try {
    return { event, data: JSON.parse(data) as T }
  } catch {
    return null
  }
}
