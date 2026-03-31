let targetsAll = [];
let chatsAll = [];
let activeChatJid = '';
let lastSeenTs = 0;
let pollTimer = null;
let msgFilter = 'all';
let chatMessages = [];
let replyHandlersBound = false;
let selectedQuotedMessageId = '';
let pairingEventSource = null;


// Friendly display maps (filled by /admin/targets)
const contactNameByJid = new Map();
const contactNameByMsisdn = new Map();
const groupAliasByJid = new Map();
const waGroupNameByJid = new Map();

// Target selection
const selectedTargets = new Set();
let waGroupsManager = [];
let selectedWaGroupJid = '';
let rulesState = {
  enabled: false,
  rules: [],
  selectedId: ''
};


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
  const tPairing = document.getElementById('tabPairing');
  if(tPairing) tPairing.classList.toggle('active', which==='pairing');
  const tSchedule = document.getElementById('tabSchedule');
  if(tSchedule) tSchedule.classList.toggle('active', which==='schedule');
  const tOps = document.getElementById('tabOps');
  if(tOps) tOps.classList.toggle('active', which==='ops');
  document.getElementById('tabContacts').classList.toggle('active', which==='contacts');
  const tGroups = document.getElementById('tabGroups');
  if(tGroups) tGroups.classList.toggle('active', which==='groups');
  const tRules = document.getElementById('tabRules');
  if(tRules) tRules.classList.toggle('active', which==='rules');
  const tAuto = document.getElementById('tabAutomations');
  if(tAuto) tAuto.classList.toggle('active', which==='automations');

  document.getElementById('panelMessages').classList.toggle('hidden', which!=='messages');
  document.getElementById('panelSend').classList.toggle('hidden', which!=='send');
  const pPairing = document.getElementById('panelPairing');
  if(pPairing) pPairing.classList.toggle('hidden', which!=='pairing');
  const pSchedule = document.getElementById('panelSchedule');
  if(pSchedule) pSchedule.classList.toggle('hidden', which!=='schedule');
  const pOps = document.getElementById('panelOps');
  if(pOps) pOps.classList.toggle('hidden', which!=='ops');
  document.getElementById('panelContacts').classList.toggle('hidden', which!=='contacts');
  const pGroups = document.getElementById('panelGroups');
  if(pGroups) pGroups.classList.toggle('hidden', which!=='groups');
  const pRules = document.getElementById('panelRules');
  if(pRules) pRules.classList.toggle('hidden', which!=='rules');
  const pAuto = document.getElementById('panelAutomations');
  if(pAuto) pAuto.classList.toggle('hidden', which!=='automations');

  if(which === 'schedule') loadSchedules().catch(()=>{});
  if(which === 'pairing') {
    connectPairingStream();
    refreshPairingQr();
  }
  if(which === 'ops') {
    loadOps().catch(()=>{});
    loadN8nDeadLetters().catch(()=>{});
  }
}

async function api(path, opts={}){
  const key=getKey();
  const headers = Object.assign({}, opts.headers||{});
  if(key) headers['x-admin-key'] = key;
  const res = await fetch(path, Object.assign({}, opts, { headers }));
  const text = await res.text();
  let json=null; try{ json=JSON.parse(text) }catch{}
  if(!res.ok){
    if(res.status === 401){
      window.location.href = '/admin/login';
      throw new Error('Unauthorized');
    }
    const msg = (json && (json.error||json.message)) ? (json.error||json.message) : text;
    throw new Error('HTTP '+res.status+' '+res.statusText+': '+(msg||'(empty)'));
  }
  return json ?? {};
}

async function logoutAdmin(){
  try{
    await fetch('/admin/logout', { method:'POST' });
  }catch{}
  window.location.href = '/admin/login';
}

function boot(){
  const k=localStorage.getItem('WA_ADMIN_KEY');
  if(k && !getKey()) document.getElementById('adminKey').value = k;

  setPill('connecting…','neutral');
  const tasks=[loadTargets(), loadChats(), loadCrud(), loadWaGroupsManager(), loadRules(), loadSchedules(), loadOps(), loadN8nDeadLetters()];
  if(typeof loadAutomations==='function') tasks.push(loadAutomations());
  Promise.all(tasks)
    .then(()=>{ renderSendForm(); restartPolling(); bindRulesUi(); bindAutomationsUi(); updateSendQuoteHint(); connectPairingStream(); refreshPairingQr(); setStatus('Connected', true); })
    .catch(e=>setStatus(e.message,false));
}
boot();

async function forceRelink(){
  try{
    await api('/admin/force-relink', { method:'POST' });
    setStatus('Relink requested. Waiting for new QR…', true);
    refreshPairingQr();
  }catch(e){
    setStatus(e.message, false);
  }
}

