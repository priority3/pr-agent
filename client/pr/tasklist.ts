/**
 * 把回复正文里 GFM task list(`- [ ] xxx`)切出来,交给可点的 Checklist 组件渲染,
 * 其余部分仍走 MarkdownStream。
 *
 * Reason: 建议类回复如果整段是散文,用户得自己在脑子里拆成「今天做什么、明天做什么」;
 * 拆成条目才能被打勾、被划掉、被回看。但正文不能因此重写成两套渲染器 —— 所以只在
 * 命中 task list 的连续行上切段,没有就是一段 md 原样走老路(模型不分点时零影响)。
 */

export interface CheckItem {
  text: string
  /** 模型自己写成 [x] 的(极少见),也当成已勾 */
  done: boolean
}

export type Segment =
  | { kind: 'md'; text: string }
  | { kind: 'list'; items: CheckItem[] }

/** 全部行匹配这个才算条目:允许缩进、`- * +` 三种符号,方括号里空格或 x/X */
const ITEM_RE = /^\s*[-*+]\s+\[([ xX])\]\s*(.*)$/

export function splitChecklist(content: string): Segment[] {
  const lines = content.split('\n')
  const out: Segment[] = []
  let buf: string[] = []
  let items: CheckItem[] | null = null
  // 代码块里的 `- [ ]` 是代码,不是清单(否则一段示例代码会被拆成可点条目)
  let fence = false

  const flushMd = () => {
    if (buf.join('').trim()) out.push({ kind: 'md', text: buf.join('\n') })
    buf = []
  }
  const flushItems = () => {
    if (items && items.length) out.push({ kind: 'list', items })
    items = null
  }

  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence
    const hit = fence ? null : ITEM_RE.exec(line)
    if (hit) {
      if (!items) {
        flushMd()
        items = []
      }
      const text = hit[2].trim()
      // 流式过程中末尾可能是空条目(`- [ ] ` 刚打出符号),先占位,不渲染空行
      if (text) items.push({ text, done: hit[1] !== ' ' })
      continue
    }
    if (items) flushItems()
    buf.push(line)
  }
  flushItems()
  flushMd()

  // 只有一条的「清单」看起来就是打错格式的列表项,退回普通 markdown,别硬做成勾选。
  // 注意必须「退化」而不是过滤:直接 filter 掉会把那一条的文字一起吞了(内容丢失)。
  return out.map(seg =>
    seg.kind === 'list' && seg.items.length <= 1
      ? { kind: 'md' as const, text: seg.items.map(it => `- [${it.done ? 'x' : ' '}] ${it.text}`).join('\n') }
      : seg,
  )
}
