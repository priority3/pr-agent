/**
 * 数字分身 API(管理端点,无内置界面;admin「数字分身」页消费)。
 * 独立文件挂 /api/pr/persona:routes/pr.ts 已到 500 行约束边缘,新维度新文件。
 */
import { Hono } from 'hono'

import { withAuth } from '@/middleware/auth'
import { getPersonaState, listPersonaEvents, projectPersona } from '@/lib/pr/persona'

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

export default persona