function setPairingText(status, hasQR){
  const el = document.getElementById('pairingStatusText');
  const hint = document.getElementById('pairingQrHint');
  if(el) el.textContent = `Status: ${status || 'unknown'}${hasQR ? ' • QR available' : ''}`;
  if(hint) hint.textContent = hasQR ? 'Scan the QR with your WhatsApp app.' : 'QR will appear when pairing is required.';
}

function refreshPairingQr(){
  const img = document.getElementById('pairingQrImage');
  if(!img) return;
  img.src = '/pairing/qr.png?t=' + Date.now();
  img.onerror = () => {
    img.removeAttribute('src');
  };
}

function connectPairingStream(){
  if(pairingEventSource) return;
  try{
    const es = new EventSource('/pairing/stream');
    pairingEventSource = es;

    es.addEventListener('status', (ev)=>{
      try{
        const data = JSON.parse(ev.data || '{}');
        setPairingText(data.status || 'unknown', Boolean(data.hasQR));
        if(data.hasQR) refreshPairingQr();
      }catch{}
    });

    es.addEventListener('qr', ()=>{
      setPairingText('pairing', true);
      refreshPairingQr();
    });

    es.onerror = ()=>{
      setPairingText('stream disconnected', false);
      try{ es.close(); }catch{}
      pairingEventSource = null;
      setTimeout(()=>connectPairingStream(), 2500);
    };
  }catch{
    pairingEventSource = null;
  }
}

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
  selectedQuotedMessageId = '';

  const log = document.getElementById('chatLog');
  if(log) log.innerHTML = '';

  const nice = activeChatJid ? displayNameForJid(activeChatJid) : '';
  document.getElementById('chatMeta').textContent = activeChatJid ? (` • ${nice}${nice && nice!==activeChatJid ? ' ('+activeChatJid+')' : ''}`) : '';

  // Reply hints
  updateReplyHint();

  // Ensure filter buttons are consistent
  setMsgFilter(msgFilter);

  bindReplyHandlersOnce();

  if(activeChatJid) pollOnce(true);
}
function clearReplyMedia(){
  const f=document.getElementById('replyFile'); if(f) f.value='';
  const c=document.getElementById('replyCaption'); if(c) c.value='';
}

function clearSelectedQuote(){
  selectedQuotedMessageId = '';
  updateReplyHint();
  updateSendQuoteHint();
}

function setSelectedQuote(messageId){
  const msg = findMessageInActiveChat(messageId);
  if(!msg || msg.direction !== 'in' || !msg.id){
    setStatus('Only incoming messages can be quoted right now', false);
    return;
  }
  selectedQuotedMessageId = msg.id;
  updateReplyHint();
  updateSendQuoteHint();
}

function updateSendQuoteHint(){
  const hint = document.getElementById('sendQuoteHint');
  if(!hint) return;

  const enabled = Boolean(document.getElementById('sendUseSelectedQuote')?.checked);
  const selected = selectedQuotedMessageId ? findMessageInActiveChat(selectedQuotedMessageId) : null;

  if(!enabled){
    hint.textContent = selected ? `Selected quote ready: ${selected.text || selected.type || 'Message'}` : 'No selected quote';
    return;
  }

  if(!selected){
    hint.textContent = 'Quote enabled, but no selected incoming message. Go to Messages tab and click Quote.';
    return;
  }

  hint.textContent = `Quote enabled: ${selected.text || selected.type || 'Message'} (single target only)`;
}

function getLatestInboundMessageForActiveChat(){
  for(let i = chatMessages.length - 1; i >= 0; i--){
    const msg = chatMessages[i];
    if(msg && msg.direction === 'in' && msg.id) return msg;
  }
  return null;
}

