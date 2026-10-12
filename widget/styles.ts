/**
 * The widget's only stylesheet. It lives inside a shadow root, so the host
 * page's CSS can't reach in and ours can't leak out. `:host { all: initial }`
 * resets anything inherited (fonts, colours, line-height).
 *
 * Colours are custom properties so one block switches the theme. Dark mode
 * follows the visitor's OS (prefers-color-scheme). Pages that set a theme
 * class on an ancestor (`.dark` / `.light`, or data-theme="dark|light") win
 * in browsers that support :host-context (Chromium).
 */
const LIGHT = `--uq-bg:#fff;--uq-fg:#0a0a0a;--uq-muted:#52525b;--uq-subtle:#71717a;--uq-faint:#a1a1aa;--uq-border:#e4e4e7;--uq-border-strong:#d4d4d8;--uq-hover:#f4f4f5;--uq-surface:#fafafa;--uq-overlay:rgba(9,9,11,.42);--uq-opt-on:#f0fdf4;--uq-badge-bg:#dcfce7;--uq-badge-fg:#15803d;--uq-err-bg:#fef2f2;--uq-err-fg:#991b1b;--uq-shadow:0 1px 2px rgba(0,0,0,.04),0 24px 64px -16px rgba(0,0,0,.28)`;
const DARK = `--uq-bg:#141417;--uq-fg:#fafafa;--uq-muted:#d4d4d8;--uq-subtle:#a1a1aa;--uq-faint:#71717a;--uq-border:#27272a;--uq-border-strong:#3f3f46;--uq-hover:#1f1f23;--uq-surface:#0c0c0e;--uq-overlay:rgba(0,0,0,.6);--uq-opt-on:rgba(34,197,94,.1);--uq-badge-bg:rgba(34,197,94,.14);--uq-badge-fg:#4ade80;--uq-err-bg:rgba(248,113,113,.12);--uq-err-fg:#fca5a5;--uq-shadow:0 0 0 1px rgba(255,255,255,.06),0 24px 64px -16px rgba(0,0,0,.7)`;

