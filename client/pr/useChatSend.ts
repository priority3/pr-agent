import type { Dispatch, RefObject, SetStateAction } from 'react'

import { newId } from './helpers'
import { parseSSE } from './sse'
import type { Msg, StreamPayload } from './types'

interface Deps {
  authHeader: () => HeadersInit
  threadId: string | null
  /** 会话代号:切会话/新对话会 +1,回包写状态前校验,防止旧会话的流写进新会话 */
  genRef: RefObject<number>
  abortRef: RefObject<AbortController | null>
  setMessages: Dispatch<SetStateAction<Msg[]>>
  setSending: (value: boolean) => void
  setAuthError: (value: boolean) => void
  /** 服务端新建了会话 → 由外层记住(并跳过一次历史重拉) */
  onThreadCreated: (id: string) => void
  refreshThreads: () => void
  /** 发出瞬间的副作用(把视图拉回底部) */
  onStart: () => void
  /**
   * 这次没把正文交到用户眼前(气泡是空的 / 网关 5xx / 流中断 / 主动停止)→ 请外层去「等回复」。
   * Reason: 服务端不会因为客户端断了就停,答案照样落库(实测发出 33 秒后才写完),
   * 客户端完全能自己把它取回来;不做这件事就只剩一个不可见的空气泡或一句错误提示。
   */
  onEmptyReply: (threadId: string | null) => void
}

export interface SendInput {
  text: string
  imageUrl: string | null
  /** 重试:复用原用户气泡,而不是再追加一条 */
  retryOf?: Msg
}

/**
 * 重试:把失败气泡改回发送中,并丢掉「紧跟它」的那些错误提示气泡。
 * Reason: 只清到下一条用户消息为止——列表里可能有别的失败消息各自带着错误气泡,
 * 一刀切「idx 之后所有 error」会把别人的错误提示也一起抹掉。
 */
function retryReset(ms: Msg[], id: string): Msg[] {
  const idx = ms.findIndex(m => m.id === id)
  if (idx < 0) return ms
  let end = idx + 1
  while (end < ms.length && ms[end].role === 'assistant') end += 1
  return ms
    .filter((m, i) => !(i > idx && i < end && m.error))
    .map(m => (m.id === id ? { ...m, status: 'sending' as const } : m))
}

/**
 * 发送 + SSE 消费编排。每次渲染重建,闭包里的 threadId 等都是当次渲染的值;
 * 所有状态写入都过 gen 校验,过期回包直接丢弃。
 */
