/**
 * 通知渠道抽象(P4a)。
 *
 * Reason: 源仓 dispatcher 把 pushplus 硬编在派发循环里(China-only)。抽离后按 design §4 拆成
 * NotificationChannel 接口 —— pushplus 只是其中一个可选实现(gated on PUSHPLUS_TOKEN),
 * 缺省无渠道时优雅跳过。派发器只依赖接口,不认识具体渠道。
 */

/** 一条待发送的通知(与具体渠道无关)。link 由派发器注入(H5 对话入口),渠道负责渲染。 */
export interface NotificationMessage {
  title: string
  content: string
  link?: string
}

/** 渠道发送结果。ok=false 时 error 用于落库 last_error;providerMessageId 可选(用于回执追踪)。 */
export interface NotificationSendResult {
  ok: boolean
  providerMessageId?: string
  error?: string
}

/** 通知渠道:name 用于与 notification_deliveries.channel 列匹配(如 'pushplus')。 */
export interface NotificationChannel {
  readonly name: string
  send(msg: NotificationMessage): Promise<NotificationSendResult>
}
