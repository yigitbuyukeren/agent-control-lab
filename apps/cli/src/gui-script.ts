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
 plan:{tr:'Plan',icon:'layers',d:'Görevi adımlara böler. Her iki sağlayıcı da izin profiline göre çalışır.',provider:()=> 'claude'},
 implement:{tr:'Uygulama',icon:'term',d:'Seçili sağlayıcı (Claude veya Codex) yalnızca izole çalışma ağacına yazar.',provider:()=> 'codex'},
 inspect:{tr:'Denetim',icon:'shield',d:'',provider:()=> 'local'},
 verify:{tr:'Test komutu',icon:'term',d:'',provider:()=> 'local'},
 review:{tr:'İnceleme',icon:'shield',d:'Çıktıyı bağımsız olarak gözden geçirir.',provider:(w)=>w==='plan-review'?'codex':'claude'}};
const PN={claude:'Claude',codex:'Codex',local:'Yerel'};
const PROFILES={plan:['read-only','text-only'],implement:['workspace-write'],review:['read-only','text-only']};
const PFN={'read-only':'Salt okunur','text-only':'Araçsız (yalnız Claude)','workspace-write':'İzole ağaca yazma'};
const provOf=(id)=>{const st=S.steps[id];return st.provider?st.provider:STEPS[id].provider(S.workflow)};
const S={claude:null,claudeMsg:'',cwd:'',timeout:300,previewKey:null,run:null,runLines:[],runCursor:0,timer:null,tick:null,view:'run',workflow:'plan-review',routing:'guided',policy:'balanced',accept:false,steps:{plan:{},implement:{},review:{}},status:null,result:null,busy:false,loading:true};
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
const NAV=[['run','flow','Orkestrasyon'],['providers','cpu','Sağlayıcılar'],['prep','shield','Hazırlık'],['safety','lock','Güvenlik']];
const TITLES={run:'Orkestrasyon',prep:'Hazırlık ve görev geçmişi',providers:'Sağlayıcılar ve kota',safety:'Güvenlik ve sınırlar'};
const app=$('#app');
const nav=h('nav',{class:'nav','aria-label':'Ana gezinme'},h('div',{class:'brand'},h('div',{class:'logo'},IC('spark')),'Agent Control Lab'),
 NAV.map(([id,ic,t])=>h('button',{class:'navbtn','data-view':id,onclick:()=>go(id)},IC(ic),t)),
 h('div',{class:'navfoot'},IC('lock'),'v1.0 · yerel'));
const topTitle=h('h1',{});const topPills=h('div',{style:null,class:'toppills'});
const refreshBtn=h('button',{class:'iconbtn',title:'Durumu yenile','aria-label':'Durumu yenile',onclick:()=>loadStatus()},IC('refresh'));
const topbar=h('header',{class:'top'},topTitle,h('span',{class:'pill safe'},IC('shield'),'Yerel · onaylı çalıştırma'),topPills,refreshBtn);
const main=h('main',{});
app.append(nav,topbar,main);
function go(v){S.view=v;draw()}

/* ---------- top status ---------- */
function drawTop(){topTitle.textContent=TITLES[S.view];topPills.replaceChildren();topPills.className='toppills';topPills.style.display='contents';
 topPills.append(h('span',{class:'pill hideS'},h('span',{class:'dot ok'}),location.host));
 if(runActive())topPills.append(h('span',{class:'pill'},h('span',{class:'dot warn'}),'Koşu sürüyor'));
 if(S.loading){topPills.append(h('span',{class:'pill'},h('span',{class:'skel',style:null}),'durum okunuyor…'));return}
 for(const p of(S.status&&S.status.providers)||[]){const ok=/logged in/.test(p.login||'');topPills.append(h('span',{class:'pill'},h('span',{class:'dot '+(ok?'ok':p.login?'warn':'bad')}),PN[p.id]))}
 if(S.claude&&S.claude.fiveHour&&S.claude.fiveHour.usedPercent!=null)topPills.append(h('span',{class:'pill hideS'},'Claude 5s: %'+Math.round(S.claude.fiveHour.usedPercent)));
 for(const q of(S.status&&S.status.quota)||[]){const w=q.windows[0];if(w)topPills.append(h('span',{class:'pill hideS'},PN[q.provider]+' '+winName(w.label).split(' ')[0]+': %'+Math.round(w.usedPercent)))}}

