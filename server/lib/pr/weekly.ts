import { createHash } from 'node:crypto'

import { and, desc, gte, lte, eq } from 'drizzle-orm'

import { getActivitiesDb } from '@/lib/db/client'
import {
  activities,
  activityReviews,
  agentRuns,
  agentStateSnapshots,
  friendDiaryEntries,
  notificationDeliveries,
  subjectiveFeedback,
} from '@/lib/db/schema'
import { generateId } from '@/lib/utils'

import { getLatestHealthDailyMetrics } from './health'
import { getRecentLifeEvents } from './life-events'
import { listContextMemories, projectFriendProfile } from './memory'
import { getRaceGoalContext } from './race-goals'

const WEEKLY_BUILDER_VERSION = 'pr-weekly-context-v1'
const WEEKLY_PROMPT_VERSION = 'pr-weekly-rule-v1'

interface WeeklyActivityContext {
  id: string
  title: string
  type: string
  startTime: string
  distanceKm: number
  durationSec: number
  averagePaceSecPerKm: number | null
  averageHeartRate: number | null
}

interface WeeklyContext {
  periodStart: string
  periodEnd: string
  activities: WeeklyActivityContext[]
  totals: {
    activities: number
    distanceKm: number
    durationSec: number
    longestDistanceKm: number
    runningDistanceKm: number
    cyclingDistanceKm: number
  }
  raceGoals: Awaited<ReturnType<typeof getRaceGoalContext>>
  healthDailyMetrics: Awaited<ReturnType<typeof getLatestHealthDailyMetrics>>
  lifeEvents: Awaited<ReturnType<typeof getRecentLifeEvents>>
  memoryItems: Awaited<ReturnType<typeof listContextMemories>>
  feedback: Array<{
    id: string
    activityId: string | null
    rpe: number | null
    mood: string | null
    note: string | null
    createdAt: string
  }>
}

function serialize(value: unknown) {
  return JSON.stringify(value)
}

function hashInput(value: unknown) {
  return createHash('sha256').update(serialize(value)).digest('hex')
}

function toIso(value: Date | string | number) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function formatDuration(seconds: number) {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (h > 0) return `${h}小时${m}分`
  return `${m}分钟`
}

async function writeSnapshot(runId: string, step: string, state: unknown) {
  const db = await getActivitiesDb()
  await db.insert(agentStateSnapshots).values({
    id: generateId('snap'),
    runId,
    step,
    stateJson: serialize(state),
  })
}

function currentWeekRange(now = new Date()) {
  const end = new Date(now)
  end.setHours(23, 59, 59, 999)

  const start = new Date(now)
  const day = start.getDay() || 7
  start.setDate(start.getDate() - day + 1)
  start.setHours(0, 0, 0, 0)

  return { start, end }
}

function weekId(start: Date) {
  const year = start.getFullYear()
  const firstDay = new Date(year, 0, 1)
  const pastDays = Math.floor((start.getTime() - firstDay.getTime()) / 86_400_000)
  const week = Math.ceil((pastDays + firstDay.getDay() + 1) / 7)
  return `${year}-W${String(week).padStart(2, '0')}`
}

async function buildWeeklyContext(start: Date, end: Date): Promise<WeeklyContext> {
  const db = await getActivitiesDb()
  const rows = await db
    .select()
    .from(activities)
    .where(and(gte(activities.startTime, start), lte(activities.startTime, end)))
    .orderBy(desc(activities.startTime))

  const activityContexts = rows.map(row => ({
    id: row.id,
    title: row.title,
    type: row.type,
    startTime: row.startTime.toISOString(),
    distanceKm: Number((Number(row.distance ?? 0) / 1000).toFixed(2)),
    durationSec: Number(row.duration ?? 0),
    averagePaceSecPerKm: row.averagePace == null ? null : Number(row.averagePace),
    averageHeartRate: row.averageHeartRate == null ? null : Number(row.averageHeartRate),
  }))

  const feedbackRows = await db
    .select()
    .from(subjectiveFeedback)
    .where(and(gte(subjectiveFeedback.createdAt, start), lte(subjectiveFeedback.createdAt, end)))
    .orderBy(desc(subjectiveFeedback.createdAt))
    .limit(12)

  const totals = {
    activities: activityContexts.length,
    distanceKm: Number(activityContexts.reduce((sum, row) => sum + row.distanceKm, 0).toFixed(2)),
    durationSec: activityContexts.reduce((sum, row) => sum + row.durationSec, 0),
    longestDistanceKm: Number(activityContexts.reduce((max, row) => Math.max(max, row.distanceKm), 0).toFixed(2)),
    runningDistanceKm: Number(activityContexts.filter(row => row.type === 'running').reduce((sum, row) => sum + row.distanceKm, 0).toFixed(2)),
    cyclingDistanceKm: Number(activityContexts.filter(row => row.type === 'cycling').reduce((sum, row) => sum + row.distanceKm, 0).toFixed(2)),
  }

  const [raceGoals, healthDailyMetrics, lifeEvents, memoryItems] = await Promise.all([
    getRaceGoalContext(3),
    getLatestHealthDailyMetrics(7),
    getRecentLifeEvents(7, 8),
    listContextMemories(8),
  ])

  return {
    periodStart: start.toISOString(),
    periodEnd: end.toISOString(),
    activities: activityContexts,
    totals,
    raceGoals,
    healthDailyMetrics,
    lifeEvents,
    memoryItems,
    feedback: feedbackRows.map(row => ({
      id: row.id,
      activityId: row.activityId,
      rpe: row.rpe == null ? null : Number(row.rpe),
      mood: row.mood,
      note: row.note,
      createdAt: row.createdAt.toISOString(),
    })),
  }
}

