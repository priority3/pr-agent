/**
 * 赛事目标路由(挂 /api/pr/race-goals)。
 *
 * 移植自宿主 runPaceFlow-admin 的 src/app/api/race-goals/**:抽离时 PR 逻辑是 copy
 * 而非 move,宿主那侧留着一份等价实现。现把 HTTP 入口补在本仓(逻辑 owner 在这里),
 * 宿主改为转发过来。
 *
 * 每次增删改后都要 projectFriendProfile():赛事目标是"伙伴画像"的输入之一
 * (备赛阶段 / 距离比赛天数会进对话上下文),不重投影的话画像就停在旧目标上。
 */
import { Hono } from 'hono'

import { missingField } from '@/lib/api-helpers'
import { projectFriendProfile } from '@/lib/pr/memory'
import { createRaceGoal, deleteRaceGoal, listRaceGoals, updateRaceGoal } from '@/lib/pr/race-goals'
import { withAuth } from '@/middleware/auth'

const raceGoals = new Hono()

/** 可选数值字段:null 表示显式清空,undefined 表示不改。 */
function optionalNumber(value: unknown): number | null | undefined {
  if (value === null) return null
  if (typeof value === 'number') return value
  if (value === undefined || value === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

raceGoals.get('/', withAuth, async c => {
  const statuses = c.req.query('status')?.split(',').filter(Boolean) ?? ['active']
  return c.json({ goals: await listRaceGoals(statuses) })
})

raceGoals.post('/', withAuth, async c => {
  let body: Record<string, unknown>
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  const miss = missingField(body, ['name', 'raceDate', 'distanceMeters', 'targetType'])
  if (miss) return c.json({ error: `${miss} is required` }, 400)

  const goalId = await createRaceGoal({
    name: String(body.name),
    raceDate: String(body.raceDate),
    distanceMeters: Number(body.distanceMeters),
    targetType: String(body.targetType),
    targetTimeSec: optionalNumber(body.targetTimeSec) ?? null,
    priority: typeof body.priority === 'string' ? body.priority : undefined,
    status: typeof body.status === 'string' ? body.status : undefined,
    notes: typeof body.notes === 'string' ? body.notes : null,
  })

  await projectFriendProfile()

  return c.json({ goalId })
})

raceGoals.patch('/:id', withAuth, async c => {
  const id = c.req.param('id')
  if (!id) return c.json({ error: 'id is required' }, 400)

  let body: Record<string, unknown>
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  await updateRaceGoal(id, {
    name: typeof body.name === 'string' ? body.name : undefined,
    raceDate: typeof body.raceDate === 'string' ? body.raceDate : undefined,
    distanceMeters: optionalNumber(body.distanceMeters) ?? undefined,
    targetType: typeof body.targetType === 'string' ? body.targetType : undefined,
    targetTimeSec: optionalNumber(body.targetTimeSec),
    priority: typeof body.priority === 'string' ? body.priority : undefined,
    status: typeof body.status === 'string' ? body.status : undefined,
    notes: typeof body.notes === 'string' ? body.notes : body.notes === null ? null : undefined,
  })

  await projectFriendProfile()

  return c.json({ goalId: id })
})

raceGoals.delete('/:id', withAuth, async c => {
  const id = c.req.param('id')
  if (!id) return c.json({ error: 'id is required' }, 400)

  await deleteRaceGoal(id)
  await projectFriendProfile()

  return c.json({ goalId: id })
})

export default raceGoals
