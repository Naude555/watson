import 'dotenv/config'
import express from 'express'
import multer from 'multer'
import P from 'pino'
import qrcode from 'qrcode-terminal'
import QRCode from 'qrcode'
import fs from 'fs'
import path from 'path'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import BullMQ from 'bullmq'
const { Queue, Worker, QueueEvents } = BullMQ

import IORedis from 'ioredis'
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  downloadMediaMessage
} from '@whiskeysockets/baileys'


/**
 * ----------------------------
 * Config
 * ----------------------------
 */
const PORT = Number(process.env.PORT || 3000)

// Normal API key (x-api-key)
const API_KEY = process.env.WA_API_KEY || ''
const REQUIRE_API_KEY = Boolean(API_KEY)

// Admin key (x-admin-key)
const ADMIN_KEY = process.env.WA_ADMIN_KEY || ''
const REQUIRE_ADMIN_KEY = Boolean(ADMIN_KEY)

// Files
const CONTACTS_FILE = process.env.CONTACTS_FILE || '/data/contacts.json'

// IMPORTANT: persistent message store (JSON) (survives container rebuilds if /data mounted)
const MESSAGES_STORE_FILE = process.env.MESSAGES_FILE || '/data/messages.json'
const MESSAGES_MAX = Number(process.env.MESSAGES_MAX || 20000)

// In-memory UI cache (fast polling)
const MESSAGES_MEMORY_LIMIT = Number(process.env.MESSAGES_MEMORY_LIMIT || 1500)

// Uploads
const UPLOAD_DIR = process.env.UPLOAD_DIR || './uploads'
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true })
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 20)

// URL fetch (for image/document URL sending)
const MAX_URL_FETCH_MB = Number(process.env.MAX_URL_FETCH_MB || 20)
const URL_FETCH_TIMEOUT_MS = Number(process.env.URL_FETCH_TIMEOUT_MS || 20000)

// Auto reply
const AUTO_REPLY_ENABLED = String(process.env.AUTO_REPLY_ENABLED || 'false') === 'true'
const AUTO_REPLY_SCOPE = process.env.AUTO_REPLY_SCOPE || 'both' // dm | group | both
const AUTO_REPLY_MATCH_TYPE = process.env.AUTO_REPLY_MATCH_TYPE || 'contains' // contains | equals | regex
const AUTO_REPLY_MATCH_VALUE = process.env.AUTO_REPLY_MATCH_VALUE || 'help'
const AUTO_REPLY_TEXT = process.env.AUTO_REPLY_TEXT || 'Hi 👋 How can I help?'
const AUTO_REPLY_COOLDOWN_MS = Number(process.env.AUTO_REPLY_COOLDOWN_MS || 30000)
const AUTO_REPLY_GROUP_PREFIX = process.env.AUTO_REPLY_GROUP_PREFIX || '!bot'
const lastAutoReplyAt = new Map()

// ----------------------------
// n8n Automations (simple, file-backed)
// ----------------------------
const AUTOMATIONS_FILE = process.env.AUTOMATIONS_FILE || '/data/automations.json'
const N8N_WEBHOOK_URL_DEFAULT = String(process.env.N8N_WEBHOOK_URL || '').trim()
const N8N_SHARED_SECRET_DEFAULT = String(process.env.N8N_SHARED_SECRET || '').trim()

// Queue throttle
const BASE_DELAY_MS = Number(process.env.WA_BASE_DELAY_MS || 900)
const JITTER_MS = Number(process.env.WA_JITTER_MS || 600)
const PER_JID_GAP_MS = Number(process.env.WA_PER_JID_GAP_MS || 1500)

const MAX_RETRIES = Number(process.env.WA_MAX_RETRIES || 3)
const RETRY_BACKOFF_MS = Number(process.env.WA_RETRY_BACKOFF_MS || 1500)

// Rate limit (non-admin, non-pairing)
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60000)
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 120)

// ESM __dirname equivalent
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// UI directory (mount your html here)
const UI_DIR = process.env.UI_DIR || path.join(__dirname, 'ui')


// Signed media URLs (no x-admin-key needed in browser)
const MEDIA_SIGNING_SECRET = String(process.env.MEDIA_SIGNING_SECRET || '').trim()

// ----------------------------
// Redis (for queue, optional)
// ----------------------------
const REDIS_URL = String(process.env.REDIS_URL || 'redis://redis:6379')
const WA_QUEUE_NAME = String(process.env.WA_QUEUE_NAME || 'wa-send')

// Optional global limiter (in addition to your BASE/JITTER)
const WA_GLOBAL_MIN_GAP_MS = Number(process.env.WA_GLOBAL_MIN_GAP_MS || 0)


function defaultAutomationsConfig() {
  return {
    enabled: Boolean(N8N_WEBHOOK_URL_DEFAULT),
    webhookUrl: N8N_WEBHOOK_URL_DEFAULT,
    sharedSecret: N8N_SHARED_SECRET_DEFAULT,
    // global forwarding switches
    forward: { text: true, image: true, document: true, other: false },
    // defaults applied to all chats unless overridden
    defaults: {
      enabled: true,
      // direct message handling
      // If false, do not forward any DMs to n8n.
      dmEnabled: true,
      // When true, ANY forwarded message (DM or group) must start with the prefix.
      // This gives a consistent "bot" experience and avoids accidental forwarding.
      requirePrefixForAll: true,
      // group handling:
      // - 'all' forwards all messages
      // - 'prefix' forwards only when message starts with prefix (e.g. "!bot hi")
      groupMode: 'prefix',
      groupPrefix: String(process.env.N8N_GROUP_PREFIX || '!bot'),
      // quiet hours in Africa/Johannesburg by default
      quietHours: { enabled: false, start: '22:00', end: '06:00', tz: 'Africa/Johannesburg' },
      // basic rate limit per chat (forwarding to n8n, not WhatsApp sending)
      rateLimit: { enabled: true, maxPerMinute: 30 },
      // safety toggles
      safety: {
        // if true, do not forward messages from groups unless groupMode allows it
        allowGroups: true,
        // if true, do not forward DMs
        allowDM: true,
        // if true, do not forward media
        blockMedia: false
      },
      // templates (optional metadata for n8n)
      templates: []
    },
    // per chat/group overrides keyed by jid
    perChat: {
      // "<jid>": { enabled: false, groupMode:'all', ... }
    }
  }
}

function readJsonFileSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback
    const raw = fs.readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : fallback
  } catch {
    return fallback
  }
}

function writeJsonFileAtomic(filePath, obj) {
  const tmp = filePath + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2))
  fs.renameSync(tmp, filePath)
}

let automations = readJsonFileSafe(AUTOMATIONS_FILE, defaultAutomationsConfig())

function saveAutomations() {
  try { writeJsonFileAtomic(AUTOMATIONS_FILE, automations) } catch (e) {
    console.warn('⚠️ Failed to save automations config:', e?.message)
  }
}

function mergeDeep(base, override) {
  if (!override || typeof override !== 'object') return base
  const out = Array.isArray(base) ? base.slice() : { ...(base || {}) }
  for (const [k, v] of Object.entries(override)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = mergeDeep(out[k] || {}, v)
    } else {
      out[k] = v
    }
  }
  return out
}

function getAutomationRuleForChat(chatJid) {
  const base = automations?.defaults || defaultAutomationsConfig().defaults
  const override = (automations?.perChat && automations.perChat[chatJid]) ? automations.perChat[chatJid] : null
  return mergeDeep(base, override || {})
}

// Quiet hours: returns true if within quiet period (meaning "do NOT forward")
function isWithinQuietHours(rule) {
  const q = rule?.quietHours
  if (!q?.enabled) return false
  const tz = q.tz || 'Africa/Johannesburg'

  // Use Intl DateTimeFormat to get hh:mm in the configured timezone
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(new Date())

  const hh = Number(parts.find(p => p.type === 'hour')?.value || '0')
  const mm = Number(parts.find(p => p.type === 'minute')?.value || '0')
  const now = hh * 60 + mm

  const [sh, sm] = String(q.start || '00:00').split(':').map(Number)
  const [eh, em] = String(q.end || '00:00').split(':').map(Number)
  const start = (Number.isFinite(sh) ? sh : 0) * 60 + (Number.isFinite(sm) ? sm : 0)
  const end = (Number.isFinite(eh) ? eh : 0) * 60 + (Number.isFinite(em) ? em : 0)

  // Handles overnight windows (e.g. 22:00 → 06:00)
  if (start === end) return false
  if (start < end) return now >= start && now < end
  return now >= start || now < end
}

