import { useEffect, useState } from 'react'

/**
 * 带鉴权的图片。
 *
 * Reason: `<img src>` 发不出 Authorization 头 —— 原先只能把访问令牌明文塞进
 * `?t=` 查询串,于是它会落进反代与 CDN 的访问日志。这里改成 fetch 带头取回
 * blob,再用 objectURL 渲染:令牌只走请求头,URL 里什么都不带。
 */

// url → objectURL。blob 走不到浏览器的原生图片缓存,不自己缓一层的话每次切回
// 会话都要重下一遍。页面生命周期内不 revoke:一次会话里能看到的图有限,
// 而提前 revoke 会让回滚到旧消息时图片变白。
const objectUrls = new Map<string, string>()
// 同一张图被两个气泡同时渲染时只发一次请求。
const inflight = new Map<string, Promise<string | null>>()

async function loadImage(url: string, token: string): Promise<string | null> {
  const cached = objectUrls.get(url)
  if (cached) return cached

  const pending = inflight.get(url)
  if (pending) return pending

  const task = (async () => {
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' })
      if (!res.ok) return null
      const objectUrl = URL.createObjectURL(await res.blob())
      objectUrls.set(url, objectUrl)
      return objectUrl
    } catch {
      return null
    } finally {
      inflight.delete(url)
    }
  })()

  inflight.set(url, task)
  return task
}

/** 令牌换掉时(重新兑换/吊销后)清空缓存,避免拿旧令牌取回的图继续显示。 */
export function clearAuthImageCache() {
  for (const objectUrl of objectUrls.values()) URL.revokeObjectURL(objectUrl)
  objectUrls.clear()
}

interface Props {
  url: string
  token: string | null
  alt: string
  className?: string
}

export default function AuthImage({ url, token, alt, className }: Props) {
  const [src, setSrc] = useState<string | null>(() => objectUrls.get(url) ?? null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!token || src) return
    let alive = true
    void loadImage(url, token).then(next => {
      if (!alive) return
      if (next) setSrc(next)
      else setFailed(true)
    })
    return () => {
      alive = false
    }
  }, [url, token, src])

  if (src) return <img src={src} alt={alt} className={className} />

  // 未就绪 / 取失败:保持同样的盒子,避免图片到位时列表跳动。
  return (
    <div
      className={className}
      style={{
        minHeight: 96,
        background: 'var(--pr-line)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 12,
        color: 'var(--pr-muted)',
      }}
    >
      {failed ? '图片加载失败' : ''}
    </div>
  )
}
