import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent, type RefObject } from 'react'

import { CameraIcon, CloseIcon, ImageIcon, PlusIcon, SendIcon, Spinner, StopIcon } from './icons'

interface Props {
  containerRef: RefObject<HTMLDivElement | null>
  textareaRef: RefObject<HTMLTextAreaElement | null>
  input: string
  onInputChange: (value: string) => void
  onSubmit: () => void
  onStop: () => void
  sending: boolean
  uploading: boolean
  canSend: boolean
  /** 登录失效:整个输入区禁用(再发也只会失败) */
  disabled: boolean
  authError: boolean
  notice: string | null
  pendingImageUrl: string | null
  onClearImage: () => void
  onPickFile: (file: File) => void
  imgSrc: (url: string) => string
}

/** 毛玻璃输入区:一体化胶囊(＋附件 · 输入 · 发送),聚焦整体亮 ring。 */
export default function Composer(props: Props) {
  const { containerRef, textareaRef, input, sending, uploading, canSend, disabled, pendingImageUrl } = props
  const [attachOpen, setAttachOpen] = useState(false)
  const [inputFocused, setInputFocused] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const cameraRef = useRef<HTMLInputElement>(null)

  // 附件菜单点外即关(容器有 backdrop-filter,fixed 遮罩会被夹在里面,改用全局监听)
  useEffect(() => {
    if (!attachOpen) return
    const close = (e: PointerEvent) => {
      if (!(e.target as HTMLElement | null)?.closest('.pr-attach')) setAttachOpen(false)
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [attachOpen])

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // 中文输入法组词中的回车是「确认候选词」,不是发送(isComposing;Safari 旧版用 keyCode 229)
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      props.onSubmit()
    }
  }

  /* textarea 随内容自动长高(封顶 128px),发出后由外层复位 */
  function autoGrow(el: HTMLTextAreaElement) {
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 128)}px`
  }

  function pick(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    if (f) props.onPickFile(f)
    e.target.value = ''
  }

  return (
    <div ref={containerRef} className="pr-glass absolute inset-x-0 bottom-0 z-20 px-3 pt-2.5" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 10px)' }}>
      {props.authError && (
        <div className="pr-pop mb-2 rounded-xl px-3 py-2 text-xs" style={{ background: 'var(--pr-sel)', color: 'var(--pr-text-2)' }}>
          登录已失效,请重新从推送链接进入。
        </div>
      )}
      {props.notice && (
        <div className="pr-pop mb-2 rounded-xl px-3 py-2 text-xs" style={{ background: 'var(--pr-danger-bg)', color: 'var(--pr-danger)' }}>
          {props.notice}
        </div>
      )}
      <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={pick} />
      <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={pick} />
      <div className="pr-composer flex flex-col rounded-[26px]" style={inputFocused ? { borderColor: 'var(--pr-accent)', boxShadow: '0 0 0 3px rgba(163,230,53,.18)' } : undefined}>
        {pendingImageUrl && (
          <div className="flex px-3 pt-3">
            <div className="pr-pop relative">
              <img src={props.imgSrc(pendingImageUrl)} alt="待发送" className="h-16 w-16 rounded-xl object-cover" style={{ border: '1px solid var(--pr-line-strong)' }} />
              <button type="button" onClick={props.onClearImage} className="pr-tap absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full" style={{ background: 'var(--pr-user-bg)', color: 'var(--pr-user-text)' }} aria-label="移除图片">
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
              disabled={uploading || sending || disabled}
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
            onChange={e => { props.onInputChange(e.target.value); autoGrow(e.target) }}
            onKeyDown={onKeyDown}
            onFocus={() => setInputFocused(true)}
            onBlur={() => setInputFocused(false)}
            rows={1}
            disabled={disabled}
            placeholder={disabled ? '登录已失效' : '和 PR 说点什么…'}
            className="pr-input pr-scroll max-h-32 min-h-[36px] flex-1 resize-none bg-transparent px-1.5 py-1.5 text-[15px] outline-none disabled:opacity-50"
            style={{ color: 'var(--pr-text)' }}
          />
          <button
            type="button"
            onClick={() => (sending ? props.onStop() : props.onSubmit())}
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
  )
}