/* ---------- run view ---------- */
const R={};
function buildRun(){
 R.task=h('textarea',{id:'task',maxlength:'20000',placeholder:'Örn. “Kullanıcı oturum süresini yapılandırılabilir yap ve testlerini ekle”',oninput:()=>{R.count.textContent=R.task.value.length.toLocaleString('tr-TR')+' / 20.000';drawRunBtn()},onkeydown:(e)=>{if((e.metaKey||e.ctrlKey)&&e.key==='Enter')preview()}});
 R.count=h('span',{},'0 / 20.000');
 R.flow=h('div',{class:'flow'});
 R.wf=h('div',{class:'seg',role:'group','aria-label':'İş akışı'});
 R.routes=h('div',{class:'routes'});
 R.pol=h('div',{class:'seg',role:'group','aria-label':'Politika'});R.polHint=h('p',{class:'hint'});
 R.ws=h('input',{type:'text',id:'ws',autocomplete:'off',placeholder:'/yol/izole-calisma-agaci',oninput:()=>{drawRunBtn()}});
 R.wsPicker=h('div',{class:'picker',hidden:true});
 R.verify=h('input',{type:'text',id:'vc',autocomplete:'off',placeholder:'pnpm test',oninput:()=>{drawRunBtn()}});
 R.wsBox=h('div',{class:'card lockable'},h('h2',{},IC('doc'),'Çalışma ağacı'),h('p',{class:'hint'},'Var olan, bağlı bir Git çalışma ağacı (ana ağaç olmaz, temiz olmalı). Seçtiğiniz uygulama sağlayıcısı (Claude veya Codex) yalnızca burada yazar; önizlemede hiçbir şey yazılmaz.'),
  h('label',{class:'l',for:'ws'},'Yol'),h('div',{class:'pathrow'},R.ws,h('button',{type:'button',class:'chipbtn',onclick:()=>{browse(R.ws.value.trim(),R.ws)}},'Gözat')),R.wsPicker,h('div',{class:'sp'}),h('label',{class:'l',for:'vc'},'Test komutu (isteğe bağlı)'),R.verify,
  R.wtBox,h('p',{class:'hint'},'Yeni yazılan kodu çalıştırır; yalnızca ayrı bir onayla ve kanıtlanmış bir işletim sistemi sandbox’ı içinde çalışır. Önizlemede çalıştırılmaz ve sandbox durumu önizlemede gösterilir.'));
 R.wtRepo=h('input',{type:'text',id:'wtrepo',autocomplete:'off',placeholder:'/yol/ana-depo'});R.wtOut=h('div',{class:'stack'});
 R.wtBox=h('div',{},h('div',{class:'sp'}),h('h4',{},'Yeni çalışma ağacı (isteğe bağlı)'),h('p',{class:'hint'},'Ana depoya dokunmadan, ayrı bir acl/ dalında, depo dışında bağlı bir çalışma ağacı oluşturur. Önce plan gösterilir; oluşturma ayrıca onay ister. Otomatik silme yoktur.'),
  h('label',{class:'l',for:'wtrepo'},'Depo yolu'),R.wtRepo,h('button',{type:'button',class:'chipbtn',onclick:()=>{worktree(false)}},'Planı göster'),R.wtOut);
 R.inBox=h('div',{});
 R.wi=h('input',{type:'checkbox',id:'wi',onchange:()=>{S.result=null;drawRunBtn()}});
 R.acc=h('input',{type:'checkbox',id:'acc',onchange:()=>{S.accept=R.acc.checked;drawRunBtn()}});
 R.go=h('button',{class:'go',type:'button',onclick:preview},IC('play'),h('span',{},'Önizle (dry run)'));
 R.out=h('div',{class:'stack'});R.runOut=h('div',{class:'stack'});
 R.cwd=h('input',{type:'text',id:'cwd',autocomplete:'off',placeholder:'/yol/proje-dizini',oninput:()=>{drawRunBtn()}});
 R.picker=h('div',{class:'picker',hidden:true});
 R.tsel=h('select',{id:'tmo','aria-label':'Adım başına zaman aşımı',onchange:()=>{S.timeout=Number(R.tsel.value);drawRunBtn()}},[[120,'2 dakika'],[300,'5 dakika'],[600,'10 dakika'],[900,'15 dakika']].map(([v,t])=>h('option',{value:v},t)));R.tsel.value=String(S.timeout);
 R.cwdBox=h('section',{class:'card lockable'},h('h2',{},IC('doc'),'Proje dizini'),h('p',{class:'hint'},'Claude ve Codex bu dizinde çalışır (araçsız plan, salt okunur inceleme). Gerçek çalıştırma için seçilmesi zorunludur.'),
  h('label',{class:'l',for:'cwd'},'Yol'),h('div',{class:'pathrow'},R.cwd,h('button',{type:'button',class:'chipbtn',onclick:()=>{browse(R.cwd.value.trim(),R.cwd)}},'Gözat')),R.picker,R.inBox,h('button',{type:'button',class:'chipbtn',onclick:showInstructions},'Talimat dosyalarını göster'));
 R.dRoot=h('input',{type:'text',id:'droot',autocomplete:'off',placeholder:'/yol/kök-dizin'});R.dPicker=h('div',{class:'picker',hidden:true});R.dOut=h('div',{class:'stack'});
 R.dBox=h('section',{class:'card lockable'},h('h2',{},IC('doc'),'Proje keşfi'),h('p',{class:'hint'},'Seçtiğiniz kök altında repo, monorepo paketi ve Git dışı projeleri salt okunur listeler. Symlink’ler izlenmez, gizli dosyalar okunmaz. Görev metni yalnızca öneri üretir; seçimi siz yaparsınız.'),
  h('label',{class:'l',for:'droot'},'Kök dizin'),h('div',{class:'pathrow'},R.dRoot,h('button',{type:'button',class:'chipbtn',onclick:()=>{browse(R.dRoot.value.trim(),R.dRoot)}},'Gözat')),R.dPicker,h('div',{class:'sp'}),
  h('button',{type:'button',class:'chipbtn',onclick:discover},'Keşfet'),R.dOut);
 R.tmoBox=h('section',{class:'card lockable'},h('label',{class:'l',for:'tmo'},'Adım başına zaman aşımı'),R.tsel);
 R.runBtn=h('button',{class:'go run',type:'button',onclick:confirmRun},IC('play'),h('span',{}));
 R.runNote=h('p',{class:'note'});
 R.view=h('div',{class:'view'},h('div',{class:'grid'},
  h('div',{class:'stack'},
   h('section',{class:'card lockable'},h('h2',{},IC('doc'),'Görev'),h('p',{class:'hint'},'Metin yalnızca bellekte tutulur; hiçbir yere kaydedilmez.'),R.task,h('div',{class:'meta'},R.count,h('span',{},'⌘/Ctrl + Enter ile önizle'))),
   h('section',{class:'card lockable fc'},h('h2',{},IC('flow'),'Akış'),h('p',{class:'hint'},'Her adım için model ve eforu elle seçebilirsiniz; elle seçim her zaman yönlendirmeden önce gelir.'),R.wf,h('div',{style:null,class:'sp'}),R.flow),
   R.runOut,R.out),
  h('aside',{class:'stack'},
   h('section',{class:'card lockable'},h('h2',{},IC('spark'),'Model yönlendirme'),h('p',{class:'hint'},'Claude modelleri erişim doğrulanamadığı için hiçbir zaman otomatik sabitlenmez.'),R.routes),
   h('section',{class:'card lockable'},h('h2',{},IC('gauge'),'Politika'),R.polHint,R.pol),
   R.dBox,R.wsBox,R.cwdBox,R.tmoBox,
   h('section',{class:'card lockable'},h('label',{class:'switch',for:'wi'},R.wi,h('span',{},'Proje talimatlarını (CLAUDE.md / AGENTS.md) sınırlı ve güvenilmeyen veri olarak modele aktar. Kişisel dosyalar ve sır benzeri satırlar aktarılmaz; sağlayıcının zaten okuduğu dosya tekrarlanmaz.'))),
   h('section',{class:'card lockable'},h('label',{class:'switch',for:'acc'},R.acc,h('span',{},'Doğrulanamayan ayarları kabul et ',h('code',{},'--accept-unverified'),'. Önizlemeye, gerçek çalıştırmayı ayrıca onaylarsanız ona da aktarılır. Proxy veya ön kontrol reddi kendiliğinden atlanmaz; bu bayrak yalnızca sizin açık tercihinizdir.'))),
   R.go,R.runBtn,R.runNote)));
 main.append(R.view)}
function drawControls(){
 R.wf.replaceChildren(...Object.keys(FLOWS).map((id)=>h('button',{type:'button','aria-pressed':String(S.workflow===id),onclick:()=>{S.workflow=id;S.result=null;drawControls();drawFlow();drawResult()}},id==='plan-review'?'Plan → İnceleme':'Plan → Uygula → İncele')));
 R.routes.replaceChildren(...ROUTES.map((r)=>h('button',{type:'button',class:'route','aria-pressed':String(S.routing===r.id),onclick:()=>{S.routing=r.id;S.result=null;drawControls();drawResult()}},h('i',{class:'rd'}),h('b',{},r.name,r.badge?h('span',{class:'badge'},r.badge):null),h('span',{},r.d))));
 R.pol.replaceChildren(...POLICIES.map((p)=>h('button',{type:'button','aria-pressed':String(S.policy===p.id),onclick:()=>{S.policy=p.id;S.result=null;drawControls();drawResult()}},p.name)));
 R.polHint.textContent=POLICY_HINT[S.policy];
 R.wsBox.hidden=S.workflow!=='plan-implement-review';R.cwdBox.hidden=S.workflow!=='plan-review';drawRunBtn()}