function updateReplyHint(){
  const hint = document.getElementById('replyToHint');
  const previewRow = document.getElementById('replyQuotePreviewRow');
  const preview = document.getElementById('replyQuotePreview');
  if(!hint) return;

  if(!activeChatJid){
    hint.textContent = 'No chat selected';
    if(previewRow) previewRow.classList.add('hidden');
    return;
  }

  const nice = displayNameForJid(activeChatJid) || activeChatJid;
  const quoteEnabled = Boolean(document.getElementById('replyQuoteLatest')?.checked);
  const latestInbound = getLatestInboundMessageForActiveChat();
  let selectedQuote = selectedQuotedMessageId ? findMessageInActiveChat(selectedQuotedMessageId) : null;

  if(selectedQuotedMessageId && !selectedQuote){
    selectedQuotedMessageId = '';
    selectedQuote = null;
  }

  if(selectedQuote){
    const who = displayNameForJid(selectedQuote.senderJid || selectedQuote.chatJid) || 'contact';
    hint.textContent = `Replying to: ${nice} • quoting selected message from ${who}`;
    if(previewRow) previewRow.classList.remove('hidden');
    if(preview) preview.textContent = `Selected quote: ${selectedQuote.text || selectedQuote.type || 'Message'}`;
    return;
  }

  if(quoteEnabled && latestInbound){
    const who = displayNameForJid(latestInbound.senderJid || latestInbound.chatJid) || 'contact';
    hint.textContent = `Replying to: ${nice} • quoting latest incoming from ${who}`;
    if(previewRow) previewRow.classList.remove('hidden');
    if(preview) preview.textContent = `Latest incoming: ${latestInbound.text || latestInbound.type || 'Message'}`;
    return;
  }

  hint.textContent = `Replying to: ${nice}`;
  if(previewRow) previewRow.classList.add('hidden');
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

  const quoteToggle = document.getElementById('replyQuoteLatest');
  if(quoteToggle){
    quoteToggle.addEventListener('change', updateReplyHint);
  }

  const sendQuoteToggle = document.getElementById('sendUseSelectedQuote');
  if(sendQuoteToggle){
    sendQuoteToggle.addEventListener('change', updateSendQuoteHint);
  }
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

function findMessageInActiveChat(messageId){
  const id = String(messageId || '').trim();
  if(!id) return null;
  return chatMessages.find(m => String(m.id || '') === id) || null;
}

function renderOneMessage(m){
  const log = document.getElementById('chatLog');
  if(!log) return;

  const d = new Date(m.ts).toLocaleString();
  const senderJid = m.isGroup ? (m.senderJid || '') : (m.chatJid || '');
  const sender = displayNameForJid(senderJid) || senderJid;

  const div = document.createElement('div');
  div.className = 'msg ' + (m.direction === 'out' ? 'out' : 'in');
  if(selectedQuotedMessageId && selectedQuotedMessageId === m.id){
    div.style.borderColor = 'rgba(255,208,0,.45)';
    div.style.boxShadow = '0 0 0 1px rgba(255,208,0,.18) inset';
  }

  const meta = document.createElement('div');
  meta.className = 'meta';

  const left = document.createElement('span');
  left.textContent = `${d} • ${sender}`;
  meta.appendChild(left);

  if(m.direction === 'in' && m.id){
    const quoteBtn = document.createElement('button');
    quoteBtn.type = 'button';
    quoteBtn.className = 'btnGhost';
    quoteBtn.style.marginLeft = '8px';
    quoteBtn.style.padding = '4px 8px';
    quoteBtn.style.fontSize = '12px';
    quoteBtn.textContent = (selectedQuotedMessageId && selectedQuotedMessageId === m.id) ? 'Quoted' : 'Quote';
    quoteBtn.addEventListener('click', () => setSelectedQuote(m.id));
    meta.appendChild(quoteBtn);
  }

  if(m.direction === 'out' && m.status){
    const b = document.createElement('span');
    const st = String(m.status || '').toLowerCase();
    b.className = 'badge ' + (['queued','sent','delivered','read','failed'].includes(st) ? st : 'type');
    b.style.marginLeft = '8px';
    b.textContent = st || 'status';
    meta.appendChild(b);
  }

  const body = document.createElement('div');
  body.className = 'bodyText';
  const lines = (m.text || '').replace(/\r\n?/g, '\n').split('\n');
  lines.forEach((line, i) => {
    body.appendChild(document.createTextNode(line));
    if (i < lines.length - 1) body.appendChild(document.createElement('br'));
  });

  div.appendChild(meta);

  if(m.quotedMessageId){
    const quoted = findMessageInActiveChat(m.quotedMessageId);
    const quote = document.createElement('div');
    quote.className = 'small';
    quote.style.opacity = '.8';
    quote.style.marginBottom = '6px';
    quote.textContent = quoted ? `↪ ${quoted.text || quoted.type || 'Quoted message'}` : '↪ Quoted reply';
    div.appendChild(quote);
  }

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

  updateReplyHint();
  updateSendQuoteHint();

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

function clearMessageSearch(){
  const q = document.getElementById('messageSearchQuery');
  if(q) q.value = '';
  const box = document.getElementById('messageSearchResults');
  if(box){
    box.innerHTML = '';
    box.classList.add('hidden');
  }
}

async function searchMessages(){
  try{
    const query = (document.getElementById('messageSearchQuery')?.value || '').trim();
    if(!query) throw new Error('Enter a search query');

    const params = new URLSearchParams();
    params.set('q', query);
    params.set('limit', '120');
    if(activeChatJid) params.set('chatJid', activeChatJid);

    const j = await api('/admin/messages/search?' + params.toString());
    const items = j.items || [];

    const box = document.getElementById('messageSearchResults');
    if(!box) return;
    box.classList.remove('hidden');
    box.innerHTML = '';

    if(!items.length){
      box.innerHTML = '<div class="small" style="opacity:.8">No matches</div>';
      return;
    }

    for(const m of items){
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'listRow';
      row.style.width = '100%';
      const when = new Date(m.ts || Date.now()).toLocaleString();
      const dir = (m.direction === 'out') ? '↗' : '↘';
      row.innerHTML = `<div class="grow3"><div class="liMain">${dir} ${esc(m.chatJid || '')}</div><div class="liSub">${esc((m.text || '').slice(0,140))} • ${esc(when)}</div></div>`;
      row.addEventListener('click', ()=>{
        switchMessagesToJid(m.chatJid);
        showTab('messages');
      });
      box.appendChild(row);
    }
  }catch(e){
    setStatus(e.message||String(e), false);
  }
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
  selectedQuotedMessageId = '';
  updateSendQuoteHint();
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
    const quotedMessageId = selectedQuotedMessageId || (document.getElementById('replyQuoteLatest')?.checked ? (getLatestInboundMessageForActiveChat()?.id || '') : '');

    if(!text && !file) throw new Error('Nothing to send');

    if(file){
      if((file.type||'').startsWith('image/')){
        const fd=new FormData();
        fd.append('to', activeChatJid);
        fd.append('image', file);
        if(caption) fd.append('caption', caption);
        if(quotedMessageId) fd.append('quotedMessageId', quotedMessageId);
        await api('/admin/send/image', { method:'POST', body: fd });
      }else{
        const fd=new FormData();
        fd.append('to', activeChatJid);
        fd.append('document', file);
        fd.append('fileName', file.name || 'document');
        if(file.type) fd.append('mimetype', file.type);
        if(quotedMessageId) fd.append('quotedMessageId', quotedMessageId);
        await api('/admin/send/document', { method:'POST', body: fd });
      }
      clearReplyMedia();
    }

    if(text){
      await api('/admin/send/text', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ to: activeChatJid, message: text, quotedMessageId: quotedMessageId || undefined })
      });
      document.getElementById('replyText').value = '';
    }

    setStatus('Queued to active chat', true);
    clearSelectedQuote();
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

    const useSendQuote = Boolean(document.getElementById('sendUseSelectedQuote')?.checked);
    const quotedMessageId = useSendQuote ? selectedQuotedMessageId : '';
    if(useSendQuote && !quotedMessageId){
      throw new Error('Quote enabled but no selected quote. Pick a message in Messages tab first.');
    }
    if(useSendQuote && toList.length !== 1){
      throw new Error('Quoted send from Send panel supports single target only.');
    }

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
          body:JSON.stringify({to,message,quotedMessageId: quotedMessageId || undefined})
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
        if(quotedMessageId) fd.append('quotedMessageId', quotedMessageId);
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
          body:JSON.stringify({to,imageUrl,caption,quotedMessageId: quotedMessageId || undefined})
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
        if(quotedMessageId) fd.append('quotedMessageId', quotedMessageId);
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
          body:JSON.stringify({to,documentUrl,fileName,mimetype,quotedMessageId: quotedMessageId || undefined})
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

