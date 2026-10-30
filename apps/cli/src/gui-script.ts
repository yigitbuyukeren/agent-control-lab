export const GUI_JS = String.raw`
(()=>{'use strict';
const NS='http://www.w3.org/2000/svg';
const $=(s,r=document)=>r.querySelector(s);
const token=$('meta[name=acl-token]').content;
const IC=(n)=>{const s=document.createElementNS(NS,'svg');s.setAttribute('class','i');const u=document.createElementNS(NS,'use');u.setAttribute('href','#i-'+n);s.append(u);return s};
function h(tag,a,...kids){const e=document.createElement(tag);for(const[k,v]of Object.entries(a||{})){if(k==='class')e.className=v;else if(k.startsWith('on'))e.addEventListener(k.slice(2),v);else if(v===true)e.setAttribute(k,'');else if(v!==false&&v!=null)e.setAttribute(k,v)}
 for(const c of kids.flat()){if(c==null||c===false)continue;e.append(c.nodeType?c:document.createTextNode(String(c)))}return e}
const ROUTES=[
 {id:'auto',name:'Otomatik',d:'Sağlayıcı varsayılanları; hiçbir şeyi değiştirmez.'},
 {id:'adaptive',name:'Uyarlanabilir',d:'Codex listesinde yalnızca tek uygun model kalırsa onu seçer.'},
 {id:'measured',name:'Ölçüme dayalı',d:'Yerel, doğrulanmış sonuç kayıtlarından seçer; veri yoksa varsayılan.'},
 {id:'research',name:'Araştırma (katı)',d:'Yalnızca aynı kıyaslama, sürüm ve eforla karşılaştırılabilir yayımlanmış sonuçlar.'},
 {id:'guided',name:'Yönlendirmeli',d:'Önce katı kanıt; yoksa belgelenmiş model amacı. Belirsizlik ayrıca gösterilir.',badge:'önerilen'}];
const POLICIES=[{id:'economy',name:'Ekonomi'},{id:'balanced',name:'Dengeli'},{id:'quality',name:'Kalite'}];
const POLICY_HINT={economy:'Mümkün olan en düşük efor ve verimli modeller.',balanced:'Görev boyutuna göre orta efor; satıcının dengeli modeli.',quality:'Yetenek öncelikli; daha yüksek efor.'};
const FLOWS={'plan-review':['plan','review'],'plan-implement-review':['plan','implement','review']};
const STEPS={
 plan:{tr:'Plan',icon:'layers',d:'Görevi adımlara böler. Araçsız, oturum kaydı yok.',provider:()=> 'claude'},
 implement:{tr:'Uygulama',icon:'term',d:'Yalnızca izole çalışma ağacına yazar.',provider:()=> 'codex'},
 review:{tr:'İnceleme',icon:'shield',d:'Çıktıyı bağımsız olarak gözden geçirir.',provider:(w)=>w==='plan-review'?'codex':'claude'}};
const PN={claude:'Claude',codex:'Codex'};
const S={view:'run',workflow:'plan-review',routing:'guided',policy:'balanced',accept:false,steps:{plan:{},implement:{},review:{}},status:null,result:null,busy:false,loading:true};
const modelsOf=(p)=>{const g=(S.status&&S.status.models||[]).find((x)=>x.provider===p);return g?g.models:[]};
const effortsFor=(p,id)=>{const ms=modelsOf(p);const m=ms.find((x)=>x.id===id);if(m)return m.efforts;const all=[];for(const x of ms)for(const e of x.efforts)if(!all.includes(e))all.push(e);return all};
function toast(t){const e=h('div',{class:'toast',role:'alert'},t);document.body.append(e);setTimeout(()=>e.remove(),5000)}
async function api(path,opt){const r=await fetch(path,{...opt,headers:{'x-acl-token':token,'content-type':'application/json'}});let j={};try{j=await r.json()}catch{}if(!r.ok)throw new Error(j.error||('HTTP '+r.status));return j}
function rel(iso){const ms=new Date(iso).getTime()-Date.now();if(!Number.isFinite(ms))return iso;const d=new Date(iso).toLocaleString('tr-TR',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'});if(ms<=0)return d;const m=Math.round(ms/60000);const t=m>=1440?Math.floor(m/1440)+' g '+Math.floor(m%1440/60)+' sa':m>=60?Math.floor(m/60)+' sa '+(m%60)+' dk':m+' dk';return d+' · '+t+' sonra'}
const winName=(l)=>/^5h/.test(l)?'5 saatlik pencere':/^7d/.test(l)?'7 günlük pencere':l;
function split(v){const m=/^(.*?) \(([^)]*)\)$/.exec(v||'');return m?{name:m[1],note:m[2]}:{name:v||'',note:''}}
function settingChip(s){if(!s)return h('span',{class:'chip def'},'—');const p=split(s.value);
 if(p.name==='provider-default')return h('span',{class:'chip def'},'Sağlayıcı varsayılanı');
 const ok=p.note==='verified';return h('span',{class:'chip '+(ok?'ok':p.note?'warn':'def')},p.name,p.note?(ok?' · doğrulandı':' · '+p.note):'')}
function verifyChip(v){if(v==null)return h('span',{class:'chip def'},'—');if(v==='verified')return h('span',{class:'chip ok'},'Doğrulandı');if(/nothing to verify/.test(v))return h('span',{class:'chip def'},'Sabitlenmedi, doğrulanacak şey yok');return h('span',{class:'chip warn'},v)}
const BASIS=(b)=>!b?'—':/benchmark/i.test(b)?'Kıyaslama kanıtı (katı)':/documented intent|documentation/i.test(b)?'Belgelenmiş model amacı — ölçüm değil':/provider default/i.test(b)?'Yeterli dayanak yok → sağlayıcı varsayılanı':b;
const UNC={low:'Düşük',medium:'Orta',high:'Yüksek'};
const EVK=[['benchmark','Kıyaslama kanıtı'],['documentation','Dokümantasyon (ölçüm değil)'],['catalog','Kanıt kataloğu'],['access','Erişim'],['other','Diğer']];

/* ---------- shell ---------- */
const NAV=[['run','flow','Orkestrasyon'],['providers','cpu','Sağlayıcılar'],['safety','lock','Güvenlik']];
const TITLES={run:'Orkestrasyon önizlemesi',providers:'Sağlayıcılar ve kota',safety:'Güvenlik ve sınırlar'};
const app=$('#app');
const nav=h('nav',{class:'nav','aria-label':'Ana gezinme'},h('div',{class:'brand'},h('div',{class:'logo'},IC('spark')),'Agent Control Lab'),
 NAV.map(([id,ic,t])=>h('button',{class:'navbtn','data-view':id,onclick:()=>go(id)},IC(ic),t)),
 h('div',{class:'navfoot'},IC('lock'),'v0.2 · yerel'));
const topTitle=h('h1',{});const topPills=h('div',{style:null,class:'toppills'});
const refreshBtn=h('button',{class:'iconbtn',title:'Durumu yenile','aria-label':'Durumu yenile',onclick:()=>loadStatus()},IC('refresh'));
const topbar=h('header',{class:'top'},topTitle,h('span',{class:'pill safe'},IC('shield'),'Yalnızca önizleme'),topPills,refreshBtn);
const main=h('main',{});
app.append(nav,topbar,main);
function go(v){S.view=v;draw()}

/* ---------- top status ---------- */
function drawTop(){topTitle.textContent=TITLES[S.view];topPills.replaceChildren();topPills.className='toppills';topPills.style.display='contents';
 topPills.append(h('span',{class:'pill hideS'},h('span',{class:'dot ok'}),location.host));
 if(S.loading){topPills.append(h('span',{class:'pill'},h('span',{class:'skel',style:null}),'durum okunuyor…'));return}
 for(const p of(S.status&&S.status.providers)||[]){const ok=/logged in/.test(p.login||'');topPills.append(h('span',{class:'pill'},h('span',{class:'dot '+(ok?'ok':p.login?'warn':'bad')}),PN[p.id]))}
 for(const q of(S.status&&S.status.quota)||[]){const w=q.windows[0];if(w)topPills.append(h('span',{class:'pill hideS'},PN[q.provider]+' '+winName(w.label).split(' ')[0]+': %'+Math.round(w.usedPercent)))}}

/* ---------- run view ---------- */
const R={};
function buildRun(){
 R.task=h('textarea',{id:'task',maxlength:'20000',placeholder:'Örn. “Kullanıcı oturum süresini yapılandırılabilir yap ve testlerini ekle”',oninput:()=>{R.count.textContent=R.task.value.length.toLocaleString('tr-TR')+' / 20.000'},onkeydown:(e)=>{if((e.metaKey||e.ctrlKey)&&e.key==='Enter')preview()}});
 R.count=h('span',{},'0 / 20.000');
 R.flow=h('div',{class:'flow'});
 R.wf=h('div',{class:'seg',role:'group','aria-label':'İş akışı'});
 R.routes=h('div',{class:'routes'});
 R.pol=h('div',{class:'seg',role:'group','aria-label':'Politika'});R.polHint=h('p',{class:'hint'});
 R.ws=h('input',{type:'text',id:'ws',autocomplete:'off',placeholder:'/yol/izole-calisma-agaci'});
 R.verify=h('input',{type:'text',id:'vc',autocomplete:'off',placeholder:'pnpm test'});
 R.wsBox=h('div',{class:'card'},h('h2',{},IC('doc'),'Çalışma ağacı'),h('p',{class:'hint'},'Var olan, bağlı bir Git çalışma ağacı. Önizlemede yazılmaz.'),
  h('label',{class:'l',for:'ws'},'Yol'),R.ws,h('div',{style:null},''),h('label',{class:'l',for:'vc',},'Doğrulama komutu (yalnızca gösterilir, çalıştırılmaz)'),R.verify);
 R.acc=h('input',{type:'checkbox',id:'acc',onchange:()=>{S.accept=R.acc.checked}});
 R.go=h('button',{class:'go',type:'button',onclick:preview},IC('play'),h('span',{},'Önizle (dry run)'));
 R.out=h('div',{class:'stack'});
 R.view=h('div',{class:'view'},h('div',{class:'grid'},
  h('div',{class:'stack'},
   h('section',{class:'card'},h('h2',{},IC('doc'),'Görev'),h('p',{class:'hint'},'Metin yalnızca bu önizleme için kullanılır; hiçbir yere kaydedilmez.'),R.task,h('div',{class:'meta'},R.count,h('span',{},'⌘/Ctrl + Enter ile önizle'))),
   h('section',{class:'card'},h('h2',{},IC('flow'),'Akış'),h('p',{class:'hint'},'Her adım için model ve eforu elle seçebilirsiniz; elle seçim her zaman yönlendirmeden önce gelir.'),R.wf,h('div',{style:null,class:'sp'}),R.flow),
   R.out),
  h('aside',{class:'stack'},
   h('section',{class:'card'},h('h2',{},IC('spark'),'Model yönlendirme'),h('p',{class:'hint'},'Claude modelleri erişim doğrulanamadığı için hiçbir zaman otomatik sabitlenmez.'),R.routes),
   h('section',{class:'card'},h('h2',{},IC('gauge'),'Politika'),R.polHint,R.pol),
   R.wsBox,
   h('section',{class:'card'},h('label',{class:'switch',for:'acc'},R.acc,h('span',{},'Doğrulanamayan ayarları kabul ederek önizle ',h('code',{},'--accept-unverified'),'. Yalnızca önizlemeyi etkiler.'))),
   R.go)));
 main.append(R.view)}
function drawControls(){
 R.wf.replaceChildren(...Object.keys(FLOWS).map((id)=>h('button',{type:'button','aria-pressed':String(S.workflow===id),onclick:()=>{S.workflow=id;S.result=null;drawControls();drawFlow();drawResult()}},id==='plan-review'?'Plan → İnceleme':'Plan → Uygula → İncele')));
 R.routes.replaceChildren(...ROUTES.map((r)=>h('button',{type:'button',class:'route','aria-pressed':String(S.routing===r.id),onclick:()=>{S.routing=r.id;S.result=null;drawControls();drawResult()}},h('i',{class:'rd'}),h('b',{},r.name,r.badge?h('span',{class:'badge'},r.badge):null),h('span',{},r.d))));
 R.pol.replaceChildren(...POLICIES.map((p)=>h('button',{type:'button','aria-pressed':String(S.policy===p.id),onclick:()=>{S.policy=p.id;S.result=null;drawControls();drawResult()}},p.name)));
 R.polHint.textContent=POLICY_HINT[S.policy];
 R.wsBox.hidden=S.workflow!=='plan-implement-review'}
function nodeResult(id){return S.result&&S.result.view.steps.find((x)=>x.id===id)}
function drawFlow(){
 const ids=FLOWS[S.workflow];const kids=[];
 ids.forEach((id,i)=>{const d=STEPS[id];const prov=d.provider(S.workflow);const st=S.steps[id];const res=nodeResult(id);
  const ms=modelsOf(prov);
  const msel=h('select',{'aria-label':d.tr+' modeli',onchange:()=>{st.model=msel.value;if(st.effort&&!effortsFor(prov,st.model).includes(st.effort))st.effort='';S.result=null;drawFlow();drawResult()}},
   h('option',{value:''},'Otomatik (yönlendirme)'),ms.map((m)=>h('option',{value:m.id},m.label+' · '+m.id)));
  msel.value=st.model||'';
  const esel=h('select',{'aria-label':d.tr+' eforu',onchange:()=>{st.effort=esel.value;S.result=null;drawResult()}},h('option',{value:''},'Otomatik (politika)'),effortsFor(prov,st.model).map((e)=>h('option',{value:e},e)));
  esel.value=st.effort||'';
  const manualClaude=prov==='claude'&&(st.model||st.effort);
  kids.push(h('div',{class:'node '+prov+(res?' '+res.verdict:''),style:null},
   h('div',{class:'ttl'},h('span',{class:'ico'},IC(d.icon)),d.tr,h('span',{class:'num'},String(i+1).padStart(2,'0'))),
   h('div',{class:'sub'},d.d),
   h('div',{class:'fields'},h('span',{class:'chip'},h('span',{class:'dot',style:null}),PN[prov]),
    h('div',{},h('label',{class:'l'},'Model'),msel),h('div',{},h('label',{class:'l'},'Efor'),esel),
    manualClaude?h('p',{class:'why'},'Claude erişimi doğrulanamaz: elle seçim “doğrulanmamış” sayılır.'):null,
    res?h('div',{},settingChip(res.model),' ',settingChip(res.effort)):null)));
  if(i<ids.length-1)kids.push(h('div',{class:'link'+(S.result?' live':''),'aria-hidden':'true'}))});
 R.flow.replaceChildren(...kids)}
function drawResult(){
 R.out.replaceChildren();const res=S.result;
 if(!res){return}
 const v=res.view;const refuse=v.steps.find((s)=>s.refusal);
 const ok=v.verdict==='would-run';
 R.out.append(h('div',{class:'banner '+(ok?'ok':'bad')},IC(ok?'check':'alert'),h('div',{},h('b',{},ok?'Bu ayarlarla çalışırdı':v.verdict==='unknown'?'Önizleme yorumlanamadı':'Bu ayarlarla reddedilirdi'),
  h('small',{},'Hiçbir ajan başlatılmadı, hiçbir dosya yazılmadı.'+(refuse?' Neden: '+refuse.refusal.replace(/[.\s]+$/,'')+'.':'')+(v.meta.requires?' Gerçek çalıştırma için CLI’da gerekenler: '+v.meta.requires+'.':'')))));
 R.out.append(h('div',{class:'res'},...v.steps.map((s,i)=>stepCard(s,i))));
 const g=['policy','model routing','data flow','guarantees','managed policy'].filter((k)=>v.meta[k]);
 if(g.length)R.out.append(h('details',{},h('summary',{},IC('chev'),'Garantiler ve sınırlar (CLI)'),h('div',{class:'ev'},g.map((k)=>h('p',{},k+': '+v.meta[k])))));
 R.out.append(h('details',{},h('summary',{},IC('chev'),'Ham CLI çıktısı'),h('pre',{},(res.output||'')+(res.errors?'\n--- stderr ---\n'+res.errors:''))))}
function stepCard(s,i){
 const d=STEPS[s.id]||{tr:s.id,icon:'flow'};const ev=s.evidence||[];
 const card=h('article',{class:'card',style:null},
  h('h2',{},IC(d.icon),d.tr,h('span',{class:'chip '+(s.verdict==='would-run'?'ok':'bad'),style:null},s.verdict==='would-run'?'çalışırdı':s.verdict==='would-refuse'?'reddedilirdi':'?'),h('span',{class:'chip def'},PN[s.provider]||s.provider)),
  h('p',{class:'hint'},s.mode),
  s.refusal?h('p',{class:'why',style:null},'⚠ '+s.refusal):null,
  row('Model',settingChip(s.model),s.model&&s.model.reason),
  row('Efor',settingChip(s.effort),s.effort&&s.effort.reason),
  row('Doğrulama',verifyChip(s.verification)),
  row('Dayanak',h('span',{},BASIS(s.basis))),
  s.uncertainty?row('Belirsizlik',h('span',{class:'unc '+s.uncertainty,style:null},h('i'),h('i'),h('i'),' ',UNC[s.uncertainty])):null,
  (s.notes||[]).map((n)=>h('p',{class:'why'},'• '+n)));
 card.style.animationDelay=(i*60)+'ms';
 if(ev.length){const body=[];for(const[k,t]of EVK){const items=ev.filter((e)=>e.kind===k);if(!items.length)continue;body.push(h('h4',{},t));items.forEach((e)=>body.push(h('p',{class:k},e.text)))}
  card.append(h('details',{},h('summary',{},IC('chev'),'Kanıtlar ('+ev.length+')'),h('div',{class:'ev'},body)))}
 return card}
function row(k,v,why){return h('div',{class:'row'},h('span',{class:'k'},k),h('div',{class:'v'},v,why?h('p',{class:'why'},'CLI gerekçesi: '+why):null))}
async function preview(){
 if(S.busy)return;const task=R.task.value;
 if(task.trim()===''){toast('Önce bir görev metni girin.');R.task.focus();return}
 const models={},efforts={};for(const id of FLOWS[S.workflow]){const st=S.steps[id];if(st.model)models[id]=st.model;if(st.effort)efforts[id]=st.effort}
 S.busy=true;R.go.disabled=true;R.go.lastChild.textContent='Önizleniyor…';
 try{S.result=await api('/api/dry-run',{method:'POST',body:JSON.stringify({workflow:S.workflow,task,routing:S.routing,policy:S.policy,acceptUnverified:S.accept,steps:{models,efforts},workspace:R.ws.value.trim(),verify:R.verify.value.trim()})});
  drawFlow();drawResult();R.out.scrollIntoView({behavior:'smooth',block:'nearest'})}
 catch(e){toast(String(e.message||e))}
 finally{S.busy=false;R.go.disabled=false;R.go.lastChild.textContent='Önizle (dry run)'}}

/* ---------- providers & safety ---------- */
function quotaBlock(p){const q=((S.status&&S.status.quota)||[]).find((x)=>x.provider===p);
 if(!q||!q.windows.length)return h('p',{class:'why'},'Kota verisi yok: bu sağlayıcı için güvenilir bir okuma bulunamadı. Tahmin gösterilmez.');
 return h('div',{},q.plan?h('p',{class:'why'},'Plan: '+q.plan):null,q.windows.map((w)=>{const bar=h('div',{});bar.style.width=Math.min(100,w.usedPercent)+'%';if(w.usedPercent>=80)bar.className='hot';
  return h('div',{class:'qrow'},h('div',{class:'qh'},h('span',{},winName(w.label)),h('span',{},'%'+Math.round(w.usedPercent)+' kullanıldı')),h('div',{class:'bar'},bar),w.resets?h('p',{class:'why'},'Sıfırlanma: '+rel(w.resets)):null)}))}
function drawProviders(){
 const v=h('div',{class:'view stack'});
 if(S.loading){v.append(h('div',{class:'card'},h('div',{class:'skel'}),h('p'),h('div',{class:'skel'})));main.replaceChildren(v);return}
 const ps=(S.status&&S.status.providers)||[];
 if(!ps.length)v.append(h('div',{class:'empty'},'Sağlayıcı bilgisi okunamadı. Yenile düğmesini deneyin.'));
 v.append(h('div',{class:'pc'},ps.map((p)=>{const ok=/logged in/.test(p.login||'');const g=((S.status&&S.status.models)||[]).find((x)=>x.provider===p.id);
  return h('section',{class:'card'},h('div',{class:'head'},h('div',{class:'ico'},IC('cpu')),h('div',{},h('h2',{},p.name),h('span',{class:'why'},p.install||''))),
   h('div',{class:'row'},h('span',{class:'k'},'Oturum'),h('div',{class:'v'},h('span',{class:'chip '+(ok?'ok':'warn')},p.login||'bilinmiyor'))),
   h('div',{class:'row'},h('span',{class:'k'},'Model listesi'),h('div',{class:'v'},h('span',{class:'why'},g?g.source+' · '+g.models.length+' model':'yok'))),
   h('h2',{style:null},IC('gauge'),'Kota'),quotaBlock(p.id))})));
 for(const g of(S.status&&S.status.models)||[])v.append(h('section',{class:'card'},h('h2',{},IC('layers'),PN[g.provider]+' modelleri'),h('p',{class:'hint'},g.source+(g.provider==='claude'?' — efor düzeyleri satıcı belgelerine göre, hesap için doğrulanmadı.':'')),
  h('div',{style:null,class:'tw'},h('table',{},h('thead',{},h('tr',{},h('th',{},'Model'),h('th',{},'Kimlik'),h('th',{},'Efor'),h('th',{},'Varsayılan'))),h('tbody',{},g.models.map((m)=>h('tr',{},h('td',{},m.label),h('td',{class:'m'},m.id),h('td',{},m.efforts.join(', ')),h('td',{},m.defaultEffort||'—'))))))));
 main.replaceChildren(v)}
function drawSafety(){
 const li=(t)=>h('li',{},t);
 main.replaceChildren(h('div',{class:'view stack'},h('section',{class:'card'},h('h2',{},IC('lock'),'Bu arayüz neyi yapar, neyi yapmaz'),
  h('ul',{class:'list'},[
  'Yalnızca bu bilgisayarın döngü arayüzünde (127.0.0.1) dinler; her istek bu başlatmaya özel rastgele bir anahtar ve doğru Host/Origin ister.',
  'Önizleme gerçek CLI’nın “orchestrate --dry-run” komutuyla üretilir. Hiçbir ajan başlatılmaz, model çağrısı yapılmaz, dosya yazılmaz.',
  'Görev metni, sonuçlar ve ayarlar kaydedilmez; tarayıcı depolaması kullanılmaz. Sayfayı yenilemek her şeyi sıfırlar.',
  'Sır, API anahtarı ya da oturum bilgisi gösterilmez veya saklanmaz. Kota yalnızca yerel okumadan gelir; yoksa “veri yok” yazılır.',
  'Sayfa dış kaynak yüklemez (yazı tipi, betik, görsel yok) ve sıkı bir içerik güvenlik ilkesiyle sunulur.',
  'Claude modelleri erişim doğrulanamadığı için hiçbir zaman otomatik sabitlenmez; ultracode seçilmez.',
  'Gerçek çalıştırma bu sürümde yoktur; CLI’daki “orchestrate --confirm” ile yapılır.'].map(li))),
  h('section',{class:'card'},h('h2',{},IC('book'),'Kanıt türleri'),h('ul',{class:'list'},[
  'Kıyaslama kanıtı: aynı kıyaslama, sürüm ve eforla karşılaştırılabilir yayımlanmış sonuçlar (katı kurallar).',
  'Dokümantasyon: sağlayıcının belgelediği model amacı. Bir ölçüm değildir; belirsizliği her zaman gösterilir.',
  'Erişim: hesabın hangi modelleri kullanabildiğine dair bilgi. Claude için bilinmiyor.'].map(li)))))}

function draw(){
 nav.querySelectorAll('.navbtn').forEach((b)=>{if(b.dataset.view===S.view)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current')});
 drawTop();
 if(S.view==='run'){main.replaceChildren(R.view);drawControls();drawFlow();drawResult()}
 else if(S.view==='providers')drawProviders();else drawSafety()}
async function loadStatus(){S.loading=true;refreshBtn.classList.add('spin');draw();
 try{S.status=await api('/api/status')}catch(e){toast('Durum okunamadı: '+String(e.message||e))}
 S.loading=false;refreshBtn.classList.remove('spin');draw()}
buildRun();draw();loadStatus();
})();
`;