// Per-chat forwarding rate limiter
const forwardRate = new Map() // chatJid -> { windowStartMs, count }
function rateLimitOk(chatJid, rule) {
  const rl = rule?.rateLimit
  if (!rl?.enabled) return true
  const maxPerMin = Math.max(1, Number(rl.maxPerMinute || 30))
  const now = Date.now()
  const win = forwardRate.get(chatJid) || { windowStartMs: now, count: 0 }
  if (now - win.windowStartMs >= 60_000) {
    win.windowStartMs = now
    win.count = 0
  }
  if (win.count >= maxPerMin) {
    forwardRate.set(chatJid, win)
    return false
  }
  win.count++
  forwardRate.set(chatJid, win)
  return true
}

function shouldForwardToN8n(rec, textForRules) {
  if (!automations?.enabled) return false
  if (!automations.webhookUrl) return false

  const rule = getAutomationRuleForChat(rec.chatJid)
  if (!rule.enabled) return false

  // Safety toggles
  if (rec.isGroup && rule.safety?.allowGroups === false) return false
  if (!rec.isGroup && rule.safety?.allowDM === false) return false
  if (!rec.isGroup && rule.dmEnabled === false) return false
  if (rule.safety?.blockMedia && rec.type !== 'text') return false

  // Global forward switches
  const f = automations.forward || {}
  if (rec.type === 'text' && f.text === false) return false
  if (rec.type === 'image' && f.image === false) return false
  if (rec.type === 'document' && f.document === false) return false
  if (!['text', 'image', 'document'].includes(rec.type) && f.other === false) return false

  // Quiet hours
  if (isWithinQuietHours(rule)) return false

  // Rate limit
  if (!rateLimitOk(rec.chatJid, rule)) return false

  // Prefix gating (consistent bot UX): when enabled, both DM and group forwarding
  // require the message to begin with the prefix.
  const requirePrefixAll = rule.requirePrefixForAll !== false

  // Helper for prefix match (accept "!bot hi", "!bot: hi", "!bot, hi", "!bot - hi")
  const prefixMatch = () => {
    const p = String(rule.groupPrefix || '!bot').trim()
    if (!p) return true
    const t = String(textForRules || '').trim()
    const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`^${escaped}(?:\\s|:|,|-)+`, 'i')
    return re.test(t) || t.toLowerCase() === p.toLowerCase()
  }

  // If requirePrefixForAll: apply prefix gate to DMs and groups
  if (requirePrefixAll) {
    return prefixMatch()
  }

  // Otherwise: legacy behaviour
  if (rec.isGroup) {
    const mode = String(rule.groupMode || 'prefix')
    if (mode === 'all') return true
    if (mode === 'prefix') return prefixMatch()
  }

  return true
}

// Simple signing for app -> n8n webhook
function n8nSig(secret, bodyString) {
  if (!secret) return ''
  return crypto.createHmac('sha256', secret).update(bodyString).digest('hex')
}

// Forward queue (memory) with retries (simple)
const n8nQueue = []
let n8nWorkerRunning = false

function enqueueN8nEvent(evt) {
  n8nQueue.push(evt)
  startN8nWorker()
}

async function startN8nWorker() {
  if (n8nWorkerRunning) return
  n8nWorkerRunning = true
  while (n8nQueue.length) {
    const job = n8nQueue.shift()
    try {
      await postToN8n(job)
    } catch (e) {
      const attempts = (job.attempts || 0) + 1
      if (attempts <= 5) {
        const backoff = Math.min(30_000, 1_000 * attempts * attempts)
        job.attempts = attempts
        // requeue after backoff
        setTimeout(() => enqueueN8nEvent(job), backoff)
      } else {
        console.warn('⚠️ n8n forward failed (giving up):', e?.message)
      }
    }
  }
  n8nWorkerRunning = false
}

async function postToN8n(evt) {
  const url = String(automations.webhookUrl || '').trim()
  if (!url) return

  const bodyString = JSON.stringify(evt)
  const headers = { 'Content-Type': 'application/json' }

  // optional shared secret header (no crypto)
  const secret = String(automations.sharedSecret || '').trim();
  if (secret) headers['x-watson-secret'] = secret;


  // Basic fetch with timeout
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), 15_000)
  try {
    const res = await fetch(url, { method: 'POST', headers, body: bodyString, signal: controller.signal })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`n8n HTTP ${res.status}: ${text || res.statusText}`)
    }
  } finally {
    clearTimeout(t)
  }
}

function buildN8nEvent(rec, rawText) {
  const rule = getAutomationRuleForChat(rec.chatJid)
  const mediaSignedUrl = rec.media?.fileName ? signMediaUrl(rec.media.fileName) : null
  return {
    event: 'inbound_message',
    eventId: rec.id,
    ts: rec.ts,
    chatJid: rec.chatJid,
    isGroup: rec.isGroup,
    senderJid: rec.senderJid,
    type: rec.type,
    text: rec.text,
    rawText: rawText ? String(rawText) : null,
    media: rec.media ? {
      fileName: rec.media.fileName || null,
      mimetype: rec.media.mimetype || null,
      localPath: rec.media.path || null, // optional (n8n usually can't access this)
      signedUrl: mediaSignedUrl
    } : null,
    rule: {
      // pass only safe subset
      groupMode: rule.groupMode,
      groupPrefix: rule.groupPrefix,
      templates: rule.templates || []
    }
  }
}

const redis = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
})

const sendQueue = new Queue(WA_QUEUE_NAME, {
  connection: redis,
  defaultJobOptions: {
    removeOnComplete: 2000,
    removeOnFail: 5000,
    attempts: (MAX_RETRIES ?? 3) + 1, // include first attempt
    backoff: { type: 'exponential', delay: RETRY_BACKOFF_MS ?? 1500 },
  },
})

// QueueEvents must use its own Redis connection
const queueEventsConn = redis.duplicate()
const queueEvents = new QueueEvents(WA_QUEUE_NAME, { connection: queueEventsConn })

queueEvents.on('completed', ({ jobId }) => console.log('✅ job completed', jobId))
queueEvents.on('failed', ({ jobId, failedReason }) => console.log('❌ job failed', jobId, failedReason))

if (!MEDIA_SIGNING_SECRET) {
  console.warn('⚠️ MEDIA_SIGNING_SECRET not set. Signed media links will NOT work securely.')
}
const MEDIA_URL_TTL_SECONDS = Number(process.env.MEDIA_URL_TTL_SECONDS || 60 * 60 * 24 * 2) // 2 days

function hmacHex(input) {
  return crypto.createHmac('sha256', MEDIA_SIGNING_SECRET).update(input).digest('hex')
}

function signMediaUrl(fileName, ttlSeconds = MEDIA_URL_TTL_SECONDS) {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds
  const payload = `${fileName}|${exp}`
  const sig = hmacHex(payload)
  return `/media/${encodeURIComponent(fileName)}?exp=${exp}&sig=${sig}`
}


function verifyMediaSignature(fileName, exp, sig) {
  if (!MEDIA_SIGNING_SECRET) return { ok: false, reason: 'no-secret' }

  const expSec = Number(exp)
  if (!fileName || !Number.isFinite(expSec) || !sig) return { ok: false, reason: 'missing' }

  const nowSec = Math.floor(Date.now() / 1000)
  if (expSec < nowSec) return { ok: false, reason: 'expired', payload: `${fileName}|${expSec}` }

  const payload = `${fileName}|${expSec}`
  const expected = hmacHex(payload)

  try {
    const a = Buffer.from(String(sig), 'hex')
    const b = Buffer.from(String(expected), 'hex')
    if (a.length !== b.length) return { ok: false, reason: 'len', payload, expected }
    const ok = crypto.timingSafeEqual(a, b)
    return { ok, reason: ok ? 'ok' : 'bad-sig', payload, expected }
  } catch {
    return { ok: false, reason: 'bad-format', payload, expected }
  }
}



console.log('🤖 Settings:', {
  REQUIRE_API_KEY,
  REQUIRE_ADMIN_KEY,
  AUTO_REPLY_ENABLED,
  AUTO_REPLY_SCOPE,
  AUTO_REPLY_MATCH_TYPE,
  AUTO_REPLY_MATCH_VALUE,
  AUTO_REPLY_GROUP_PREFIX,
  MAX_URL_FETCH_MB,
  URL_FETCH_TIMEOUT_MS,
  MESSAGES_STORE_FILE,
  MESSAGES_MAX,
  MESSAGES_MEMORY_LIMIT
})

/**
 * ----------------------------
 * Helpers
 * ----------------------------
 */
