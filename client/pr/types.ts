/** PR H5 对话页共享类型。 */

/**
 * 一条对话消息。
 * id 是稳定标识:服务端消息用服务端 id,本地新消息用 newId();
 * 列表 key、思考展开、流式打补丁、失败重试全部按 id 定位(不再依赖数组下标)。
 */
export interface Msg {
  id: string
  role: 'user' | 'assistant'
  content: string
  imageUrl?: string | null
  /** 模型思考过程(流式收集);流式期间实时显示,出正文后收起成「已思考 Ns」胶囊 */
  thinking?: string
  thinkingSeconds?: number
  thinkingOpen?: boolean
  /** 该条 assistant 消息仍在流式接收中 */
  streaming?: boolean
  /** 工具调用提示(查数据中…),出正文后清除 */
  toolNote?: string | null
  /** 用户消息发送状态;failed 时气泡标红并给「重试」 */
  status?: 'sending' | 'sent' | 'failed'
  /** assistant 侧错误提示(服务端 4xx/5xx、流中断),用错误样式渲染 */
  error?: boolean
}

export interface Thread {
  id: string
  title: string
  summary: string | null
  lastMessageAt: string | null
}

/** 历史消息加载三态:骨架 / 失败可重试 / 就绪(只有就绪且为空才显示欢迎语) */
export type HistoryState = 'loading' | 'error' | 'ready'

/** /api/pr/chat SSE 各事件的 data 载荷(按事件类型取用其中一部分) */
export interface StreamPayload {
  delta?: string
  name?: string
  message?: string
  threadId?: string
  answer?: string
}

/** GET /api/pr/chat 返回的消息行 */
export interface ServerMsg {
  id?: string
  role: string
  content: string
  imageUrl?: string | null
}
