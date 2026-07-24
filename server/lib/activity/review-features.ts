import { and, desc, eq, lt } from 'drizzle-orm'

import { getActivitiesDb } from '@/lib/db/client'
import { activities, splits } from '@/lib/db/schema'

export const ACTIVITY_REVIEW_FEATURES_VERSION = 1

export interface ReviewMoment {
  type: 'surge' | 'slowdown' | 'high_hr' | 'strong_finish' | 'hr_drift' | 'weather_note'
  kilometer?: number
  label: string
  content: string
  confidence: number
}

export interface ActivityReviewFeatures {
  version: number
  summary: {
    activityId: string
    title: string
    type: string
    startTime: string
    distanceKm: number
    durationSec: number
    averagePaceSecPerKm: number | null
    averageHeartRate: number | null
    maxHeartRate: number | null
    elevationGain: number | null
    weatherDescription: string | null
  }
  pace: {
    trend: 'negative_split' | 'positive_split' | 'steady' | 'unknown'
    fastestKm: number | null
    slowestKm: number | null
    firstHalfAvgPace: number | null
    secondHalfAvgPace: number | null
  }
  effort: {
    fatigueSignal: 'low' | 'medium' | 'high' | 'unknown'
    heartRateNote: string | null
  }
  splits: Array<{
    kilometer: number
    distance: number
    duration: number
    pace: number
    averageHeartRate: number | null
  }>
  moments: ReviewMoment[]
}

export interface RecentTrainingContext {
  days: number
  activities: number
  distanceKm: number
  durationSec: number
  longestDistanceKm: number
  latestActivityAt: string | null
}

interface WeatherPayload {
  description?: string
  temperature?: number
  humidity?: number
  windSpeed?: number
}