function norm(s) { return String(s || '').trim().toLowerCase() }
function makeId(prefix = 'job') { return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}` }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
function calcDelay() { return BASE_DELAY_MS + Math.floor(Math.random() * JITTER_MS) }
function isGroupJid(jid) { return typeof jid === 'string' && jid.endsWith('@g.us') }

function extractTextMessage(msg) {
  return (
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption ||
    null
  )
}

/**
 * "!bot hi" / "!bot: hi" / "!bot, hi" / "!bot - hi"
 */
function stripGroupPrefix(text) {
  const t = String(text || '').trim()
  const p = String(AUTO_REPLY_GROUP_PREFIX || '').trim()
  if (!p) return { ok: true, text: t }

  const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`^${escaped}(?:\\s|:|,|-)+`, 'i')

  if (re.test(t)) return { ok: true, text: t.replace(re, '').trim() }
  if (t.toLowerCase() === p.toLowerCase()) return { ok: true, text: '' }
  return { ok: false, text: t }
}

function matchesAutoReply(text) {
  const t = String(text || '').trim()
  const v = String(AUTO_REPLY_MATCH_VALUE || '').trim()
  if (!t || !v) return false

  if (AUTO_REPLY_MATCH_TYPE === 'equals') return t.toLowerCase() === v.toLowerCase()
  if (AUTO_REPLY_MATCH_TYPE === 'contains') return t.toLowerCase().includes(v.toLowerCase())
  if (AUTO_REPLY_MATCH_TYPE === 'regex') {
    try { return new RegExp(v, 'i').test(t) } catch { return false }
  }
  return false
}

// SA normalization
function toUserJid(msisdn) {
  const raw = String(msisdn || '').trim()
  if (!raw) throw new Error('Invalid phone number (msisdn)')

  let digits = raw.replace(/[^\d]/g, '')
  if (digits.startsWith('00')) digits = digits.slice(2)
  if (digits.startsWith('0')) digits = '27' + digits.slice(1)
  if (digits.length < 9) throw new Error('Invalid phone number (too short)')

  return `${digits}@s.whatsapp.net`
}

function looksLikePhone(input) {
  const digits = String(input || '').replace(/[^\d]/g, '')
  return digits.length >= 9 && digits.length <= 15
}

/**
 * Fetch remote URL to Buffer (avoid Baileys fetch stream)
 */
async function fetchToBuffer(url, maxBytes) {
  const u = String(url || '').trim()
  if (!u) throw new Error('Missing URL')
  if (!/^https?:\/\//i.test(u)) throw new Error('URL must start with http:// or https://')

  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), URL_FETCH_TIMEOUT_MS)

  try {
    const res = await fetch(u, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': 'wa-api/1.0 (+https://localhost)' }
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching URL`)

    const ab = await res.arrayBuffer()
    const buf = Buffer.from(ab)

    if (buf.length > maxBytes) {
      throw new Error(`Remote file too large (${Math.ceil(buf.length / 1024 / 1024)}MB). Max ${Math.ceil(maxBytes / 1024 / 1024)}MB`)
    }

    const ct = res.headers.get('content-type') || ''
    return { buffer: buf, contentType: ct }
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error(`Timeout fetching URL after ${URL_FETCH_TIMEOUT_MS}ms`)
    throw e
  } finally {
    clearTimeout(t)
  }
}

/**
 * Uploads helpers images
 */

function extFromMime(mime='') {
  const m = String(mime).toLowerCase()
  if (m.includes('jpeg')) return 'jpg'
  if (m.includes('png')) return 'png'
  if (m.includes('webp')) return 'webp'
  if (m.includes('gif')) return 'gif'
  if (m.includes('pdf')) return 'pdf'
  if (m.includes('msword')) return 'doc'
  if (m.includes('officedocument.wordprocessingml')) return 'docx'
  if (m.includes('ms-excel')) return 'xls'
  if (m.includes('officedocument.spreadsheetml')) return 'xlsx'
  if (m.includes('text/plain')) return 'txt'
  return 'bin'
}

function safeBase(name='file') {
  return String(name).replace(/[^a-zA-Z0-9.\-_]/g, '_').slice(0, 120) || 'file'
}

/**
 * Download inbound media to disk so admin UI can preview it.
 * Returns { localPath, localUrl, mimetype, fileName }
 */
