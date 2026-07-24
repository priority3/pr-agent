import { createHash } from 'node:crypto'

import { desc, eq } from 'drizzle-orm'

import {
  buildActivityReviewFeatures,
  buildRecentTrainingContext,
  type ActivityReviewFeatures,
  type RecentTrainingContext,
} from '@/lib/activity/review-features'
import { getActivitiesDb } from '@/lib/db/client'
import { activities } from '@/lib/db/schema'

import { getLatestHealthDailyMetrics, type HealthDailyMetricContext } from './health'
import { listSubjectiveFeedbackForActivity, type SubjectiveFeedbackContext } from './feedback'
import { getRaceGoalContext, type RaceGoalContext } from './race-goals'
import { retrieveKnowledge, type KnowledgeContext } from './rag'
import { getFriendProfile, listContextMemories, type MemoryContext } from './memory'

export const PR_CONTEXT_BUILDER_VERSION = 'pr-context-v1'

export interface CompanionProfileContext {
  displayName: string | null
  companionStyle: string[]
  activeGoals: string[]
  trainingPreferences: string[]
  injuryWatchlist: string[]
  recentState: unknown
  doNotAssume: string[]
  projectionVersion: number
  updatedAt: string | null
}

export interface TrainingHabitSignal {
  type: 'time_of_day' | 'distance_band' | 'recovery_risk'
  label: string
  content: string
  confidence: number
  evidence: Array<{
    source: 'activity' | 'health_daily_metrics' | 'recent_training'
    refId?: string
    quote?: string
    createdAt: string
  }>
}

