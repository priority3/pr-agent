import { useEffect, useRef, useState, type KeyboardEvent } from 'react'

interface Msg {
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
}
interface Thread {
  id: string
  title: string
  summary: string | null
  lastMessageAt: string | null
}

/* 内联描边图标(项目未加载图标字体,统一用 currentColor 的极简 SVG,替代 emoji) */
type IconProps = { size?: number; className?: string }
const svgBase = (size: number) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
})
const MenuIcon = ({ size = 22, className }: IconProps) => (
  <svg {...svgBase(size)} className={className} aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
)
const PlusIcon = ({ size = 22, className }: IconProps) => (
  <svg {...svgBase(size)} className={className} aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
)
const ImageIcon = ({ size = 22, className }: IconProps) => (
  <svg {...svgBase(size)} className={className} aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="m21 15-5-5L5 21" /></svg>
)
const CameraIcon = ({ size = 22, className }: IconProps) => (
  <svg {...svgBase(size)} className={className} aria-hidden="true"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" /><circle cx="12" cy="13" r="4" /></svg>
)
const TrashIcon = ({ size = 18, className }: IconProps) => (
  <svg {...svgBase(size)} className={className} aria-hidden="true"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6" /></svg>
)
const SendIcon = ({ size = 20, className }: IconProps) => (
  <svg {...svgBase(size)} className={className} aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
)
const StopIcon = ({ size = 20, className }: IconProps) => (
  <svg {...svgBase(size)} className={className} aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.5" /></svg>
)
const CloseIcon = ({ size = 16, className }: IconProps) => (
  <svg {...svgBase(size)} className={className} aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
)
const Spinner = ({ size = 20, className }: IconProps) => (
  <svg {...svgBase(size)} className={`pr-spin ${className ?? ''}`} aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.22-8.56" /></svg>
)

/**
 * PR 对话 H5(手机优先,完整多会话 chat)。RunPaceFlow 品牌:黑白极简 + 荧光绿强调色 + 真实 logo。
 * 交互参考 Shiro(innei.in):毛玻璃顶栏/输入区、弹簧曲线入场与按压反馈、抽屉滑入、
 * 两段式删除、textarea 自动长高——全部纯 CSS spring,不引第三方动画库。
 * 主题:作用域 CSS 变量(--pr-*),深色随系统自动切换(不依赖全局 shadcn 令牌)。
 * 免登录:token 由推送链接带入(?t=),存 localStorage。会话/消息都存服务端。
 */
