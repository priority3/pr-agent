/**
 * 极简 hash 路由。
 *
 * 为什么用 hash 而不是 history API:服务端只把 / 与 /pr 映射到 index.html
 * (见 server/index.ts 的静态托管),没有通配回退。换成 history 路由要同时改服务端,
 * 而这里只有四个页面、不需要 SEO —— hash 是最小改动。
 *
 * 路由表:
 *   (空) / #/           对话(默认)
 *   #/records           训练记录
 *   #/records/<id>      单条详情
 *   #/settings          设置
 */
import { useEffect, useState } from 'react'

export type Route =
  | { name: 'chat' }
  | { name: 'records' }
  | { name: 'record'; id: string }
  | { name: 'settings' }

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#\/?/, '').replace(/\/+$/, '')
  if (!path) return { name: 'chat' }
  const [head, ...rest] = path.split('/')
  if (head === 'records') {
    const id = rest.join('/')
    return id ? { name: 'record', id: decodeURIComponent(id) } : { name: 'records' }
  }
  if (head === 'settings') return { name: 'settings' }
  return { name: 'chat' }
}

/** 跳转。push 用 history 栈(返回键回上一页),replace 用于重定向。 */
export function navigate(path: string, opts: { replace?: boolean } = {}) {
  const hash = path.startsWith('#') ? path : `#${path}`
  if (opts.replace) {
    const url = `${window.location.pathname}${window.location.search}${hash}`
    window.history.replaceState({}, '', url)
    window.dispatchEvent(new HashChangeEvent('hashchange'))
    return
  }
  window.location.hash = hash
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash))

  useEffect(() => {
    const onChange = () => setRoute(parseRoute(window.location.hash))
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])

  return route
}
