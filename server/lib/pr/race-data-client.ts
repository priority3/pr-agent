import type { ExtractedRacePlan } from './race-plan-extraction'
import type { RaceResearch } from './race-research'
import type { RacePlan } from './race-plans'
import type { RaceGoalContext } from './race-goals'

function baseUrl() {
  return (process.env.RUNPACEFLOW_ADMIN_URL || process.env.PR_DATA_API_URL || '').trim().replace(/\/$/, '')
}

export function isAdminDataConfigured() {
  return Boolean(baseUrl() && process.env.PR_AGENT_DATA_TOKEN)
}

function headers() {
  return { Authorization: `Bearer ${process.env.PR_AGENT_DATA_TOKEN}`, 'Content-Type': 'application/json' }
}

async function request(path: string, init: RequestInit = {}) {
  const response = await fetch(`${baseUrl()}${path}`, { ...init, headers: { ...headers(), ...(init.headers ?? {}) }, signal: AbortSignal.timeout(12_000) })
  if (!response.ok) throw new Error(`admin 数据 API ${path} 返回 ${response.status}`)
  return response
}

export async function adminListRacePlans(ids?: string[]): Promise<RacePlan[]> {
  const query = ids?.length ? `?${ids.map(id => `id=${encodeURIComponent(id)}`).join('&')}` : ''
  const result = await (await request(`/api/pr-data/race-plans${query}`)).json() as { plans: RacePlan[] }
  return result.plans ?? []
}

export async function adminListRaceGoals(): Promise<RaceGoalContext[]> {
  const result = await (await request('/api/pr-data/race-goals?status=active')).json() as { goals: Array<Record<string, unknown>> }
  return (result.goals ?? []).map(goal => ({
    id: String(goal.id), name: String(goal.name), raceDate: new Date(String(goal.raceDate)).toISOString(),
    distanceMeters: Number(goal.distanceMeters), targetType: String(goal.targetType),
    targetTimeSec: goal.targetTimeSec == null ? null : Number(goal.targetTimeSec), priority: String(goal.priority), status: String(goal.status), notes: goal.notes == null ? null : String(goal.notes),
    daysUntilRace: Math.ceil((new Date(String(goal.raceDate)).getTime() - Date.now()) / 86_400_000), phase: 'base', phaseLabel: '基础期',
  }))
}

export async function adminSyncRacePlans(plans: ExtractedRacePlan[], runId?: string): Promise<RacePlan[]> {
  const payload = { runId: runId ?? null, plans: plans.map(plan => ({
    name: plan.name, city: plan.city, raceDate: plan.raceDate, distanceMeters: plan.distanceMeters,
    status: plan.status, evidence: plan.evidence,
  })) }
  const result = await (await request('/api/pr-data/race-plans', { method: 'POST', body: JSON.stringify(payload) })).json() as { plans: RacePlan[] }
  return result.plans ?? []
}

export async function adminSaveRaceResearch(id: string, research: RaceResearch): Promise<RacePlan | null> {
  const result = await (await request(`/api/pr-data/race-plans/${encodeURIComponent(id)}/research`, { method: 'POST', body: JSON.stringify(research) })).json() as { plan?: RacePlan }
  return result.plan ?? null
}
