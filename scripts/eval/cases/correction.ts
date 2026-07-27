/** R4:多轮纠正/撤回/玩笑与反问 —— doNotAssume 不复犯 + 上一轮话在下一轮生效(0534cc3 回归);判据只看对话内表现。 */
import { FRIEND_PROFILE, RACE_GOAL } from '../dataset'

import { t, type EvalCase } from './shared'

export const CORRECTION_CASES: EvalCase[] = [
  // ─────────────────────────── R4:纠正/撤回/玩笑/反问 ───────────────────────────
  {
    id: 'corr-no-repeat',
    level: 'L3',
    category: 'correction/memory',
    title: '纠正后不再默认早上跑',
    turns: [
      t('跟你说过了吧,别再默认我早上跑,我都是晚上跑的'),
      t('那你说,明天我啥时候跑合适?'),
    ],
    interTurnDelayMs: 1500,
    judge: {
      intent: '轮 1 用户重申「别默认我早上跑」(画像本就有晚上跑习惯 + doNotAssume);考轮 2 同一对话内是否不复犯',
      mustGround: [
        `既有习惯:${FRIEND_PROFILE.trainingPreferences[0]}`,
        `画像 doNotAssume:${FRIEND_PROFILE.doNotAssume[0]}`,
      ],
      pass: '轮 1 接住纠正;轮 2 以晚上/傍晚为首选给时段建议,顺着他晚上跑的习惯;结合恢复情况微调具体时段也算过',
      fail: '轮 2 又把早上当成他的默认或首选时段(如直接推清晨跑,或说「你不是习惯早上跑吗」),等于纠正没生效',
      likelyReasons: ['repeated_correction'],
    },
  },
  {
    id: 'corr-joke',
    level: 'L3',
    category: 'correction/memory',
    title: '玩笑不当真实目标',
    turns: [
      t('我决定了,以后不跑步了,改行专练铁人三头肌哈哈哈哈'),
      t('说正经的,这周末我练点啥好?'),
    ],
    interTurnDelayMs: 1500,
    judge: {
      intent: '轮 1 是玩笑话(铁人三项×三头肌的梗),不是真实新目标;轮 2 要正经建议时应回到真实备赛语境',
      mustGround: [
        `真实目标:${FRIEND_PROFILE.activeGoals[0]}(还有 ${RACE_GOAL.daysUntil} 天)`,
        `周末习惯:${FRIEND_PROFILE.trainingPreferences[1]}`,
      ],
      pass: '轮 1 接不接梗都行;轮 2 按跑步/备赛给正常周末建议(比如把跑量捡起来、安排长距离),不把「铁人三头肌」当成他真实的新目标复述或据此规划',
      fail: '轮 2 把玩笑当真——按「他已确立铁人三项/三头肌新方向」出计划,或复述「你的新目标是练三头肌」这类既成事实表述',
      likelyReasons: ['wrong_readback', 'scope_drift'],
    },
  },
  {
    id: 'corr-retract',
    level: 'L3',
    category: 'correction/memory',
    title: '撤回加量请求',
    turns: [
      t('帮我看看下周怎么加量,我感觉能多跑点了'),
      t('算了算了,刚才那条不算哈,我先不加量了,还是按原来的来'),
    ],
    interTurnDelayMs: 1500,
    judge: {
      intent: '轮 2 撤回轮 1 的加量请求;应接住撤回、停止输出加量方案,回到原有备赛节奏(轮 1 怎么答加量不作要求)',
      mustGround: [`目标不变:${FRIEND_PROFILE.activeGoals[0]}(还有 ${RACE_GOAL.daysUntil} 天)`],
      pass: '轮 2 明确承认撤回(好的/那就先不加),不再继续推加量方案;按原有节奏聊备赛;如实说「咱也没存过具体加量计划,就维持现在节奏」同样算过;顺带一句「以后想加再聊」也没问题',
      fail: '轮 2 无视撤回,当他仍要加量,继续输出下周加量计划',
      likelyReasons: ['repeated_correction', 'scope_drift'],
    },
  },
  {
    id: 'corr-question-not-fact',
    level: 'L3',
    category: 'correction/memory',
    title: '反问不当既成事实',
    turns: [
      t('哎你说,我是不是应该改成早上跑啊?'),
      t('那我到底啥时候跑好?'),
    ],
    interTurnDelayMs: 1500,
    judge: {
      intent: '轮 1 是征询意见的反问,不是「已决定改早上」;轮 2 不得把「改早上」当成他已确认的新习惯(0534cc3 修复的回归)',
      mustGround: [`既有习惯:${FRIEND_PROFILE.trainingPreferences[0]}(轮 1 只是发问,没拍板)`],
      pass: '轮 1 当开放问题讨论——结合他一贯晚上跑的习惯聊利弊(给不给「可以试试早上」的建议都行);轮 2 仍以晚上跑为他的既有习惯给建议(可附带「真想试早上可以怎么安排」),不预设他已改早上',
      fail: '把反问当既成事实——轮 1 就复述成「好的,记住你以后早上跑」,或轮 2 按「他已经改成早上跑」直接输出(如「你现在不是改早上了嘛」)',
      likelyReasons: ['wrong_readback', 'repeated_correction'],
    },
  },
]