export default function PrChatPage() {
  const [token, setToken] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [authError, setAuthError] = useState(false)
  const [threads, setThreads] = useState<Thread[]>([])
  const [threadId, setThreadId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [pendingImageUrl, setPendingImageUrl] = useState<string | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [attachOpen, setAttachOpen] = useState(false)
  const [inputFocused, setInputFocused] = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const cameraRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const deleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 历史消息入场错峰只在整屏载入时生效;之后追加的新消息立即入场(否则每次发送都要等 delay)
  const staggerCountRef = useRef(0)

  const authHeader = (): HeadersInit => ({ Authorization: `Bearer ${token ?? ''}` })
  const imgSrc = (url: string) => `${url}${url.includes('?') ? '&' : '?'}t=${encodeURIComponent(token ?? '')}`

  // token 初始化(mount 后读浏览器 API,避免 SSR hydration 不一致)
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

  // 拉会话列表 → 决定当前会话(本地存的优先,否则最近一条)。跨设备也能续上。
  useEffect(() => {
    if (!token) return
    void (async () => {
      const list = await fetchThreads()
      const stored = localStorage.getItem('pr_chat_thread')
      const pick = stored && list.some(t => t.id === stored) ? stored : (list[0]?.id ?? null)
      setThreadId(pick)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  // 会话切换 → 载入该会话消息
  useEffect(() => {
    if (!token || !threadId) return
    void (async () => {
      try {
        const r = await fetch(`/api/pr/chat?threadId=${encodeURIComponent(threadId)}`, { headers: authHeader(), cache: 'no-store' })
        if (r.status === 401) { setAuthError(true); return }
        if (r.ok) {
          const j = await r.json()
          const list: Msg[] = (j.messages ?? [])
            .slice()
            .reverse()
            .map((m: { role: string; content: string; imageUrl?: string | null }) => ({
              role: m.role === 'assistant' ? 'assistant' : 'user',
              content: m.content,
              imageUrl: m.imageUrl ?? null,
            }))
          staggerCountRef.current = list.length
          setMessages(list)
        }
      } catch {
        /* ignore */
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, threadId])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, sending])

  // 附件菜单点外即关(容器有 backdrop-filter,fixed 遮罩会被夹在里面,改用全局监听)
  useEffect(() => {
    if (!attachOpen) return
    const close = (e: PointerEvent) => {
      if (!(e.target as HTMLElement | null)?.closest('.pr-attach')) setAttachOpen(false)
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [attachOpen])

  async function fetchThreads(): Promise<Thread[]> {
    try {
      const r = await fetch('/api/pr/threads', { headers: authHeader(), cache: 'no-store' })
      if (r.status === 401) { setAuthError(true); return [] }
      if (!r.ok) return []
      const j = await r.json()
      const list: Thread[] = j.threads ?? []
      setThreads(list)
      return list
    } catch {
      return []
    }
  }

  function switchTo(id: string) {
    setDrawerOpen(false)
    if (id === threadId) return
    setMessages([])
    setThreadId(id)
    localStorage.setItem('pr_chat_thread', id)
  }

  function toggleThinking(index: number) {
    setMessages(ms => ms.map((m, i) => (i === index ? { ...m, thinkingOpen: !m.thinkingOpen } : m)))
  }

  function newChat() {
    setDrawerOpen(false)
    setThreadId(null)
    staggerCountRef.current = 0
    setMessages([])
    setPendingImageUrl(null)
    localStorage.removeItem('pr_chat_thread')
  }

  /* 两段式删除:第一下把垃圾桶变成「确认删除」,3 秒不点自动还原(替代生硬的 window.confirm) */
  function armDelete(id: string) {
    if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current)
    setConfirmDeleteId(id)
    deleteTimerRef.current = setTimeout(() => setConfirmDeleteId(null), 3000)
  }

  async function deleteThread(id: string) {
    if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current)
    setConfirmDeleteId(null)
    try {
      await fetch(`/api/pr/threads?id=${encodeURIComponent(id)}`, { method: 'DELETE', headers: authHeader() })
    } catch {
      /* ignore */
    }
    const list = await fetchThreads()
    if (id === threadId) {
      const next = list[0]?.id ?? null
      setMessages([])
      setThreadId(next)
      if (next) localStorage.setItem('pr_chat_thread', next)
      else localStorage.removeItem('pr_chat_thread')
    }
  }

  async function uploadFile(file: File) {
    if (!token) return
    setUploading(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const r = await fetch('/api/pr/upload', { method: 'POST', headers: authHeader(), body: fd })
      const j = await r.json()
      if (!r.ok) { window.alert(j.error || '上传失败'); return }
      setPendingImageUrl(j.url)
    } catch {
      window.alert('上传失败,网络错误')
    } finally {
      setUploading(false)
    }
  }

  async function send() {
    const text = input.trim()
    if ((!text && !pendingImageUrl) || sending || uploading || !token) return
    const imageUrl = pendingImageUrl
    const isNew = !threadId
    setInput('')
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
    setPendingImageUrl(null)
    setMessages(m => [...m, { role: 'user', content: text, imageUrl }])
    setSending(true)
    const controller = new AbortController()
    abortRef.current = controller

    // 流式渲染:首个 SSE 事件到达时才追加 assistant 消息(此前显示三点 loading),
    // 之后所有 delta 都更新最后一条 streaming 消息。
    let assistantAdded = false
    let thinkStart = 0
    const ensureAssistant = () => {
      if (assistantAdded) return
      assistantAdded = true
      thinkStart = Date.now()
      setMessages(ms => [...ms, { role: 'assistant', content: '', thinking: '', streaming: true }])
    }
    const patchLast = (patch: (m: Msg) => Msg) =>
      setMessages(ms => {
        const last = ms[ms.length - 1]
        if (!last || last.role !== 'assistant' || !last.streaming) return ms
        return [...ms.slice(0, -1), patch(last)]
      })
    const applyResult = (result: { threadId?: string; answer?: string }) => {
      if (result.threadId && result.threadId !== threadId) {
        setThreadId(result.threadId)
        localStorage.setItem('pr_chat_thread', result.threadId)
      }
      if (isNew) void fetchThreads() // 新会话 → 刷新列表让它出现
    }

    try {
      const r = await fetch('/api/pr/chat', {
        method: 'POST',
        headers: { ...authHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, threadId, imageUrl, stream: true }),
        signal: controller.signal,
      })
      if (r.status === 401) { setAuthError(true); setSending(false); return }

      // 服务端未按流式返回(旧版本/错误页)→ 按原 JSON 逻辑兜底
      const contentType = r.headers.get('content-type') ?? ''
      if (!contentType.includes('text/event-stream') || !r.body) {
        const j = await r.json()
        applyResult(j)
        setMessages(m => [...m, { role: 'assistant', content: j.answer ?? '(没有回复)' }])
        abortRef.current = null
        setSending(false)
        return
      }

      // 手写 SSE 解析:按 \n\n 分帧,残包跨 chunk 缓冲;心跳注释行(: ka)直接跳过
      const reader = r.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      let result: { threadId?: string; answer?: string } | null = null
      let streamError: string | null = null
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let sep: number
        while ((sep = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, sep)
          buf = buf.slice(sep + 2)
          if (!frame || frame.startsWith(':')) continue
          let event = 'message'
          let data = ''
          for (const line of frame.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim()
            else if (line.startsWith('data:')) data += line.slice(5).trim()
          }
          let payload: { delta?: string; name?: string; message?: string; threadId?: string; answer?: string }
          try {
            payload = data ? JSON.parse(data) : {}
          } catch {
            continue
          }
          if (event === 'thinking') {
            ensureAssistant()
            patchLast(m => ({ ...m, thinking: (m.thinking ?? '') + (payload.delta ?? '') }))
          } else if (event === 'text') {
            ensureAssistant()
            patchLast(m => ({
              ...m,
              content: m.content + (payload.delta ?? ''),
              toolNote: null,
              // 首个正文 delta 时定格思考用时(思考块随之收起)
              thinkingSeconds: m.thinkingSeconds ?? Math.max(1, Math.round((Date.now() - thinkStart) / 1000)),
            }))
          } else if (event === 'tool') {
            ensureAssistant()
            patchLast(m => ({ ...m, toolNote: '查数据中…' }))
          } else if (event === 'text_reset') {
            patchLast(m => ({ ...m, content: '' }))
          } else if (event === 'replace') {
            ensureAssistant()
            patchLast(m => ({ ...m, content: payload.answer ?? '' }))
          } else if (event === 'done') {
            result = payload
          } else if (event === 'error') {
            streamError = payload.message || '未知错误'
          }
        }
      }

      if (result) {
        const answer = result.answer
        if (assistantAdded) {
          patchLast(m => ({ ...m, streaming: false, toolNote: null, content: m.content || (answer ?? '(没有回复)') }))
        } else {
          setMessages(m => [...m, { role: 'assistant', content: answer ?? '(没有回复)' }])
        }
        applyResult(result)
      } else {
        // 没等到 done(服务端 error 事件或连接中断)
        const note = streamError ? `(出错了:${streamError})` : '(回复中断,重新进入会话可见完整内容。)'
        if (assistantAdded) {
          patchLast(m => ({ ...m, streaming: false, toolNote: null, content: m.content ? `${m.content}\n${note}` : note }))
        } else {
          setMessages(m => [...m, { role: 'assistant', content: streamError ? `出错了:${streamError}` : '网络出错了，稍后再试。' }])
        }
      }
    } catch (error) {
      // 用户主动中断:服务端可能仍会完成并落库,重进会话可见,不当成网络错误
      const note = (error as Error).name === 'AbortError'
        ? '（已停止等待。PR 可能稍后仍会回复，重新进入会话可见。）'
        : '网络出错了，稍后再试。'
      if (assistantAdded) {
        patchLast(m => ({ ...m, streaming: false, toolNote: null, content: m.content ? `${m.content}\n${note}` : note }))
      } else {
        setMessages(m => [...m, { role: 'assistant', content: note }])
      }
    }
    abortRef.current = null
    setSending(false)
  }

  function stopWaiting() {
    abortRef.current?.abort()
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // 中文输入法组词中的回车是「确认候选词」,不是发送(isComposing;Safari 旧版用 keyCode 229)
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send()
    }
  }

  /* textarea 随内容自动长高(封顶 128px),发出后复位 */
  function autoGrow(el: HTMLTextAreaElement) {
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 128)}px`
  }

  function relTime(iso: string | null): string {
    if (!iso) return ''
    const d = new Date(iso)
    const diff = Date.now() - d.getTime()
    if (diff < 60_000) return '刚刚'
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
    if (new Date().toDateString() === d.toDateString()) return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
    return `${d.getMonth() + 1}-${d.getDate()}`
  }

  const canSend = (input.trim().length > 0 || !!pendingImageUrl) && !sending && !uploading

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
    <div className="pr relative h-[100dvh] overflow-hidden" style={{ background: 'var(--pr-bg)', color: 'var(--pr-text)' }}>
      <PrThemeStyle />

      {/* 毛玻璃顶栏:内容从底下滚过 */}
      <header className="pr-glass absolute inset-x-0 top-0 z-20 flex items-center gap-2.5 px-3.5" style={{ height: 56, borderBottom: '1px solid var(--pr-line)' }}>
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

      {/* 会话抽屉:常驻渲染,spring 滑入滑出 + 背景淡入(不再瞬间弹出) */}
      <div className={`fixed inset-0 z-40 ${drawerOpen ? '' : 'pointer-events-none'}`} onClick={() => setDrawerOpen(false)}>
        <div className="pr-backdrop absolute inset-0" style={{ opacity: drawerOpen ? 1 : 0 }} />
        <div
          className="pr-drawer absolute left-0 top-0 flex h-full w-72 flex-col"
          style={{ background: 'var(--pr-bg)', transform: drawerOpen ? 'translateX(0)' : 'translateX(-105%)' }}
          onClick={e => e.stopPropagation()}
        >
          <div className="p-3" style={{ borderBottom: '1px solid var(--pr-line)' }}>
            <button type="button" onClick={newChat} className="pr-tap flex w-full items-center justify-center gap-1.5 rounded-xl px-3 py-2.5 text-sm font-medium" style={{ background: 'var(--pr-user-bg)', color: 'var(--pr-user-text)' }}>
              <PlusIcon size={18} />新对话
            </button>
          </div>
          <div className="pr-scroll flex-1 overflow-y-auto p-2">
            {threads.length === 0 && <p className="p-3 text-xs" style={{ color: 'var(--pr-muted)' }}>还没有会话</p>}
            {threads.map((t, i) => {
              const active = t.id === threadId
              const arming = confirmDeleteId === t.id
              return (
                <div
                  key={t.id}
                  className="pr-row flex items-center gap-2 rounded-xl px-3 py-2.5"
                  style={{ background: active ? 'var(--pr-sel)' : 'transparent', animationDelay: drawerOpen ? `${Math.min(i * 30, 240)}ms` : '0ms' }}
                >
                  {active && <span className="pr-dot-solid shrink-0" style={{ background: 'var(--pr-accent)' }} />}
                  <button type="button" onClick={() => switchTo(t.id)} className="min-w-0 flex-1 text-left">
                    <div className="flex items-baseline gap-2">
                      <div className="min-w-0 flex-1 truncate text-sm" style={{ color: 'var(--pr-text)' }}>{t.title}</div>
                      <div className="shrink-0 text-[10px]" style={{ color: 'var(--pr-muted)' }}>{relTime(t.lastMessageAt)}</div>
                    </div>
                    {t.summary && (
                      <div className="mt-0.5 truncate text-[11px]" style={{ color: 'var(--pr-muted)' }}>{t.summary}</div>
                    )}
                  </button>
                  {arming ? (
                    <button type="button" onClick={() => void deleteThread(t.id)} className="pr-tap pr-pop shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium" style={{ background: 'var(--pr-accent)', color: 'var(--pr-accent-ink)' }}>
                      确认删除
                    </button>
                  ) : (
                    <button type="button" onClick={() => armDelete(t.id)} className="pr-tap shrink-0 p-1" style={{ color: 'var(--pr-muted)' }} aria-label="删除会话">
                      <TrashIcon />
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {/* 消息区:滚到毛玻璃顶栏/输入区底下 */}
      <div ref={scrollRef} className="pr-scroll h-full overflow-y-auto px-4" style={{ paddingTop: 72, paddingBottom: 168, overscrollBehavior: 'contain' }}>
        {messages.length === 0 && !sending && (
          <div className="mx-auto mt-20 max-w-xs text-center">
            <div className="pr-breath mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full" style={{ background: '#fff', border: '1px solid var(--pr-line-strong)' }}>
              <img src="/pr-logo.png" alt="" className="h-10 w-10" />
            </div>
            <p className="pr-rise text-[15px] font-medium" style={{ color: 'var(--pr-text)' }}>嗨,我是 PR。</p>
            <p className="pr-rise mt-1 text-sm leading-relaxed" style={{ color: 'var(--pr-text-2)', animationDelay: '90ms' }}>今天感觉怎么样?聊聊训练、睡眠、状态,或者拍张跑鞋、风景给我看看。</p>
          </div>
        )}

        <div key={threadId ?? 'new'} className="pr-thread-in flex flex-col gap-2.5">
          {messages.map((m, i) => {
            const isUser = m.role === 'user'
            // 整屏载入的历史错峰入场;之后追加的消息(i >= staggerCount)立即入场
            const delay = i < staggerCountRef.current ? `${Math.min(i * 36, 288)}ms` : '0ms'
            if (isUser) {
              return (
                <div key={i} className="pr-msg flex justify-end" style={{ animationDelay: delay }}>
                  <div className="max-w-[80%] overflow-hidden" style={{ background: 'var(--pr-user-bg)', color: 'var(--pr-user-text)', borderRadius: '18px 18px 6px 18px' }}>
                    {m.imageUrl && (
                      <img src={imgSrc(m.imageUrl)} alt="图片" className="block max-h-72 w-full object-cover" />
                    )}
                    {m.content && m.content !== '[图片]' && (
                      <div className="whitespace-pre-wrap break-words px-3.5 py-2.5 text-[15px] leading-relaxed">{m.content}</div>
                    )}
                  </div>
                </div>
              )
            }
            // 连续的 PR 消息只在第一条带头像(iMessage 式分组),后续用占位对齐
            const firstOfGroup = i === 0 || messages[i - 1].role === 'user'
            // 思考展示:流式且正文未开始 → 实时暗色滚动;否则收起成「已思考 Ns」胶囊(点击展开)
            const thinkingLive = Boolean(m.streaming && m.thinking && !m.content)
            return (
              <div key={i} className="pr-msg flex items-end gap-2" style={{ animationDelay: delay }}>
                {firstOfGroup ? <PrAvatar /> : <div className="w-7 shrink-0" />}
                <div className="max-w-[80%] overflow-hidden" style={{ background: 'var(--pr-ai-bg)', color: 'var(--pr-ai-text)', borderRadius: '18px 18px 18px 6px' }}>
                  {m.imageUrl && (
                    <img src={imgSrc(m.imageUrl)} alt="图片" className="block max-h-72 w-full object-cover" />
                  )}
                  {thinkingLive && (
                    <div className="whitespace-pre-wrap break-words px-3.5 py-2.5 text-[12.5px] leading-relaxed" style={{ color: 'var(--pr-muted)' }}>
                      {m.thinking}
                    </div>
                  )}
                  {!thinkingLive && m.thinking && (
                    <button
                      type="button"
                      onClick={() => toggleThinking(i)}
                      className="pr-tap flex items-center gap-1 px-3.5 pt-2.5 text-[12px]"
                      style={{ color: 'var(--pr-muted)' }}
                    >
                      已思考 {m.thinkingSeconds ?? 0} 秒
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
                </div>
              </div>
            )
          })}

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
      </div>

      {/* 毛玻璃输入区:一体化胶囊(＋附件 · 输入 · 发送),聚焦整体亮 ring */}
      <div className="pr-glass absolute inset-x-0 bottom-0 z-20 px-3 pt-2.5" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 10px)' }}>
        {authError && (
          <div className="pr-pop mb-2 rounded-xl px-3 py-2 text-xs" style={{ background: 'var(--pr-sel)', color: 'var(--pr-text-2)' }}>
            登录已失效,请重新从推送链接进入。
          </div>
        )}
        <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) void uploadFile(f); e.target.value = '' }} />
        <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) void uploadFile(f); e.target.value = '' }} />
        <div className="pr-composer flex flex-col rounded-[26px]" style={inputFocused ? { borderColor: 'var(--pr-accent)', boxShadow: '0 0 0 3px rgba(163,230,53,.18)' } : undefined}>
          {pendingImageUrl && (
            <div className="flex px-3 pt-3">
              <div className="pr-pop relative">
                <img src={imgSrc(pendingImageUrl)} alt="待发送" className="h-16 w-16 rounded-xl object-cover" style={{ border: '1px solid var(--pr-line-strong)' }} />
                <button type="button" onClick={() => setPendingImageUrl(null)} className="pr-tap absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full" style={{ background: 'var(--pr-user-bg)', color: 'var(--pr-user-text)' }} aria-label="移除图片">
                  <CloseIcon size={11} />
                </button>
              </div>
            </div>
          )}
          <div className="flex items-end gap-1 p-1.5">
            <div className="pr-attach relative shrink-0">
              <button
                type="button"
                onClick={() => setAttachOpen(open => !open)}
                disabled={uploading || sending}
                className={`pr-tap pr-plus flex h-9 w-9 items-center justify-center rounded-full disabled:opacity-40 ${attachOpen ? 'pr-plus-open' : ''}`}
                style={{ color: 'var(--pr-text-2)' }}
                aria-label="添加图片"
              >
                {uploading ? <Spinner size={19} /> : <PlusIcon size={20} />}
              </button>
              {attachOpen && (
                <div className="pr-pop pr-menu absolute bottom-11 left-0 flex w-32 flex-col rounded-2xl p-1" style={{ background: 'var(--pr-bg)', border: '1px solid var(--pr-line)', boxShadow: '0 8px 28px rgba(0,0,0,.16)' }}>
                  <button type="button" onClick={() => { setAttachOpen(false); cameraRef.current?.click() }} className="pr-tap flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-sm" style={{ color: 'var(--pr-text)' }}>
                    <CameraIcon size={17} className="shrink-0" />拍照
                  </button>
                  <button type="button" onClick={() => { setAttachOpen(false); fileRef.current?.click() }} className="pr-tap flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-sm" style={{ color: 'var(--pr-text)' }}>
                    <ImageIcon size={17} className="shrink-0" />相册
                  </button>
                </div>
              )}
            </div>
            <textarea
              ref={textareaRef}
              value={input}
              onChange={e => { setInput(e.target.value); autoGrow(e.target) }}
              onKeyDown={onKeyDown}
              onFocus={() => setInputFocused(true)}
              onBlur={() => setInputFocused(false)}
              rows={1}
              placeholder="和 PR 说点什么…"
              className="pr-input pr-scroll max-h-32 min-h-[36px] flex-1 resize-none bg-transparent px-1.5 py-1.5 text-[15px] outline-none"
              style={{ color: 'var(--pr-text)' }}
            />
            <button
              type="button"
              onClick={() => (sending ? stopWaiting() : void send())}
              disabled={!sending && !canSend}
              className="pr-send flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
              style={{ background: 'var(--pr-accent)', color: 'var(--pr-accent-ink)' }}
              aria-label={sending ? '停止' : '发送'}
            >
              {sending ? <StopIcon size={18} /> : <SendIcon size={18} />}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/* PR 头像:白底圆形 + 黑色 logo,深浅色下都清晰 */
function PrAvatar() {
  return (
    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full" style={{ background: '#fff', border: '1px solid var(--pr-line-strong)' }}>
      <img src="/pr-logo.png" alt="PR" style={{ width: 18, height: 18 }} />
    </div>
  )
}

/* 作用域主题变量 + 动画。深色随系统(prefers-color-scheme),不依赖全局 shadcn 令牌。
   动画语言(参考 Shiro):spring 贝塞尔 --pr-spring 负责入场/按压,expo-out --pr-ease 负责位移。 */
function PrThemeStyle() {
  return (
    <style>{`
.pr{
  --pr-bg:#ffffff; --pr-text:#111114; --pr-text-2:#6b6b72;
  --pr-muted:#a3a3ac; --pr-line:#ececee; --pr-line-strong:#e0e0e3;
  --pr-ai-bg:#f1f1f3; --pr-ai-text:#111114; --pr-user-bg:#141417; --pr-user-text:#f7f7f8;
  --pr-accent:#a3e635; --pr-accent-ink:#1a2e05; --pr-sel:#f0f0f2;
  --pr-glass:rgba(255,255,255,.78);
  --pr-spring:cubic-bezier(.34,1.56,.64,1); --pr-ease:cubic-bezier(.16,1,.3,1);
  color-scheme:light;
  -webkit-tap-highlight-color:transparent;
}
@media (prefers-color-scheme:dark){
  .pr{
    --pr-bg:#0b0b0d; --pr-text:#f2f2f4; --pr-text-2:#a0a0a8;
    --pr-muted:#6b6b73; --pr-line:#232327; --pr-line-strong:#2c2c31;
    --pr-ai-bg:#1c1c20; --pr-ai-text:#f2f2f4; --pr-user-bg:#ededf0; --pr-user-text:#141417;
    --pr-accent:#a3e635; --pr-accent-ink:#16240a; --pr-sel:#1c1c20;
    --pr-glass:rgba(11,11,13,.72);
    color-scheme:dark;
  }
}
.pr ::selection{background:rgba(163,230,53,.4)}
.pr .pr-glass{background:var(--pr-glass);backdrop-filter:blur(16px) saturate(1.5);-webkit-backdrop-filter:blur(16px) saturate(1.5)}
.pr-backdrop{background:rgba(0,0,0,.32);backdrop-filter:blur(2px);-webkit-backdrop-filter:blur(2px);transition:opacity .3s ease}
.pr-drawer{transition:transform .38s var(--pr-ease);box-shadow:8px 0 32px rgba(0,0,0,.14)}
.pr .pr-input::placeholder{color:var(--pr-muted)}
.pr .pr-composer{background:var(--pr-sel);border:1px solid var(--pr-line);transition:border-color .25s,box-shadow .25s}
.pr .pr-plus{transition:transform .3s var(--pr-spring),opacity .18s}
.pr .pr-plus-open{transform:rotate(45deg)}
.pr .pr-plus-open:active{transform:rotate(45deg) scale(.9)}
.pr-menu{transform-origin:0 100%}
.pr .pr-tap{transition:transform .25s var(--pr-spring),opacity .18s,background-color .18s}
.pr .pr-tap:active{transform:scale(.9)}
.pr .pr-row{animation:prRise .4s var(--pr-ease) both;transition:background-color .2s,transform .25s var(--pr-spring)}
.pr .pr-row:active{transform:scale(.98)}
.pr .pr-send{transition:transform .35s var(--pr-spring),opacity .2s,background-color .2s}
.pr .pr-send:disabled{opacity:.35;transform:scale(.86)}
.pr .pr-send:not(:disabled):active{transform:scale(.88)}
.pr-dot-solid{width:6px;height:6px;border-radius:9999px;display:inline-block}
.pr-pulse{animation:prPulse 1.1s ease-in-out infinite}
@keyframes prPulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(.7)}}
.pr .pr-dot{width:6px;height:6px;border-radius:9999px;background:var(--pr-muted);display:inline-block;animation:prBounce 1.2s infinite ease-in-out}
.pr .pr-dot:nth-child(2){animation-delay:.15s}
.pr .pr-dot:nth-child(3){animation-delay:.3s}
@keyframes prBounce{0%,80%,100%{opacity:.25;transform:translateY(0)}40%{opacity:1;transform:translateY(-3px)}}
.pr-msg{animation:prIn .5s var(--pr-spring) both}
@keyframes prIn{from{opacity:0;transform:translateY(12px) scale(.96)}to{opacity:1;transform:none}}
.pr-thread-in{animation:prFade .35s ease-out both}
@keyframes prFade{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.pr-rise{animation:prRise .6s var(--pr-ease) both}
@keyframes prRise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
.pr-pop{animation:prPop .35s var(--pr-spring) both}
@keyframes prPop{from{opacity:0;transform:scale(.8)}to{opacity:1;transform:none}}
.pr-breath{animation:prBreath 4.5s ease-in-out infinite}
@keyframes prBreath{0%,100%{transform:scale(1)}50%{transform:scale(1.05)}}
.pr-spin{animation:prSpin .8s linear infinite}
@keyframes prSpin{to{transform:rotate(360deg)}}
.pr-scroll{scrollbar-width:none}
.pr-scroll::-webkit-scrollbar{display:none}
@media (prefers-reduced-motion:reduce){
  .pr *,.pr-backdrop,.pr-drawer{animation-duration:.01ms !important;transition-duration:.01ms !important}
}
`}</style>
  )
}
