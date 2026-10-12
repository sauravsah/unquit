/**
 * The widget's only stylesheet. It lives inside a shadow root, so the host
 * page's CSS can't reach in and ours can't leak out. `:host { all: initial }`
 * resets anything inherited (fonts, colours, line-height).
 */
export const WIDGET_CSS = `
:host{all:initial}
*{box-sizing:border-box;margin:0}
.uq-root{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;color:#0a0a0a;font-size:15px;line-height:1.5;-webkit-font-smoothing:antialiased}
.uq-overlay{position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(10,10,10,.45)}
.uq-inline{display:flex;justify-content:center;padding:24px 12px;background:#f5f5f5;border-radius:12px}
.uq-card{position:relative;width:100%;max-width:440px;max-height:calc(100vh - 32px);overflow:auto;background:#fff;border-radius:16px;padding:28px 24px 24px;box-shadow:0 20px 50px rgba(0,0,0,.18);animation:uq-in .16s ease-out}
.uq-inline .uq-card{max-height:none;box-shadow:0 1px 3px rgba(0,0,0,.1)}
@keyframes uq-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.uq-card{animation:none}}
@media (max-width:520px){.uq-overlay{align-items:flex-end;padding:0}.uq-overlay .uq-card{max-width:none;max-height:92vh;border-radius:16px 16px 0 0;padding:24px 18px calc(18px + env(safe-area-inset-bottom))}}
.uq-close{position:absolute;top:10px;right:10px;width:36px;height:36px;border:0;border-radius:8px;background:transparent;color:#525252;font-size:22px;line-height:1;cursor:pointer}
.uq-close:hover{background:#f5f5f5;color:#0a0a0a}
h2{font-size:20px;line-height:1.3;font-weight:600;letter-spacing:-.01em;padding-right:32px;outline:none}
p{margin-top:8px;color:#404040}
.uq-muted{color:#737373;font-size:13px}
fieldset{border:0;padding:0;margin:18px 0 0}
legend{font-size:14px;font-weight:500;color:#404040;margin-bottom:8px;padding:0}
.uq-opt{display:flex;align-items:center;gap:10px;padding:11px 12px;margin-top:8px;border:1px solid #e5e5e5;border-radius:10px;cursor:pointer;min-height:44px}
.uq-opt:hover{border-color:#a3a3a3}
.uq-opt:has(input:checked){border-color:#16a34a;background:#f0fdf4}
.uq-opt input{accent-color:#16a34a;width:18px;height:18px;margin:0;flex:none}
label.uq-label{display:block;margin-top:14px;font-size:14px;font-weight:500}
textarea{display:block;width:100%;margin-top:6px;min-height:80px;padding:10px 12px;border:1px solid #d4d4d4;border-radius:10px;font:inherit;color:inherit;resize:vertical}
.uq-actions{display:flex;flex-direction:column;gap:10px;margin-top:22px}
.uq-btn{display:block;width:100%;min-height:46px;padding:12px 16px;border-radius:10px;border:1px solid transparent;font:inherit;font-weight:600;font-size:15px;cursor:pointer;text-align:center}
.uq-btn[disabled]{opacity:.5;cursor:not-allowed}
.uq-primary{background:#16a34a;color:#fff}
.uq-primary:hover:not([disabled]){background:#15803d}
.uq-secondary{background:#fff;color:#0a0a0a;border-color:#d4d4d4}
.uq-secondary:hover:not([disabled]){border-color:#a3a3a3}
.uq-link{background:transparent;color:#525252;font-weight:500;text-decoration:underline;text-underline-offset:3px}
.uq-link:hover:not([disabled]){color:#0a0a0a}
.uq-badge{display:inline-block;margin-bottom:10px;padding:2px 10px;border-radius:999px;background:#dcfce7;color:#15803d;font-size:12px;font-weight:600}
.uq-error{margin-top:14px;padding:10px 12px;border-radius:10px;background:#fef2f2;color:#991b1b;font-size:14px}
.uq-spinner{width:28px;height:28px;margin:18px auto 6px;border:3px solid #dcfce7;border-top-color:#16a34a;border-radius:50%;animation:uq-spin .8s linear infinite}
@keyframes uq-spin{to{transform:rotate(360deg)}}
.uq-foot{margin-top:18px;text-align:center;font-size:11px;color:#a3a3a3}
button:focus-visible,input:focus-visible,textarea:focus-visible,.uq-close:focus-visible{outline:2px solid #16a34a;outline-offset:2px}
.uq-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
`;
