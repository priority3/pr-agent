import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

// 每次创建临时库,先覆盖环境再加载业务模块,避免读取/修改真实数据。
const directory = await mkdtemp(path.join(tmpdir(), 'pr-race-test-'))
process.env.DATABASE_URL = `file:${directory}/test.db`
delete process.env.DATABASE_AUTH_TOKEN
process.env.PR_PERSONA_LLM = 'off'

const { resolveRaceDate, validateRacePlans, shanghaiDate } = await import('../server/lib/pr/race-plan-extraction')
const { saveRacePlans, getRacePlan, listRacePlans } = await import('../server/lib/pr/race-plans')
const { validateRaceResearch, researchRacePlan } = await import('../server/lib/pr/race-research')
const { publicWebUrl } = await import('../server/lib/pr/race-web')
const { getActivitiesDb, getActivitiesClient, ensureActivitiesSchema } = await import('../server/lib/db/client')
const { memoryItems, raceGoals } = await import('../server/lib/db/schema')
const { updateRaceGoal, deleteRaceGoal } = await import('../server/lib/pr/race-goals')
const { raceGoalsProvider } = await import('../server/lib/pr/providers/race-goals')
const { eq } = await import('drizzle-orm')

let checks = 0
function check(name: string, fn: () => void) { fn(); checks++; console.log(`PASS ${name}`) }

