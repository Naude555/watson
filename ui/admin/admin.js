let targetsAll = [];
let chatsAll = [];
let activeChatJid = '';
let lastSeenTs = 0;
let pollTimer = null;
let msgFilter = 'all';
let chatMessages = [];
let replyHandlersBound = false;


// Friendly display maps (filled by /admin/targets)
const contactNameByJid = new Map();
const contactNameByMsisdn = new Map();
const groupAliasByJid = new Map();
const waGroupNameByJid = new Map();

// Target selection
const selectedTargets = new Set();


function setPill(msg, mode){
  const dot = document.getElementById('statusDot');
  const text = document.getElementById('statusText');
  text.textContent = msg;
  dot.className = 'dot ' + (mode || 'neutral');
}

let statusTimer=null;
function setStatus(msg, ok=true){
  const el=document.getElementById('status');
  el.className = 'toast ' + (ok ? 'ok' : 'err');
  el.textContent = msg;
  setPill(ok ? 'connected' : 'error', ok ? 'ok' : 'err');
  if(statusTimer) clearTimeout(statusTimer);
  statusTimer = setTimeout(()=>{
    // keep the pill, clear only the message
    if(el) el.textContent = '';
  }, 3500);
}

function getKey(){ return document.getElementById('adminKey').value.trim(); }
function saveKey(){
  const k=getKey();
  if(!k) return setStatus('No key to save', false);
  localStorage.setItem('WA_ADMIN_KEY', k);
  setStatus('Saved admin key in browser', true);
}
function clearKey(){
  localStorage.removeItem('WA_ADMIN_KEY');
  document.getElementById('adminKey').value='';
  setStatus('Cleared admin key', true);
}

function showTab(which){
  document.getElementById('tabMessages').classList.toggle('active', which==='messages');
  document.getElementById('tabSend').classList.toggle('active', which==='send');
  document.getElementById('tabContacts').classList.toggle('active', which==='contacts');
  const tAuto = document.getElementById('tabAutomations');
  if(tAuto) tAuto.classList.toggle('active', which==='automations');

  document.getElementById('panelMessages').classList.toggle('hidden', which!=='messages');
  document.getElementById('panelSend').classList.toggle('hidden', which!=='send');
  document.getElementById('panelContacts').classList.toggle('hidden', which!=='contacts');
  const pAuto = document.getElementById('panelAutomations');
  if(pAuto) pAuto.classList.toggle('hidden', which!=='automations');
}

async function api(path, opts={}){
  const key=getKey();
  if(!key) throw new Error('Missing admin key');
  const headers = Object.assign({}, opts.headers||{}, {'x-admin-key': key});
  const res = await fetch(path, Object.assign({}, opts, { headers }));
  const text = await res.text();
  let json=null; try{ json=JSON.parse(text) }catch{}
  if(!res.ok){
    const msg = (json && (json.error||json.message)) ? (json.error||json.message) : text;
    throw new Error('HTTP '+res.status+' '+res.statusText+': '+(msg||'(empty)'));
  }
  return json ?? {};
}

function boot(){
  const k=localStorage.getItem('WA_ADMIN_KEY');
  if(k && !getKey()) document.getElementById('adminKey').value = k;

  setPill('connecting…','neutral');
  const tasks=[loadTargets(), loadChats(), loadCrud()];
  if(typeof loadAutomations==='function') tasks.push(loadAutomations());
  Promise.all(tasks)
    .then(()=>{ renderSendForm(); restartPolling(); bindAutomationsUi(); setStatus('Connected', true); })
    .catch(e=>setStatus(e.message,false));
}
boot();

/**
 * ---------- Targets (multi-select) ----------
 */
async function loadTargets(){
  const j = await api('/admin/targets');

  // Build label maps for friendly display
  contactNameByJid.clear();
  contactNameByMsisdn.clear();
  groupAliasByJid.clear();
  waGroupNameByJid.clear();

  for(const c of (j.contacts||[])){
    const name = String(c.name||'').trim();
    const jid = String(c.jid||'').trim();
    const ms = String(c.msisdn||'').replace(/\D/g,'');
    if(name && jid) contactNameByJid.set(jid, name);
    if(name && ms){
      // store both raw digits and ZA-normalised 27XXXXXXXXX form where possible
      contactNameByMsisdn.set(ms, name);
      if(ms.startsWith('0') && ms.length >= 10) contactNameByMsisdn.set('27'+ms.slice(1), name);
      if(ms.startsWith('27')) contactNameByMsisdn.set(ms, name);
    }
  }

  for(const g of (j.groupAliases||[])){
    const alias = String(g.name||'').trim();
    const jid = String(g.jid||'').trim();
    if(alias && jid) groupAliasByJid.set(jid, alias);
  }

  for(const g of (j.waGroups||[])){
    const name = String(g.name||'').trim();
    const jid = String(g.jid||'').trim();
    if(name && jid) waGroupNameByJid.set(jid, name);
  }

  targetsAll = [
    ...(j.contacts||[]).map(x=>({...x, label: '👤 '+x.name, value: x.to || x.jid || x.name})),
    ...(j.groupAliases||[]).map(x=>({...x, label: '🏷️ '+x.name, value: x.to || x.jid || x.name})),
    ...(j.waGroups||[]).map(x=>({...x, label: '👥 '+x.name, value: x.to || x.jid || x.name}))
  ].filter(x=>x.value);
  renderTargets();

  // WA group picker for aliases
  const pick = document.getElementById('waGroupsPick');
  pick.innerHTML = '';
  const opt0 = document.createElement('option');
  opt0.value = '';
  opt0.textContent = 'Select a WhatsApp group…';
  pick.appendChild(opt0);

  const wa = (j.waGroups || []).slice().sort((a,b)=>String(a.name).localeCompare(String(b.name)));
  for(const g of wa){
    const opt=document.createElement('option');
    opt.value=g.jid;
    opt.textContent = g.name + '  ('+g.jid+')';
    pick.appendChild(opt);
  }
}

function renderTargets(){
  const q = (document.getElementById('targetSearch').value||'').toLowerCase().trim();

  const listEl = document.getElementById('targetList');
  if(!listEl) return;

  const list = targetsAll.filter(t => !q || (t.label||'').toLowerCase().includes(q) || (t.value||'').toLowerCase().includes(q));
  listEl.innerHTML = '';

  for(const t of list){
    const row = document.createElement('label');
    row.className = 'targetRow';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = selectedTargets.has(t.value);
    cb.addEventListener('change', ()=>{
      if(cb.checked) selectedTargets.add(t.value);
      else selectedTargets.delete(t.value);
      renderSelectedTargets();
    });

    const text = document.createElement('div');
    text.className = 'targetText';
    text.innerHTML = `<div class="tMain">${esc(t.label||'Target')}</div><div class="tSub">${esc(t.value||'')}</div>`;

    row.appendChild(cb);
    row.appendChild(text);
    listEl.appendChild(row);
  }

  renderSelectedTargets();
}

function getSelectedTargets(){
  return Array.from(selectedTargets.values()).filter(Boolean);
}

function renderSelectedTargets(){
  const chips = document.getElementById('selectedTargetsChips');
  if(!chips) return;
  chips.innerHTML = '';

  const values = Array.from(selectedTargets.values());
  if(!values.length){
    const empty = document.createElement('div');
    empty.className = 'small';
    empty.style.opacity = '.8';
    empty.textContent = 'None selected';
    chips.appendChild(empty);
    return;
  }

  for(const v of values){
    const t = targetsAll.find(x=>x.value===v);
    const label = t ? String(t.label||v) : v;
    const chip = document.createElement('span');
    chip.className = 'chip';

    const txt = document.createElement('span');
    txt.className = 'chipText';
    txt.textContent = label;
    chip.appendChild(txt);

    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'chipX';
    x.textContent = '×';
    x.addEventListener('click', ()=>{
      selectedTargets.delete(v);
      renderTargets();
    });

    chip.appendChild(x);
    chips.appendChild(chip);
  }
}

