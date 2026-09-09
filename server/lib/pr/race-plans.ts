import { createHash } from 'node:crypto'
import { and, asc, eq, inArray } from 'drizzle-orm'

import { getActivitiesDb } from '@/lib/db/client'
import { memoryEvents, memoryItems, raceGoals, racePlans } from '@/lib/db/schema'
import { generateId } from '@/lib/utils'

import { normalizeRaceName, shanghaiDate, type ExtractedRacePlan, type RacePlanEvidence } from './race-plan-extraction'
import type { RaceResearch } from './race-research'
import { adminListRacePlans, adminSaveRaceResearch, adminSyncRacePlans, isAdminDataConfigured } from './race-data-client'

export interface RacePlan extends Omit<ExtractedRacePlan, 'evidence' | 'status'> {
  id: string
  goalId: string | null
  status: string
  evidence: RacePlanEvidence[]
  research: RaceResearch | null
}

function fromRow(row: typeof racePlans.$inferSelect): RacePlan {
  return { ...row, evidence: JSON.parse(row.evidenceJson), research: row.researchJson ? JSON.parse(row.researchJson) : null }
}

export async function listRacePlans(statuses = ['active', 'needs_confirmation']): Promise<RacePlan[]> {
  if (isAdminDataConfigured()) return adminListRacePlans()
  const db = await getActivitiesDb()
  return (await db.select().from(racePlans).where(inArray(racePlans.status, statuses)).orderBy(asc(racePlans.raceDate))).map(fromRow)
}

export async function getRacePlan(id: string): Promise<RacePlan | null> {
  if (isAdminDataConfigured()) return (await adminListRacePlans([id]))[0] ?? null
  const db = await getActivitiesDb()
  const [row] = await db.select().from(racePlans).where(eq(racePlans.id, id))
  return row ? fromRow(row) : null
}

function planContent(plan: Pick<RacePlan, 'name' | 'raceDate' | 'city' | 'distanceMeters' | 'status'>) {
  return `用户${plan.status === 'active' ? '计划参加' : plan.status === 'needs_confirmation' ? '提到待确认赛事' : '赛事计划已结束或取消'}：${plan.name}；日期：${plan.raceDate ?? '待确认'}；地点：${plan.city ?? '待确认'}；距离：${plan.distanceMeters == null ? '待确认' : `${plan.distanceMeters / 1000} 公里`}。赛事官方资料另存，用户陈述不等于官方核验。`
}

