/**
 * 运行时配置 API(管理端点;宿主「配置管理」面板经代理消费)。
 * 仅覆盖 AI 网关白名单键;读取永不返回密钥明文(见 runtime-overrides.ts)。
 */
import { Hono } from 'hono'

import { invalidateRuntimeOverridesCache } from '@/lib/config'
import { isOverridableKey, listOverrideViews, setOverride } from '@/lib/runtime-overrides'
import { withAuth } from '@/middleware/auth'

const settings = new Hono()

settings.get('/', withAuth, async c => c.json({ settings: await listOverrideViews() }))

// 部分更新:body 为 {键: 值} 平铺对象;空串 = 清除覆盖(回落 env)。
settings.put('/', withAuth, async c => {
  let body: Record<string, unknown>
  try {
    body = (await c.req.json()) as Record<string, unknown>
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  const entries = Object.entries(body)
  if (!entries.length) return c.json({ error: '空更新' }, 400)
  const invalid = entries.filter(([key, value]) => !isOverridableKey(key) || typeof value !== 'string')
  if (invalid.length) {
    return c.json({ error: `不可覆盖的键或非法值: ${invalid.map(([k]) => k).join(', ')}` }, 400)
  }

  for (const [key, value] of entries) {
    if (isOverridableKey(key)) await setOverride(key, value as string)
  }
  invalidateRuntimeOverridesCache()
  return c.json({ settings: await listOverrideViews() })
})

export default settings