function avg(values: number[]) {
  if (values.length === 0) return null
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function parseWeatherDescription(weatherData: string | null) {
  if (!weatherData) return null
  try {
    const weather = JSON.parse(weatherData) as WeatherPayload
    const parts = [
      weather.description,
      typeof weather.temperature === 'number' ? `${Math.round(weather.temperature)}°C` : null,
      typeof weather.humidity === 'number' ? `湿度 ${Math.round(weather.humidity)}%` : null,
      typeof weather.windSpeed === 'number' ? `风 ${Math.round(weather.windSpeed)} km/h` : null,
    ].filter(Boolean)
    return parts.length > 0 ? parts.join('，') : null
  } catch {
    return null
  }
}

function classifyPaceTrend(firstHalfAvgPace: number | null, secondHalfAvgPace: number | null) {
  if (!firstHalfAvgPace || !secondHalfAvgPace) return 'unknown'
  const diff = secondHalfAvgPace - firstHalfAvgPace
  if (diff <= -15) return 'negative_split'
  if (diff >= 15) return 'positive_split'
  return 'steady'
}

function buildMoments(input: {
  splitRows: ActivityReviewFeatures['splits']
  trend: ActivityReviewFeatures['pace']['trend']
  averageHeartRate: number | null
  maxHeartRate: number | null
  weatherDescription: string | null
}) {
  const { splitRows, trend, averageHeartRate, maxHeartRate, weatherDescription } = input
  const moments: ReviewMoment[] = []
  const validPaceSplits = splitRows.filter(split => split.pace > 0)

  if (validPaceSplits.length > 0) {
    const fastest = validPaceSplits.reduce((best, split) => (split.pace < best.pace ? split : best))
    const slowest = validPaceSplits.reduce((worst, split) => (split.pace > worst.pace ? split : worst))
    const allPaces = validPaceSplits.map(split => split.pace)
    const averagePace = avg(allPaces) ?? 0

    if (averagePace > 0 && fastest.pace <= averagePace - 20) {
      moments.push({
        type: 'surge',
        kilometer: fastest.kilometer,
        label: `第 ${fastest.kilometer} 公里提速`,
        content: `这一公里明显快于全程均值，是本次活动里最突出的提速点。`,
        confidence: 0.78,
      })
    }

    if (averagePace > 0 && slowest.pace >= averagePace + 25 && validPaceSplits.length >= 3) {
      moments.push({
        type: 'slowdown',
        kilometer: slowest.kilometer,
        label: `第 ${slowest.kilometer} 公里放缓`,
        content: `这一公里慢于全程均值，可能是补给、路况、爬升或疲劳造成的节奏变化。`,
        confidence: 0.7,
      })
    }

    const lastSplit = validPaceSplits.at(-1)
    if (lastSplit && trend === 'negative_split') {
      moments.push({
        type: 'strong_finish',
        kilometer: lastSplit.kilometer,
        label: '后程收得不错',
        content: `后半程配速快于前半程，说明这次节奏控制比较稳。`,
        confidence: 0.82,
      })
    }
  }

  if (averageHeartRate && maxHeartRate && maxHeartRate - averageHeartRate >= 28) {
    moments.push({
      type: 'high_hr',
      label: '心率峰值偏高',
      content: `最高心率比平均心率高出 ${maxHeartRate - averageHeartRate} bpm，需要结合当时路段和体感判断是否是冲刺或爬升。`,
      confidence: 0.72,
    })
  }

  if (weatherDescription) {
    moments.push({
      type: 'weather_note',
      label: '天气上下文',
      content: `本次天气为 ${weatherDescription}，复盘节奏时需要把外部条件一起算进去。`,
      confidence: 0.68,
    })
  }

  return moments.slice(0, 5)
}

export async function buildActivityReviewFeatures(activityId: string): Promise<ActivityReviewFeatures | null> {
  const db = await getActivitiesDb()
  const activityRows = await db.select().from(activities).where(eq(activities.id, activityId)).limit(1)
  const activity = activityRows[0]
  if (!activity) return null

  const splitRows = await db
    .select()
    .from(splits)
    .where(eq(splits.activityId, activityId))
    .orderBy(splits.kilometer)

  const normalizedSplits = splitRows.map(split => ({
    kilometer: Number(split.kilometer),
    distance: Number(split.distance ?? 0),
    duration: Number(split.duration ?? 0),
    pace: Number(split.pace ?? 0),
    averageHeartRate: split.averageHeartRate == null ? null : Number(split.averageHeartRate),
  }))

  const validPaceSplits = normalizedSplits.filter(split => split.pace > 0)
  const halfIndex = validPaceSplits.length > 1 ? Math.floor(validPaceSplits.length / 2) : 0
  const firstHalfAvgPace = halfIndex > 0 ? avg(validPaceSplits.slice(0, halfIndex).map(split => split.pace)) : null
  const secondHalfAvgPace =
    halfIndex > 0 ? avg(validPaceSplits.slice(halfIndex).map(split => split.pace)) : null
  const trend = classifyPaceTrend(firstHalfAvgPace, secondHalfAvgPace)
  const fastest = validPaceSplits.length
    ? validPaceSplits.reduce((best, split) => (split.pace < best.pace ? split : best))
    : null
  const slowest = validPaceSplits.length
    ? validPaceSplits.reduce((worst, split) => (split.pace > worst.pace ? split : worst))
    : null
  const weatherDescription = parseWeatherDescription(activity.weatherData)
  const averageHeartRate = activity.averageHeartRate == null ? null : Number(activity.averageHeartRate)
  const maxHeartRate = activity.maxHeartRate == null ? null : Number(activity.maxHeartRate)
  const heartRateNote =
    averageHeartRate && maxHeartRate
      ? `平均 ${averageHeartRate} bpm，最高 ${maxHeartRate} bpm`
      : averageHeartRate
        ? `平均 ${averageHeartRate} bpm`
        : null
  const fatigueSignal =
    trend === 'positive_split' && averageHeartRate && maxHeartRate && maxHeartRate - averageHeartRate >= 25
      ? 'high'
      : trend === 'positive_split'
        ? 'medium'
        : trend === 'negative_split' || trend === 'steady'
          ? 'low'
          : 'unknown'

  return {
    version: ACTIVITY_REVIEW_FEATURES_VERSION,
    summary: {
      activityId: activity.id,
      title: activity.title,
      type: activity.type,
      startTime: activity.startTime.toISOString(),
      distanceKm: Number((Number(activity.distance ?? 0) / 1000).toFixed(2)),
      durationSec: Number(activity.duration ?? 0),
      averagePaceSecPerKm: activity.averagePace == null ? null : Number(activity.averagePace),
      averageHeartRate,
      maxHeartRate,
      elevationGain: activity.elevationGain == null ? null : Number(activity.elevationGain),
      weatherDescription,
    },
    pace: {
      trend,
      fastestKm: fastest?.kilometer ?? null,
      slowestKm: slowest?.kilometer ?? null,
      firstHalfAvgPace,
      secondHalfAvgPace,
    },
    effort: {
      fatigueSignal,
      heartRateNote,
    },
    splits: normalizedSplits,
    moments: buildMoments({
      splitRows: normalizedSplits,
      trend,
      averageHeartRate,
      maxHeartRate,
      weatherDescription,
    }),
  }
}

export async function buildRecentTrainingContext(
  activityId: string,
  days = 14,
): Promise<RecentTrainingContext> {
  const db = await getActivitiesDb()
  const activityRows = await db.select().from(activities).where(eq(activities.id, activityId)).limit(1)
  const activity = activityRows[0]
  if (!activity) {
    return { days, activities: 0, distanceKm: 0, durationSec: 0, longestDistanceKm: 0, latestActivityAt: null }
  }

  const startAt = new Date(activity.startTime)
  startAt.setDate(startAt.getDate() - days)
  const rows = await db
    .select()
    .from(activities)
    .where(and(lt(activities.startTime, activity.startTime), eq(activities.type, activity.type)))
    .orderBy(desc(activities.startTime))
    .limit(60)

  const recentRows = rows.filter(row => row.startTime >= startAt)
  const distance = recentRows.reduce((sum, row) => sum + Number(row.distance ?? 0), 0)
  const duration = recentRows.reduce((sum, row) => sum + Number(row.duration ?? 0), 0)
  const longest = recentRows.reduce((max, row) => Math.max(max, Number(row.distance ?? 0)), 0)

  return {
    days,
    activities: recentRows.length,
    distanceKm: Number((distance / 1000).toFixed(2)),
    durationSec: duration,
    longestDistanceKm: Number((longest / 1000).toFixed(2)),
    latestActivityAt: recentRows[0]?.startTime.toISOString() ?? null,
  }
}