// ---------- Friendly labels ----------
function digitsFromJid(jid){
  const s = String(jid||'');
  const at = s.indexOf('@');
  const num = (at > 0 ? s.slice(0, at) : s).replace(/\D/g,'');
  return num || '';
}

function prettyPhoneFromJid(jid){
  const d = digitsFromJid(jid);
  if(!d) return '';
  // South Africa-friendly: 27XXXXXXXXX -> 0XXXXXXXXX
  if(d.startsWith('27') && d.length >= 11) return '0' + d.slice(2);
  return '+' + d;
}

function mapGet(m, k){
  if(!m) return undefined;
  if(typeof m.get === 'function') return m.get(k);
  return m[k];
}

function displayNameForJid(jid){
  const j = String(jid||'').trim();
  if(!j) return '';

  if(j.endsWith('@g.us')){
    const alias = mapGet(groupAliasByJid, j)
    if(alias) return alias;
    const waName = mapGet(waGroupNameByJid, j)
    if(waName) return waName;
    return j; // fallback
  }

  const byJid = mapGet(contactNameByJid, j);
  if(byJid) return byJid;

  const digits = digitsFromJid(j);
  if(digits){
    const byDigits = mapGet(contactNameByMsisdn, digits);
    if(byDigits) return byDigits;
  }

  const phone = prettyPhoneFromJid(j);
  return phone || j;
}

/**
 * ---------- Messages ----------
 */
async function loadChats(){
  const j = await api('/admin/messages/chats');
  chatsAll = j.chats || [];
  renderChats();
}

function renderChats(){
  const q = (document.getElementById('chatSearch').value||'').toLowerCase().trim();
  const sel = document.getElementById('chatSelect');
  const prev = sel.value;
  sel.innerHTML='';

  const list = (chatsAll||[]).filter(c => {
    const name = displayNameForJid(c.chatJid);
    const hay = (String(name||'')+' '+String(c.chatJid||'')+' '+String(c.lastText||'')).toLowerCase();
    return !q || hay.includes(q);
  });

  for(const c of list){
    const opt=document.createElement('option');
    opt.value=c.chatJid;
    const name = displayNameForJid(c.chatJid);
    const suffix = (name && name !== c.chatJid) ? ` (${c.chatJid})` : '';
    const title = (c.isGroup ? '👥 ' : '👤 ') + (name || c.chatJid) + suffix;
    const tail = (c.lastText||'').slice(0,40).replace(/\\n/g,' ');
    opt.textContent = title + ' — ' + tail;
    sel.appendChild(opt);
  }

  if(prev) sel.value = prev;
  if(!activeChatJid && sel.value){ activeChatJid = sel.value; selectChat(); }
}

function selectChat(){
  const sel = document.getElementById('chatSelect');
  activeChatJid = sel.value;
  lastSeenTs = 0;
  chatMessages = [];

  const log = document.getElementById('chatLog');
  if(log) log.innerHTML = '';

  const nice = activeChatJid ? displayNameForJid(activeChatJid) : '';
  document.getElementById('chatMeta').textContent = activeChatJid ? (` • ${nice}${nice && nice!==activeChatJid ? ' ('+activeChatJid+')' : ''}`) : '';

  // Reply hints
  const hint = document.getElementById('replyToHint');
  if(hint) hint.textContent = activeChatJid ? (`Replying to: ${nice || activeChatJid}`) : 'No chat selected';

  // Ensure filter buttons are consistent
  setMsgFilter(msgFilter);

  bindReplyHandlersOnce();

  if(activeChatJid) pollOnce(true);
}
function clearReplyMedia(){
  const f=document.getElementById('replyFile'); if(f) f.value='';
  const c=document.getElementById('replyCaption'); if(c) c.value='';
}

function esc(s){
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&":"&amp;",
    "<":"&lt;",
    ">":"&gt;",
    '"':"&quot;",
    "'":"&#39;"
  }[c]));
}


function bindReplyHandlersOnce(){
  if(replyHandlersBound) return;
  replyHandlersBound = true;

  const ta = document.getElementById('replyText');
  if(!ta) return;

  ta.addEventListener('keydown', (e) => {
    // Enter sends, Shift+Enter makes a newline
    if(e.key === 'Enter' && !e.shiftKey){
      e.preventDefault();
      sendReply();
    }
  });
}

function setMsgFilter(which){
  msgFilter = which || 'all';
  document.getElementById('msgTabAll')?.classList.toggle('active', msgFilter==='all');
  document.getElementById('msgTabIn')?.classList.toggle('active', msgFilter==='in');
  document.getElementById('msgTabOut')?.classList.toggle('active', msgFilter==='out');

  const hint = document.getElementById('msgFilterHint');
  if(hint){
    hint.textContent = 'Showing: ' + (msgFilter==='all' ? 'All' : (msgFilter==='in' ? 'Incoming' : 'Outgoing'));
  }

  renderChatMessages(true);
}

function matchesFilter(m){
  if(msgFilter === 'all') return true;
  return (m.direction === msgFilter);
}

function renderOneMessage(m){
  const log = document.getElementById('chatLog');
  if(!log) return;

  const d = new Date(m.ts).toLocaleString();
  const senderJid = m.isGroup ? (m.senderJid || '') : (m.chatJid || '');
  const sender = displayNameForJid(senderJid) || senderJid;

  const div = document.createElement('div');
  div.className = 'msg ' + (m.direction === 'out' ? 'out' : 'in');

  const meta = document.createElement('div');
  meta.className = 'meta';

  const left = document.createElement('span');
  left.textContent = `${d} • ${sender}`;
  meta.appendChild(left);

  if(m.direction === 'out' && m.status){
    const b = document.createElement('span');
    const st = String(m.status || '').toLowerCase();
    b.className = 'badge ' + (st === 'queued' || st === 'sent' || st === 'failed' ? st : 'type');
    b.style.marginLeft = '8px';
    b.textContent = st || 'status';
    meta.appendChild(b);
  }

  const body = document.createElement('div');
  body.className = 'bodyText';
  body.textContent = (m.text || '');

  div.appendChild(meta);
  div.appendChild(body);

  const mediaUrl = (m.media && (m.media.localUrl || m.media.url))
    ? (m.media.localUrl || m.media.url)
    : null;

  if(mediaUrl){
    const wrap = document.createElement('div');
    wrap.className = 'mediaWrap';

    const isImage = (m.type === 'image') || ((m.media?.mimetype || '').startsWith('image/'));

    if(isImage){
      const img = document.createElement('img');
      img.className = 'mediaImg';
      img.loading = 'lazy';
      img.alt = 'image';
      img.src = mediaUrl;

      img.onerror = () => {
        const err = document.createElement('div');
        err.className = 'small';
        err.textContent = `⚠️ Failed to load image: ${mediaUrl}`;
        wrap.appendChild(err);
      };

      wrap.appendChild(img);
    }else{
      const a = document.createElement('a');
      a.className = 'mediaLink';
      a.href = mediaUrl;
      a.textContent = m.media?.fileName || 'Download file';
      a.target = '_blank';
      a.rel = 'noopener';
      wrap.appendChild(a);
    }

    div.appendChild(wrap);
  }

  log.appendChild(div);
}