function nodeResult(id){return S.result&&S.result.view.steps.find((x)=>x.id===id)}
function drawFlow(){
 const ids=FLOWS[S.workflow];const kids=[];
 ids.forEach((id,i)=>{const d=STEPS[id];const prov=provOf(id);const st=S.steps[id];const res=nodeResult(id);
  const psel=h('select',{'aria-label':d.tr+' sağlayıcısı',onchange:()=>{st.provider=psel.value;st.model='';st.effort='';S.result=null;drawFlow();drawResult()}},h('option',{value:''},'Otomatik ('+PN[d.provider(S.workflow)]+')'),h('option',{value:'claude'},'Claude'),h('option',{value:'codex'},'Codex'));
  psel.value=st.provider||'';
  const pfs=h('select',{'aria-label':d.tr+' izin profili',onchange:()=>{st.profile=pfs.value;S.result=null;drawFlow();drawResult()}},PROFILES[id].filter((p)=>!(p==='text-only'&&prov==='codex')).map((p,k)=>h('option',{value:k===0&&p!=='text-only'?'':p},PFN[p]+(k===0?' (varsayılan)':''))));
  pfs.value=st.profile&&PROFILES[id].includes(st.profile)&&!(st.profile==='text-only'&&prov==='codex')?st.profile:'';
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
    h('div',{},h('label',{class:'l'},'Sağlayıcı'),psel),h('div',{},h('label',{class:'l'},'İzin profili'),pfs),h('div',{},h('label',{class:'l'},'Model'),msel),h('div',{},h('label',{class:'l'},'Efor'),esel),
    manualClaude?h('p',{class:'why'},'Claude erişimi doğrulanamaz: elle seçim “doğrulanmamış” sayılır.'):null,
    res?h('div',{},settingChip(res.model),' ',settingChip(res.effort)):null,h('div',{class:'rstat','data-step':id}))));
  if(i<ids.length-1)kids.push(h('div',{class:'link'+(S.result?' live':''),'aria-hidden':'true'}))});
 R.flow.replaceChildren(...kids);updateNodes()}
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
 drawRunBtn();
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
function bodyNow(){const models={},efforts={},providers={},profiles={};for(const id of FLOWS[S.workflow]){const st=S.steps[id];if(st.provider)providers[id]=st.provider;if(st.profile&&!(st.profile==='text-only'&&provOf(id)==='codex'))profiles[id]=st.profile;if(st.model)models[id]=st.model;if(st.effort)efforts[id]=st.effort}
 const b={withInstructions:R.wi.checked,workflow:S.workflow,task:R.task.value,routing:S.routing,policy:S.policy,acceptUnverified:S.accept,steps:{providers,models,efforts,profiles},workspace:R.ws.value.trim(),verify:R.verify.value.trim(),timeoutSec:S.timeout};
 if(S.workflow==='plan-review')b.cwd=R.cwd.value.trim();return b}
const paramsKey=()=>JSON.stringify(bodyNow());
const runActive=()=>!!S.run&&(S.run.status==='running'||S.run.status==='cancelling');
async function preview(){
 if(S.busy||runActive())return;
 if(R.task.value.trim()===''){toast('Önce bir görev metni girin.');R.task.focus();return}
 const key=paramsKey();
 S.busy=true;R.go.disabled=true;R.go.lastChild.textContent='Önizleniyor…';
 try{S.result=await api('/api/dry-run',{method:'POST',body:key});
  S.previewKey=(S.result.exitCode===0&&S.result.view.verdict==='would-run'&&S.result.runnable===true)?key:null;
  drawFlow();drawResult();R.out.scrollIntoView({behavior:'smooth',block:'nearest'})}
 catch(e){toast(String(e.message||e))}
 finally{S.busy=false;R.go.disabled=runActive();R.go.lastChild.textContent='Önizle (dry run)'}}

/* ---------- real plan-review run ---------- */
const SST={pending:'bekliyor',running:'çalışıyor',completed:'tamamlandı',failed:'başarısız',timeout:'zaman aşımı',cancelled:'iptal edildi',skipped:'atlandı'};
const RST={running:'Çalışıyor',cancelling:'İptal ediliyor…',completed:'Tamamlandı',failed:'Başarısız',refused:'CLI ön kontrolü reddetti',cancelled:'İptal edildi',timeout:'Zaman aşımına uğradı'};
const chipCls=(st)=>st==='completed'?'ok':(st==='failed'||st==='timeout'||st==='refused')?'bad':(st==='running'||st==='cancelling'||st==='cancelled'||st==='skipped')?'warn':'def';
function drawRunBtn(){const pw=S.workflow==='plan-implement-review',act=runActive();R.runBtn.hidden=false;
 R.runBtn.lastChild.textContent=pw?'Gerçek çalıştır (plan-implement-review, dosya yazar)':'Gerçek çalıştır (plan-review)';
 const dir=(pw?R.ws.value:R.cwd.value).trim()!=='';
 const ready=!!S.result&&S.result.exitCode===0&&S.result.view.verdict==='would-run'&&S.previewKey===paramsKey()&&dir&&!act;
 R.runBtn.disabled=!ready;
 R.runNote.textContent=act?'Bir koşu sürüyor; aynı anda yalnızca bir koşu çalışır.':ready?(pw?'Önizleme geçti. Gerçek çalıştırma ayrıca açık yazma onayı ister'+(R.verify.value.trim()?' (test komutu için ayrı onayla)':'')+'.':'Önizleme geçti. Gerçek çalıştırma ayrıca açık onay ister.'):!dir?(pw?'Önce çalışma ağacını seçin.':'Önce proje dizinini seçin.'):(S.result&&S.result.exitCode===0&&S.result.view.verdict==='would-run'&&S.result.runnable===false)?'Önizleme geçti ama çalışma ağacının durumu okunamadı; gerçek çalıştırma kapalı.':'Gerçek çalıştırma için aynı ayarlarla geçen bir önizleme gerekir.'}
function setLocked(on){R.view.querySelectorAll('.lockable').forEach((e)=>{e.inert=on;e.style.opacity=on?'.65':''});R.go.disabled=on||S.busy}
function updateNodes(){document.querySelectorAll('.node').forEach((n)=>{const el=n.querySelector('.rstat');if(!el)return;const id=el.dataset.step;const st=S.run&&S.run.steps.find((x)=>x.id===id);
 n.classList.toggle('running',!!st&&st.status==='running');el.replaceChildren();if(!st)return;
 el.append(h('span',{class:'chip '+chipCls(st.status)},'Koşu: '+SST[st.status]+(st.seconds!=null?' · '+st.seconds.toFixed(1)+' sn':'')))})}
