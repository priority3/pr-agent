import { useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react'

import { newId } from './helpers'
import type { HistoryState, Msg, ServerMsg } from './types'

/**
 * 「最后一条是自己发的、还没有回复」时的补拉节奏(相对上一次,累计约 76 秒)。
 *
 * Reason: 生产实测过一条带 4 次工具调用的回复,用户发出后 33 秒才落库;而客户端这一头
 * 可能早就断了(切会话 abort、网关 502)。服务端不会因此停下,照样算完写库,可客户端
 * 没有任何机制把它取回来——载入历史只在 threadId 变化时跑一次,于是那条回复永远不会
 * 出现在界面上,看起来就是「消息被吞了」。补拉就是那个缺失的机制。
 * 常量写死在代码里(不加配置项);拉到 assistant 回复即停。
 */
const REPLY_POLL_DELAYS = [3_000, 8_000, 20_000, 45_000]

interface Deps {
  authHeader: () => HeadersInit
  /** 会话代号:切会话/新对话/删会话都 +1;异步回包写状态前校验,防止写进新会话 */
  genRef: RefObject<number>
  /** 发送中:此时补拉不能替换列表,否则会把正在流式写的气泡冲掉 */
  sendingRef: RefObject<boolean>
  setAuthError: (value: boolean) => void
  /** 用户可见的载入完成 → 把视图拉回底部 */
  onLoaded: () => void
}

export interface ThreadHistory {
  messages: Msg[]
  setMessages: Dispatch<SetStateAction<Msg[]>>
  historyState: HistoryState
  setHistoryState: Dispatch<SetStateAction<HistoryState>>
  /** 历史里那条还没被回答的消息:waiting = 定时补拉中,timeout = 补拉用尽(给手动重载) */
  replyWait: 'waiting' | 'timeout' | null
  /** 整屏载入的历史条数(气泡入场错峰用) */
  staggerCount: number
  loadMessages: (id: string, opts?: { silent?: boolean; attempt?: number }) => Promise<void>
  /** 停掉补拉并清掉等待提示(切会话/新对话/发新消息/卸载都要调) */
  stopReplyWait: () => void
  /** 新对话 / 删掉最后一个会话:清空本地列表 */
  clearMessages: () => void
}

/**
 * 会话历史:载入、空态三态、以及「等回复」的有限次后台补拉。
 * 从 PrChat 拆出来的一块自洽状态(列表 + 载入态 + 等待态 + 补拉 timer)。
 */
export function useThreadHistory(deps: Deps): ThreadHistory {
  const [messages, setMessages] = useState<Msg[]>([])
  const [historyState, setHistoryState] = useState<HistoryState>('loading')
  const [replyWait, setReplyWait] = useState<'waiting' | 'timeout' | null>(null)
  // 入场错峰只在整屏载入时生效;之后追加的新消息立即入场(否则每次发送都要等 delay)
  const staggerCountRef = useRef(0)
  // messages 的镜像:补拉回来时要判断「服务端这条回复本地有没有」,异步闭包里的 state 是旧的
  const messagesRef = useRef<Msg[]>([])
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  useEffect(() => () => {
    if (pollTimer.current) clearTimeout(pollTimer.current)
  }, [])

  function clearPoll() {
    if (pollTimer.current) clearTimeout(pollTimer.current)
    pollTimer.current = null
  }

  function stopReplyWait() {
    clearPoll()
    setReplyWait(null)
  }

  /** 换上服务端历史(ref 同步写:紧接着的补拉判断要用最新值,不能等 effect) */
  function applyHistory(list: Msg[]) {
    staggerCountRef.current = list.length
    messagesRef.current = list
    setMessages(list)
  }

  function clearMessages() {
    applyHistory([])
  }

  /**
   * 排下一次「等回复」补拉。gen 校验保证旧会话的补拉不会写进新会话;
   * 节奏表用尽就停在 timeout 态,交给用户手动重载(不无限轮询)。
   */
  function scheduleReplyPoll(id: string, attempt: number, gen: number) {
    clearPoll()
    const delay = REPLY_POLL_DELAYS[attempt]
    if (delay === undefined) { setReplyWait('timeout'); return }
    setReplyWait('waiting')
    pollTimer.current = setTimeout(() => {
      pollTimer.current = null
      if (deps.genRef.current !== gen) return
      // 正在发送的那次请求自己会带回正文(空则由 onEmptyReply 兜住),这时重拉只会冲掉流式气泡
      if (deps.sendingRef.current) { setReplyWait(null); return }
      void loadMessages(id, { silent: true, attempt: attempt + 1 })
    }, delay)
  }

  /**
   * 载入历史。
   * - 默认(用户可见):loading→骨架、error→可重试、ready→才可能显示欢迎语。
   * - silent(「等回复」的后台补拉):不闪骨架、失败不报错,而且**只在服务端确实多出一条
   *   本地没有的 assistant 回复时才替换视图** —— 否则会把本地的失败气泡/重试入口冲掉。
   */
  async function loadMessages(id: string, opts: { silent?: boolean; attempt?: number } = {}) {
    const silent = opts.silent === true
    const attempt = opts.attempt ?? 0
    const gen = deps.genRef.current
    if (!silent) setHistoryState('loading')
    try {
      const r = await fetch(`/api/pr/chat?threadId=${encodeURIComponent(id)}`, { headers: deps.authHeader(), cache: 'no-store' })
      if (deps.genRef.current !== gen) return
      if (r.status === 401) { deps.setAuthError(true); if (!silent) setHistoryState('error'); return }
      if (!r.ok) {
        if (silent) scheduleReplyPoll(id, attempt, gen)
        else setHistoryState('error')
        return
      }
      const j = await r.json()
      if (deps.genRef.current !== gen) return
      const list: Msg[] = (j.messages ?? [])
        .slice()
        .reverse()
        .map((m: ServerMsg) => ({
          id: typeof m.id === 'string' && m.id ? m.id : newId(),
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: m.content,
          imageUrl: m.imageUrl ?? null,
          status: 'sent' as const,
        }))
      const last = list[list.length - 1]

      if (silent) {
        const known = new Set(messagesRef.current.map(m => m.id))
        if (last?.role === 'assistant' && !known.has(last.id)) {
          applyHistory(list) // 服务端把回复写出来了 → 换上真实历史,停止等待
          stopReplyWait()
        } else if (last?.role === 'user') {
          scheduleReplyPoll(id, attempt, gen) // 还在算,继续等
        } else {
          stopReplyWait() // 服务端没有待回复的消息(这次多半根本没送到)→ 别再等
        }
        return
      }

      applyHistory(list)
      setHistoryState('ready')
      deps.onLoaded()
      // 最后一条还是自己发的 → 服务端多半还在算(实测 30 秒以上),排补拉;拉到回复即停
      if (last?.role === 'user') scheduleReplyPoll(id, attempt, gen)
      else stopReplyWait()
    } catch {
      if (deps.genRef.current !== gen) return
      if (silent) scheduleReplyPoll(id, attempt, gen)
      else setHistoryState('error')
    }
  }

  return {
    messages,
    setMessages,
    historyState,
    setHistoryState,
    replyWait,
    staggerCount: staggerCountRef.current,
    loadMessages,
    stopReplyWait,
    clearMessages,
  }
}
