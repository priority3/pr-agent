import PrChatPage from './PrChat'
import RecordDetailPage from './RecordDetailPage'
import RecordsPage from './RecordsPage'
import { useRoute } from './router'
import SettingsPage from './SettingsPage'

/**
 * H5 入口:按 hash 在四个页面之间切换。
 *
 * 对话页保持原样(它自己管令牌兑换、流式、抽屉),不为了路由改造它——
 * 三个新页各自从 localStorage 取同一枚设备令牌(见 data.ts),所以这里不需要
 * 把令牌用一个 Provider 传下去。这也意味着:如果用户绕过一次性链接直接开
 * #/records,新页会看到「访问已失效」,而对话页仍然负责真正的入口兑换。
 */
export default function PrApp() {
  const route = useRoute()

  switch (route.name) {
    case 'records':
      return <RecordsPage />
    case 'record':
      return <RecordDetailPage id={route.id} />
    case 'settings':
      return <SettingsPage />
    default:
      return <PrChatPage />
  }
}