export function useChatSend(deps: Deps) {
  return async function send({ text, imageUrl, retryOf }: SendInput) {
    const { genRef, abortRef, setMessages, setSending, setAuthError, threadId } = deps
    const gen = genRef.current
    const alive = () => genRef.current === gen
    const commit = (updater: (ms: Msg[]) => Msg[]) => { if (alive()) setMessages(updater) }

    const isNew = !threadId
    const userId = retryOf ? retryOf.id : newId()
    if (retryOf) setMessages(ms => retryReset(ms, userId))
    else setMessages(ms => [...ms, { id: userId, role: 'user', content: text, imageUrl, status: 'sending' }])
    setSending(true)
    deps.onStart()
    const controller = new AbortController()
    abortRef.current = controller

    // 流式渲染:首个 SSE 事件到达时才追加 assistant 消息(此前显示三点 loading),
    // 之后所有 delta 都按 id 精确更新那条消息。
    let assistantId: string | null = null
    let thinkStart = 0
    // 本次回复应该落在哪条消息上 / 属于哪个会话:收尾时用来判断「气泡是否空了」并自愈重拉
    let replyId: string | null = null
    let replyThreadId = threadId
    // 请求这一头断了但服务端很可能仍在算并会落库(网关 5xx / 流中断 / 主动停止):
    // 收尾时同样要通知外层去「等回复」,否则那条回复永远不会出现在界面上
    let replyMayLandLater = false
    const ensureAssistant = () => {
      if (assistantId) return
      const id = newId()
      assistantId = id
      replyId = id
      thinkStart = Date.now()
      commit(ms => [...ms, { id, role: 'assistant', content: '', thinking: '', streaming: true }])
    }
    const patchAssistant = (patch: (m: Msg) => Msg) => {
      const id = assistantId
      if (!id) return
      commit(ms => ms.map(m => (m.id === id ? patch(m) : m)))
    }
    const elapsed = () => Math.max(1, Math.round((Date.now() - thinkStart) / 1000))
    const markUser = (status: Msg['status']) => commit(ms => ms.map(m => (m.id === userId ? { ...m, status } : m)))
    const pushError = (message: string) => commit(ms => [...ms, { id: newId(), role: 'assistant', content: message, error: true }])
    /** 没有流式气泡可打补丁时(非流式响应 / 没收到任何增量就 done)直接补一条完整回复 */
    const pushReply = (content: string) => {
      const id = newId()
      replyId = id
      commit(ms => [...ms, { id, role: 'assistant', content }])
    }
    const applyResult = (result: { threadId?: string }) => {
      if (result.threadId) replyThreadId = result.threadId
      if (!alive()) return
      if (result.threadId && result.threadId !== threadId) deps.onThreadCreated(result.threadId)
      if (isNew) deps.refreshThreads() // 新会话 → 刷新列表让它出现
    }

    /**
     * 收尾观测:承载本次回复的那条气泡最终是不是空的(空 = 用户什么都看不到)。
     * Reason: 光靠本地累加的正文判断不出「commit 被 gen 守卫丢弃 / 气泡被历史重拉抹掉」
     * 这类写入没落地的情况,而那恰恰是「服务端答了却界面空白」的成因。所以用一次恒等
     * updater 读真实状态:它排在所有 patch 之后执行,拿到的是最终列表;返回原数组 →
     * React 直接 bailout,不会多渲染一次。
     */
    const replyIsBlank = () => new Promise<boolean>(resolve => {
      const id = replyId
      if (!id) { resolve(false); return }
      setMessages(ms => {
        const m = ms.find(x => x.id === id)
        resolve(!m || (!m.content && !m.thinking && !m.imageUrl))
        return ms
      })
    })

    const finish = async () => {
      // 只清自己那个 controller:切会话后紧接着发的新消息已经把 abortRef 换成新的了
      if (abortRef.current === controller) abortRef.current = null
      if (alive()) setSending(false)
      // 自愈:气泡空白(服务端已落库却没写进视图)或这头断了但服务端还在算 → 交给外层去等回复。
      // gen 已变(用户切走/新对话/删会话)时不触发:那时往当前视图写东西才是错的,
      // 回到该会话时历史自然完整;而留在屏上的空气泡由 MessageList 的兜底显性化。
      if (!alive()) return
      if (replyMayLandLater || (await replyIsBlank())) deps.onEmptyReply(replyThreadId)
    }

    try {
      const r = await fetch('/api/pr/chat', {
        method: 'POST',
        headers: { ...deps.authHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, threadId, imageUrl, stream: true }),
        signal: controller.signal,
      })
      if (r.status === 401) {
        if (alive()) setAuthError(true)
        markUser('failed')
        await finish()
        return
      }

      // 服务端未按流式返回(旧版本/错误响应)→ 先看 r.ok,再按 JSON 逻辑兜底
      const contentType = r.headers.get('content-type') ?? ''
      if (!contentType.includes('text/event-stream') || !r.body) {
        const j = (await r.json().catch(() => ({}))) as { error?: string; answer?: string; threadId?: string }
        if (!r.ok) {
          markUser('failed')
          pushError(j.error ? `出错了:${j.error}` : `请求失败(HTTP ${r.status})`)
          // 5xx 多半是网关/反代先放手(实测 502),消息已经进了服务端、回复仍会落库 → 去等它
          if (r.status >= 500) replyMayLandLater = true
        } else {
          markUser('sent')
          applyResult(j)
          pushReply(j.answer ?? '(没有回复)')
        }
        await finish()
        return
      }

      let result: StreamPayload | null = null
      let streamError: string | null = null
      for await (const { event, data } of parseSSE<StreamPayload>(r.body)) {
        if (event === 'thinking') {
          ensureAssistant()
          patchAssistant(m => ({ ...m, thinking: (m.thinking ?? '') + (data.delta ?? '') }))
        } else if (event === 'text') {
          ensureAssistant()
          // 首个正文 delta 时定格思考用时(思考块随之收起)
          patchAssistant(m => ({ ...m, content: m.content + (data.delta ?? ''), toolNote: null, thinkingSeconds: m.thinkingSeconds ?? elapsed() }))
        } else if (event === 'tool') {
          ensureAssistant()
          patchAssistant(m => ({ ...m, toolNote: '查数据中…' }))
        } else if (event === 'text_reset') {
          patchAssistant(m => ({ ...m, content: '' }))
        } else if (event === 'replace') {
          // 整段替换(评审改写/兜底):没走过 text 分支,思考用时要在这里补算;
          // toolNote 同样要清(text/done/中断分支都清了),否则以 replace 收尾时「查数据中…」会残留
          ensureAssistant()
          patchAssistant(m => ({ ...m, content: data.answer ?? '', toolNote: null, thinkingSeconds: m.thinkingSeconds ?? elapsed() }))
        } else if (event === 'done') {
          result = data
        } else if (event === 'error') {
          streamError = data.message || '未知错误'
        }
      }

      if (result) {
        const answer = result.answer
        markUser('sent')
        if (assistantId) {
          patchAssistant(m => ({
            ...m,
            streaming: false,
            toolNote: null,
            thinkingSeconds: m.thinkingSeconds ?? elapsed(),
            content: m.content || (answer ?? '(没有回复)'),
          }))
        } else {
          pushReply(answer ?? '(没有回复)')
        }
        applyResult(result)
      } else {
        // 没等到 done(服务端 error 事件或连接中断):服务端多半仍在算并会落库 → 去等它
        replyMayLandLater = true
        const note = streamError ? `(出错了:${streamError})` : '(回复中断,重新进入会话可见完整内容。)'
        if (assistantId) {
          markUser('sent') // 已有部分正文 → 服务端多半已落库,不诱导用户重发
          patchAssistant(m => ({
            ...m,
            streaming: false,
            toolNote: null,
            thinkingSeconds: m.thinkingSeconds ?? elapsed(),
            content: m.content ? `${m.content}\n${note}` : note,
            error: !m.content,
          }))
        } else {
          markUser('failed')
          pushError(streamError ? `出错了:${streamError}` : '网络出错了,稍后再试。')
        }
      }
    } catch (error) {
      // 用户主动中断/网络断:服务端可能仍会完成并落库 → 去等它(等不到会自己停)
      replyMayLandLater = true
      const aborted = (error as Error).name === 'AbortError'
      const note = aborted
        ? '（已停止等待。PR 可能稍后仍会回复，重新进入会话可见。）'
        : '网络出错了，稍后再试。'
      if (assistantId) {
        markUser('sent')
        patchAssistant(m => ({
          ...m,
          streaming: false,
          toolNote: null,
          thinkingSeconds: m.thinkingSeconds ?? elapsed(),
          content: m.content ? `${m.content}\n${note}` : note,
        }))
      } else if (aborted) {
        markUser('sent')
        commit(ms => [...ms, { id: newId(), role: 'assistant', content: note }])
      } else {
        markUser('failed')
        pushError(note)
      }
    }
    await finish()
  }
}
