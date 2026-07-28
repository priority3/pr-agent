import { useEffect, useRef, useState } from 'react'

import Composer from './Composer'
import { newId } from './helpers'
import { useElementHeightVar, useStickyScroll, useVisualViewport } from './hooks'
import { ArrowDownIcon, MenuIcon, PlusIcon } from './icons'
import MessageList from './MessageList'
import { PrThemeStyle } from './theme'
import ThreadDrawer from './ThreadDrawer'
import type { HistoryState, Msg, ServerMsg, Thread } from './types'
import { useChatSend } from './useChatSend'

/**
 * PR 对话 H5(手机优先,完整多会话 chat)。RunPaceFlow 品牌:黑白极简 + 荧光绿强调色 + 真实 logo。
 * 交互参考 Shiro(innei.in):毛玻璃顶栏/输入区、弹簧曲线入场与按压反馈、抽屉滑入、
 * 两段式删除、textarea 自动长高——全部纯 CSS spring,不引第三方动画库。
 * 主题:作用域 CSS 变量(--pr-*),深色随系统自动切换(不依赖全局 shadcn 令牌)。
 * 免登录:token 由推送链接带入(?t=),存 localStorage。会话/消息都存服务端。
 *
 * 结构:本文件只管状态与编排;帧解析 sse.ts、气泡 MessageList、输入区 Composer、
 * 会话抽屉 ThreadDrawer、滚动/视口 hooks.ts、主题 theme.tsx。
 */
export default function PrChatPage() {
  const [token, setToken] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [authError, setAuthError] = useState(false)
  const [threads, setThreads] = useState<Thread[]>([])
  const [threadId, setThreadId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Msg[]>([])
  const [historyState, setHistoryState] = useState<HistoryState>('loading')
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
  // 历史消息入场错峰只在整屏载入时生效;之后追加的新消息立即入场(否则每次发送都要等 delay)
  const staggerCountRef = useRef(0)
  // 会话代号:切会话/新对话/删会话都 +1;所有异步回包写状态前校验,防止旧会话的流写进新会话
  const genRef = useRef(0)
  // 自己发消息拿到的新 threadId:跳过一次历史重拉(本地已是最新,重拉只会闪骨架并丢掉思考块)
  const selfSetThreadRef = useRef<string | null>(null)

  const authHeader = (): HeadersInit => ({ Authorization: `Bearer ${token ?? ''}` })
  const imgSrc = (url: string) => `${url}${url.includes('?') ? '&' : '?'}t=${encodeURIComponent(token ?? '')}`

  const { atBottom, hasNew, scrollToBottom, keepPinned } = useStickyScroll(scrollRef, messages, sending)
  useVisualViewport(keepPinned)
  useElementHeightVar(composerRef, '--pr-composer-h')

  // token 初始化(mount 后读浏览器 API)
  useEffect(() => {
    const url = new URL(window.location.href)
    const t = url.searchParams.get('t')
    if (t) {
      localStorage.setItem('pr_chat_token', t)
      url.searchParams.delete('t')
      window.history.replaceState({}, '', url.pathname + url.search)
    }
    const nextToken = t || localStorage.getItem('pr_chat_token')
    /* eslint-disable react-hooks/set-state-in-effect */
    setToken(nextToken)
    setReady(true)
    /* eslint-enable react-hooks/set-state-in-effect */
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

  /** 载入历史:loading→骨架、error→可重试、ready→才可能显示欢迎语(空态不再冒充「会话被清空」) */
  async function loadMessages(id: string) {
    const gen = genRef.current
    setHistoryState('loading')
    try {
      const r = await fetch(`/api/pr/chat?threadId=${encodeURIComponent(id)}`, { headers: authHeader(), cache: 'no-store' })
      if (genRef.current !== gen) return
      if (r.status === 401) { setAuthError(true); setHistoryState('error'); return }
      if (!r.ok) { setHistoryState('error'); return }
      const j = await r.json()
      if (genRef.current !== gen) return
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
      staggerCountRef.current = list.length
      setMessages(list)
      setHistoryState('ready')
      scrollToBottom('auto')
    } catch {
      if (genRef.current === gen) setHistoryState('error')
    }
  }

  /** 失败返回 null(而不是 []):调用方据此保留旧列表,不会因一次抖动把用户踢回新对话 */
  async function fetchThreads(): Promise<Thread[] | null> {
    try {
      const r = await fetch('/api/pr/threads', { headers: authHeader(), cache: 'no-store' })
      if (r.status === 401) { setAuthError(true); return null }
      if (!r.ok) return null
      const j = await r.json()
      const list: Thread[] = j.threads ?? []
      setThreads(list)
      return list
    } catch {
      return null
    }
  }

  /** 离开当前会话前的统一收尾:中断在途请求 + 作废其回包 */
  function leaveCurrent() {
    abortRef.current?.abort()
    abortRef.current = null
    genRef.current += 1
    // 离开会话后,之前那次「自己新建的会话」标记必然过期;不清掉的话万一以后切回同一个 id,
    // 会被误判成「本地已是最新」而跳过历史拉取,直接把上一个会话的消息留在屏上。
    selfSetThreadRef.current = null
    setSending(false)
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
    staggerCountRef.current = 0
    setMessages([])
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
      if (r.status === 401) { setAuthError(true); return }
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
        staggerCountRef.current = 0
        setMessages([])
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
    setSending,
    setAuthError,
    onThreadCreated: id => {
      selfSetThreadRef.current = id
      setThreadId(id)
      localStorage.setItem('pr_chat_thread', id)
    },
    refreshThreads: () => { void fetchThreads() },
    onStart: () => scrollToBottom('auto'), // 自己发的消息:无条件回到底部
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
          <p className="pr-rise text-sm" style={{ color: 'var(--pr-text)' }}>请从每日推送里的「打开 PR 对话」链接进入。</p>
          <p className="pr-rise mt-1.5 text-xs" style={{ color: 'var(--pr-muted)', animationDelay: '80ms' }}>(缺少访问令牌)</p>
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
          staggerCount={staggerCountRef.current}
          // 按「会话代号」重挂列表(切会话才重放入场动画);发首条消息时服务端回填的 threadId
          // 不该触发重挂,否则整屏消息会在流式结束那一刻重新动一遍
          threadKey={String(genRef.current)}
          imgSrc={imgSrc}
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
        imgSrc={imgSrc}
      />
    </div>
  )
}
