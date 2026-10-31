export const GUI_CSS = String.raw`
:root{color-scheme:dark;--bg:#0a0b10;--bg2:#0f1118;--panel:#12141c;--panel2:#171a24;--line:#242836;--line2:#2f3446;--fg:#ecedf3;--dim:#9096a8;--mute:#646a7e;
--acc:#8b7cff;--acc2:#38d6c4;--ok:#3ddc97;--bad:#ff6b7a;--warn:#f5b84b;--claude:#e8946a;--codex:#5aa9ff;--r:14px;
--font:Inter,ui-sans-serif,-apple-system,"SF Pro Text","Segoe UI",Roboto,sans-serif;--mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace}
*{box-sizing:border-box}[hidden]{display:none!important}html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.55 var(--font);-webkit-font-smoothing:antialiased;
background-image:radial-gradient(900px 500px at 85% -10%,rgba(139,124,255,.14),transparent 60%),radial-gradient(700px 420px at -5% 105%,rgba(56,214,196,.09),transparent 60%);background-attachment:fixed}
.sprite{display:none}svg.i{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round;flex:none}
button,select,input,textarea{font:inherit;color:inherit}
:focus-visible{outline:2px solid var(--acc);outline-offset:2px;border-radius:8px}
.app{display:grid;grid-template-columns:232px 1fr;grid-template-rows:56px 1fr;min-height:100vh}
.nav{grid-row:1/3;border-right:1px solid var(--line);background:rgba(10,11,16,.7);backdrop-filter:blur(12px);padding:16px 12px;display:flex;flex-direction:column;gap:4px;position:sticky;top:0;height:100vh}
.brand{display:flex;align-items:center;gap:10px;padding:4px 8px 18px;font-weight:650;letter-spacing:-.01em}
.logo{width:30px;height:30px;border-radius:9px;background:linear-gradient(135deg,var(--acc),var(--acc2));display:grid;place-items:center;color:#071016;box-shadow:0 6px 20px rgba(139,124,255,.35)}
.navbtn{display:flex;align-items:center;gap:10px;padding:9px 10px;border:0;background:none;border-radius:9px;color:var(--dim);cursor:pointer;text-align:left;transition:background .15s,color .15s}
.navbtn:hover{background:var(--panel);color:var(--fg)}.navbtn[aria-current=page]{background:var(--panel2);color:var(--fg);box-shadow:inset 2px 0 0 var(--acc)}
.navfoot{margin-top:auto;color:var(--mute);font-size:12px;padding:8px;display:flex;gap:8px;align-items:center}
.top{grid-column:2;display:flex;align-items:center;gap:10px;padding:0 24px;border-bottom:1px solid var(--line);background:rgba(10,11,16,.6);backdrop-filter:blur(12px);position:sticky;top:0;z-index:5}
.top h1{font-size:15px;margin:0;font-weight:600;letter-spacing:-.01em;margin-right:auto}
.pill{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--line);background:var(--panel);border-radius:999px;padding:3px 11px;font-size:12px;color:var(--dim);white-space:nowrap}
.dot{width:8px;height:8px;border-radius:50%;background:var(--mute);flex:none}.dot.ok{background:var(--ok);box-shadow:0 0 0 3px rgba(61,220,151,.15)}.dot.bad{background:var(--bad)}.dot.warn{background:var(--warn)}
.pill.safe{color:var(--acc2);border-color:rgba(56,214,196,.35);background:rgba(56,214,196,.07)}
.iconbtn{display:grid;place-items:center;width:32px;height:32px;border:1px solid var(--line);background:var(--panel);border-radius:9px;color:var(--dim);cursor:pointer;transition:.15s}
.iconbtn:hover{color:var(--fg);border-color:var(--line2)}.iconbtn.spin svg{animation:spin .8s linear infinite}
main{grid-column:2;padding:24px;max-width:1240px;width:100%;margin:0 auto}
.view{animation:rise .35s ease both}
.grid{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:20px;align-items:start}
.stack{display:grid;gap:20px}
.card{background:linear-gradient(180deg,var(--panel2),var(--panel));border:1px solid var(--line);border-radius:var(--r);padding:18px;transition:border-color .2s}
.card:hover{border-color:var(--line2)}
.card h2{margin:0 0 4px;font-size:14px;font-weight:600;display:flex;align-items:center;gap:8px;letter-spacing:-.005em}
.card .hint{margin:0 0 14px;color:var(--mute);font-size:12.5px}
textarea,select,input[type=text]{width:100%;background:var(--bg2);border:1px solid var(--line);border-radius:10px;padding:10px 12px;transition:border-color .15s,box-shadow .15s}
textarea:hover,select:hover,input:hover{border-color:var(--line2)}textarea:focus,select:focus,input:focus{outline:none;border-color:var(--acc);box-shadow:0 0 0 3px rgba(139,124,255,.18)}
textarea{min-height:150px;resize:vertical;line-height:1.55}
select{appearance:none;background-image:linear-gradient(45deg,transparent 50%,var(--dim) 50%),linear-gradient(135deg,var(--dim) 50%,transparent 50%);background-position:calc(100% - 17px) 55%,calc(100% - 12px) 55%;background-size:5px 5px;background-repeat:no-repeat;padding-right:30px}
label.l{display:block;font-size:12px;color:var(--dim);margin:0 0 5px}
.meta{display:flex;justify-content:space-between;color:var(--mute);font-size:12px;margin-top:6px}
.seg{display:grid;grid-auto-flow:column;grid-auto-columns:1fr;background:var(--bg2);border:1px solid var(--line);border-radius:11px;padding:3px;gap:3px}
.seg button{border:0;background:none;border-radius:8px;padding:7px 6px;color:var(--dim);cursor:pointer;transition:.15s;font-weight:500}
.seg button:hover{color:var(--fg)}.seg button[aria-pressed=true]{background:var(--panel2);color:var(--fg);box-shadow:0 0 0 1px var(--line2),0 4px 14px rgba(0,0,0,.35)}
.routes{display:grid;gap:8px}
.route{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;text-align:left;border:1px solid var(--line);background:var(--bg2);border-radius:11px;padding:10px 12px;cursor:pointer;transition:.15s}
.route:hover{border-color:var(--line2);transform:translateY(-1px)}.route[aria-pressed=true]{border-color:var(--acc);background:rgba(139,124,255,.09)}
.route b{font-weight:600}.route span{color:var(--mute);font-size:12.5px;grid-column:2}.route .rd{grid-row:1/3;align-self:center;width:14px;height:14px;border-radius:50%;border:2px solid var(--line2)}
.route[aria-pressed=true] .rd{border-color:var(--acc);background:radial-gradient(circle,var(--acc) 40%,transparent 45%)}
.badge{font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;padding:1px 7px;border-radius:6px;border:1px solid var(--line2);color:var(--dim);margin-left:6px;font-weight:600}
.switch{display:flex;gap:10px;align-items:flex-start;color:var(--dim);font-size:12.5px;cursor:pointer}
.switch input{margin-top:3px;accent-color:var(--acc)}
.go{width:100%;display:flex;align-items:center;justify-content:center;gap:8px;border:0;border-radius:11px;padding:12px;font-weight:650;color:#0a0b10;cursor:pointer;background:linear-gradient(135deg,var(--acc),var(--acc2));box-shadow:0 8px 24px rgba(139,124,255,.3);transition:.2s}
.go:hover{transform:translateY(-1px);box-shadow:0 12px 30px rgba(139,124,255,.4)}.go:active{transform:none}.go:disabled{opacity:.55;cursor:progress;transform:none}
.flow{display:flex;align-items:stretch;gap:0;overflow-x:auto;padding:4px 2px 8px}
.node{flex:1 1 0;min-width:210px;border:1px solid var(--line);background:var(--bg2);border-radius:13px;padding:14px;position:relative;transition:.2s;animation:rise .3s ease both}
.node:hover{border-color:var(--line2)}.node.would-run{border-color:rgba(61,220,151,.45)}.node.would-refuse{border-color:rgba(255,107,122,.5)}
.node .ttl{display:flex;align-items:center;gap:8px;font-weight:600;margin-bottom:2px}.node .sub{color:var(--mute);font-size:12px;margin-bottom:12px}
.node .ico{width:30px;height:30px;border-radius:9px;display:grid;place-items:center;background:var(--panel2);border:1px solid var(--line)}
.node.claude .ico{color:var(--claude)}.node.codex .ico{color:var(--codex)}
.num{margin-left:auto;color:var(--mute);font:600 11px var(--mono)}
.link{flex:0 0 36px;align-self:center;height:2px;margin:0 -1px;background:repeating-linear-gradient(90deg,var(--line2) 0 5px,transparent 5px 9px);background-size:18px 2px;position:relative}
.link.live{background-image:repeating-linear-gradient(90deg,var(--acc2) 0 5px,transparent 5px 9px);animation:dash 1s linear infinite}
.fields{display:grid;gap:8px}
.chip{display:inline-flex;align-items:center;gap:6px;border-radius:7px;padding:2px 9px;font:500 12px var(--mono);border:1px solid var(--line2);background:var(--panel)}
.chip.ok{color:var(--ok);border-color:rgba(61,220,151,.35)}.chip.bad{color:var(--bad);border-color:rgba(255,107,122,.4)}.chip.warn{color:var(--warn);border-color:rgba(245,184,75,.4)}.chip.def{color:var(--dim)}
.banner{display:flex;gap:12px;align-items:center;border-radius:var(--r);padding:14px 18px;border:1px solid var(--line);animation:rise .3s ease both}
.banner.ok{background:rgba(61,220,151,.07);border-color:rgba(61,220,151,.35)}.banner.bad{background:rgba(255,107,122,.07);border-color:rgba(255,107,122,.4)}
.banner b{font-size:15px}.banner small{display:block;color:var(--dim)}
.res{display:grid;grid-template-columns:repeat(auto-fit,minmax(290px,1fr));gap:16px}
.res .card{animation:rise .35s ease both}
.row{display:flex;align-items:center;gap:10px;padding:8px 0;border-top:1px solid var(--line)}.row:first-of-type{border-top:0}
.row .k{width:92px;color:var(--mute);font-size:12px;flex:none}.row .v{min-width:0;flex:1}
.why{color:var(--dim);font-size:12.5px;margin:2px 0 0;overflow-wrap:anywhere}
.unc{display:flex;gap:4px;align-items:center}.unc i{width:22px;height:6px;border-radius:3px;background:var(--line2)}
.unc.low i:nth-child(-n+1){background:var(--ok)}.unc.medium i:nth-child(-n+2){background:var(--warn)}.unc.high i{background:var(--bad)}
details{border:1px solid var(--line);border-radius:11px;background:var(--bg2);margin-top:10px}
summary{cursor:pointer;padding:9px 12px;color:var(--dim);display:flex;align-items:center;gap:8px;list-style:none;border-radius:11px;transition:color .15s}
summary::-webkit-details-marker{display:none}summary:hover{color:var(--fg)}summary svg{transition:transform .2s}details[open]>summary svg.ch{transform:rotate(90deg)}
.ev{padding:4px 12px 12px;display:grid;gap:8px}.ev p{margin:0;font-size:12.5px;color:var(--dim);overflow-wrap:anywhere;padding-left:10px;border-left:2px solid var(--line2)}
.ev p.benchmark{border-color:var(--acc)}.ev p.documentation{border-color:var(--warn)}.ev p.catalog{border-color:var(--acc2)}.ev p.access{border-color:var(--bad)}
.ev h4{margin:6px 0 0;font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:var(--mute);font-weight:600}
pre{margin:0;padding:12px;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.55 var(--mono);color:var(--dim);max-height:360px;overflow:auto}
.pc{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(300px,1fr))}
.pc .head{display:flex;align-items:center;gap:12px;margin-bottom:10px}.pc .ico{width:40px;height:40px;border-radius:11px;display:grid;place-items:center;background:var(--bg2);border:1px solid var(--line)}
.bar{height:8px;border-radius:5px;background:var(--bg2);border:1px solid var(--line);overflow:hidden}.bar>div{height:100%;border-radius:5px;background:linear-gradient(90deg,var(--acc2),var(--acc));transition:width .6s cubic-bezier(.2,.8,.2,1)}
.bar>div.hot{background:linear-gradient(90deg,var(--warn),var(--bad))}
.qrow{margin-top:10px}.qrow .qh{display:flex;justify-content:space-between;font-size:12px;color:var(--dim);margin-bottom:5px}
table{width:100%;border-collapse:collapse;font-size:12.5px}th,td{text-align:left;padding:8px 10px;border-top:1px solid var(--line)}th{color:var(--mute);font-weight:500;border-top:0}td.m{font-family:var(--mono)}
.empty{color:var(--mute);padding:22px;text-align:center;border:1px dashed var(--line2);border-radius:var(--r)}
.skel{height:14px;border-radius:6px;background:linear-gradient(90deg,var(--panel) 25%,var(--panel2) 50%,var(--panel) 75%);background-size:200% 100%;animation:shine 1.2s linear infinite}
.wsum{margin-top:14px}.wsum h3{font-size:14px;margin:0 0 8px}
.list{margin:0;padding-left:18px;color:var(--dim)}.list li{margin:5px 0}
.toast{position:fixed;right:20px;bottom:20px;background:var(--panel2);border:1px solid var(--bad);color:var(--fg);padding:10px 14px;border-radius:11px;animation:rise .25s ease both;z-index:20;max-width:360px}
.pathrow{display:flex;gap:8px}.pathrow input{flex:1;min-width:0}
.chipbtn{border:1px solid var(--line2);background:var(--panel);color:var(--fg);border-radius:9px;padding:6px 12px;cursor:pointer;white-space:nowrap;transition:.15s}.chipbtn:hover{border-color:var(--acc)}.chipbtn:disabled{opacity:.5;cursor:default}
.chipbtn.danger{border-color:rgba(255,107,122,.5);color:var(--bad)}.chipbtn.danger:hover{background:rgba(255,107,122,.1)}
.picker{border:1px solid var(--line);border-radius:10px;background:var(--bg2);max-height:280px;overflow:auto;margin-top:8px}
.pkh{padding:8px 10px;border-bottom:1px solid var(--line);color:var(--dim);font-size:12px;overflow-wrap:anywhere}.pkf{display:flex;gap:8px;padding:8px 10px;border-top:1px solid var(--line);position:sticky;bottom:0;background:var(--bg2)}
.pk{display:flex;gap:8px;align-items:center;width:100%;border:0;background:none;color:var(--fg);padding:7px 10px;text-align:left;cursor:pointer}.pk:hover{background:var(--panel2)}
.go.run{margin-top:10px;background:linear-gradient(135deg,var(--ok),var(--acc2));box-shadow:0 8px 24px rgba(61,220,151,.22)}.go.run:disabled{background:var(--panel2);color:var(--mute);box-shadow:none;cursor:not-allowed}
.runhead{display:flex;align-items:center;gap:10px;margin-bottom:12px}.runhead h2{margin:0;margin-right:auto}.steps{display:grid;gap:8px;margin-bottom:12px}
.srow{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:8px 10px;border:1px solid var(--line);border-radius:10px;background:var(--bg2)}
.node.running{border-color:var(--acc2);box-shadow:0 0 0 3px rgba(56,214,196,.12);animation:pulse 1.4s ease-in-out infinite}.rstat{margin-top:8px}
pre.refusal{border:1px solid rgba(255,107,122,.4);border-radius:10px;background:rgba(255,107,122,.05);color:var(--fg);margin:10px 0}pre.modelout{background:var(--bg2);border:1px solid var(--line);border-radius:10px;color:var(--fg)}
.dlg{background:var(--panel);color:var(--fg);border:1px solid var(--line2);border-radius:16px;padding:20px;max-width:540px;width:calc(100% - 32px)}.dlg::backdrop{background:rgba(0,0,0,.65);backdrop-filter:blur(4px)}
.dlg h2{margin:0 0 12px;font-size:16px}.facts{display:grid;gap:6px;margin-bottom:12px}.facts div{display:flex;gap:10px;align-items:baseline}.facts .k{width:120px;color:var(--mute);font-size:12px;flex:none}.facts code{font:12.5px var(--mono);overflow-wrap:anywhere}
.dlgbtn{display:flex;gap:10px;justify-content:flex-end;margin-top:14px}.dlgbtn .go{width:auto;padding:10px 18px}
@keyframes pulse{50%{box-shadow:0 0 0 6px rgba(56,214,196,.05)}}
@keyframes rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}@keyframes spin{to{transform:rotate(360deg)}}
@keyframes dash{to{background-position:18px 0}}@keyframes shine{to{background-position:-200% 0}}
@media(max-width:1020px){.grid{grid-template-columns:minmax(0,1fr)}}.stack,.card{min-width:0}
@media(max-width:760px){.app{grid-template-columns:1fr;grid-template-rows:56px 1fr 62px}.nav{grid-row:3;grid-column:1;flex-direction:row;height:auto;position:fixed;top:auto;bottom:0;left:0;right:0;z-index:6;border-right:0;border-top:1px solid var(--line);padding:6px;justify-content:space-around;background:rgba(10,11,16,.92)}
.brand,.navfoot{display:none}.navbtn{flex-direction:column;gap:2px;font-size:11px;padding:6px 12px;text-align:center}.navbtn[aria-current=page]{box-shadow:none}.top{grid-column:1;padding:0 14px}main{grid-column:1;padding:16px 14px 84px}
.top .pill:not(.safe){display:none}.top h1{font-size:14px}.top .pill.safe{padding:3px 9px}.flow{flex-direction:column;overflow:visible}.node{min-width:0}.link{flex:0 0 22px;width:2px;height:22px;align-self:center;background:repeating-linear-gradient(180deg,var(--line2) 0 5px,transparent 5px 9px)}.link.live{background-image:repeating-linear-gradient(180deg,var(--acc2) 0 5px,transparent 5px 9px)}}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`;