async function loadSchedules(){
  try{
    const j = await api('/admin/schedule?limit=300');
    const list = j.schedules || [];
    const box = document.getElementById('scheduleList');
    if(!box) return;
    box.innerHTML = '';

    if(!list.length){
      box.innerHTML = '<div class="small" style="opacity:.8">No schedules yet.</div>';
      return;
    }

    for(const s of list){
      const row = document.createElement('div');
      row.className = 'listRow';
      const sendAt = new Date(Number(s.sendAt || Date.now())).toLocaleString();
      const status = String(s.status || 'pending');
      const tgt = Array.isArray(s.targets) ? s.targets.length : 0;
      const msg = String(s?.payload?.message || '').slice(0, 120);
      row.innerHTML = `<div class="grow3"><div class="liMain">${esc(status.toUpperCase())} • ${esc(sendAt)}</div><div class="liSub">Targets: ${tgt} • ${esc(msg)}</div></div>`;

      const right = document.createElement('div');
      right.className = 'row';
      if(status === 'pending' || status === 'failed'){
        const run = document.createElement('button');
        run.className = 'btnGhost';
        run.textContent = 'Run now';
        run.addEventListener('click', ()=>runScheduleNow(s.id));
        right.appendChild(run);
      }
      if(status === 'pending'){
        const cancel = document.createElement('button');
        cancel.className = 'btnDanger';
        cancel.textContent = 'Cancel';
        cancel.addEventListener('click', ()=>cancelSchedule(s.id));
        right.appendChild(cancel);
      }

      row.appendChild(right);
      box.appendChild(row);
    }
  }catch(e){
    setStatus(e.message||String(e), false);
  }
}

async function createSchedule(){
  try{
    const targetsRaw = (document.getElementById('scheduleTargets')?.value || '').trim();
    const message = (document.getElementById('scheduleMessage')?.value || '').trim();
    const sendAtLocal = (document.getElementById('scheduleSendAt')?.value || '').trim();
    if(!targetsRaw) throw new Error('Targets required');
    if(!message) throw new Error('Message required');

    const targets = targetsRaw.split(/[\n,;]+/g).map(x=>x.trim()).filter(Boolean);
    const body = { targets, payload: { type:'text', message } };
    if(sendAtLocal) body.sendAt = new Date(sendAtLocal).toISOString();

    await api('/admin/schedule', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify(body)
    });

    setStatus('Schedule created', true);
    document.getElementById('scheduleMessage').value = '';
    await loadSchedules();
    await loadOps();
  }catch(e){
    setStatus(e.message||String(e), false);
  }
}

