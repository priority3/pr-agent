import { lazy, Suspense } from 'react'

const MarkdownRender = lazy(() => import('markstream-react'))

interface Props {
  children: string
  messageId: string
  streaming?: boolean
  isDark: boolean
}

/** SSE 累积正文直接交给 Markstream；结束标记让未闭合语法正确收尾。 */
export default function MarkdownText({ children, messageId, streaming = false, isDark }: Props) {
  return (
    <Suspense fallback={<span className="whitespace-pre-wrap">{children}</span>}>
      <MarkdownRender
        content={children}
        customId={`pr-message-${messageId}`}
        final={!streaming}
        isDark={isDark}
        fade={false}
        smoothStreaming={false}
        batchRendering={false}
        deferNodesUntilVisible={false}
        renderCodeBlocksAsPre
      />
    </Suspense>
  )
}
