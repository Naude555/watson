/**
 * Watson Admin UI v2 - Simplified and clean
 */

let chats = [];
let currentChat = null;
let contacts = [];
let groups = [];
let rules = [];
let templates = [];
let schedules = [];
let ws = null;
let selectedGroupJid = '';
let chatPollTimer = null;
let messagesES = null;
let messagesESRetryTimer = null;
let messagesStreamLive = false;
let chatRefreshTimer = null;
let activeChatMessages = [];
let selectedQuotedMessageId = '';
let runtimeSettings = {};
let automationSettings = {};
let editingRuleId = '';
let editingTemplateId = '';
let editingContactOriginalName = '';
let contactsSearchQuery = '';
let opsMode = 'basic';
let chatRenderToken = 0;
const chatFingerprintByJid = new Map();
let adminCsrfToken = '';
let adminCsrfPromise = null;
const linkPreviewCache = new Map();
let chatFetchLimit = 500;
const CHAT_RENDER_LIMIT = 500;

const contactNameByJid = new Map();
const contactNameByMsisdn = new Map();
const groupAliasByJid = new Map();
const waGroupNameByJid = new Map();
const waContactNameByJid = new Map();
const canonicalChatJidByAlias = new Map();
const CHAT_LAST_SEEN_STORAGE_KEY = 'watson.admin.chatLastSeen.v1';
const chatUnreadCountByJid = new Map();
let activeChatUnreadSinceTs = 0;

function readChatLastSeenMap() {
  try {
    const raw = localStorage.getItem(CHAT_LAST_SEEN_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const out = {};
    for (const [k, v] of Object.entries(parsed)) {
      const key = String(k || '').trim();
      const ts = Number(v || 0);
      if (!key || !Number.isFinite(ts) || ts <= 0) continue;
      out[key] = ts;
    }
    return out;
  } catch {
    return {};
  }
}

let chatLastSeenByJid = readChatLastSeenMap();

function persistChatLastSeenMap() {
  try {
    localStorage.setItem(CHAT_LAST_SEEN_STORAGE_KEY, JSON.stringify(chatLastSeenByJid));
  } catch {}
}

function getChatLastSeenTs(jid) {
  const key = String(jid || '').trim();
  if (!key) return 0;
  return Number(chatLastSeenByJid[key] || 0);
}

function setChatLastSeenTs(jid, ts) {
  const key = String(jid || '').trim();
  const t = Number(ts || 0);
  if (!key || !Number.isFinite(t) || t <= 0) return;
  if (t <= Number(chatLastSeenByJid[key] || 0)) return;
  chatLastSeenByJid[key] = t;
  persistChatLastSeenMap();
}

function getUnreadCount(jid) {
  return Math.max(0, Number(chatUnreadCountByJid.get(String(jid || '').trim()) || 0));
}

function setUnreadCount(jid, count) {
  const key = String(jid || '').trim();
  if (!key) return;
  const next = Math.max(0, Number(count || 0));
  chatUnreadCountByJid.set(key, next);
}

function incrementUnreadCount(jid, by = 1) {
  const key = String(jid || '').trim();
  if (!key) return;
  setUnreadCount(key, getUnreadCount(key) + Math.max(1, Number(by || 1)));
}

function refreshMessagesNavUnreadBadge() {
  const badge = document.getElementById('messagesNavUnreadBadge');
  if (!badge) return;
  let total = 0;
  for (const c of chats || []) total += getUnreadCount(c?.jid);
  if (total <= 0) {
      if (badge) { badge.style.display = 'none'; badge.textContent = ''; }
      const mob = document.getElementById('mobNavMessagesBadge');
      if (mob) mob.classList.remove('visible');
    return;
  }
    const text = total > 99 ? '99+' : String(total);
    if (badge) { badge.style.display = 'inline-flex'; badge.textContent = text; }
    const mob = document.getElementById('mobNavMessagesBadge');
    if (mob) { mob.textContent = text; mob.classList.add('visible'); }
}

function markChatAsRead(jid, msgs = []) {
  const key = String(jid || '').trim();
  if (!key) return;
  let latestTs = 0;
  if (Array.isArray(msgs) && msgs.length) {
    latestTs = Math.max(...msgs.map(m => Number(m?.ts || 0)));
  }
  if (!latestTs) latestTs = Date.now();
  setChatLastSeenTs(key, latestTs);
  setUnreadCount(key, 0);
  refreshMessagesNavUnreadBadge();
}

function markAllChatsRead() {
  if (!Array.isArray(chats) || !chats.length) {
    toast('No chats to mark as read', false);
    return;
  }

  const now = Date.now();
  for (const c of chats) {
    const jid = String(c?.jid || c?.chatJid || '').trim();
    if (!jid) continue;
    const lastTs = Number(c?.lastTs || 0);
    setChatLastSeenTs(jid, lastTs > 0 ? lastTs : now);
    setUnreadCount(jid, 0);
  }

  refreshMessagesNavUnreadBadge();
  renderChats();
  toast('All chats marked as read', true);
}

function initializeUnreadCountsFromChats() {
  for (const c of chats || []) {
    const jid = String(c?.jid || c?.chatJid || '').trim();
    if (!jid) continue;
    const lastSeen = getChatLastSeenTs(jid);
    const lastTs = Number(c?.lastTs || 0);
    if (!lastTs || lastTs <= lastSeen) {
      setUnreadCount(jid, 0);
      continue;
    }
    const existing = getUnreadCount(jid);
    setUnreadCount(jid, Math.max(existing, 1));
  }
  refreshMessagesNavUnreadBadge();
}

// Panel navigation
function showPanel(name, btnEl) {
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.getElementById('panelMessages').classList.toggle('active', name === 'messages');
  document.getElementById('panelSend').classList.toggle('active', name === 'send');
  document.getElementById('panelPairing').classList.toggle('active', name === 'pairing');
  document.getElementById('panelContacts').classList.toggle('active', name === 'contacts');
  document.getElementById('panelGroups').classList.toggle('active', name === 'groups');
  document.getElementById('panelRules').classList.toggle('active', name === 'rules');
  document.getElementById('panelTemplates').classList.toggle('active', name === 'templates');
  document.getElementById('panelSchedule').classList.toggle('active', name === 'schedule');
  document.getElementById('panelOps').classList.toggle('active', name === 'ops');
  
    // Sync active state across sidebar nav + mobile nav using data-panel attribute
    document.querySelectorAll('.nav-item, .mob-nav-item').forEach(b => b.classList.remove('active'));
    document.querySelectorAll(`[data-panel="${name}"]`).forEach(b => b.classList.add('active'));
  
  const titles = {
    messages: 'Messages',
    send: 'Send',
    pairing: 'Pairing',
    contacts: 'Contacts',
    groups: 'Groups',
    rules: 'Rules',
    templates: 'Templates',
    schedule: 'Schedule',
    ops: 'Operations'
  };
  
  document.getElementById('panelTitle').textContent = titles[name] || 'Watson';
  
  if (name === 'pairing') {
    connectPairingStream();
    refreshQr({ quiet: true, force: true });
  }
  if (name === 'messages') connectMessagesStream();
  if (name === 'messages' && currentChat?.jid) {
    loadChatMessages(currentChat.jid, true).catch(() => {});
  }
  if (name === 'send' || name === 'schedule' || name === 'messages') {
    loadContacts();
  }
  if (name === 'contacts') loadContacts();
  if (name === 'groups') loadGroups();
  if (name === 'rules') {
    loadContacts().catch(() => {});
    loadRules();
  }
  if (name === 'templates') loadTemplates();
  if (name === 'schedule') loadSchedules();
  if (name === 'ops') loadOps();
}

// API helper
function isMutatingMethod(method = 'GET') {
  const m = String(method || 'GET').toUpperCase();
  return m === 'POST' || m === 'PUT' || m === 'PATCH' || m === 'DELETE';
}

async function ensureAdminCsrfToken(force = false) {
  if (!force && adminCsrfToken) return adminCsrfToken;
  if (!force && adminCsrfPromise) return adminCsrfPromise;

  adminCsrfPromise = (async () => {
    const res = await fetch('/admin/csrf', { credentials: 'same-origin' });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    if (!res.ok) {
      throw new Error((json && (json.error || json.message)) || text || 'Failed to fetch CSRF token');
    }
    adminCsrfToken = String(json?.csrfToken || '').trim();
    return adminCsrfToken;
  })();

  try {
    return await adminCsrfPromise;
  } finally {
    adminCsrfPromise = null;
  }
}

async function api(path, opts = {}) {
  const options = { ...opts };
  const method = String(options.method || 'GET').toUpperCase();
  options.headers = { ...(options.headers || {}) };

  if (isMutatingMethod(method) && path !== '/admin/login') {
    if (!adminCsrfToken) await ensureAdminCsrfToken();
    if (adminCsrfToken) options.headers['x-csrf-token'] = adminCsrfToken;
  }

  const res = await fetch(path, options);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  
  if (!res.ok) {
    if (res.status === 401) {
      window.location.href = '/admin/login';
      throw new Error('Unauthorized');
    }
    if (res.status === 403 && isMutatingMethod(method) && String(path).startsWith('/admin/')) {
      adminCsrfToken = '';
      await ensureAdminCsrfToken(true);
      if (adminCsrfToken) {
        options.headers['x-csrf-token'] = adminCsrfToken;
        const retry = await fetch(path, options);
        const retryText = await retry.text();
        let retryJson = null;
        try { retryJson = JSON.parse(retryText); } catch {}
        if (retry.ok) return retryJson || {};
        const retryMsg = (retryJson && (retryJson.error || retryJson.message)) ? (retryJson.error || retryJson.message) : retryText;
        throw new Error(`HTTP ${retry.status}: ${retryMsg}`);
      }
    }
    const msg = (json && (json.error || json.message)) ? (json.error || json.message) : text;
    throw new Error(`HTTP ${res.status}: ${msg}`);
  }
  
  return json || {};
}

function toast(msg, ok = true) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast ${ok ? 'ok' : 'err'}`;
  setTimeout(() => el.classList.add('hidden'), 3500);
}

function splitTargets(raw) {
  return String(raw || '').split(/[\n,;]+/).map(x => x.trim()).filter(Boolean);
}

// ─────────────────────────────────────────────────────────────────────────────
// RECIPIENT PICKER (Send + Schedule panels)
// ─────────────────────────────────────────────────────────────────────────────
let sendRecipients = [];   // { label, value }
let schedRecipients = [];  // { label, value }
let ruleDmFilterSenders = [];  // { label, value }

function normalizeTagValue(tag) {
  return String(tag || '').trim().toLowerCase();
}

function collectAvailableContactTags() {
  const out = new Map();
  for (const c of contacts || []) {
    const tags = Array.isArray(c?.tags) ? c.tags : [];
    for (const t of tags) {
      const raw = String(t || '').trim();
      const key = normalizeTagValue(raw);
      if (!key) continue;
      if (!out.has(key)) out.set(key, raw);
    }
  }
  return Array.from(out.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([, label]) => label);
}

function updateRecipientTagOptions() {
  const tags = collectAvailableContactTags();
  const targets = ['sendTagSelect', 'schedTagSelect'];

  for (const id of targets) {
    const sel = document.getElementById(id);
    if (!sel) continue;

    const prev = String(sel.value || '').trim();
    sel.innerHTML = '';

    const first = document.createElement('option');
    first.value = '';
    first.textContent = tags.length ? 'Select tag…' : 'No tags available';
    sel.appendChild(first);

    for (const t of tags) {
      const opt = document.createElement('option');
      opt.value = t;
      opt.textContent = t;
      sel.appendChild(opt);
    }

    if (prev && tags.some(t => normalizeTagValue(t) === normalizeTagValue(prev))) {
      const match = tags.find(t => normalizeTagValue(t) === normalizeTagValue(prev));
      sel.value = match || '';
    }

    sel.disabled = !tags.length;
  }
}

function contactsForTag(tagRaw) {
  const wanted = normalizeTagValue(tagRaw);
  if (!wanted) return [];
  return (contacts || []).filter(c => {
    const tags = Array.isArray(c?.tags) ? c.tags : [];
    return tags.some(t => normalizeTagValue(t) === wanted);
  });
}

function digitsOnly(v) {
  return String(v || '').replace(/\D/g, '');
}

function canonicalMsisdn(v) {
  let d = digitsOnly(v);
  if (!d) return '';
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('0')) d = '27' + d.slice(1);
  return d;
}

function localMsisdnFromAny(v) {
  const c = canonicalMsisdn(v);
  if (!c) return '';
  if (c.startsWith('27') && c.length >= 11) return '0' + c.slice(2);
  return c;
}

function plusMsisdnFromAny(v) {
  const c = canonicalMsisdn(v);
  return c ? `+${c}` : '';
}

function jidFromIdentifier(v) {
  const raw = String(v || '').trim();
  if (!raw) return '';
  if (raw.includes('@')) return raw;
  const c = canonicalMsisdn(raw);
  return c ? `${c}@s.whatsapp.net` : '';
}

function normalizeJidFieldInput(v) {
  const raw = String(v || '').trim().toLowerCase();
  if (!raw) return '';
  if (!raw.includes('@')) return '';
  if (raw.endsWith('@w.whatsapp.net')) return raw.replace('@w.whatsapp.net', '@s.whatsapp.net');
  return raw;
}

function contactPhoneSeed(c) {
  const ms = String(c?.msisdn || '').trim();
  if (ms) return ms;
  const jid = String(c?.jid || '').trim().toLowerCase();
  if (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@w.whatsapp.net')) return jid;
  return '';
}

function contactIdentifierSummary(c) {
  const ms = String(c?.msisdn || '').trim();
  const jid = String(c?.jid || '').trim();
  const aliases = Array.isArray(c?.aliasJids) ? c.aliasJids.map(v => String(v || '').trim()).filter(Boolean) : [];
  const seed = contactPhoneSeed(c);
  const local = localMsisdnFromAny(seed);
  const intl = plusMsisdnFromAny(seed);
  const aliasText = aliases.length ? `aliases: ${aliases.join(', ')}` : '';
  return [local, intl, jid, aliasText].filter(Boolean).join(' • ');
}

function contactPrimaryTarget(c) {
  return String(c?.msisdn || '').trim() || String(c?.jid || '').trim() || String(c?.name || '').trim();
}

function canonicalPhoneSeed(c) {
  const direct = digitsOnly(c?.msisdn || '');
  if (direct) return direct;
  const jid = String(c?.jid || '').trim();
  const primaryDigits = digitsOnly((jid.split('@')[0] || ''));
  if (primaryDigits.length >= 9) return primaryDigits;
  const aliases = Array.isArray(c?.aliasJids) ? c.aliasJids : [];
  for (const alias of aliases) {
    const aliasDigits = digitsOnly((String(alias || '').split('@')[0] || ''));
    if (aliasDigits.length >= 9) return aliasDigits;
  }
  return '';
}

function contactIdentitySet(c) {
  const out = new Set();
  const jid = String(c?.jid || '').trim();
  if (jid) out.add(jid);
  for (const alias of (Array.isArray(c?.aliasJids) ? c.aliasJids : [])) {
    const value = String(alias || '').trim();
    if (value) out.add(value);
  }
  const phone = canonicalPhoneSeed(c);
  if (phone) out.add(`phone:${phone}`);
  return out;
}

function contactBaseName(nameRaw) {
  return String(nameRaw || '').trim().replace(/\s*\(\d{3,8}\)(\s*#\d+)?$/, '').trim().toLowerCase();
}

function likelyDuplicatePairs(rows) {
  const items = Array.isArray(rows) ? rows : [];
  const pairs = [];
  const seen = new Set();

  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i];
      const b = items[j];
      const aName = String(a?.name || '').trim();
      const bName = String(b?.name || '').trim();
      if (!aName || !bName) continue;

      const aIds = contactIdentitySet(a);
      const bIds = contactIdentitySet(b);
      const shared = [];
      for (const value of aIds) {
        if (bIds.has(value)) shared.push(value);
      }

      const aPhone = canonicalPhoneSeed(a);
      const bPhone = canonicalPhoneSeed(b);
      const samePhone = Boolean(aPhone && bPhone && aPhone === bPhone);
      const aBase = contactBaseName(aName);
      const bBase = contactBaseName(bName);
      const sameBaseName = Boolean(aBase && bBase && aBase === bBase && aName !== bName);

      let score = 0;
      const reasons = [];
      if (shared.length) {
        score += 5;
        reasons.push(`shared id: ${shared[0].replace(/^phone:/, '')}`);
      }
      if (samePhone) {
        score += 4;
        reasons.push(`same phone: ${aPhone}`);
      }
      if (sameBaseName) {
        score += 2;
        reasons.push(`same name: ${aBase}`);
      }

      const aJid = String(a?.jid || '').trim();
      const bJid = String(b?.jid || '').trim();
      const aIsLid = aJid.endsWith('@lid');
      const bIsLid = bJid.endsWith('@lid');
      const aIsPhoneJid = /@(s|w)\.whatsapp\.net$/i.test(aJid);
      const bIsPhoneJid = /@(s|w)\.whatsapp\.net$/i.test(bJid);
      if ((aIsLid && bIsPhoneJid) || (bIsLid && aIsPhoneJid)) {
        score += 1;
        reasons.push('lid + phone jid split');
      }

      if (score < 3) continue;

      const key = [aName, bName].sort().join('¦');
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({
        left: a,
        right: b,
        score,
        reasons
      });
    }
  }

  return pairs.sort((a, b) => {
    const ds = Number(b.score || 0) - Number(a.score || 0);
    if (ds !== 0) return ds;
    return String(a.left?.name || '').localeCompare(String(b.left?.name || ''));
  }).slice(0, 12);
}

/** Build search results from contacts + groups arrays */
function buildRecipientSearchList(query) {
  const q = (query || '').toLowerCase().trim();
  const results = [];
  for (const c of contacts) {
    const name = String(c?.name || '');
    const ms = String(c?.msisdn || '').trim();
    const jid = String(c?.jid || '').trim();
    const seed = contactPhoneSeed(c);
    const local = localMsisdnFromAny(seed);
    const intl = plusMsisdnFromAny(seed);
    const hay = `${name} ${ms} ${jid} ${local} ${intl}`.toLowerCase();
    if (!q || hay.includes(q)) {
      results.push({
        type: 'contact',
        label: name,
        sub: contactIdentifierSummary(c),
        value: contactPrimaryTarget(c)
      });
    }
  }
  for (const g of groups) {
    if (!q || g.name.toLowerCase().includes(q) || g.jid.toLowerCase().includes(q)) {
      results.push({ type: 'group', label: g.name, sub: g.jid, value: g.jid });
    }
  }
  return results;
}

function handlePickerKey(e, dropdownId) {
  if (e.key === 'Escape') {
    const dd = document.getElementById(dropdownId);
    if (dd) dd.classList.remove('open');
  }
}

function renderPickerDropdown(ddId, selected, onPick) {
  const searchId = ddId === 'sendDropdown' ? 'sendRecipientSearch' : 'schedRecipientSearch';
  const query = (document.getElementById(searchId)?.value || '');
  const dd = document.getElementById(ddId);
  if (!dd) return;

  const items = buildRecipientSearchList(query);
  const selectedValues = new Set(selected.map(r => r.value));
  const available = items.filter(i => !selectedValues.has(i.value));

  dd.innerHTML = '';
  if (available.length === 0) {
    dd.innerHTML = '<div class="recipient-dropdown-empty">No contacts or groups found</div>';
  } else {
    let lastType = null;
    for (const item of available) {
      if (item.type !== lastType) {
        const section = document.createElement('div');
        section.className = 'recipient-dropdown-section';
        section.textContent = item.type === 'contact' ? '👤 Contacts' : '👥 Groups';
        dd.appendChild(section);
        lastType = item.type;
      }

      const row = document.createElement('div');
      row.className = 'recipient-dropdown-item';

      const main = document.createElement('span');
      main.className = 'item-main';
      main.textContent = item.label;

      const sub = document.createElement('span');
      sub.className = 'item-sub';
      sub.textContent = item.sub;

      row.appendChild(main);
      row.appendChild(sub);

      // Use mousedown so selection happens before input blur closes dropdown
      row.addEventListener('mousedown', (e) => {
        e.preventDefault();
        onPick(item.label, item.value);
      });

      dd.appendChild(row);
    }
  }
  dd.classList.add('open');
}

// ── Send picker ──────────────────────────────────────────────────────────────
function filterSendDropdown(query) {
  renderPickerDropdown('sendDropdown', sendRecipients, addSendRecipient);
}

function addSendRecipient(label, value) {
  if (!sendRecipients.find(r => r.value === value)) {
    sendRecipients.push({ label, value });
    renderSendChips();
  }
  const inp = document.getElementById('sendRecipientSearch');
  if (inp) inp.value = '';
  const dd = document.getElementById('sendDropdown');
  if (dd) dd.classList.remove('open');
}

function removeSendRecipient(value) {
  sendRecipients = sendRecipients.filter(r => r.value !== value);
  renderSendChips();
}

function renderSendChips() {
  const el = document.getElementById('sendChips');
  if (!el) return;
  el.innerHTML = '';
  for (const r of sendRecipients) {
    const chip = document.createElement('span');
    chip.className = 'recipient-chip';
    chip.append(document.createTextNode(String(r.label || '')));

    const btn = document.createElement('button');
    btn.className = 'chip-remove';
    btn.type = 'button';
    btn.title = 'Remove';
    btn.textContent = '×';
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      removeSendRecipient(r.value);
    });

    chip.appendChild(btn);
    el.appendChild(chip);
  }
}

function addSendTagRecipients() {
  const sel = document.getElementById('sendTagSelect');
  const tag = String(sel?.value || '').trim();
  if (!tag) {
    toast('Select a tag first', false);
    return;
  }

  const rows = contactsForTag(tag);
  let added = 0;
  for (const c of rows) {
    const value = contactPrimaryTarget(c);
    if (!value) continue;
    const before = sendRecipients.length;
    addSendRecipient(String(c?.name || value), value);
    if (sendRecipients.length > before) added++;
  }

  if (!rows.length) toast(`No contacts found for tag "${tag}"`, false);
  else toast(added ? `Added ${added} recipient(s) for tag "${tag}"` : `All contacts for tag "${tag}" already selected`, true);
}

// ── Schedule picker ──────────────────────────────────────────────────────────
function filterSchedDropdown(query) {
  renderPickerDropdown('schedDropdown', schedRecipients, addSchedRecipient);
}

function addSchedRecipient(label, value) {
  if (!schedRecipients.find(r => r.value === value)) {
    schedRecipients.push({ label, value });
    renderSchedChips();
  }
  const inp = document.getElementById('schedRecipientSearch');
  if (inp) inp.value = '';
  const dd = document.getElementById('schedDropdown');
  if (dd) dd.classList.remove('open');
}

function removeSchedRecipient(value) {
  schedRecipients = schedRecipients.filter(r => r.value !== value);
  renderSchedChips();
}

function renderSchedChips() {
  const el = document.getElementById('schedChips');
  if (!el) return;
  el.innerHTML = '';
  for (const r of schedRecipients) {
    const chip = document.createElement('span');
    chip.className = 'recipient-chip';
    chip.append(document.createTextNode(String(r.label || '')));

    const btn = document.createElement('button');
    btn.className = 'chip-remove';
    btn.type = 'button';
    btn.title = 'Remove';
    btn.textContent = '×';
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      removeSchedRecipient(r.value);
    });

    chip.appendChild(btn);
    el.appendChild(chip);
  }
}

function addSchedTagRecipients() {
  const sel = document.getElementById('schedTagSelect');
  const tag = String(sel?.value || '').trim();
  if (!tag) {
    toast('Select a tag first', false);
    return;
  }

  const rows = contactsForTag(tag);
  let added = 0;
  for (const c of rows) {
    const value = contactPrimaryTarget(c);
    if (!value) continue;
    const before = schedRecipients.length;
    addSchedRecipient(String(c?.name || value), value);
    if (schedRecipients.length > before) added++;
  }

  if (!rows.length) toast(`No contacts found for tag "${tag}"`, false);
  else toast(added ? `Added ${added} recipient(s) for tag "${tag}"` : `All contacts for tag "${tag}" already selected`, true);
}

// Close any open picker dropdown when clicking outside
document.addEventListener('click', function(e) {
  const pairs = [
    ['sendRecipientPicker', 'sendDropdown'],
    ['schedRecipientPicker', 'schedDropdown']
  ];
  for (const [pickerId, ddId] of pairs) {
    const picker = document.getElementById(pickerId);
    const dd = document.getElementById(ddId);
    if (dd && picker && !picker.contains(e.target)) {
      dd.classList.remove('open');
    }
  }
});

function getSelectedQuoteForCurrentChat() {
  if (!selectedQuotedMessageId || !currentChat?.jid) return null;
  return activeChatMessages.find(m => m.id === selectedQuotedMessageId && m.direction === 'in') || null;
}

function updateQuoteHints() {
  const selected = getSelectedQuoteForCurrentChat();
  const base = selected
    ? `Selected quote: ${(selected.text || `[${selected.type || 'message'}]`).slice(0, 90)}`
    : 'No quote selected. Use Quote on an incoming message.';

  const replyEl = document.getElementById('replyQuoteHint');
  if (replyEl) replyEl.textContent = base;

  const sendEl = document.getElementById('sendQuoteHint');
  if (sendEl) sendEl.textContent = selected
    ? `${base} • Broadcast quote only works with a single recipient.`
    : 'No quote selected for broadcast.';
}

function setSelectedQuote(messageId) {
  const found = activeChatMessages.find(m => m.id === messageId && m.direction === 'in');
  if (!found) {
    toast('Only incoming messages can be quoted', false);
    return;
  }
  selectedQuotedMessageId = found.id;
  updateQuoteHints();
  toast('Quote selected', true);
}

function clearSelectedQuote() {
  selectedQuotedMessageId = '';
  updateQuoteHints();
}

async function deleteMessage(messageId, deleteForAll = true) {
  try {
    const id = String(messageId || '').trim();
    if (!id) throw new Error('Message id required');

    const target = activeChatMessages.find(m => String(m?.id || '') === id);
    if (!target) throw new Error('Message not found in active chat');
    if (String(target?.direction || '') !== 'out') throw new Error('Only outbound messages can be deleted');
    if (String(target?.status || '').toLowerCase() === 'deleted') {
      toast('Message already deleted', true);
      return;
    }

    const deleteLabel = deleteForAll ? 'Delete for everyone?' : 'Soft delete this message?';
    if (!confirm(deleteLabel)) return;

    await api(`/admin/messages/${encodeURIComponent(id)}/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deleteForAll })
    });

    const chatJid = String(currentChat?.jid || '').trim();
    chatFingerprintByJid.delete(chatJid);
    if (chatJid) await loadChatMessages(chatJid, true);
    toast(deleteForAll ? 'Message deleted for everyone' : 'Message soft-deleted', true);
  } catch (e) {
    toast(e.message, false);
  }
}

