import { CollapsibleSection } from '../../components/shared'
import { HealthRecoveryPanel } from './HealthRecoveryPanel'
import { HomeLocationCard } from './HomeLocationCard'
import { MemoryPanel } from './MemoryPanel'
import { PrReviewsPanel } from './PrReviewsPanel'

/**
 * PR 伙伴面板:把"脑(记忆)/嘴(反思)/身体(恢复)"三块摊在一个标签页里,
 * 外加常跑地点(环境感知用的定位画像)。
 * 记忆区是学习环的闭合点——确认候选 → 进画像 → 次日反思引用。
 */
export function PrPanel() {
  return (
    <div className="space-y-4">
      <CollapsibleSection title="记忆 · 确认或纠正 PR 学到的东西">
        <MemoryPanel />
      </CollapsibleSection>
      <CollapsibleSection title="最近反思 · PR 说过的话">
        <PrReviewsPanel />
      </CollapsibleSection>
      <CollapsibleSection title="近 14 天恢复" defaultOpen={false}>
        <HealthRecoveryPanel />
      </CollapsibleSection>
      <CollapsibleSection title="常跑地点 · 天气与环境感知的定位" defaultOpen={false}>
        <HomeLocationCard />
      </CollapsibleSection>
    </div>
  )
}
