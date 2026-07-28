/* 内联描边图标(项目未加载图标字体,统一用 currentColor 的极简 SVG,替代 emoji) */
type IconProps = { size?: number; className?: string }

const svgBase = (size: number) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
})

export const MenuIcon = ({ size = 22, className }: IconProps) => (
  <svg {...svgBase(size)} className={className} aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
)
export const PlusIcon = ({ size = 22, className }: IconProps) => (
  <svg {...svgBase(size)} className={className} aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
)
export const ImageIcon = ({ size = 22, className }: IconProps) => (
  <svg {...svgBase(size)} className={className} aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="m21 15-5-5L5 21" /></svg>
)
export const CameraIcon = ({ size = 22, className }: IconProps) => (
  <svg {...svgBase(size)} className={className} aria-hidden="true"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" /><circle cx="12" cy="13" r="4" /></svg>
)
export const TrashIcon = ({ size = 18, className }: IconProps) => (
  <svg {...svgBase(size)} className={className} aria-hidden="true"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6" /></svg>
)
export const SendIcon = ({ size = 20, className }: IconProps) => (
  <svg {...svgBase(size)} className={className} aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
)
export const StopIcon = ({ size = 20, className }: IconProps) => (
  <svg {...svgBase(size)} className={className} aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.5" /></svg>
)
export const CloseIcon = ({ size = 16, className }: IconProps) => (
  <svg {...svgBase(size)} className={className} aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
)
export const ArrowDownIcon = ({ size = 14, className }: IconProps) => (
  <svg {...svgBase(size)} className={className} aria-hidden="true"><path d="M12 5v14M19 12l-7 7-7-7" /></svg>
)
export const CopyIcon = ({ size = 14, className }: IconProps) => (
  <svg {...svgBase(size)} className={className} aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
)
export const CheckIcon = ({ size = 14, className }: IconProps) => (
  <svg {...svgBase(size)} className={className} aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>
)
export const Spinner = ({ size = 20, className }: IconProps) => (
  <svg {...svgBase(size)} className={`pr-spin ${className ?? ''}`} aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.22-8.56" /></svg>
)

/* PR 头像:白底圆形 + 黑色 logo,深浅色下都清晰 */
export function PrAvatar() {
  return (
    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full" style={{ background: '#fff', border: '1px solid var(--pr-line-strong)' }}>
      <img src="/pr-logo.png" alt="PR" style={{ width: 18, height: 18 }} />
    </div>
  )
}