function isNearBottom(el, threshold = 140) {
  if (!el) return true;
  return (el.scrollHeight - el.scrollTop - el.clientHeight) <= threshold;
}

function scrollChatLogToBottom(log, token = chatRenderToken) {
  if (!log) return;
  const toBottom = () => {
    if (token !== chatRenderToken) return;
    log.scrollTop = log.scrollHeight;
  };
  toBottom();
  requestAnimationFrame(toBottom);
  setTimeout(toBottom, 60);
  setTimeout(toBottom, 220);
}

function watchChatImagesForBottomLock(log, token = chatRenderToken) {
  if (!log) return;
  const images = Array.from(log.querySelectorAll('img'));
  if (!images.length) {
    scrollChatLogToBottom(log, token);
    return;
  }
  for (const img of images) {
    if (img.complete) continue;
    img.addEventListener('load', () => scrollChatLogToBottom(log, token), { once: true });
    img.addEventListener('error', () => scrollChatLogToBottom(log, token), { once: true });
  }
  scrollChatLogToBottom(log, token);
}

function chatMessagesFingerprint(msgs) {
  return (msgs || []).map((m) => {
    const media = String(m?.media?.localUrl || '');
    return [m?.id || '', m?.ts || '', m?.status || '', m?.type || '', m?.direction || '', m?.text || '', media].join('¦');
  }).join('||');
}