function renderChatMessages(scrollToBottom=true){
  const log = document.getElementById('chatLog');
  if(!log) return;

  // Keep it simple: full redraw of up to 200 messages is cheap and avoids edge cases.
  log.innerHTML = '';
  for(const m of chatMessages){
    if(matchesFilter(m)) renderOneMessage(m);
  }

  if(scrollToBottom){
    log.scrollTop = log.scrollHeight;
  }
}

function appendMessages(msgs){
  // Merge into in-memory cache, then re-render according to filter.
  for(const m of (msgs||[])){
    chatMessages.push(m);
    lastSeenTs = Math.max(lastSeenTs, m.ts || 0);
  }

  // De-dup by id if present (keep last occurrence)
  // (Some full refreshes may re-deliver the same records.)
  const seen = new Map();
  for(const m of chatMessages){
    const key = m.id || (String(m.ts)+'|'+String(m.direction)+'|'+String(m.text||'')+'|'+String(m.chatJid||''));
    seen.set(key, m);
  }
  chatMessages = Array.from(seen.values()).sort((a,b)=>(a.ts||0)-(b.ts||0));

  renderChatMessages(true);
}

let pollCount = 0;

async function pollOnce(force=false){
  if(!activeChatJid) return;

  pollCount++;
  const doFull = force || (pollCount % 10 === 0); // every 10 polls full refresh

  const qs = new URLSearchParams();
  qs.set('limit','200');
  if(!doFull && lastSeenTs) qs.set('since', String(lastSeenTs));

  const j = await api('/admin/messages/chat/'+encodeURIComponent(activeChatJid)+'?'+qs.toString());

  if(doFull){
    document.getElementById('chatLog').innerHTML='';
    lastSeenTs = 0;
  }

  if(j.messages && j.messages.length) appendMessages(j.messages);
}


function restartPolling(){
  if(pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  const ms = Number(document.getElementById('pollRate').value||0);
  if(ms > 0){
    pollTimer = setInterval(()=>{
      pollOnce(false).catch(()=>{});
      loadChats().catch(()=>{});
    }, ms);
  }
}

/**
 * Switch messages to a chat after sending
 */
function switchMessagesToJid(jid){
  if(!jid) return;
  showTab('messages');

  const sel = document.getElementById('chatSelect');
  let found = false;
  for(const opt of sel.options){ if(opt.value === jid){ found = true; break; } }
  if(!found){
    const opt=document.createElement('option');
    opt.value = jid;
    const name = displayNameForJid(jid);
    const suffix = (name && name !== jid) ? ` (${jid})` : '';
    opt.textContent = (jid.endsWith('@g.us') ? '👥 ' : '👤 ') + (name || jid) + suffix + ' — (new)';
    sel.insertBefore(opt, sel.firstChild);
  }
  sel.value = jid;
  activeChatJid = jid;
  lastSeenTs = 0;
  document.getElementById('chatMeta').textContent = ' • '+jid;
  document.getElementById('chatLog').innerHTML='';
  pollOnce(true).catch(()=>{});
}


async function sendReply(){
  try{
    if(!activeChatJid) throw new Error('Select a chat first');
    const text = (document.getElementById('replyText').value||'').trim();
    const fileEl = document.getElementById('replyFile');
    const file = fileEl && fileEl.files && fileEl.files[0] ? fileEl.files[0] : null;
    const caption = (document.getElementById('replyCaption')?.value||'').trim();

    if(!text && !file) throw new Error('Nothing to send');

    if(file){
      if((file.type||'').startsWith('image/')){
        const fd=new FormData();
        fd.append('to', activeChatJid);
        fd.append('image', file);
        if(caption) fd.append('caption', caption);
        await api('/admin/send/image', { method:'POST', body: fd });
      }else{
        const fd=new FormData();
        fd.append('to', activeChatJid);
        fd.append('document', file);
        fd.append('fileName', file.name || 'document');
        if(file.type) fd.append('mimetype', file.type);
        await api('/admin/send/document', { method:'POST', body: fd });
      }
      clearReplyMedia();
    }

    if(text){
      await api('/admin/send/text', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ to: activeChatJid, message: text })
      });
      document.getElementById('replyText').value = '';
    }

    setStatus('Queued to active chat', true);
    pollOnce(true).catch(()=>{});
  }catch(e){
    setStatus(e.message||String(e), false);
  }
}

/**
 * ---------- Send ----------
 */
function renderSendForm(){
  const type = document.getElementById('sendType').value;
  const el = document.getElementById('sendForm');

  if(type === 'text'){
    el.innerHTML = '<textarea id="sendText" placeholder="Type message..."></textarea>';
  } else if(type === 'image_upload'){
    el.innerHTML = '<input type="file" id="sendFile" accept="image/*" /><input id="sendCaption" placeholder="Caption (optional)" style="margin-top:8px"/>';
  } else if(type === 'image_url'){
    el.innerHTML = '<input id="sendUrl" placeholder="https://...image.jpg" /><input id="sendCaption" placeholder="Caption (optional)" style="margin-top:8px"/>';
  } else if(type === 'doc_upload'){
    el.innerHTML = '<input type="file" id="sendFile" /><input id="sendFileName" placeholder="fileName (optional)" style="margin-top:8px"/><input id="sendMime" placeholder="mimetype (optional)" style="margin-top:8px"/>';
  } else if(type === 'doc_url'){
    el.innerHTML = '<input id="sendUrl" placeholder="https://...file.pdf" /><input id="sendFileName" placeholder="fileName (optional)" style="margin-top:8px"/><input id="sendMime" placeholder="mimetype (optional)" style="margin-top:8px"/>';
  }
}

function clearSendForm(){
  const type = document.getElementById('sendType').value;
  if(type === 'text'){
    const el = document.getElementById('sendText'); if(el) el.value = '';
  } else if(type === 'image_upload' || type === 'doc_upload'){
    const f = document.getElementById('sendFile'); if(f) f.value = '';
    const c = document.getElementById('sendCaption'); if(c) c.value = '';
    const fn = document.getElementById('sendFileName'); if(fn) fn.value = '';
    const mt = document.getElementById('sendMime'); if(mt) mt.value = '';
  } else if(type === 'image_url' || type === 'doc_url'){
    const u = document.getElementById('sendUrl'); if(u) u.value = '';
    const c = document.getElementById('sendCaption'); if(c) c.value = '';
    const fn = document.getElementById('sendFileName'); if(fn) fn.value = '';
    const mt = document.getElementById('sendMime'); if(mt) mt.value = '';
  }
}

function parseManualTo(){
  const raw = (document.getElementById('toManual').value||'').trim();
  if(!raw) return [];
  // split by comma or newline
  return raw.split(/[,\\n]/g).map(x=>x.trim()).filter(Boolean);
}

function getToList(){
  const manualList = parseManualTo();
  if(manualList.length) return manualList;
  return getSelectedTargets();
}

function useSelectedAsManual(){
  const sel = getSelectedTargets();
  if(!sel.length) return setStatus('No targets selected', false);
  document.getElementById('toManual').value = sel.join(', ');
  setStatus('Copied selected targets into Manual To', true);
}

function clearManual(){
  document.getElementById('toManual').value = '';
  setStatus('Manual To cleared', true);
}

