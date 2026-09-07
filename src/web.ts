/** 웹 채팅 UI. 텔레그램과 동일한 명령 처리기를 재사용한다. */

const COOKIE = 'jarvis_auth';

export async function hashToken(password: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${password}::jarvis-v1`));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function readCookie(request: Request, name: string): string | null {
  const raw = request.headers.get('Cookie') ?? '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

export async function isAuthed(request: Request, password?: string): Promise<boolean> {
  if (!password) return false;
  const token = readCookie(request, COOKIE);
  return !!token && token === (await hashToken(password));
}

export function authCookie(token: string): string {
  // 30일 유지. Secure + HttpOnly 로 스크립트 접근과 평문 전송을 막는다.
  return `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`;
}

export const LOGIN_HTML = `<!doctype html><html lang="ko"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>자비스 로그인</title><style>
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;min-height:100dvh;display:grid;place-items:center;background:#f6f7f9;
 font:15px/1.5 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Pretendard",sans-serif;color:#1a1a1a}
@media(prefers-color-scheme:dark){body{background:#111315;color:#e8e8e8}}
form{width:min(320px,90vw);display:grid;gap:12px;padding:28px;border-radius:16px;background:#fff;
 box-shadow:0 1px 3px rgba(0,0,0,.08),0 8px 24px rgba(0,0,0,.06)}
@media(prefers-color-scheme:dark){form{background:#1b1e21;box-shadow:none;border:1px solid #2a2e33}}
h1{margin:0 0 4px;font-size:18px}
p{margin:0;font-size:13px;opacity:.6}
input,button{padding:11px 13px;border-radius:9px;border:1px solid #d8dce0;font-size:15px;font-family:inherit}
@media(prefers-color-scheme:dark){input{background:#111315;border-color:#33383e;color:#e8e8e8}}
button{background:#2f6fed;color:#fff;border:none;font-weight:600;cursor:pointer}
button:hover{background:#2a63d4}
.err{color:#d33;font-size:13px;display:none}
</style></head><body>
<form method="post" action="/login">
<h1>⏰ 자비스</h1><p>비밀번호를 입력하세요</p>
<input type="password" name="password" autofocus autocomplete="current-password" required>
<button type="submit">들어가기</button>
<div class="err" id="e">비밀번호가 틀렸어요</div>
</form>
<script>if(location.search.indexOf('e=1')>=0)document.getElementById('e').style.display='block'</script>
</body></html>`;

export const CHAT_HTML = `<!doctype html><html lang="ko"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>자비스</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>⏰</text></svg>">
<style>
:root{color-scheme:light dark;--bg:#f6f7f9;--panel:#fff;--line:#e5e8eb;--me:#2f6fed;--txt:#1a1a1a;--sub:#8b9099;--danger:#e5484d}
@media(prefers-color-scheme:dark){:root{--bg:#111315;--panel:#1b1e21;--line:#2a2e33;--txt:#e8e8e8;--sub:#868c94}}
*{box-sizing:border-box}
body{margin:0;height:100dvh;display:flex;flex-direction:column;background:var(--bg);color:var(--txt);
 font:15px/1.55 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Pretendard",sans-serif}
header{display:flex;align-items:center;gap:4px;padding:10px 12px;border-bottom:1px solid var(--line);
 background:var(--panel);position:sticky;top:0;z-index:2}
.brand{font-weight:600;padding:0 8px 0 4px}
.tab{padding:7px 14px;border-radius:20px;border:none;background:none;color:var(--sub);
 font:inherit;font-weight:600;font-size:14px;cursor:pointer}
.tab[aria-selected="true"]{background:var(--bg);color:var(--txt)}
.count{font-weight:400;opacity:.6;font-size:12px}
main{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch}
[hidden]{display:none!important}

/* 채팅 */
#log{padding:16px;display:flex;flex-direction:column;gap:10px}
.msg{max-width:min(80%,560px);padding:10px 14px;border-radius:16px;white-space:pre-wrap;word-break:break-word;animation:in .18s ease-out}
@keyframes in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
.me{align-self:flex-end;background:var(--me);color:#fff;border-bottom-right-radius:5px}
.bot{align-self:flex-start;background:var(--panel);border:1px solid var(--line);border-bottom-left-radius:5px}
.tip{align-self:center;color:var(--sub);font-size:13px;text-align:center;max-width:min(90%,520px);padding:4px 0}
.tip code{background:var(--panel);border:1px solid var(--line);padding:3px 8px;border-radius:7px;font-size:12px;
 display:inline-block;margin:3px 2px}
.tip code.ex{cursor:pointer}
.tip code.ex:hover{border-color:var(--me);color:var(--me)}

/* 목록 */
#items{padding:12px;display:flex;flex-direction:column;gap:8px}
.item{display:flex;align-items:center;gap:12px;padding:13px 14px;border-radius:13px;
 background:var(--panel);border:1px solid var(--line)}
.item.off{opacity:.5}
.info{flex:1;min-width:0}
.when{font-size:12px;color:var(--sub);display:flex;align-items:center;gap:5px}
.badge{background:var(--me);color:#fff;border-radius:5px;padding:0 5px;font-size:10px;font-weight:700}
.what{font-weight:500;margin-top:2px;word-break:break-word}
.act{display:flex;gap:6px;flex-shrink:0}
.act button{width:34px;height:34px;border-radius:9px;border:1px solid var(--line);background:var(--bg);
 color:var(--txt);cursor:pointer;font-size:15px;line-height:1;padding:0}
.act button:hover{border-color:var(--sub)}
.act .del:hover{border-color:var(--danger);color:var(--danger)}
.empty{text-align:center;color:var(--sub);padding:48px 20px;font-size:14px}

/* 퀵 명령 칩 */
#chips{display:flex;gap:7px;padding:11px 14px 11px;overflow-x:auto;scrollbar-width:none;
 background:var(--panel);border-top:1px solid var(--line)}
#chips::-webkit-scrollbar{display:none}
.chip{flex-shrink:0;padding:9px 15px;border-radius:18px;border:1px solid var(--line);
 background:var(--bg);color:var(--txt);font:inherit;font-size:13px;cursor:pointer;white-space:nowrap;
 line-height:1.2}
.chip:hover{border-color:var(--me);color:var(--me)}
.chip.run{background:var(--me);color:#fff;border-color:var(--me);font-weight:600}
.chip.run:hover{opacity:.88;color:#fff}
form{border-top:none}

form{display:flex;gap:8px;padding:4px 14px calc(14px + env(safe-area-inset-bottom));
 border-top:1px solid var(--line);background:var(--panel)}
input{flex:1;padding:12px 14px;border-radius:22px;border:1px solid var(--line);background:var(--bg);
 color:var(--txt);font-size:16px;font-family:inherit;min-width:0}
input:focus{outline:2px solid var(--me);outline-offset:-1px}
form button{padding:0 18px;border-radius:22px;border:none;background:var(--me);color:#fff;font-weight:600;
 font-size:15px;cursor:pointer;flex-shrink:0}
form button:disabled{opacity:.5}
</style></head><body>
<header>
  <span class="brand">⏰ 자비스</span>
  <button class="tab" id="tabChat" aria-selected="true">채팅</button>
  <button class="tab" id="tabList" aria-selected="false">알람 <span class="count" id="cnt"></span></button>
  <small id="st" title="상태 확인 중"><span class="dot" id="dot"></span><span id="stx">확인 중</span></small>
</header>

<main id="paneChat">
  <div id="log">
    <div class="tip">말하듯 편하게 적어보세요
      <div><code class="ex">내일 3시에 병원 알려줘</code><code class="ex">평일 8시 반 스탠드업</code><code class="ex">다음주 월요일 2시에 치과</code></div>
    </div>
  </div>
</main>

<main id="paneList" hidden><div id="items"></div></main>

<div id="chips"></div>
<form id="f"><input id="i" placeholder="내일 3시에 병원 알려줘" autocomplete="off" autofocus><button id="b">보내기</button></form>

<script>
var log=document.getElementById('log'),f=document.getElementById('f'),i=document.getElementById('i'),b=document.getElementById('b');
var paneChat=document.getElementById('paneChat'),paneList=document.getElementById('paneList');
var tabChat=document.getElementById('tabChat'),tabList=document.getElementById('tabList');
var items=document.getElementById('items'),cnt=document.getElementById('cnt');

function add(text,cls){var d=document.createElement('div');d.className='msg '+cls;d.textContent=text;
  log.appendChild(d);paneChat.scrollTop=paneChat.scrollHeight;return d}

function show(which){
  var isChat=which==='chat';
  paneChat.hidden=!isChat; paneList.hidden=isChat;
  f.hidden=!isChat;
  tabChat.setAttribute('aria-selected',isChat?'true':'false');
  tabList.setAttribute('aria-selected',isChat?'false':'true');
  if(!isChat)load();
}
tabChat.onclick=function(){show('chat')};
tabList.onclick=function(){show('list')};

async function api(text){
  var r=await fetch('/api/chat',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({text:text})});
  if(r.status===401){location.href='/';return null}
  return (await r.json()).reply;
}

async function load(){
  items.innerHTML='<div class="empty">불러오는 중...</div>';
  var r=await fetch('/api/reminders');
  if(r.status===401){location.href='/';return}
  var list=await r.json();
  cnt.textContent=list.filter(function(x){return x.enabled}).length||'';
  items.innerHTML='';
  if(!list.length){items.innerHTML='<div class="empty">등록된 알람이 없어요.<br>채팅 탭에서 말하듯 적어보세요.</div>';return}
  list.forEach(function(x){
    var el=document.createElement('div');
    el.className='item'+(x.enabled?'':' off');
    var info=document.createElement('div'); info.className='info';
    var when=document.createElement('div'); when.className='when';
    when.textContent=x.when;
    if(x.once){var bd=document.createElement('span');bd.className='badge';bd.textContent='1회';when.appendChild(bd)}
    var what=document.createElement('div'); what.className='what'; what.textContent=x.message;
    info.appendChild(when); info.appendChild(what);
    var act=document.createElement('div'); act.className='act';
    var tg=document.createElement('button');
    tg.textContent=x.enabled?'⏸':'▶'; tg.title=x.enabled?'끄기':'켜기';
    tg.onclick=async function(){tg.disabled=true;await api((x.enabled?'/off ':'/on ')+x.id);load()};
    var dl=document.createElement('button'); dl.className='del'; dl.textContent='🗑'; dl.title='삭제';
    dl.onclick=async function(){
      if(!confirm('"'+x.message+'" 알람을 삭제할까요?'))return;
      dl.disabled=true; await api('/del '+x.id); load();
    };
    act.appendChild(tg); act.appendChild(dl);
    el.appendChild(info); el.appendChild(act);
    items.appendChild(el);
  });
}

// run:true = 누르면 바로 실행 / false = 입력창에 채워넣고 수정하게
var CHIPS=[
  {label:'📋 알람 목록', cmd:'/list', run:true},
  {label:'🆕 새 모델 확인', cmd:'/check', run:true},
  {label:'❓ 도움말', cmd:'/help', run:true},
  {label:'매일 09:00 물 마시기', cmd:'매일 09:00 물 마시기', run:false},
  {label:'평일 08:30 스탠드업', cmd:'평일 08:30 스탠드업', run:false},
  {label:'내일 15:00 병원', cmd:'내일 15:00 병원', run:false},
  {label:'🆔 내 chat_id', cmd:'/id', run:true}
];
CHIPS.forEach(function(c){
  var el=document.createElement('button');
  el.className='chip'+(c.run?' run':'');
  el.textContent=c.label;
  el.onclick=function(){
    if(c.run){ send(c.cmd); }
    else { i.value=c.cmd; i.focus(); i.setSelectionRange(c.cmd.length,c.cmd.length); }
  };
  document.getElementById('chips').appendChild(el);
});

// 채팅 탭 예시 문구도 클릭하면 입력창에 채워진다
Array.prototype.forEach.call(document.querySelectorAll('.tip code.ex'),function(el){
  el.onclick=function(){ i.value=el.textContent; i.focus(); };
});

var ALIAS={'목록':'/list','리스트':'/list','도움말':'/help','help':'/help'};
async function send(text){
  text=(text||'').trim(); if(!text)return;
  show('chat');  // 알람 탭에서 칩을 눌러도 결과는 채팅에서 보인다
  add(text,'me'); i.value=''; b.disabled=true;
  var pending=add('...','bot');
  try{
    var reply=await api(ALIAS[text]||text);
    if(reply===null)return;
    pending.textContent=reply||'응답이 비었어요';
    if(reply.indexOf('등록했어요')===0)load();
  }catch(err){pending.textContent='연결에 실패했어요. 잠시 후 다시 시도해주세요.'}
  b.disabled=false; i.focus();
}

f.onsubmit=function(e){ e.preventDefault(); send(i.value); };

var dot=document.getElementById('dot'),stx=document.getElementById('stx'),st=document.getElementById('st');

async function status(){
  try{
    var r=await fetch('/api/status');
    if(r.status===401){location.href='/';return}
    var d=await r.json();
    dot.className='dot '+(d.healthy?'ok':'bad');
    if(d.ageMin===null){ stx.textContent='대기 중'; }
    else { stx.textContent=d.healthy ? '정상' : (d.ageMin+'분째 멈춤'); }
    var lines=[
      '마지막 확인: '+(d.lastTick||'-')+(d.ageMin!==null?' ('+d.ageMin+'분 전)':''),
      '서버 시각: '+d.now,
      '켜진 알람: '+d.reminders+'개',
      '감시 중인 모델: '+d.watched+'개',
      '감시 제작사: '+(d.watchProviders.join(', ')||'없음')
    ];
    st.title=lines.join('\\n');
  }catch(e){
    dot.className='dot'; stx.textContent='연결 끊김'; st.title='상태를 가져오지 못했어요';
  }
}
status();
setInterval(status,60000);            // 1분마다 갱신
document.addEventListener('visibilitychange',function(){ if(!document.hidden)status() });

load();
</script></body></html>`;
