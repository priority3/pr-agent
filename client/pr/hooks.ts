import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

/** 距底部多少像素内算「贴底」——小于它才自动跟随新内容 */
const BOTTOM_GAP = 80

/**
 * 贴底跟随滚动。
 * 流式对话每个 delta 都会换新 messages 数组,原来无条件 `scrollTo({behavior:'smooth'})`
 * 会把上翻查看历史的用户硬拽回底部,还和移动端惯性滚动打架。
 * 这里:只有贴底时才跟随;流式期间用 behavior:'auto' 并用 rAF 合并;不贴底时置 hasNew 让外层出「新消息」按钮。
 */
export function useStickyScroll(ref: RefObject<HTMLElement | null>, signal: unknown, instant: boolean) {
  const [atBottom, setAtBottom] = useState(true)
  const [hasNew, setHasNew] = useState(false)
  const pinnedRef = useRef(true)
  // Reason: 调用方(载入历史/发出消息)在 setState 之后、DOM 更新之前就调 scrollToBottom('auto'),
  // 那一刻新内容还没渲染,真正落地的是下面这个跟随 effect。不把「要瞬移」传下去的话,
  // 整屏历史会被 smooth 从顶部滚到底,和入场动画一起抖。
  const instantNextRef = useRef(false)

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const el = ref.current
    if (!el) return
    pinnedRef.current = true
    if (behavior === 'auto') instantNextRef.current = true
    setAtBottom(true)
    setHasNew(false)
    el.scrollTo({ top: el.scrollHeight, behavior })
  }, [ref])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    let raf = 0
    const onScroll = () => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        const near = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_GAP
        pinnedRef.current = near
        setAtBottom(prev => (prev === near ? prev : near))
        if (near) setHasNew(prev => (prev ? false : prev))
      })
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [ref])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (!pinnedRef.current) {
      setHasNew(prev => (prev ? prev : true))
      return
    }
    const raf = requestAnimationFrame(() => {
      const behavior: ScrollBehavior = instant || instantNextRef.current ? 'auto' : 'smooth'
      instantNextRef.current = false
      el.scrollTo({ top: el.scrollHeight, behavior })
    })
    return () => cancelAnimationFrame(raf)
  }, [ref, signal, instant])

  /** 视口变化(键盘弹起/收起)时:原本贴底就保持贴底,否则不动用户的位置 */
  const keepPinned = useCallback(() => {
    if (!pinnedRef.current) return
    const el = ref.current
    el?.scrollTo({ top: el.scrollHeight, behavior: 'auto' })
  }, [ref])

  return { atBottom, hasNew, scrollToBottom, keepPinned }
}

/**
 * 跟随 visualViewport:把可视高度/偏移写进 --pr-vh / --pr-vv-top。
 * iOS Safari 键盘弹起时布局视口不变、可视视口变矮,只靠 100dvh 会让输入框被键盘盖住。
 * 根容器用 height:var(--pr-vh) + translateY(var(--pr-vv-top)) 贴住可视视口。
 */
export function useVisualViewport(onChange?: () => void) {
  const cb = useRef(onChange)
  useEffect(() => {
    cb.current = onChange
  })
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const root = document.documentElement
    const clear = () => {
      root.style.removeProperty('--pr-vh')
      root.style.removeProperty('--pr-vv-top')
    }
    const apply = () => {
      // Reason: 捏合放大时 vv.height/offsetTop 描述的是「缩放取景窗」而不是键盘,照搬会让整页
      // 跟着手指缩放平移。这时退回 100dvh(移除变量),只有正常比例下才贴合可视视口。
      if (vv.scale > 1.05) {
        clear()
        return
      }
      root.style.setProperty('--pr-vh', `${Math.round(vv.height)}px`)
      root.style.setProperty('--pr-vv-top', `${Math.round(vv.offsetTop)}px`)
      cb.current?.()
    }
    apply()
    vv.addEventListener('resize', apply)
    vv.addEventListener('scroll', apply)
    return () => {
      vv.removeEventListener('resize', apply)
      vv.removeEventListener('scroll', apply)
      clear()
    }
  }, [])
}

/**
 * 把元素实测高度写进 CSS 变量。输入区高度受 textarea 长高、图片预览、错误横幅影响,
 * 消息区底部留白不能再写死(写死 168px 时最后一条会被盖住)。
 */
export function useElementHeightVar(ref: RefObject<HTMLElement | null>, varName: string) {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const root = document.documentElement
    const write = () => root.style.setProperty(varName, `${Math.round(el.getBoundingClientRect().height)}px`)
    write()
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(write)
    ro?.observe(el)
    return () => {
      ro?.disconnect()
      root.style.removeProperty(varName)
    }
  }, [ref, varName])
}