async function runScheduleNow(id){
  try{
    await api('/admin/schedule/'+encodeURIComponent(id)+'/run-now', { method:'POST' });
    setStatus('Schedule triggered', true);
    await loadSchedules();
    await loadOps();
  }catch(e){
    setStatus(e.message||String(e), false);
  }
}

async function cancelSchedule(id){
  try{
    await api('/admin/schedule/'+encodeURIComponent(id), { method:'DELETE' });
    setStatus('Schedule cancelled', true);
    await loadSchedules();
    await loadOps();
  }catch(e){
    setStatus(e.message||String(e), false);
  }
}

async function loadOps(){
  try{
    const j = await api('/admin/connection');
    const box = document.getElementById('opsConnectionBox');
    if(box) box.textContent = JSON.stringify(j, null, 2);
  }catch(e){
    setStatus(e.message||String(e), false);
  }
}

async function forceLogoutNow(){
  try{
    await api('/admin/force-logout', { method:'POST' });
    setStatus('Logout requested', true);
    await loadOps();
  }catch(e){
    setStatus(e.message||String(e), false);
  }
}

async function refreshGroupCacheNow(){
  try{
    await api('/admin/group-cache/refresh', { method:'POST' });
    setStatus('Group cache refreshed', true);
    await loadTargets();
    await loadWaGroupsManager();
    await loadOps();
  }catch(e){
    setStatus(e.message||String(e), false);
  }
}

async function sendN8nTest(){
  try{
    const text = (document.getElementById('opsN8nTestText')?.value || '').trim();
    await api('/admin/automations/test', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ text })
    });
    setStatus('n8n test sent', true);
    await loadN8nDeadLetters();
  }catch(e){
    setStatus(e.message||String(e), false);
  }
}

async function loadN8nDeadLetters(){
  try{
    const j = await api('/admin/n8n/dead-letters?limit=100');
    const box = document.getElementById('opsDeadLetters');
    if(!box) return;
    box.innerHTML = '';

    const items = j.items || [];
    if(!items.length){
      box.innerHTML = '<div class="small" style="opacity:.8">No dead letters.</div>';
      return;
    }

    for(const it of items){
      const row = document.createElement('div');
      row.className = 'listRow';
      const when = new Date(it.ts || Date.now()).toLocaleString();
      row.innerHTML = `<div class="grow3"><div class="liMain">${esc(when)} • ${esc(it.chatJid || '(no chat)')}</div><div class="liSub">${esc(String(it.error || '').slice(0,220))}</div></div>`;
      const del = document.createElement('button');
      del.className = 'btnDanger';
      del.textContent = 'Clear';
      del.addEventListener('click', async ()=>{
        try{
          await api('/admin/n8n/dead-letters/'+encodeURIComponent(it.id), { method:'DELETE' });
          await loadN8nDeadLetters();
        }catch(e){
          setStatus(e.message||String(e), false);
        }
      });
      row.appendChild(del);
      box.appendChild(row);
    }
  }catch(e){
    setStatus(e.message||String(e), false);
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
 * ---------- WhatsApp Groups Management ----------
 */
function parseParticipantTokens(raw){
  return String(raw || '')
    .split(/[\n,;]+/g)
    .map(s=>s.trim())
    .filter(Boolean);
}

function getSelectedWaGroup(){
  const pick = document.getElementById('gmGroupPick');
  if(!pick) return '';
  selectedWaGroupJid = (pick.value || '').trim();
  return selectedWaGroupJid;
}

function renderWaGroupsManager(){
  const pick = document.getElementById('gmGroupPick');
  if(!pick) return;

  const current = selectedWaGroupJid || pick.value || '';
  const list = [...waGroupsManager].sort((a,b)=>String(a.subject||'').localeCompare(String(b.subject||'')));

  pick.innerHTML = '<option value="">Select group…</option>';
  for(const g of list){
    const opt = document.createElement('option');
    opt.value = g.jid;
    opt.textContent = `${g.subject || '(no subject)'}  (${g.jid})`;
    pick.appendChild(opt);
  }

  if(current && list.some(g=>g.jid===current)){
    pick.value = current;
    selectedWaGroupJid = current;
  }

  selectWaGroupForManager();
}

function selectWaGroupForManager(){
  const jid = getSelectedWaGroup();
  const meta = document.getElementById('gmSelectedMeta');
  if(!meta) return;

  if(!jid){
    meta.textContent = 'No group selected';
    return;
  }

  const g = waGroupsManager.find(x=>x.jid===jid);
  meta.textContent = `${g?.subject || '(no subject)'} • ${jid}`;
}

async function loadWaGroupsManager(){
  const j = await api('/admin/wa-groups');
  waGroupsManager = j.groups || [];
  renderWaGroupsManager();
}

async function loadSelectedGroupInfo(){
  try{
    const jid = getSelectedWaGroup();
    if(!jid) throw new Error('Select a group first');

    const j = await api('/admin/groups/'+encodeURIComponent(jid)+'/info');
    const info = j.info || {};

    const subjectInput = document.getElementById('gmSubject');
    const descInput = document.getElementById('gmDescription');
    if(subjectInput) subjectInput.value = info.subject || '';
    if(descInput) descInput.value = info.desc || info.description || '';

    const out = {
      id: info.id,
      subject: info.subject,
      owner: info.owner,
      creation: info.creation,
      desc: info.desc || info.description || null,
      participantsCount: Array.isArray(info.participants) ? info.participants.length : 0,
      participants: (info.participants || []).map(p => ({ id: p.id, admin: p.admin || null }))
    };
    const box = document.getElementById('gmInfoBox');
    if(box) box.textContent = JSON.stringify(out, null, 2);

    setStatus('Group info loaded', true);
  }catch(e){
    setStatus(e.message, false);
  }
}

async function createWaGroup(){
  try{
    const subject = (document.getElementById('gmCreateSubject')?.value || '').trim();
    const participantsRaw = document.getElementById('gmCreateParticipants')?.value || '';
    if(!subject) throw new Error('Group subject required');

    const participants = parseParticipantTokens(participantsRaw);
    const j = await api('/admin/groups/create', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ subject, participants })
    });

    const createdJid = j?.group?.id || '';
    setStatus('Group created' + (createdJid ? ': ' + createdJid : ''), true);

    document.getElementById('gmCreateSubject').value = '';
    document.getElementById('gmCreateParticipants').value = '';

    await loadWaGroupsManager();
    await loadTargets();
    if(createdJid){
      selectedWaGroupJid = createdJid;
      renderWaGroupsManager();
      await loadSelectedGroupInfo();
    }
  }catch(e){
    setStatus(e.message, false);
  }
}