async function saveInboundMedia(msg, kind, idHint='in') {
  const node =
    kind === 'image' ? msg.message?.imageMessage :
    kind === 'document' ? msg.message?.documentMessage :
    kind === 'video' ? msg.message?.videoMessage :
    null

  if (!node) return null

  const mimetype = node.mimetype || ''
  const fileNameRaw = node.fileName || `${idHint}_${kind}.${extFromMime(mimetype)}`
  const fileName = safeBase(fileNameRaw)
  const ext = extFromMime(mimetype)
  const outName = `${idHint}_${kind}.${ext}`
  const outPath = path.join(UPLOAD_DIR, outName)

  // downloadMediaMessage needs sock.updateMediaMessage for reupload flow
  const buf = await downloadMediaMessage(
    msg,
    'buffer',
    {},
    { logger: P({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
  )

  fs.writeFileSync(outPath, buf)

  return {
    localPath: outPath,
    localUrl: signMediaUrl(outName),
    mimetype,
    fileName
  }
}

/**
 * Save outbound buffers (URL-buffer sends) to disk so UI can preview.
 */
function saveOutboundBufferToDisk(buf, kind, idHint, mimetype, fileNameHint) {
  const ext = extFromMime(mimetype)
  const outName = `${idHint}_${kind}.${ext}`
  const outPath = path.join(UPLOAD_DIR, outName)
  fs.writeFileSync(outPath, buf)
  return {
    localPath: outPath,
    localUrl: signMediaUrl(outName),
    mimetype,
    fileName: safeBase(fileNameHint || outName)
  }
}


/**
 * ----------------------------
 * Contacts store
 * ----------------------------
 */
function ensureContactsStore() {
  if (fs.existsSync(CONTACTS_FILE)) return
  fs.mkdirSync(path.dirname(CONTACTS_FILE), { recursive: true })
  const initial = { contacts: [], groups: [], updatedAt: Date.now() }
  fs.writeFileSync(CONTACTS_FILE, JSON.stringify(initial, null, 2))
  console.log(`📒 Created contacts store: ${CONTACTS_FILE}`)
}

function readContactsStore() {
  ensureContactsStore()
  try { return JSON.parse(fs.readFileSync(CONTACTS_FILE, 'utf8')) }
  catch { return { contacts: [], groups: [], updatedAt: Date.now() } }
}

function writeContactsStore(store) {
  const next = { ...store, updatedAt: Date.now() }
  fs.writeFileSync(CONTACTS_FILE, JSON.stringify(next, null, 2))
  return next
}

function upsertContact(store, contact) {
  const key = norm(contact.name)
  if (!key) throw new Error('Contact name required')

  const idx = store.contacts.findIndex(c => norm(c.name) === key)
  if (idx >= 0) store.contacts[idx] = { ...store.contacts[idx], ...contact }
  else store.contacts.push(contact)
  return store
}

function deleteContact(store, name) {
  const before = store.contacts.length
  store.contacts = store.contacts.filter(c => norm(c.name) !== norm(name))
  return before !== store.contacts.length
}

function upsertGroupAlias(store, group) {
  const key = norm(group.name)
  if (!key) throw new Error('Group alias name required')
  if (!String(group.jid || '').endsWith('@g.us')) throw new Error('Group jid must end with @g.us')

  const idx = store.groups.findIndex(g => norm(g.name) === key)
  if (idx >= 0) store.groups[idx] = { ...store.groups[idx], ...group }
  else store.groups.push(group)
  return store
}

function deleteGroupAlias(store, name) {
  const before = store.groups.length
  store.groups = store.groups.filter(g => norm(g.name) !== norm(name))
  return before !== store.groups.length
}

/**
 * ----------------------------
 * Persistent message store (JSON)
 * ----------------------------
 */
function ensureMessagesStore() {
  if (fs.existsSync(MESSAGES_STORE_FILE)) return
  fs.mkdirSync(path.dirname(MESSAGES_STORE_FILE), { recursive: true })
  const initial = { messages: [], updatedAt: Date.now() }
  fs.writeFileSync(MESSAGES_STORE_FILE, JSON.stringify(initial, null, 2))
  console.log(`💬 Created messages store: ${MESSAGES_STORE_FILE}`)
}

function readMessagesStore() {
  ensureMessagesStore()
  try { return JSON.parse(fs.readFileSync(MESSAGES_STORE_FILE, 'utf8')) }
  catch { return { messages: [], updatedAt: Date.now() } }
}

function writeMessagesStore(store) {
  const next = { ...store, updatedAt: Date.now() }
  fs.writeFileSync(MESSAGES_STORE_FILE, JSON.stringify(next, null, 2))
  return next
}

function payloadType(payload) {
  if (!payload || typeof payload !== 'object') return 'unknown'
  if (payload.text) return 'text'
  if (payload.image) return 'image'
  if (payload.document) return 'document'
  return 'unknown'
}

function addMessageRecord(rec) {
  const store = readMessagesStore()
  const msg = {
    id: rec.id || makeId('msg'),
    ts: rec.ts || Date.now(),
    direction: rec.direction || 'in', // in | out
    chatJid: String(rec.chatJid || ''),
    senderJid: rec.senderJid ? String(rec.senderJid) : '',
    isGroup: Boolean(rec.isGroup),
    type: rec.type || 'text',
    text: rec.text ? String(rec.text) : '',
    media: rec.media || null,
    status: rec.status || null
  }

  if (!msg.chatJid) return msg

  store.messages.push(msg)
  if (store.messages.length > MESSAGES_MAX) {
    store.messages.splice(0, store.messages.length - MESSAGES_MAX)
  }
  writeMessagesStore(store)
  return msg
}

function updateMessageStatus(id, patch) {
  const store = readMessagesStore();
  const idx = store.messages.findIndex(m => m.id === id);
  if (idx === -1) return null;

  const nextPatch = { ...patch, statusTs: Date.now() };   // ✅ add
  store.messages[idx] = { ...store.messages[idx], ...nextPatch };
  writeMessagesStore(store);
  return store.messages[idx];
}


/**
 * ----------------------------
 * In-memory message cache (for UI polling)
 * ----------------------------
 */
const recentMessages = []
const chatIndex = new Map() // chatJid -> summary


/**
 * Bootstrap: load last N messages from persistent store into memory
 */
function hydrateInMemoryFromStore() {
  try {
    const store = readMessagesStore()
    const all = Array.isArray(store.messages) ? store.messages : []
    const tail = all.slice(-MESSAGES_MEMORY_LIMIT)

    for (const m of tail) {
      upsertRecentMessage({
        ts: m.ts,
        chatJid: m.chatJid,
        senderJid: m.senderJid,
        id: m.id,
        isGroup: Boolean(m.isGroup),
        text: m.text || '',
        direction: m.direction || 'in',
        status: m.status || null,
        type: m.type || 'text',
        media: m.media || null,          // ✅ ADD THIS
      })
    }

    console.log(`💾 Hydrated ${tail.length} messages into memory cache`)
  } catch (e) {
    console.warn('⚠️ Failed to hydrate messages:', e?.message)
  }
}


/**
 * ----------------------------
 * Group cache
 * ----------------------------
 */
let groupCache = {
  updatedAt: 0,
  byJid: new Map(),
  byName: new Map()
}

let sock = null
async function refreshGroups() {
  if (!sock) throw new Error('WhatsApp socket not ready')
  const groups = await sock.groupFetchAllParticipating()

  const byJid = new Map()
  const byName = new Map()

  for (const g of Object.values(groups)) {
    const jid = g.id
    const subject = (g.subject || '').trim()
    const key = norm(subject)
    const item = { jid, subject }

    byJid.set(jid, item)
    if (!byName.has(key)) byName.set(key, [])
    byName.get(key).push(item)
  }

  groupCache = { updatedAt: Date.now(), byJid, byName }
  console.log(`👥 Group cache updated: ${byJid.size} groups`)
  return { count: byJid.size, updatedAt: groupCache.updatedAt }
}

function findGroupCachedByName(groupName) {
  const needle = norm(groupName)
  if (!needle) return { matches: [] }

  const exact = groupCache.byName.get(needle) || []
  if (exact.length) return { matches: exact }

  const matches = []
  for (const g of groupCache.byJid.values()) {
    if (norm(g.subject).includes(needle)) matches.push(g)
  }
  return { matches }
}

/**
 * Resolver: jid | phone | admin contact name | admin group alias | WA subject cache
 */
async function resolveToJid(toRaw) {
  const to = String(toRaw || '').trim()
  if (!to) throw new Error('Missing "to"')

  if (to.includes('@')) return to
  if (looksLikePhone(to)) return toUserJid(to)

  const store = readContactsStore()
  const key = norm(to)

  const ga = store.groups.find(g => norm(g.name) === key)
  if (ga?.jid) return ga.jid

  const c = store.contacts.find(c => norm(c.name) === key)
  if (c?.jid) return c.jid
  if (c?.msisdn) return toUserJid(c.msisdn)

  const { matches } = findGroupCachedByName(to)
  if (matches.length === 1) return matches[0].jid
  if (matches.length > 1) {
    const err = new Error('Multiple groups matched. Use a group alias in admin or be more specific.')
    err.code = 'AMBIGUOUS_GROUP'
    err.matches = matches
    throw err
  }

  const err = new Error('Unresolved "to": not a jid/phone and not found in admin contacts/groups')
  err.code = 'UNRESOLVED_TO'
  throw err
}

/**
 * ----------------------------
 * Security middleware
 * ----------------------------
 */
function apiKeyMiddleware(req, res, next) {
  // public endpoints that must work without headers
  if (req.path.startsWith('/pairing/')) return next()
  if (req.path.startsWith('/admin/')) return next()

  // ✅ signed media must be accessible without x-api-key
  if (req.path.startsWith('/media/')) return next()

  // ✅ avoid noise
  if (req.path === '/favicon.ico') return res.status(204).end()

  if (!REQUIRE_API_KEY) return next()
  const key = req.headers['x-api-key']
  if (key !== API_KEY) return res.status(401).json({ ok: false, error: 'Unauthorized' })
  next()
}

function adminKeyMiddleware(req, res, next) {
  if (!REQUIRE_ADMIN_KEY) return res.status(500).json({ ok: false, error: 'Admin key not set (WA_ADMIN_KEY)' })
  const key = req.headers['x-admin-key']
  if (key !== ADMIN_KEY) return res.status(401).json({ ok: false, error: 'Unauthorized' })
  next()
}

/**
 * ----------------------------
 * Multer
 * ----------------------------
 */
const multerStorage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOAD_DIR),
  filename: (_, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_')
    cb(null, `${Date.now()}_${safe}`)
  }
})

function fileFilter(req, file, cb) {
  const field = file.fieldname
  const mt = (file.mimetype || '').toLowerCase()
  if (field === 'image' && mt.startsWith('image/')) return cb(null, true)

  const docOk = [
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/plain'
  ].includes(mt)

  if (field === 'document' && (docOk || mt === 'application/octet-stream')) return cb(null, true)

  return cb(new Error(`Unsupported file type: ${file.mimetype}`))
}

const upload = multer({
  storage: multerStorage,
  fileFilter,
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 }
})

/**
 * ----------------------------
 * Baileys
 * ----------------------------
 */
let connectionStatus = 'disconnected'
let lastQR = null

// SSE
const sseClients = new Set()
function sseSend(res, event, data) {
  res.write(`event: ${event}\n`)
  res.write(`data: ${JSON.stringify(data)}\n\n`)
}
function broadcast(event, data) {
  for (const res of sseClients) {
    try { sseSend(res, event, data) } catch {}
  }
}