async function sendNow(){
  try{
    const toList = getToList();
    if(!toList.length) throw new Error('Select one or more targets OR type Manual To list');

    const type = document.getElementById('sendType').value;

    // we queue each target individually
    const results = [];
    const firstTo = toList[0];

    if(type === 'text'){
      const message = (document.getElementById('sendText').value||'').trim();
      if(!message) throw new Error('Message empty');

      for(const to of toList){
        const r = await api('/admin/send/text',{
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({to,message})
        });
        results.push(r);
      }
      setStatus('Sent text (queued) to '+toList.length+' target(s)', true);
      clearSendForm();
      switchMessagesToJid((results[0] && results[0].jid) ? results[0].jid : firstTo);
      return;
    }

    if(type === 'image_upload'){
      const f = document.getElementById('sendFile').files[0];
      if(!f) throw new Error('Choose an image file');
      const caption = (document.getElementById('sendCaption').value||'').trim();

      for(const to of toList){
        const fd = new FormData();
        fd.append('to', to);
        fd.append('image', f);
        if(caption) fd.append('caption', caption);
        const r = await api('/admin/send/image',{method:'POST',body:fd});
        results.push(r);
      }
      setStatus('Sent image upload (queued) to '+toList.length+' target(s)', true);
      clearSendForm();
      switchMessagesToJid((results[0] && results[0].jid) ? results[0].jid : firstTo);
      return;
    }

    if(type === 'image_url'){
      const imageUrl = (document.getElementById('sendUrl').value||'').trim();
      if(!imageUrl) throw new Error('Enter image URL');
      const caption = (document.getElementById('sendCaption').value||'').trim();

      for(const to of toList){
        const r = await api('/admin/send/image',{
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({to,imageUrl,caption})
        });
        results.push(r);
      }
      setStatus('Sent image URL (queued) to '+toList.length+' target(s)', true);
      clearSendForm();
      switchMessagesToJid((results[0] && results[0].jid) ? results[0].jid : firstTo);
      return;
    }

    if(type === 'doc_upload'){
      const f = document.getElementById('sendFile').files[0];
      if(!f) throw new Error('Choose a document file');
      const fileName = (document.getElementById('sendFileName').value||'').trim();
      const mimetype = (document.getElementById('sendMime').value||'').trim();

      for(const to of toList){
        const fd = new FormData();
        fd.append('to', to);
        fd.append('document', f);
        if(fileName) fd.append('fileName', fileName);
        if(mimetype) fd.append('mimetype', mimetype);
        const r = await api('/admin/send/document',{method:'POST',body:fd});
        results.push(r);
      }
      setStatus('Sent document upload (queued) to '+toList.length+' target(s)', true);
      clearSendForm();
      switchMessagesToJid((results[0] && results[0].jid) ? results[0].jid : firstTo);
      return;
    }

    if(type === 'doc_url'){
      const documentUrl = (document.getElementById('sendUrl').value||'').trim();
      if(!documentUrl) throw new Error('Enter document URL');
      const fileName = (document.getElementById('sendFileName').value||'').trim();
      const mimetype = (document.getElementById('sendMime').value||'').trim();

      for(const to of toList){
        const r = await api('/admin/send/document',{
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({to,documentUrl,fileName,mimetype})
        });
        results.push(r);
      }
      setStatus('Sent document URL (queued) to '+toList.length+' target(s)', true);
      clearSendForm();
      switchMessagesToJid((results[0] && results[0].jid) ? results[0].jid : firstTo);
      return;
    }

    throw new Error('Unknown send type');
  }catch(e){
    setStatus(e.message,false);
  }
}

/**
 * ---------- CRUD ----------
 */
async function loadCrud(){
  const j = await api('/admin/contacts');
  renderContacts(j.contacts||[]);
  renderGroupAliases(j.groups||[]);
}

function renderContacts(list){
  const tbody = document.querySelector('#contactsTable tbody');
  tbody.innerHTML = '';

  list.sort((a,b)=>String(a.name).localeCompare(String(b.name)));

  for(const c of list){
    const tr = document.createElement('tr');

    tr.innerHTML = `
      <td>${esc(c.name || '')}</td>
      <td>${esc(c.msisdn || '')}</td>
      <td>${esc(c.jid || '')}</td>
      <td>${Array.isArray(c.tags) ? esc(c.tags.join(', ')) : ''}</td>
      <td></td>
    `;

    const btn = document.createElement('button');
    btn.className = 'btnDanger';
    btn.textContent = 'Delete';
    btn.addEventListener('click', () => deleteContact(c.name));

    tr.lastElementChild.appendChild(btn);
    tbody.appendChild(tr);
  }
}

function renderGroupAliases(list){
  const tbody = document.querySelector('#groupsTable tbody');
  tbody.innerHTML = '';

  list.sort((a,b)=>String(a.name).localeCompare(String(b.name)));

  for(const g of list){
    const tr = document.createElement('tr');

    tr.innerHTML = `
      <td>${esc(g.name || '')}</td>
      <td>${esc(g.jid || '')}</td>
      <td></td>
    `;

    const btn = document.createElement('button');
    btn.className = 'btnDanger';
    btn.textContent = 'Delete';
    btn.addEventListener('click', () => deleteGroup(g.name));

    tr.lastElementChild.appendChild(btn);
    tbody.appendChild(tr);
  }
}

async function upsertContact(){
  try{
    const name=document.getElementById('cName').value.trim();
    const msisdn=document.getElementById('cMsisdn').value.trim();
    const jid=document.getElementById('cJid').value.trim();
    const tagsRaw=document.getElementById('cTags').value.trim();
    const tags=tagsRaw? tagsRaw.split(',').map(x=>x.trim()).filter(Boolean) : [];
    if(!name) throw new Error('Name required');

    const body={name, tags};
    if(msisdn) body.msisdn=msisdn;
    if(jid) body.jid=jid;

    await api('/admin/contacts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    setStatus('Contact saved', true);

    document.getElementById('cName').value='';
    document.getElementById('cMsisdn').value='';
    document.getElementById('cJid').value='';
    document.getElementById('cTags').value='';

    await loadCrud();
    await loadTargets();
  }catch(e){ setStatus(e.message,false); }
}

async function deleteContact(name){
  try{
    await api('/admin/contacts/'+encodeURIComponent(name),{method:'DELETE'});
    setStatus('Contact deleted', true);
    await loadCrud();
    await loadTargets();
  }catch(e){ setStatus(e.message,false); }
}

async function upsertGroup(){
  try{
    const name=document.getElementById('gName').value.trim();
    const jid=document.getElementById('gJid').value.trim();
    if(!name||!jid) throw new Error('Alias name and group JID required');

    await api('/admin/groups',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,jid})});
    setStatus('Group alias saved', true);

    document.getElementById('gName').value='';
    document.getElementById('gJid').value='';

    await loadCrud();
    await loadTargets();
  }catch(e){ setStatus(e.message,false); }
}

async function deleteGroup(name){
  try{
    await api('/admin/groups/'+encodeURIComponent(name),{method:'DELETE'});
    setStatus('Group alias deleted', true);
    await loadCrud();
    await loadTargets();
  }catch(e){ setStatus(e.message,false); }
}

function copyFromWaGroups(){
  const pick = document.getElementById('waGroupsPick');
  const jid = pick.value;
  if(!jid) return setStatus('Pick a WA group first', false);
  document.getElementById('gJid').value = jid;

  if(!document.getElementById('gName').value.trim()){
    const label = pick.selectedOptions[0].textContent || '';
    const name = label.split('  (')[0].trim();
    document.getElementById('gName').value = name;
  }
  setStatus('Copied group into alias form', true);
}

/**
 * ============================
 * Automations (n8n forwarding) UI
 * ============================
 * NOTE: This UI configures server-side forwarding rules only.
 * n8n owns flow logic and responses.
 */
let autoState = {
  global: null,
  overrides: {}, // jid -> override object
  selectedJid: '',
  templates: {} // key -> value (per override draft)
};

function el(id){ return document.getElementById(id); }