export interface PrContext {
  activity: ActivityReviewFeatures
  recentTraining: RecentTrainingContext
  raceGoals: RaceGoalContext[]
  healthDailyMetrics: HealthDailyMetricContext[]
  subjectiveFeedback: SubjectiveFeedbackContext[]
  retrievedKnowledge: KnowledgeContext[]
  memoryItems: MemoryContext[]
  companionProfile: CompanionProfileContext
  trainingHabitSignals: TrainingHabitSignal[]
  stateSnapshot: {
    builderVersion: string
    inputHash: string
    memoryVersion: number
    generatedAt: string
  }
  discardedContext: Array<{ type: string; reason: string }>
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`
}

export function hashPrInput(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex')
}

function parseJson(value: string | null | undefined): unknown {
  if (!value) return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function parseStringArray(value: string | null | undefined): string[] {
  const parsed = parseJson(value)
  if (!Array.isArray(parsed)) return []
  return parsed.filter(item => typeof item === 'string' && item.trim().length > 0)
}

export async function buildCompanionProfileContext(): Promise<CompanionProfileContext> {
  const profile = await getFriendProfile()
  if (!profile) {
    return {
      displayName: null,
      companionStyle: [],
      activeGoals: [],
      trainingPreferences: [],
      injuryWatchlist: [],
      recentState: null,
      doNotAssume: [],
      projectionVersion: 0,
      updatedAt: null,
    }
  }

  return {
    displayName: profile.displayName,
    companionStyle: parseStringArray(profile.companionStyleJson),
    activeGoals: parseStringArray(profile.activeGoalsJson),
    trainingPreferences: parseStringArray(profile.trainingPreferencesJson),
    injuryWatchlist: parseStringArray(profile.injuryWatchlistJson),
    recentState: parseJson(profile.recentStateJson),
    doNotAssume: parseStringArray(profile.doNotAssumeJson),
    projectionVersion: profile.projectionVersion,
    updatedAt: profile.updatedAt,
  }
}

function timeBucketLabel(hour: number) {
  if (hour >= 5 && hour < 9) return '清晨'
  if (hour >= 9 && hour < 12) return '上午'
  if (hour >= 12 && hour < 14) return '午间'
  if (hour >= 14 && hour < 18) return '下午'
  if (hour >= 18 && hour < 22) return '晚间'
  return '夜间'
}

function median(values: number[]) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

function activityEvidence(rows: Array<typeof activities.$inferSelect>) {
  return rows.slice(0, 6).map(row => ({
    source: 'activity' as const,
    refId: row.id,
    quote: `${row.title}｜${(Number(row.distance ?? 0) / 1000).toFixed(2)} km｜${row.startTime.toISOString()}`,
    createdAt: row.startTime.toISOString(),
  }))
}

async function buildTrainingHabitSignals(input: {
  activity: ActivityReviewFeatures
  recentTraining: RecentTrainingContext
  healthDailyMetrics: HealthDailyMetricContext[]
}): Promise<TrainingHabitSignal[]> {
  const db = await getActivitiesDb()
  const activityStart = new Date(input.activity.summary.startTime)
  const windowStart = new Date(activityStart)
  windowStart.setDate(windowStart.getDate() - 90)

  const rows = await db
    .select()
    .from(activities)
    .where(eq(activities.type, input.activity.summary.type))
    .orderBy(desc(activities.startTime))
    .limit(120)

  // Exclude the activity being reviewed from its own habit stats (avoid off-by-one).
  const windowRows = rows.filter(row => row.startTime < activityStart && row.startTime >= windowStart)
  const signals: TrainingHabitSignal[] = []

  if (windowRows.length >= 4) {
    const buckets = new Map<string, number>()
    for (const row of windowRows) {
      const label = timeBucketLabel(row.startTime.getHours())
      buckets.set(label, (buckets.get(label) ?? 0) + 1)
    }
    const dominant = Array.from(buckets.entries()).sort((a, b) => b[1] - a[1])[0]
    if (dominant && dominant[1] >= Math.max(3, Math.ceil(windowRows.length * 0.45))) {
      const confidence = Math.min(0.9, 0.58 + dominant[1] / windowRows.length / 2)
      signals.push({
        type: 'time_of_day',
        label: `${dominant[0]}训练偏好`,
        // Content stays count-free so dedup-by-content merges across reviews; counts live in evidence.
        content: `近 90 天 ${input.activity.summary.type} 活动多集中在${dominant[0]}，是一个可持续观察的训练时间习惯。`,
        confidence,
        evidence: activityEvidence(windowRows.filter(row => timeBucketLabel(row.startTime.getHours()) === dominant[0])),
      })
    }

    const distances = windowRows
      .map(row => Number(row.distance ?? 0) / 1000)
      .filter(distanceKm => Number.isFinite(distanceKm) && distanceKm >= 1)
    const medianDistance = median(distances)
    if (medianDistance != null) {
      const roundedMedian = Math.round(medianDistance * 2) / 2
      signals.push({
        type: 'distance_band',
        label: '常见训练距离',
        content: `近 90 天 ${input.activity.summary.type} 活动的常见距离约 ${roundedMedian.toFixed(1)} km，可作为判断本次训练长短的个人基线。`,
        confidence: Math.min(0.86, 0.55 + Math.min(distances.length, 12) / 40),
        evidence: activityEvidence(windowRows),
      })
    }
  }

  const latestHealth = input.healthDailyMetrics[0]
  if (latestHealth?.recoveryLabel === 'poor' && input.recentTraining.activities >= 3) {
    signals.push({
      type: 'recovery_risk',
      label: '恢复与负荷叠加',
      content: `最近恢复状态偏低，叠加近期同类型训练负荷，适合把疲劳风险放进复盘。`,
      confidence: 0.72,
      evidence: [
        {
          source: 'health_daily_metrics',
          refId: latestHealth.id,
          quote: `${latestHealth.date} 恢复状态 ${latestHealth.recoveryLabel}`,
          createdAt: latestHealth.date,
        },
        {
          source: 'recent_training',
          quote: `近 ${input.recentTraining.days} 天 ${input.recentTraining.activities} 次，累计 ${input.recentTraining.distanceKm.toFixed(2)} km`,
          createdAt: input.activity.summary.startTime,
        },
      ],
    })
  }

  return signals
}

export async function buildPrContext(activityId: string): Promise<PrContext | null> {
  const activity = await buildActivityReviewFeatures(activityId)
  if (!activity) return null

  const knowledgeQuery = [
    activity.pace.trend,
    activity.effort.fatigueSignal,
    activity.summary.type,
    activity.moments.map(moment => moment.type).join(' '),
  ].filter(Boolean).join(' ')

  const [recentTraining, subjectiveFeedback, memoryItems, raceGoals, healthDailyMetrics, retrievedKnowledge, companionProfile] =
    await Promise.all([
      buildRecentTrainingContext(activityId, 14),
      listSubjectiveFeedbackForActivity(activityId, 5),
      listContextMemories(8),
      getRaceGoalContext(3),
      getLatestHealthDailyMetrics(7),
      retrieveKnowledge(knowledgeQuery, 3),
      buildCompanionProfileContext(),
    ])
  const trainingHabitSignals = await buildTrainingHabitSignals({ activity, recentTraining, healthDailyMetrics })

  const hashPayload = {
    activity,
    recentTraining,
    raceGoals,
    healthDailyMetrics,
    retrievedKnowledge,
    subjectiveFeedback,
    memoryItems,
    companionProfile,
    trainingHabitSignals,
    builderVersion: PR_CONTEXT_BUILDER_VERSION,
  }
  const inputHash = hashPrInput(hashPayload)
  const memoryVersion = memoryItems.reduce((max, item) => Math.max(max, item.version), 0)

  return {
    activity,
    recentTraining,
    raceGoals,
    healthDailyMetrics,
    subjectiveFeedback,
    retrievedKnowledge,
    memoryItems,
    companionProfile,
    trainingHabitSignals,
    discardedContext: [
      ...(memoryItems.length === 0
        ? [{ type: 'memory', reason: '暂无 active 长期记忆，避免伪造上下文' }]
        : []),
      ...(companionProfile.projectionVersion === 0
        ? [{ type: 'friend_profile', reason: '暂无伙伴画像投影，先只使用事实、反馈和候选习惯信号' }]
        : []),
      ...(trainingHabitSignals.length === 0
        ? [{ type: 'habit_signal', reason: '近期活动样本不足，暂不推断训练习惯' }]
        : []),
      ...(raceGoals.length === 0
        ? [{ type: 'race_goal', reason: '暂无 active 比赛目标，避免编造备赛目标' }]
        : []),
      ...(healthDailyMetrics.length === 0
        ? [{ type: 'health', reason: '暂无恢复数据，避免编造睡眠/HRV/静息心率状态' }]
        : []),
      ...(retrievedKnowledge.length === 0
        ? [{ type: 'rag', reason: '暂无命中的训练知识库条目，训练建议仅基于活动事实' }]
        : []),
    ],
    stateSnapshot: {
      builderVersion: PR_CONTEXT_BUILDER_VERSION,
      inputHash,
      memoryVersion,
      generatedAt: new Date().toISOString(),
    },
  }
}

// 活动记录查询(摘要列/工具执行体)拆到 activity-query.ts(本文件曾逼近 500 行红线);
// 这里 re-export 保持既有 import 路径不变。
export {
  getLatestActivityPerType,
  getRecentActivityContext,
  queryActivityContext,
} from './activity-query'
export type { RecentActivityContext } from './activity-query'

export const PR_DAILY_BUILDER_VERSION = 'pr-daily-v1'

export interface DailyContext {
  date: string
  todayHealth: HealthDailyMetricContext | null
  recentHealth: HealthDailyMetricContext[]
  companionProfile: CompanionProfileContext
  memoryItems: MemoryContext[]
  raceGoals: RaceGoalContext[]
  discardedContext: Array<{ type: string; reason: string }>
  stateSnapshot: {
    builderVersion: string
    inputHash: string
    memoryVersion: number
    generatedAt: string
  }
}

/**
 * Health-driven daily context — does NOT require an activity (Strava may be offline).
 * Assembles recent recovery data + companion profile + active memories + race goals.
 */
export async function buildDailyContext(date: string): Promise<DailyContext> {
  const [recentHealth, companionProfile, memoryItems, raceGoals] = await Promise.all([
    getLatestHealthDailyMetrics(14),
    buildCompanionProfileContext(),
    listContextMemories(8),
    getRaceGoalContext(3),
  ])
  const todayHealth = recentHealth.find(item => item.date === date) ?? recentHealth[0] ?? null
  const memoryVersion = memoryItems.reduce((max, item) => Math.max(max, item.version), 0)

  const inputHash = hashPrInput({
    date,
    todayHealth,
    recentHealth,
    companionProfile,
    memoryItems,
    raceGoals,
    builderVersion: PR_DAILY_BUILDER_VERSION,
  })

  return {
    date,
    todayHealth,
    recentHealth,
    companionProfile,
    memoryItems,
    raceGoals,
    discardedContext: [
      ...(memoryItems.length === 0
        ? [{ type: 'memory', reason: '暂无 active 长期记忆，避免伪造上下文' }]
        : []),
      ...(companionProfile.projectionVersion === 0
        ? [{ type: 'friend_profile', reason: '暂无伙伴画像投影，先只用事实与反馈' }]
        : []),
      ...(raceGoals.length === 0
        ? [{ type: 'race_goal', reason: '暂无 active 比赛目标，避免编造备赛目标' }]
        : []),
      ...(recentHealth.length === 0
        ? [{ type: 'health', reason: '暂无恢复数据，避免编造睡眠/HRV/静息心率状态' }]
        : []),
    ],
    stateSnapshot: {
      builderVersion: PR_DAILY_BUILDER_VERSION,
      inputHash,
      memoryVersion,
      generatedAt: new Date().toISOString(),
    },
  }
}
