/**
 * 启动引导:serve 前把数据库准备好(建表 + WAL)。
 *
 * Reason: 建表原本惰性发生在 getActivitiesDb() 首次调用。但 metrics 等路由走 getActivitiesClient()
 * 裸 client(不触发 ensureActivitiesSchema),导致首个带会话请求报 "no such table: agent_runs"。
 * 这里在启动路径显式建表一次,消除首访 500;幂等,可重复调用。
 */
import { ensureActivitiesSchema, getActivitiesClient } from '@/lib/db/client'

export async function ensureDatabaseReady() {
  const client = await getActivitiesClient()

  // 本地 file 库启用 WAL,减少并发锁错误(远程 libsql 不需要也不支持)。
  const url = process.env.DATABASE_URL || 'file:./data/pr.db'
  if (url.startsWith('file:')) {
    try {
      await client.execute('PRAGMA journal_mode=WAL;')
      await client.execute('PRAGMA busy_timeout=5000;')
    } catch {
      // 忽略 PRAGMA 失败,不阻断启动
    }
  }

  await ensureActivitiesSchema(client)
}
