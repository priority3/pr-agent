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

/**
 * 「后续消息」观察窗口(服务端说本轮登记了观察时才开)。
 *
 * Reason: 对话内同步的结果在工具 20s 超时之后才落地,服务端(sync-watch)那时会往这个会话
 * 写一条新消息。而上面那条补拉线覆盖不到它:补拉只在「最后一条是自己发的」时继续,同步
 * 这轮最后一条是 PR 的回复,不满足条件。所以另给一条独立、更长的观察线:按服务端给的信号
 * 开始,一拉到新消息就换上并停止;窗口上限 6 分钟(与服务端观察上限同量级)。
 */
const WATCH_TOTAL_MS = 6 * 60 * 1000
const WATCH_POLL_DELAYS = [12_000, 20_000, 30_000, 30_000, 45_000, 60_000, 60_000, 60_000]

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
  /** 开始观察「后续消息」(服务端说本轮登记了观察时);窗口内静默补拉,消息一到就换上 */
  startWatch: (id: string) => void
  /** 停掉后续消息观察(切会话/卸载) */
  stopWatch: () => void
  /** 新对话 / 删掉最后一个会话:清空本地列表 */
  clearMessages: () => void
}

interface WatchState {
  id: string
  gen: number
  /**
   * 开始观察时服务端**末条消息的 id**。用它而不是条数比较:历史接口只回最近 30 条,
   * 长会话里条数会一直卡在上限,拿条数比就永远看不出「多了一条」。null = 基线还没取到
   * (首次请求失败),下一轮成功时先补基线、不误判成新消息。
   */
  lastId: string | null
  deadline: number
  timer: ReturnType<typeof setTimeout> | null
}

/**
 * 会话历史:载入、空态三态、「等回复」的有限次后台补拉,以及「后续消息」观察窗口。
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
  const watchRef = useRef<WatchState | null>(null)

  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  useEffect(() => () => {
    if (pollTimer.current) clearTimeout(pollTimer.current)
    if (watchRef.current?.timer) clearTimeout(watchRef.current.timer)
  }, [])

  function clearPoll() {
    if (pollTimer.current) clearTimeout(pollTimer.current)
    pollTimer.current = null
  }

  function stopReplyWait() {
    clearPoll()
    setReplyWait(null)
  }

  function stopWatch() {
    if (watchRef.current?.timer) clearTimeout(watchRef.current.timer)
    watchRef.current = null
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

  /** 拉一次会话历史并归一化成 Msg[];失败/未鉴权返回 ok:false(调用方各自决定重试策略)。 */
  async function requestHistory(id: string): Promise<{ ok: boolean; unauthorized: boolean; list: Msg[] }> {
    try {
      const r = await fetch(`/api/pr/chat?threadId=${encodeURIComponent(id)}`, { headers: deps.authHeader(), cache: 'no-store' })
      if (r.status === 401) return { ok: false, unauthorized: true, list: [] }
      if (!r.ok) return { ok: false, unauthorized: false, list: [] }
      const j = await r.json()
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
      return { ok: true, unauthorized: false, list }
    } catch {
      return { ok: false, unauthorized: false, list: [] }
    }
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

  /** 排下一次「后续消息」观察;窗口用尽即停(不无限轮询)。 */
  function scheduleWatch(id: string, attempt: number, gen: number) {
    const watch = watchRef.current
    if (!watch || watch.id !== id || watch.gen !== gen) return
    if (deps.genRef.current !== gen || Date.now() >= watch.deadline) { stopWatch(); return }
    const delay = WATCH_POLL_DELAYS[Math.min(attempt, WATCH_POLL_DELAYS.length - 1)]
    watch.timer = setTimeout(() => { void pollWatch(id, attempt + 1, gen) }, delay)
  }

  async function pollWatch(id: string, attempt: number, gen: number) {
    const watch = watchRef.current
    if (!watch || watch.id !== id || watch.gen !== gen) return
    if (deps.genRef.current !== gen) { stopWatch(); return }
    // 流式写入中不替换列表(与补拉同一条理由)
    if (deps.sendingRef.current) { scheduleWatch(id, attempt, gen); return }
    const res = await requestHistory(id)
    if (deps.genRef.current !== gen) return
    const current = watchRef.current
    if (!current || current.id !== id || current.gen !== gen) return
    if (res.ok) {
      const lastId = res.list[res.list.length - 1]?.id ?? null
      if (current.lastId === null) {
        // 基线此前没取到:这一轮先补上,不把「终于拉到了」误判成后续消息
        current.lastId = lastId
      } else if (lastId !== current.lastId) {
        applyHistory(res.list) // 后续消息到了(服务端写进本会话的那条)
        stopWatch()
        return
      }
    }
    scheduleWatch(id, attempt, gen)
  }

  /**
   * 开始观察后续消息。先取一次服务端末条 id 当基线 —— 本地气泡用的是临时 id,而服务端
   * 末条 id 稳定,跨「本地/服务端」比较只能靠它。
   */
  async function startWatch(id: string) {
    stopWatch()
    stopReplyWait() // 两条等待线不并存:观察期间以观察为准
    setReplyWait(null)
    const gen = deps.genRef.current
    const first = await requestHistory(id)
    if (deps.genRef.current !== gen) return
    if (first.unauthorized) { deps.setAuthError(true); return }
    const lastId = first.ok ? (first.list[first.list.length - 1]?.id ?? null) : null
    // 只在服务端确实比本地多时才替换(与静默补拉同一条保守原则:别冲掉本地的失败气泡/重试入口)
    if (first.ok && first.list.length > messagesRef.current.length) applyHistory(first.list)
    watchRef.current = { id, gen, lastId, deadline: Date.now() + WATCH_TOTAL_MS, timer: null }
    scheduleWatch(id, 0, gen)
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
    const res = await requestHistory(id)
    if (deps.genRef.current !== gen) return
    if (!res.ok) {
      if (res.unauthorized) deps.setAuthError(true)
      // 401 不排补拉:令牌已废,继续轮询只会一路 401(保持与拆分前一致的行为)
      if (silent) { if (!res.unauthorized) scheduleReplyPoll(id, attempt, gen) }
      else setHistoryState('error')
      return
    }
    const list = res.list
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
    startWatch,
    stopWatch,
    clearMessages,
  }
}