function extractFirstUrl(text) {
  const src = String(text || '');
  const m = src.match(/https?:\/\/[^\s<>"]+/i);
  return m?.[0] ? String(m[0]).trim() : '';
}

async function loadLinkPreview(url) {
  const u = String(url || '').trim();
  if (!u) return null;

  const cached = linkPreviewCache.get(u);
  if (cached && Number(cached.expiresAt || 0) > Date.now()) return cached.value;

  try {
    const data = await api(`/admin/link-preview?url=${encodeURIComponent(u)}`);
    const preview = data?.preview || null;
    linkPreviewCache.set(u, { value: preview, expiresAt: Date.now() + (5 * 60 * 1000) });
    return preview;
  } catch {
    linkPreviewCache.set(u, { value: null, expiresAt: Date.now() + 60_000 });
    return null;
  }
}

function renderEmptyChatState(log) {
  if (!log) return;
  const wrap = document.createElement('div');
  wrap.className = 'wa-chat-empty';
  wrap.textContent = 'No messages yet. Start the conversation from Reply or Send.';
  log.replaceChildren(wrap);
}

function renderLinkPreviewMarkup(preview) {
  const title = esc(preview?.title || preview?.url || 'Link preview');
  const description = esc(preview?.description || '');
  const siteName = esc(preview?.siteName || '');
  const url = esc(preview?.url || '');
  const image = esc(preview?.image || '');

  const imageMarkup = image
    ? `<div class="msg-link-preview-image-wrap"><img class="msg-link-preview-image" src="${image}" alt="Preview image" loading="lazy" onerror="this.style.display='none'" /></div>`
    : '';

  return `
    <a class="msg-link-preview" href="${url}" target="_blank" rel="noopener">
      ${imageMarkup}
      <div class="msg-link-preview-body">
        <div class="msg-link-preview-title">${title}</div>
        ${description ? `<div class="msg-link-preview-desc">${description}</div>` : ''}
        <div class="msg-link-preview-site">${siteName || url}</div>
      </div>
    </a>
  `;
}

async function hydrateChatLinkPreviews(log, token = chatRenderToken) {
  if (!log) return;
  const nodes = Array.from(log.querySelectorAll('.msg-link-preview-slot[data-url]'));
  for (const node of nodes) {
    if (token !== chatRenderToken) return;
    const raw = node.getAttribute('data-url') || '';
    const url = decodeURIComponent(raw);
    if (!url) continue;
    const preview = await loadLinkPreview(url);
    if (token !== chatRenderToken) return;
    if (!preview) {
      node.innerHTML = `<a class="msg-link-preview-fallback" href="${esc(url)}" target="_blank" rel="noopener">Open link</a>`;
      continue;
    }
    node.innerHTML = renderLinkPreviewMarkup(preview);
  }
}

// MESSAGES
function digitsFromJid(jid) {
  const s = String(jid || '');
  const at = s.indexOf('@');
  const num = (at > 0 ? s.slice(0, at) : s).replace(/\D/g, '');
  return num || '';
}

function prettyPhoneFromJid(jid) {
  const digits = digitsFromJid(jid);
  if (!digits) return '';
  if (digits.startsWith('27') && digits.length >= 11) return `+${digits}`;
  return digits;
}

function displayNameForJid(jid) {
  const j = String(jid || '').trim();
  if (!j) return '';

  if (j.endsWith('@g.us')) {
    return groupAliasByJid.get(j) || waGroupNameByJid.get(j) || j;
  }

  const byJid = contactNameByJid.get(j);
  if (byJid) return byJid;

  const waName = waContactNameByJid.get(j);
  if (waName) return waName;

  const digits = digitsFromJid(j);
  if (digits) {
    const byDigits = contactNameByMsisdn.get(digits);
    if (byDigits) return byDigits;
  }

  return prettyPhoneFromJid(j) || j;
}

function normalizeUiJid(raw) {
  const j = String(raw || '').trim().toLowerCase();
  if (!j) return '';
  if (j.endsWith('@w.whatsapp.net')) return j.replace('@w.whatsapp.net', '@s.whatsapp.net');
  return j;
}

function preferredCanonicalJidForContact(contact) {
  const ids = [
    String(contact?.jid || '').trim(),
    ...(Array.isArray(contact?.aliasJids) ? contact.aliasJids.map(v => String(v || '').trim()) : [])
  ].map(normalizeUiJid).filter(Boolean);
  if (!ids.length) return '';
  const phoneJid = ids.find(v => /@(s|w)\.whatsapp\.net$/i.test(v));
  if (phoneJid) return normalizeUiJid(phoneJid);
  const nonLid = ids.find(v => !v.endsWith('@lid'));
  if (nonLid) return nonLid;
  return ids[0];
}

function rebuildCanonicalChatJidMap(contactRows = []) {
  canonicalChatJidByAlias.clear();
  for (const c of (contactRows || [])) {
    const canonical = preferredCanonicalJidForContact(c);
    if (!canonical) continue;
    const ids = [
      String(c?.jid || '').trim(),
      ...(Array.isArray(c?.aliasJids) ? c.aliasJids.map(v => String(v || '').trim()) : [])
    ].map(normalizeUiJid).filter(Boolean);
    canonicalChatJidByAlias.set(canonical, canonical);
    for (const id of ids) canonicalChatJidByAlias.set(id, canonical);
  }
}

function canonicalizeChatJidForUi(raw) {
  const normalized = normalizeUiJid(raw);
  if (!normalized || normalized.endsWith('@g.us')) return normalized;
  return canonicalChatJidByAlias.get(normalized) || normalized;
}

async function loadChats() {
  try {
    const [targets, chatData] = await Promise.all([
      api('/admin/targets'),
      api('/admin/messages/chats')
    ]);

    contactNameByJid.clear();
    contactNameByMsisdn.clear();
    groupAliasByJid.clear();
    waGroupNameByJid.clear();
    waContactNameByJid.clear();

    const targetContacts = Array.isArray(targets.contacts) ? targets.contacts : [];
    rebuildCanonicalChatJidMap(targetContacts);

    for (const c of targetContacts) {
      const name = String(c.name || '').trim();
      const jid = normalizeUiJid(c.jid || '');
      const aliasJids = Array.isArray(c?.aliasJids) ? c.aliasJids.map(v => normalizeUiJid(v)) : [];
      const ms = String(c.msisdn || '').replace(/\D/g, '');
      if (name && jid) contactNameByJid.set(jid, name);
      if (name && aliasJids.length) {
        for (const a of aliasJids) {
          const aj = String(a || '').trim();
          if (aj) contactNameByJid.set(aj, name);
        }
      }
      if (name && ms) {
        contactNameByMsisdn.set(ms, name);
        if (ms.startsWith('0') && ms.length >= 10) contactNameByMsisdn.set('27' + ms.slice(1), name);
        if (ms.startsWith('27')) contactNameByMsisdn.set(ms, name);
      }
    }

    for (const g of targets.groupAliases || []) {
      const name = String(g.name || '').trim();
      const jid = String(g.jid || '').trim();
      if (name && jid) groupAliasByJid.set(jid, name);
    }

    for (const g of targets.waGroups || []) {
      const name = String(g.name || '').trim();
      const jid = String(g.jid || '').trim();
      if (name && jid) waGroupNameByJid.set(jid, name);
    }

    for (const c of targets.waContacts || []) {
      const name = String(c.name || '').trim();
      const jid = String(c.jid || '').trim();
      if (name && jid) waContactNameByJid.set(jid, name);
    }

    chats = (chatData.chats || []).map(c => {
      const canonicalJid = canonicalizeChatJidForUi(c.chatJid);
      return {
      ...c,
      chatJid: canonicalJid,
      jid: canonicalJid,
      type: c.isGroup ? 'group' : 'contact',
      label: `${c.isGroup ? '👥' : '👤'} ${displayNameForJid(canonicalJid)}`
    }});

    const merged = new Map();
    for (const c of chats) {
      const key = String(c?.jid || '').trim();
      if (!key) continue;
      const prev = merged.get(key);
      if (!prev) {
        merged.set(key, c);
        continue;
      }
      merged.set(key, {
        ...prev,
        ...c,
        count: Math.max(Number(prev.count || 0), Number(c.count || 0)),
        lastTs: Math.max(Number(prev.lastTs || 0), Number(c.lastTs || 0)),
        lastText: Number(c.lastTs || 0) >= Number(prev.lastTs || 0) ? c.lastText : prev.lastText,
        lastSenderJid: Number(c.lastTs || 0) >= Number(prev.lastTs || 0) ? c.lastSenderJid : prev.lastSenderJid,
      });
    }
    chats = Array.from(merged.values());
    
    renderChats();
  } catch (e) {
    toast(e.message, false);
  }
}

function filterChats() {
  renderChats();
}

function renderChats() {
  const q = (document.getElementById('chatSearch').value || '').toLowerCase();
  const filtered = chats.filter(c => {
    const name = displayNameForJid(c.jid);
    const hay = `${name} ${c.jid} ${c.lastText || ''}`.toLowerCase();
    return !q || hay.includes(q);
  });
  
  const sel = document.getElementById('chatSelect');
  const listEl = document.getElementById('chatsList');
  const prev = sel.value;
  sel.innerHTML = '<option value="">— Select chat —</option>';
  if (listEl) listEl.innerHTML = '';
  
  for (const c of filtered) {
    const opt = document.createElement('option');
    opt.value = c.jid;
    const name = displayNameForJid(c.jid);
    const suffix = (name && name !== c.jid) ? ` (${c.jid})` : '';
    const tail = String(c.lastText || '').slice(0, 40).replace(/\n/g, ' ');
    opt.textContent = `${c.isGroup ? '👥' : '👤'} ${name || c.jid}${suffix} — ${tail}`;
    sel.appendChild(opt);

    if (listEl) {
      const item = document.createElement('div');
      item.className = `wa-chat-item${currentChat?.jid === c.jid ? ' active' : ''}`;

      const top = document.createElement('div');
      top.className = 'wa-chat-top';

      const nameEl = document.createElement('div');
      nameEl.className = 'wa-chat-name';
      nameEl.textContent = `${c.isGroup ? '👥' : '👤'} ${name || c.jid}`;

      const timeEl = document.createElement('div');
      timeEl.className = 'wa-chat-time';
      timeEl.textContent = c.lastTs ? new Date(c.lastTs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';

      const unreadCount = getUnreadCount(c.jid);
      if (unreadCount > 0) {
        const unreadBadge = document.createElement('span');
        unreadBadge.className = 'wa-chat-unread-badge';
        unreadBadge.textContent = unreadCount > 99 ? '99+' : String(unreadCount);
        timeEl.appendChild(unreadBadge);
      }

      top.appendChild(nameEl);
      top.appendChild(timeEl);

      const lastEl = document.createElement('div');
      lastEl.className = 'wa-chat-last';
      lastEl.textContent = tail || '[no messages]';

      item.appendChild(top);
      item.appendChild(lastEl);
      item.onclick = () => selectChat(c.jid);
      listEl.appendChild(item);
    }
  }

  if (prev) sel.value = prev;
}

function startChatPollingFallback() {
  if (chatPollTimer) return;
  chatPollTimer = setInterval(() => {
    if (currentChat?.jid) loadChatMessages(currentChat.jid, true).catch(() => {});
  }, 4000);
}

function stopChatPollingFallback() {
  if (!chatPollTimer) return;
  clearInterval(chatPollTimer);
  chatPollTimer = null;
}

function scheduleActiveChatRefresh(chatJid) {
  if (!chatJid || currentChat?.jid !== chatJid) return;
  if (chatRefreshTimer) clearTimeout(chatRefreshTimer);
  chatRefreshTimer = setTimeout(() => {
    if (currentChat?.jid === chatJid) loadChatMessages(chatJid, true).catch(() => {});
  }, 80);
}

function applyChatSummaryUpdate(summary) {
  const jid = canonicalizeChatJidForUi(summary?.chatJid || '');
  if (!jid) return;

  const next = {
    chatJid: jid,
    jid,
    isGroup: Boolean(summary?.isGroup),
    count: Number(summary?.count || 0),
    lastTs: Number(summary?.lastTs || 0),
    lastText: String(summary?.lastText || ''),
    lastSenderJid: String(summary?.lastSenderJid || ''),
    type: Boolean(summary?.isGroup) ? 'group' : 'contact',
    label: `${Boolean(summary?.isGroup) ? '👥' : '👤'} ${displayNameForJid(jid)}`
  };

  const idx = chats.findIndex(c => String(c?.jid || c?.chatJid || '') === jid);
  if (idx >= 0) {
    chats[idx] = { ...chats[idx], ...next, isGroup: chats[idx].isGroup || next.isGroup };
  } else {
    chats.push(next);
  }

  chats.sort((a, b) => {
    const dt = Number(b?.lastTs || 0) - Number(a?.lastTs || 0);
    if (dt !== 0) return dt;
    return String(a?.jid || '').localeCompare(String(b?.jid || ''));
  });

  refreshMessagesNavUnreadBadge();
  renderChats();
}

function connectMessagesStream() {
  if (messagesES) return;

  messagesES = new EventSource('/admin/messages/stream');

  messagesES.addEventListener('hello', () => {
    messagesStreamLive = true;
    stopChatPollingFallback();
    if (messagesESRetryTimer) {
      clearTimeout(messagesESRetryTimer);
      messagesESRetryTimer = null;
    }
  });

  messagesES.addEventListener('message-update', (evt) => {
    try {
      const data = JSON.parse(evt.data || '{}');
      const chatJid = canonicalizeChatJidForUi(data?.chatJid || '');
      if (!chatJid) return;
      const isIncoming = String(data?.message?.direction || '').trim() === 'in';
      if (isIncoming) {
        const panelMessages = document.getElementById('panelMessages');
        const messagesVisible = Boolean(panelMessages && panelMessages.classList.contains('active'));
        const activeSameChat = messagesVisible && currentChat?.jid === chatJid;
        if (!activeSameChat) {
          const msgTs = Number(data?.message?.ts || 0);
          if (!msgTs || msgTs > getChatLastSeenTs(chatJid)) {
            incrementUnreadCount(chatJid, 1);
          }
        }
      }
      if (data?.summary) applyChatSummaryUpdate(data.summary);
      scheduleActiveChatRefresh(chatJid);
    } catch {}
  });

  messagesES.onerror = () => {
    messagesStreamLive = false;
    try { messagesES?.close?.(); } catch {}
    messagesES = null;
    if (currentChat?.jid) startChatPollingFallback();
    if (!messagesESRetryTimer) {
      messagesESRetryTimer = setTimeout(() => {
        messagesESRetryTimer = null;
        connectMessagesStream();
      }, 2000);
    }
  };
}

function mobileBackToChats() {
  const shell = document.getElementById('waShell');
  if (shell) shell.dataset.mobile = 'list';
}

async function selectChat(selectedJid = '') {
  const sel = document.getElementById('chatSelect');
  const jid = String(selectedJid || sel?.value || '').trim();
  if (!jid) {
    currentChat = null;
    stopChatPollingFallback();
    return;
  }
  
  if (sel && sel.value !== jid) sel.value = jid;
  activeChatUnreadSinceTs = getChatLastSeenTs(jid);
  currentChat = chats.find(c => c.jid === jid) || { jid, label: displayNameForJid(jid) || jid };
  selectedQuotedMessageId = '';
  activeChatMessages = [];
  renderEmptyChatState(document.getElementById('chatLog'));
  document.getElementById('chatTitle').textContent = currentChat.label;
  document.getElementById('chatInfo').textContent = jid;
  // Reset board panel to hidden when switching chats; reload if visible
  const bp = document.getElementById('boardPanel');
  if (bp && bp.style.display !== 'none') loadBoards();
  else renderBoards([]);
  updateQuoteHints();
  renderChats();

    // On mobile: slide to the chat message view
    if (window.matchMedia('(max-width: 768px)').matches) {
      const shell = document.getElementById('waShell');
      if (shell) shell.dataset.mobile = 'chat';
    }

  if (messagesStreamLive) stopChatPollingFallback();
  else startChatPollingFallback();

  await loadChatMessages(jid, false);
}

async function loadChatMessages(jid, silent = false) {
  try {
    const limit = Math.min(Math.max(Number(chatFetchLimit || 500), 50), 2000);
    const data = await api(`/admin/messages/chat/${encodeURIComponent(jid)}?limit=${limit}`);
    const log = document.getElementById('chatLog');
    const msgs = (data.messages || []).slice(-CHAT_RENDER_LIMIT);
    const nextFingerprint = chatMessagesFingerprint(msgs);
    const prevFingerprint = chatFingerprintByJid.get(jid) || '';
    const hadBottomLock = isNearBottom(log);

    if (nextFingerprint === prevFingerprint) {
      activeChatMessages = msgs;
      const hasRenderedMessages = Boolean(log && log.querySelector('.msg'));
      if (!msgs.length) {
        renderEmptyChatState(log);
      }
      if (msgs.length && !hasRenderedMessages) {
        // The fingerprint can be unchanged when re-opening a chat, but the UI
        // may have been reset to empty while switching chats.
        // In that case we must continue to the full render path below.
      } else {
      updateQuoteHints();
      if (hadBottomLock) scrollChatLogToBottom(log);
      markChatAsRead(jid, msgs);
      renderChats();
      return;
      }
    }

    chatRenderToken += 1;
    const thisRenderToken = chatRenderToken;
    const fragment = document.createDocumentFragment();
    activeChatMessages = msgs;
    const unreadSinceTs = Number(activeChatUnreadSinceTs || 0);
    const unreadIncomingCount = unreadSinceTs
      ? msgs.filter(m => String(m?.direction || '') === 'in' && Number(m?.ts || 0) > unreadSinceTs).length
      : 0;
    let unreadBadgeInserted = false;

    const mediaMarkupFor = (m) => {
      const rawUrl = m?.media?.localUrl;
      if (!rawUrl) return '';
      const safeUrl = esc(rawUrl);
      const mime = String(m?.media?.mimetype || '').toLowerCase();
      const isImage = mime.startsWith('image/') || String(m?.type || '').toLowerCase() === 'image';
      const isVideo = mime.startsWith('video/') || String(m?.type || '').toLowerCase() === 'video';
      const isGifLike = mime.includes('gif') || Boolean(m?.media?.gifPlayback);
      const isPdf = mime.includes('application/pdf') || (/\.pdf(?:\?|$)/i.test(String(rawUrl)));

      if (isImage) {
        return `
          <div style="margin-top:8px;display:grid;gap:6px;">
            <a href="${safeUrl}" target="_blank" rel="noopener" title="Open image">
              <img
                src="${safeUrl}"
                alt="Image preview"
                loading="lazy"
                style="display:block;max-width:min(340px,80vw);max-height:260px;border-radius:10px;border:1px solid rgba(255,255,255,.16);object-fit:cover;background:#0d1119;"
                onerror="this.style.display='none'"
              />
            </a>
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
              <a href="${safeUrl}" target="_blank" rel="noopener" style="color:#9cc7ff;font-size:12px;">Open image</a>
              <a href="${safeUrl}" download style="color:#9cc7ff;font-size:12px;">Download</a>
            </div>
          </div>
        `;
      }

      if (isVideo) {
        return `
          <div style="margin-top:8px;display:grid;gap:6px;">
            <video
              src="${safeUrl}"
              ${isGifLike ? 'autoplay loop muted playsinline' : 'controls'}
              style="display:block;max-width:min(360px,82vw);max-height:280px;border-radius:10px;border:1px solid rgba(255,255,255,.16);background:#0d1119;"
            ></video>
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
              <a href="${safeUrl}" target="_blank" rel="noopener" style="color:#9cc7ff;font-size:12px;">Open video</a>
              <a href="${safeUrl}" download style="color:#9cc7ff;font-size:12px;">Download</a>
            </div>
          </div>
        `;
      }

      if (isPdf) {
        return `
          <div style="margin-top:8px;display:grid;gap:6px;">
            <iframe
              src="${safeUrl}#view=FitH"
              loading="lazy"
              style="display:block;width:min(480px,85vw);height:min(360px,50vh);border-radius:10px;border:1px solid rgba(255,255,255,.16);background:#0d1119;"
            ></iframe>
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
              <a href="${safeUrl}" target="_blank" rel="noopener" style="color:#9cc7ff;font-size:12px;">Open PDF</a>
              <a href="${safeUrl}" download style="color:#9cc7ff;font-size:12px;">Download</a>
            </div>
          </div>
        `;
      }

      return `<div style="margin-top:6px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;"><a href="${safeUrl}" target="_blank" rel="noopener" style="color:#9cc7ff;font-size:12px;">Open media</a><a href="${safeUrl}" download style="color:#9cc7ff;font-size:12px;">Download</a></div>`;
    };

    for (const m of msgs) {
      if (!unreadBadgeInserted && unreadIncomingCount > 0 && String(m?.direction || '') === 'in' && Number(m?.ts || 0) > unreadSinceTs) {
        const marker = document.createElement('div');
        marker.className = 'msg-unread-marker';
        marker.textContent = `${unreadIncomingCount} unread since last opened`;
        fragment.appendChild(marker);
        unreadBadgeInserted = true;
      }

      const div = document.createElement('div');
      div.className = `msg ${m.direction}`;
      const rawTs = Number(m?.ts || 0);
      const dateObj = rawTs > 0 ? new Date(rawTs) : null;
      const isValidDate = Boolean(dateObj) && Number.isFinite(dateObj.getTime());
      const time = isValidDate
        ? dateObj.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
        : 'Unknown time';
      const directionLabel = m.direction === 'out' ? 'Sent' : 'Received';
      const status = m.direction === 'out' ? (m.status || 'queued') : (m.status || 'received');
      const senderName = m.direction === 'out' ? 'You' : displayNameForJid(m.senderJid || m.chatJid);
      const showSender = Boolean(senderName) && (Boolean(m.isGroup) || m.direction === 'in');
      const mediaLink = mediaMarkupFor(m);
      const firstUrl = extractFirstUrl(m?.text || '');
      const previewSlot = firstUrl
        ? `<div class="msg-link-preview-slot" data-url="${encodeURIComponent(firstUrl)}"><span class="ops-muted">Loading preview…</span></div>`
        : '';
      const deletedHint = status === 'deleted'
        ? '<div class="ops-muted" style="margin-top:6px;font-size:11px;">Deleted on sender side</div>'
        : '';
      const quoteBtn = (m.direction === 'in' && m.id)
        ? `<button class="btn-ghost" type="button" onclick="setSelectedQuote('${esc(m.id)}')">Quote</button>`
        : '';
      const canDelete = m.direction === 'out' && m.id && status !== 'deleted';
      const deleteBtn = canDelete
        ? `<button class="btn-ghost" type="button" onclick="deleteMessage('${esc(m.id)}', true)">Delete</button>`
        : '';
      const actions = (quoteBtn || deleteBtn)
        ? `<div class="msg-actions">${quoteBtn}${deleteBtn}</div>`
        : '';
      const senderLine = showSender ? `<div class="msg-sender">${esc(senderName)}</div>` : '';
      div.innerHTML = `${senderLine}<div style="white-space:pre-wrap;word-break:break-word;">${esc(m.text || `[${m.type || 'message'}]`).replace(/\n/g,'<br>')}</div>${deletedHint}${previewSlot}${mediaLink}<div class="msg-time">${directionLabel}: ${time} <span class="badge ${status}">${status}</span></div>${actions}`;
      fragment.appendChild(div);
    }

    if (!msgs.length) {
      renderEmptyChatState(log);
    } else {
      log.replaceChildren(fragment);
    }
    chatFingerprintByJid.set(jid, nextFingerprint);
    markChatAsRead(jid, msgs);
    hydrateChatLinkPreviews(log, thisRenderToken).catch(() => {});
    watchChatImagesForBottomLock(log, thisRenderToken);
    updateQuoteHints();
    renderChats();
  } catch (e) {
    if (!silent) toast(e.message, false);
  }
}

// ── Notice Board management ──────────────────────────────────────────────────

function toggleBoardPanel() {
  const panel = document.getElementById('boardPanel');
  if (!panel) return;
  const visible = panel.style.display !== 'none';
  panel.style.display = visible ? 'none' : 'block';
  if (!visible && currentChat?.jid) loadBoards();
}

function autoSlug() {
  const name = (document.getElementById('boardName')?.value || '').trim();
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  const slugEl = document.getElementById('boardSlug');
  if (slugEl) slugEl.value = slug;
}

async function loadBoards() {
  if (!currentChat?.jid) { renderBoards([]); return; }
  try {
    const data = await api(`/admin/notice-board/list?chatJid=${encodeURIComponent(currentChat.jid)}`);
    renderBoards(data.boards || []);
  } catch {
    renderBoards([]);
  }
}

function renderBoards(boardList) {
  const container = document.getElementById('boardList');
  if (!container) return;
  container.innerHTML = '';
  if (!boardList.length) {
    container.innerHTML = '<div style="font-size:12px;color:#5a6278;padding:4px 0;">No boards for this chat yet. Create one below.</div>';
    return;
  }
  for (const b of boardList) {
    const statusClass = b.enabled ? 'active' : 'disabled';
    const statusLabel = b.enabled ? 'Active' : 'Disabled';
    const safeSlug = esc(b.slug || '');
    const safeUrl  = esc(b.url  || b.slug);
    const currentSize = String(b.size || 'm').trim().toLowerCase() || 'm';
    const currentDensity = String(b.density || 'normal').trim().toLowerCase() || 'normal';
    const div = document.createElement('div');
    div.className = 'board-row board-row-large';
    div.innerHTML = `
      <div>
        <div class="board-row-name" style="font-size:1.5em;font-weight:bold;line-height:1.3;">${esc(b.name)} <span class="board-status ${statusClass}">${statusLabel}</span></div>
        <div class="board-row-url" onclick="copyBoardUrl('${safeUrl}')" title="Click to copy" style="font-size:1.1em;word-break:break-all;">${safeUrl}</div>
        <div style="margin-top:8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
          <span class="ops-muted" style="font-size:12px;">Display</span>
          <select onchange="updateBoardSize('${safeSlug}', this.value)" style="max-width:110px;">
            <option value="xl" ${currentSize === 'xl' ? 'selected' : ''}>XL</option>
            <option value="l" ${currentSize === 'l' ? 'selected' : ''}>L</option>
            <option value="m" ${currentSize === 'm' ? 'selected' : ''}>M</option>
            <option value="s" ${currentSize === 's' ? 'selected' : ''}>S</option>
            <option value="xs" ${currentSize === 'xs' ? 'selected' : ''}>XS</option>
          </select>
          <select onchange="updateBoardDensity('${safeSlug}', this.value)" style="max-width:150px;">
            <option value="wide" ${currentDensity === 'wide' ? 'selected' : ''}>TV / Wide</option>
            <option value="normal" ${currentDensity === 'normal' ? 'selected' : ''}>Normal</option>
            <option value="compact" ${currentDensity === 'compact' ? 'selected' : ''}>Tablet / Compact</option>
          </select>
        </div>
      </div>
      <button class="btn-ghost" type="button" onclick="copyBoardUrl('${safeUrl}')" style="font-size:1em;padding:6px 14px;">Copy URL</button>
      <button class="btn-ghost" type="button" onclick="toggleBoard('${safeSlug}',${!b.enabled})" style="font-size:1em;padding:6px 14px;">${b.enabled ? 'Disable' : 'Enable'}</button>
      <button class="btn-ghost" type="button" onclick="deleteBoard('${safeSlug}')" style="font-size:1em;padding:6px 14px;color:#ff9bad;">Delete</button>
    `;
    container.appendChild(div);
  }
  // Always scroll to bottom after rendering boards
  setTimeout(() => { container.scrollTop = container.scrollHeight; }, 0);
}

async function createBoard() {
  if (!currentChat?.jid) { toast('Select a chat first', false); return; }
  const name = (document.getElementById('boardName')?.value || '').trim();
  if (!name) { toast('Enter a board name', false); return; }
  const slug    = (document.getElementById('boardSlug')?.value    || '').trim();
  const showDir =  document.getElementById('boardShowDir')?.value || 'both';
  const size    =  document.getElementById('boardSize')?.value || 'm';
  const density =  document.getElementById('boardDensity')?.value || 'normal';
  try {
    await api('/admin/notice-board/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatJid: currentChat.jid, name, slug, showDir, size, density })
    });
    document.getElementById('boardName').value = '';
    document.getElementById('boardSlug').value = '';
    const boardSize = document.getElementById('boardSize');
    if (boardSize) boardSize.value = 'm';
    const boardDensity = document.getElementById('boardDensity');
    if (boardDensity) boardDensity.value = 'normal';
    toast('Notice board created', true);
    await loadBoards();
  } catch (e) {
    toast(e.message, false);
  }
}

async function updateBoardSize(slug, size) {
  try {
    await api(`/admin/notice-board/${encodeURIComponent(slug)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ size })
    });
    toast('Board size updated', true);
    await loadBoards();
  } catch (e) {
    toast(e.message, false);
  }
}

async function updateBoardDensity(slug, density) {
  try {
    await api(`/admin/notice-board/${encodeURIComponent(slug)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ density })
    });
    toast('Board density updated', true);
    await loadBoards();
  } catch (e) {
    toast(e.message, false);
  }
}

