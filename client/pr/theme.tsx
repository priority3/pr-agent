/* 作用域主题变量 + 动画。深色随系统(prefers-color-scheme),不依赖全局 shadcn 令牌。
   动画语言(参考 Shiro):spring 贝塞尔 --pr-spring 负责入场/按压,expo-out --pr-ease 负责位移。 */
export function PrThemeStyle() {
  return (
    <style>{`
.pr{
  --pr-bg:#ffffff; --pr-text:#111114; --pr-text-2:#6b6b72;
  --pr-muted:#a3a3ac; --pr-line:#ececee; --pr-line-strong:#e0e0e3;
  --pr-ai-bg:#f1f1f3; --pr-ai-text:#111114; --pr-user-bg:#141417; --pr-user-text:#f7f7f8;
  --pr-accent:#a3e635; --pr-accent-ink:#1a2e05; --pr-sel:#f0f0f2;
  --pr-danger:#d92d20; --pr-danger-bg:rgba(217,45,32,.08);
  --pr-glass:rgba(255,255,255,.78);
  --pr-skel-a:#f1f1f3; --pr-skel-b:#e4e4e8;
  --pr-spring:cubic-bezier(.34,1.56,.64,1); --pr-ease:cubic-bezier(.16,1,.3,1);
  color-scheme:light;
  -webkit-tap-highlight-color:transparent;
}
@media (prefers-color-scheme:dark){
  .pr{
    --pr-bg:#0b0b0d; --pr-text:#f2f2f4; --pr-text-2:#a0a0a8;
    --pr-muted:#6b6b73; --pr-line:#232327; --pr-line-strong:#2c2c31;
    --pr-ai-bg:#1c1c20; --pr-ai-text:#f2f2f4; --pr-user-bg:#ededf0; --pr-user-text:#141417;
    --pr-accent:#a3e635; --pr-accent-ink:#16240a; --pr-sel:#1c1c20;
    --pr-danger:#ff6b63; --pr-danger-bg:rgba(255,107,99,.12);
    --pr-glass:rgba(11,11,13,.72);
    --pr-skel-a:#1c1c20; --pr-skel-b:#26262c;
    color-scheme:dark;
  }
}
.pr ::selection{background:rgba(163,230,53,.4)}
.pr .pr-glass{background:var(--pr-glass);backdrop-filter:blur(16px) saturate(1.5);-webkit-backdrop-filter:blur(16px) saturate(1.5)}
.pr-backdrop{background:rgba(0,0,0,.32);backdrop-filter:blur(2px);-webkit-backdrop-filter:blur(2px);transition:opacity .3s ease}
.pr-drawer{transition:transform .38s var(--pr-ease);box-shadow:8px 0 32px rgba(0,0,0,.14)}
.pr .pr-input::placeholder{color:var(--pr-muted)}
.pr .pr-composer{background:var(--pr-sel);border:1px solid var(--pr-line);transition:border-color .25s,box-shadow .25s}
.pr .pr-plus{transition:transform .3s var(--pr-spring),opacity .18s}
.pr .pr-plus-open{transform:rotate(45deg)}
.pr .pr-plus-open:active{transform:rotate(45deg) scale(.9)}
.pr-menu{transform-origin:0 100%}
.pr .pr-tap{transition:transform .25s var(--pr-spring),opacity .18s,background-color .18s}
.pr .pr-tap:active{transform:scale(.9)}
.pr .pr-row{animation:prRise .4s var(--pr-ease) both;transition:background-color .2s,transform .25s var(--pr-spring)}
.pr .pr-row:active{transform:scale(.98)}
.pr .pr-send{transition:transform .35s var(--pr-spring),opacity .2s,background-color .2s}
.pr .pr-send:disabled{opacity:.35;transform:scale(.86)}
.pr .pr-send:not(:disabled):active{transform:scale(.88)}
.pr-dot-solid{width:6px;height:6px;border-radius:9999px;display:inline-block}
.pr-pulse{animation:prPulse 1.1s ease-in-out infinite}
@keyframes prPulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(.7)}}
.pr .pr-dot{width:6px;height:6px;border-radius:9999px;background:var(--pr-muted);display:inline-block;animation:prBounce 1.2s infinite ease-in-out}
.pr .pr-dot:nth-child(2){animation-delay:.15s}
.pr .pr-dot:nth-child(3){animation-delay:.3s}
@keyframes prBounce{0%,80%,100%{opacity:.25;transform:translateY(0)}40%{opacity:1;transform:translateY(-3px)}}
.pr-msg{animation:prIn .5s var(--pr-spring) both}
@keyframes prIn{from{opacity:0;transform:translateY(12px) scale(.96)}to{opacity:1;transform:none}}
.pr-thread-in{animation:prFade .35s ease-out both}
@keyframes prFade{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.pr-rise{animation:prRise .6s var(--pr-ease) both}
@keyframes prRise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
.pr-pop{animation:prPop .35s var(--pr-spring) both}
@keyframes prPop{from{opacity:0;transform:scale(.8)}to{opacity:1;transform:none}}
.pr-breath{animation:prBreath 4.5s ease-in-out infinite}
@keyframes prBreath{0%,100%{transform:scale(1)}50%{transform:scale(1.05)}}
.pr-spin{animation:prSpin .8s linear infinite}
@keyframes prSpin{to{transform:rotate(360deg)}}
.pr-scroll{scrollbar-width:none}
.pr-scroll::-webkit-scrollbar{display:none}
/* 历史加载骨架:与气泡同形,微光扫过 */
.pr .pr-skel{background:linear-gradient(90deg,var(--pr-skel-a) 25%,var(--pr-skel-b) 37%,var(--pr-skel-a) 63%);background-size:400% 100%;animation:prShimmer 1.5s ease infinite}
@keyframes prShimmer{0%{background-position:100% 50%}100%{background-position:0 50%}}
/* 「回到底部 / 新消息」悬浮胶囊:只在用户离开底部时出现 */
.pr .pr-jump{background:var(--pr-glass);border:1px solid var(--pr-line-strong);backdrop-filter:blur(12px) saturate(1.4);-webkit-backdrop-filter:blur(12px) saturate(1.4);box-shadow:0 4px 16px rgba(0,0,0,.12);color:var(--pr-text-2)}
/* 复制按钮:常驻但极低存在感,点后变对勾 */
.pr .pr-copy{color:var(--pr-muted);opacity:.6}
.pr .pr-copy:active{opacity:1}
@media (prefers-reduced-motion:reduce){
  .pr *,.pr-backdrop,.pr-drawer{animation-duration:.01ms !important;transition-duration:.01ms !important}
}
`}</style>
  )
}
