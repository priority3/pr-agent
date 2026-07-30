import { useEffect, useRef, useState } from 'react'

import { copyText } from './helpers'
import { CheckIcon, CopyIcon, PrAvatar, Spinner } from './icons'
import type { HistoryState, Msg } from './types'

interface Props {
  messages: Msg[]
  historyState: HistoryState
  sending: boolean
  /** 整屏载入的历史条数:小于它的消息错峰入场,之后追加的立即入场 */
  staggerCount: number
  threadKey: string
  /**
   * 历史里最后一条是自己发的、还没有回复:waiting = 正在定时补拉,timeout = 补拉次数用完。
   * 刻意不复用三点 loading / streaming 外观——那会假装「正在打字」,而这里只是在等服务端。
   */
  replyWait: 'waiting' | 'timeout' | null
  imgSrc: (url: string) => string
  onToggleThinking: (id: string) => void
  onRetry: (id: string) => void
  onReloadHistory: () => void
}

/** 消息区内容:三态(骨架 / 加载失败 / 就绪)+ 气泡列表 + 等待中的三点。 */
export default function MessageList(props: Props) {
  const { messages, historyState, sending, staggerCount, threadKey, imgSrc } = props
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (copyTimer.current) clearTimeout(copyTimer.current)
  }, [])

  async function onCopy(m: Msg) {
    const ok = await copyText(m.content)
    if (!ok) return
    if (copyTimer.current) clearTimeout(copyTimer.current)
    setCopiedId(m.id)
    copyTimer.current = setTimeout(() => setCopiedId(null), 1500)
  }

  if (historyState === 'loading') return <HistorySkeleton />
  if (historyState === 'error') return <HistoryError onRetry={props.onReloadHistory} />

  return (
    <>
      {messages.length === 0 && !sending && <Welcome />}

      <div key={threadKey} className="pr-thread-in flex flex-col gap-2.5">
        {messages.map((m, i) => {
          const delay = i < staggerCount ? `${Math.min(i * 36, 288)}ms` : '0ms'
          if (m.role === 'user') {
            const failed = m.status === 'failed'
            return (
              <div key={m.id} className="pr-msg flex flex-col items-end" style={{ animationDelay: delay }}>
                <div
                  className="max-w-[80%] overflow-hidden"
                  style={{
                    background: 'var(--pr-user-bg)',
                    color: 'var(--pr-user-text)',
                    borderRadius: '18px 18px 6px 18px',
                    border: failed ? '1px solid var(--pr-danger)' : undefined,
                    opacity: failed ? 0.75 : 1,
                  }}
                >
                  {m.imageUrl && <img src={imgSrc(m.imageUrl)} alt="图片" className="block max-h-72 w-full object-cover" />}
                  {m.content && m.content !== '[图片]' && (
                    <div className="whitespace-pre-wrap break-words px-3.5 py-2.5 text-[15px] leading-relaxed">{m.content}</div>
                  )}
                </div>
                {failed && (
                  <div className="mt-1 flex items-center gap-2 text-[11px]" style={{ color: 'var(--pr-danger)' }}>
                    <span>发送失败</span>
                    <button
                      type="button"
                      onClick={() => props.onRetry(m.id)}
                      className="pr-tap rounded-full px-2 py-0.5"
                      style={{ border: '1px solid var(--pr-danger)' }}
                    >
                      重试
                    </button>
                  </div>
                )}
              </div>
            )
          }

          // 连续的 PR 消息只在第一条带头像(iMessage 式分组),后续用占位对齐
          const firstOfGroup = i === 0 || messages[i - 1].role === 'user'
          // 思考展示:流式且正文未开始 → 实时暗色滚动;否则收起成「已思考 Ns」胶囊(点击展开)
          const thinkingLive = Boolean(m.streaming && m.thinking && !m.content)
          const copyable = !m.streaming && !m.error && m.content.length > 0 && m.content !== '[图片]'
          // Reason: 气泡里所有内容都是条件渲染,一条「流已结束但正文/思考/图片全空」的消息
          // 会渲染成零高度的空 div —— 生产实测过这种静默失败(服务端答了并落库、界面什么都没有,
          // 也没有 loading 和重试)。这里把它显性化,并给一键重拉历史。
          const blank = !m.streaming && !m.content && !m.thinking && !m.imageUrl
          return (
            <div key={m.id} className="pr-msg flex items-end gap-2" style={{ animationDelay: delay }}>
              {firstOfGroup ? <PrAvatar /> : <div className="w-7 shrink-0" />}
              <div
                className="max-w-[80%] overflow-hidden"
                style={{
                  background: m.error ? 'var(--pr-danger-bg)' : 'var(--pr-ai-bg)',
                  color: m.error ? 'var(--pr-danger)' : 'var(--pr-ai-text)',
                  borderRadius: '18px 18px 18px 6px',
                }}
              >
                {m.imageUrl && <img src={imgSrc(m.imageUrl)} alt="图片" className="block max-h-72 w-full object-cover" />}
                {thinkingLive && (
                  <div className="whitespace-pre-wrap break-words px-3.5 py-2.5 text-[12.5px] leading-relaxed" style={{ color: 'var(--pr-muted)' }}>
                    {m.thinking}
                  </div>
                )}
                {!thinkingLive && m.thinking && (
                  <button
                    type="button"
                    onClick={() => props.onToggleThinking(m.id)}
                    className="pr-tap flex items-center gap-1 px-3.5 pt-2.5 text-[12px]"
                    style={{ color: 'var(--pr-muted)' }}
                  >
                    已思考 {m.thinkingSeconds ?? 1} 秒
                    <span style={{ fontSize: 9 }}>{m.thinkingOpen ? '▲' : '▼'}</span>
                  </button>
                )}
                {!thinkingLive && m.thinking && m.thinkingOpen && (
                  <div className="whitespace-pre-wrap break-words px-3.5 pt-1.5 text-[12.5px] leading-relaxed" style={{ color: 'var(--pr-muted)' }}>
                    {m.thinking}
                  </div>
                )}
                {m.toolNote && m.streaming && (
                  <div className="flex items-center gap-1.5 px-3.5 pt-2 text-[12px]" style={{ color: 'var(--pr-muted)' }}>
                    <Spinner size={12} />
                    {m.toolNote}
                  </div>
                )}
                {m.content && m.content !== '[图片]' && (
                  <div className="whitespace-pre-wrap break-words px-3.5 py-2.5 text-[15px] leading-relaxed">{m.content}</div>
                )}
                {blank && (
                  <div className="flex flex-wrap items-center gap-2 px-3.5 py-2.5 text-[13px]" style={{ color: 'var(--pr-muted)' }}>
                    <span>这条没收到内容</span>
                    <button
                      type="button"
                      onClick={props.onReloadHistory}
                      className="pr-tap rounded-full px-2 py-0.5 text-[12px]"
                      style={{ border: '1px solid var(--pr-line-strong)', color: 'var(--pr-text-2)' }}
                    >
                      重新载入
                    </button>
                  </div>
                )}
              </div>
              {copyable && (
                <button
                  type="button"
                  onClick={() => void onCopy(m)}
                  className="pr-tap pr-copy mb-1 shrink-0 p-1"
                  aria-label={copiedId === m.id ? '已复制' : '复制回复'}
                >
                  {copiedId === m.id ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
                </button>
              )}
            </div>
          )
        })}

        {/* 等回复(不是本次发送,而是历史里那条还没被回答的消息):轻提示 + 兜底重载 */}
        {!sending && props.replyWait && <ReplyWait state={props.replyWait} onReload={props.onReloadHistory} />}

        {/* 三点 loading 只显示到首个流式事件到达(之后由思考/正文接管) */}
        {sending && !(messages[messages.length - 1]?.role === 'assistant' && messages[messages.length - 1]?.streaming) && (
          <div className="pr-msg flex items-end gap-2">
            <PrAvatar />
            <div className="flex items-center gap-1.5 px-4 py-3.5" style={{ background: 'var(--pr-ai-bg)', borderRadius: '18px 18px 18px 6px' }}>
              <span className="pr-dot" /><span className="pr-dot" /><span className="pr-dot" />
            </div>
          </div>
        )}
      </div>
    </>
  )
}