async function startWhatsApp() {
  connectionStatus = 'connecting'
  const { state, saveCreds } = await useMultiFileAuthState('./auth')

  sock = makeWASocket({
    auth: state,
    logger: P({ level: 'silent' }),
    getMessage: async () => undefined
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      lastQR = qr
      console.log('📲 Scan QR to pair (WhatsApp > Linked devices):')
      qrcode.generate(qr, { small: true })
      broadcast('qr', { qr })
      broadcast('status', { status: connectionStatus, hasQR: true })
    }

    if (connection === 'open') {
      connectionStatus = 'open'
      lastQR = null
      console.log('✅ WhatsApp connected')
      try { await refreshGroups() } catch (e) { console.warn('⚠️ Group cache refresh failed:', e?.message) }
      broadcast('status', { status: connectionStatus, hasQR: false })
    }

    if (connection === 'close') {
      connectionStatus = 'disconnected'
      const statusCode = lastDisconnect?.error?.output?.statusCode
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut

      console.log('❌ WhatsApp connection closed. Reconnect?', shouldReconnect)
      broadcast('status', { status: connectionStatus, hasQR: Boolean(lastQR) })

      if (shouldReconnect) startWhatsApp()
      else console.log('⚠️ Logged out. Delete ./auth folder and pair again.')
    }
  })

  // Inbound messages
  sock.ev.on('messages.upsert', async ({ messages }) => {
  const msg = messages?.[0]
  if (!msg?.message) return

  const chatJid = msg.key.remoteJid
  const group = isGroupJid(chatJid)

  // ignore outgoing events here (we store outbound ourselves)
  if (msg.key.fromMe) return

  const senderJid = msg.key.participant || msg.key.remoteJid
  const msgId = msg.key.id || makeId('in')

  // Determine type + text
  const textRaw = extractTextMessage(msg)
  const hasImage = Boolean(msg.message?.imageMessage)
  const hasDoc = Boolean(msg.message?.documentMessage)

  let type = 'text'
  if (hasImage) type = 'image'
  else if (hasDoc) type = 'document'

  // Caption may be empty → still store placeholder
  let text = ''
  if (type === 'text') text = String(textRaw || '').trim()
  if (type === 'image') text = String(msg.message?.imageMessage?.caption || '').trim() || '[image]'
  if (type === 'document') {
    const fn = msg.message?.documentMessage?.fileName
    text = fn ? `[document] ${fn}` : '[document]'
  }

  // If it's a plain text message and still empty, skip
  if (type === 'text' && !text) return

  console.log(`📩 ${chatJid}: ${text}`)

  // If media, download it so the UI can preview
  let media = null
  try {
    if (type === 'image') media = await saveInboundMedia(msg, 'image', msgId)
    if (type === 'document') media = await saveInboundMedia(msg, 'document', msgId)
  } catch (e) {
    console.warn('⚠️ Failed to download inbound media:', e?.message)
  }

  const rec = {
    ts: Date.now(),
    chatJid,
    senderJid,
    id: msgId,
    isGroup: group,
    text,
    direction: 'in',
    status: null,
    type,
    media
  }

// Persist + memory
addMessageRecord(rec)      // your persistent store
upsertRecentMessage(rec)   // we’ll add this next

// Forward to n8n (if enabled + allowed by rules)
try {
  const textForRules = (type === 'text' ? text : (textRaw ? String(textRaw).trim() : ''))
  if (shouldForwardToN8n(rec, textForRules)) {
    enqueueN8nEvent(buildN8nEvent(rec, textForRules))
  }
} catch (e) {
  console.warn('⚠️ n8n forward (skipped):', e?.message)
}

// auto reply logic (optional / legacy)
if (AUTO_REPLY_ENABLED) {
  if (AUTO_REPLY_SCOPE === 'dm' && group) return
  if (AUTO_REPLY_SCOPE === 'group' && !group) return

  let textToMatch = (type === 'text' ? text : (textRaw ? String(textRaw).trim() : ''))
  if (group) {
    const { ok, text } = stripGroupPrefix(textToMatch)
    if (!ok) return
    textToMatch = text
    if (!textToMatch) return
  }

  if (!matchesAutoReply(textToMatch)) return

  const last = lastAutoReplyAt.get(chatJid) || 0
  if (Date.now() - last < AUTO_REPLY_COOLDOWN_MS) return
  lastAutoReplyAt.set(chatJid, Date.now())

  const outMsgId = makeId('out_auto')
  const payload = { text: String(AUTO_REPLY_TEXT) }

  const outRec = {
    id: outMsgId,
    direction: 'out',
    ts: Date.now(),
    chatJid,
    senderJid: 'me',
    isGroup: group,
    type: 'text',
    text: payload.text,
    status: 'queued',
    media: null
  }
  addMessageRecord(outRec)
  upsertRecentMessage(outRec)

  const toJid = chatJid
  const msgId = outMsgId

  await enqueue({
    id: makeId('auto_txt'),
    jid: toJid,
    payload,
    createdAt: Date.now(),
    msgId,
    chatJid: toJid
  })
  } // AUTO_REPLY_ENABLED
  })
}

function requireConnected(req, res, next) {
  if (connectionStatus !== 'open' || !sock) {
    return res.status(503).json({ ok: false, error: 'WhatsApp not connected', status: connectionStatus })
  }
  next()
}

/**
 * ----------------------------
 * Queue
 * ----------------------------
 */

async function enqueue(job) {
  // job: { id, jid, payload, msgId, chatJid, createdAt }
  const jobId = job.id || makeId('job')
  await sendQueue.add('send', job, { jobId })
  return jobId
}

let lastGlobalSendAt = 0

async function redisPerJidGate(jid) {
  // Durable per-JID last-send tracking in Redis
  const key = `wa:lastSendAt:${jid}`
  const now = Date.now()

  const last = await redis.get(key)
  const lastNum = last ? Number(last) : 0
  const since = now - lastNum

  if (since < PER_JID_GAP_MS) {
    await sleep(PER_JID_GAP_MS - since)
  }

  // set new timestamp
  await redis.set(key, String(Date.now()))
}

async function globalGate() {
  if (!WA_GLOBAL_MIN_GAP_MS) return
  const since = Date.now() - lastGlobalSendAt
  if (since < WA_GLOBAL_MIN_GAP_MS) await sleep(WA_GLOBAL_MIN_GAP_MS - since)
  lastGlobalSendAt = Date.now()
}

const worker = new Worker(
  WA_QUEUE_NAME,
  async (bullJob) => {
    const job = bullJob.data

    // Wait for WhatsApp connection (durable jobs should not fail just because WS is reconnecting)
    while (connectionStatus !== 'open' || !sock) {
      await sleep(1000)
    }

    // Durable per recipient pacing
    await redisPerJidGate(job.jid)

    // Optional global gate + your existing base/jitter delay
    await globalGate()

    try {
      await sock.sendMessage(job.jid, job.payload)

      if (job.msgId) {
        const updated = updateMessageStatus(job.msgId, { status: 'sent' })
        if (updated) upsertRecentMessage(updated)
      }

      // Natural pacing between sends
      await sleep(calcDelay())

      return { ok: true }
    } catch (err) {
      const msg = err?.message || String(err)

      if (job.msgId) {
        // Mark as failed only when job is truly out of attempts.
        // BullMQ will retry automatically — so mark "retrying" until final failure.
        const isLastAttempt = bullJob.attemptsMade + 1 >= bullJob.opts.attempts
        const nextStatus = isLastAttempt ? 'failed' : 'retrying'
        const updated = updateMessageStatus(job.msgId, { status: nextStatus })
        if (updated) upsertRecentMessage(updated)

      }

      throw err
    }
  },
  { connection: redis, concurrency: 1 }
)

worker.on('failed', (job, err) => {
  console.warn('❌ Queue job failed:', job?.id, err?.message || err)
})


const recentIndexById = new Map() // msgId -> index in recentMessages


function rebuildRecentIndex(){
  recentIndexById.clear()
  for (let i = 0; i < recentMessages.length; i++) {
    const id = recentMessages[i]?.id
    if (id) recentIndexById.set(id, i)
  }
}

/**
 * Upsert a message in memory cache by id.
 * - If record exists: merge patch.
 * - If not: push only if it has chatJid + ts (real message).
 * - DO NOT mutate chatIndex for status-only patches.
 */
function upsertRecentMessage(rec) {
  const normalized = {
    id: rec.id || makeId('msg'),
    ts: rec.ts || Date.now(),
    chatJid: rec.chatJid,
    senderJid: rec.senderJid || '',
    isGroup: Boolean(rec.isGroup),
    direction: rec.direction || 'in',
    status: rec.status ?? null,
    type: rec.type || 'text',
    text: rec.text || '',
    media: rec.media || null,   // ✅ KEEP
  }

  if (!normalized.chatJid) return

  const idx = recentIndexById.get(normalized.id)
  if (idx === undefined) {
    recentMessages.push(normalized)
    recentIndexById.set(normalized.id, recentMessages.length - 1)
    while (recentMessages.length > MESSAGES_MEMORY_LIMIT) {
      recentMessages.shift()
      recentIndexById.clear()
      for (let i = 0; i < recentMessages.length; i++) {
        if (recentMessages[i]?.id) recentIndexById.set(recentMessages[i].id, i)
      }
    }
  } else {
    recentMessages[idx] = { ...recentMessages[idx], ...normalized } // ✅ media merges too
  }

  const key = normalized.chatJid
  const prev = chatIndex.get(key) || { chatJid: key, isGroup: normalized.isGroup, count: 0, lastTs: 0, lastText: '', lastSenderJid: '' }
  chatIndex.set(key, {
    ...prev,
    isGroup: normalized.isGroup,
    count: (prev.count || 0) + 1,
    lastTs: Math.max(prev.lastTs || 0, normalized.ts || 0),
    lastText: normalized.text || prev.lastText || '',
    lastSenderJid: normalized.senderJid || prev.lastSenderJid || ''
  })
}



/**
 * ----------------------------
 * Express
 * ----------------------------
 */
const app = express()
app.disable('x-powered-by')
app.set('trust proxy', 1)

// allow inline scripts in admin/pairing UI
app.use(helmet({ contentSecurityPolicy: false }))

app.use(express.json({ limit: '25mb' }))

const limiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false
})
app.use((req, res, next) => {
  if (req.path.startsWith('/admin/')) return next()
  if (req.path.startsWith('/pairing/')) return next()
  return limiter(req, res, next)
})

app.use(apiKeyMiddleware)

// Admin static assets (CSS, JS)
app.use(
  '/admin/assets',
  express.static(path.join(process.cwd(), 'ui/admin'))
)

// Public-ish media serving (filenames are random/unpredictable)
app.use('/media', express.static(UPLOAD_DIR, {
  fallthrough: false,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'private, max-age=86400'); // 1 day
  }
}));


/**
 * Health
 */
