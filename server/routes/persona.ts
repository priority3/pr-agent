/**
 * 数字分身 API(管理端点,无内置界面;admin「数字分身」页消费)。
 * 独立文件挂 /api/pr/persona:routes/pr.ts 已到 500 行约束边缘,新维度新文件。
 */
import { Hono } from 'hono'

import { withAuth, withLoreIngestAuth } from '@/middleware/auth'
import { ingestLoreCapture } from '@/lib/pr/lore-ingest'
import { getPersonaState, listPersonaEvents, projectPersona } from '@/lib/pr/persona'
import { getPersonaLive } from '@/lib/pr/presence'

const persona = new Hono()

// 读投影;还没有(首次访问)就现算一份,保证页面永远有东西可渲染。
persona.get('/', withAuth, async c => {
  let state = await getPersonaState()
  if (!state) {
    await projectPersona({ force: true })
    state = await getPersonaState()
  }
  return c.json({ persona: state })
})

persona.get('/history', withAuth, async c => {
  const limit = Math.min(200, Math.max(1, Number(c.req.query('limit')) || 50))
  return c.json({ events: await listPersonaEvents(limit) })
})

// 手动重投影(调试/管理):force 跳过输入指纹短路,LLM 路仍按 memHash 决定是否重跑。
persona.post('/reproject', withAuth, async c => {
  const result = await projectPersona({ force: true })
  return c.json(result)
})

// 实时状态(P3):代理 priority.me presence,30s 缓存;未配 PR_PRESENCE_URL 返回 enabled:false。
persona.get('/live', withAuth, async c => c.json(await getPersonaLive()))

// pr-lore 采集投递(P4):单条 lore.capture.v1 → MemoryCurator 蒸馏为候选记忆。
// 按策略拒收(不许上云/无文本)也回 200,避免 lore 侧把它当失败反复重投。
persona.post('/ingest', withLoreIngestAuth, async c => {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }
  const result = await ingestLoreCapture(body)
  if ('badRequest' in result) return c.json({ error: result.badRequest }, 400)
  return c.json(result)
})

export default persona