/** 计划、正式目标、文字记忆同一事务写入;重放消息不产生重复目标。 */
export async function saveRacePlans(plans: ExtractedRacePlan[], runId?: string): Promise<RacePlan[]> {
  if (isAdminDataConfigured()) return adminSyncRacePlans(plans, runId)
  const db = await getActivitiesDb()
  const ids: string[] = []
  await db.transaction(async tx => {
    for (const plan of plans) {
      const existing = await tx.select().from(racePlans)
      const sameName = existing.filter(row => normalizeRaceName(row.name) === normalizeRaceName(plan.name))
      const exact = sameName.find(row => row.raceDate === plan.raceDate && row.distanceMeters === plan.distanceMeters)
      const pending = sameName.filter(row => row.status === 'needs_confirmation' && (!row.raceDate || row.raceDate === plan.raceDate) && (!row.distanceMeters || row.distanceMeters === plan.distanceMeters))
      const match = exact ?? (plan.status === 'active' && pending.length === 1 ? pending[0] : undefined)
      // 已取消/完成的正式计划不因旧消息重放而重新激活。
      if (match && !['active', 'needs_confirmation'].includes(match.status)) continue
      const identity = JSON.stringify([normalizeRaceName(plan.name), plan.raceDate, plan.distanceMeters])
      const id = match?.id ?? `race_${createHash('sha256').update(identity).digest('hex').slice(0, 24)}`
      const evidence: RacePlanEvidence[] = match ? JSON.parse(match.evidenceJson) : []
      if (!evidence.some(item => item.messageId === plan.evidence.messageId && item.quote === plan.evidence.quote)) evidence.push(plan.evidence)
      let goalId = match?.goalId ?? null
      const status = match?.status === 'active' ? 'active' : plan.status
      if (status === 'active' && plan.raceDate && plan.distanceMeters && !goalId) {
        const goals = await tx.select().from(raceGoals)
        const manualGoal = goals.find(goal => normalizeRaceName(goal.name) === normalizeRaceName(plan.name) && shanghaiDate(goal.raceDate) === plan.raceDate && goal.distanceMeters === plan.distanceMeters)
        if (manualGoal && manualGoal.status !== 'active') continue
        goalId = manualGoal?.id ?? `goal_${id}`
        if (!manualGoal) await tx.insert(raceGoals).values({
          id: goalId, name: plan.name, raceDate: new Date(`${plan.raceDate}T00:00:00+08:00`),
          distanceMeters: plan.distanceMeters, targetType: 'participate', priority: 'secondary',
          notes: '来自用户聊天的参赛计划；未指定成绩目标及主次。',
        })
      }
      const next = { ...plan, status, city: plan.city ?? match?.city ?? null }
      const identityChanged = match && (match.raceDate !== plan.raceDate || match.distanceMeters !== plan.distanceMeters)
      await tx.insert(racePlans).values({
        id, goalId, name: next.name, city: next.city, raceDate: next.raceDate,
        distanceMeters: next.distanceMeters, status, evidenceJson: JSON.stringify(evidence),
      }).onConflictDoUpdate({ target: racePlans.id, set: {
        goalId, city: next.city, raceDate: next.raceDate, distanceMeters: next.distanceMeters,
        status, evidenceJson: JSON.stringify(evidence), updatedAt: new Date(),
        ...(identityChanged ? { researchJson: null } : {}),
      } })
      const memoryId = `mem_${id}`
      const memoryEvidence = evidence.map(item => ({
        source: item.source === 'user_image' ? 'conversation_image' : 'conversation_message',
        refId: item.messageId, quote: item.quote, createdAt: item.messageCreatedAt,
      }))
      const memoryStatus = status === 'active' ? 'active' : 'candidate'
      await tx.insert(memoryItems).values({
        id: memoryId, type: 'goal', status: memoryStatus, content: planContent(next),
        evidenceJson: JSON.stringify(memoryEvidence), confidence: status === 'active' ? 0.9 : 0.6,
        source: 'user', dedupeKey: `race-plan:${id}`,
      }).onConflictDoUpdate({ target: memoryItems.id, set: {
        status: memoryStatus, content: planContent(next), evidenceJson: JSON.stringify(memoryEvidence),
        confidence: status === 'active' ? 0.9 : 0.6, lastSeenAt: new Date(), updatedAt: new Date(),
      } })
      await tx.insert(memoryEvents).values({
        id: generateId('mevt'), memoryId, runId: runId ?? null,
        idempotencyKey: `race-plan:${id}:${plan.evidence.messageId}`,
        action: match ? 'update' : 'create', status: 'applied', actor: 'user',
        patchJson: JSON.stringify(next), reason: '保留单场赛事结构及用户原话；官方资料单独查证。',
      }).onConflictDoNothing()
      ids.push(id)
    }
  })
  return (await Promise.all([...new Set(ids)].map(getRacePlan))).filter((plan): plan is RacePlan => plan !== null)
}

/** 管理端修改/删除目标时同步关联记忆,避免另一份旧日期继续进入聊天。 */
export async function syncRacePlanForGoal(goalId: string, deleted = false) {
  const db = await getActivitiesDb()
  await db.transaction(async tx => {
    const linked = await tx.select().from(racePlans).where(eq(racePlans.goalId, goalId))
    const [goal] = await tx.select().from(raceGoals).where(eq(raceGoals.id, goalId))
    for (const row of linked) {
      const status = deleted || !goal || goal.status !== 'active' ? 'archived' : 'active'
      const next = { ...row, status, ...(goal ? {
        name: goal.name, raceDate: shanghaiDate(goal.raceDate), distanceMeters: goal.distanceMeters,
      } : {}) }
      const changed = next.name !== row.name || next.raceDate !== row.raceDate || next.distanceMeters !== row.distanceMeters
      await tx.update(memoryItems).set({ status: status === 'active' ? 'active' : 'archived', content: planContent(next), updatedAt: new Date() })
        .where(eq(memoryItems.dedupeKey, `race-plan:${row.id}`))
      await tx.update(racePlans).set({
        name: next.name, raceDate: next.raceDate, distanceMeters: next.distanceMeters, status,
        ...(changed ? { researchJson: null } : {}), updatedAt: new Date(),
      }).where(eq(racePlans.id, row.id))
    }
  })
}

export async function saveRaceResearch(plan: RacePlan, research: RaceResearch) {
  if (isAdminDataConfigured()) { await adminSaveRaceResearch(plan.id, research); return }
  const db = await getActivitiesDb()
  // 资料查询期间用户可能改了日期;过期结果不能写回新一届赛事。
  await db.update(racePlans).set({ researchJson: JSON.stringify(research), updatedAt: new Date() })
    .where(and(eq(racePlans.id, plan.id), eq(racePlans.name, plan.name), eq(racePlans.raceDate, plan.raceDate!)))
}