function elapsed(){if(!S.run)return'';const end=S.run.endedAt||Date.now();const s=Math.max(0,Math.round((end-S.run.startedAt)/1000));return Math.floor(s/60)+':'+String(s%60).padStart(2,'0')}
function drawRun(){const r=S.run;R.runOut.replaceChildren();setLocked(runActive());drawTop();updateNodes();drawRunBtn();if(!r)return;
 const act=runActive();
 const head=h('div',{class:'runhead'},h('h2',{},IC('play'),'Gerçek koşu',h('span',{class:'chip '+chipCls(r.status)},RST[r.status]||r.status)),h('span',{class:'chip def',id:'elapsed'},elapsed()),
  act?h('button',{type:'button',class:'chipbtn danger',disabled:r.status==='cancelling',onclick:cancelRun},r.status==='cancelling'?'İptal ediliyor…':'İptal / durdur'):null);
 const steps=h('div',{class:'steps'},r.steps.map((st)=>h('div',{class:'srow'},h('span',{class:'dot '+(st.status==='completed'?'ok':st.status==='running'?'warn':(st.status==='failed'||st.status==='timeout')?'bad':'')}),h('b',{},(STEPS[st.id]||{tr:st.id}).tr),h('span',{class:'chip def'},PN[st.provider]||st.provider),
  h('span',{class:'chip '+chipCls(st.status)},SST[st.status]||st.status),st.seconds!=null?h('span',{class:'why'},st.seconds.toFixed(1)+' sn'):null,st.error?h('span',{class:'why'},st.error):null)));
 const card=h('section',{class:'card'},head,steps);
 const wr=r.workspace;const pw=r.steps.some((x)=>x.id==='implement');
 const msg=r.status==='completed'?['ok','Koşu tamamlandı',pw?'Özet aşağıda Git’ten okunan gerçek çalışma ağacı durumundan üretildi.':PN[provOf('plan')]+' planladı, '+PN[provOf('review')]+' inceledi. Dosya yazılmadı, commit/push yapılmadı.']:
  r.status==='refused'?['bad','CLI ön kontrolü reddetti — hiçbir adım başlamadı','Güvenlik kontrolleri otomatik atlanmaz. Nedenleri aşağıda; giderip yeniden önizleyin.']:
  r.status==='cancelled'?['bad','Koşu iptal edildi',pw?'Süreçler durduruldu. Yazılanlar geri alınmadı; gerçek durum aşağıda.':'Başlatılan süreçler durduruldu; kısmi çıktı varsa aşağıdadır.']:
  r.status==='timeout'?['bad','Zaman aşımı','Koşu süre sınırını aştı ve durduruldu.']:r.status==='failed'?['bad','Koşu başarısız','Ayrıntı canlı kayıtta.']:null;
 if(msg)card.append(h('div',{class:'banner '+msg[0],style:null},IC(msg[0]==='ok'?'check':'alert'),h('div',{},h('b',{},msg[1]),h('small',{},msg[2]))));
 if(pw&&wr)card.append(workspaceCard(wr,r.status));
 if(r.refusal&&r.refusal.length)card.append(h('pre',{class:'refusal'},r.refusal.join('\n')));
 R.logPre=h('pre',{id:'log'},S.runLines.join('\n'));
 card.append(h('details',{open:true},h('summary',{},IC('chev'),'Canlı kayıt ('+S.runLines.length+' satır, maskelenmiş)'),R.logPre));
 R.runOut.append(card);
 R.logPre.scrollTop=R.logPre.scrollHeight;
 if(r.sections&&r.sections.length){R.runOut.append(h('p',{class:'note'},'Aşağıdaki metin model çıktısıdır: güvenilmeyen veri, talimat değil. Yalnızca metin olarak gösterilir.'));
  for(const sec of r.sections)R.runOut.append(h('section',{class:'card'},h('h2',{},IC((STEPS[sec.id]||{icon:'doc'}).icon),((STEPS[sec.id]||{tr:sec.id}).tr)+' çıktısı',h('span',{class:'chip def'},PN[sec.provider]||sec.provider),h('span',{class:'chip '+chipCls(sec.status)},SST[sec.status]||sec.status)),
   sec.usedModel?h('p',{class:'why'},'Yanıtın bildirdiği model: '+sec.usedModel):null,h('pre',{class:'modelout'},sec.text||'(boş)')));
  if(r.summary)R.runOut.append(h('p',{class:'note'},'Özet: '+r.summary))}}
function workspaceCard(w,status){
 if(!w.readable)return h('div',{class:'banner bad',style:null},IC('alert'),h('div',{},h('b',{},'Çalışma ağacı durumu okunamadı'),h('small',{},'Değişiklikleri elle kontrol edin: git status && git diff')));
 const files=w.files||[];
 return h('div',{class:'wsum'},h('h3',{},'Çalışma ağacının gerçek durumu'),
  h('div',{class:'facts'},h('div',{},h('span',{class:'k'},'Dizin'),h('code',{},w.root||'')),h('div',{},h('span',{class:'k'},'Dal'),h('code',{},w.branch||'ayrık HEAD')),
   h('div',{},h('span',{class:'k'},'HEAD'),h('code',{},(w.headBefore?w.headBefore.slice(0,8)+' → ':'')+(w.headAfter||'').slice(0,8))),
   h('div',{},h('span',{class:'k'},'Değişiklik'),h('code',{},files.length+(w.truncated?'+':'')+' dosya, +'+w.added+' −'+w.deleted+' satır'))),
  w.committed?h('div',{class:'banner bad',style:null},IC('alert'),h('div',{},h('b',{},'HEAD veya bir dal değişmiş'),h('small',{},'Bu araç commit yapmaz; Git geçmişini elle inceleyin.'))):h('p',{class:'why'},'Commit/push yapılmadı: HEAD ve dallar koşu öncesiyle aynı.'),
  files.length?h('ul',{class:'list'},files.map((f)=>h('li',{},h('code',{},f.path),' ',h('span',{class:'chip def'},f.kind==='new'?'yeni ('+f.bytes+' bayt)':f.added==null?'ikili':'+'+f.added+' −'+(f.deleted||0))))):h('p',{class:'why'},'Çalışma ağacında değişiklik yok.'),
  h('p',{class:'why'},'Değişiklikler birleştirilmedi ve geri alınmadı. İnceleyin: git -C "'+(w.root||'')+'" status && git diff'))}
function startTick(){clearInterval(S.tick);S.tick=setInterval(()=>{const e=document.getElementById('elapsed');if(e)e.textContent=elapsed();if(!runActive())clearInterval(S.tick)},1000)}
async function poll(){clearTimeout(S.timer);
 try{const r=await api('/api/run?from='+S.runCursor);if(r.status==='idle')S.run=null;else{S.runCursor=r.next;if(r.skipped)S.runLines.push('… '+r.skipped+' satır kayıt sınırı nedeniyle atlandı');S.runLines.push(...r.lines);if(S.runLines.length>400)S.runLines.splice(0,S.runLines.length-400);S.run=r}}catch(e){toast(String(e.message||e))}
 drawRun();
 if(runActive())S.timer=setTimeout(poll,700);else{clearInterval(S.tick);loadStatus()}}
async function startRun(acceptConfirmed,writeConfirmed,verifyConfirmed,unsandboxed){const b=bodyNow();b.confirm=true;if(S.accept)b.confirmAcceptUnverified=acceptConfirmed===true;if(S.workflow==='plan-implement-review'){b.confirmWrite=writeConfirmed===true;if(b.verify){b.confirmVerify=verifyConfirmed===true;if(unsandboxed===true)b.confirmUnsandboxed=true}}
 S.previewKey=null;
 try{S.run=await api('/api/run',{method:'POST',body:JSON.stringify(b)});S.runLines=[];S.runCursor=S.run.next||0;S.runLines.push(...(S.run.lines||[]));drawRun();startTick();S.timer=setTimeout(poll,500);R.runOut.scrollIntoView({behavior:'smooth',block:'nearest'})}
 catch(e){toast(String(e.message||e))}}