async function toggleBoard(slug, enabled) {
  try {
    await api(`/admin/notice-board/${encodeURIComponent(slug)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled })
    });
    await loadBoards();
  } catch (e) {
    toast(e.message, false);
  }
}

async function deleteBoard(slug) {
  if (!confirm(`Delete board "${slug}"? The URL will stop working immediately.`)) return;
  try {
    await api(`/admin/notice-board/${encodeURIComponent(slug)}`, { method: 'DELETE' });
    toast('Board deleted', true);
    await loadBoards();
  } catch (e) {
    toast(e.message, false);
  }
}

async function copyBoardUrl(url) {
  if (!url) { toast('No URL to copy', false); return; }
  try {
    await navigator.clipboard.writeText(url);
    toast('URL copied to clipboard', true);
  } catch {
    toast('Copy manually: ' + url, false);
  }
}

async function sendReply() {
  if (!currentChat) {
    toast('Select a chat first', false);
    return;
  }
  
  const text = (document.getElementById('replyText').value || '').trim();
  const file = document.getElementById('replyFile')?.files?.[0] || null;
  const caption = (document.getElementById('replyCaption').value || '').trim();
  const useQuote = Boolean(document.getElementById('replyUseQuote')?.checked);
  const quotedMessageId = (useQuote && getSelectedQuoteForCurrentChat()) ? selectedQuotedMessageId : '';

  if (!text && !file) {
    toast('Enter text or attach media', false);
    return;
  }
  
  try {
    if (file) {
      if ((file.type || '').startsWith('image/')) {
        const fd = new FormData();
        fd.append('to', currentChat.jid);
        fd.append('image', file);
        if (caption || text) fd.append('caption', caption || text);
        if (quotedMessageId) fd.append('quotedMessageId', quotedMessageId);

        await api('/admin/send/image', {
          method: 'POST',
          body: fd
        });
      } else {
        const fd = new FormData();
        fd.append('to', currentChat.jid);
        fd.append('document', file);
        fd.append('fileName', caption || file.name || 'file');
        if (quotedMessageId) fd.append('quotedMessageId', quotedMessageId);

        await api('/admin/send/document', {
          method: 'POST',
          body: fd
        });
      }
    } else {
      await api('/admin/send/text', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: currentChat.jid, message: text, quotedMessageId: quotedMessageId || undefined })
      });
    }
    
    document.getElementById('replyText').value = '';
    const rf = document.getElementById('replyFile');
    if (rf) rf.value = '';
    document.getElementById('replyCaption').value = '';
    toast('Message sent', true);
    await loadChats();
    await loadChatMessages(currentChat.jid, true);
  } catch (e) {
    toast(e.message, false);
  }
}

function clearReply() {
  document.getElementById('replyText').value = '';
  const rf = document.getElementById('replyFile');
  if (rf) rf.value = '';
  const rc = document.getElementById('replyCaption');
  if (rc) rc.value = '';
}

function templateById(idRaw) {
  const id = String(idRaw || '').trim();
  if (!id) return null;
  return templates.find(t => String(t?.id || '').trim() === id) || null;
}

function parseTemplateVariablesInput(raw) {
  const out = {};
  const lines = String(raw || '').split(/\n+/g);
  for (const lineRaw of lines) {
    const line = String(lineRaw || '').trim();
    if (!line) continue;
    const idxEq = line.indexOf('=');
    const idxColon = line.indexOf(':');
    const idx = (idxEq >= 0 && idxColon >= 0) ? Math.min(idxEq, idxColon) : Math.max(idxEq, idxColon);
    if (idx <= 0) continue;
    const key = String(line.slice(0, idx) || '').trim();
    const value = String(line.slice(idx + 1) || '').trim();
    if (!key) continue;
    out[key] = value;
  }
  return out;
}

function renderTemplateBody(body, variables = {}) {
  const src = String(body || '');
  if (!src) return '';
  return src.replace(/\{\{\s*([a-zA-Z0-9_.-]{1,64})\s*\}\}/g, (full, name) => {
    const key = String(name || '').trim();
    if (!key) return full;
    if (!Object.prototype.hasOwnProperty.call(variables, key)) return full;
    return String(variables[key] ?? '');
  });
}

function templateElementsFor(kind) {
  const k = String(kind || '').trim().toLowerCase();
  if (k === 'send') {
    return {
      select: document.getElementById('sendTemplateSelect'),
      vars: document.getElementById('sendTemplateVars'),
      preview: document.getElementById('sendTemplatePreview'),
      message: document.getElementById('sendMessage')
    };
  }
  return {
    select: document.getElementById('schedTemplateSelect'),
    vars: document.getElementById('schedTemplateVars'),
    preview: document.getElementById('schedTemplatePreview'),
    message: document.getElementById('schedMessage')
  };
}

function refreshTemplatePreview(kind) {
  const el = templateElementsFor(kind);
  if (!el.preview || !el.select) return;
  const tpl = templateById(el.select.value);
  if (!tpl) {
    el.preview.textContent = 'Template preview will appear here.';
    return;
  }
  const vars = parseTemplateVariablesInput(el.vars?.value || '');
  const rendered = renderTemplateBody(tpl.body, vars);
  el.preview.textContent = rendered || '[empty]';
}

function applySelectedTemplateToMessage(kind) {
  const el = templateElementsFor(kind);
  if (!el.select || !el.message) return;
  const tpl = templateById(el.select.value);
  if (!tpl) {
    toast('Select a template first', false);
    return;
  }
  const vars = parseTemplateVariablesInput(el.vars?.value || '');
  const rendered = renderTemplateBody(tpl.body, vars).trim();
  if (!rendered) {
    toast('Template rendered to empty text', false);
    return;
  }
  el.message.value = rendered;
  refreshTemplatePreview(kind);
}

function resolveRenderedTemplateText(kind) {
  const el = templateElementsFor(kind);
  if (!el.select) return '';
  const tpl = templateById(el.select.value);
  if (!tpl) return '';
  const vars = parseTemplateVariablesInput(el.vars?.value || '');
  return renderTemplateBody(tpl.body, vars).trim();
}

function populateTemplateSelectOptions() {
  const applyOptions = (selectEl, placeholder = 'No template') => {
    if (!selectEl) return;
    const prev = String(selectEl.value || '').trim();
    selectEl.innerHTML = '';

    const first = document.createElement('option');
    first.value = '';
    first.textContent = templates.length ? 'No template' : 'No templates available';
    selectEl.appendChild(first);

    for (const t of templates) {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = t.category ? `${t.name} (${t.category})` : t.name;
      selectEl.appendChild(opt);
    }

    if (prev && templates.some(t => String(t.id) === prev)) {
      selectEl.value = prev;
    }
    selectEl.disabled = templates.length === 0;
  };

  applyOptions(document.getElementById('sendTemplateSelect'));
  applyOptions(document.getElementById('schedTemplateSelect'));
  refreshTemplatePreview('send');
  refreshTemplatePreview('sched');
}

// SEND
function updateSendForm() {
  const type = document.getElementById('sendType').value;
  const form = document.getElementById('sendForm');
  
  if (type === 'text') {
    form.innerHTML = '<div class="label">Message</div><textarea id="sendMessage" placeholder="Type your message…" style="height: 100px;"></textarea>';
  } else if (type === 'image') {
    form.innerHTML = '<div class="label">Image Upload (preferred)</div><input type="file" id="sendFile" accept="image/*" /><div class="label" style="margin-top: 8px;">OR Image URL</div><input id="sendImageUrl" placeholder="https://..." /><div class="label" style="margin-top: 8px;">Caption (optional)</div><input id="sendCaption" placeholder="Image caption…" />';
  } else if (type === 'document') {
    form.innerHTML = '<div class="label">Document Upload (preferred)</div><input type="file" id="sendFile" /><div class="label" style="margin-top: 8px;">OR Document URL</div><input id="sendDocumentUrl" placeholder="https://..." /><div class="label" style="margin-top: 8px;">File name (optional)</div><input id="sendDocName" placeholder="invoice.pdf" />';
  }
}

async function sendMessages() {
  if (sendRecipients.length === 0) {
    toast('Select at least one recipient', false);
    return;
  }
  
  const type = document.getElementById('sendType').value;
  const targets = sendRecipients.map(r => r.value);
  const useQuote = Boolean(document.getElementById('sendUseQuote')?.checked);
  const quote = getSelectedQuoteForCurrentChat();
  if (useQuote && quote && targets.length !== 1) {
    toast('Quote broadcast is only allowed for a single recipient', false);
    return;
  }
  const quotedMessageId = (useQuote && quote && targets.length === 1) ? quote.id : '';
  
  // Explicit sequential loop: one API call per recipient.
  let sent = 0;
  let failed = 0;
  for (const target of targets) {
    try {
      if (type === 'text') {
        const directMsg = (document.getElementById('sendMessage').value || '').trim();
        const msg = directMsg || resolveRenderedTemplateText('send');
        if (!msg) throw new Error('Message is required');
        await api('/admin/send/text', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ to: target, message: msg, quotedMessageId: quotedMessageId || undefined })
        });
      } else if (type === 'image') {
        const file = document.getElementById('sendFile')?.files?.[0] || null;
        const imageUrl = (document.getElementById('sendImageUrl')?.value || '').trim();
        const caption = (document.getElementById('sendCaption')?.value || '').trim();
        if (!file && !imageUrl) throw new Error('Provide image file or URL');

        if (file) {
          const fd = new FormData();
          fd.append('to', target);
          fd.append('image', file);
          if (caption) fd.append('caption', caption);
          if (quotedMessageId) fd.append('quotedMessageId', quotedMessageId);
          await api('/admin/send/image', { method: 'POST', body: fd });
        } else {
          await api('/admin/send/image', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ to: target, imageUrl, caption, quotedMessageId: quotedMessageId || undefined })
          });
        }
      } else if (type === 'document') {
        const file = document.getElementById('sendFile')?.files?.[0] || null;
        const documentUrl = (document.getElementById('sendDocumentUrl')?.value || '').trim();
        const fileName = (document.getElementById('sendDocName')?.value || '').trim();
        if (!file && !documentUrl) throw new Error('Provide document file or URL');

        if (file) {
          const fd = new FormData();
          fd.append('to', target);
          fd.append('document', file);
          if (fileName) fd.append('fileName', fileName);
          if (quotedMessageId) fd.append('quotedMessageId', quotedMessageId);
          await api('/admin/send/document', { method: 'POST', body: fd });
        } else {
          await api('/admin/send/document', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ to: target, documentUrl, fileName, quotedMessageId: quotedMessageId || undefined })
          });
        }
      }
      sent++;
    } catch (e) {
      failed++;
      console.warn(e.message);
    }
  }

  const ok = failed === 0;
  if (ok) toast(`Sent to ${sent}/${targets.length}`, true);
  else toast(`Sent to ${sent}/${targets.length} • Failed: ${failed}`, false);
  sendRecipients = [];
  renderSendChips();
}

function clearSend() {
  sendRecipients = [];
  renderSendChips();
  const msg = document.getElementById('sendMessage');
  if (msg) msg.value = '';
  const sf = document.getElementById('sendFile');
  if (sf) sf.value = '';
  const si = document.getElementById('sendImageUrl');
  if (si) si.value = '';
  const sd = document.getElementById('sendDocumentUrl');
  if (sd) sd.value = '';
  const sn = document.getElementById('sendDocName');
  if (sn) sn.value = '';
  const sc = document.getElementById('sendCaption');
  if (sc) sc.value = '';
  const stv = document.getElementById('sendTemplateVars');
  if (stv) stv.value = '';
  refreshTemplatePreview('send');
}

// PAIRING
let pairingES = null;
let pairingQrPollTimer = null;
let pairingQrPollRemaining = 0;
let pairingRelinkBusy = false;
let pairingQrUpdatedAt = 0;
let pairingQrRequestInFlight = false;
let pairingLastQrRequestKey = '';
let pairingLastQrLoadedKey = '';
let pairingStatusState = { status: 'unknown', hasQR: false, relinking: false, qrUpdatedAt: 0 };

function setPairingQrImage(src) {
  const img = document.getElementById('qrImage');
  if (!img || !src) return;
  img.src = src;
}

function stopPairingQrPolling() {
  if (!pairingQrPollTimer) return;
  clearTimeout(pairingQrPollTimer);
  pairingQrPollTimer = null;
  pairingQrPollRemaining = 0;
}

function startPairingQrPolling({ attempts = 20, intervalMs = 2500, immediate = true } = {}) {
  stopPairingQrPolling();
  pairingQrPollRemaining = Math.max(1, Number(attempts || 0));

  const tick = () => {
    refreshQr({ quiet: true });
    pairingQrPollRemaining -= 1;
    if (pairingQrPollRemaining <= 0) {
      pairingQrPollTimer = null;
      return;
    }
    pairingQrPollTimer = setTimeout(tick, Math.max(250, Number(intervalMs || 2500)));
  };

  if (immediate) tick();
  else pairingQrPollTimer = setTimeout(tick, Math.max(250, Number(intervalMs || 2500)));
}

function updatePairingStatusUi(data = {}) {
  const prevStatus = String(pairingStatusState?.status || 'unknown');

  pairingStatusState = {
    status: String(data.status || pairingStatusState.status || 'unknown'),
    hasQR: Boolean(data.hasQR),
    relinking: Boolean(data.relinking),
    qrUpdatedAt: Number(data.qrUpdatedAt || pairingStatusState.qrUpdatedAt || 0)
  };

  pairingQrUpdatedAt = pairingStatusState.qrUpdatedAt;

  const parts = [`Status: ${pairingStatusState.status}`];
  if (pairingStatusState.relinking) parts.push('re-pair in progress');
  if (pairingStatusState.hasQR) parts.push('QR Ready');
  const statusEl = document.getElementById('pairingStatus');
  if (statusEl) statusEl.textContent = parts.join(' • ');

  // Once WA opens (especially after fresh pair), refresh data panels immediately.
  if (pairingStatusState.status === 'open' && prevStatus !== 'open') {
    loadChats().catch(() => {});
    loadContacts().catch(() => {});
    loadGroups().catch(() => {});
  }
}

function connectPairingStream() {
  if (pairingES) return;

  pairingES = new EventSource('/admin/pairing/stream');

  pairingES.addEventListener('status', (e) => {
    try {
      const data = JSON.parse(e.data || '{}');
      updatePairingStatusUi(data);
      if (data.status === 'open') {
        stopPairingQrPolling();
        return;
      }

      if (data.hasQR) {
        refreshQr({ quiet: true });
      }
    } catch {}
  });

  pairingES.addEventListener('qr', (e) => {
    try {
      const data = JSON.parse(e.data || '{}');
      if (data && typeof data === 'object') {
        pairingQrUpdatedAt = Number(data.qrUpdatedAt || Date.now());
        updatePairingStatusUi({ ...pairingStatusState, hasQR: true, qrUpdatedAt: pairingQrUpdatedAt });
        if (data.qrDataUrl) {
          const dataUrl = String(data.qrDataUrl || '');
          if (dataUrl.startsWith('data:image/')) {
            const img = document.getElementById('qrImage');
            if (img) {
              const fallbackVersion = String(pairingQrUpdatedAt || Date.now());
              img.onload = () => {
                pairingQrRequestInFlight = false;
                pairingLastQrRequestKey = fallbackVersion;
                pairingLastQrLoadedKey = fallbackVersion;
                img.dataset.qrReady = '1';
              };
              img.onerror = () => {
                pairingQrRequestInFlight = false;
                img.dataset.qrReady = '0';
                setPairingQrImage(`/admin/pairing/qr.png?v=${encodeURIComponent(fallbackVersion)}&t=${Date.now()}`);
              };
              setPairingQrImage(dataUrl);
              return;
            }
          }
        }
      }
    } catch {}
    refreshQr({ quiet: true });
  });

  pairingES.onerror = () => {
    try { pairingES?.close?.(); } catch {}
    pairingES = null;
    setTimeout(() => connectPairingStream(), 2000);
  };
}

async function refreshQr(options = {}) {
  const { quiet = false } = options || {};
  const img = document.getElementById('qrImage');
  if (!img) return;

  const force = Boolean(options && options.force);
  const hasVersion = Number(pairingQrUpdatedAt || 0) > 0;
  const qrVersion = hasVersion
    ? Number(pairingQrUpdatedAt)
    : Math.floor(Date.now() / 15000) * 15000;
  const requestKey = String(qrVersion);

  if (!force && pairingQrRequestInFlight && pairingLastQrRequestKey === requestKey) {
    return;
  }
  if (!force && pairingLastQrLoadedKey === requestKey) {
    return;
  }

  pairingQrRequestInFlight = true;
  pairingLastQrRequestKey = requestKey;
  img.onload = () => {
    pairingQrRequestInFlight = false;
    pairingLastQrLoadedKey = requestKey;
    img.dataset.qrReady = '1';
  };
  img.onerror = () => {
    pairingQrRequestInFlight = false;
    img.dataset.qrReady = '0';
    if (!quiet) toast('QR not ready yet', false);
  };
  const bust = force ? `&t=${Date.now()}` : '';
  setPairingQrImage(`/admin/pairing/qr.png?v=${encodeURIComponent(requestKey)}${bust}`);
}

function manualRefreshQr() {
  if (pairingStatusState.hasQR) {
    refreshQr({ quiet: false, force: true });
    return;
  }
  if (pairingStatusState.status === 'connecting' || pairingStatusState.status === 'relinking' || pairingStatusState.relinking) {
    refreshQr({ quiet: true, force: true });
    toast('Waiting for latest QR…', true);
    return;
  }
  forceRelink({ silentSuccess: true, source: 'refresh-qr' });
}

async function forceRelink(options = {}) {
  const { silentSuccess = false, source = 'force-relink' } = options || {};
  if (pairingRelinkBusy) {
    refreshQr({ quiet: true, force: true });
    toast('Waiting for latest QR…', true);
    return;
  }

  try {
    pairingRelinkBusy = true;
    const statusEl = document.getElementById('pairingStatus');
    if (statusEl) statusEl.textContent = source === 'refresh-qr'
      ? 'Status: relinking • requesting fresh QR…'
      : 'Status: relinking • waiting for QR…';
    await api('/admin/force-relink', { method: 'POST' });
    refreshQr({ quiet: true, force: true });
    if (!silentSuccess) toast('Re-pair requested', true);
  } catch (e) {
    if (String(e?.message || '').toLowerCase().includes('already in progress')) {
      refreshQr({ quiet: true, force: true });
      toast('Waiting for latest QR…', true);
    } else {
      toast(e.message, false);
    }
  } finally {
    pairingRelinkBusy = false;
  }
}

// CONTACTS
async function loadContacts() {
  try {
    const data = await api('/admin/contacts');
    contacts = data.contacts || [];
    if (editingContactOriginalName) {
      const stillExists = contacts.some(c => String(c.name || '').trim() === editingContactOriginalName);
      if (!stillExists) resetContactForm();
    }
    updateRecipientTagOptions();
    syncRuleDmFilterPicker();
    renderContactMergeOptions();
    renderContactsList();
  } catch (e) {
    toast(e.message, false);
  }
}

function splitTags(raw) {
  return String(raw || '')
    .split(/[;,]+/g)
    .map(t => t.trim())
    .filter(Boolean);
}

function splitJids(raw) {
  const out = [];
  const seen = new Set();
  const rows = String(raw || '').split(/[\n,;]+/g).map(v => v.trim()).filter(Boolean);
  for (const r of rows) {
    const j = normalizeJidFieldInput(r);
    if (!j || seen.has(j)) continue;
    seen.add(j);
    out.push(j);
  }
  return out;
}

function tagsToInputValue(tags) {
  if (!Array.isArray(tags) || !tags.length) return '';
  return tags.map(t => String(t || '').trim()).filter(Boolean).join(', ');
}

function contactPhoneDisplay(c) {
  const direct = localMsisdnFromAny(String(c?.msisdn || '').trim());
  if (direct) return direct;
  const jid = String(c?.jid || '').trim();
  if (!jid || !jid.includes('@')) return '';
  const userPart = jid.split('@')[0] || '';
  return /^\d{9,15}$/.test(userPart) ? localMsisdnFromAny(userPart) : '';
}

function contactMatchesQuery(contact, queryRaw) {
  const q = String(queryRaw || '').trim().toLowerCase();
  if (!q) return true;
  const tags = Array.isArray(contact?.tags) ? contact.tags.map(t => String(t || '').trim()).filter(Boolean).join(' ') : '';
  const aliases = Array.isArray(contact?.aliasJids) ? contact.aliasJids.join(' ') : '';
  const haystack = [
    String(contact?.name || ''),
    String(contact?.jid || ''),
    String(contact?.msisdn || ''),
    String(contact?.msisdnIntl || ''),
    String(contactPhoneDisplay(contact) || ''),
    aliases,
    tags
  ].join(' ').toLowerCase();
  return haystack.includes(q);
}

function getFilteredSortedContacts() {
  const q = String(contactsSearchQuery || '').trim();
  return [...(contacts || [])]
    .sort((a, b) => String(a?.name || '').localeCompare(String(b?.name || ''), undefined, { sensitivity: 'base' }))
    .filter(c => contactMatchesQuery(c, q));
}

function filterContactsList() {
  contactsSearchQuery = String(document.getElementById('contactsSearch')?.value || '').trim();
  renderContactsList();
}

function applyContactFormMode() {
  const title = document.getElementById('cFormTitle');
  const saveBtn = document.getElementById('cSaveBtn');
  const cancelBtn = document.getElementById('cCancelEditBtn');
  const editing = Boolean(editingContactOriginalName);

  if (title) title.textContent = editing ? `Edit Contact: ${editingContactOriginalName}` : 'Add Contact';
  if (saveBtn) saveBtn.textContent = editing ? 'Update Contact' : 'Save Contact';
  if (cancelBtn) cancelBtn.style.display = editing ? 'block' : 'none';
}

function resetContactForm() {
  editingContactOriginalName = '';
  document.getElementById('cName').value = '';
  document.getElementById('cPhone').value = '';
  document.getElementById('cJid').value = '';
  document.getElementById('cAliasJids').value = '';
  document.getElementById('cTags').value = '';
  const mergeTarget = document.getElementById('cMergeTarget');
  if (mergeTarget) mergeTarget.value = '';
  applyContactFormMode();
}

function startContactEdit(name) {
  const target = String(name || '').trim();
  const contact = contacts.find(c => String(c?.name || '').trim() === target);
  if (!contact) {
    toast('Contact not found', false);
    return;
  }

  editingContactOriginalName = target;
  document.getElementById('cName').value = String(contact.name || '');
  document.getElementById('cPhone').value = contactPhoneDisplay(contact);
  document.getElementById('cJid').value = String(contact.jid || '');
  document.getElementById('cAliasJids').value = Array.isArray(contact.aliasJids) ? contact.aliasJids.join(', ') : '';
  document.getElementById('cTags').value = tagsToInputValue(contact.tags);
  const mergeTarget = document.getElementById('cMergeTarget');
  if (mergeTarget) mergeTarget.value = target;
  applyContactFormMode();
}

function cancelContactEdit() {
  resetContactForm();
}

function renderContactMergeOptions() {
  const targetEl = document.getElementById('cMergeTarget');
  const sourceEl = document.getElementById('cMergeSource');
  if (!targetEl || !sourceEl) return;

  const prevTarget = String(targetEl.value || '');
  const prevSource = String(sourceEl.value || '');
  targetEl.innerHTML = '<option value="">— Select target contact —</option>';
  sourceEl.innerHTML = '<option value="">— Select source contact —</option>';

  const rows = [...(contacts || [])].sort((a, b) => String(a?.name || '').localeCompare(String(b?.name || '')));
  for (const c of rows) {
    const name = String(c?.name || '').trim();
    if (!name) continue;
    const summary = contactIdentifierSummary(c);
    const label = summary ? `${name} — ${summary}` : name;

    const targetOpt = document.createElement('option');
    targetOpt.value = name;
    targetOpt.textContent = label;
    targetEl.appendChild(targetOpt);

    const sourceOpt = document.createElement('option');
    sourceOpt.value = name;
    sourceOpt.textContent = label;
    sourceEl.appendChild(sourceOpt);
  }

  if (rows.some(c => String(c?.name || '').trim() === prevTarget)) targetEl.value = prevTarget;
  if (rows.some(c => String(c?.name || '').trim() === prevSource)) sourceEl.value = prevSource;
}

function renderLikelyDuplicateContacts() {
  const host = document.getElementById('contactsMergeSuggestions');
  if (!host) return;

  const pairs = likelyDuplicatePairs(contacts || []);
  if (!pairs.length) {
    host.innerHTML = '<div class="ops-muted">No likely duplicate contacts detected.</div>';
    return;
  }

  host.innerHTML = pairs.map((pair, idx) => {
    const leftName = esc(String(pair.left?.name || 'Left'));
    const rightName = esc(String(pair.right?.name || 'Right'));
    const leftSummary = esc(contactIdentifierSummary(pair.left) || 'No identifiers');
    const rightSummary = esc(contactIdentifierSummary(pair.right) || 'No identifiers');
    const reasons = esc((pair.reasons || []).join(' • '));
    const keepLeft = esc(String(pair.left?.name || ''));
    const keepRight = esc(String(pair.right?.name || ''));
    return `
      <div class="list-item" style="margin-top:${idx ? '8px' : '0'};align-items:flex-start;flex-direction:column;gap:8px;">
        <div class="list-item-text" style="width:100%;">
          <div class="list-item-main">Possible duplicate • score ${Number(pair.score || 0)}</div>
          <div class="list-item-sub">${reasons}</div>
          <div class="list-item-sub" style="margin-top:6px;"><strong>${leftName}</strong> — ${leftSummary}</div>
          <div class="list-item-sub"><strong>${rightName}</strong> — ${rightSummary}</div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button class="btn-ghost" type="button" onclick="mergeContactsByName('${keepLeft.replace(/'/g, "\\'")}', '${keepRight.replace(/'/g, "\\'")}')">Keep ${leftName}</button>
          <button class="btn-ghost" type="button" onclick="mergeContactsByName('${keepRight.replace(/'/g, "\\'")}', '${keepLeft.replace(/'/g, "\\'")}')">Keep ${rightName}</button>
        </div>
      </div>
    `;
  }).join('');
}

function renderContactsList() {
  const list = document.getElementById('contactsList');
  list.innerHTML = '';
  const rows = getFilteredSortedContacts();

  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'ops-muted';
    empty.textContent = contactsSearchQuery ? 'No contacts match your search.' : 'No contacts yet.';
    list.appendChild(empty);
  }

  for (const c of rows) {
    const item = document.createElement('div');
    item.className = 'list-item';
    item.innerHTML = `<div class="list-item-text"><div class="list-item-main">${esc(c.name)}</div><div class="list-item-sub">${esc(contactIdentifierSummary(c))}</div></div>`;

    const actions = document.createElement('div');
    actions.style.display = 'flex';
    actions.style.gap = '8px';

    const editBtn = document.createElement('button');
    editBtn.className = 'btn-ghost';
    editBtn.textContent = 'Edit';
    editBtn.onclick = () => startContactEdit(c.name);
    
    const del = document.createElement('button');
    del.className = 'btn-danger';
    del.textContent = 'Delete';
    del.onclick = () => deleteContact(c.name);
    
    actions.appendChild(editBtn);
    actions.appendChild(del);
    item.appendChild(actions);
    list.appendChild(item);
  }

  renderLikelyDuplicateContacts();
}

async function saveContact() {
  const name = document.getElementById('cName').value.trim();
  const rawPhone = document.getElementById('cPhone').value.trim();
  const rawJid = document.getElementById('cJid').value.trim();
  const rawAliasJids = document.getElementById('cAliasJids').value;
  const tags = splitTags(document.getElementById('cTags').value);
  const asMsisdn = localMsisdnFromAny(rawPhone);
  const asJid = rawJid ? normalizeJidFieldInput(rawJid) : '';
  const aliasJids = splitJids(rawAliasJids).filter(v => v !== asJid);
  
  if (!name) {
    toast('Name required', false);
    return;
  }
  
  try {
    if (editingContactOriginalName) {
      const body = { newName: name, tags };
      if (rawPhone && !asMsisdn) {
        toast('Invalid phone number format', false);
        return;
      }
      if (rawJid && !asJid) {
        toast('Invalid JID format', false);
        return;
      }
      body.msisdn = asMsisdn || '';
      body.jid = asJid || '';
      body.aliasJids = aliasJids;
      await api(`/admin/contacts/${encodeURIComponent(editingContactOriginalName)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      toast('Contact updated', true);
    } else {
      if (!rawPhone && !rawJid) {
        toast('Phone number or JID required for new contact', false);
        return;
      }
      if (rawPhone && !asMsisdn) {
        toast('Invalid phone number format', false);
        return;
      }
      if (rawJid && !asJid) {
        toast('Invalid JID format', false);
        return;
      }
      const body = { name, tags, msisdn: asMsisdn || '', jid: asJid || '', aliasJids };
      await api('/admin/contacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      toast('Contact saved', true);
    }

    resetContactForm();
    await Promise.all([loadContacts(), loadChats()]);
  } catch (e) {
    toast(e.message, false);
  }
}