try {
  check('上海时区、跨年、闰年、无效日期和缺月份', () => {
    assert.equal(shanghaiDate('2026-09-30T16:30:00Z'), '2026-10-01')
    assert.equal(resolveRaceDate('下个月18号', '2026-12-09'), '2027-01-18')
    assert.equal(resolveRaceDate('下个月31号', '2026-01-09'), null)
    assert.equal(resolveRaceDate('2028年2月29日', null), '2028-02-29')
    assert.equal(resolveRaceDate('2026年2月29日', null), null)
    assert.equal(resolveRaceDate('25号', '2026-09-09', '2026-10-18'), '2026-10-25')
    assert.equal(resolveRaceDate('18号', '2026-09-09'), null)
  })
  const message = '我下个月18号和25号都有一场半马比赛，一个在遂宁一个在成都，看看最近训练记录给点建议'
  const input = { messageId: 'msg_test', message, createdAt: '2026-09-09T02:00:00Z' }
  const candidates = [
    { name: '遂宁半马', city: '遂宁', distanceMeters: 21097.5, dateText: '下个月18号', quote: message, source: 'user_text', intent: 'planned' },
    { name: '成都半马', city: '成都', distanceMeters: 21097.5, dateText: '25号', quote: message, source: 'user_text', intent: 'planned' },
  ]
  const extracted = validateRacePlans({ racePlans: candidates }, input)
  check('一条原话拆成两场、共享相对月份并保留来源', () => {
    assert.equal(extracted.length, 2)
    assert.deepEqual(extracted.map(plan => plan.raceDate), ['2026-10-18', '2026-10-25'])
    assert(extracted.every(plan => plan.status === 'active' && plan.evidence.originalText === message && plan.evidence.dateReference === '2026-09-09'))
  })
  const saved = await saveRacePlans(extracted)
  const db = await getActivitiesDb()
  await ensureActivitiesSchema(await getActivitiesClient())
  check('正式目标与 active 详细文字记忆同时保存', () => {
    assert(saved.every(plan => plan.goalId && plan.evidence[0].messageId === input.messageId))
  })
  const memories = await db.select().from(memoryItems)
  check('两条详细记忆含日期、地点、距离和原话', () => {
    assert.equal(memories.length, 2)
    assert(memories.every(memory => memory.status === 'active' && memory.content.includes('21.0975') && memory.content.includes('2026-10-') && JSON.parse(memory.evidenceJson)[0].quote === message))
  })
  await saveRacePlans(extracted)
  await saveRacePlans(extracted.map(plan => ({ ...plan, evidence: { ...plan.evidence, messageId: 'msg_repeat' } })))
  const repeated = await listRacePlans()
  const goals = await db.select().from(raceGoals)
  check('重试和再次提及同场赛事不会新增目标，证据合并', () => {
    assert.equal(repeated.length, 2)
    assert.equal(goals.length, 2)
    assert.equal(repeated[0].evidence.length, 2)
  })
  const imageInput = { ...input, images: [{ base64: 'fixture', mediaType: 'image/png' as const }], imageUrl: '/api/pr/uploads/test.png' }
  const image = validateRacePlans({ racePlans: [{ ...candidates[0], source: 'user_image', imageMessageDate: null }] }, imageInput)
  check('旧截图没有原消息时间时不套用上传日期', () => {
    assert.equal(image[0].raceDate, null)
    assert.equal(image[0].status, 'needs_confirmation')
    assert.equal(image[0].evidence.imageUrl, imageInput.imageUrl)
  })
  check('伪造原话和无附件的图片证据不能落库', () => {
    assert.throws(() => validateRacePlans({ racePlans: [{ ...candidates[0], quote: '这不是用户原话' }] }, input))
    assert.throws(() => validateRacePlans({ racePlans: [{ ...candidates[0], source: 'user_image' }] }, input))
  })
  const pendingInput = { ...input, messageId: 'msg_pending', message: '打算参加重庆半马' }
  const pending = validateRacePlans({ racePlans: [{ ...candidates[0], name: '重庆半马', city: '重庆', dateText: null, quote: pendingInput.message }] }, pendingInput)
  const [pendingPlan] = await saveRacePlans(pending)
  assert.equal(pendingPlan.goalId, null)
  const [confirmed] = await saveRacePlans([{ ...pending[0], raceDate: '2026-11-08', status: 'active' }])
  check('日期补充后沿用待确认条目并建立正式目标', () => {
    assert.equal(confirmed.id, pendingPlan.id)
    assert(confirmed.goalId)
  })
  const document = {
    url: 'https://sports.example.gov.cn/race', title: '2026 遂宁半程马拉松规程',
    text: '2026年遂宁半程马拉松于2026年10月18日举行，半程21.0975公里。起点体育中心，终点市民广场。累计爬升85米。补给站尚未公布。',
    fetchedAt: '2026-09-09T02:10:00Z', authority: 'official' as const,
  }
  const source = {
    index: 0, year: 2026, raceDate: '2026-10-18', distanceMeters: 21097.5,
    eventQuote: '2026年遂宁半程马拉松于2026年10月18日举行，半程21.0975公里。',
    fields: [
      { key: 'route', value: '起点体育中心，终点市民广场。', quote: '起点体育中心，终点市民广场。', status: 'published' },
      { key: 'elevationGain', value: '累计爬升85米', quote: '累计爬升85米。', status: 'published' },
      { key: 'aidStations', value: '补给站尚未公布', quote: '补给站尚未公布。', status: 'not_published' },
    ],
  }
  const verified = validateRaceResearch({ sources: [source] }, saved[0], [document])
  check('逐项保留来源、年份和状态；不以爬升代替海拔', () => {
    assert.equal(verified.fields.elevationGain.status, 'verified')
    assert.equal(verified.fields.elevation.status, 'unavailable')
    assert.equal(verified.fields.aidStations.status, 'pending')
    assert.equal(verified.sources[0].eventYear, 2026)
    assert.equal(verified.sources[0].url, document.url)
  })
  check('杜撰数值、不同城市、旧年份、错误组别均不能成为当前资料', () => {
    const fabricated = validateRaceResearch({ sources: [{ ...source, fields: [{ ...source.fields[1], value: '累计爬升850米' }] }] }, saved[0], [document])
    assert.equal(fabricated.fields.elevationGain.value, null)
    assert.equal(validateRaceResearch({ sources: [source] }, saved[1], [document]).status, 'unavailable')
    assert.equal(validateRaceResearch({ sources: [{ ...source, year: 2025 }] }, saved[0], [document]).status, 'unavailable')
    assert.equal(validateRaceResearch({ sources: [{ ...source, distanceMeters: 42195 }] }, saved[0], [document]).status, 'unavailable')
  })
  check('非官方来源待核实，日期冲突不覆盖用户日期', () => {
    assert.equal(validateRaceResearch({ sources: [source] }, saved[0], [{ ...document, authority: 'unverified' }]).fields.route.status, 'unverified')
    const conflict = validateRaceResearch({ sources: [{ ...source, raceDate: '2026-10-19', eventQuote: source.eventQuote.replace('18日', '19日') }] }, saved[0], [{ ...document, text: document.text.replace('18日', '19日') }])
    assert.equal(conflict.fields.route.status, 'conflict')
    assert.equal(conflict.fields.route.value, null)
  })
  let calls = 0
  const deps = {
    search: async () => [document.url], read: async () => document,
    model: async () => { calls++; return { content: JSON.stringify({ sources: [source] }), model: 'fixture', provider: 'claude' as const } },
  }
  await researchRacePlan(saved[0].id, {}, deps)
  await researchRacePlan(saved[0].id, {}, deps)
  const researched = await getRacePlan(saved[0].id)
  check('查询资料持久化且重复读取使用缓存', () => {
    assert.equal(calls, 1)
    assert.equal(researched?.research?.fields.route.status, 'verified')
  })
  const failed = await researchRacePlan(saved[0].id, { force: true }, { ...deps, search: async () => { throw new Error('offline') } })
  check('网络失败不会抹掉已查证资料，也不声称官方尚未公布', () => {
    assert.equal(failed.status, 'failed')
    assert.equal(failed.sources[0].url, document.url)
    assert(failed.reason?.includes('失败'))
  })
  const block = await raceGoalsProvider.load({ message: '两场半马怎么准备', today: '2026-09-09', hasImage: false })
  check('后续聊天读取详细来源和两场比赛间隔', () => {
    assert(block?.lines.some(line => line.includes('间隔 7 天')))
    assert(block?.lines.some(line => line.includes(document.url)))
    assert(block?.lines.some(line => line.includes('成都半马')))
  })
  await updateRaceGoal(saved[0].goalId!, { raceDate: '2026-10-20T00:00:00+08:00' })
  const updated = await getRacePlan(saved[0].id)
  const [updatedMemory] = await db.select().from(memoryItems).where(eq(memoryItems.id, `mem_${saved[0].id}`))
  check('管理端改期同步文字记忆并使旧路线资料失效', () => {
    assert.equal(updated?.raceDate, '2026-10-20')
    assert.equal(updated?.research, null)
    assert(updatedMemory.content.includes('2026-10-20'))
  })
  await deleteRaceGoal(saved[0].goalId!)
  const [archived] = await db.select().from(memoryItems).where(eq(memoryItems.id, `mem_${saved[0].id}`))
  check('删除正式目标同步归档关联记忆', () => assert.equal(archived.status, 'archived'))
  check('网页读取拒绝内部地址及伪装地址', () => {
    for (const url of ['http://127.0.0.1/', 'http://2130706433/', 'http://169.254.169.254/', 'http://10.0.0.1/', 'http://localhost/', 'file:///etc/passwd', 'http://[::1]/', 'https://user:pass@example.com/']) assert.throws(() => publicWebUrl(url))
    assert.equal(publicWebUrl('https://sports.example.gov.cn/race').hostname, 'sports.example.gov.cn')
  })
  console.log(`\n${checks} checks passed; isolated database only.`)
} finally {
  ;(await getActivitiesClient()).close()
  await rm(directory, { recursive: true, force: true })
}
