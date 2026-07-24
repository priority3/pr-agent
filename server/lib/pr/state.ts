import { and, desc, eq, lt } from 'drizzle-orm'

import { getActivitiesDb } from '@/lib/db/client'
import { activityReviews, agentRuns, agentStateSnapshots } from '@/lib/db/schema'

function toIso(value: Date | string | number | null) {
  if (!value) return null
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

const STALE_RUN_MINUTES = 15

/**
 * 编排状态机可恢复(务实版)。同步管线里一个 run 若进程中途崩溃,会永远停在 status='running'。
 * 启动时把超过阈值仍 running 的孤儿 run 收回为 failed(errorCode='stale_reclaimed'),
 * 让它们不再永久占着"运行中"、并在 Dashboard / trace 里可见。
 *
 * Reason: cron 型 run(review/daily/weekly)靠 input_hash 幂等,下次调度 tick 会重新生成缺失产出;
 * 因此这里只做 reclaim + 依赖幂等重跑,不做逐 step 的状态恢复(同步请求内管线不支持中途续跑)。
 */
export async function reclaimStaleRuns(staleMinutes = STALE_RUN_MINUTES): Promise<number> {
  const db = await getActivitiesDb()
  const cutoff = new Date(Date.now() - staleMinutes * 60_000)
  const stale = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(and(eq(agentRuns.status, 'running'), lt(agentRuns.startedAt, cutoff)))
    .limit(200)
  for (const row of stale) {
    // 再次带 status='running' 条件更新,避免与刚好完成的 run 抢写。
    await db
      .update(agentRuns)
      .set({
        status: 'failed',
        errorCode: 'stale_reclaimed',
        errorMessage: `运行超过 ${staleMinutes} 分钟未完成，判定为进程中断的孤儿 run，已收回。`,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(agentRuns.id, row.id), eq(agentRuns.status, 'running')))
  }
  return stale.length
}

export async function listAgentRuns(limit = 30) {
  const db = await getActivitiesDb()
  const rows = await db.select().from(agentRuns).orderBy(desc(agentRuns.createdAt)).limit(limit)
  return rows.map(row => ({
    id: row.id,
    trigger: row.trigger,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    status: row.status,
    inputHash: row.inputHash,
    builderVersion: row.builderVersion,
    model: row.model,
    attempts: row.attempts,
    lastStep: row.lastStep,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    startedAt: toIso(row.startedAt),
    completedAt: toIso(row.completedAt),
    createdAt: toIso(row.createdAt),
  }))
}

export async function getAgentRunDetail(runId: string) {
  const db = await getActivitiesDb()
  const runs = await db.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1)
  const run = runs[0]
  if (!run) return null

  const snapshots = await db
    .select()
    .from(agentStateSnapshots)
    .where(eq(agentStateSnapshots.runId, runId))
    .orderBy(desc(agentStateSnapshots.createdAt))

  const reviews = await db
    .select()
    .from(activityReviews)
    .where(eq(activityReviews.runId, runId))
    .orderBy(desc(activityReviews.createdAt))

  return {
    run: {
      id: run.id,
      trigger: run.trigger,
      subjectType: run.subjectType,
      subjectId: run.subjectId,
      status: run.status,
      inputHash: run.inputHash,
      builderVersion: run.builderVersion,
      model: run.model,
      attempts: run.attempts,
      lastStep: run.lastStep,
      errorCode: run.errorCode,
      errorMessage: run.errorMessage,
      startedAt: toIso(run.startedAt),
      completedAt: toIso(run.completedAt),
      createdAt: toIso(run.createdAt),
    },
    snapshots: snapshots.map(snapshot => ({
      id: snapshot.id,
      step: snapshot.step,
      state: JSON.parse(snapshot.stateJson),
      createdAt: toIso(snapshot.createdAt),
    })),
    reviews: reviews.map(review => ({
      id: review.id,
      kind: review.kind,
      activityId: review.activityId,
      status: review.status,
      isCurrent: review.isCurrent,
      inputHash: review.inputHash,
      createdAt: toIso(review.createdAt),
    })),
  }
}

export async function getContextSnapshotForRun(runId: string) {
  const db = await getActivitiesDb()
  const reviews = await db.select().from(activityReviews).where(eq(activityReviews.runId, runId)).limit(1)
  const review = reviews[0]
  if (!review?.contextJson) return null

  return {
    runId,
    reviewId: review.id,
    context: JSON.parse(review.contextJson),
    features: JSON.parse(review.featuresJson),
  }
}