async function deleteContact(name) {
  try {
    await api(`/admin/contacts/${encodeURIComponent(name)}`, { method: 'DELETE' });
    toast('Contact deleted', true);
    await Promise.all([loadContacts(), loadChats()]);
  } catch (e) {
    toast(e.message, false);
  }
}

async function mergeContactsAction() {
  const targetName = String(document.getElementById('cMergeTarget')?.value || '').trim();
  const sourceName = String(document.getElementById('cMergeSource')?.value || '').trim();

  if (!targetName || !sourceName) {
    toast('Select both a target and source contact', false);
    return;
  }
  if (targetName === sourceName) {
    toast('Pick two different contacts', false);
    return;
  }
  if (!confirm(`Merge "${sourceName}" into "${targetName}"? The source contact will be removed and its thread merged.`)) return;

  try {
    await api('/admin/contacts/merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetName, sourceName })
    });
    toast(`Merged ${sourceName} into ${targetName}`, true);
    document.getElementById('cMergeSource').value = '';
    document.getElementById('cMergeTarget').value = targetName;
    await Promise.all([loadContacts(), loadChats()]);
  } catch (e) {
    toast(e.message, false);
  }
}

async function mergeContactsByName(targetName, sourceName) {
  const targetEl = document.getElementById('cMergeTarget');
  const sourceEl = document.getElementById('cMergeSource');
  if (targetEl) targetEl.value = String(targetName || '');
  if (sourceEl) sourceEl.value = String(sourceName || '');
  await mergeContactsAction();
}

