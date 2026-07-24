/**
 * PushPlus 通知渠道(可选实现,gated on PUSHPLUS_TOKEN)。
 *
 * 从源仓 src/lib/notify.ts 移植 sendPushPlus + src/lib/notifications/dispatcher.ts 的
 * buildPushPlusHtml。pushplus.plus 是 China-only 的微信/邮件/短信推送服务,故设为可选:
 * 未配置 PUSHPLUS_TOKEN 时 getPushPlusChannel() 返回 null,派发器优雅跳过。
 *
 * 剥离(design §7):原 buildPushPlusHtml 的回退域 runpaceflow-admin.razet.me 已去除,
 * 改由 NotificationMessage.link(派发器按 PUBLIC_BASE_URL + PR_CHAT_TOKEN 构造)注入。
 */
import type { NotificationChannel, NotificationMessage, NotificationSendResult } from './types'

const PUSHPLUS_API = 'https://www.pushplus.plus/send'

/** 底层 API 调用:向 pushplus 发一条 HTML 模板消息。 */
async function sendPushPlus(
  token: string,
  title: string,
  content: string,
): Promise<{ success: boolean; message?: string }> {
  const res = await fetch(PUSHPLUS_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, title, content, template: 'html' }),
  })

  const data = (await res.json()) as { code?: number; msg?: string }
  if (data.code !== 200) {
    return { success: false, message: data.msg || 'PushPlus API error' }
  }
  return { success: true }
}

/** 把 PR 文本正文 + H5 对话链接组装成 pushplus 的 HTML 正文。 */
function buildPushPlusHtml(content: string, link?: string): string {
  const body = content
    .replace(/\*\*/g, '')
    .replace(/[<>]/g, ch => (ch === '<' ? '&lt;' : '&gt;'))
    .replace(/\r?\n/g, '<br>')
  if (!link) return body
  return `${body}<br><br><a href="${link}" style="display:inline-block;padding:8px 14px;background:#171717;color:#fff;border-radius:8px;text-decoration:none;">💬 打开 PR 对话</a>`
}

/**
 * 返回 pushplus 渠道实例;未配置 PUSHPLUS_TOKEN 时返回 null(派发器据此判定无渠道)。
 */
export function getPushPlusChannel(): NotificationChannel | null {
  const token = process.env.PUSHPLUS_TOKEN
  if (!token) return null

  return {
    name: 'pushplus',
    async send(msg: NotificationMessage): Promise<NotificationSendResult> {
      const html = buildPushPlusHtml(msg.content, msg.link)
      const r = await sendPushPlus(token, msg.title, html)
      return r.success ? { ok: true } : { ok: false, error: r.message || 'PushPlus 发送失败' }
    },
  }
}
