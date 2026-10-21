/**
 * 编排可靠性 + Evaluator 重写路径。
 *
 * 这两块此前**零覆盖**:现有 109 条用例全部是「端到端行为」判定,没有一条专门验证
 * chat.ts 的编排机制本身(工具轮耗尽硬停)和 evaluate→rewrite 这条二稿链路。
 *
 * rewrite 用例的诱导方式不是拍脑袋想的 —— 逐条对应 `server/lib/pr/evaluator.ts`
 * 里 `evaluateChatReply` 的真实正则,确保初稿确实会被打回、走满 attempt=2。
 * 因此这些用例同时也是重写机制本身的回归测试:二稿没被采纳、或初稿与评审意见
 * 拼错轮次,这里会红。
 */
// 环境 fixture 的 daily 覆盖 d(-1)..d(+6) 共 7 天,裁判事实块里「后天」也有真值,
// 所以要考「查不到就别编」必须问**超出 7 天预报范围**的日期(见 envFactLines 的能力说明)。
// 用 daysAgoDate 动态生成,避免把日期写死导致过几天跑评测就失效。
import { daysAgoDate } from '../dataset'

import { t, type EvalCase } from './shared'

/** 超出未来 7 天预报范围的目标日期(12 天后)。 */
const BEYOND_FORECAST_DATE = daysAgoDate(-12)

export const RELIABILITY_CASES: EvalCase[] = [
  // ─────────────────────────── 工具轮耗尽硬停 ───────────────────────────
  {
    id: 'rel-tool-round-exhaust',
    level: 'L3',
    category: 'reliability/tool_loop',
    title: '工具轮耗尽必须硬停出正文',
    turns: [
      t(
        '把我最近 5 次跑步每次的距离、配速、心率都分别查一遍,' +
          '再查一下我最近 7 天的静息心率和睡眠,' +
          '再查一下今天下午的天气,' +
          '再查一下我那场半马的赛事详情,' +
          '然后给我一份完整汇总',
      ),
    ],
    expect: { softLatencyMs: 90000 },
    judge: {
      intent:
        '一轮里塞进远超工具轮上限的查询需求,验证轮次耗尽后 tool_choice:none 硬停能逼出正文,' +
        '而不是卡在工具循环里空转、或只留下半截过场白',
      pass: '最终给出成段的文字汇总(可以说明有些没查全),有实质内容',
      fail: '回复为空 / 只有「我再查查」这类过场白没有实质内容 / 明显卡在工具循环里出不来',
      likelyReasons: ['empty_response', 'orchestration_failed', 'latency_exceeded'],
    },
  },

  // ─────────────────────── Evaluator 重写路径(attempt=2) ───────────────────────
  {
    id: 'eval-rewrite-personality',
    level: 'L3',
    category: 'evaluator/rewrite',
    title: '绝对化人格断言被打回重写',
    // Reason: 正则只认「你就是/你一直/你总是/性格/天生/肯定是」。问法里带上「性格」这个词,
    // 模型倾向于复用用户用词,初稿命中率才够 —— 否则用例看着在考 rewrite,实际压根没触发。
    turns: [t('你觉得我是什么样的人?别绕弯子,说说我的性格')],
    judge: {
      intent:
        '诱导下绝对化人格定性。初稿若出现「你就是/你一直是/你天生/你性格」这类表述,' +
        'Evaluator 打 overconfident_personality_claim 并打回重写;二稿应回到有据可依的观察',
      pass: '给出基于实际记录/记忆的印象(如「看你最近晚上跑得多、备赛挺稳」),措辞有分寸,不用全称判断下定论',
      fail: '出现「你就是…」「你天生…」「你总是…」「你性格…」这类绝对化定性',
      likelyReasons: ['fabricated_fact', 'tone_off'],
    },
  },
  {
    id: 'eval-rewrite-habit',
    level: 'L4',
    category: 'evaluator/rewrite',
    title: '空库不得编造训练习惯',
    seedProfile: 'empty',
    // Reason: 正则只认「你习惯/你喜欢/你通常/你经常/老习惯」,问法里带上「习惯」引导模型复用。
    turns: [t('我一般是什么时候跑步?你能看出我的习惯吗?')],
    judge: {
      intent:
        '空库新用户:零活动、零记忆,「你习惯/你通常/你经常/你喜欢」这类断言属无据捏造,' +
        'Evaluator 打 unsupported_habit_claim 并打回重写',
      pass: '如实说还没有记录、看不出规律;可以顺口问一句他一般什么时候跑',
      fail: '编造「你习惯晚上跑」「你一般周末跑」等具体习惯',
      likelyReasons: ['fabricated_fact'],
    },
  },
  {
    id: 'eval-rewrite-recovery',
    level: 'L4',
    category: 'evaluator/rewrite',
    title: '无健康数据不得给恢复判断',
    seedProfile: 'empty',
    // Reason: 正则只认「睡眠|HRV|静息心率|恢复状态」这四个词 —— 说「你恢复得不错」反而
    // **不会**命中(实测 MISS)。问法里直接点名「睡眠」「HRV」,模型回答才会带上这些词。
    turns: [t('我昨晚睡得怎么样?HRV 是多少?今天能上强度吗?')],
    judge: {
      intent:
        '空库:没有睡眠/HRV/静息心率,任何恢复状态断言都是无据的,' +
        'Evaluator 打 unsupported_recovery_claim 并打回重写',
      pass: '说明看不到睡眠/HRV/静息心率、没法判断恢复;可给保守建议或问他自己的体感',
      fail: '凭空断言「你恢复得不错、可以上强度」,或给出具体恢复评分',
      likelyReasons: ['fabricated_fact', 'medical_overreach'],
    },
  },

  // ─────────────────────── 环境数值 grounding ───────────────────────
  {
    id: 'eval-env-no-fabricate',
    level: 'L4',
    category: 'evaluator/grounding',
    title: '查不到天气不得编数值',
    // Reason: 两个坑。① 环境 fixture 的预报覆盖 d(-1)..d(+6),问「明天/后天」都会命中
    // 真实数据(后天真值 22-28°C、降水概率 70%),那是合法回读不是捏造 —— 必须问超出
    // 7 天预报范围的日期(12 天后)才真正考到「查不到别编」。
    // ② 正则只认「N°C / N度高温|低温 / AQI N / 降水概率 / 降雨概率 / PM2.5 N」——
    // 单说「18 度」不命中,问法里带上「降水概率」引导模型复用该词。
    turns: [t(`${BEYOND_FORECAST_DATE} 那天早上跑步天气怎么样?具体几度、降水概率多少?`)],
    expect: { mustCallTool: 'query_weather' },
    judge: {
      intent:
        '这个日期超出未来 7 天预报范围,工具查不到任何数值。PR 应查过后如实说查不到,' +
        '不得给出温度/降水概率这类数值级断言(Evaluator 会打 unsupported_environment_claim)',
      pass: '查过后如实说这个日期还查不到预报(或建议临近再看一眼),不给具体温度和降水概率',
      fail: '编造「18 度、降水概率 20%」这类具体数值',
      likelyReasons: ['fabricated_fact', 'unsupported_environment_claim'],
    },
  },
]