/**
 * 「你的消息还没有回复」提示。一次带工具调用的回复实测要 30 秒以上,期间离开会话
 * 再回来时历史里就只有自己那条,所以这里明说在等、并在补拉用尽后给手动重载。
 */
function ReplyWait({ state, onReload }: { state: 'waiting' | 'timeout'; onReload: () => void }) {
  if (state === 'waiting') {
    return (
      <div className="flex items-center gap-2 pl-9 text-[12px]" style={{ color: 'var(--pr-muted)' }} aria-live="polite">
        <span className="pr-dot-solid pr-pulse" style={{ background: 'var(--pr-muted)' }} />
        PR 可能还在想(有时要半分钟以上),回复到了会自动出现
      </div>
    )
  }
  return (
    <div className="flex flex-wrap items-center gap-2 pl-9 text-[12px]" style={{ color: 'var(--pr-muted)' }} aria-live="polite">
      <span>还没等到回复</span>
      <button
        type="button"
        onClick={onReload}
        className="pr-tap rounded-full px-2 py-0.5"
        style={{ border: '1px solid var(--pr-line-strong)', color: 'var(--pr-text-2)' }}
      >
        重新载入
      </button>
    </div>
  )
}

/** 只有「确认为空」才出现的欢迎语(加载中/加载失败时都不能出,否则像会话被清空) */
function Welcome() {
  return (
    <div className="mx-auto mt-20 max-w-xs text-center">
      <div className="pr-breath mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full" style={{ background: '#fff', border: '1px solid var(--pr-line-strong)' }}>
        <img src="/pr-logo.png" alt="" className="h-10 w-10" />
      </div>
      <p className="pr-rise text-[15px] font-medium" style={{ color: 'var(--pr-text)' }}>嗨,我是 PR。</p>
      <p className="pr-rise mt-1 text-sm leading-relaxed" style={{ color: 'var(--pr-text-2)', animationDelay: '90ms' }}>今天感觉怎么样?聊聊训练、睡眠、状态,或者拍张跑鞋、风景给我看看。</p>
    </div>
  )
}

