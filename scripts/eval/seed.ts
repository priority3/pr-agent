import './isolate' // 必须最先 import:隔离到 eval.db

import path from 'node:path'

import { getActivitiesClient, getActivitiesDb } from '@/lib/db/client'
import {
  activities,
  friendProfile,
  memoryItems,
} from '@/lib/db/schema'
import { upsertHealthDailyMetric } from '@/lib/pr/health'
import { createRaceGoal } from '@/lib/pr/race-goals'
import { ingestKnowledgeDocument } from '@/lib/pr/rag'
import { generateId } from '@/lib/utils'

import {
  ACTIVITIES,
  daysAgoAt,
  daysAgoDate,
  FRIEND_PROFILE,
  HEALTH,
  KNOWLEDGE_DOCS,
  MEMORIES,
  RACE_GOAL,
  SEED_VERSION,
  STALE_SHIFT_DAYS,
  type SeedProfile,
} from './dataset'

// 每次全量 seed 前清空的表(顺序照顾外键:子表先删)。
const TABLES_TO_RESET = [
  'agent_state_snapshots',
  'memory_events',
  'conversation_messages',
  'review_annotations',
  'notification_deliveries',
  'rag_retrieval_logs',
  'activity_reviews',
  'splits',
  'subjective_feedback',
  'conversation_threads',
  'agent_runs',
  'activities',
  'health_daily_metrics',
  'race_goals',
  'memory_items',
  'friend_profile',
  'knowledge_embeddings',
  'knowledge_chunks',
  'knowledge_documents',
]

async function resetTables() {
  const client = await getActivitiesClient()
  // 外键在 client.ts 里默认 ON:整表 DELETE 时子表必须先清,否则 set null/cascade 之外的引用会报错。
  await client.execute('PRAGMA foreign_keys = OFF;')
  for (const table of TABLES_TO_RESET) {
    try {
      await client.execute(`DELETE FROM ${table}`)
    } catch (error) {
      // 表可能尚未建(首次冷启动 ensureActivitiesSchema 之后就都在了)——忽略缺表
      console.warn(`[seed] 清表 ${table} 跳过:`, (error as Error).message)
    }
  }
  await client.execute('PRAGMA foreign_keys = ON;')
}

export interface SeedResult {
  version: string
  activities: number
  healthDays: number
  raceGoals: number
  memories: number
  knowledgeDocs: number
}

export async function seed(profile: SeedProfile = 'default'): Promise<SeedResult> {
  const db = await getActivitiesDb() // 触发 ensureActivitiesSchema(建全套表)
  await resetTables()

  // 空库新用户档:只留称呼,零数据/零记忆/零目标。
  if (profile === 'empty') {
    await db.insert(friendProfile).values({
      id: generateId('profile'),
      displayName: FRIEND_PROFILE.displayName,
      companionStyleJson: '[]',
      activeGoalsJson: '[]',
      trainingPreferencesJson: '[]',
      injuryWatchlistJson: '[]',
      doNotAssumeJson: '[]',
      projectionVersion: 1,
    })
    return { version: `${SEED_VERSION}:empty`, activities: 0, healthDays: 0, raceGoals: 0, memories: 0, knowledgeDocs: 0 }
  }

  // stale 档:同一批数据整体后移,制造「比赛临近但两个多月没练」的真实状态。
  const shift = profile === 'stale' ? STALE_SHIFT_DAYS : 0

  // ── 运动记录 ──
  for (const a of ACTIVITIES) {
    const start = daysAgoAt(a.daysAgo + shift, a.hour)
    const durationSec = a.paceSecPerKm
      ? Math.round(a.distanceKm * a.paceSecPerKm)
      : Math.round((a.distanceKm / 25) * 3600) // 骑行/步行按 25km/h 粗估时长
    await db.insert(activities).values({
      id: generateId('act'),
      title: a.title,
      type: a.type,
      source: 'seed',
      sourceId: `seed-${a.key}`,
      startTime: start,
      endTime: new Date(start.getTime() + durationSec * 1000),
      duration: durationSec,
      distance: a.distanceKm * 1000,
      averagePace: a.paceSecPerKm,
      averageHeartRate: a.avgHr,
      maxHeartRate: a.maxHr,
      // 供「复盘过去某天」用例:当次实测天气/爬升/路线(仅个别条目带,与生产回填字段同构)
      elevationGain: a.elevationGain ?? null,
      weatherData: a.weatherData ? JSON.stringify(a.weatherData) : null,
      routeCoordinates: a.routeCoordinates ? JSON.stringify(a.routeCoordinates) : null,
    })
  }

  // ── 每日健康(复用 upsert,顺带产出正确 recoveryLabel) ──
  for (const h of HEALTH) {
    await upsertHealthDailyMetric({
      date: daysAgoDate(h.daysAgo + shift),
      sleepMinutes: h.sleepMinutes,
      deepSleepMinutes: h.deepSleepMinutes,
      remSleepMinutes: h.remSleepMinutes,
      hrv: h.hrv,
      restingHr: h.restingHr,
      steps: h.steps,
      envAudioDb: h.envAudioDb,
      source: 'seed',
    })
  }

  // ── 比赛目标 ──
  await createRaceGoal({
    name: RACE_GOAL.name,
    raceDate: daysAgoAt(-RACE_GOAL.daysUntil, 8), // 负天数 = 未来
    distanceMeters: RACE_GOAL.distanceMeters,
    targetType: RACE_GOAL.targetType,
    targetTimeSec: RACE_GOAL.targetTimeSec,
    priority: RACE_GOAL.priority,
    notes: RACE_GOAL.notes,
  })

  // ── 伙伴画像 ──
  await db.insert(friendProfile).values({
    id: generateId('profile'),
    displayName: FRIEND_PROFILE.displayName,
    companionStyleJson: JSON.stringify(FRIEND_PROFILE.companionStyle),
    activeGoalsJson: JSON.stringify(FRIEND_PROFILE.activeGoals),
    trainingPreferencesJson: JSON.stringify(FRIEND_PROFILE.trainingPreferences),
    injuryWatchlistJson: JSON.stringify(FRIEND_PROFILE.injuryWatchlist),
    doNotAssumeJson: JSON.stringify(FRIEND_PROFILE.doNotAssume),
    projectionVersion: FRIEND_PROFILE.projectionVersion,
  })

  // ── 长期记忆(直接 active) ──
  for (const m of MEMORIES) {
    await db.insert(memoryItems).values({
      id: generateId('mem'),
      type: m.type,
      status: 'active',
      content: m.content,
      evidenceJson: '[]',
      confidence: m.confidence,
      source: 'seed',
    })
  }

  // ── 知识库(含一条注入载荷) ──
  for (const doc of KNOWLEDGE_DOCS) {
    await ingestKnowledgeDocument({ title: doc.title, source: doc.source, content: doc.content })
  }

  return {
    version: shift ? `${SEED_VERSION}:stale` : SEED_VERSION,
    activities: ACTIVITIES.length,
    healthDays: HEALTH.length,
    raceGoals: 1,
    memories: MEMORIES.length,
    knowledgeDocs: KNOWLEDGE_DOCS.length,
  }
}

// 允许 `bun run scripts/eval/seed.ts` 单独跑(手动重置种子)
// Reason: 不用 Bun 专有的 import.meta.main —— @types/node 没这个字段,tsc 会红。
const isDirectRun = Boolean(process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename)
if (isDirectRun) {
  seed()
    .then(result => {
      console.log('[seed] 完成:', JSON.stringify(result))
      process.exit(0)
    })
    .catch(error => {
      console.error('[seed] 失败:', error)
      process.exit(1)
    })
}