function buildWeeklyReviewContent(context: WeeklyContext) {
  const latestGoal = context.raceGoals[0]
  const latestHealth = context.healthDailyMetrics[0]
  const lastActivity = context.activities[0]
  const feedback = context.feedback[0]
  const lifeEvent = context.lifeEvents[0]
  const goalText = latestGoal
    ? `离 **${latestGoal.name}** 还有 ${latestGoal.daysUntilRace} 天，这周的训练可以继续围绕这个目标做连续性建设。`
    : '这周还没有明确 active 比赛目标，复盘先以训练连续性和恢复状态为主。'
  const healthText = latestHealth
    ? `最近恢复记录里，${latestHealth.date} 的状态是 **${latestHealth.recoveryLabel}**，睡眠 ${latestHealth.sleepMinutes ?? '未知'} 分钟。`
    : '恢复数据暂时还少，所以这周不硬判断睡眠或 HRV 趋势。'
  const feedbackText = feedback
    ? `你本周补过主观反馈：${[feedback.rpe ? `RPE ${feedback.rpe}/10` : null, feedback.mood, feedback.note].filter(Boolean).join('，')}。`
    : ''
  const lifeText = lifeEvent?.observation?.summary
    ? `最近生活记录里有一条观察：${String(lifeEvent.observation.summary)}。`
    : ''

  return `这周一共记录 **${context.totals.activities} 次**活动，累计 **${context.totals.distanceKm.toFixed(2)} km**，总时长 **${formatDuration(context.totals.durationSec)}**，最长单次 **${context.totals.longestDistanceKm.toFixed(2)} km**。${lastActivity ? `最近一次是 ${lastActivity.title}，${lastActivity.distanceKm.toFixed(2)} km。` : ''}

${goalText}${healthText}${feedbackText}${lifeText}

下一步建议先守住节奏：如果恢复状态偏弱，优先轻松跑或休息；如果状态稳定，再把一节质量训练放到身体最松的那天。`
}

function buildDiaryContent(context: WeeklyContext) {
  const goal = context.raceGoals[0]
  const health = context.healthDailyMetrics[0]
  const lifeEvent = context.lifeEvents[0]
  const memoryLine = context.memoryItems.slice(0, 3).map(memory => memory.content).join('；')

  return [
    `${context.periodStart.slice(0, 10)} 到 ${context.periodEnd.slice(0, 10)}：本周 ${context.totals.activities} 次活动，${context.totals.distanceKm.toFixed(2)} km。`,
    goal ? `当前目标 ${goal.name} 进入倒计时 ${goal.daysUntilRace} 天。` : '当前没有明确 active 比赛目标。',
    health ? `最近恢复标签是 ${health.recoveryLabel}，后续复盘需要继续观察睡眠/HRV 是否稳定。` : '恢复数据不足，后续不要直接推断睡眠状态。',
    lifeEvent?.observation?.summary ? `生活观察：${String(lifeEvent.observation.summary)}。` : '本周暂无生活观察输入。',
    memoryLine ? `需要延续的长期上下文：${memoryLine}。` : '长期记忆还少，先以事实复盘为主。',
  ].join('\n')
}

