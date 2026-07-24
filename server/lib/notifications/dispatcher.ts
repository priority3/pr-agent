/**
 * 通知派发 —— P3a 占位(stub)。
 *
 * Reason: 真正的派发在 P4 接入(NotificationChannel 接口 + pushplus 可选实现,design §4)。
 * 现阶段仅让 health/daily、pr/reviews/notify 两个路由能编译并运行:派发为 no-op,
 * 返回与原仓相同形状的结果供路由序列化。切勿在此把整套通知栈拖进来。
 */
export interface NotificationDispatchResult {
  claimed: number
  sent: number
  failed: number
  skipped: number
}

export async function dispatchPendingNotifications(
  _limit = 10,
): Promise<NotificationDispatchResult> {
  console.warn('[notify] dispatchPendingNotifications 未接(P4 待接),本次跳过派发')
  return { claimed: 0, sent: 0, failed: 0, skipped: 0 }
}