async function cancelRun(){try{await api('/api/run/cancel',{method:'POST',body:'{}'});toast('İptal isteği gönderildi.')}catch(e){toast(String(e.message||e))}}
function confirmRun(){if(!S.result)return;const v=S.result.view;const dlg=h('dialog',{class:'dlg','aria-labelledby':'dlgt'});
 const pw=S.workflow==='plan-implement-review',vcmd=pw?R.verify.value.trim():'';
 const stp=(id)=>{const s=v.steps.find((x)=>x.id===id);return s?(s.model?s.model.value:'?')+' · efor: '+(s.effort?s.effort.value:'?'):'?'};
 const q=((S.status&&S.status.quota)||[]).map((x)=>PN[x.provider]+': '+x.windows.map((w)=>winName(w.label)+' %'+Math.round(w.usedPercent)).join(', ')).join(' | ')||'okunamadı (tahmin gösterilmez)';
 const c1=h('input',{type:'checkbox',id:'c1'}),c2=S.accept?h('input',{type:'checkbox',id:'c2'}):null,c3=vcmd?h('input',{type:'checkbox',id:'c3'}):null,c4=vcmd?h('input',{type:'checkbox',id:'c4'}):null;
 const go=h('button',{class:'go',type:'button',disabled:true,onclick:()=>{dlg.close();startRun(!!c2&&c2.checked,c1.checked,!!c3&&c3.checked,!!c4&&c4.checked)}},IC('play'),h('span',{},'Gerçek çalıştırmayı başlat'));
 const upd=()=>{go.disabled=!(c1.checked&&(!c2||c2.checked)&&(!c3||c3.checked))};for(const c of [c1,c2,c3])if(c)c.addEventListener('change',upd);
 const pv=(id)=>{const s=v.steps.find((x)=>x.id===id);return s?PN[s.provider]||s.provider:'?'};
 const facts=pw?[['Çalışma ağacı',R.ws.value.trim()],['Plan ('+pv('plan')+')',stp('plan')],['Uygulama ('+pv('implement')+', YAZAR)',stp('implement')],['İnceleme ('+pv('review')+')',stp('review')],['Test komutu',vcmd||'yok']]
  :[['Proje dizini',R.cwd.value.trim()],['Plan ('+pv('plan')+')',stp('plan')],['İnceleme ('+pv('review')+')',stp('review')]];
 dlg.append(...[h('h2',{id:'dlgt'},IC('alert'),'Gerçek çalıştırmayı onayla'),
  h('div',{class:'facts'},...facts.map((f)=>h('div',{},h('span',{class:'k'},f[0]),h('code',{},f[1]))),
   h('div',{},h('span',{class:'k'},'Zaman aşımı'),h('code',{},(S.timeout/60)+' dk / adım')),h('div',{},h('span',{class:'k'},'Kota'),h('code',{},q)),S.accept?h('div',{},h('span',{class:'k'},'Doğrulanamayan ayarlar'),h('code',{},'KABUL EDİLDİ (--accept-unverified) — gerçek koşuya aktarılır')):null),
  h('p',{class:'why'},pw?'Seçtiğiniz sağlayıcıların gerçek oturumları başlar ve abonelik kotanızı kullanır. '+pv('implement')+' yalnızca seçtiğiniz bağlı çalışma ağacına yazar; ana ağaç, commit, push, dal değişikliği ve korumalı yollar yasaktır ve her adımdan sonra Git ile denetlenir. İptal ederseniz o ana kadar yazılanlar geri alınmaz. API anahtarı, yeniden deneme ve sağlayıcı değiştirme yoktur. Kota %95’e yakınsa koşu başlamaz.':'Seçtiğiniz sağlayıcıların gerçek oturumları başlar ve abonelik kotanızı kullanır. Plan ('+pv('plan')+') ve inceleme ('+pv('review')+') yazma yetkisi olmadan çalışır; dosya yazılmaz, commit/push yapılmaz, API anahtarı kullanılmaz, yeniden deneme ve sağlayıcı değiştirme yoktur. Kota %95’e yakınsa koşu başlamaz.'),
  h('label',{class:'switch',for:'c1'},c1,h('span',{},pw?pv('implement')+'’in bu çalışma ağacına dosya yazmasını açıkça onaylıyorum.':'Bunu anlıyorum ve gerçek çalıştırmayı onaylıyorum.')),
  c3?h('label',{class:'switch',for:'c3'},c3,h('span',{},'“'+vcmd+'” komutunun yeni yazılan kodu çalıştırmasını ayrıca onaylıyorum. Komut, bu bilgisayarda doğrulanabilen bir işletim sistemi sandbox’ı içinde (yalnızca çalışma ağacına yazma, ağ yok, kimlik bilgisi klasörleri okunamaz) çalışır; sandbox kanıtlanamazsa çalıştırılmaz.')):null,
  c4?h('label',{class:'switch',for:'c4'},c4,h('span',{},'İsteğe bağlı: sandbox kullanma. Komut tam kullanıcı haklarınızla, korumasız çalışsın (işaretlemezseniz sandbox kanıtlanamadığında komut çalıştırılmaz).')):null,
  c2?h('label',{class:'switch',for:'c2'},c2,h('span',{},'Doğrulanamayan ayarları (örn. proxy/TLS değişkenlerinin Claude’a iletilmemesi) gerçek çalıştırma için de kendim kabul ediyorum: --accept-unverified bu koşuya aktarılacak ve o ön kontrol uyarıları aşılacak.')):null,
  h('div',{class:'dlgbtn'},h('button',{type:'button',class:'chipbtn',onclick:()=>{dlg.close()}},'Vazgeç'),go)].filter((x)=>x!==null));
 document.body.append(dlg);dlg.addEventListener('close',()=>{dlg.remove()});dlg.showModal()}
async function worktree(confirmed){const repo=R.wtRepo.value.trim();if(repo===''){toast('Önce depo yolunu yazın.');return}
 try{const r=await api('/api/worktree',{method:'POST',body:JSON.stringify({repo,confirm:confirmed===true})});
  const out=[h('pre',{class:'log'},(r.output||'')+(r.errors||''))];
  if(r.created&&r.workspace){R.ws.value=r.workspace;S.result=null;drawRunBtn();out.push(h('p',{class:'why'},'Oluşturuldu ve çalışma ağacı yolu forma yazıldı.'))}
  else if(r.exitCode===0&&!confirmed){const ok=h('input',{type:'checkbox',id:'wtok'});const b=h('button',{type:'button',class:'chipbtn',disabled:true,onclick:()=>{worktree(true)}},'Oluştur');ok.addEventListener('change',()=>{b.disabled=!ok.checked});out.push(h('label',{class:'switch',for:'wtok'},ok,h('span',{},'Bu çalışma ağacının ve dalın oluşturulmasını onaylıyorum.')),b)}
  R.wtOut.replaceChildren(...out)}catch(e){toast(String(e.message||e))}}