app.get('/health', async (req, res) => {
  const counts = await sendQueue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed')
  res.json({
    ok: true,
    wa: { status: connectionStatus, hasQR: Boolean(lastQR) },
    groupCache: { updatedAt: groupCache.updatedAt, count: groupCache.byJid.size },
    queue: { name: WA_QUEUE_NAME, ...counts },
    autoReply: { enabled: AUTO_REPLY_ENABLED, scope: AUTO_REPLY_SCOPE },
    messages: { storeFile: MESSAGES_STORE_FILE, max: MESSAGES_MAX, memLimit: MESSAGES_MEMORY_LIMIT }
  })
})


/**
 * Pairing
 */
app.get('/pairing/qr.png', async (req, res) => {
  try {
    if (!lastQR) return res.status(404).send('No QR available')
    res.setHeader('Content-Type', 'image/png')
    const pngBuffer = await QRCode.toBuffer(lastQR, { type: 'png', width: 320 })
    res.send(pngBuffer)
  } catch (err) {
    res.status(500).send(err?.message || 'Failed to generate QR PNG')
  }
})

app.get('/pairing/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders?.()

  sseClients.add(res)
  sseSend(res, 'status', { status: connectionStatus, hasQR: Boolean(lastQR) })
  if (lastQR) sseSend(res, 'qr', { qr: lastQR })

  const ping = setInterval(() => {
    try { res.write(`event: ping\ndata: {}\n\n`) } catch {}
  }, 15000)

  req.on('close', () => {
    clearTimeout(ping)
    sseClients.delete(res)
  })
})

/**
 * Pairing UI (kept as you provided)
 */
app.get('/pairing/ui', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.sendFile(path.join(UI_DIR, 'pairing', 'pairing.html'))
})

/**
 * Unified public send endpoints
 * - UPDATED: store outbound in persistent store + memory with status queued/sent/failed
 */
app.post('/send', requireConnected, async (req, res) => {
  try {
    const { to, message } = req.body || {}
    if (!to || !message) return res.status(400).json({ ok: false, error: 'Missing to/message' })
    const jid = await resolveToJid(to)

    const msgId = makeId('out_txt')
    const payload = { text: String(message) }

    // store queued outbound
    const saved = addMessageRecord({
      id: msgId,
      direction: 'out',
      ts: Date.now(),
      chatJid: jid,
      senderJid: 'me',
      isGroup: isGroupJid(jid),
      type: payloadType(payload),
      text: payload.text,
      status: 'queued'
    })
    upsertRecentMessage({
        ts: saved.ts,
        chatJid: saved.chatJid,
        senderJid: saved.senderJid,
        id: saved.id,
        isGroup: saved.isGroup,
        text: saved.text,
        direction: saved.direction,
        status: saved.status,
        type: saved.type,
        media: saved.media || null
        })


    const jobId = await enqueue({
        id: makeId('job_txt'),
        jid,
        payload,
        createdAt: Date.now(),
        msgId,
        chatJid: jid
        })

    res.json({ ok: true, to, jid, queued: true, jobId, msgId })
  } catch (err) {
    if (err.code === 'AMBIGUOUS_GROUP') return res.status(409).json({ ok: false, error: err.message, matches: err.matches })
    res.status(400).json({ ok: false, error: err?.message || 'Failed to queue text' })
  }
})

app.post('/send/image', requireConnected, upload.single('image'), async (req, res) => {
  try {
    const to = req.body?.to
    const caption = req.body?.caption || ''
    if (!to) return res.status(400).json({ ok: false, error: 'Missing to' })
    const jid = await resolveToJid(to)

    // Build payload
    let payload = null
    let media = null

    if (req.file?.path) {
    const filePath = req.file.path              // e.g. uploads/1770_xxx.jpeg
    const fileName = path.basename(filePath)    // e.g. 1770_xxx.jpeg

    payload = { image: { url: filePath }, caption: String(caption) }

    media = {
        localPath: filePath,
        localUrl: signMediaUrl(fileName),         // ✅ signed route
        mimetype: req.file.mimetype || '',
        fileName
    }
    } else {
        const imageUrl = req.body?.imageUrl
        if (!imageUrl) return res.status(400).json({ ok: false, error: 'Missing image file OR imageUrl' })

        const { buffer, contentType } = await fetchToBuffer(imageUrl, MAX_URL_FETCH_MB * 1024 * 1024)

        payload = { image: buffer, caption: String(caption) }

        // ✅ save buffer to disk + generate signed localUrl
        const idHint = makeId('out_imgbuf')
        const savedMedia = saveOutboundBufferToDisk(
            buffer,
            'image',
            idHint,
            contentType || 'image/jpeg',
            path.basename(new URL(imageUrl).pathname) || 'image.jpg'
        )

        media = {
            ...savedMedia,
            sourceUrl: imageUrl,
            mode: 'url-buffer'
        }
        }

    const msgId = makeId('out_img')
    const saved = addMessageRecord({
      id: msgId,
      direction: 'out',
      ts: Date.now(),
      chatJid: jid,
      senderJid: 'me',
      isGroup: isGroupJid(jid),
      type: payloadType(payload),
      text: (caption && String(caption).trim()) ? String(caption).trim() : '[image]',
      media,
      status: 'queued'
    })
    upsertRecentMessage({
        ts: saved.ts,
        chatJid: saved.chatJid,
        senderJid: saved.senderJid,
        id: saved.id,
        isGroup: saved.isGroup,
        text: saved.text,
        direction: saved.direction,
        status: saved.status,
        type: saved.type,
        media: saved.media || null
        })


    const jobId = await enqueue({
        id: makeId('job_img'),
        jid,
        payload,
        createdAt: Date.now(),
        msgId,
        chatJid: jid
        })

    res.json({ ok: true, to, jid, queued: true, jobId, msgId })
  } catch (err) {
    if (err.code === 'AMBIGUOUS_GROUP') return res.status(409).json({ ok: false, error: err.message, matches: err.matches })
    res.status(400).json({ ok: false, error: err?.message || 'Failed to queue image' })
  }
})

app.post('/send/document', requireConnected, upload.single('document'), async (req, res) => {
  try {
    const to = req.body?.to
    if (!to) return res.status(400).json({ ok: false, error: 'Missing to' })
    const jid = await resolveToJid(to)

    let payload = null
    let media = null

    if (req.file?.path) {
        const filePath = req.file.path
        const fileName = path.basename(filePath)
        const fileNameDisplay =
            req.body?.fileName || req.body?.filename || req.file.originalname || fileName
        const mimetype = req.body?.mimetype || req.file.mimetype || 'application/octet-stream'

        payload = { document: { url: filePath }, mimetype: String(mimetype), fileName: String(fileNameDisplay) }

        media = {
            localPath: filePath,
            localUrl: signMediaUrl(fileName),     // ✅ signed
            mimetype,
            fileName: fileNameDisplay
        }
        } else {
  const documentUrl = req.body?.documentUrl
  const fileNameDisplay = req.body?.fileName || 'file'
  let mimetype = req.body?.mimetype || 'application/octet-stream'
  if (!documentUrl) return res.status(400).json({ ok: false, error: 'Missing document file OR documentUrl' })

  const { buffer, contentType } = await fetchToBuffer(documentUrl, MAX_URL_FETCH_MB * 1024 * 1024)
  if (mimetype === 'application/octet-stream' && contentType) mimetype = contentType

  payload = { document: buffer, mimetype: String(mimetype), fileName: String(fileNameDisplay) }

  const idHint = makeId('out_docbuf')
  const savedMedia = saveOutboundBufferToDisk(
    buffer,
    'document',
    idHint,
    mimetype,
    fileNameDisplay
  )

  media = {
    ...savedMedia,
    sourceUrl: documentUrl,
    mode: 'url-buffer'
  }
}

    const msgId = makeId('out_doc')
    const saved = addMessageRecord({
      id: msgId,
      direction: 'out',
      ts: Date.now(),
      chatJid: jid,
      senderJid: 'me',
      isGroup: isGroupJid(jid),
      type: payloadType(payload),
      text: media?.fileName ? `[document] ${media.fileName}` : '[document]',
      media,
      status: 'queued'
    })
    upsertRecentMessage({
        ts: saved.ts,
        chatJid: saved.chatJid,
        senderJid: saved.senderJid,
        id: saved.id,
        isGroup: saved.isGroup,
        text: saved.text,
        direction: saved.direction,
        status: saved.status,
        type: saved.type,
        media: saved.media || null
        })


    const jobId = await enqueue({
    id: makeId('job_doc'),
    jid,
    payload,
    createdAt: Date.now(),
    msgId,
    chatJid: jid
    })

    res.json({ ok: true, to, jid, queued: true, jobId, msgId })
  } catch (err) {
    if (err.code === 'AMBIGUOUS_GROUP') return res.status(409).json({ ok: false, error: err.message, matches: err.matches })
    res.status(400).json({ ok: false, error: err?.message || 'Failed to queue document' })
  }
})

