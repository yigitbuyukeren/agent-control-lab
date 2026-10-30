/** The single local page of `gui`: no external resources, no storage, text is only ever inserted as text. */
export function guiPage(token: string, nonce: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark"><meta name="acl-token" content="${token}">
<title>Agent Control Lab</title>
<style nonce="${nonce}">
:root{--bg:#0e1116;--panel:#161b22;--line:#2a313c;--fg:#e6edf3;--dim:#8b949e;--acc:#58a6ff;--ok:#3fb950;--bad:#f85149;--warn:#d29922}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:980px;margin:0 auto;padding:24px 16px 48px}h1{font-size:20px;margin:0 0 4px}p.sub{color:var(--dim);margin:0 0 20px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px;margin-bottom:16px}
label{display:block;font-size:13px;color:var(--dim);margin:0 0 4px}textarea,select,input{width:100%;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:8px;font:inherit}
textarea{min-height:120px;resize:vertical}.row{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-top:12px}
button{background:var(--acc);color:#04111f;border:0;border-radius:6px;padding:9px 18px;font:inherit;font-weight:600;cursor:pointer}button:disabled{opacity:.5;cursor:wait}
.note{color:var(--dim);font-size:13px;margin-top:10px}.badge{display:inline-block;border-radius:999px;padding:1px 10px;font-size:12px;border:1px solid var(--line)}
.ok{color:var(--ok)}.bad{color:var(--bad)}.warn{color:var(--warn)}h2{font-size:15px;margin:0 0 8px}
pre{margin:0;white-space:pre-wrap;word-break:break-word;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.l{display:block}.l.k{color:var(--acc)}.l.e{color:var(--warn)}
</style></head><body><main>
<h1>Agent Control Lab</h1>
<p class="sub">Dry-run preview only: nothing is started, written or saved. The preview is produced by the real CLI.</p>
<form id="f" class="card">
<label for="task">Task</label><textarea id="task" maxlength="20000" required></textarea>
<div class="row">
<div><label for="workflow">Workflow</label><select id="workflow"><option>plan-review</option><option>plan-implement-review</option></select></div>
<div><label for="routing">Model routing</label><select id="routing"><option>auto</option><option>adaptive</option><option>measured</option><option>research</option><option>guided</option></select></div>
<div><label for="policy">Policy</label><select id="policy"><option>economy</option><option selected>balanced</option><option>quality</option></select></div>
</div>
<div class="row" id="wrow" hidden>
<div><label for="workspace">Workspace (existing linked worktree)</label><input id="workspace" autocomplete="off"></div>
<div><label for="verify">Verify command (shown, not run)</label><input id="verify" autocomplete="off"></div>
</div>
<div class="row" id="steps"></div>
<p class="note">Per-step model/effort: leave empty for automatic. A manual value always wins over routing.</p>
<p><button id="go" type="submit">Preview (dry run)</button> <span id="state" class="note"></span></p>
</form>
<div id="out"></div>
</main>
<script nonce="${nonce}">
const $=(i)=>document.getElementById(i);
const token=document.querySelector('meta[name=acl-token]').content;
const STEPS={'plan-review':['plan','review'],'plan-implement-review':['plan','implement','review']};
function drawSteps(){const box=$('steps');box.replaceChildren();
 for(const s of STEPS[$('workflow').value]){for(const kind of ['model','effort']){
  const d=document.createElement('div'),l=document.createElement('label'),i=document.createElement('input');
  l.textContent=s+' '+kind;i.id=kind+'-'+s;i.autocomplete='off';i.placeholder='auto';d.append(l,i);box.append(d);}}
 $('wrow').hidden=$('workflow').value!=='plan-implement-review';}
$('workflow').addEventListener('change',drawSteps);drawSteps();
function card(title,lines,cls){const c=document.createElement('div');c.className='card';const h=document.createElement('h2');h.textContent=title;if(cls){const b=document.createElement('span');b.className='badge '+cls;b.textContent=' ';h.append(' ',b);}
 const p=document.createElement('pre');for(const t of lines){const s=document.createElement('span');s.className='l'+(/^ {2}(selected|routing basis|uncertainty|evidence|issue|warning)/.test(t)?' k':'');s.textContent=t;p.append(s);}c.append(h,p);return c;}
function render(res){const out=$('out');out.replaceChildren();
 const verdict=/verdict: would run/.test(res.output)?'would run':'would refuse';
 const sum=document.createElement('div');sum.className='card';sum.innerHTML='';
 const h=document.createElement('h2');h.textContent='Verdict: '+verdict+' (exit '+res.exitCode+')';h.className=verdict==='would run'?'ok':'bad';sum.append(h);out.append(sum);
 const groups=[];let cur={title:'Plan overview',lines:[]};
 for(const line of res.output.split('\\n')){if(/^ {2}step \\d+\\/\\d+ /.test(line)){groups.push(cur);cur={title:line.trim(),lines:[]};}else if(line!=='')cur.lines.push(line);}
 groups.push(cur);for(const g of groups)if(g.lines.length)out.append(card(g.title,g.lines));
 if(res.errors)out.append(card('Messages',res.errors.split('\\n').filter(Boolean)));}
$('f').addEventListener('submit',async(e)=>{e.preventDefault();$('go').disabled=true;$('state').textContent='running…';
 const w=$('workflow').value,steps={models:{},efforts:{}};
 for(const s of STEPS[w]){for(const k of ['model','effort']){const v=$(k+'-'+s).value.trim();if(v)steps[k+'s'][s]=v;}}
 const body={workflow:w,task:$('task').value,routing:$('routing').value,policy:$('policy').value,steps,workspace:$('workspace').value.trim(),verify:$('verify').value.trim()};
 try{const r=await fetch('/api/dry-run',{method:'POST',headers:{'content-type':'application/json','x-acl-token':token},body:JSON.stringify(body)});
  const j=await r.json();if(!r.ok){$('out').replaceChildren(card('Error',[String(j.error||r.status)]));}else render(j);$('state').textContent='';}
 catch{$('state').textContent='request failed';}finally{$('go').disabled=false;}});
</script></body></html>
`;
}
