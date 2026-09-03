import { useEffect, useRef, useState } from 'react'

import { clearAuthImageCache } from './AuthImage'
import Composer from './Composer'
import { newId } from './helpers'
import { useElementHeightVar, useStickyScroll, useVisualViewport } from './hooks'
import { ArrowDownIcon, MenuIcon, PlusIcon } from './icons'
import MessageList from './MessageList'
import {
  clearStoredToken,
  readStoredToken,
  redeemInvite,
  REDEEM_MESSAGES,
  storeToken,
  type RedeemError,
} from './session'
import { PrThemeStyle } from './theme'
import ThreadDrawer from './ThreadDrawer'
import type { Thread } from './types'
import { useChatSend } from './useChatSend'
import { useThreadHistory } from './useThreadHistory'

/**
 * PR 对话 H5(手机优先,完整多会话 chat)。RunPaceFlow 品牌:黑白极简 + 荧光绿强调色 + 真实 logo。
 * 交互参考 Shiro(innei.in):毛玻璃顶栏/输入区、弹簧曲线入场与按压反馈、抽屉滑入、
 * 两段式删除、textarea 自动长高——全部纯 CSS spring,不引第三方动画库。
 * 主题:作用域 CSS 变量(--pr-*),深色随系统自动切换(不依赖全局 shadcn 令牌)。
 * 免登录:一次性链接(?t=)换一枚设备令牌存 localStorage(见 session.ts)。会话/消息都存服务端。
 *
 * 结构:本文件只管状态与编排;帧解析 sse.ts、气泡 MessageList、输入区 Composer、
 * 会话抽屉 ThreadDrawer、滚动/视口 hooks.ts、主题 theme.tsx。
 */