// Signed media serving (browser-friendly; no headers required)
app.get('/media/:name', (req, res) => {
  const name = String(req.params.name || '')
  if (!name || name.includes('..') || name.includes('/') || name.includes('\\')) {
    return res.status(400).send('Bad name')
  }

  const exp = String(req.query.exp || '')
  const sig = String(req.query.sig || '')

  const v = verifyMediaSignature(name, exp, sig)

  if (!v.ok) {
    return res.status(401).json({
      ok: false,
      error: 'Unauthorized',
      reason: v.reason,
      name,
      exp,
      sig_prefix: sig.slice(0, 12),
      expected_prefix: (v.expected || '').slice(0, 12),
      payload: v.payload,
      now: Math.floor(Date.now() / 1000)
    })
  }

  const full = path.join(UPLOAD_DIR, name)
  if (!fs.existsSync(full)) return res.status(404).send('Not found')

  res.setHeader('Cache-Control', 'private, max-age=300')
  res.sendFile(path.resolve(full))
})


/**
 * ----------------------------
 * Admin API
 * ----------------------------
 */

// Admin-only media serving (previews for received/sent files)
app.get('/admin/media/:name', adminKeyMiddleware, (req, res) => {
  const name = String(req.params.name || '')
  if (!name || name.includes('..') || name.includes('/') || name.includes('\\')) {
    return res.status(400).send('Bad name')
  }
  const full = path.join(UPLOAD_DIR, name)
  if (!fs.existsSync(full)) return res.status(404).send('Not found')
  res.sendFile(path.resolve(full))
})



app.get('/admin/targets', adminKeyMiddleware, requireConnected, async (req, res) => {
  const store = readContactsStore()
  const contacts = (store.contacts || []).map(c => ({
    type: 'contact',
    name: c.name,
    to: c.jid || (c.msisdn ? c.msisdn : ''),
    jid: c.jid || null
  }))

  const groupAliases = (store.groups || []).map(g => ({
    type: 'group-alias',
    name: g.name,
    to: g.jid,
    jid: g.jid
  }))

  const waGroups = Array.from(groupCache.byJid.values()).map(g => ({
    type: 'wa-group',
    name: g.subject,
    to: g.jid,
    jid: g.jid
  })).sort((a,b)=>String(a.name).localeCompare(String(b.name)))

  res.json({ ok: true, contacts, groupAliases, waGroups, groupCacheUpdatedAt: groupCache.updatedAt })
})


// ---- Automations (n8n) config ----
app.get('/admin/automations', adminKeyMiddleware, (req, res) => {
  // never return sharedSecret in plaintext
  const safe = { ...automations }
  if (safe && safe.sharedSecret) safe.sharedSecret = safe.sharedSecret ? '***' : ''
  res.json({ ok: true, automations: safe })
})

app.post('/admin/automations', adminKeyMiddleware, (req, res) => {
  try {
    const body = req.body || {}
    // Preserve existing config (especially perChat overrides) while applying updates.
    // Then backfill any missing fields from defaults.
    const merged = mergeDeep(automations || defaultAutomationsConfig(), body)
    const next = mergeDeep(defaultAutomationsConfig(), merged)

    // If client sends sharedSecret as '***' or empty string, keep existing secret
    const incomingSecret = body.sharedSecret
    if (incomingSecret === '***' || incomingSecret === undefined) {
      next.sharedSecret = automations.sharedSecret
    }

    automations = next
    saveAutomations()
    const safe = { ...automations }
    if (safe.sharedSecret) safe.sharedSecret = '***'
    res.json({ ok: true, automations: safe })
  } catch (e) {
    res.status(400).json({ ok: false, error: e?.message || 'bad request' })
  }
})

app.delete('/admin/automations/chat/:jid', adminKeyMiddleware, (req, res) => {
  const jid = req.params.jid;

  automations.perChat = automations.perChat || {};
  delete automations.perChat[jid];

  saveAutomations(); // whatever your persistence function is
  res.json(automations);
});


// Convenience: enable/disable or tweak one chat/group rule
app.post('/admin/automations/chat/:jid', adminKeyMiddleware, (req, res) => {
  try {
    const jid = String(req.params.jid || '').trim()
    if (!jid) return res.status(400).json({ ok: false, error: 'jid required' })

    if (!automations.perChat) automations.perChat = {}
    const current = automations.perChat[jid] || {}
    const patch = req.body || {}

    automations.perChat[jid] = mergeDeep(current, patch)
    saveAutomations()

    res.json({ ok: true, jid, rule: automations.perChat[jid] })
  } catch (e) {
    res.status(400).json({ ok: false, error: e?.message || 'bad request' })
  }
})


app.get('/admin/contacts', adminKeyMiddleware, (req, res) => {
  const store = readContactsStore()
  res.json({ ok: true, updatedAt: store.updatedAt, contacts: store.contacts, groups: store.groups })
})

app.post('/admin/contacts', adminKeyMiddleware, (req, res) => {
  try {
    const { name, msisdn, jid, tags = [] } = req.body || {}
    if (!name) return res.status(400).json({ ok: false, error: 'name required' })

    const store = readContactsStore()
    const contact = { name: String(name).trim(), tags: Array.isArray(tags) ? tags : [] }
    if (msisdn) contact.msisdn = String(msisdn).trim()
    if (jid) contact.jid = String(jid).trim()
    if (!contact.jid && contact.msisdn) contact.jid = toUserJid(contact.msisdn)

    upsertContact(store, contact)
    const saved = writeContactsStore(store)

    res.json({ ok: true, updatedAt: saved.updatedAt, contact })
  } catch (err) {
    res.status(400).json({ ok: false, error: err?.message || 'Failed to save contact' })
  }
})

app.delete('/admin/contacts/:name', adminKeyMiddleware, (req, res) => {
  const store = readContactsStore()
  const removed = deleteContact(store, req.params.name)
  const saved = writeContactsStore(store)
  res.json({ ok: true, updatedAt: saved.updatedAt, removed })
})

app.post('/admin/groups', adminKeyMiddleware, (req, res) => {
  try {
    const { name, jid } = req.body || {}
    if (!name || !jid) return res.status(400).json({ ok: false, error: 'name and jid required' })

    const store = readContactsStore()
    upsertGroupAlias(store, { name: String(name).trim(), jid: String(jid).trim() })
    const saved = writeContactsStore(store)

    res.json({ ok: true, updatedAt: saved.updatedAt })
  } catch (err) {
    res.status(400).json({ ok: false, error: err?.message || 'Failed to save group alias' })
  }
})

app.delete('/admin/groups/:name', adminKeyMiddleware, (req, res) => {
  const store = readContactsStore()
  const removed = deleteGroupAlias(store, req.params.name)
  const saved = writeContactsStore(store)
  res.json({ ok: true, updatedAt: saved.updatedAt, removed })
})

/**
 * Chat threads list (in-memory summary)
 */
app.get('/admin/messages/chats', adminKeyMiddleware, (req, res) => {
  const list = Array.from(chatIndex.values())
    .sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0))
    .slice(0, 500)
  res.json({ ok: true, count: list.length, chats: list })
})

/**
 * Messages in a chat (poll this) — now includes outbound too
 */
app.get('/admin/messages/chat/:jid', adminKeyMiddleware, (req, res) => {
  const chatJid = req.params.jid;
  const limit = Math.min(Number(req.query.limit || 200), 1000);
  const since = Number(req.query.since || 0);

  let msgs = recentMessages.filter(m => m.chatJid === chatJid);

  if (since) {
    msgs = msgs.filter(m => Math.max(m.ts || 0, m.statusTs || 0) > since); // ✅
  }

  msgs = msgs.slice(-limit);

  const latest = msgs.length
    ? Math.max(msgs[msgs.length - 1].ts || 0, msgs[msgs.length - 1].statusTs || 0)
    : since;

  res.json({ ok: true, chatJid, count: msgs.length, latestTs: latest, messages: msgs });
});


/**
 * Admin send helpers
 * - UPDATED: store outbound in persistent store + memory
 */