const LSTAT={loaded:'okunur',unknown:'okunduğu doğrulanamaz','on-demand':'alt klasörde gerektiğinde',shadowed:'üstü örtülü','not-loaded':'okunmaz',skipped:'atlandı'};
async function showInstructions(){const dir=(S.workflow==='plan-implement-review'?R.ws:R.cwd).value.trim();if(dir===''){toast('Önce bir dizin seçin.');return}
 try{const r=await api('/api/instructions',{method:'POST',body:JSON.stringify({cwd:dir})});const out=[h('p',{class:'why'},'Yalnızca listelenir; dosyalar değiştirilmez. Talimat metni güvenilmeyen veridir ve izinleri veya onayları asla aşmaz. Kişisel (kullanıcı/yerel) dosyalar dışarı aktarılmaz.')];
  for(const g of [r.claude,r.codex]){if(!g)continue;out.push(h('h4',{},PN[g.provider]+': '+(g.entries.length?g.entries.length+' dosya':'talimat dosyası yok')));
   out.push(h('ul',{class:'list'},g.entries.map((e)=>h('li',{},h('code',{},e.path),' ',h('span',{class:'chip def'},(LSTAT[e.status]||e.status)+' · '+e.scope),e.flags.length?h('span',{class:'chip bad'},'şüpheli metin'):null,h('div',{class:'why'},e.reason)))));
   for(const c of g.conflicts)out.push(h('p',{class:'note'},c.detail));for(const w of g.warnings)out.push(h('p',{class:'note'},w))}
  for(const c of r.crossProviderConflicts||[])out.push(h('p',{class:'note'},c.detail));
  R.inBox.replaceChildren(...out)}catch(e){toast(String(e.message||e))}}
const CKIND={ok:'ok',warn:'warn',fail:'bad'};
async function drawPrep(){const v=h('div',{class:'stack'});main.replaceChildren(v);
 v.append(h('section',{class:'card'},h('h2',{},IC('shield'),'Kurulum denetimi'),h('p',{class:'hint'},'Salt okunur: model çağrılmaz, hiçbir şey değiştirilmez.'),h('div',{id:'doc'},h('span',{class:'skel',style:null}))));
 v.append(h('section',{class:'card'},h('h2',{},IC('doc'),'Görev geçmişi'),h('p',{class:'hint'},'Yerelde kalır. İstem, model çıktısı ve plan metni saklanmaz; yalnızca durum, Git bilgisi ve kanıt özeti. Silmek için: agent-control-lab tasks clear'),h('div',{id:'tl'},h('span',{class:'skel',style:null}))));
 try{const d=await api('/api/doctor');const box=document.getElementById('doc');if(box)box.replaceChildren(...d.items.map((c)=>h('div',{class:'srow'},h('span',{class:'dot '+(CKIND[c.status]||'warn')}),h('div',{},h('div',{},c.message),c.fix?h('div',{class:'why'},'→ '+c.fix):null))))}catch(e){toast(String(e.message||e))}
 try{const t=await api('/api/tasks');const box=document.getElementById('tl');if(box){box.replaceChildren(...(t.items.length?t.items.map((x)=>h('div',{class:'srow'},h('span',{class:'dot '+(x.status==='completed'?'ok':x.status==='running'?'warn':'bad')}),h('div',{},h('code',{},x.id||''),' ',x.unreadable?'okunamıyor ('+x.unreadable+')':x.status+(x.ownerGone?' (süreci yok)':'')+' · '+x.label+' · '+x.project+' · '+x.updatedAt))):[h('p',{class:'why'},'Kayıtlı görev yok.')]))}}catch(e){toast(String(e.message||e))}}
const DKIND={'git-repo':'Git deposu','git-worktree':'Git çalışma ağacı','git-submodule':'Git alt modülü',package:'paket','project':'proje'};
function pickWorkspace(c){const t=S.workflow==='plan-implement-review'?R.ws:R.cwd;t.value=c.path;S.result=null;drawRunBtn();toast('Seçildi: '+c.relative)}
function candRow(c,note){return h('div',{class:'row'},h('span',{class:'k'},c.relative),h('div',{class:'v'},h('b',{},c.name),' ',h('span',{class:'badge'},DKIND[c.kind]||c.kind),c.monorepo?h('span',{class:'badge'},'monorepo'):null,c.nestedIn?h('span',{class:'badge'},'iç içe repo'):null,
  note?h('p',{class:'why'},note):null,h('button',{type:'button',class:'chipbtn',onclick:()=>{pickWorkspace(c)}},'Bunu seç')))}
async function discover(){
 const root=R.dRoot.value.trim();if(root===''){toast('Önce bir kök dizin seçin.');return}
 try{const r=await api('/api/workspaces',{method:'POST',body:JSON.stringify({root,task:R.task.value})});const out=[];
  out.push(h('p',{class:'why'},r.candidates.length+' aday'+(r.truncated?' (sınırlar nedeniyle liste kesildi)':'')+(r.enclosingRepo?'; kök bir Git deposunun içinde: '+r.enclosingRepo:'')));
  const sg=r.suggestion;
  if(sg){
   if(sg.state==='suggested')out.push(h('h4',{},'Öneri (uygulanmadı)'),candRow(sg.best.candidate,sg.best.reasons.join('; ')+' (puan '+sg.best.score+')'));
   else if(sg.state==='ambiguous')out.push(h('h4',{},'Belirsiz eşleşme: otomatik seçim yapılmadı'),...sg.matches.map((m)=>candRow(m.candidate,m.reasons.join('; ')+' (puan '+m.score+')')));
   else out.push(h('p',{class:'why'},'Görev metni hiçbir adayla eşleşmedi; elle seçin.'))}
  out.push(h('h4',{},'Tüm adaylar'),...r.candidates.map((c)=>candRow(c,c.markers.join(', '))));
  if(r.skipped.length)out.push(h('p',{class:'why'},'Girilmeyenler: '+r.skipped.slice(0,10).map((s)=>s.relative+' ('+(s.reason==='symlink'?'symlink izlenmez':s.reason)+')').join(', ')));
  R.dOut.replaceChildren(...out)}
 catch(e){toast(String(e.message||e))}}
async function browse(path,target){
 const pick=target===R.ws?R.wsPicker:target===R.dRoot?R.dPicker:R.picker;
 try{const r=await api('/api/dirs?path='+encodeURIComponent(path||''));const sep=r.path.includes('\\')&&!r.path.includes('/')?'\\':'/';
  pick.hidden=false;
  pick.replaceChildren(h('div',{class:'pkh'},h('code',{},r.path)),
   r.parent?h('button',{type:'button',class:'pk',onclick:()=>{browse(r.parent,target)}},'↑ Üst dizin'):null,
   ...r.dirs.map((d)=>h('button',{type:'button',class:'pk',onclick:()=>{browse(r.path.replace(/[\\/]+$/,'')+sep+d,target)}},IC('doc'),d)),
   r.dirs.length===0?h('p',{class:'why',style:null},'Alt dizin yok.'):null,
   h('div',{class:'pkf'},h('button',{type:'button',class:'chipbtn',onclick:()=>{target.value=r.path;pick.hidden=true;drawRunBtn()}},'Bu dizini seç'),h('button',{type:'button',class:'chipbtn',onclick:()=>{pick.hidden=true}},'Kapat')))}
 catch(e){toast(String(e.message||e))}}
window.addEventListener('beforeunload',(e)=>{if(runActive())e.preventDefault()});