export const WIDGET_CSS = `
:host{all:initial}
:host{${LIGHT}}
@media (prefers-color-scheme:dark){:host{${DARK}}}
:host-context(.dark),:host-context([data-theme=dark]){${DARK}}
:host-context(.light),:host-context([data-theme=light]){${LIGHT}}
*{box-sizing:border-box;margin:0}
.uq-root{font-family:"Geist","Inter",ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;color:var(--uq-fg);font-size:15px;line-height:1.5;-webkit-font-smoothing:antialiased}
.uq-overlay{position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:16px;background:var(--uq-overlay);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);animation:uq-fade .18s ease-out}
.uq-inline{display:flex;justify-content:center;padding:24px 12px;background:var(--uq-surface);border-radius:14px}
.uq-card{position:relative;width:100%;max-width:440px;max-height:calc(100vh - 32px);overflow:auto;background:var(--uq-bg);border:1px solid var(--uq-border);border-radius:18px;padding:28px 24px 22px;box-shadow:var(--uq-shadow);animation:uq-in .32s cubic-bezier(.16,1,.3,1)}
.uq-inline .uq-card{max-height:none;box-shadow:0 1px 2px rgba(0,0,0,.05),0 8px 24px -12px rgba(0,0,0,.18)}
@keyframes uq-in{from{opacity:0;transform:translateY(10px) scale(.98)}to{opacity:1;transform:none}}
@keyframes uq-fade{from{opacity:0}to{opacity:1}}
@keyframes uq-sheet{from{transform:translateY(100%)}to{transform:none}}
@media (max-width:520px){.uq-overlay{align-items:flex-end;padding:0}.uq-overlay .uq-card{max-width:none;max-height:92vh;border-radius:22px 22px 0 0;border-bottom:0;padding:26px 18px calc(18px + env(safe-area-inset-bottom));animation:uq-sheet .34s cubic-bezier(.16,1,.3,1)}}
@media (prefers-reduced-motion:reduce){.uq-card,.uq-overlay,.uq-overlay .uq-card{animation:none}.uq-btn,.uq-opt{transition:none}}
.uq-close{position:absolute;top:12px;right:12px;width:34px;height:34px;border:0;border-radius:10px;background:transparent;color:var(--uq-subtle);font-size:22px;line-height:1;cursor:pointer;transition:background-color .15s,color .15s}
.uq-close:hover{background:var(--uq-hover);color:var(--uq-fg)}
h2{font-size:20px;line-height:1.3;font-weight:600;letter-spacing:-.02em;padding-right:32px;outline:none;color:var(--uq-fg)}
p{margin-top:8px;color:var(--uq-muted)}
.uq-muted{color:var(--uq-subtle);font-size:13px}
fieldset{border:0;padding:0;margin:18px 0 0}
legend{font-size:14px;font-weight:500;color:var(--uq-muted);margin-bottom:8px;padding:0}
.uq-opt{display:flex;align-items:center;gap:10px;padding:11px 12px;margin-top:8px;border:1px solid var(--uq-border);border-radius:12px;cursor:pointer;min-height:44px;transition:border-color .15s,background-color .15s,transform .15s}
.uq-opt:hover{border-color:var(--uq-border-strong);background:var(--uq-hover)}
.uq-opt:active{transform:scale(.99)}
.uq-opt:has(input:checked){border-color:#16a34a;background:var(--uq-opt-on);box-shadow:0 0 0 3px rgba(22,163,74,.12)}
.uq-opt input{accent-color:#16a34a;width:18px;height:18px;margin:0;flex:none}
label.uq-label{display:block;margin-top:14px;font-size:14px;font-weight:500;color:var(--uq-fg)}
textarea{display:block;width:100%;margin-top:6px;min-height:80px;padding:10px 12px;border:1px solid var(--uq-border-strong);border-radius:12px;font:inherit;color:inherit;background:var(--uq-bg);resize:vertical;transition:border-color .15s,box-shadow .15s}
textarea:focus{border-color:#16a34a;box-shadow:0 0 0 4px rgba(22,163,74,.15);outline:none}
.uq-actions{display:flex;flex-direction:column;gap:10px;margin-top:22px}
.uq-btn{display:block;width:100%;min-height:46px;padding:12px 16px;border-radius:12px;border:1px solid transparent;font:inherit;font-weight:600;font-size:15px;cursor:pointer;text-align:center;transition:background-color .15s,border-color .15s,box-shadow .15s,transform .12s,filter .15s}
.uq-btn:active:not([disabled]){transform:scale(.98)}
.uq-btn[disabled]{opacity:.5;cursor:not-allowed}
.uq-primary{background:linear-gradient(180deg,#15803d,#166534);color:#fff;box-shadow:0 0 0 1px rgba(22,163,74,.25),0 6px 18px -6px rgba(34,197,94,.55)}
.uq-primary:hover:not([disabled]){filter:brightness(1.1);box-shadow:0 0 0 1px rgba(22,163,74,.35),0 8px 26px -6px rgba(34,197,94,.65)}
.uq-secondary{background:var(--uq-bg);color:var(--uq-fg);border-color:var(--uq-border-strong)}
.uq-secondary:hover:not([disabled]){border-color:var(--uq-faint);background:var(--uq-hover)}
.uq-link{background:transparent;color:var(--uq-subtle);font-weight:500;text-decoration:underline;text-underline-offset:3px}
.uq-link:hover:not([disabled]){color:var(--uq-fg)}
.uq-badge{display:inline-block;margin-bottom:10px;padding:2px 10px;border-radius:999px;background:var(--uq-badge-bg);color:var(--uq-badge-fg);font-size:12px;font-weight:600}
.uq-error{margin-top:14px;padding:10px 12px;border-radius:12px;background:var(--uq-err-bg);color:var(--uq-err-fg);font-size:14px}
.uq-spinner{width:28px;height:28px;margin:18px auto 6px;border:3px solid var(--uq-badge-bg);border-top-color:#16a34a;border-radius:50%;animation:uq-spin .8s linear infinite}
@keyframes uq-spin{to{transform:rotate(360deg)}}
.uq-foot{margin-top:18px;text-align:center;font-size:11px;color:var(--uq-faint)}
button:focus-visible,input:focus-visible,textarea:focus-visible,.uq-close:focus-visible{outline:2px solid #16a34a;outline-offset:2px}
.uq-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
`;