app.post('/admin/send/text', adminKeyMiddleware, requireConnected, async (req, res) => {
  try {
    const { to, message } = req.body || {}
    if (!to || !message) return res.status(400).json({ ok: false, error: 'Missing to/message' })
    const jid = await resolveToJid(to)

    const msgId = makeId('out_adm_txt')
    const payload = { text: String(message) }

    const saved = addMessageRecord({
      id: msgId,
      direction: 'out',
      ts: Date.now(),
      chatJid: jid,
      senderJid: 'me',
      isGroup: isGroupJid(jid),
      type: payloadType(payload),
      text: payload.text,
      status: 'queued'
    })
    upsertRecentMessage({
        ts: saved.ts,
        chatJid: saved.chatJid,
        senderJid: saved.senderJid,
        id: saved.id,
        isGroup: saved.isGroup,
        text: saved.text,
        direction: saved.direction,
        status: saved.status,
        type: saved.type,
        media: saved.media || null
        })


    const jobId = await enqueue({
    id: makeId('job_admin_txt'),
    jid,
    payload,
    createdAt: Date.now(),
    msgId,
    chatJid: jid
    })
    res.json({ ok: true, to, jid, queued: true, jobId, msgId })
  } catch (err) {
    if (err.code === 'AMBIGUOUS_GROUP') return res.status(409).json({ ok: false, error: err.message, matches: err.matches })
    res.status(400).json({ ok: false, error: err?.message || 'Failed to queue text' })
  }
})

app.post('/admin/send/image', adminKeyMiddleware, requireConnected, upload.single('image'), async (req, res) => {
  try {
    const to = req.body?.to
    const caption = req.body?.caption || ''
    if (!to) return res.status(400).json({ ok: false, error: 'Missing to' })
    const jid = await resolveToJid(to)

    let payload = null
    let media = null

    if (req.file?.path) {
  const filePath = req.file.path              // e.g. uploads/1770_xxx.jpeg
  const fileName = path.basename(filePath)    // e.g. 1770_xxx.jpeg

  payload = { image: { url: filePath }, caption: String(caption) }

  media = {
    localPath: filePath,
    localUrl: signMediaUrl(fileName),         // ✅ signed route
    mimetype: req.file.mimetype || '',
    fileName
  }
} else {
  const imageUrl = req.body?.imageUrl
  if (!imageUrl) return res.status(400).json({ ok: false, error: 'Missing image file OR imageUrl' })

  const { buffer, contentType } = await fetchToBuffer(imageUrl, MAX_URL_FETCH_MB * 1024 * 1024)

  payload = { image: buffer, caption: String(caption) }

  // ✅ save buffer to disk + generate signed localUrl
  const idHint = makeId('out_imgbuf')
  const savedMedia = saveOutboundBufferToDisk(
    buffer,
    'image',
    idHint,
    contentType || 'image/jpeg',
    path.basename(new URL(imageUrl).pathname) || 'image.jpg'
  )

  media = {
    ...savedMedia,
    sourceUrl: imageUrl,
    mode: 'url-buffer'
  }
}

    const msgId = makeId('out_adm_img')
    const saved = addMessageRecord({
      id: msgId,
      direction: 'out',
      ts: Date.now(),
      chatJid: jid,
      senderJid: 'me',
      isGroup: isGroupJid(jid),
      type: payloadType(payload),
      text: (caption && String(caption).trim()) ? String(caption).trim() : '[image]',
      media,
      status: 'queued'
    })
    upsertRecentMessage({
        ts: saved.ts,
        chatJid: saved.chatJid,
        senderJid: saved.senderJid,
        id: saved.id,
        isGroup: saved.isGroup,
        text: saved.text,
        direction: saved.direction,
        status: saved.status,
        type: saved.type,
        media: saved.media || null
        })


    const jobId = await enqueue({
    id: makeId('job_admin_img'),
    jid,
    payload,
    createdAt: Date.now(),
    msgId,
    chatJid: jid
    })
    return res.json({ ok: true, to, jid, queued: true, jobId, msgId })
  } catch (err) {
    if (err.code === 'AMBIGUOUS_GROUP') return res.status(409).json({ ok: false, error: err.message, matches: err.matches })
    res.status(400).json({ ok: false, error: err?.message || 'Failed to queue image' })
  }
})

app.post('/admin/send/document', adminKeyMiddleware, requireConnected, upload.single('document'), async (req, res) => {
  try {
    const to = req.body?.to
    if (!to) return res.status(400).json({ ok: false, error: 'Missing to' })
    const jid = await resolveToJid(to)

    let payload = null
    let media = null

if (req.file?.path) {
  const filePath = req.file.path
  const fileName = path.basename(filePath)
  const fileNameDisplay =
    req.body?.fileName || req.body?.filename || req.file.originalname || fileName
  const mimetype = req.body?.mimetype || req.file.mimetype || 'application/octet-stream'

  payload = { document: { url: filePath }, mimetype: String(mimetype), fileName: String(fileNameDisplay) }

  media = {
    localPath: filePath,
    localUrl: signMediaUrl(fileName),     // ✅ signed
    mimetype,
    fileName: fileNameDisplay
  }
  } else {
  const documentUrl = req.body?.documentUrl
  const fileNameDisplay = req.body?.fileName || 'file'
  let mimetype = req.body?.mimetype || 'application/octet-stream'
  if (!documentUrl) return res.status(400).json({ ok: false, error: 'Missing document file OR documentUrl' })

  const { buffer, contentType } = await fetchToBuffer(documentUrl, MAX_URL_FETCH_MB * 1024 * 1024)
  if (mimetype === 'application/octet-stream' && contentType) mimetype = contentType

  payload = { document: buffer, mimetype: String(mimetype), fileName: String(fileNameDisplay) }

  const idHint = makeId('out_docbuf')
  const savedMedia = saveOutboundBufferToDisk(
    buffer,
    'document',
    idHint,
    mimetype,
    fileNameDisplay
  )

  media = {
    ...savedMedia,
    sourceUrl: documentUrl,
    mode: 'url-buffer'
  }
}

    const msgId = makeId('out_adm_doc')
    const saved = addMessageRecord({
      id: msgId,
      direction: 'out',
      ts: Date.now(),
      chatJid: jid,
      senderJid: 'me',
      isGroup: isGroupJid(jid),
      type: payloadType(payload),
      text: media?.fileName ? `[document] ${media.fileName}` : '[document]',
      media,
      status: 'queued'
    })
    upsertRecentMessage({
        ts: saved.ts,
        chatJid: saved.chatJid,
        senderJid: saved.senderJid,
        id: saved.id,
        isGroup: saved.isGroup,
        text: saved.text,
        direction: saved.direction,
        status: saved.status,
        type: saved.type,
        media: saved.media || null
        })


    const jobId = await enqueue({
    id: makeId('job_admin_doc'),
    jid,
    payload,
    createdAt: Date.now(),
    msgId,
    chatJid: jid
    })
    return res.json({ ok: true, to, jid, queued: true, jobId, msgId })
  } catch (err) {
    if (err.code === 'AMBIGUOUS_GROUP') return res.status(409).json({ ok: false, error: err.message, matches: err.matches })
    res.status(400).json({ ok: false, error: err?.message || 'Failed to queue document' })
  }
})

/**
 * Admin UI (dynamic messages + send panel) — Black/Yellow/Purple theme + Multi-send
 */
app.get('/admin/ui', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.sendFile(path.join(UI_DIR, 'admin', 'admin.html'))
})


/** * ----------------------------
 * Media cleanup
 * ----------------------------
 */
const MEDIA_TTL_DAYS = Number(process.env.MEDIA_TTL_DAYS || 2);
const MEDIA_CLEANUP_EVERY_HOURS = Number(process.env.MEDIA_CLEANUP_EVERY_HOURS || 12);

function cleanupOldUploads() {
  const cutoff = Date.now() - MEDIA_TTL_DAYS * 24 * 60 * 60 * 1000;

  try {
    const files = fs.readdirSync(UPLOAD_DIR);
    let removed = 0;

    for (const f of files) {
      const full = path.join(UPLOAD_DIR, f);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (!st.isFile()) continue;

      if (st.mtimeMs < cutoff) {
        try { fs.unlinkSync(full); removed++; } catch {}
      }
    }

    if (removed) console.log(`🧹 Media cleanup: removed ${removed} old file(s)`);
  } catch (e) {
    console.warn('⚠️ Media cleanup failed:', e?.message);
  }
}

setInterval(cleanupOldUploads, MEDIA_CLEANUP_EVERY_HOURS * 60 * 60 * 1000);
cleanupOldUploads();

async function shutdown() {
  try { await worker?.close() } catch {}
  try { await sendQueue?.close() } catch {}
  try { await queueEvents?.close() } catch {}
  try { await queueEventsConn?.quit() } catch {}
  try { await redis?.quit() } catch {}
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)


/**
 * ----------------------------
 * Start
 * ----------------------------
 */
app.listen(PORT, async () => {
  console.log(`✅ API listening on http://0.0.0.0:${PORT}`)
  if (!REQUIRE_API_KEY) console.log('⚠️ WARNING: WA_API_KEY not set. Set it in .env before VPS.')
  if (!REQUIRE_ADMIN_KEY) console.log('⚠️ WARNING: WA_ADMIN_KEY not set. Admin UI/API will not work.')

  ensureContactsStore()
  ensureMessagesStore()
  hydrateInMemoryFromStore()

  await startWhatsApp()
})