export default function PrChatPage() {
  const [token, setToken] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [authError, setAuthError] = useState(false)
  // 兑换一次性链接失败的原因(空态里展示,区分「链接用过了」和「网络不通」)
  const [entryError, setEntryError] = useState<RedeemError | null>(null)
  const [threads, setThreads] = useState<Thread[]>([])
  const [threadId, setThreadId] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [pendingImageUrl, setPendingImageUrl] = useState<string | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // sending 的镜像:补拉 timer 触发时要读最新值(闭包里的 state 是旧的)
  const sendingRef = useRef(false)
  // 会话代号:切会话/新对话/删会话都 +1;所有异步回包写状态前校验,防止旧会话的流写进新会话
  const genRef = useRef(0)
  // 自己发消息拿到的新 threadId:跳过一次历史重拉(本地已是最新,重拉只会闪骨架并丢掉思考块)
  const selfSetThreadRef = useRef<string | null>(null)
  // 载入完成时要回到底部,但 scrollToBottom 要等 messages 先就位 → 经 ref 回调转一手
  const scrollToBottomRef = useRef<(behavior?: ScrollBehavior) => void>(() => {})

  const authHeader = (): HeadersInit => ({ Authorization: `Bearer ${token ?? ''}` })

  /**
   * 令牌失效(401)。除了置错误态,还要把废令牌从 localStorage 抹掉 ——
   * 原先不抹,下次进页面会拿着同一枚废令牌一路 401 到底,看起来像「服务挂了」。
   */
  function onAuthError() {
    setAuthError(true)
    clearStoredToken()
    clearAuthImageCache()
  }

  // 历史列表 + 载入三态 + 「等回复」补拉(见 useThreadHistory)
  const {
    messages, setMessages, historyState, setHistoryState, replyWait, staggerCount,
    loadMessages, stopReplyWait, clearMessages,
  } = useThreadHistory({
    authHeader,
    genRef,
    sendingRef,
    setAuthError: onAuthError,
    onLoaded: () => scrollToBottomRef.current('auto'),
  })

  const { atBottom, hasNew, scrollToBottom, keepPinned } = useStickyScroll(scrollRef, messages, sending)
  useVisualViewport(keepPinned)
  useElementHeightVar(composerRef, '--pr-composer-h')

  useEffect(() => {
    scrollToBottomRef.current = scrollToBottom
  }, [scrollToBottom])

  // 令牌初始化(mount 后读浏览器 API):本地令牌优先,否则拿 URL 上的一次性 t 去兑换
  useEffect(() => {
    let alive = true

    void (async () => {
      const stored = readStoredToken()
      if (stored) {
        if (alive) {
          setToken(stored)
          setReady(true)
        }
        return
      }

      const url = new URL(window.location.href)
      const t = url.searchParams.get('t')
      if (!t) {
        if (alive) setReady(true)
        return
      }

      const outcome = await redeemInvite(t)
      if (!alive) return

      if (outcome.ok) {
        storeToken(outcome.token)
        setToken(outcome.token)
      } else {
        setEntryError(outcome.reason)
      }
      setReady(true)

      // 无论成败都把 t 从地址栏抹掉:成功了它已作废,失败了留着也只会误导人刷新重试。
      url.searchParams.delete('t')
      window.history.replaceState({}, '', url.pathname + url.search)
    })()

    return () => {
      alive = false
    }
  }, [])

  useEffect(() => () => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current)
  }, [])

  // 拉会话列表 → 决定当前会话(本地存的优先,否则最近一条)。跨设备也能续上。
  useEffect(() => {
    if (!token) return
    void (async () => {
      const list = await fetchThreads()
      const stored = localStorage.getItem('pr_chat_thread')
      if (!list) {
        // 列表拉不到时退回本地记住的会话(消息接口是另一条请求,往往还能用),别直接落到空态
        if (stored) setThreadId(stored)
        else setHistoryState('ready')
        return
      }
      const pick = stored && list.some(t => t.id === stored) ? stored : (list[0]?.id ?? null)
      if (pick) setThreadId(pick)
      else setHistoryState('ready')
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  // 会话切换 → 载入该会话消息
  useEffect(() => {
    if (!token || !threadId) return
    if (selfSetThreadRef.current === threadId) {
      selfSetThreadRef.current = null
      setHistoryState('ready')
      return
    }
    void loadMessages(threadId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, threadId])

  function showNotice(text: string) {
    if (noticeTimer.current) clearTimeout(noticeTimer.current)
    setNotice(text)
    noticeTimer.current = setTimeout(() => setNotice(null), 4000)
  }

  /** 失败返回 null(而不是 []):调用方据此保留旧列表,不会因一次抖动把用户踢回新对话 */
  async function fetchThreads(): Promise<Thread[] | null> {
    try {
      const r = await fetch('/api/pr/threads', { headers: authHeader(), cache: 'no-store' })
      if (r.status === 401) { onAuthError(); return null }
      if (!r.ok) return null
      const j = await r.json()
      const list: Thread[] = j.threads ?? []
      setThreads(list)
      return list
    } catch {
      return null
    }
  }

  /** sending 同时写进 ref:补拉 timer 里要读最新值 */
  function markSending(value: boolean) {
    sendingRef.current = value
    setSending(value)
  }

  /** 离开当前会话前的统一收尾:中断在途请求 + 作废其回包 + 停掉等回复的补拉 */
  function leaveCurrent() {
    abortRef.current?.abort()
    abortRef.current = null
    genRef.current += 1
    // 离开会话后,之前那次「自己新建的会话」标记必然过期;不清掉的话万一以后切回同一个 id,
    // 会被误判成「本地已是最新」而跳过历史拉取,直接把上一个会话的消息留在屏上。
    selfSetThreadRef.current = null
    stopReplyWait()
    markSending(false)
  }

  function switchTo(id: string) {
    setDrawerOpen(false)
    if (id === threadId) return
    leaveCurrent()
    setHistoryState('loading') // 不先清空 messages,由骨架接管,避免「空态闪一下」
    setThreadId(id)
    localStorage.setItem('pr_chat_thread', id)
  }

  function newChat() {
    setDrawerOpen(false)
    leaveCurrent()
    setThreadId(null)
    clearMessages()
    setPendingImageUrl(null)
    setHistoryState('ready')
    localStorage.removeItem('pr_chat_thread')
  }

  function toggleThinking(id: string) {
    setMessages(ms => ms.map(m => (m.id === id ? { ...m, thinkingOpen: !m.thinkingOpen } : m)))
  }

  async function deleteThread(id: string) {
    let ok = false
    try {
      const r = await fetch(`/api/pr/threads?id=${encodeURIComponent(id)}`, { method: 'DELETE', headers: authHeader() })
      if (r.status === 401) { onAuthError(); return }
      ok = r.ok
    } catch {
      ok = false
    }
    if (!ok) { showNotice('删除失败,请重试'); return }

    // 先按本地列表推进:即使随后的列表刷新失败,也不会清空侧栏 / 把用户踢走
    const rest = threads.filter(t => t.id !== id)
    setThreads(rest)
    if (id === threadId) {
      leaveCurrent()
      const next = rest[0]?.id ?? null
      if (next) {
        setHistoryState('loading')
        setThreadId(next)
        localStorage.setItem('pr_chat_thread', next)
      } else {
        setThreadId(null)
        clearMessages()
        setHistoryState('ready')
        localStorage.removeItem('pr_chat_thread')
      }
    }
    if (!(await fetchThreads())) showNotice('会话列表没刷新成功,显示的是本地结果')
  }

  async function uploadFile(file: File) {
    if (!token) return
    setUploading(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const r = await fetch('/api/pr/upload', { method: 'POST', headers: authHeader(), body: fd })
      const j = await r.json().catch(() => ({}) as { url?: string; error?: string })
      if (!r.ok) { showNotice(j.error || '上传失败'); return }
      setPendingImageUrl(j.url ?? null)
    } catch {
      showNotice('上传失败,网络错误')
    } finally {
      setUploading(false)
    }
  }

  const sendMessage = useChatSend({
    authHeader,
    threadId,
    genRef,
    abortRef,
    setMessages,
    setSending: markSending,
    setAuthError: onAuthError,
    onThreadCreated: id => {
      selfSetThreadRef.current = id
      setThreadId(id)
      localStorage.setItem('pr_chat_thread', id)
    },
    refreshThreads: () => { void fetchThreads() },
    // 自己发的消息:无条件回到底部;并停掉等回复的补拉(本次请求自己会带回正文,
    // 补拉在流式期间替换列表会把正在写的气泡冲掉)
    onStart: () => {
      stopReplyWait()
      scrollToBottom('auto')
    },
    // 这次没拿到正文(气泡空 / 网关 5xx / 流中断 / 主动停止)→ 进「等回复」后台补拉:
    // 服务端很可能仍在算并会落库,拉到就自动替换成真实回复。
    // id 由发送方给(新会话是服务端刚建的,当次渲染闭包里的 threadId 还是 null)
    onEmptyReply: id => {
      const target = id ?? threadId
      if (target) void loadMessages(target, { silent: true })
    },
  })

  const canSend = (input.trim().length > 0 || !!pendingImageUrl) && !sending && !uploading && !authError

  function submit() {
    const text = input.trim()
    if (!canSend || !token) return
    // 输入清空只做在真正发出的那一刻;失败后原文还留在那条失败气泡里,可一键重试
    setInput('')
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
    setPendingImageUrl(null)
    void sendMessage({ text, imageUrl: pendingImageUrl })
  }

  function retry(id: string) {
    const target = messages.find(m => m.id === id)
    if (!target || sending || uploading || !token || authError) return
    void sendMessage({ text: target.content, imageUrl: target.imageUrl ?? null, retryOf: target })
  }

  if (ready && !token) {
    return (
      <div className="pr flex h-[100dvh] items-center justify-center p-6 text-center" style={{ background: 'var(--pr-bg)', color: 'var(--pr-text-2)' }}>
        <PrThemeStyle />
        <div>
          <div className="pr-breath mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full" style={{ background: '#fff', border: '1px solid var(--pr-line-strong)' }}>
            <img src="/pr-logo.png" alt="RunPaceFlow" className="h-10 w-10" />
          </div>
          <p className="pr-rise text-sm" style={{ color: 'var(--pr-text)' }}>
            {entryError ? REDEEM_MESSAGES[entryError] : '请用管理端生成的一次性链接进入。'}
          </p>
          <p className="pr-rise mt-1.5 text-xs" style={{ color: 'var(--pr-muted)', animationDelay: '80ms' }}>
            {entryError ? '(链接一次有效)' : '(缺少访问令牌)'}
          </p>
        </div>
      </div>
    )
  }

  const currentTitle = threads.find(t => t.id === threadId)?.title ?? (threadId ? 'PR 对话' : '新对话')

  return (
    // 根容器贴住 visualViewport(键盘弹起时可视区变矮 + 页面被上推),回退到 100dvh
    <div
      className="pr fixed inset-x-0 top-0 overflow-hidden"
      style={{
        height: 'var(--pr-vh, 100dvh)',
        transform: 'translateY(var(--pr-vv-top, 0px))',
        background: 'var(--pr-bg)',
        color: 'var(--pr-text)',
      }}
    >
      <PrThemeStyle />

      {/* 毛玻璃顶栏:内容从底下滚过;高度含刘海安全区 */}
      <header
        className="pr-glass absolute inset-x-0 top-0 z-20 flex items-center gap-2.5 px-3.5"
        style={{ height: 'calc(56px + var(--pr-safe-top))', paddingTop: 'var(--pr-safe-top)', borderBottom: '1px solid var(--pr-line)' }}
      >
        <button type="button" onClick={() => { void fetchThreads(); setDrawerOpen(true) }} className="pr-tap rounded-lg p-1.5" style={{ color: 'var(--pr-text-2)' }} aria-label="会话列表">
          <MenuIcon />
        </button>
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full" style={{ background: '#fff', border: '1px solid var(--pr-line-strong)' }}>
          <img src="/pr-logo.png" alt="RunPaceFlow" className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-medium tracking-tight">{currentTitle}</div>
          <div className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--pr-muted)' }}>
            <span className={`pr-dot-solid ${sending ? 'pr-pulse' : ''}`} style={{ background: 'var(--pr-accent)' }} />
            {sending ? '正在输入…' : 'PR · 你的运动伙伴'}
          </div>
        </div>
        <button type="button" onClick={newChat} className="pr-tap rounded-lg p-1.5" style={{ color: 'var(--pr-text-2)' }} aria-label="新对话">
          <PlusIcon />
        </button>
      </header>

      <ThreadDrawer
        open={drawerOpen}
        threads={threads}
        activeId={threadId}
        onClose={() => setDrawerOpen(false)}
        onSwitch={switchTo}
        onNewChat={newChat}
        onDelete={id => void deleteThread(id)}
      />

      {/* 消息区:滚到毛玻璃顶栏/输入区底下;底部留白按输入区实测高度走 */}
      <div
        ref={scrollRef}
        className="pr-scroll h-full overflow-y-auto px-4"
        style={{
          paddingTop: 'calc(72px + var(--pr-safe-top))',
          paddingBottom: 'calc(var(--pr-composer-h, 168px) + 12px)',
          overscrollBehavior: 'contain',
        }}
      >
        <MessageList
          messages={messages}
          historyState={historyState}
          sending={sending}
          staggerCount={staggerCount}
          // 按「会话代号」重挂列表(切会话才重放入场动画);发首条消息时服务端回填的 threadId
          // 不该触发重挂,否则整屏消息会在流式结束那一刻重新动一遍
          threadKey={String(genRef.current)}
          replyWait={replyWait}
          token={token}
          onToggleThinking={toggleThinking}
          onRetry={retry}
          onReloadHistory={() => { if (threadId) void loadMessages(threadId) }}
        />
      </div>

      {/* 离开底部时才出现:回到底部 / 有新内容 */}
      {!atBottom && historyState === 'ready' && messages.length > 0 && (
        <div className="pointer-events-none absolute inset-x-0 z-20 flex justify-center" style={{ bottom: 'calc(var(--pr-composer-h, 168px) + 12px)' }}>
          <button
            type="button"
            onClick={() => scrollToBottom('smooth')}
            className="pr-jump pr-tap pr-pop pointer-events-auto flex items-center gap-1 rounded-full py-1.5 pl-2.5 pr-3 text-[12px]"
          >
            <ArrowDownIcon size={13} />
            {hasNew ? '新消息' : '回到底部'}
          </button>
        </div>
      )}

      <Composer
        containerRef={composerRef}
        textareaRef={textareaRef}
        input={input}
        onInputChange={setInput}
        onSubmit={submit}
        onStop={() => abortRef.current?.abort()}
        sending={sending}
        uploading={uploading}
        canSend={canSend}
        disabled={authError}
        authError={authError}
        notice={notice}
        pendingImageUrl={pendingImageUrl}
        onClearImage={() => setPendingImageUrl(null)}
        onPickFile={file => void uploadFile(file)}
        token={token}
      />
    </div>
  )
}