function bindAutomationsUi(){
  // Safe to call multiple times
  const btnReload = el('btnAutoReload');
  if(btnReload && !btnReload.dataset.bound){
    btnReload.dataset.bound='1';
    btnReload.addEventListener('click', ()=>loadAutomations().catch(e=>setStatus(e.message,false)));
  }

  const btnSaveGlobal = el('btnAutoSaveGlobal');
  if(btnSaveGlobal && !btnSaveGlobal.dataset.bound){
    btnSaveGlobal.dataset.bound='1';
    btnSaveGlobal.addEventListener('click', ()=>saveGlobalAutomations().catch(e=>setStatus(e.message,false)));
  }

  const btnCopyWebhook = el('btnCopyWebhook');
  if(btnCopyWebhook && !btnCopyWebhook.dataset.bound){
    btnCopyWebhook.dataset.bound='1';
    btnCopyWebhook.addEventListener('click', ()=>copyText(el('autoWebhookUrl')?.value || ''));
  }

  const btnChatRefresh = el('btnAutoChatRefresh');
  if(btnChatRefresh && !btnChatRefresh.dataset.bound){
    btnChatRefresh.dataset.bound='1';
    btnChatRefresh.addEventListener('click', ()=>loadChats().then(()=>renderAutoChatList()).catch(e=>setStatus(e.message,false)));
  }

  const search = el('autoChatSearch');
  if(search && !search.dataset.bound){
    search.dataset.bound='1';
    search.addEventListener('input', ()=>renderAutoChatList());
  }

  const btnSaveOverride = el('btnAutoSaveOverride');
  if(btnSaveOverride && !btnSaveOverride.dataset.bound){
    btnSaveOverride.dataset.bound='1';
    btnSaveOverride.addEventListener('click', ()=>saveSelectedOverride().catch(e=>setStatus(e.message,false)));
  }

  const btnReset = el('btnAutoResetOverride');
  if(btnReset && !btnReset.dataset.bound){
    btnReset.dataset.bound='1';
    btnReset.addEventListener('click', ()=>resetSelectedOverride().catch(e=>setStatus(e.message,false)));
  }
  const btnRecheck = el('btnAutoPreviewRecalc');

  if(btnRecheck && !btnRecheck.dataset.bound){
    btnRecheck.dataset.bound='1';
    btnRecheck.addEventListener('click', updateEffectivePreview);
  }

  const sample = el('autoPreviewSample');
  if(sample && !sample.dataset.bound){
    sample.dataset.bound='1';
    sample.addEventListener('input', updateEffectivePreview);
  }

  // mode toggles (global)
  const groupModeRadios = document.querySelectorAll('input[name="groupModeDefault"]');
  groupModeRadios.forEach(r=>{
    if(r.dataset.bound) return;
    r.dataset.bound='1';
    r.addEventListener('change', ()=>toggleKeywordRows('global'));
  });

  // mode toggles (override)
  const groupModeOverrideRadios = document.querySelectorAll('input[name="groupModeOverride"]');
  groupModeOverrideRadios.forEach(r=>{
    if(r.dataset.bound) return;
    r.dataset.bound='1';
    r.addEventListener('change', ()=>toggleKeywordRows('override'));
  });

  // inherit/custom toggle
  const overrideMode = document.querySelectorAll('input[name="overrideMode"]');
  overrideMode.forEach(r=>{
    if(r.dataset.bound) return;
    r.dataset.bound='1';
    r.addEventListener('change', ()=>{
      syncOverrideUi();
    });
  });


  // template add
  const btnTplAdd = el('btnTplAdd');
  if(btnTplAdd && !btnTplAdd.dataset.bound){
    btnTplAdd.dataset.bound='1';
    btnTplAdd.addEventListener('click', addTemplateFromInputs);
  }

  const btnCopyJson = el('btnAutoCopyJson');
  if(btnCopyJson && !btnCopyJson.dataset.bound){
    btnCopyJson.dataset.bound='1';
    btnCopyJson.addEventListener('click', ()=>copyText(el('autoJson')?.textContent || ''));
  }

  // any changes should re-render inspector
  const watchIds = [
    'autoEnabled','autoCatchEnabled','autoCatchText','globalPrefix','globalKeywords',
    'globalAllowDM','globalAllowGroups','globalBlockMedia','globalRateEnabled','globalRateMaxPerMinute',
    'globalQuietEnabled','globalQuietStart','globalQuietEnd','globalQuietTz',
    'overrideEnabled','overridePrefix','overrideKeywords','overrideAllowDM','overrideAllowGroups','overrideBlockMedia',
    'overrideRateEnabled','overrideRateMaxPerMinute','overrideQuietEnabled','overrideQuietStart','overrideQuietEnd','overrideQuietTz','overrideNotes'
  ];
  for(const id of watchIds){
    const x = el(id);
    if(x && !x.dataset.bound){
      x.dataset.bound='1';
      x.addEventListener('input', renderAutomationInspector);
      x.addEventListener('change', renderAutomationInspector);
    }
  }

  toggleKeywordRows('global');
  toggleKeywordRows('override');
  renderAutoChatList();
  renderTemplates();
  renderAutomationInspector();
  syncOverrideUi();
}

function normalizeAutoCfg(raw){
  const cfg = raw?.config || raw?.automations || raw?.global || raw || {};
  cfg.defaults = cfg.defaults || {};
  cfg.defaults.safety = cfg.defaults.safety || {};
  cfg.defaults.rateLimit = cfg.defaults.rateLimit || {};
  cfg.defaults.quietHours = cfg.defaults.quietHours || {};
  cfg.defaults.templates = cfg.defaults.templates || {};
  cfg.perChat = cfg.perChat || cfg.overrides || {}; // accept old name but we will WRITE perChat
  cfg.catch = cfg.catch || { enabled:false, text:'' };

  // Back-compat: if older data uses defaults.prefix
  if(!cfg.defaults.groupPrefix && cfg.defaults.prefix) cfg.defaults.groupPrefix = cfg.defaults.prefix;
  // If older data uses defaults.group
  if(!cfg.defaults.groupMode && cfg.defaults.group) cfg.defaults.groupMode = cfg.defaults.group;
  // dmEnabled default
  if(typeof cfg.defaults.dmEnabled !== 'boolean') cfg.defaults.dmEnabled = true;

  return cfg;
}


function copyText(text){
  const t = String(text||'').trim();
  if(!t) return setStatus('Nothing to copy', false);
  navigator.clipboard?.writeText(t).then(()=>setStatus('Copied', true)).catch(()=>setStatus('Copy failed', false));
}

function readRadio(name, fallback){
  const el = document.querySelector(`input[name="${name}"]:checked`);
  return el ? el.value : fallback;
}
function setRadio(name, value){
  const els = document.querySelectorAll(`input[name="${name}"]`);
  for(const r of els){
    r.checked = (r.value === value);
  }
}

function getOverrideMode(){
  return readRadio('overrideMode','inherit');
}

function toggleKeywordRows(which){
  if(which === 'global'){
    const mode = readRadio('groupModeDefault','prefix');
    el('globalPrefixRow')?.classList.toggle('hidden', !(mode==='prefix' || mode==='all'));
    el('globalKeywordsRow')?.classList.toggle('hidden', !(mode==='keywords' || mode==='all'));
  } else {
    const mode = readRadio('groupModeOverride','prefix');
    el('overridePrefixRow')?.classList.toggle('hidden', !(mode==='prefix' || mode==='all'));
    el('overrideKeywordsRow')?.classList.toggle('hidden', !(mode==='keywords' || mode==='all'));
  }
  renderAutomationInspector();
}

function normalizeKeywords(text){
  return String(text||'')
    .split(/\n/g)
    .map(x=>x.trim())
    .filter(Boolean)
    .slice(0, 50);
}