async function groupParticipantsAction(action){
  try{
    const jid = getSelectedWaGroup();
    if(!jid) throw new Error('Select a group first');

    const participantsRaw = document.getElementById('gmParticipantsInput')?.value || '';
    const participants = parseParticipantTokens(participantsRaw);
    if(!participants.length) throw new Error('Provide at least one participant');

    await api('/admin/groups/'+encodeURIComponent(jid)+'/'+action, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ participants })
    });

    setStatus(`Group action complete: ${action}`, true);
    if(action === 'add' || action === 'remove'){
      await loadWaGroupsManager();
      await loadTargets();
    }
    await loadSelectedGroupInfo();
  }catch(e){
    setStatus(e.message, false);
  }
}

async function updateSelectedGroupSubject(){
  try{
    const jid = getSelectedWaGroup();
    if(!jid) throw new Error('Select a group first');
    const subject = (document.getElementById('gmSubject')?.value || '').trim();
    if(!subject) throw new Error('Subject required');

    await api('/admin/groups/'+encodeURIComponent(jid)+'/subject', {
      method:'PUT',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ subject })
    });

    setStatus('Group subject updated', true);
    await loadWaGroupsManager();
    await loadTargets();
    await loadSelectedGroupInfo();
  }catch(e){
    setStatus(e.message, false);
  }
}

async function updateSelectedGroupDescription(){
  try{
    const jid = getSelectedWaGroup();
    if(!jid) throw new Error('Select a group first');
    const description = (document.getElementById('gmDescription')?.value || '').trim();

    await api('/admin/groups/'+encodeURIComponent(jid)+'/description', {
      method:'PUT',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ description })
    });

    setStatus('Group description updated', true);
    await loadSelectedGroupInfo();
  }catch(e){
    setStatus(e.message, false);
  }
}

async function leaveSelectedGroup(){
  try{
    const jid = getSelectedWaGroup();
    if(!jid) throw new Error('Select a group first');
    if(!confirm('Leave this group? This cannot be undone from this UI.')) return;

    await api('/admin/groups/'+encodeURIComponent(jid)+'/leave', { method:'POST' });
    setStatus('Left group', true);
    selectedWaGroupJid = '';
    const box = document.getElementById('gmInfoBox');
    if(box) box.textContent = '{}';
    await loadWaGroupsManager();
    await loadTargets();
  }catch(e){
    setStatus(e.message, false);
  }
}

/**
 * ---------- Response Rules ----------
 */
function defaultRuleDraft(){
  return {
    id: '',
    name: '',
    enabled: true,
    triggerType: 'text',
    scope: 'both',
    matchType: 'contains',
    matchValue: '',
    requirePrefix: false,
    groupPrefix: '!bot',
    cooldownMs: 30000,
    replyText: ''
  };
}

function selectedRule(){
  if(!rulesState.selectedId) return null;
  return rulesState.rules.find(rule => String(rule.id) === String(rulesState.selectedId)) || null;
}