// GROUPS
async function loadGroups() {
  try {
    const data = await api('/admin/wa-groups');
    groups = (data.groups || []).map(g => ({ jid: g.jid, name: g.subject || g.name || g.jid }));
    renderGroupsList();
  } catch (e) {
    toast(e.message, false);
  }
}

function renderGroupsList() {
  const list = document.getElementById('groupsList');
  const sel = document.getElementById('groupSelect');
  list.innerHTML = '';
  if (sel) {
    sel.innerHTML = '<option value="">— Select group —</option>';
  }
  
  for (const g of groups) {
    if (sel) {
      const opt = document.createElement('option');
      opt.value = g.jid;
      opt.textContent = `${g.name} (${g.jid})`;
      sel.appendChild(opt);
    }

    const item = document.createElement('div');
    item.className = 'list-item';
    item.innerHTML = `<div class="list-item-text"><div class="list-item-main">${esc(g.name)}</div><div class="list-item-sub">${esc(g.jid)}</div></div>`;
    list.appendChild(item);
  }

  if (sel && selectedGroupJid) {
    sel.value = selectedGroupJid;
  }
}

async function createGroup() {
  const name = document.getElementById('groupName').value.trim();
  if (!name) {
    toast('Enter group name', false);
    return;
  }
  
  try {
    const participantsRaw = (document.getElementById('groupParticipants')?.value || '').trim();
    const participants = participantsRaw ? participantsRaw.split(/[\n,;]+/).map(x => x.trim()).filter(Boolean) : [];

    await api('/admin/groups/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject: name, participants })
    });
    
    toast('Group created', true);
    document.getElementById('groupName').value = '';
    await loadGroups();
  } catch (e) {
    toast(e.message, false);
  }
}

let groupParticipantSenders = [];

function selectGroupForOps() {
  selectedGroupJid = String(document.getElementById('groupSelect')?.value || '').trim();
  groupParticipantSenders = [];
  renderGroupParticipantChips();
  document.getElementById('groupParticipantSearch').value = '';
  syncGroupParticipantPicker('');
}

function setGroupParticipantManualValues(values = []) {
  groupParticipantSenders = (Array.isArray(values) ? values : []).map(v => String(v || '').trim()).filter(Boolean);
  renderGroupParticipantChips();
}

function getGroupParticipantManualValues() {
  return groupParticipantSenders;
}

function readGroupParticipants() {
  return getGroupParticipantManualValues();
}

function renderGroupParticipantChips() {
  const chips = document.getElementById('groupParticipantChips');
  if (!chips) return;
  chips.innerHTML = '';
  for (const value of groupParticipantSenders) {
    const label = contactLabelForValue(value);
    const chip = document.createElement('div');
    chip.className = 'recipient-chip';
    chip.style.cssText = 'background: rgba(138, 43, 226, 0.2); border: 1px solid rgba(138, 43, 226, 0.5); border-radius: 16px; padding: 4px 10px; display: inline-flex; align-items: center; gap: 6px; margin: 2px; font-size: 12px; color: #ccc;';
    chip.innerHTML = `
      <span>${esc(label || value)}</span>
      <button type="button" style="background: none; border: none; color: #aaa; cursor: pointer; padding: 0; font-size: 14px;" onclick="removeGroupParticipant('${esc(value)}')" title="Remove">×</button>
    `;
    chips.appendChild(chip);
  }
}

function removeGroupParticipant(value) {
  groupParticipantSenders = groupParticipantSenders.filter(v => String(v || '').trim() !== String(value || '').trim());
  renderGroupParticipantChips();
}

function addGroupParticipant(label, value) {
  const v = String(value || '').trim();
  if (!v || groupParticipantSenders.some(x => String(x).trim() === v)) return;
  groupParticipantSenders.push(v);
  renderGroupParticipantChips();
}

function syncGroupParticipantPicker(q) {
  const list = document.getElementById('groupParticipantPickList');
  if (!list) return;

  const query = String(q || '').trim().toLowerCase();
  const selected = new Set(getGroupParticipantManualValues().map(v => v.toLowerCase()));

  const rows = [...(contacts || [])]
    .sort((a, b) => String(a?.name || '').localeCompare(String(b?.name || ''), undefined, { sensitivity: 'base' }))
    .filter(c => {
      const value = ruleDmFilterCandidateValue(c);
      const summary = contactIdentifierSummary(c);
      const hay = `${String(c?.name || '')} ${summary} ${value}`.toLowerCase();
      return !query || hay.includes(query);
    });

  list.innerHTML = '';
  for (const c of rows) {
    const value = ruleDmFilterCandidateValue(c);
    if (!value) continue;
    const name = String(c?.name || '').trim() || value;
    const summary = contactIdentifierSummary(c);
    const option = document.createElement('option');
    option.value = value;
    option.textContent = summary ? `${name} — ${summary}` : name;
    if (selected.has(String(value).toLowerCase())) option.disabled = true;
    list.appendChild(option);
  }

  if (!list.options.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No matching contacts';
    option.disabled = true;
    list.appendChild(option);
  }
}

function addSelectedGroupParticipants() {
  const list = document.getElementById('groupParticipantPickList');
  if (!list) return;
  const picked = Array.from(list.selectedOptions || [])
    .filter(o => !o.disabled)
    .map(o => String(o.value || '').trim())
    .filter(Boolean);
  if (!picked.length) {
    toast('Select participant(s) to add', false);
    return;
  }
  for (const value of picked) {
    addGroupParticipant(contactLabelForValue(value), value);
  }
}

function addAllFilteredGroupParticipants() {
  const list = document.getElementById('groupParticipantPickList');
  if (!list) return;
  const picked = Array.from(list.options || [])
    .filter(o => !o.disabled)
    .map(o => String(o.value || '').trim())
    .filter(Boolean);
  if (!picked.length) return;
  for (const value of picked) {
    addGroupParticipant(contactLabelForValue(value), value);
  }
}

function handleGroupPickerKey(evt) {
  const list = document.getElementById('groupParticipantPickList');
  if (!list) return;
  if (evt.key === 'Enter') {
    evt.preventDefault();
    addSelectedGroupParticipants();
  }
}

