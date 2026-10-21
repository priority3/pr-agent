/**
 * 工具选择覆盖补全。
 *
 * `DeterministicExpect.mustCallTool` 原先只声明了 3 个工具,而 registry 实际聚合出 5 个,
 * `query_race_details` / `sync_activities` 长期没有对应用例。
 *
 * 注意:mustCallTool 在 checks.ts 里是**软信号**(hard: false),不影响判定,
 * 只计入工具准确率并交给裁判参考 —— 所以下面的用例不会因为模型"直接从上下文答出来"
 * 就误判失败,主判据仍是 judge。
 */
import { t, type EvalCase } from './shared'

export const TOOL_COVERAGE_CASES: EvalCase[] = [
  {
    id: 'tool-race-details',
    level: 'L2',
    category: 'tool_selection',
    title: '赛事资料查不到就如实说',
    // Reason: 种子只写了 race_goals(西湖半马目标),没有 race_plans 资料 ——
    // 无参调用 query_race_details 会返回空计划列表,是纯本地查询、不出外网。
    // 因此这条真正考的是「查不到就说没有」,而不是回读具体路线数据。
    turns: [t('我那场半马有路线、海拔和补给站的资料吗?关门时间呢?')],
    expect: { mustCallTool: 'query_race_details' },
    judge: {
      intent:
        '问赛事本身的路线/海拔/补给/关门时间这类资料。应调 query_race_details 查,' +
        '库里没存过就如实说没有,不拿目标信息(日期/距离/目标时间)冒充赛事资料,' +
        '更不编造路线细节',
      pass: '查询后如实说明没有存过路线、海拔、补给、关门时间这些资料;可以说手上有的是目标和日期',
      fail: '编造具体的路线走向、累计爬升、补给站位置或关门时间',
      likelyReasons: ['missing_tool_call', 'fabricated_fact'],
    },
  },
]