/* ---------- providers & safety ---------- */
const REASON={fresh:'Veri güncel.','no-cache-dir':'Önbellek dizini belirlenemedi (HOME/LOCALAPPDATA yok); veri saklanamaz.','settings-invalid':'Claude ayar dosyası JSON olarak okunamadı (yorum ya da sondaki virgül olabilir). Dosyaya dokunulmaz; elle düzeltin.','settings-unreadable':'Claude ayar dosyası okunamadı (izin sorunu ya da dosya çok büyük).','not-installed':'statusLine toplayıcısı kurulu değil. Claude Code kullanım sınırı verisini yalnızca statusLine komutuna verir.','other-statusline':'Başka bir statusLine komutunuz var; toplayıcı henüz bağlı değil. Kurulum onu bozmadan zincirler.','unsupported-statusline':'statusLine ayarı beklenmeyen biçimde (komut türünde değil); otomatik kurulum yapılmaz.','waiting-for-data':'Toplayıcı kurulu ama henüz veri gelmedi. Veri yalnızca açık bir Claude Code oturumu durum çubuğunu çizdiğinde ve Claude Code kullanım sınırı bilgisini gönderdiğinde yazılır. Tahmin yürütülmez.',stale:'Son veri 15 dakikadan eski; güncel sayılmaz. Açık bir Claude Code oturumu durum çubuğunu yeniledikçe güncellenir.','windows-expired':'Kayıtlı pencerelerin sıfırlanma zamanı geçti; güncel kullanım bilinmiyor.','cache-invalid':'Önbellek dosyası bozuk ya da okunamıyor; yeni veri gelince yenilenir.'};
const SETST={missing:'ayar dosyası yok','no-statusline':'statusLine tanımlı değil',collector:'toplayıcı kurulu',chained:'toplayıcı, mevcut komutunuzla zincirli',other:'başka bir statusLine komutu',unsupported:'desteklenmeyen biçim',invalid:'okunamayan JSON',unreadable:'okunamadı'};
const CST={fresh:'güncel',missing:'yok',stale:'eski','expired':'pencereler sıfırlanmış',invalid:'bozuk','no-dir':'dizin yok'};
const INSTERR={invalid:'Ayar dosyası JSON olarak okunamadı; hiçbir şey değiştirilmedi.',unreadable:'Ayar dosyası okunamadı; hiçbir şey değiştirilmedi.',unsupported:'statusLine beklenmeyen biçimde; hiçbir şey değiştirilmedi.',unavailable:'Yol güvenle alıntılanamadı; hiçbir şey değiştirilmedi.','no-cache-dir':'Önbellek dizini yok.','write-failed':'Yazılamadı; ayarınız değiştirilmedi.','no-record':'Bu araçla yapılmış bir kurulum kaydı yok; geri alınacak bir şey yok.','changed-since-install':'statusLine kurulumdan sonra değişmiş; ayarınıza dokunulmadı. Elle düzenleyin.'};
function claudeQuotaBlock(){const c=S.claude;
 if(!c||c.unavailable)return h('p',{class:'why'},'Entegrasyon bilgisi alınamadı.');
 const wins=[['5 saatlik pencere',c.fiveHour],['7 günlük pencere',c.sevenDay]].filter((x)=>x[1]&&x[1].usedPercent!=null);
 if(!wins.length)return h('p',{class:'why'},'Kota verisi yok: '+(REASON[c.reason]||c.reason));
 return h('div',{},wins.map(([name,w])=>{const bar=h('div',{});bar.style.width=Math.min(100,w.usedPercent)+'%';if(w.usedPercent>=80)bar.className='hot';
  return h('div',{class:'qrow'},h('div',{class:'qh'},h('span',{},name),h('span',{},'%'+Math.round(w.usedPercent)+' kullanıldı')),h('div',{class:'bar'},bar),w.resetsAt?h('p',{class:'why'},'Sıfırlanma: '+rel(w.resetsAt)):null)}),
  h('p',{class:'why'},'Son güncelleme: '+(c.cache.ageSeconds!=null?Math.max(0,Math.round(c.cache.ageSeconds/60))+' dk önce':'—')+' · kaynak: Claude Code statusLine'))}
function quotaBlock(p){if(p==='claude')return claudeQuotaBlock();const q=((S.status&&S.status.quota)||[]).find((x)=>x.provider===p);
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
 v.append(integrationCard());
 for(const g of(S.status&&S.status.models)||[])v.append(h('section',{class:'card'},h('h2',{},IC('layers'),PN[g.provider]+' modelleri'),h('p',{class:'hint'},g.source+(g.provider==='claude'?' — efor düzeyleri satıcı belgelerine göre, hesap için doğrulanmadı.':'')),
  h('div',{style:null,class:'tw'},h('table',{},h('thead',{},h('tr',{},h('th',{},'Model'),h('th',{},'Kimlik'),h('th',{},'Efor'),h('th',{},'Varsayılan'))),h('tbody',{},g.models.map((m)=>h('tr',{},h('td',{},m.label),h('td',{class:'m'},m.id),h('td',{},m.efforts.join(', ')),h('td',{},m.defaultEffort||'—'))))))));
 main.replaceChildren(v)}
function integrationCard(){const c=S.claude;const card=h('section',{class:'card'},h('h2',{},IC('lock'),'Claude kota entegrasyonu'),h('p',{class:'hint'},'Yalnızca Claude Code’un resmî statusLine girdisi kullanılır: 5 saatlik/7 günlük yüzde ve sıfırlanma zamanı. Keychain, token, belgesiz API, kazıma, tahmin ve model çağrısı yok.'));
 if(!c||c.unavailable){card.append(h('p',{class:'why'},'Bu sunucuda entegrasyon kullanılamıyor.'));return card}
 card.append(h('div',{class:'row'},h('span',{class:'k'},'Ayar dosyası'),h('div',{class:'v'},h('code',{},c.settingsPath))),
  h('div',{class:'row'},h('span',{class:'k'},'statusLine'),h('div',{class:'v'},h('span',{class:'chip '+(c.installed?'ok':'def')},SETST[c.settings]||c.settings))),
  h('div',{class:'row'},h('span',{class:'k'},'Önbellek'),h('div',{class:'v'},h('span',{class:'chip '+(c.cache.state==='fresh'?'ok':c.cache.state==='missing'?'def':'warn')},CST[c.cache.state]||c.cache.state),c.cache.updatedAt?h('span',{class:'why'},' son güncelleme '+new Date(c.cache.updatedAt).toLocaleString('tr-TR')):null)),
  h('div',{class:'row'},h('span',{class:'k'},'Durum'),h('div',{class:'v'},h('p',{class:'why',style:null},REASON[c.reason]||c.reason))));
 const btns=h('div',{class:'dlgbtn',style:null});
 if(c.plan)btns.append(h('button',{type:'button',class:'chipbtn',onclick:()=>{confirmInstall(c.plan)}},c.plan.action==='chain'?'Kur (mevcut komutla zincirle)…':'Kur…'));
 if(c.restorable)btns.append(h('button',{type:'button',class:'chipbtn danger',onclick:confirmUninstall},'Geri al…'));
 btns.append(h('button',{type:'button',class:'chipbtn',onclick:()=>{loadClaude().then(draw)}},'Yenile'));
 card.append(btns);
 if(c.installed&&!c.restorable)card.append(h('p',{class:'why'},'Toplayıcı sizin kurduğunuz ya da kaydı kaybolmuş bir kurulum; bu araç onu otomatik geri almaz.'));
 if(S.claudeMsg)card.append(h('p',{class:'note'},S.claudeMsg));
 return card}
