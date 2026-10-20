/**
 * 一轮对话的隐式上下文(AsyncLocalStorage)。
 *
 * Reason: provider 的工具执行体签名是 `(name, input) => Promise<string>` —— 拿不到本轮属于
 * 哪个会话。而「同步结果落地后回到这个会话里说一声」必须要 threadId。与其给所有 provider 都加
 * 一个 context 参数(每个实现跟着改、又都忽略它),不如把这一轮的标识挂成隐式上下文:谁需要谁取。
 * 单进程单用户,ALS 的开销可忽略。
 *
 * 生命周期:chat.ts 在调用模型前后用 runInChatTurn 包住 —— 工具调用发生在模型循环内部,
 * 一定在这个作用域里。
 */
import { AsyncLocalStorage } from 'node:async_hooks'

export interface ChatTurnContext {
  runId: string
  threadId: string
  /**
   * 本轮是否登记了「结果落地后回来说一声」的观察。
   * 由 sync 工具在 pending 且登记成功时置位,chat.ts 据此在 SSE done 里告诉前端「继续等一会儿」。
   */
  watchRegistered: boolean
}

const storage = new AsyncLocalStorage<ChatTurnContext>()

export function runInChatTurn<T>(context: ChatTurnContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(context, fn)
}

export function getChatTurn(): ChatTurnContext | undefined {
  return storage.getStore()
}

/** 登记成功后置位(见 ChatTurnContext.watchRegistered)。 */
export function markChatTurnWatchRegistered(): void {
  const context = storage.getStore()
  if (context) context.watchRegistered = true
}