function readGlobalForm(){
  const dmMode = readRadio('dmMode','on');             // on/off
  const groupMode = readRadio('groupModeDefault','prefix'); // off/prefix/keywords/all

  return {
    enabled: Boolean(el('autoEnabled')?.checked),

    // Keep read-only; server may ignore changes to webhookUrl anyway
    webhookUrl: String(el('autoWebhookUrl')?.value || '').trim(),

    catch: {
      enabled: Boolean(el('autoCatchEnabled')?.checked),
      text: String(el('autoCatchText')?.value || '').trim()
    },

    defaults: {
      enabled: true,
      dmEnabled: (dmMode === 'on'),

      groupMode: groupMode,
      groupPrefix: String(el('globalPrefix')?.value || '!bot').trim(),
      keywords: normalizeKeywords(el('globalKeywords')?.value || ''),

      safety: {
        allowDM: Boolean(el('globalAllowDM')?.checked),
        allowGroups: Boolean(el('globalAllowGroups')?.checked),
        blockMedia: Boolean(el('globalBlockMedia')?.checked)
      },

      rateLimit: {
        enabled: Boolean(el('globalRateEnabled')?.checked),
        maxPerMinute: Number(el('globalRateMaxPerMinute')?.value || 0) || 0
      },

      quietHours: {
        enabled: Boolean(el('globalQuietEnabled')?.checked),
        start: String(el('globalQuietStart')?.value || ''),
        end: String(el('globalQuietEnd')?.value || ''),
        tz: String(el('globalQuietTz')?.value || 'Africa/Johannesburg')
      },

      templates: autoState?.global?.defaults?.templates || {} // keep templates if present
    }
  };
}


function applyGlobalToForm(gRaw){
  const g = normalizeAutoCfg(gRaw);
  autoState.global = g;

  if(el('autoEnabled')) el('autoEnabled').checked = Boolean(g.enabled);
  if(el('autoWebhookUrl')) el('autoWebhookUrl').value = g.webhookUrl || '';
  if(el('autoCatchEnabled')) el('autoCatchEnabled').checked = Boolean(g.catch?.enabled);
  if(el('autoCatchText')) el('autoCatchText').value = g.catch?.text || '';

  // DM
  setRadio('dmMode', g.defaults?.dmEnabled === false ? 'off' : 'on');

  // Groups
  setRadio('groupModeDefault', g.defaults?.groupMode || 'prefix');

  if(el('globalPrefix')) el('globalPrefix').value = g.defaults?.groupPrefix || '!bot';
  if(el('globalKeywords')) el('globalKeywords').value = (g.defaults?.keywords || []).join('\n');

  // Safety
  if(el('globalAllowDM')) el('globalAllowDM').checked = g.defaults?.safety?.allowDM !== false;
  if(el('globalAllowGroups')) el('globalAllowGroups').checked = g.defaults?.safety?.allowGroups !== false;
  if(el('globalBlockMedia')) el('globalBlockMedia').checked = g.defaults?.safety?.blockMedia !== false;

  // Rate limit
  if(el('globalRateEnabled')) el('globalRateEnabled').checked = g.defaults?.rateLimit?.enabled !== false;
  if(el('globalRateMaxPerMinute')) el('globalRateMaxPerMinute').value = String(g.defaults?.rateLimit?.maxPerMinute ?? 12);

  // Quiet hours
  if(el('globalQuietEnabled')) el('globalQuietEnabled').checked = Boolean(g.defaults?.quietHours?.enabled);
  if(el('globalQuietStart')) el('globalQuietStart').value = g.defaults?.quietHours?.start || '20:00';
  if(el('globalQuietEnd')) el('globalQuietEnd').value = g.defaults?.quietHours?.end || '06:00';
  if(el('globalQuietTz')) el('globalQuietTz').value = g.defaults?.quietHours?.tz || 'Africa/Johannesburg';

  toggleKeywordRows('global');
}


function readOverrideForm(){
  return {
    enabled: Boolean(el('overrideEnabled')?.checked),

    groupMode: readRadio('groupModeOverride','prefix'),
    groupPrefix: String(el('overridePrefix')?.value || '!bot').trim(),
    keywords: normalizeKeywords(el('overrideKeywords')?.value || ''),

    safety: {
      allowDM: Boolean(el('overrideAllowDM')?.checked),
      allowGroups: Boolean(el('overrideAllowGroups')?.checked),
      blockMedia: Boolean(el('overrideBlockMedia')?.checked)
    },

    rateLimit: {
      enabled: Boolean(el('overrideRateEnabled')?.checked),
      maxPerMinute: Number(el('overrideRateMaxPerMinute')?.value || 0) || 0
    },

    quietHours: {
      enabled: Boolean(el('overrideQuietEnabled')?.checked),
      start: String(el('overrideQuietStart')?.value || ''),
      end: String(el('overrideQuietEnd')?.value || ''),
      tz: String(el('overrideQuietTz')?.value || 'Africa/Johannesburg')
    },

    templates: autoState.templates || {},
    notes: String(el('overrideNotes')?.value || '').trim()
  };
}


function applyOverrideToForm(oRaw){
  const o = oRaw || null;

  if(!o){
    // reset to defaults
    if(el('overrideEnabled')) el('overrideEnabled').checked = true;
    setRadio('groupModeOverride','prefix');
    if(el('overridePrefix')) el('overridePrefix').value = el('globalPrefix')?.value || '!bot';
    if(el('overrideKeywords')) el('overrideKeywords').value = '';
    if(el('overrideAllowDM')) el('overrideAllowDM').checked = true;
    if(el('overrideAllowGroups')) el('overrideAllowGroups').checked = true;
    if(el('overrideBlockMedia')) el('overrideBlockMedia').checked = true;
    if(el('overrideRateEnabled')) el('overrideRateEnabled').checked = true;
    if(el('overrideRateMaxPerMinute')) el('overrideRateMaxPerMinute').value = '12';
    if(el('overrideQuietEnabled')) el('overrideQuietEnabled').checked = false;
    if(el('overrideQuietStart')) el('overrideQuietStart').value = '20:00';
    if(el('overrideQuietEnd')) el('overrideQuietEnd').value = '06:00';
    if(el('overrideQuietTz')) el('overrideQuietTz').value = 'Africa/Johannesburg';
    if(el('overrideNotes')) el('overrideNotes').value = '';
    autoState.templates = {};
    renderTemplates();
    toggleKeywordRows('override');
    return;
  }

  if(el('overrideEnabled')) el('overrideEnabled').checked = o.enabled !== false;
  setRadio('groupModeOverride', o.groupMode || 'prefix');

  if(el('overridePrefix')) el('overridePrefix').value = o.groupPrefix || '!bot';
  if(el('overrideKeywords')) el('overrideKeywords').value = (o.keywords || []).join('\n');

  if(el('overrideAllowDM')) el('overrideAllowDM').checked = o.safety?.allowDM !== false;
  if(el('overrideAllowGroups')) el('overrideAllowGroups').checked = o.safety?.allowGroups !== false;
  if(el('overrideBlockMedia')) el('overrideBlockMedia').checked = o.safety?.blockMedia !== false;

  if(el('overrideRateEnabled')) el('overrideRateEnabled').checked = o.rateLimit?.enabled !== false;
  if(el('overrideRateMaxPerMinute')) el('overrideRateMaxPerMinute').value = String(o.rateLimit?.maxPerMinute ?? 12);

  if(el('overrideQuietEnabled')) el('overrideQuietEnabled').checked = Boolean(o.quietHours?.enabled);
  if(el('overrideQuietStart')) el('overrideQuietStart').value = o.quietHours?.start || '20:00';
  if(el('overrideQuietEnd')) el('overrideQuietEnd').value = o.quietHours?.end || '06:00';
  if(el('overrideQuietTz')) el('overrideQuietTz').value = o.quietHours?.tz || 'Africa/Johannesburg';

  if(el('overrideNotes')) el('overrideNotes').value = o.notes || '';

  autoState.templates = o.templates || {};
  renderTemplates();
  toggleKeywordRows('override');
}