function askDialog(title,facts,text,consent,label,onGo){const dlg=h('dialog',{class:'dlg'});const c=h('input',{type:'checkbox',id:'ic'});
 const go=h('button',{class:'go',type:'button',disabled:true,onclick:()=>{dlg.close();onGo()}},h('span',{},label));c.addEventListener('change',()=>{go.disabled=!c.checked});
 dlg.append(h('h2',{},IC('alert'),title),h('div',{class:'facts'},facts.map(([k,v])=>h('div',{},h('span',{class:'k'},k),h('code',{},v)))),h('p',{class:'why'},text),h('label',{class:'switch',for:'ic'},c,h('span',{},consent)),h('div',{class:'dlgbtn'},h('button',{type:'button',class:'chipbtn',onclick:()=>{dlg.close()}},'Vazgeç'),go));
 document.body.append(dlg);dlg.addEventListener('close',()=>{dlg.remove()});dlg.showModal()}
function confirmInstall(plan){askDialog('Kota toplayıcısını kur',[['Ayar dosyası',S.claude.settingsPath],['Eylem',plan.action==='chain'?'mevcut statusLine komutunuz zincirlenecek':'statusLine eklenecek'],['Yazılacak komut',plan.display]],
  'Yalnızca ~/.claude ayarındaki statusLine anahtarı değişir; diğer ayarlarınız korunur (dosya 2 boşluk girintiyle yeniden yazılır). Önceki değer kaydedilir ve “Geri al” aynen geri yükler. Mevcut komutunuz varsa her çizimde önce toplayıcı çalışır, sonra sizin komutunuz aynı girdiyle çalışır ve çıktısı aynen görünür. Toplayıcı yalnızca yüzde ve sıfırlanma zamanını yerel önbelleğe yazar.',
  'Bu değişikliği anlıyorum ve onaylıyorum.','Kur',async()=>{try{const r=await api('/api/claude/install',{method:'POST',body:JSON.stringify({confirm:true,planId:plan.id})});S.claude=r.diagnosis;S.claudeMsg=r.result.action==='unchanged'?'Zaten kurulu.':'Kuruldu. Veri, açık bir Claude Code oturumu durum çubuğunu çizdiğinde gelir.'}catch(e){S.claudeMsg='Kurulmadı: '+(INSTERR[e.message]||String(e.message||e))}loadClaude().then(draw)})}
function confirmUninstall(){askDialog('Kurulumu geri al',[['Ayar dosyası',S.claude.settingsPath]],'statusLine, kurulumdan önceki değerine aynen döner (yoksa kaldırılır). Kurulumdan sonra siz değiştirdiyseniz ayarınıza dokunulmaz.','Geri almayı onaylıyorum.','Geri al',async()=>{try{const r=await api('/api/claude/uninstall',{method:'POST',body:JSON.stringify({confirm:true})});S.claude=r.diagnosis;S.claudeMsg='Geri alındı: statusLine önceki haline döndü.'}catch(e){S.claudeMsg='Geri alınmadı: '+(INSTERR[e.message]||String(e.message||e))}loadClaude().then(draw)})}
async function loadClaude(){try{S.claude=await api('/api/claude')}catch(e){S.claude=null}}
function drawSafety(){
 const li=(t)=>h('li',{},t);
 main.replaceChildren(h('div',{class:'view stack'},h('section',{class:'card'},h('h2',{},IC('lock'),'Bu arayüz neyi yapar, neyi yapmaz'),
  h('ul',{class:'list'},[
  'Yalnızca bu bilgisayarın döngü arayüzünde (127.0.0.1) dinler; her istek bu başlatmaya özel rastgele bir anahtar ve doğru Host/Origin ister.',
  'Önizleme gerçek CLI’nın “orchestrate --dry-run” komutuyla üretilir: ajan başlatılmaz, model çağrısı yapılmaz, dosya yazılmaz. Koşu da aynı CLI/çekirdek orkestrasyonunu kullanır; ayrı bir yürütücü yoktur.',
  'Görev metni, çıktılar ve ayarlar diske ya da tarayıcı depolamasına yazılmaz; yalnızca sunucu belleğinde son koşu tutulur (sunucu kapanınca silinir).',
  'Sır, API anahtarı ya da oturum bilgisi gösterilmez veya saklanmaz. Kota yalnızca yerel okumadan gelir; yoksa “veri yok” yazılır.',
  'Sayfa dış kaynak yüklemez (yazı tipi, betik, görsel yok) ve sıkı bir içerik güvenlik ilkesiyle sunulur.',
  'Claude modelleri erişim doğrulanamadığı için hiçbir zaman otomatik sabitlenmez; ultracode seçilmez.',
  'Gerçek çalıştırma aynı ayarlarla geçen bir önizleme, açık onay ve (plan-implement-review için) bağlı bir çalışma ağacı ister; ağaç önizlemeden sonra değiştiyse koşu başlamaz. Yazma ve test komutu ayrı onaylanır. Aynı anda tek koşu, adım zaman aşımı, genel süre sınırı ve kota (≥%95 ise başlamaz) uygulanır; koşu sonrası özet Git’ten okunur.',
  'CLI ön kontrolü (proxy/TLS, oturum, güvenlik) reddederse bu açıkça gösterilir ve otomatik atlanmaz. API anahtarı geri dönüşü, otomatik commit/push ve yeniden deneme yoktur.',
  'Canlı kayıt ve çıktı gösterilmeden önce bilinen sır kalıplarından (anahtar, token, parola, Bearer) arındırılır; bu en iyi çabadır, tam güvence değildir. Model çıktısı yalnızca metin olarak gösterilir.'].map(li))),
  h('section',{class:'card'},h('h2',{},IC('book'),'Kanıt türleri'),h('ul',{class:'list'},[
  'Kıyaslama kanıtı: aynı kıyaslama, sürüm ve eforla karşılaştırılabilir yayımlanmış sonuçlar (katı kurallar).',
  'Dokümantasyon: sağlayıcının belgelediği model amacı. Bir ölçüm değildir; belirsizliği her zaman gösterilir.',
  'Erişim: hesabın hangi modelleri kullanabildiğine dair bilgi. Claude için bilinmiyor.'].map(li)))))}

function draw(){
 nav.querySelectorAll('.navbtn').forEach((b)=>{if(b.dataset.view===S.view)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current')});
 drawTop();
 if(S.view==='run'){main.replaceChildren(R.view);drawControls();drawFlow();drawResult();drawRun()}
 else if(S.view==='providers')drawProviders();else if(S.view==='prep')drawPrep();else drawSafety()}
async function loadStatus(){S.loading=true;refreshBtn.classList.add('spin');draw();
 try{S.status=await api('/api/status')}catch(e){toast('Durum okunamadı: '+String(e.message||e))}
 await loadClaude();
 S.loading=false;refreshBtn.classList.remove('spin');draw()}
buildRun();draw();loadStatus();
})();
`;