function setRulesSelectedBadge(rule){
  const title = document.getElementById('ruleSelectedTitle');
  const meta = document.getElementById('ruleSelectedMeta');
  const badge = document.getElementById('ruleSelectedBadge');
  if(!title || !meta || !badge) return;

  if(!rule){
    title.textContent = 'New rule';
    meta.textContent = 'Text rule';
    badge.className = 'badge type';
    badge.textContent = 'Draft';
    return;
  }

  title.textContent = rule.name || 'Unnamed rule';
  meta.textContent = `${rule.triggerType === 'voice_note' ? 'Voice note' : 'Text'} • ${rule.scope === 'both' ? 'DM + Group' : rule.scope.toUpperCase()}`;
  badge.className = 'badge ' + (rule.enabled === false ? 'failed' : 'sent');
  badge.textContent = rule.enabled === false ? 'Disabled' : 'Active';
}

function syncRuleEditorVisibility(){
  const triggerType = (document.getElementById('ruleTriggerType')?.value || 'text');
  const matchType = (document.getElementById('ruleMatchType')?.value || 'contains');
  const matchBlock = document.getElementById('ruleMatchBlock');
  const prefixBlock = document.getElementById('rulePrefixBlock');
  const matchValue = document.getElementById('ruleMatchValue');

  if(matchBlock) matchBlock.classList.toggle('hidden', triggerType !== 'text');
  if(prefixBlock) prefixBlock.classList.toggle('hidden', triggerType !== 'text');
  if(matchValue) matchValue.disabled = (triggerType !== 'text' || matchType === 'any');

  renderRulesInspector();
}

function applyRuleToForm(ruleInput){
  const rule = { ...defaultRuleDraft(), ...(ruleInput || {}) };
  if(document.getElementById('ruleEnabled')) document.getElementById('ruleEnabled').checked = rule.enabled !== false;
  if(document.getElementById('ruleName')) document.getElementById('ruleName').value = rule.name || '';
  if(document.getElementById('ruleTriggerType')) document.getElementById('ruleTriggerType').value = rule.triggerType || 'text';
  if(document.getElementById('ruleScope')) document.getElementById('ruleScope').value = rule.scope || 'both';
  if(document.getElementById('ruleMatchType')) document.getElementById('ruleMatchType').value = rule.matchType || 'contains';
  if(document.getElementById('ruleMatchValue')) document.getElementById('ruleMatchValue').value = rule.matchValue || '';
  if(document.getElementById('ruleRequirePrefix')) document.getElementById('ruleRequirePrefix').checked = Boolean(rule.requirePrefix);
  if(document.getElementById('ruleGroupPrefix')) document.getElementById('ruleGroupPrefix').value = rule.groupPrefix || '!bot';
  if(document.getElementById('ruleCooldownMs')) document.getElementById('ruleCooldownMs').value = String(rule.cooldownMs ?? 30000);
  if(document.getElementById('ruleReplyText')) document.getElementById('ruleReplyText').value = rule.replyText || '';
  setRulesSelectedBadge(ruleInput && ruleInput.id ? rule : null);
  syncRuleEditorVisibility();
}

function readRuleForm(){
  const current = selectedRule() || defaultRuleDraft();
  return {
    id: current.id || '',
    name: (document.getElementById('ruleName')?.value || '').trim(),
    enabled: Boolean(document.getElementById('ruleEnabled')?.checked),
    triggerType: document.getElementById('ruleTriggerType')?.value || 'text',
    scope: document.getElementById('ruleScope')?.value || 'both',
    matchType: document.getElementById('ruleMatchType')?.value || 'contains',
    matchValue: (document.getElementById('ruleMatchValue')?.value || '').trim(),
    requirePrefix: Boolean(document.getElementById('ruleRequirePrefix')?.checked),
    groupPrefix: (document.getElementById('ruleGroupPrefix')?.value || '!bot').trim(),
    cooldownMs: Number(document.getElementById('ruleCooldownMs')?.value || 0) || 0,
    replyText: (document.getElementById('ruleReplyText')?.value || '').trim()
  };
}

function renderRulesList(){
  const host = document.getElementById('rulesList');
  const btnDelete = document.getElementById('btnRulesDelete');
  if(!host) return;

  host.innerHTML = '';
  const list = [...(rulesState.rules || [])];

  if(!list.length){
    host.innerHTML = '<div class="small" style="opacity:.8">No rules yet. Create one to start matching text or voice notes.</div>';
  }

  for(const rule of list){
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'listRow' + (String(rule.id) === String(rulesState.selectedId) ? ' active' : '');
    row.style.width = '100%';

    const label = `${rule.triggerType === 'voice_note' ? '🎤' : '💬'} ${esc(rule.name || 'Unnamed rule')}`;
    const sub = `${rule.scope === 'both' ? 'DM + Group' : rule.scope.toUpperCase()} • ${rule.enabled === false ? 'disabled' : 'active'}`;
    row.innerHTML = `<div class="grow3"><div class="liMain">${label}</div><div class="liSub">${esc(sub)}</div></div>`;
    row.addEventListener('click', ()=>{
      rulesState.selectedId = rule.id;
      applyRuleToForm(rule);
      renderRulesList();
    });
    host.appendChild(row);
  }

  if(btnDelete) btnDelete.disabled = !rulesState.selectedId;
}

