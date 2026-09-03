/**
 * 定时任务管理 API(管理端点;宿主「任务调度」面板经代理消费)。
 *
 * 设计:job 清单以代码为准(scheduler.ts 的 DEFAULT_JOBS),这里把「代码默认 + 运行时覆盖
 * + 执行历史 + 算好的下次触发时刻」合成一份可直接渲染的视图 —— 面板不需要自己解析 cron、
 * 也不需要知道优先级规则,拿到 cronSource 就能标出当前值来自面板/env/默认。
 */
import { Hono } from 'hono'

import { DEFAULT_JOBS, reloadScheduler } from '@/lib/scheduler'
import {
  JOB_RUN_HISTORY_LIMIT,
  loadOverrides,
  loadRuns,
  nextRunAt,
  resolveCron,
  saveOverride,
  schedulerTimezone,
} from '@/lib/scheduler-store'
import { withAuth } from '@/middleware/auth'
import cron from 'node-cron'

const jobs = new Hono()

jobs.get('/', withAuth, async c => {
  const [overrides, runs] = await Promise.all([
    loadOverrides(),
    loadRuns(DEFAULT_JOBS.map(j => j.id)),
  ])
  const timezone = schedulerTimezone()

  return c.json({
    timezone,
    historyLimit: JOB_RUN_HISTORY_LIMIT,
    // 调度总开关关掉时,下面所有 job 其实都不会跑 —— 面板需要知道,否则显示的
    // 「下次触发」是个谎言。
    schedulerDisabled: ['off', 'false', '0'].includes((process.env.PR_SCHEDULER ?? '').trim().toLowerCase()),
    jobs: DEFAULT_JOBS.map(job => {
      const override = overrides.get(job.id)
      const { expression, source } = resolveCron(job.id, job.cron, override)
      const enabled = override?.enabled ?? true
      const history = runs.get(job.id) ?? []
      return {
        id: job.id,
        name: job.name,
        cronExpression: expression,
        cronSource: source,
        defaultCron: job.cron,
        enabled,
        // 关掉的 job 不该显示下次触发时刻
        nextRunAt: enabled ? nextRunAt(expression) : null,
        lastRun: history[0] ?? null,
        runs: history,
      }
    }),
  })
})

jobs.patch('/:id', withAuth, async c => {
  const id = c.req.param('id')
  if (!DEFAULT_JOBS.some(j => j.id === id)) {
    return c.json({ error: `未知任务: ${id}` }, 404)
  }

  let body: Record<string, unknown>
  try {
    body = (await c.req.json()) as Record<string, unknown>
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  const patch: { cronExpression?: string | null; enabled?: boolean } = {}

  if ('cronExpression' in body) {
    const raw = body.cronExpression
    if (raw === null || raw === '') {
      // 显式清空 = 恢复到 env / 代码默认
      patch.cronExpression = null
    } else if (typeof raw !== 'string' || !cron.validate(raw.trim())) {
      return c.json({ error: `非法 cron 表达式: ${String(raw)}` }, 400)
    } else {
      patch.cronExpression = raw.trim()
    }
  }

  if ('enabled' in body) {
    if (typeof body.enabled !== 'boolean') return c.json({ error: 'enabled 必须是布尔值' }, 400)
    patch.enabled = body.enabled
  }

  if (!Object.keys(patch).length) return c.json({ error: '空更新' }, 400)

  await saveOverride(id, patch)
  // 立即重建定时器,免重启生效 —— 否则又是「保存成功但没用」。
  await reloadScheduler()

  const overrides = await loadOverrides()
  const job = DEFAULT_JOBS.find(j => j.id === id)!
  const override = overrides.get(id)
  const { expression, source } = resolveCron(id, job.cron, override)
  const enabled = override?.enabled ?? true

  return c.json({
    ok: true,
    job: {
      id,
      name: job.name,
      cronExpression: expression,
      cronSource: source,
      defaultCron: job.cron,
      enabled,
      nextRunAt: enabled ? nextRunAt(expression) : null,
    },
  })
})

export default jobs