function HistorySkeleton() {
  const rows = [
    { mine: false, w: '66%', h: 64 },
    { mine: true, w: '48%', h: 40 },
    { mine: false, w: '74%', h: 88 },
  ]
  return (
    <div className="flex flex-col gap-2.5" aria-busy="true" aria-label="正在加载历史消息">
      {rows.map((r, i) => (
        <div key={i} className={r.mine ? 'flex justify-end' : 'flex items-end gap-2'}>
          {!r.mine && <div className="pr-skel h-7 w-7 shrink-0 rounded-full" />}
          <div
            className="pr-skel"
            style={{ width: r.w, height: r.h, borderRadius: r.mine ? '18px 18px 6px 18px' : '18px 18px 18px 6px' }}
          />
        </div>
      ))}
    </div>
  )
}

function HistoryError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="mx-auto mt-24 max-w-xs text-center">
      <p className="text-sm" style={{ color: 'var(--pr-text-2)' }}>历史消息加载失败</p>
      <p className="mt-1 text-xs" style={{ color: 'var(--pr-muted)' }}>会话内容还在服务端,只是这次没拉到。</p>
      <button
        type="button"
        onClick={onRetry}
        className="pr-tap mt-3 rounded-full px-4 py-2 text-sm"
        style={{ background: 'var(--pr-sel)', color: 'var(--pr-text)', border: '1px solid var(--pr-line-strong)' }}
      >
        点此重试
      </button>
    </div>
  )
}