function renderRulesInspector(){
  const pre = document.getElementById('rulesInspector');
  if(!pre) return;
  pre.textContent = JSON.stringify({ enabled: Boolean(document.getElementById('rulesEnabled')?.checked), rule: readRuleForm() }, null, 2);
}

function newRuleDraft(){
  rulesState.selectedId = '';
  applyRuleToForm(defaultRuleDraft());
  renderRulesList();
}

async function loadRules(){
  const j = await api('/admin/rules');
  const cfg = j.rulesConfig || {};
  rulesState.enabled = Boolean(cfg.enabled);
  rulesState.rules = Array.isArray(cfg.rules) ? cfg.rules : [];

  const enabledBox = document.getElementById('rulesEnabled');
  if(enabledBox) enabledBox.checked = rulesState.enabled;

  if(rulesState.selectedId && !rulesState.rules.some(rule => String(rule.id) === String(rulesState.selectedId))){
    rulesState.selectedId = '';
  }

  const active = selectedRule();
  applyRuleToForm(active || defaultRuleDraft());
  renderRulesList();
}

async function saveRulesConfig(){
  await api('/admin/rules/config', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ enabled: Boolean(document.getElementById('rulesEnabled')?.checked) })
  });
}

async function saveRule(){
  try{
    const rule = readRuleForm();
    await saveRulesConfig();

    const hasDraft = Boolean(rule.id || rule.name || rule.replyText || rule.matchValue);
    if(!hasDraft){
      setStatus('Rules config saved', true);
      await loadRules();
      return;
    }

    if(!rule.name) throw new Error('Rule name required');
    if(!rule.replyText) throw new Error('Reply text required');
    if(rule.triggerType === 'text' && rule.matchType !== 'any' && !rule.matchValue) throw new Error('Match value required for text rules');

    const j = await api('/admin/rules', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify(rule)
    });

    rulesState.selectedId = j.rule?.id || rule.id || '';
    setStatus('Rule saved', true);
    await loadRules();
  }catch(e){
    setStatus(e.message, false);
  }
}

async function deleteRule(){
  try{
    const rule = selectedRule();
    if(!rule?.id) throw new Error('Select a saved rule first');
    await api('/admin/rules/'+encodeURIComponent(rule.id), { method:'DELETE' });
    rulesState.selectedId = '';
    setStatus('Rule deleted', true);
    await loadRules();
  }catch(e){
    setStatus(e.message, false);
  }
}

function bindRulesUi(){
  const btnReload = document.getElementById('btnRulesReload');
  if(btnReload && !btnReload.dataset.bound){
    btnReload.dataset.bound = '1';
    btnReload.addEventListener('click', ()=>loadRules().catch(e=>setStatus(e.message,false)));
  }

  const btnNew = document.getElementById('btnRulesNew');
  if(btnNew && !btnNew.dataset.bound){
    btnNew.dataset.bound = '1';
    btnNew.addEventListener('click', newRuleDraft);
  }

  const btnSave = document.getElementById('btnRulesSave');
  if(btnSave && !btnSave.dataset.bound){
    btnSave.dataset.bound = '1';
    btnSave.addEventListener('click', saveRule);
  }

  const btnDelete = document.getElementById('btnRulesDelete');
  if(btnDelete && !btnDelete.dataset.bound){
    btnDelete.dataset.bound = '1';
    btnDelete.addEventListener('click', deleteRule);
  }

  const rulesEnabled = document.getElementById('rulesEnabled');
  if(rulesEnabled && !rulesEnabled.dataset.bound){
    rulesEnabled.dataset.bound = '1';
    rulesEnabled.addEventListener('change', ()=>{
      renderRulesInspector();
      saveRulesConfig().then(()=>setStatus('Rules config saved', true)).catch(e=>setStatus(e.message, false));
    });
  }

  const watchIds = ['ruleEnabled','ruleName','ruleTriggerType','ruleScope','ruleMatchType','ruleMatchValue','ruleRequirePrefix','ruleGroupPrefix','ruleCooldownMs','ruleReplyText'];
  for(const id of watchIds){
    const node = document.getElementById(id);
    if(node && !node.dataset.bound){
      node.dataset.bound = '1';
      node.addEventListener('input', renderRulesInspector);
      node.addEventListener('change', ()=>{
        if(id === 'ruleTriggerType' || id === 'ruleMatchType') syncRuleEditorVisibility();
        else renderRulesInspector();
      });
    }
  }

  syncRuleEditorVisibility();
  renderRulesInspector();
  renderRulesList();
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