function renderTemplates(){
  const box = el('tplList');
  if(!box) return;
  box.innerHTML = '';
  const entries = Object.entries(autoState.templates || {});
  if(!entries.length){
    const d=document.createElement('div');
    d.className='small';
    d.style.opacity='.8';
    d.textContent='No templates set';
    box.appendChild(d);
    return;
  }
  for(const [k,v] of entries){
    const row=document.createElement('div');
    row.className='listItem';
    row.style.cursor='default';
    row.innerHTML = `<div class="grow3"><div class="liMain">${esc(k)}</div><div class="liSub">${esc(String(v).slice(0,160))}</div></div>`;
    const btn=document.createElement('button');
    btn.type='button';
    btn.className='btnDanger';
    btn.textContent='Remove';
    btn.addEventListener('click', ()=>{
      delete autoState.templates[k];
      renderTemplates();
      renderAutomationInspector();
    });
    row.appendChild(btn);
    box.appendChild(row);
  }
}

function addTemplateFromInputs(){
  const k = String(el('tplKey')?.value||'').trim();
  const v = String(el('tplVal')?.value||'').trim();
  if(!k || !v) return setStatus('Template key and value required', false);
  autoState.templates = autoState.templates || {};
  autoState.templates[k] = v;
  if(el('tplKey')) el('tplKey').value='';
  if(el('tplVal')) el('tplVal').value='';
  renderTemplates();
  renderAutomationInspector();
}

function renderAutoChatList(){
  const listEl = el('autoChatList');
  if(!listEl) return;

  const q = String(el('autoChatSearch')?.value||'').toLowerCase().trim();
  const list = (chatsAll||[]).slice()
    .sort((a,b)=>(b.lastTs||0)-(a.lastTs||0))
    .filter(c=>{
      const name = displayNameForJid(c.chatJid);
      const hay = (String(name||'')+' '+String(c.chatJid||'')+' '+String(c.lastText||'')).toLowerCase();
      return !q || hay.includes(q);
    })
    .slice(0, 150);

  listEl.innerHTML = '';
  for(const c of list){
    const jid = c.chatJid;
    const name = displayNameForJid(c.chatJid) || c.name || c.title || c.chatJid;
    const isSel = jid === autoState.selectedJid;

    const row = document.createElement('div');
    row.className = 'listItem' + (isSel ? ' active' : '');
    row.addEventListener('click', ()=>selectAutoChat(jid, c.isGroup));

    const left = document.createElement('div');
    left.className = 'grow3';
    left.innerHTML = `<div class="liMain">${c.isGroup ? '👥' : '👤'} ${esc(name || jid)}</div><div class="liSub">${esc(jid)}</div>`;
    row.appendChild(left);

    const state = document.createElement('span');
    const hasOverride = Boolean(autoState.overrides && autoState.overrides[jid]);
    state.className = 'badge ' + (hasOverride ? 'type' : 'queued');
    state.textContent = hasOverride ? 'override' : 'global';
    row.appendChild(state);

    listEl.appendChild(row);
  }

  updateOverrideButtons();
}

function selectAutoChat(jid, isGroup){
  autoState.selectedJid = jid;

  const name = displayNameForJid(jid) || jid;
  if(el('autoSelTitle')) el('autoSelTitle').textContent = name;
  if(el('autoSelJid')) el('autoSelJid').textContent = jid;
  if(el('autoSelState')){
    const has = Boolean(autoState.overrides && autoState.overrides[jid]);
    el('autoSelState').className = 'badge ' + (has ? 'type' : 'queued');
    el('autoSelState').textContent = has ? 'Override' : 'Global';
  }

  // Load override into editor
  const ov = (autoState.overrides||{})[jid] || null;
  if(ov){
    setRadio('overrideMode','custom');
    applyOverrideToForm(ov);
  } else {
    setRadio('overrideMode','inherit');
    applyOverrideToForm(null); // fills defaults
  }

  renderAutoChatList();
  renderAutomationInspector();
  updateOverrideButtons();
  updateEffectivePreview();
  syncOverrideUi();
}

function updateOverrideButtons(){
  const jid = autoState.selectedJid;
  const hasSel = Boolean(jid);
  const mode = getOverrideMode();
  const hasOverride = Boolean(jid && autoState.overrides && autoState.overrides[jid]);

  const btnSave = el('btnAutoSaveOverride');
  const btnReset = el('btnAutoResetOverride');

  // Reset is allowed when selected
  if(btnReset) btnReset.disabled = !hasSel;

  // Save should be enabled if:
  // - selected AND (custom mode) OR (inherit mode but there IS an override to remove)
  if(btnSave){
    btnSave.disabled = !hasSel || (mode === 'inherit' && !hasOverride);

    // Improve label so it's obvious what it will do
    if(mode === 'inherit'){
      btnSave.textContent = hasOverride ? 'Use global (remove override)' : 'Save override';
    } else {
      btnSave.textContent = 'Save override';
    }
  }
}


function syncOverrideUi(){
  const fields = el('overrideFields');
  if(!fields) return;

  const isCustom = getOverrideMode() === 'custom';

  // Always show the override block so the admin can see options
  fields.classList.remove('hidden');

  // Enable/disable everything inside overrideFields
  const nodes = fields.querySelectorAll('input, textarea, select, button');
  nodes.forEach(n => { n.disabled = !isCustom; });

  // Keep keyword rows correct
  toggleKeywordRows('override');

  // Buttons + preview + inspector
  updateOverrideButtons();
  renderAutomationInspector();
  updateEffectivePreview?.();
}



function renderAutomationInspector(){
  const box = el('autoJson');
  if(!box) return;

  const global = readGlobalForm();
  let effective = { ...global };

  const jid = autoState.selectedJid;
  const mode = getOverrideMode();

  if(jid && mode === 'custom'){
    const ov = readOverrideForm();
    effective = {
      ...global,
      overrideFor: jid,
      override: ov
    };
  } else if(jid) {
    effective = { ...global, overrideFor: jid, override: null };
  }

  box.textContent = JSON.stringify(effective, null, 2);
}

async function loadAutomations(){
  const j = await api('/admin/automations');
  const global = j.automations || j.global || j.config || j;
  autoState.global = global;

  // webhook
  const url = global.webhookUrl || global.webhook || '';
  if(el('autoWebhookUrl')) el('autoWebhookUrl').value = url;

  // ✅ overrides
  autoState.overrides = global.perChat || {};

  applyGlobalToForm(global);
  renderAutoChatList();
  renderAutomationInspector();
  updateEffectivePreview();
  setStatus('Automations loaded', true);
}

function syncOverrideUi(){
  const custom = getOverrideMode() === 'custom';

  const fields = el('overrideFields');
  if(!fields) return;

  // Always show the block
  fields.classList.remove('hidden');

  // Disable/enable all inputs inside it
  const inputs = fields.querySelectorAll('input, textarea, select, button');
  for(const inp of inputs){
    // Keep template list "Remove" buttons disabled as well unless custom
    inp.disabled = !custom;
  }

  // But allow reading scroll etc. We’ll also keep keyword rows in sync.
  toggleKeywordRows('override');

  // Update inspector + preview
  renderAutomationInspector();
  updateOverrideButtons();
  updateEffectivePreview();
}