export async function generateWeeklyReview(options: {
  force?: boolean
  enqueueNotification?: boolean
  now?: Date
} = {}) {
  const db = await getActivitiesDb()
  const { start, end } = currentWeekRange(options.now)
  const subjectId = weekId(start)
  const context = await buildWeeklyContext(start, end)
  const inputHash = hashInput({ context, builderVersion: WEEKLY_BUILDER_VERSION })

  const currentRows = await db
    .select()
    .from(activityReviews)
    .where(
      and(
        eq(activityReviews.kind, 'pr_weekly_review'),
        eq(activityReviews.subjectType, 'week'),
        eq(activityReviews.subjectId, subjectId),
        eq(activityReviews.isCurrent, true),
      ),
    )
    .limit(1)

  if (currentRows[0] && !options.force && currentRows[0].inputHash === inputHash) {
    return { reviewId: currentRows[0].id, diaryId: null, generated: false, subjectId }
  }

  const runId = generateId('run')
  const runInputHash = options.force ? `${inputHash}:regenerated:${Date.now().toString(36)}` : inputHash
  await db.insert(agentRuns).values({
    id: runId,
    idempotencyKey: `weekly_review:week:${subjectId}:${runInputHash}`,
    trigger: 'weekly_review',
    subjectType: 'week',
    subjectId,
    status: 'running',
    inputHash,
    builderVersion: WEEKLY_BUILDER_VERSION,
    attempts: 1,
    lastStep: 'build_context',
    startedAt: new Date(),
  }).onConflictDoNothing()

  await writeSnapshot(runId, 'build_context', { context, inputHash: runInputHash })

  try {
    const content = buildWeeklyReviewContent(context)
    const diaryContent = buildDiaryContent(context)
    const reviewId = generateId('review')
    const diaryId = generateId('diary')

    for (const row of currentRows) {
      await db
        .update(activityReviews)
        .set({ isCurrent: false, supersededBy: reviewId, updatedAt: new Date() })
        .where(eq(activityReviews.id, row.id))
    }

    await db.insert(activityReviews).values({
      id: reviewId,
      runId,
      subjectType: 'week',
      subjectId,
      kind: 'pr_weekly_review',
      status: 'generated',
      featuresJson: serialize(context.totals),
      contextJson: serialize(context),
      content,
      model: 'rule-based-weekly-v1',
      provider: 'local-rule',
      inputHash: runInputHash,
      builderVersion: WEEKLY_BUILDER_VERSION,
      promptVersion: WEEKLY_PROMPT_VERSION,
      isCurrent: true,
    })

    await db.insert(friendDiaryEntries).values({
      id: diaryId,
      periodStart: start,
      periodEnd: end,
      content: diaryContent,
      observationsJson: serialize({
        totals: context.totals,
        raceGoals: context.raceGoals,
        latestHealth: context.healthDailyMetrics[0] ?? null,
        lifeEvents: context.lifeEvents,
      }),
      memoryPatchesJson: serialize([]),
      model: 'rule-based-diary-v1',
    })

    if (options.enqueueNotification !== false) {
      await db.insert(notificationDeliveries).values({
        id: generateId('noti'),
        reviewId,
        channel: 'pushplus',
        recipient: 'default',
        title: `PR 周总结：${subjectId}`,
        content,
        payloadJson: serialize({ subjectId, inputHash: runInputHash }),
        status: 'pending',
      }).onConflictDoNothing()
    }

    await db
      .update(agentRuns)
      .set({
        status: 'succeeded',
        model: 'rule-based-weekly-v1',
        lastStep: 'persist_output',
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(agentRuns.id, runId))

    await writeSnapshot(runId, 'persist_output', { reviewId, diaryId })
    await projectFriendProfile()

    return { reviewId, diaryId, generated: true, subjectId }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    await db
      .update(agentRuns)
      .set({
        status: 'failed',
        errorCode: 'weekly_review_failed',
        errorMessage,
        lastStep: 'persist_output',
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(agentRuns.id, runId))
    await writeSnapshot(runId, 'failed', { errorMessage })
    throw error
  }
}

export async function listFriendDiaryEntries(limit = 20) {
  const db = await getActivitiesDb()
  const rows = await db.select().from(friendDiaryEntries).orderBy(desc(friendDiaryEntries.createdAt)).limit(limit)
  return rows.map(row => ({
    id: row.id,
    periodStart: toIso(row.periodStart),
    periodEnd: toIso(row.periodEnd),
    content: row.content,
    observations: row.observationsJson ? JSON.parse(row.observationsJson) : null,
    model: row.model,
    createdAt: toIso(row.createdAt),
  }))
}