async function groupAction(action) {
  try {
    if (!selectedGroupJid) throw new Error('Select a group first');
    const participants = readGroupParticipants();
    if (!participants.length) throw new Error('Participants required');

    await api(`/admin/groups/${encodeURIComponent(selectedGroupJid)}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ participants })
    });

    toast(`Group ${action} completed`, true);
  } catch (e) {
    toast(e.message, false);
  }
}

async function updateGroupSubject() {
  try {
    if (!selectedGroupJid) throw new Error('Select a group first');
    const subject = String(document.getElementById('groupNewSubject')?.value || '').trim();
    if (!subject) throw new Error('Subject required');

    await api(`/admin/groups/${encodeURIComponent(selectedGroupJid)}/subject`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject })
    });

    toast('Subject updated', true);
    await loadGroups();
  } catch (e) {
    toast(e.message, false);
  }
}

async function updateGroupDescription() {
  try {
    if (!selectedGroupJid) throw new Error('Select a group first');
    const description = String(document.getElementById('groupNewDescription')?.value || '').trim();

    await api(`/admin/groups/${encodeURIComponent(selectedGroupJid)}/description`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description })
    });

    toast('Description updated', true);
  } catch (e) {
    toast(e.message, false);
  }
}

async function leaveGroup() {
  try {
    if (!selectedGroupJid) throw new Error('Select a group first');

    await api(`/admin/groups/${encodeURIComponent(selectedGroupJid)}/leave`, {
      method: 'POST'
    });

    toast('Left group', true);
    selectedGroupJid = '';
    await loadGroups();
  } catch (e) {
    toast(e.message, false);
  }
}

// RULES
function updateRuleMatchDisplay() {
  const match = document.getElementById('ruleMatch').value;
  const box = document.getElementById('ruleKeywordBox');
  box.style.display = match === 'any' ? 'none' : 'block';
}

function updateRuleDmFilterDisplay() {
  const mode = String(document.getElementById('ruleDmFilterMode')?.value || 'all');
  const box = document.getElementById('ruleDmFilterBox');
  if (!box) return;
  box.style.display = mode === 'all' ? 'none' : 'block';
  if (mode !== 'all') syncRuleDmFilterPicker();
}

function getRuleDmFilterManualValues() {
  return ruleDmFilterSenders.map(s => s.value);
}

function contactLabelForValue(value) {
  const v = String(value || '').trim();
  if (!v) return v;
  const c = contacts.find(ct => ruleDmFilterCandidateValue(ct) === v);
  if (c) return String(c?.name || '').trim() || v;
  return v;
}

function setRuleDmFilterManualValues(values) {
  const deduped = [...new Set((values || []).map(v => String(v || '').trim()).filter(Boolean))];
  ruleDmFilterSenders = deduped.map(v => ({ label: contactLabelForValue(v), value: v }));
  renderRuleDmFilterChips();
}

function addRuleDmFilterSender(label, value) {
  const v = String(value || '').trim();
  if (!v) return;
  if (ruleDmFilterSenders.find(s => s.value === v)) return;
  ruleDmFilterSenders.push({ label: String(label || v), value: v });
  renderRuleDmFilterChips();
  syncRuleDmFilterPicker();
}

function removeRuleDmFilterSender(value) {
  ruleDmFilterSenders = ruleDmFilterSenders.filter(s => s.value !== value);
  renderRuleDmFilterChips();
  syncRuleDmFilterPicker();
}

function renderRuleDmFilterChips() {
  const el = document.getElementById('ruleDmFilterChips');
  if (!el) return;
  el.innerHTML = '';
  if (!ruleDmFilterSenders.length) {
    const empty = document.createElement('span');
    empty.className = 'ops-muted';
    empty.style.fontSize = '12px';
    empty.textContent = 'No senders selected';
    el.appendChild(empty);
    return;
  }
  for (const s of ruleDmFilterSenders) {
    const chip = document.createElement('span');
    chip.className = 'recipient-chip';
    chip.append(document.createTextNode(String(s.label || s.value)));
    const btn = document.createElement('button');
    btn.className = 'chip-remove';
    btn.type = 'button';
    btn.title = `Remove ${s.label || s.value}`;
    btn.textContent = '×';
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      removeRuleDmFilterSender(s.value);
    });
    chip.appendChild(btn);
    el.appendChild(chip);
  }
}

function ruleDmFilterCandidateValue(c) {
  const jid = String(c?.jid || '').trim();
  if (jid) return jid;
  const intl = String(c?.msisdnIntl || '').trim();
  if (intl) return intl;
  const msisdn = String(c?.msisdn || '').trim();
  if (msisdn) return msisdn;
  return String(c?.name || '').trim();
}

function syncRuleDmFilterPicker() {
  const list = document.getElementById('ruleDmFilterPickList');
  if (!list) return;

  const q = String(document.getElementById('ruleDmFilterSearch')?.value || '').trim().toLowerCase();
  const selected = new Set(getRuleDmFilterManualValues().map(v => v.toLowerCase()));

  const rows = [...(contacts || [])]
    .sort((a, b) => String(a?.name || '').localeCompare(String(b?.name || ''), undefined, { sensitivity: 'base' }))
    .filter(c => {
      const value = ruleDmFilterCandidateValue(c);
      const summary = contactIdentifierSummary(c);
      const hay = `${String(c?.name || '')} ${summary} ${value}`.toLowerCase();
      return !q || hay.includes(q);
    });

  list.innerHTML = '';
  for (const c of rows) {
    const value = ruleDmFilterCandidateValue(c);
    if (!value) continue;
    const name = String(c?.name || '').trim() || value;
    const summary = contactIdentifierSummary(c);
    const option = document.createElement('option');
    option.value = value;
    option.textContent = summary ? `${name} — ${summary}` : name;
    if (selected.has(String(value).toLowerCase())) option.disabled = true;
    list.appendChild(option);
  }

  if (!list.options.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No matching contacts';
    option.disabled = true;
    list.appendChild(option);
  }
}

function addSelectedSendersToRuleList() {
  const list = document.getElementById('ruleDmFilterPickList');
  if (!list) return;
  const picked = Array.from(list.selectedOptions || [])
    .filter(o => !o.disabled)
    .map(o => String(o.value || '').trim())
    .filter(Boolean);
  if (!picked.length) {
    toast('Select sender(s) to add', false);
    return;
  }
  for (const value of picked) {
    addRuleDmFilterSender(contactLabelForValue(value), value);
  }
}

function addAllFilteredSendersToRuleList() {
  const list = document.getElementById('ruleDmFilterPickList');
  if (!list) return;
  const picked = Array.from(list.options || [])
    .filter(o => !o.disabled)
    .map(o => String(o.value || '').trim())
    .filter(Boolean);
  if (!picked.length) return;
  for (const value of picked) {
    addRuleDmFilterSender(contactLabelForValue(value), value);
  }
}

function resetRuleForm() {
  editingRuleId = '';
  document.getElementById('ruleId').value = '';
  document.getElementById('ruleEnabled').value = 'true';
  document.getElementById('ruleTrigger').value = 'text';
  document.getElementById('ruleScope').value = 'both';
  document.getElementById('ruleDmFilterMode').value = 'all';
  document.getElementById('ruleDmFilterSearch').value = '';
  ruleDmFilterSenders = [];
  renderRuleDmFilterChips();
  document.getElementById('ruleMatch').value = 'contains';
  document.getElementById('ruleKeyword').value = '';
  document.getElementById('ruleReply').value = '';
  document.getElementById('ruleFormMode').textContent = 'Creating a new rule';
  updateRuleDmFilterDisplay();
  updateRuleMatchDisplay();
}

function editRule(id) {
  const rule = rules.find(r => r.id === id);
  if (!rule) return;
  editingRuleId = rule.id;
  document.getElementById('ruleId').value = rule.id || '';
  document.getElementById('ruleEnabled').value = String(rule.enabled !== false);
  document.getElementById('ruleTrigger').value = rule.triggerType || 'text';
  document.getElementById('ruleScope').value = rule.scope || 'both';
  document.getElementById('ruleDmFilterMode').value = rule.dmFilterMode || 'all';
  document.getElementById('ruleDmFilterSearch').value = '';
  setRuleDmFilterManualValues(Array.isArray(rule.dmFilterValues) ? rule.dmFilterValues : []);
  document.getElementById('ruleMatch').value = rule.matchType || 'contains';
  document.getElementById('ruleKeyword').value = rule.matchValue || '';
  document.getElementById('ruleReply').value = rule.replyText || '';
  document.getElementById('ruleFormMode').textContent = `Editing rule: ${rule.name || rule.id}`;
  updateRuleDmFilterDisplay();
  updateRuleMatchDisplay();
}

async function loadRules() {
  try {
    const data = await api('/admin/rules');
    const cfg = data.rulesConfig || {};
    rules = cfg.rules || [];
    if (!contacts.length) loadContacts().catch(() => {});
    renderRulesList();
    if (!editingRuleId) resetRuleForm();
  } catch (e) {
    toast(e.message, false);
  }
}

function renderRulesList() {
  const list = document.getElementById('rulesList');
  list.innerHTML = '';
  
  for (const r of rules) {
    const dmMode = String(r.dmFilterMode || 'all');
    const dmValues = Array.isArray(r.dmFilterValues) ? r.dmFilterValues : [];
    const dmLabels = dmValues.map(v => contactLabelForValue(v));
    const dmSummary = dmMode === 'include'
      ? `DM include: ${dmLabels.length ? dmLabels.join(', ') : '(none)'}`
      : (dmMode === 'exclude' ? `DM exclude: ${dmLabels.length ? dmLabels.join(', ') : '(none)'}` : 'DM all');
    const item = document.createElement('div');
    item.className = 'list-item';
    item.innerHTML = `<div class="list-item-text"><div class="list-item-main">${r.triggerType}: "${esc(r.matchValue || 'any')}"</div><div class="list-item-sub">${esc(dmSummary)} • → ${esc(r.replyText.slice(0, 50))}</div></div>`;
    
    const del = document.createElement('button');
    del.className = 'btn-danger';
    del.textContent = 'Delete';
    del.onclick = () => deleteRule(r.id);

    const edit = document.createElement('button');
    edit.className = 'btn-ghost';
    edit.textContent = 'Edit';
    edit.onclick = () => editRule(r.id);
    
    item.appendChild(edit);
    item.appendChild(del);
    list.appendChild(item);
  }
}

async function saveRule() {
  const trigger = document.getElementById('ruleTrigger').value;
  const scope = document.getElementById('ruleScope').value;
  const dmFilterMode = document.getElementById('ruleDmFilterMode').value;
  const dmFilterValues = getRuleDmFilterManualValues();
  const match = document.getElementById('ruleMatch').value;
  const keyword = document.getElementById('ruleKeyword').value.trim();
  const reply = document.getElementById('ruleReply').value.trim();
  const id = document.getElementById('ruleId').value.trim();
  const enabled = document.getElementById('ruleEnabled').value !== 'false';
  
  if (!reply) {
    toast('Enter reply text', false);
    return;
  }
  
  try {
    await api('/admin/rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: id || undefined,
        triggerType: trigger,
        matchType: match,
        matchValue: keyword,
        scope,
        dmFilterMode,
        dmFilterValues,
        enabled,
        replyText: reply
      })
    });
    
    toast(id ? 'Rule updated' : 'Rule added', true);
    resetRuleForm();
    await loadRules();
  } catch (e) {
    toast(e.message, false);
  }
}

async function deleteRule(id) {
  try {
    await api(`/admin/rules/${encodeURIComponent(id)}`, { method: 'DELETE' });
    toast('Rule deleted', true);
    if (editingRuleId === id) resetRuleForm();
    await loadRules();
  } catch (e) {
    toast(e.message, false);
  }
}

// TEMPLATES
function resetTemplateForm() {
  editingTemplateId = '';
  const idEl = document.getElementById('tplId');
  const nameEl = document.getElementById('tplName');
  const catEl = document.getElementById('tplCategory');
  const descEl = document.getElementById('tplDescription');
  const bodyEl = document.getElementById('tplBody');
  const modeEl = document.getElementById('tplFormMode');
  if (idEl) idEl.value = '';
  if (nameEl) nameEl.value = '';
  if (catEl) catEl.value = '';
  if (descEl) descEl.value = '';
  if (bodyEl) bodyEl.value = '';
  if (modeEl) modeEl.textContent = 'Create a new template';
}

function editTemplate(id) {
  const tpl = templates.find(t => String(t?.id || '') === String(id || ''));
  if (!tpl) return;
  editingTemplateId = tpl.id;
  const idEl = document.getElementById('tplId');
  const nameEl = document.getElementById('tplName');
  const catEl = document.getElementById('tplCategory');
  const descEl = document.getElementById('tplDescription');
  const bodyEl = document.getElementById('tplBody');
  const modeEl = document.getElementById('tplFormMode');
  if (idEl) idEl.value = tpl.id || '';
  if (nameEl) nameEl.value = tpl.name || '';
  if (catEl) catEl.value = tpl.category || '';
  if (descEl) descEl.value = tpl.description || '';
  if (bodyEl) bodyEl.value = tpl.body || '';
  if (modeEl) modeEl.textContent = `Editing template: ${tpl.name || tpl.id}`;
}

async function loadTemplates() {
  try {
    const data = await api('/admin/templates');
    templates = Array.isArray(data?.templates) ? data.templates : [];
    populateTemplateSelectOptions();
    renderTemplatesList();
    if (!editingTemplateId) resetTemplateForm();
  } catch (e) {
    toast(e.message, false);
  }
}

function renderTemplatesList() {
  const list = document.getElementById('templatesList');
  if (!list) return;
  list.innerHTML = '';

  for (const t of templates) {
    const item = document.createElement('div');
    item.className = 'list-item';
    const vars = Array.isArray(t?.variables) ? t.variables : [];
    const desc = String(t?.description || '').trim();
    const sub = [
      t?.category ? `Category: ${t.category}` : '',
      vars.length ? `Vars: ${vars.map(v => `{{${v}}}`).join(', ')}` : 'Vars: none',
      desc
    ].filter(Boolean).join(' • ');
    item.innerHTML = `<div class="list-item-text"><div class="list-item-main">${esc(t.name || 'Template')}</div><div class="list-item-sub">${esc(sub)}</div></div>`;

    const edit = document.createElement('button');
    edit.className = 'btn-ghost';
    edit.textContent = 'Edit';
    edit.onclick = () => editTemplate(t.id);

    const del = document.createElement('button');
    del.className = 'btn-danger';
    del.textContent = 'Delete';
    del.onclick = () => deleteTemplate(t.id);

    item.appendChild(edit);
    item.appendChild(del);
    list.appendChild(item);
  }
}

async function saveTemplate() {
  const id = String(document.getElementById('tplId')?.value || '').trim();
  const name = String(document.getElementById('tplName')?.value || '').trim();
  const category = String(document.getElementById('tplCategory')?.value || '').trim();
  const description = String(document.getElementById('tplDescription')?.value || '').trim();
  const body = String(document.getElementById('tplBody')?.value || '').trim();

  if (!name || !body) {
    toast('Template name and body are required', false);
    return;
  }

  try {
    await api('/admin/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: id || undefined, name, category, description, body })
    });
    toast(id ? 'Template updated' : 'Template saved', true);
    resetTemplateForm();
    await loadTemplates();
  } catch (e) {
    toast(e.message, false);
  }
}

async function deleteTemplate(id) {
  try {
    await api(`/admin/templates/${encodeURIComponent(id)}`, { method: 'DELETE' });
    toast('Template deleted', true);
    if (editingTemplateId === id) resetTemplateForm();
    await loadTemplates();
  } catch (e) {
    toast(e.message, false);
  }
}

// SCHEDULE
async function loadSchedules() {
  try {
    const data = await api('/admin/schedule');
    schedules = data.schedules || [];
    renderScheduleList();
  } catch (e) {
    toast(e.message, false);
  }
}

function renderScheduleList() {
  const list = document.getElementById('scheduleList');
  list.innerHTML = '';
  
  for (const s of schedules) {
    const item = document.createElement('div');
    item.className = 'list-item';
    const when = new Date(s.sendAt || s.ts).toLocaleString();
    item.innerHTML = `<div class="list-item-text"><div class="list-item-main">${when}</div><div class="list-item-sub">${esc(String(s.payload?.message || 'broadcast').slice(0, 50))}</div></div>`;
    list.appendChild(item);
  }
}

async function scheduleMessage() {
  const targets = schedRecipients.map(r => r.value);
  const directMsg = (document.getElementById('schedMessage').value || '').trim();
  const msg = directMsg || resolveRenderedTemplateText('sched');
  const when = document.getElementById('schedTime').value;
  
  if (!targets.length || !msg) {
    toast('Fill all fields', false);
    return;
  }
  
  try {
    await api('/admin/schedule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targets,
        payload: { type: 'text', message: msg },
        sendAt: when ? new Date(when).toISOString() : undefined
      })
    });
    
    toast('Scheduled', true);
    schedRecipients = [];
    renderSchedChips();
    document.getElementById('schedMessage').value = '';
    document.getElementById('schedTime').value = '';
    const stv = document.getElementById('schedTemplateVars');
    if (stv) stv.value = '';
    refreshTemplatePreview('sched');
    await loadSchedules();
  } catch (e) {
    toast(e.message, false);
  }
}

// OPS
function pct(part, total) {
  if (!total) return '0%';
  return `${Math.round((Number(part || 0) / Number(total || 1)) * 100)}%`;
}

function renderOpsDeliveryStats(delivery) {
  const el = document.getElementById('opsDeliveryStats');
  if (!el) return;

  const d = delivery || {};
  const lifecycle = d.lifecycle || {};
  const outbound = Number(d.outbound || 0);
  const windowSize = Number(d.windowSize || 0);
  const failed = Array.isArray(d.recentFailed) ? d.recentFailed : [];

  const chips = [
    ['queued', lifecycle.queued || 0],
    ['retrying', lifecycle.retrying || 0],
    ['sent', lifecycle.sent || 0],
    ['delivered', lifecycle.delivered || 0],
    ['read', lifecycle.read || 0],
    ['failed', lifecycle.failed || 0]
  ];

  const chipHtml = chips.map(([k, v]) => {
    const cls = ['sent', 'delivered', 'read', 'failed'].includes(k) ? k : 'neutral';
    return `<div class="ops-chip"><span class="badge ${cls}">${k}</span><strong>${v}</strong><small>${pct(v, outbound)}</small></div>`;
  }).join('');

  const failedHtml = failed.length
    ? failed.map(f => {
        const ts = Number(f.statusTs || f.ts || 0);
        const when = ts ? new Date(ts).toLocaleString() : 'unknown time';
        const jid = esc(f.chatJid || 'unknown');
        const text = esc(f.text || '[no text]');
        return `<div class="ops-failed-item"><div><strong>${jid}</strong><div class="ops-muted">${text}</div></div><div class="ops-muted">${when}</div></div>`;
      }).join('')
    : '<div class="ops-muted">No recent failed outbound messages ✅</div>';

  el.innerHTML = `
    <div class="info-box" style="line-height:1.5;">
      <strong>Delivery lifecycle</strong><br/>
      Window: last ${windowSize} stored messages • Outbound: ${outbound} • Inbound: ${Number(d.inbound || 0)}
    </div>
    <div class="ops-chip-grid">${chipHtml}</div>
    <div class="info-box" style="margin-top:10px;">
      <strong>Recent failed outbound</strong>
      <div class="ops-failed-list">${failedHtml}</div>
    </div>
  `;
}

function renderOpsDependencyHealth(deps) {
  const el = document.getElementById('opsDependencyHealth');
  if (!el) return;

  const redis = deps?.redis || {};
  const wa = deps?.wa || {};
  const queue = deps?.queue || {};

  const redisState = redis.ok ? 'ok' : 'err';
  const waState = wa.ok ? 'ok' : 'err';
  const lagMs = Number(queue.lagMs || 0);
  const lagLabel = lagMs > 0 ? `${Math.round(lagMs / 1000)}s` : '0s';

  el.innerHTML = `
    <div class="info-box" style="line-height:1.5;">
      <strong>Dependency health</strong><br/>
      <span class="badge ${redisState}">Redis</span> ${redis.ok ? 'Connected' : esc(redis.error || 'Disconnected')}
      ${redis.latencyMs !== null && redis.latencyMs !== undefined ? `• ${Number(redis.latencyMs)}ms` : ''}<br/>
      <span class="badge ${waState}">WhatsApp</span> ${esc(wa.status || 'unknown')}${wa.hasQR ? ' • QR ready' : ''}<br/>
      <span class="badge neutral">Queue lag</span> ${lagLabel}
    </div>
  `;
}

function renderOpsDeadLetters(items = []) {
  const el = document.getElementById('opsDeadLetters');
  if (!el) return;

  const rows = Array.isArray(items) ? items : [];
  const listHtml = rows.length
    ? rows.slice(0, 20).map((d) => {
        const when = Number(d?.ts || 0) ? new Date(Number(d.ts)).toLocaleString() : 'unknown time';
        const jid = esc(d?.chatJid || 'unknown chat');
        const err = esc(String(d?.error || 'Unknown error').slice(0, 180));
        const id = encodeURIComponent(String(d?.id || ''));
        return `
          <div class="ops-failed-item">
            <div>
              <strong>${jid}</strong>
              <div class="ops-muted">${err}</div>
              <div class="ops-muted">${when}</div>
            </div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;">
              <button class="btn-ghost" type="button" onclick="retryDeadLetter('${id}')">Retry</button>
              <button class="btn-ghost" type="button" onclick="removeDeadLetter('${id}')">Dismiss</button>
            </div>
          </div>
        `;
      }).join('')
    : '<div class="ops-muted">No n8n dead-letter items ✅</div>';

  el.innerHTML = `
    <div class="info-box">
      <strong>n8n Dead-letter Queue</strong>
      <div class="ops-muted" style="margin-top:4px;">Failed webhook events are stored here for retry.</div>
      <div class="row" style="margin-top:8px;">
        <button class="btn-ghost" type="button" onclick="loadDeadLetters()">Reload</button>
        <button class="btn-ghost" type="button" onclick="retryAllDeadLetters()">Retry all</button>
        <button class="btn-danger" type="button" onclick="clearDeadLetters()">Clear all</button>
      </div>
      <div class="ops-failed-list" style="margin-top:8px;">${listHtml}</div>
    </div>
  `;
}

async function loadDeadLetters(silent = false) {
  try {
    const data = await api('/admin/n8n/dead-letters?limit=200');
    renderOpsDeadLetters(data?.items || []);
    return data?.items || [];
  } catch (e) {
    if (!silent) toast(e.message, false);
    renderOpsDeadLetters([]);
    return [];
  }
}

async function retryDeadLetter(id) {
  try {
    await api(`/admin/n8n/dead-letters/${String(id || '')}/retry`, { method: 'POST' });
    toast('Dead-letter retried', true);
    await loadDeadLetters(true);
  } catch (e) {
    toast(e.message, false);
  }
}

async function removeDeadLetter(id) {
  try {
    await api(`/admin/n8n/dead-letters/${String(id || '')}`, { method: 'DELETE' });
    toast('Dead-letter dismissed', true);
    await loadDeadLetters(true);
  } catch (e) {
    toast(e.message, false);
  }
}

async function retryAllDeadLetters() {
  try {
    const out = await api('/admin/n8n/dead-letters/retry-all', { method: 'POST' });
    toast(`Retried ${Number(out?.retried || 0)} dead-letter item(s)`, true);
    await loadDeadLetters(true);
  } catch (e) {
    toast(e.message, false);
  }
}

async function clearDeadLetters() {
  if (!confirm('Clear all dead-letter items?')) return;
  try {
    await api('/admin/n8n/dead-letters', { method: 'DELETE' });
    toast('Dead-letter queue cleared', true);
    await loadDeadLetters(true);
  } catch (e) {
    toast(e.message, false);
  }
}

async function loadOps() {
  try {
    const [data] = await Promise.all([
      api('/admin/connection'),
      loadRuntimeSettings(true),
      loadAutomationSettings(true)
    ]);
    const status = document.getElementById('opsStatus');
    const waStatus = data?.wa?.status || 'unknown';
    const queueWaiting = data?.queue?.waiting ?? 0;
    const queueActive = data?.queue?.active ?? 0;
    const queueFailed = data?.queue?.failed ?? 0;
    const qh = data?.queue?.quietHours || {};
    const quietLabel = qh?.enabled
      ? `Enabled (${esc(qh.start || '22:00')} → ${esc(qh.end || '06:00')} ${esc(qh.tz || 'Africa/Johannesburg')})`
      : 'Disabled';
    const deadLetters = Number(data?.n8n?.deadLetters || 0);
    status.innerHTML = `<div class="info-box"><strong>Status:</strong> ${waStatus}<br/><strong>Queue waiting:</strong> ${queueWaiting}<br/><strong>Queue active:</strong> ${queueActive}<br/><strong>Queue failed:</strong> ${queueFailed}<br/><strong>Dead letters:</strong> ${deadLetters}<br/><strong>Quiet hours:</strong> ${quietLabel}</div>`;
    renderOpsDependencyHealth(data?.dependencies || {});
    renderOpsDeliveryStats(data?.delivery || {});
    await loadDeadLetters(true);
  } catch (e) {
    toast(e.message, false);
  }
}

function formatSettingsMeta(source, updatedAt) {
  const sourceLabel = source === 'admin' ? 'admin override' : 'startup defaults';
  const when = Number(updatedAt || 0) > 0 ? new Date(Number(updatedAt)).toLocaleString() : '—';
  return `Source: ${sourceLabel} · Last saved: ${when}`;
}

function setOpsMode(mode) {
  const next = mode === 'advanced' ? 'advanced' : 'basic';
  opsMode = next;
  const panel = document.getElementById('panelOps');
  if (panel) panel.setAttribute('data-mode', next);

  const bBasic = document.getElementById('opsModeBasic');
  const bAdvanced = document.getElementById('opsModeAdvanced');
  if (bBasic) bBasic.classList.toggle('active', next === 'basic');
  if (bAdvanced) bAdvanced.classList.toggle('active', next === 'advanced');

  try { localStorage.setItem('watson.opsMode', next); } catch {}
}

function initOpsMode() {
  let saved = 'basic';
  try { saved = localStorage.getItem('watson.opsMode') || 'basic'; } catch {}
  setOpsMode(saved === 'advanced' ? 'advanced' : 'basic');
}

function addWebhookRow(value = '') {
  const list = document.getElementById('opsWebhookList');
  if (!list) return;

  const row = document.createElement('div');
  row.className = 'ops-webhook-row';

  const input = document.createElement('input');
  input.type = 'url';
  input.placeholder = 'https://example.com/webhook';
  input.value = String(value || '').trim();

  const remove = document.createElement('button');
  remove.className = 'btn-ghost';
  remove.type = 'button';
  remove.title = 'Remove this webhook URL';
  remove.textContent = '−';
  remove.onclick = () => {
    row.remove();
    if (!list.children.length) addWebhookRow('');
  };

  row.appendChild(input);
  row.appendChild(remove);
  list.appendChild(row);
}

function renderWebhookRows(urls = []) {
  const list = document.getElementById('opsWebhookList');
  if (!list) return;
  list.innerHTML = '';
  const items = Array.isArray(urls) ? urls : [];
  if (!items.length) {
    addWebhookRow('');
    return;
  }
  for (const u of items) addWebhookRow(u);
}

function readWebhookUrlsFromUi() {
  const list = document.getElementById('opsWebhookList');
  if (!list) return [];
  const out = [];
  for (const row of Array.from(list.children)) {
    const input = row.querySelector('input');
    const val = String(input?.value || '').trim();
    if (val) out.push(val);
  }
  return out;
}

async function loadAutomationSettings(silent = false) {
  try {
    const data = await api('/admin/automations');
    automationSettings = data?.automations || {};

    const enabledEl = document.getElementById('opsN8nEnabled');
    if (!enabledEl) return automationSettings;

    const defaults = automationSettings.defaults || {};
    const forward = automationSettings.forward || {};
    const safety = defaults.safety || {};
    const rateLimit = defaults.rateLimit || {};
    const urls = Array.isArray(automationSettings.webhookUrls) && automationSettings.webhookUrls.length
      ? automationSettings.webhookUrls
      : [automationSettings.webhookUrl].filter(Boolean);

    enabledEl.checked = Boolean(automationSettings.enabled);
    renderWebhookRows(urls);
    document.getElementById('opsN8nSharedSecret').value = automationSettings.sharedSecret || '';
    document.getElementById('opsN8nForwardText').checked = forward.text !== false;
    document.getElementById('opsN8nForwardImage').checked = Boolean(forward.image);
    document.getElementById('opsN8nForwardDocument').checked = Boolean(forward.document);
    document.getElementById('opsN8nForwardOther').checked = Boolean(forward.other);
    document.getElementById('opsN8nDmEnabled').checked = defaults.dmEnabled !== false;
    document.getElementById('opsN8nRequirePrefixForAll').checked = Boolean(defaults.requirePrefixForAll);
    document.getElementById('opsN8nGroupMode').value = defaults.groupMode || 'prefix';
    document.getElementById('opsN8nGroupPrefix').value = defaults.groupPrefix || '';
    document.getElementById('opsN8nRateLimitEnabled').checked = rateLimit.enabled !== false;
    document.getElementById('opsN8nRateLimitMaxPerMinute').value = Number(rateLimit.maxPerMinute || 30);
    document.getElementById('opsN8nAllowGroups').checked = safety.allowGroups !== false;
    document.getElementById('opsN8nAllowDM').checked = safety.allowDM !== false;
    document.getElementById('opsN8nBlockMedia').checked = Boolean(safety.blockMedia);
    const metaEl = document.getElementById('opsN8nMeta');
    if (metaEl) metaEl.textContent = formatSettingsMeta(automationSettings.lastSavedBy, automationSettings.updatedAt);
    return automationSettings;
  } catch (e) {
    if (!silent) toast(e.message, false);
    return {};
  }
}

async function saveAutomationSettings() {
  try {
    const urls = readWebhookUrlsFromUi();

    const payload = {
      enabled: Boolean(document.getElementById('opsN8nEnabled')?.checked),
      webhookUrl: urls[0] || '',
      webhookUrls: urls,
      sharedSecret: (document.getElementById('opsN8nSharedSecret')?.value || '').trim() || '***',
      forward: {
        text: Boolean(document.getElementById('opsN8nForwardText')?.checked),
        image: Boolean(document.getElementById('opsN8nForwardImage')?.checked),
        document: Boolean(document.getElementById('opsN8nForwardDocument')?.checked),
        other: Boolean(document.getElementById('opsN8nForwardOther')?.checked)
      },
      defaults: {
        ...(automationSettings.defaults || {}),
        enabled: true,
        dmEnabled: Boolean(document.getElementById('opsN8nDmEnabled')?.checked),
        requirePrefixForAll: Boolean(document.getElementById('opsN8nRequirePrefixForAll')?.checked),
        groupMode: document.getElementById('opsN8nGroupMode')?.value || 'prefix',
        groupPrefix: (document.getElementById('opsN8nGroupPrefix')?.value || '').trim(),
        rateLimit: {
          ...(automationSettings.defaults?.rateLimit || {}),
          enabled: Boolean(document.getElementById('opsN8nRateLimitEnabled')?.checked),
          maxPerMinute: Number(document.getElementById('opsN8nRateLimitMaxPerMinute')?.value || 30)
        },
        safety: {
          ...(automationSettings.defaults?.safety || {}),
          allowGroups: Boolean(document.getElementById('opsN8nAllowGroups')?.checked),
          allowDM: Boolean(document.getElementById('opsN8nAllowDM')?.checked),
          blockMedia: Boolean(document.getElementById('opsN8nBlockMedia')?.checked)
        }
      }
    };

    await api('/admin/automations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    toast('n8n settings saved', true);
    await loadAutomationSettings(true);
  } catch (e) {
    toast(e.message, false);
  }
}

async function loadRuntimeSettings(silent = false) {
  try {
    const data = await api('/admin/settings/runtime');
    runtimeSettings = data?.settings || {};
    const auto = runtimeSettings.autoReply || {};
    const queue = runtimeSettings.queue || {};
    const rateLimit = runtimeSettings.rateLimit || {};
    const apiToggles = runtimeSettings.api || {};
    const messages = runtimeSettings.messages || {};
    const media = runtimeSettings.media || {};

    const enabledEl = document.getElementById('opsAutoReplyEnabled');
    if (!enabledEl) return runtimeSettings;

    enabledEl.checked = Boolean(auto.enabled);
    const apiEnabled = document.getElementById('opsApiEnabled');
    if (apiEnabled) apiEnabled.checked = apiToggles.enabled !== false;
    const apiText = document.getElementById('opsApiSendTextEnabled');
    if (apiText) apiText.checked = apiToggles.sendTextEnabled !== false;
    const apiImage = document.getElementById('opsApiSendImageEnabled');
    if (apiImage) apiImage.checked = apiToggles.sendImageEnabled !== false;
    const apiDocument = document.getElementById('opsApiSendDocumentEnabled');
    if (apiDocument) apiDocument.checked = apiToggles.sendDocumentEnabled !== false;
    document.getElementById('opsAutoReplyScope').value = auto.scope || 'both';
    document.getElementById('opsAutoReplyMatchType').value = auto.matchType || 'contains';
    document.getElementById('opsAutoReplyMatchValue').value = String(auto.matchValue || '');
    document.getElementById('opsAutoReplyText').value = String(auto.text || '');
    document.getElementById('opsAutoReplyCooldownMs').value = Number(auto.cooldownMs || 0);
    document.getElementById('opsAutoReplyGroupPrefix').value = String(auto.groupPrefix || '');

    const setNum = (id, v) => {
      const el = document.getElementById(id);
      if (el) el.value = Number(v || 0);
    };
    setNum('opsQueueBaseDelayMs', queue.baseDelayMs);
    setNum('opsQueueJitterMs', queue.jitterMs);
    setNum('opsQueuePerJidGapMs', queue.perJidGapMs);
    setNum('opsQueueGlobalMinGapMs', queue.globalMinGapMs);
    setNum('opsQueueMaxRetries', queue.maxRetries);
    setNum('opsQueueRetryBackoffMs', queue.retryBackoffMs);
    const quiet = queue.quietHours || {};
    const quietEnabled = document.getElementById('opsQueueQuietEnabled');
    if (quietEnabled) quietEnabled.checked = Boolean(quiet.enabled);
    const quietStart = document.getElementById('opsQueueQuietStart');
    if (quietStart) quietStart.value = String(quiet.start || '22:00');
    const quietEnd = document.getElementById('opsQueueQuietEnd');
    if (quietEnd) quietEnd.value = String(quiet.end || '06:00');
    const quietTz = document.getElementById('opsQueueQuietTz');
    if (quietTz) quietTz.value = String(quiet.tz || 'Africa/Johannesburg');
    setNum('opsRateLimitWindowMs', rateLimit.windowMs);
    setNum('opsRateLimitMax', rateLimit.max);
    setNum('opsMessagesUiFetchLimit', messages.uiFetchLimit || 500);
    setNum('opsMessagesPersistMax', messages.persistMax || 0);
    setNum('opsMediaUrlTtlSeconds', media.urlTtlSeconds);
    setNum('opsMediaRetentionDays', media.retentionDays || 7);
    chatFetchLimit = Math.min(Math.max(Number(messages.uiFetchLimit || 500), 50), 2000);
    const metaEl = document.getElementById('opsRuntimeMeta');
    if (metaEl) metaEl.textContent = formatSettingsMeta(runtimeSettings.lastSavedBy, runtimeSettings.updatedAt);
    return runtimeSettings;
  } catch (e) {
    if (!silent) toast(e.message, false);
    return {};
  }
}

async function saveRuntimeSettings() {
  try {
    const payload = {
      autoReply: {
        enabled: Boolean(document.getElementById('opsAutoReplyEnabled')?.checked),
        scope: document.getElementById('opsAutoReplyScope')?.value || 'both',
        matchType: document.getElementById('opsAutoReplyMatchType')?.value || 'contains',
        matchValue: (document.getElementById('opsAutoReplyMatchValue')?.value || '').trim(),
        text: (document.getElementById('opsAutoReplyText')?.value || '').trim(),
        cooldownMs: Number(document.getElementById('opsAutoReplyCooldownMs')?.value || 0),
        groupPrefix: (document.getElementById('opsAutoReplyGroupPrefix')?.value || '').trim()
      },
      queue: {
        baseDelayMs: Number(document.getElementById('opsQueueBaseDelayMs')?.value || 0),
        jitterMs: Number(document.getElementById('opsQueueJitterMs')?.value || 0),
        perJidGapMs: Number(document.getElementById('opsQueuePerJidGapMs')?.value || 0),
        globalMinGapMs: Number(document.getElementById('opsQueueGlobalMinGapMs')?.value || 0),
        maxRetries: Number(document.getElementById('opsQueueMaxRetries')?.value || 0),
        retryBackoffMs: Number(document.getElementById('opsQueueRetryBackoffMs')?.value || 0),
        quietHours: {
          enabled: Boolean(document.getElementById('opsQueueQuietEnabled')?.checked),
          start: (document.getElementById('opsQueueQuietStart')?.value || '22:00').trim() || '22:00',
          end: (document.getElementById('opsQueueQuietEnd')?.value || '06:00').trim() || '06:00',
          tz: (document.getElementById('opsQueueQuietTz')?.value || 'Africa/Johannesburg').trim() || 'Africa/Johannesburg'
        }
      },
      rateLimit: {
        windowMs: Number(document.getElementById('opsRateLimitWindowMs')?.value || 0),
        max: Number(document.getElementById('opsRateLimitMax')?.value || 0)
      },
      api: {
        enabled: Boolean(document.getElementById('opsApiEnabled')?.checked),
        sendTextEnabled: Boolean(document.getElementById('opsApiSendTextEnabled')?.checked),
        sendImageEnabled: Boolean(document.getElementById('opsApiSendImageEnabled')?.checked),
        sendDocumentEnabled: Boolean(document.getElementById('opsApiSendDocumentEnabled')?.checked)
      },
      messages: {
        uiFetchLimit: Number(document.getElementById('opsMessagesUiFetchLimit')?.value || 500),
        persistMax: Number(document.getElementById('opsMessagesPersistMax')?.value || 0)
      },
      media: {
        urlTtlSeconds: Number(document.getElementById('opsMediaUrlTtlSeconds')?.value || 0),
        retentionDays: Number(document.getElementById('opsMediaRetentionDays')?.value || 7)
      }
    };

    await api('/admin/settings/runtime', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    toast('Runtime settings saved', true);
    await loadRuntimeSettings(true);
  } catch (e) {
    toast(e.message, false);
  }
}

async function forceLogout() {
  try {
    await api('/admin/force-logout', { method: 'POST' });
    toast('Logout requested', true);
  } catch (e) {
    toast(e.message, false);
  }
}

async function refreshGroupCache() {
  try {
    await api('/admin/group-cache/refresh', { method: 'POST' });
    toast('Group cache refreshed', true);
    await loadGroups();
  } catch (e) {
    toast(e.message, false);
  }
}

async function testN8n() {
  try {
    await api('/admin/automations/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Test message from Watson' })
    });
    toast('n8n test sent', true);
  } catch (e) {
    toast(e.message, false);
  }
}

// LOGOUT
async function logout() {
  try {
    await api('/admin/logout', { method: 'POST' });
  } catch {}
  window.location.href = '/admin/login';
}

// Utility
function esc(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Bootstrap
async function init() {
  try {
    initOpsMode();
    renderWebhookRows([]);
    await loadChats();
    await loadContacts();
    await loadGroups();
    await loadRules();
    await loadTemplates();
    resetRuleForm();
    resetTemplateForm();
    initializeUnreadCountsFromChats();
    toast('Connected', true);
    updateQuoteHints();
    connectMessagesStream();

    const sel = document.getElementById('chatSelect');
    if (sel && sel.options.length > 1) {
      sel.selectedIndex = 1;
      await selectChat();
    }
  } catch (e) {
    toast(e.message, false);
  }
}

updateSendForm();
init();