function updateEffectivePreview(){
  const decisionEl = el('autoPreviewDecision');
  const badgeEl = el('autoPreviewBadge');
  const reasonEl = el('autoPreviewReason');
  const effEl = el('autoPreviewEffective'); // optional if you added it

  if(!decisionEl || !badgeEl || !reasonEl) return;

  const jid = autoState.selectedJid;
  if(!jid){
    decisionEl.textContent = 'No selection';
    badgeEl.className = 'badge type';
    badgeEl.textContent = '—';
    reasonEl.textContent = 'Select a chat/group to see the effective forwarding rule.';
    if(effEl) effEl.textContent = '';
    return;
  }

  const isGroup = jid.endsWith('@g.us');
  const sample = String(el('autoPreviewSample')?.value || '!bot help').trim();

  // Build effective rule (global + override if exists and custom)
  const global = normalizeAutoCfg(autoState.global || {});
  const ov = (autoState.overrides || {})[jid] || null;

  // If override mode is inherit, treat as no override
  const mode = getOverrideMode();
  const useOverride = (mode === 'custom') ? (readOverrideForm()) : null;

  const eff = {
    enabled: global.enabled !== false,
    dmEnabled: global.defaults?.dmEnabled !== false,
    groupMode: global.defaults?.groupMode || 'prefix',
    groupPrefix: global.defaults?.groupPrefix || '!bot',
    keywords: global.defaults?.keywords || [],
    safety: global.defaults?.safety || {}
  };

  // merge override if custom mode
  if(useOverride){
    if(typeof useOverride.enabled !== 'undefined') eff.enabled = useOverride.enabled !== false;
    if(useOverride.groupMode) eff.groupMode = useOverride.groupMode;
    if(useOverride.groupPrefix) eff.groupPrefix = useOverride.groupPrefix;
    if(Array.isArray(useOverride.keywords)) eff.keywords = useOverride.keywords;
    if(useOverride.safety) eff.safety = { ...eff.safety, ...useOverride.safety };
  } else if(ov) {
    // if there is an override saved but user is currently in inherit mode,
    // show that it exists so it's obvious why it may behave differently
  }

  // Decision logic (simple + aligned with your new “prefix required for all” direction)
  if(!eff.enabled || global.enabled === false){
    decisionEl.textContent = 'Forward to n8n: NO';
    badgeEl.className = 'badge failed';
    badgeEl.textContent = 'NO';
    reasonEl.textContent = 'Automations are disabled globally or for this chat.';
    if(effEl) effEl.textContent = '';
    return;
  }

  // Safety gates
  if(!isGroup && eff.safety?.allowDM === false){
    decisionEl.textContent = 'Forward to n8n: NO';
    badgeEl.className = 'badge failed';
    badgeEl.textContent = 'NO';
    reasonEl.textContent = 'Blocked by safety: Allow DMs is OFF.';
    return;
  }
  if(isGroup && eff.safety?.allowGroups === false){
    decisionEl.textContent = 'Forward to n8n: NO';
    badgeEl.className = 'badge failed';
    badgeEl.textContent = 'NO';
    reasonEl.textContent = 'Blocked by safety: Allow groups is OFF.';
    return;
  }

  // Prefix gating for both DM & groups (your “standard experience” rule)
  const prefix = String(eff.groupPrefix || '!bot').trim();
  const startsWith = sample.toLowerCase().startsWith(prefix.toLowerCase());

  if(!startsWith){
    decisionEl.textContent = 'Forward to n8n: NO';
    badgeEl.className = 'badge failed';
    badgeEl.textContent = 'NO';
    reasonEl.textContent = `Prefix required. Sample does not start with "${prefix}".`;
    if(effEl) effEl.textContent = `Effective: prefix="${prefix}", groupMode="${eff.groupMode}"`;
    return;
  }

  // If groupMode is off and it's a group, block
  if(isGroup && eff.groupMode === 'off'){
    decisionEl.textContent = 'Forward to n8n: NO';
    badgeEl.className = 'badge failed';
    badgeEl.textContent = 'NO';
    reasonEl.textContent = 'This group override mode is OFF.';
    return;
  }

  decisionEl.textContent = 'Forward to n8n: YES';
  badgeEl.className = 'badge sent';
  badgeEl.textContent = 'YES';

  // keyword extraction
  const rest = sample.slice(prefix.length).trim();
  const kw = rest ? rest.split(/\s+/)[0] : '';
  reasonEl.textContent = `Prefix matched. Keyword: ${kw ? `"${kw}"` : '(none)'}`;

  if(effEl) effEl.textContent = `Effective: prefix="${prefix}", groupMode="${eff.groupMode}"`;
}


async function saveGlobalAutomations(){
  const selected = autoState.selectedJid;
  const mode = getOverrideMode();

  const g = readGlobalForm();
  await api('/admin/automations', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify(g)
  });

  setStatus('Saved global automations', true);
  await loadAutomations();

  if(selected){
    selectAutoChat(selected, selected.endsWith('@g.us'));
    // restore mode if needed
    setRadio('overrideMode', mode || 'inherit');
  }
}



async function saveSelectedOverride(){
  if(!autoState.selectedJid) throw new Error('Select a chat/group first');

  const jid = autoState.selectedJid;
  const mode = getOverrideMode();

 if(mode === 'inherit'){
    // Delete override on server
    try{
      await api('/admin/automations/chat/'+encodeURIComponent(jid), { method:'DELETE' });
    }catch(_){
      await api('/admin/automations/chat/'+encodeURIComponent(jid), {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ inherit: true })
      });
    }

    // Clear local cached override immediately so UI doesn't snap back
    if(autoState.overrides) delete autoState.overrides[jid];
    autoState.templates = {};
    renderTemplates();

    setStatus('Now using global defaults (override removed)', true);

    // Reload state from server so we're in sync
    await loadAutomations();

    // Ensure we stay in inherit mode visually
    setRadio('overrideMode','inherit');
    syncOverrideUi?.();           // if you added it
    applyOverrideToForm(null);    // show defaults in the editor
    renderAutoChatList();

    // Re-select chat with no override present
    selectAutoChat(jid, jid.endsWith('@g.us'));

    updateOverrideButtons();
    updateEffectivePreview?.();

    return;
  } else {
    const ov = readOverrideForm();
    await api('/admin/automations/chat/'+encodeURIComponent(jid), {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify(ov)
    });
    setStatus('Override saved', true);
  }

  await loadAutomations();
  selectAutoChat(jid, jid.endsWith('@g.us'));
}

function toggleKeywordRows(which){
  if(which === 'global'){
    const mode = readRadio('groupModeDefault','prefix');
    el('globalPrefixRow')?.classList.toggle('hidden', mode!=='prefix');
    el('globalKeywordsRow')?.classList.toggle('hidden', mode!=='keywords');
  } else {
    const mode = readRadio('groupModeOverride','prefix');
    el('overridePrefixRow')?.classList.toggle('hidden', mode!=='prefix');
    el('overrideKeywordsRow')?.classList.toggle('hidden', mode!=='keywords');
  }
  renderAutomationInspector();
}

async function resetSelectedOverride(){
  if(!autoState.selectedJid) throw new Error('Select a chat/group first');
  const jid = autoState.selectedJid;

  try{
    await api('/admin/automations/chat/'+encodeURIComponent(jid), { method:'DELETE' });
  }catch(_){
    await api('/admin/automations/chat/'+encodeURIComponent(jid), {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ inherit: true })
    });
  }
  setStatus('Override reset', true);
  await loadAutomations();
  selectAutoChat(jid, jid.endsWith('@g.us'));
}
