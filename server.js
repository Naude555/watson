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
import pg from 'pg'
const { Pool } = pg
import Database from 'better-sqlite3'
import { loadChatSummariesFromDb } from './lib/chat-summaries.js'
import { createDiagnosticsBuffer } from './lib/diagnostics.js'
import { parseDisconnectDetails, computeReconnectDelayMs, computeStatus405DelayMs } from './lib/wa-reconnect.js'
import { createRequestTracingMiddleware } from './lib/request-tracing.js'
import { registerAdminDebugRoutes } from './lib/admin-debug-routes.js'
import { registerAdminMiddlewares } from './lib/admin-middleware.js'

import IORedis from 'ioredis'
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  initAuthCreds,
  BufferJSON,
  downloadMediaMessage
} from '@whiskeysockets/baileys'

function parseSecretRing(...rawValues) {
  const seen = new Set()
  const out = []
  for (const raw of rawValues) {
    const parts = String(raw || '').split(',').map(s => s.trim()).filter(Boolean)
    for (const p of parts) {
      if (seen.has(p)) continue
      seen.add(p)
      out.push(p)
    }
  }
  return out
}

function matchesSecretRing(candidate, ring = []) {
  const c = String(candidate || '').trim()
  if (!c) return false
  return Array.isArray(ring) && ring.includes(c)
}


/**
 * ----------------------------
 * Config
 * ----------------------------
 */
const PORT = Number(process.env.PORT || 3000)

// Normal API key (x-api-key)
const API_KEYS = parseSecretRing(process.env.WA_API_KEY, process.env.WA_API_KEY_PREVIOUS)
const API_KEY = API_KEYS[0] || ''
const REQUIRE_API_KEY = API_KEYS.length > 0

// Admin key (x-admin-key)
const ADMIN_KEYS = parseSecretRing(process.env.WA_ADMIN_KEY, process.env.WA_ADMIN_KEY_PREVIOUS)
const OPERATOR_KEYS = parseSecretRing(process.env.WA_OPERATOR_KEY, process.env.WA_OPERATOR_KEY_PREVIOUS)
const VIEWER_KEYS = parseSecretRing(process.env.WA_VIEWER_KEY, process.env.WA_VIEWER_KEY_PREVIOUS)
const ADMIN_ANY_KEYS = parseSecretRing(ADMIN_KEYS.join(','), OPERATOR_KEYS.join(','), VIEWER_KEYS.join(','))
const ADMIN_KEY = ADMIN_KEYS[0] || ''
const REQUIRE_ADMIN_KEY = ADMIN_ANY_KEYS.length > 0
const ADMIN_SESSION_COOKIE = String(process.env.ADMIN_SESSION_COOKIE || 'wa_admin_session').trim()
const ADMIN_SESSION_TTL_SEC = Number(process.env.ADMIN_SESSION_TTL_SEC || 60 * 60 * 12)
const ADMIN_SESSION_SECRET = String(process.env.ADMIN_SESSION_SECRET || ADMIN_KEY || 'wa-admin-session-secret').trim()
const ADMIN_CSRF_COOKIE = String(process.env.ADMIN_CSRF_COOKIE || 'wa_admin_csrf').trim()
const ADMIN_IP_ALLOWLIST = String(process.env.ADMIN_IP_ALLOWLIST || '').split(',').map(s => s.trim()).filter(Boolean)
const ADMIN_AUDIT_MAX_ITEMS = Math.max(200, Number(process.env.ADMIN_AUDIT_MAX_ITEMS || 5000))
const WA_BROWSER_PROFILE = String(process.env.WA_BROWSER_PROFILE || 'macos').trim().toLowerCase()

const ADMIN_ROLE_LEVEL = { viewer: 1, operator: 2, admin: 3 }

function normalizeAdminRole(roleRaw) {
  const r = String(roleRaw || '').trim().toLowerCase()
  if (r === 'admin' || r === 'operator' || r === 'viewer') return r
  return 'viewer'
}

function resolveAdminRoleFromKey(keyRaw) {
  const key = String(keyRaw || '').trim()
  if (!key) return ''
  if (matchesSecretRing(key, ADMIN_KEYS)) return 'admin'
  if (matchesSecretRing(key, OPERATOR_KEYS)) return 'operator'
  if (matchesSecretRing(key, VIEWER_KEYS)) return 'viewer'
  return ''
}

function roleSatisfies(currentRoleRaw, requiredRoleRaw) {
  const current = normalizeAdminRole(currentRoleRaw)
  const required = normalizeAdminRole(requiredRoleRaw)
  return (ADMIN_ROLE_LEVEL[current] || 0) >= (ADMIN_ROLE_LEVEL[required] || 0)
}

function requiredRoleForAdminRequest(req) {
  const method = String(req.method || 'GET').toUpperCase()
  const p = String(req.path || '').trim()

  if (p === '/login' || p === '/logout' || p === '/csrf' || p === '/ui' || p === '/ui-legacy' || p.startsWith('/assets/')) {
    return 'viewer'
  }

  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return 'viewer'

  if (p === '/settings/runtime' || p.startsWith('/automations') || p.startsWith('/rules')) return 'admin'
  if (p === '/group-cache/refresh' || p.startsWith('/force-')) return 'admin'
  if (p.startsWith('/n8n/dead-letters')) return 'admin'

  return 'operator'
}

// Auth
const AUTH_CREDS_DB_KEY = 'wa_auth_creds_v1'

// Storage backend
const PG_HOST = String(process.env.PG_HOST || process.env.POSTGRES_HOST || '').trim()
const PG_PORT = Number(process.env.PG_PORT || process.env.POSTGRES_PORT || 5432)
const PG_DATABASE = String(process.env.PG_DATABASE || process.env.POSTGRES_DB || '').trim()
const PG_USER = String(process.env.PG_USER || process.env.POSTGRES_USER || '').trim()
const PG_PASSWORD = String(process.env.PG_PASSWORD || process.env.POSTGRES_PASSWORD || '').trim()
const PG_POOL_MAX = Math.max(1, Number(process.env.PG_POOL_MAX || 10))
const PG_CONNECTION_TIMEOUT_MS = Math.max(1000, Number(process.env.PG_CONNECTION_TIMEOUT_MS || 10000))
const DATABASE_URL = String(process.env.DATABASE_URL || '').trim()
const SQLITE_FILE = String(process.env.SQLITE_FILE || '/data/watson.sqlite').trim()
const HAS_PG_CONFIG = Boolean(DATABASE_URL) || Boolean(PG_HOST && PG_DATABASE)
const STORAGE_BACKEND = String(process.env.STORAGE_BACKEND || (HAS_PG_CONFIG ? 'postgres' : 'sqlite')).trim().toLowerCase()
const USE_POSTGRES = STORAGE_BACKEND === 'postgres' && HAS_PG_CONFIG
const PG_SSL = String(process.env.PG_SSL || '').trim().toLowerCase() === 'true'

// In-memory UI cache (fast polling)
const MESSAGES_MEMORY_LIMIT = Number(process.env.MESSAGES_MEMORY_LIMIT || 1500)
const DIAG_EVENT_BUFFER_SIZE = Number(process.env.DIAG_EVENT_BUFFER_SIZE || 600)
const diag = createDiagnosticsBuffer(DIAG_EVENT_BUFFER_SIZE)

function logDiag(level, event, message, meta = null) {
  diag.push({ level, event, message, meta })
  if (meta && typeof meta === 'object') {
    console.log(message, meta)
  } else {
    console.log(message)
  }
}

// Uploads
const UPLOAD_DIR = process.env.UPLOAD_DIR || './uploads'
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true })
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 20)

// URL fetch (for image/document URL sending)
const MAX_URL_FETCH_MB = Number(process.env.MAX_URL_FETCH_MB || 20)
const URL_FETCH_TIMEOUT_MS = Number(process.env.URL_FETCH_TIMEOUT_MS || 20000)

// Auto reply
const AUTO_REPLY_ENABLED_DEFAULT = String(process.env.AUTO_REPLY_ENABLED || 'false') === 'true'
const AUTO_REPLY_SCOPE_DEFAULT = process.env.AUTO_REPLY_SCOPE || 'both' // dm | group | both
const AUTO_REPLY_MATCH_TYPE_DEFAULT = process.env.AUTO_REPLY_MATCH_TYPE || 'contains' // contains | equals | regex
const AUTO_REPLY_MATCH_VALUE_DEFAULT = process.env.AUTO_REPLY_MATCH_VALUE || 'help'
const AUTO_REPLY_TEXT_DEFAULT = process.env.AUTO_REPLY_TEXT || 'Hi 👋 How can I help?'
const AUTO_REPLY_COOLDOWN_MS_DEFAULT = Number(process.env.AUTO_REPLY_COOLDOWN_MS || 30000)
const AUTO_REPLY_GROUP_PREFIX_DEFAULT = process.env.AUTO_REPLY_GROUP_PREFIX || '!bot'
const GROUP_CACHE_REFRESH_MIN_GAP_MS = Math.max(5000, Number(process.env.GROUP_CACHE_REFRESH_MIN_GAP_MS || 30000))
const GROUP_CACHE_REFRESH_DEBOUNCE_MS = Math.max(250, Number(process.env.GROUP_CACHE_REFRESH_DEBOUNCE_MS || 1500))
const GROUP_CACHE_SYNC_INTERVAL_MS = Math.max(60000, Number(process.env.GROUP_CACHE_SYNC_INTERVAL_MS || 180000))
// Map key format: "instanceId:chatJid" to ensure isolation between multiple instances
const lastAutoReplyAt = new Map()

// ----------------------------
// Instance Isolation (multi-instance support)
// ----------------------------
// INSTANCE_ID can be set to manually isolate multiple instances on same Redis
// If not set, it will be auto-derived from the connected WhatsApp JID
const INSTANCE_ID_OVERRIDE = String(process.env.INSTANCE_ID || '').trim()
let currentInstanceId = INSTANCE_ID_OVERRIDE || 'default'  // will be updated on socket connection
let currentWhatsAppJid = ''  // will be set on socket connection

// ----------------------------
// n8n Automations
// ----------------------------
const N8N_WEBHOOK_URL_DEFAULT = String(process.env.N8N_WEBHOOK_URL || '').trim()
const N8N_SHARED_SECRET_DEFAULT = String(process.env.N8N_SHARED_SECRET || '').trim()
const SCHEDULE_POLL_MS = Number(process.env.SCHEDULE_POLL_MS || 5000)

// Queue throttle
const BASE_DELAY_MS_DEFAULT = Number(process.env.WA_BASE_DELAY_MS || 900)
const JITTER_MS_DEFAULT = Number(process.env.WA_JITTER_MS || 600)
const PER_JID_GAP_MS_DEFAULT = Number(process.env.WA_PER_JID_GAP_MS || 1500)

const MAX_RETRIES_DEFAULT = Number(process.env.WA_MAX_RETRIES || 3)
const RETRY_BACKOFF_MS_DEFAULT = Number(process.env.WA_RETRY_BACKOFF_MS || 1500)

// Rate limit (non-admin, non-pairing)
const RATE_LIMIT_WINDOW_MS_DEFAULT = Number(process.env.RATE_LIMIT_WINDOW_MS || 60000)
const RATE_LIMIT_MAX_DEFAULT = Number(process.env.RATE_LIMIT_MAX || 120)
const API_PUBLIC_ENABLED_DEFAULT = String(process.env.API_PUBLIC_ENABLED || 'true').trim().toLowerCase() !== 'false'
const API_SEND_TEXT_ENABLED_DEFAULT = String(process.env.API_SEND_TEXT_ENABLED || 'true').trim().toLowerCase() !== 'false'
const API_SEND_IMAGE_ENABLED_DEFAULT = String(process.env.API_SEND_IMAGE_ENABLED || 'true').trim().toLowerCase() !== 'false'
const API_SEND_DOCUMENT_ENABLED_DEFAULT = String(process.env.API_SEND_DOCUMENT_ENABLED || 'true').trim().toLowerCase() !== 'false'
const WA_HISTORY_SYNC_MAX = Number(process.env.WA_HISTORY_SYNC_MAX || 15000)

// ESM __dirname equivalent
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// UI directory (mount your html here)
const UI_DIR = process.env.UI_DIR || path.join(__dirname, 'ui')


// Signed media URLs (no x-admin-key needed in browser)
const MEDIA_SIGNING_SECRETS = parseSecretRing(process.env.MEDIA_SIGNING_SECRET, process.env.MEDIA_SIGNING_SECRET_PREVIOUS)
const MEDIA_SIGNING_SECRET = MEDIA_SIGNING_SECRETS[0] || ''

// ----------------------------
// Redis (for queue, optional)
// ----------------------------
const REDIS_URL = String(process.env.REDIS_URL || 'redis://redis:6379')
const WA_QUEUE_NAME_BASE = String(process.env.WA_QUEUE_NAME || 'wa-send')

// Optional global limiter (in addition to your BASE/JITTER)
const WA_GLOBAL_MIN_GAP_MS_DEFAULT = Number(process.env.WA_GLOBAL_MIN_GAP_MS || 0)
const WA_WEB_VERSION_OVERRIDE = String(process.env.WA_WEB_VERSION_OVERRIDE || '').trim()

// Get the effective queue name for this instance
// This ensures each WhatsApp number gets its own queue, preventing crosstalk
function getWaQueueName() {
  if (INSTANCE_ID_OVERRIDE) {
    // If explicitly set, use it
    return `${WA_QUEUE_NAME_BASE}-${INSTANCE_ID_OVERRIDE}`
  }
  if (currentWhatsAppJid) {
    // Auto-derive from WhatsApp JID (e.g., "123456789@s.whatsapp.net" -> "wa-send-123456789")
    const jidNum = currentWhatsAppJid.split('@')[0]
    return `${WA_QUEUE_NAME_BASE}-${jidNum}`
  }
  // Fallback during startup
  return WA_QUEUE_NAME_BASE
}

function parseWaVersionOverride(raw = '') {
  const s = String(raw || '').trim()
  if (!s) return null
  const parts = s.split('.').map(v => Number(v))
  if (parts.length < 3 || parts.some(v => !Number.isFinite(v) || v < 0)) return null
  return [parts[0], parts[1], parts[2]]
}

// Known-good WA Web versions, newest first. Used as ordered fallbacks when auto-fetch
// fails or a 405 is received. Extend this list when a new working version is confirmed.
const WA_KNOWN_VERSIONS = [
  [2, 3000, 1035194821],
  [2, 3000, 1023223821],
]


function defaultAutomationsConfig() {
  return {
    enabled: Boolean(N8N_WEBHOOK_URL_DEFAULT),
    webhookUrl: N8N_WEBHOOK_URL_DEFAULT,
    webhookUrls: N8N_WEBHOOK_URL_DEFAULT ? [N8N_WEBHOOK_URL_DEFAULT] : [],
    sharedSecret: N8N_SHARED_SECRET_DEFAULT,
    updatedAt: Date.now(),
    lastSavedBy: 'startup-defaults',
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

function defaultSchedulesConfig() {
  return {
    schedules: [],
    updatedAt: Date.now()
  }
}

function defaultN8nDeadLettersConfig() {
  return {
    items: [],
    updatedAt: Date.now()
  }
}

function defaultRulesConfig() {
  return {
    enabled: false,
    rules: [],
    updatedAt: Date.now()
  }
}

function defaultTemplatesConfig() {
  return {
    templates: [],
    updatedAt: Date.now()
  }
}

function defaultRuntimeSettings() {
  return {
    autoReply: {
      enabled: AUTO_REPLY_ENABLED_DEFAULT,
      scope: AUTO_REPLY_SCOPE_DEFAULT,
      matchType: AUTO_REPLY_MATCH_TYPE_DEFAULT,
      matchValue: AUTO_REPLY_MATCH_VALUE_DEFAULT,
      text: AUTO_REPLY_TEXT_DEFAULT,
      cooldownMs: AUTO_REPLY_COOLDOWN_MS_DEFAULT,
      groupPrefix: AUTO_REPLY_GROUP_PREFIX_DEFAULT
    },
    queue: {
      baseDelayMs: BASE_DELAY_MS_DEFAULT,
      jitterMs: JITTER_MS_DEFAULT,
      perJidGapMs: PER_JID_GAP_MS_DEFAULT,
      maxRetries: MAX_RETRIES_DEFAULT,
      retryBackoffMs: RETRY_BACKOFF_MS_DEFAULT,
      globalMinGapMs: WA_GLOBAL_MIN_GAP_MS_DEFAULT,
      quietHours: {
        enabled: false,
        start: '22:00',
        end: '06:00',
        tz: 'Africa/Johannesburg'
      }
    },
    rateLimit: {
      windowMs: RATE_LIMIT_WINDOW_MS_DEFAULT,
      max: RATE_LIMIT_MAX_DEFAULT
    },
    api: {
      enabled: API_PUBLIC_ENABLED_DEFAULT,
      sendTextEnabled: API_SEND_TEXT_ENABLED_DEFAULT,
      sendImageEnabled: API_SEND_IMAGE_ENABLED_DEFAULT,
      sendDocumentEnabled: API_SEND_DOCUMENT_ENABLED_DEFAULT
    },
    messages: {
      uiFetchLimit: Math.max(50, Number(process.env.MSG_UI_FETCH_LIMIT || 500)),
      persistMax: Math.max(0, Number(process.env.MSG_PERSIST_MAX || 0))
    },
    media: {
      urlTtlSeconds: Number(process.env.MEDIA_URL_TTL_SECONDS || 60 * 60 * 24 * 2),
      retentionDays: Math.max(1, Number(process.env.MEDIA_RETENTION_DAYS || 7))
    },
    updatedAt: Date.now(),
    lastSavedBy: 'startup-defaults'
  }
}

let pgPool = null
let sqliteDb = null
let waAuthCreds = null

function activeStorageBackend() {
  if (pgPool) return 'postgres'
  if (sqliteDb) return 'sqlite'
  return 'json'
}

function normalizeSQLitePath(filePath) {
  const p = String(filePath || '').trim()
  if (!p) return '/data/watson.sqlite'
  if (path.isAbsolute(p)) return p
  return path.join(process.cwd(), p)
}

function buildPostgresConnectionConfig() {
  if (DATABASE_URL) {
    return {
      connectionString: DATABASE_URL,
      ssl: PG_SSL ? { rejectUnauthorized: false } : undefined,
      max: PG_POOL_MAX,
      connectionTimeoutMillis: PG_CONNECTION_TIMEOUT_MS
    }
  }

  return {
    host: PG_HOST,
    port: PG_PORT,
    database: PG_DATABASE,
    user: PG_USER || undefined,
    password: PG_PASSWORD || undefined,
    ssl: PG_SSL ? { rejectUnauthorized: false } : undefined,
    max: PG_POOL_MAX,
    connectionTimeoutMillis: PG_CONNECTION_TIMEOUT_MS
  }
}

async function initPostgresStorage() {
  if (!USE_POSTGRES) return false

  try {
    pgPool = new Pool(buildPostgresConnectionConfig())

    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS runtime_settings (
        id SMALLINT PRIMARY KEY,
        settings JSONB NOT NULL,
        updated_at BIGINT NOT NULL
      )
    `)

    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        wa_msg_id TEXT,
        ts BIGINT NOT NULL,
        direction TEXT NOT NULL,
        chat_jid TEXT NOT NULL,
        sender_jid TEXT,
        is_group BOOLEAN NOT NULL DEFAULT false,
        type TEXT,
        text_content TEXT,
        media JSONB,
        status TEXT,
        status_ts BIGINT,
        quoted_message_id TEXT
      )
    `)
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages(chat_jid, ts DESC)')
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_messages_wa_msg_id ON messages(wa_msg_id)')

    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS kv_store (
        key TEXT PRIMARY KEY,
        value JSONB NOT NULL,
        updated_at BIGINT NOT NULL
      )
    `)

    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS wa_auth_keys (
        key_type TEXT NOT NULL,
        key_id TEXT NOT NULL,
        value JSONB NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (key_type, key_id)
      )
    `)

    const rtCount = await pgPool.query('SELECT COUNT(*)::int AS n FROM runtime_settings')
    if (!Number(rtCount.rows?.[0]?.n || 0)) {
      const seed = defaultRuntimeSettings()
      await pgPool.query(
        'INSERT INTO runtime_settings(id, settings, updated_at) VALUES (1, $1::jsonb, $2)',
        [JSON.stringify(seed), Number(seed.updatedAt || Date.now())]
      )
    }

    console.log('🗄️ PostgreSQL storage enabled (runtime settings, messages, kv_store)')
    return true
  } catch (e) {
    console.warn('⚠️ Failed to initialize PostgreSQL storage:', e?.message)
    try { await pgPool?.end?.() } catch {}
    pgPool = null
    return false
  }
}

function initSqliteStorage() {
  try {
    const sqlitePath = normalizeSQLitePath(SQLITE_FILE)
    fs.mkdirSync(path.dirname(sqlitePath), { recursive: true })
    sqliteDb = new Database(sqlitePath)
    sqliteDb.exec('PRAGMA journal_mode=WAL;')
    sqliteDb.exec('PRAGMA foreign_keys=ON;')

    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS runtime_settings (
        id INTEGER PRIMARY KEY,
        settings TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        wa_msg_id TEXT,
        ts INTEGER NOT NULL,
        direction TEXT NOT NULL,
        chat_jid TEXT NOT NULL,
        sender_jid TEXT,
        is_group INTEGER NOT NULL DEFAULT 0,
        type TEXT,
        text_content TEXT,
        media TEXT,
        status TEXT,
        status_ts INTEGER,
        quoted_message_id TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages(chat_jid, ts DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_wa_msg_id ON messages(wa_msg_id);
      CREATE TABLE IF NOT EXISTS kv_store (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS wa_auth_keys (
        key_type TEXT NOT NULL,
        key_id TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (key_type, key_id)
      );
    `)

    const rtCount = Number(sqliteDb.prepare('SELECT COUNT(*) AS n FROM runtime_settings').get()?.n || 0)
    if (!rtCount) {
      const seed = defaultRuntimeSettings()
      sqliteDb.prepare('INSERT INTO runtime_settings(id, settings, updated_at) VALUES (1, ?, ?)')
        .run(JSON.stringify(seed), Number(seed.updatedAt || Date.now()))
    }

    console.log(`🗄️ SQLite storage enabled (runtime settings, messages, kv_store) (${sqlitePath})`)
    return true
  } catch (e) {
    console.warn('⚠️ Failed to initialize SQLite storage:', e?.message)
    try { sqliteDb?.close?.() } catch {}
    sqliteDb = null
    return false
  }
}

async function initDatabaseStorage() {
  if (STORAGE_BACKEND === 'postgres' && !HAS_PG_CONFIG) {
    console.warn('⚠️ STORAGE_BACKEND=postgres but PostgreSQL settings are missing. Falling back to SQLite.')
  }

  if (USE_POSTGRES) {
    const ok = await initPostgresStorage()
    if (ok) return 'postgres'
    console.warn('⚠️ Falling back to SQLite because PostgreSQL initialization failed')
  }

  const sqliteOk = initSqliteStorage()
  if (sqliteOk) return 'sqlite'
  return 'json'
}

async function readRuntimeSettingsFromPostgres() {
  if (!pgPool) return null
  try {
    const r = await pgPool.query('SELECT settings, updated_at FROM runtime_settings WHERE id = 1 LIMIT 1')
    const row = r.rows?.[0]
    if (!row) return null
    const raw = row.settings && typeof row.settings === 'object' ? row.settings : {}
    const merged = mergeDeep(defaultRuntimeSettings(), raw)
    merged.updatedAt = Number(row.updated_at || raw.updatedAt || Date.now())
    merged.lastSavedBy = String(raw.lastSavedBy || merged.lastSavedBy || 'startup-defaults')
    return merged
  } catch (e) {
    console.warn('⚠️ Failed to read runtime settings from PostgreSQL:', e?.message)
    return null
  }
}

function readRuntimeSettingsFromSqlite() {
  if (!sqliteDb) return null
  try {
    const row = sqliteDb.prepare('SELECT settings, updated_at FROM runtime_settings WHERE id = 1 LIMIT 1').get()
    if (!row) return null
    const raw = (() => {
      try { return JSON.parse(String(row.settings || '{}')) } catch { return {} }
    })()
    const merged = mergeDeep(defaultRuntimeSettings(), raw)
    merged.updatedAt = Number(row.updated_at || raw.updatedAt || Date.now())
    merged.lastSavedBy = String(raw.lastSavedBy || merged.lastSavedBy || 'startup-defaults')
    return merged
  } catch (e) {
    console.warn('⚠️ Failed to read runtime settings from SQLite:', e?.message)
    return null
  }
}

async function writeRuntimeSettingsToPostgres(settingsObj) {
  if (!pgPool) return false
  try {
    const safe = mergeDeep(defaultRuntimeSettings(), settingsObj || {})
    const updatedAt = Number(safe.updatedAt || Date.now())
    await pgPool.query(
      `INSERT INTO runtime_settings(id, settings, updated_at)
       VALUES (1, $1::jsonb, $2)
       ON CONFLICT (id) DO UPDATE SET settings = EXCLUDED.settings, updated_at = EXCLUDED.updated_at`,
      [JSON.stringify(safe), updatedAt]
    )
    return true
  } catch (e) {
    console.warn('⚠️ Failed to write runtime settings to PostgreSQL:', e?.message)
    return false
  }
}

function writeRuntimeSettingsToSqlite(settingsObj) {
  if (!sqliteDb) return false
  try {
    const safe = mergeDeep(defaultRuntimeSettings(), settingsObj || {})
    const updatedAt = Number(safe.updatedAt || Date.now())
    sqliteDb.prepare(
      `INSERT INTO runtime_settings(id, settings, updated_at)
       VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at`
    ).run(JSON.stringify(safe), updatedAt)
    return true
  } catch (e) {
    console.warn('⚠️ Failed to write runtime settings to SQLite:', e?.message)
    return false
  }
}

async function readRuntimeSettingsFromDb() {
  if (pgPool) return await readRuntimeSettingsFromPostgres()
  if (sqliteDb) return readRuntimeSettingsFromSqlite()
  return null
}

async function writeRuntimeSettingsToDb(settingsObj) {
  if (pgPool) return await writeRuntimeSettingsToPostgres(settingsObj)
  if (sqliteDb) return writeRuntimeSettingsToSqlite(settingsObj)
  return false
}

function rowToMessage(row) {
  if (!row) return null
  let media = null
  if (row.media && typeof row.media === 'object') media = row.media
  else if (typeof row.media === 'string' && row.media.trim()) {
    try { media = JSON.parse(row.media) } catch { media = null }
  }

  return {
    id: row.id,
    waMsgId: row.wa_msg_id || null,
    ts: Number(row.ts || 0),
    direction: row.direction || 'in',
    chatJid: normalizeJid(row.chat_jid || ''),
    senderJid: row.sender_jid || '',
    isGroup: Boolean(row.is_group),
    type: row.type || 'text',
    text: row.text_content || '',
    media,
    status: row.status || null,
    statusTs: row.status_ts ? Number(row.status_ts) : null,
    quotedMessageId: row.quoted_message_id || null
  }
}

function persistMessageRecordToPostgres(rec) {
  if (!pgPool || !rec?.id) return
  const q = `
    INSERT INTO messages(
      id, wa_msg_id, ts, direction, chat_jid, sender_jid, is_group, type, text_content, media, status, status_ts, quoted_message_id
    )
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13)
    ON CONFLICT (id) DO UPDATE SET
      wa_msg_id = EXCLUDED.wa_msg_id,
      ts = EXCLUDED.ts,
      direction = EXCLUDED.direction,
      chat_jid = EXCLUDED.chat_jid,
      sender_jid = EXCLUDED.sender_jid,
      is_group = EXCLUDED.is_group,
      type = EXCLUDED.type,
      text_content = EXCLUDED.text_content,
      media = EXCLUDED.media,
      status = EXCLUDED.status,
      status_ts = EXCLUDED.status_ts,
      quoted_message_id = EXCLUDED.quoted_message_id
  `
  const vals = [
    String(rec.id || ''),
    rec.waMsgId ? String(rec.waMsgId) : null,
    Number(rec.ts || Date.now()),
    String(rec.direction || 'in'),
    normalizeJid(rec.chatJid),
    String(rec.senderJid || ''),
    Boolean(rec.isGroup),
    String(rec.type || 'text'),
    String(rec.text || ''),
    rec.media ? JSON.stringify(rec.media) : null,
    rec.status ? String(rec.status) : null,
    rec.statusTs ? Number(rec.statusTs) : null,
    rec.quotedMessageId ? String(rec.quotedMessageId) : null
  ]

  pgPool.query(q, vals)
    .then(async () => {
      const msgCfg = getMessageStorageConfig()
      const persistMax = Number(msgCfg.persistMax || 0)
      if (persistMax > 0) {
        await pgPool.query(
          `DELETE FROM messages
           WHERE id IN (
             SELECT id FROM messages ORDER BY ts DESC OFFSET $1
           )`,
          [persistMax]
        )
      }
    })
    .catch((e) => {
      console.warn('⚠️ Failed to persist message to PostgreSQL:', e?.message)
    })
}

function persistMessageRecordToSqlite(rec) {
  if (!sqliteDb || !rec?.id) return
  try {
    sqliteDb.prepare(`
      INSERT INTO messages(
        id, wa_msg_id, ts, direction, chat_jid, sender_jid, is_group, type, text_content, media, status, status_ts, quoted_message_id
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        wa_msg_id = excluded.wa_msg_id,
        ts = excluded.ts,
        direction = excluded.direction,
        chat_jid = excluded.chat_jid,
        sender_jid = excluded.sender_jid,
        is_group = excluded.is_group,
        type = excluded.type,
        text_content = excluded.text_content,
        media = excluded.media,
        status = excluded.status,
        status_ts = excluded.status_ts,
        quoted_message_id = excluded.quoted_message_id
    `).run(
      String(rec.id || ''),
      rec.waMsgId ? String(rec.waMsgId) : null,
      Number(rec.ts || Date.now()),
      String(rec.direction || 'in'),
      normalizeJid(rec.chatJid),
      String(rec.senderJid || ''),
      rec.isGroup ? 1 : 0,
      String(rec.type || 'text'),
      String(rec.text || ''),
      rec.media ? JSON.stringify(rec.media) : null,
      rec.status ? String(rec.status) : null,
      rec.statusTs ? Number(rec.statusTs) : null,
      rec.quotedMessageId ? String(rec.quotedMessageId) : null
    )

    const msgCfg = getMessageStorageConfig()
    const persistMax = Number(msgCfg.persistMax || 0)
    if (persistMax > 0) {
      sqliteDb.prepare(
        `DELETE FROM messages
         WHERE id IN (
           SELECT id FROM messages ORDER BY ts DESC LIMIT -1 OFFSET ?
         )`
      ).run(persistMax)
    }
  } catch (e) {
    console.warn('⚠️ Failed to persist message to SQLite:', e?.message)
  }
}

function persistMessageRecordToDb(rec) {
  if (pgPool) return persistMessageRecordToPostgres(rec)
  if (sqliteDb) return persistMessageRecordToSqlite(rec)
}

function patchMessageInPostgresById(id, patch = {}) {
  if (!pgPool) return
  const key = String(id || '').trim()
  if (!key) return

  const fields = []
  const values = []
  let idx = 1

  if (Object.prototype.hasOwnProperty.call(patch, 'status')) {
    fields.push(`status = $${idx++}`)
    values.push(patch.status ? String(patch.status) : null)
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'statusTs')) {
    fields.push(`status_ts = $${idx++}`)
    values.push(patch.statusTs ? Number(patch.statusTs) : null)
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'waMsgId')) {
    fields.push(`wa_msg_id = $${idx++}`)
    values.push(patch.waMsgId ? String(patch.waMsgId) : null)
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'chatJid')) {
    fields.push(`chat_jid = $${idx++}`)
    values.push(normalizeJid(patch.chatJid || ''))
  }

  if (!fields.length) return
  values.push(key)
  pgPool.query(`UPDATE messages SET ${fields.join(', ')} WHERE id = $${idx}`, values)
    .catch(e => console.warn('⚠️ Failed to patch message in PostgreSQL:', e?.message))
}

function patchMessageInSqliteById(id, patch = {}) {
  if (!sqliteDb) return
  const key = String(id || '').trim()
  if (!key) return

  const fields = []
  const values = []

  if (Object.prototype.hasOwnProperty.call(patch, 'status')) {
    fields.push('status = ?')
    values.push(patch.status ? String(patch.status) : null)
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'statusTs')) {
    fields.push('status_ts = ?')
    values.push(patch.statusTs ? Number(patch.statusTs) : null)
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'waMsgId')) {
    fields.push('wa_msg_id = ?')
    values.push(patch.waMsgId ? String(patch.waMsgId) : null)
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'chatJid')) {
    fields.push('chat_jid = ?')
    values.push(normalizeJid(patch.chatJid || ''))
  }
  if (!fields.length) return

  values.push(key)
  try {
    sqliteDb.prepare(`UPDATE messages SET ${fields.join(', ')} WHERE id = ?`).run(...values)
  } catch (e) {
    console.warn('⚠️ Failed to patch message in SQLite:', e?.message)
  }
}

function patchMessageInDbById(id, patch = {}) {
  if (pgPool) return patchMessageInPostgresById(id, patch)
  if (sqliteDb) return patchMessageInSqliteById(id, patch)
}

function patchMessageInPostgresByWaMsgId(waMsgId, patch = {}) {
  if (!pgPool) return
  const key = String(waMsgId || '').trim()
  if (!key) return

  const fields = []
  const values = []
  let idx = 1

  if (Object.prototype.hasOwnProperty.call(patch, 'status')) {
    fields.push(`status = $${idx++}`)
    values.push(patch.status ? String(patch.status) : null)
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'statusTs')) {
    fields.push(`status_ts = $${idx++}`)
    values.push(patch.statusTs ? Number(patch.statusTs) : null)
  }

  if (!fields.length) return
  values.push(key)
  pgPool.query(`UPDATE messages SET ${fields.join(', ')} WHERE wa_msg_id = $${idx}`, values)
    .catch(e => console.warn('⚠️ Failed to patch message by wa_msg_id in PostgreSQL:', e?.message))
}

function patchMessageInSqliteByWaMsgId(waMsgId, patch = {}) {
  if (!sqliteDb) return
  const key = String(waMsgId || '').trim()
  if (!key) return

  const fields = []
  const values = []

  if (Object.prototype.hasOwnProperty.call(patch, 'status')) {
    fields.push('status = ?')
    values.push(patch.status ? String(patch.status) : null)
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'statusTs')) {
    fields.push('status_ts = ?')
    values.push(patch.statusTs ? Number(patch.statusTs) : null)
  }
  if (!fields.length) return

  values.push(key)
  try {
    sqliteDb.prepare(`UPDATE messages SET ${fields.join(', ')} WHERE wa_msg_id = ?`).run(...values)
  } catch (e) {
    console.warn('⚠️ Failed to patch message by wa_msg_id in SQLite:', e?.message)
  }
}

function patchMessageInDbByWaMsgId(waMsgId, patch = {}) {
  if (pgPool) return patchMessageInPostgresByWaMsgId(waMsgId, patch)
  if (sqliteDb) return patchMessageInSqliteByWaMsgId(waMsgId, patch)
}

function findMessageInMemoryByAnyId(idOrWaId) {
  const key = String(idOrWaId || '').trim()
  if (!key) return null

  const storeMessages = Array.isArray(messagesStoreCache?.messages) ? messagesStoreCache.messages : []
  for (let i = storeMessages.length - 1; i >= 0; i--) {
    const m = storeMessages[i]
    if (!m) continue
    if (String(m.id || '') === key || String(m.waMsgId || '') === key) {
      return {
        id: String(m.id || ''),
        waMsgId: m.waMsgId ? String(m.waMsgId) : null,
        ts: Number(m.ts || 0),
        direction: String(m.direction || 'in'),
        chatJid: normalizeJid(m.chatJid || ''),
        senderJid: String(m.senderJid || ''),
        isGroup: Boolean(m.isGroup),
        type: String(m.type || 'text'),
        text: String(m.text || ''),
        media: m.media || null,
        status: m.status ? String(m.status) : null,
        statusTs: m.statusTs ? Number(m.statusTs) : null,
        quotedMessageId: m.quotedMessageId ? String(m.quotedMessageId) : null
      }
    }
  }

  for (let i = recentMessages.length - 1; i >= 0; i--) {
    const m = recentMessages[i]
    if (!m) continue
    if (String(m.id || '') === key || String(m.waMsgId || '') === key) {
      return {
        id: String(m.id || ''),
        waMsgId: m.waMsgId ? String(m.waMsgId) : null,
        ts: Number(m.ts || 0),
        direction: String(m.direction || 'in'),
        chatJid: normalizeJid(m.chatJid || ''),
        senderJid: String(m.senderJid || ''),
        isGroup: Boolean(m.isGroup),
        type: String(m.type || 'text'),
        text: String(m.text || ''),
        media: m.media || null,
        status: m.status ? String(m.status) : null,
        statusTs: m.statusTs ? Number(m.statusTs) : null,
        quotedMessageId: m.quotedMessageId ? String(m.quotedMessageId) : null
      }
    }
  }

  return null
}

async function findMessageInDbByAnyId(idOrWaId) {
  const key = String(idOrWaId || '').trim()
  if (!key) return null

  if (pgPool) {
    try {
      const out = await pgPool.query(
        `SELECT id, wa_msg_id, ts, direction, chat_jid, sender_jid, is_group, type, text_content, media, status, status_ts, quoted_message_id
         FROM messages
         WHERE id = $1 OR wa_msg_id = $1
         ORDER BY ts DESC
         LIMIT 1`,
        [key]
      )
      return rowToMessage(out.rows?.[0])
    } catch (e) {
      console.warn('⚠️ Failed to lookup message in PostgreSQL:', e?.message)
    }
  }

  if (sqliteDb) {
    try {
      const row = sqliteDb.prepare(
        `SELECT id, wa_msg_id, ts, direction, chat_jid, sender_jid, is_group, type, text_content, media, status, status_ts, quoted_message_id
         FROM messages
         WHERE id = ? OR wa_msg_id = ?
         ORDER BY ts DESC
         LIMIT 1`
      ).get(key, key)
      return rowToMessage(row)
    } catch (e) {
      console.warn('⚠️ Failed to lookup message in SQLite:', e?.message)
    }
  }

  return null
}

async function findMessageByAnyId(idOrWaId) {
  return findMessageInMemoryByAnyId(idOrWaId) || await findMessageInDbByAnyId(idOrWaId)
}

// ----------------------------
// Generic KV store helpers (contacts, templates, rules, automations, etc.)
// ----------------------------

function writeKvToDb(key, valueObj) {
  const k = String(key || '').trim()
  if (!k) return Promise.resolve(false)
  const json = JSON.stringify(valueObj)
  const ts = Date.now()

  if (pgPool) {
    return pgPool.query(
      `INSERT INTO kv_store(key, value, updated_at) VALUES ($1, $2::jsonb, $3)
       ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [k, json, ts]
    ).then(() => true).catch(e => { console.warn(`⚠️ kv_store write failed [${k}]:`, e?.message); return false })
  }

  if (sqliteDb) {
    try {
      sqliteDb.prepare(
        `INSERT INTO kv_store(key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      ).run(k, json, ts)
      return Promise.resolve(true)
    } catch (e) {
      console.warn(`⚠️ kv_store write failed [${k}]:`, e?.message)
      return Promise.resolve(false)
    }
  }

  return Promise.resolve(false)
}

async function readKvFromDb(key, fallback = null) {
  const k = String(key || '').trim()
  if (!k) return fallback

  if (pgPool) {
    try {
      const r = await pgPool.query('SELECT value FROM kv_store WHERE key = $1 LIMIT 1', [k])
      const row = r.rows?.[0]
      if (!row) return fallback
      const v = row.value && typeof row.value === 'object' ? row.value : null
      if (v) return v
      try { return JSON.parse(String(row.value || '')) } catch { return fallback }
    } catch (e) {
      console.warn(`⚠️ kv_store read failed [${k}]:`, e?.message)
      return fallback
    }
  }

  if (sqliteDb) {
    try {
      const row = sqliteDb.prepare('SELECT value FROM kv_store WHERE key = ? LIMIT 1').get(k)
      if (!row) return fallback
      try { return JSON.parse(String(row.value || '')) } catch { return fallback }
    } catch (e) {
      console.warn(`⚠️ kv_store read failed [${k}]:`, e?.message)
      return fallback
    }
  }

  return fallback
}

function deleteKvFromDb(key) {
  const k = String(key || '').trim()
  if (!k) return Promise.resolve(false)

  if (pgPool) {
    return pgPool.query('DELETE FROM kv_store WHERE key = $1', [k])
      .then(() => true)
      .catch((e) => {
        console.warn(`⚠️ kv_store delete failed [${k}]:`, e?.message)
        return false
      })
  }

  if (sqliteDb) {
    try {
      sqliteDb.prepare('DELETE FROM kv_store WHERE key = ?').run(k)
      return Promise.resolve(true)
    } catch (e) {
      console.warn(`⚠️ kv_store delete failed [${k}]:`, e?.message)
      return Promise.resolve(false)
    }
  }

  return Promise.resolve(false)
}

async function readAuthCredsFromDb() {
  const raw = await readKvFromDb(AUTH_CREDS_DB_KEY, null)
  if (!raw || typeof raw !== 'object') return null
  try {
    return JSON.parse(JSON.stringify(raw), BufferJSON.reviver)
  } catch {
    return null
  }
}

async function writeAuthCredsToDb(creds) {
  if (!creds || typeof creds !== 'object') return false
  return await writeKvToDb(AUTH_CREDS_DB_KEY, creds)
}

function reviveBufferJson(value, fallback = null) {
  if (value == null) return fallback
  try {
    return JSON.parse(JSON.stringify(value), BufferJSON.reviver)
  } catch {
    return fallback
  }
}

async function readAuthKeysFromDb(type, ids = []) {
  const out = {}
  const keyType = String(type || '').trim()
  const wanted = Array.isArray(ids) ? ids.map(x => String(x || '').trim()).filter(Boolean) : []
  if (!keyType || !wanted.length) return out

  if (pgPool) {
    try {
      const r = await pgPool.query(
        'SELECT key_id, value FROM wa_auth_keys WHERE key_type = $1 AND key_id = ANY($2::text[])',
        [keyType, wanted]
      )
      for (const row of (r.rows || [])) {
        if (!row?.key_id) continue
        const val = row.value && typeof row.value === 'object'
          ? reviveBufferJson(row.value, null)
          : (() => { try { return JSON.parse(String(row.value || '{}'), BufferJSON.reviver) } catch { return null } })()
        if (val !== null) out[String(row.key_id)] = val
      }
    } catch (e) {
      console.warn('⚠️ Failed reading auth keys from PostgreSQL:', e?.message)
    }
    return out
  }

  if (sqliteDb) {
    try {
      const placeholders = wanted.map(() => '?').join(',')
      const rows = sqliteDb.prepare(
        `SELECT key_id, value FROM wa_auth_keys WHERE key_type = ? AND key_id IN (${placeholders})`
      ).all(keyType, ...wanted)
      for (const row of (rows || [])) {
        const keyId = String(row?.key_id || '')
        if (!keyId) continue
        try {
          out[keyId] = JSON.parse(String(row.value || '{}'), BufferJSON.reviver)
        } catch {}
      }
    } catch (e) {
      console.warn('⚠️ Failed reading auth keys from SQLite:', e?.message)
    }
  }

  return out
}

async function writeAuthKeysToDb(data = {}) {
  const entries = []
  for (const [type, value] of Object.entries(data || {})) {
    const t = String(type || '').trim()
    if (!t || !value || typeof value !== 'object') continue
    for (const [id, payload] of Object.entries(value || {})) {
      entries.push({ type: t, id: String(id || '').trim(), payload })
    }
  }

  if (!entries.length) return true

  if (pgPool) {
    try {
      for (const row of entries) {
        if (!row.id) continue
        if (row.payload) {
          await pgPool.query(
            `INSERT INTO wa_auth_keys(key_type, key_id, value, updated_at)
             VALUES ($1, $2, $3::jsonb, $4)
             ON CONFLICT(key_type, key_id) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
            [row.type, row.id, JSON.stringify(row.payload), Date.now()]
          )
        } else {
          await pgPool.query('DELETE FROM wa_auth_keys WHERE key_type = $1 AND key_id = $2', [row.type, row.id])
        }
      }
      return true
    } catch (e) {
      console.warn('⚠️ Failed writing auth keys to PostgreSQL:', e?.message)
      return false
    }
  }

  if (sqliteDb) {
    try {
      const upsert = sqliteDb.prepare(
        `INSERT INTO wa_auth_keys(key_type, key_id, value, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(key_type, key_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      const del = sqliteDb.prepare('DELETE FROM wa_auth_keys WHERE key_type = ? AND key_id = ?')
      const ts = Date.now()
      sqliteDb.transaction(() => {
        for (const row of entries) {
          if (!row.id) continue
          if (row.payload) upsert.run(row.type, row.id, JSON.stringify(row.payload), ts)
          else del.run(row.type, row.id)
        }
      })()
      return true
    } catch (e) {
      console.warn('⚠️ Failed writing auth keys to SQLite:', e?.message)
      return false
    }
  }

  return false
}

// In-memory cache for Baileys signal-protocol keys.
// Keeps keys.get/set off the hot DB path so the event loop never blocks during WA handshake.
let waAuthKeysCache = {} // { [type]: { [id]: value } }

async function clearAuthFromDb() {
  await deleteKvFromDb(AUTH_CREDS_DB_KEY).catch(() => {})
  if (pgPool) {
    await pgPool.query('DELETE FROM wa_auth_keys').catch(() => {})
  } else if (sqliteDb) {
    try { sqliteDb.prepare('DELETE FROM wa_auth_keys').run() } catch {}
  }
  waAuthKeysCache = {}
}

async function preloadAuthKeysToCache() {
  // Load ALL auth keys from DB into memory cache before WhatsApp handshake
  // This ensures keys.get never hits the DB during critical handshake phase
  waAuthKeysCache = {}
  
  if (pgPool) {
    try {
      const r = await pgPool.query('SELECT key_type, key_id, value FROM wa_auth_keys')
      for (const row of (r.rows || [])) {
        const type = String(row?.key_type || '')
        const id = String(row?.key_id || '')
        if (!type || !id) continue
        const val = row.value && typeof row.value === 'object'
          ? reviveBufferJson(row.value, null)
          : (() => { try { return JSON.parse(String(row.value || '{}'), BufferJSON.reviver) } catch { return null } })()
        if (val !== null) {
          if (!waAuthKeysCache[type]) waAuthKeysCache[type] = {}
          waAuthKeysCache[type][id] = val
        }
      }
    } catch (e) {
      console.warn('⚠️ Failed preloading auth keys from PostgreSQL:', e?.message)
    }
  } else if (sqliteDb) {
    try {
      const rows = sqliteDb.prepare('SELECT key_type, key_id, value FROM wa_auth_keys').all()
      for (const row of (rows || [])) {
        const type = String(row?.key_type || '')
        const id = String(row?.key_id || '')
        if (!type || !id) continue
        try {
          const val = JSON.parse(String(row.value || '{}'), BufferJSON.reviver)
          if (!waAuthKeysCache[type]) waAuthKeysCache[type] = {}
          waAuthKeysCache[type][id] = val
        } catch {}
      }
    } catch (e) {
      console.warn('⚠️ Failed preloading auth keys from SQLite:', e?.message)
    }
  }
}

async function getAuthStateFromDb() {
  const credsFromDb = await readAuthCredsFromDb()
  waAuthCreds = credsFromDb || initAuthCreds()

  const state = {
    creds: waAuthCreds,
    keys: {
      get: async (type, ids) => {
        // NEVER hit the DB during get — cache is preloaded before handshake
        const keyType = String(type || '')
        const wanted = Array.isArray(ids) ? ids.map(id => String(id || '')).filter(Boolean) : []
        if (!keyType || !wanted.length) return {}

        const cached = waAuthKeysCache[keyType] || {}
        const result = {}
        for (const id of wanted) {
          const v = cached[id]
          if (v != null) result[id] = v
        }
        return result
      },
      set: async (data) => {
        // Update in-memory cache immediately (synchronous, no I/O)
        for (const [type, vals] of Object.entries(data || {})) {
          if (!waAuthKeysCache[type]) waAuthKeysCache[type] = {}
          for (const [id, val] of Object.entries(vals || {})) {
            if (val != null) waAuthKeysCache[type][id] = val
            else delete waAuthKeysCache[type][id]
          }
        }
        // Note: actual DB writes are deferred/batched by caller (startWhatsApp)
      }
    }
  }

  const saveCreds = async () => {
    await writeAuthCredsToDb(state.creds)
  }

  return { state, saveCreds }
}


let automations = defaultAutomationsConfig()

let responseRules = defaultRulesConfig()

let runtimeSettings = defaultRuntimeSettings()
let contactsStoreCache = { contacts: [], groups: [], updatedAt: Date.now() }
let contactsStoreNeedsNormalize = true
let contactsNormalizationInProgress = false
let templatesStoreCache = defaultTemplatesConfig()
let schedulesStoreCache = defaultSchedulesConfig()
let deadLettersStoreCache = defaultN8nDeadLettersConfig()
let adminAuditStoreCache = { items: [], updatedAt: Date.now() }
let messagesStoreCache = { messages: [], updatedAt: Date.now() }

function ensureRuntimeSettingsStore() {
  // no-op: DB-backed
}

function readRuntimeSettingsStore() {
  const raw = runtimeSettings || defaultRuntimeSettings()
  const merged = mergeDeep(defaultRuntimeSettings(), raw)
  merged.updatedAt = Number(raw.updatedAt || Date.now())
  merged.lastSavedBy = String(raw.lastSavedBy || merged.lastSavedBy || 'startup-defaults')
  runtimeSettings = merged
  return merged
}

function saveRuntimeSettingsStore() {
  try {
    runtimeSettings.updatedAt = Date.now()
    runtimeSettings.lastSavedBy = String(runtimeSettings.lastSavedBy || 'startup-defaults')
    writeRuntimeSettingsToDb(runtimeSettings).catch(() => {})
  } catch (e) {
    console.warn('⚠️ Failed to save runtime settings:', e?.message)
  }
}

function getAutoReplyConfig() {
  const cfg = mergeDeep(defaultRuntimeSettings().autoReply, runtimeSettings?.autoReply || {})
  cfg.enabled = Boolean(cfg.enabled)
  cfg.scope = ['dm', 'group', 'both'].includes(cfg.scope) ? cfg.scope : 'both'
  cfg.matchType = ['contains', 'equals', 'regex'].includes(cfg.matchType) ? cfg.matchType : 'contains'
  cfg.matchValue = String(cfg.matchValue || '').trim()
  cfg.text = String(cfg.text || '').trim()
  cfg.cooldownMs = Math.max(0, Number(cfg.cooldownMs || 0))
  cfg.groupPrefix = String(cfg.groupPrefix || '').trim() || AUTO_REPLY_GROUP_PREFIX_DEFAULT
  return cfg
}

function getQueueConfig() {
  const cfg = mergeDeep(defaultRuntimeSettings().queue, runtimeSettings?.queue || {})
  cfg.baseDelayMs = Math.max(0, Number(cfg.baseDelayMs || 0))
  cfg.jitterMs = Math.max(0, Number(cfg.jitterMs || 0))
  cfg.perJidGapMs = Math.max(0, Number(cfg.perJidGapMs || 0))
  cfg.maxRetries = Math.max(0, Number(cfg.maxRetries || 0))
  cfg.retryBackoffMs = Math.max(0, Number(cfg.retryBackoffMs || 0))
  cfg.globalMinGapMs = Math.max(0, Number(cfg.globalMinGapMs || 0))
  cfg.quietHours = {
    enabled: Boolean(cfg?.quietHours?.enabled),
    start: String(cfg?.quietHours?.start || '22:00').trim() || '22:00',
    end: String(cfg?.quietHours?.end || '06:00').trim() || '06:00',
    tz: String(cfg?.quietHours?.tz || 'Africa/Johannesburg').trim() || 'Africa/Johannesburg'
  }
  return cfg
}

function getRateLimitConfig() {
  const cfg = mergeDeep(defaultRuntimeSettings().rateLimit, runtimeSettings?.rateLimit || {})
  cfg.windowMs = Math.max(1000, Number(cfg.windowMs || 0))
  cfg.max = Math.max(1, Number(cfg.max || 0))
  return cfg
}

function getApiConfig() {
  const cfg = mergeDeep(defaultRuntimeSettings().api, runtimeSettings?.api || {})
  cfg.enabled = Boolean(cfg.enabled)
  cfg.sendTextEnabled = Boolean(cfg.sendTextEnabled)
  cfg.sendImageEnabled = Boolean(cfg.sendImageEnabled)
  cfg.sendDocumentEnabled = Boolean(cfg.sendDocumentEnabled)
  return cfg
}

function getMediaConfig() {
  const cfg = mergeDeep(defaultRuntimeSettings().media, runtimeSettings?.media || {})
  cfg.urlTtlSeconds = Math.max(60, Number(cfg.urlTtlSeconds || 0))
  cfg.retentionDays = Math.max(1, Number(cfg.retentionDays || 0))
  return cfg
}

function getMessageStorageConfig() {
  const cfg = mergeDeep(defaultRuntimeSettings().messages, runtimeSettings?.messages || {})
  cfg.uiFetchLimit = Math.min(2000, Math.max(50, Number(cfg.uiFetchLimit || 0)))
  cfg.persistMax = Math.max(0, Number(cfg.persistMax || 0))
  return cfg
}

function saveAutomations() {
  try {
    automations.updatedAt = Number(automations.updatedAt || Date.now())
    automations.lastSavedBy = String(automations.lastSavedBy || 'startup-defaults')
    writeKvToDb('automations', automations).catch(() => {})
  } catch (e) {
    console.warn('⚠️ Failed to save automations config:', e?.message)
  }
}

function ensureRulesStore() {
  // no-op: DB-backed
}

function ensureTemplatesStore() {
  // no-op: DB-backed
}

function normalizeTemplateInput(template = {}, existing = null) {
  const name = String(template?.name || existing?.name || '').trim()
  const body = String(template?.body || existing?.body || '').trim()
  const category = String(template?.category || existing?.category || '').trim()
  const description = String(template?.description || existing?.description || '').trim()
  const tags = Array.isArray(template?.tags)
    ? template.tags.map(t => String(t || '').trim()).filter(Boolean)
    : (Array.isArray(existing?.tags) ? existing.tags : [])

  if (!name) throw new Error('Template name is required')
  if (!body) throw new Error('Template body is required')

  const varSet = new Set()
  const re = /\{\{\s*([a-zA-Z0-9_.-]{1,64})\s*\}\}/g
  let m
  while ((m = re.exec(body))) {
    varSet.add(String(m[1] || '').trim())
    if (varSet.size > 100) break
  }

  return {
    id: String(template?.id || existing?.id || makeId('tpl')).trim(),
    name,
    body,
    category,
    description,
    tags,
    variables: Array.from(varSet),
    updatedAt: Date.now(),
    createdAt: Number(existing?.createdAt || Date.now())
  }
}

function readTemplatesStore() {
  const raw = templatesStoreCache || defaultTemplatesConfig()
  const rows = Array.isArray(raw.templates) ? raw.templates : []
  const templates = rows
    .map(t => {
      try { return normalizeTemplateInput(t, t) } catch { return null }
    })
    .filter(Boolean)

  templatesStoreCache = {
    templates,
    updatedAt: Number(raw.updatedAt || Date.now())
  }
  return templatesStoreCache
}

function writeTemplatesStore(store) {
  const next = {
    templates: Array.isArray(store?.templates) ? store.templates : [],
    updatedAt: Date.now()
  }
  templatesStoreCache = next
  writeKvToDb('templates', next).catch(() => {})
  return next
}

function upsertTemplate(store, template = {}) {
  const list = Array.isArray(store?.templates) ? store.templates : []
  const incomingId = String(template?.id || '').trim()
  const idxById = incomingId ? list.findIndex(t => String(t?.id || '') === incomingId) : -1
  const existing = idxById >= 0 ? list[idxById] : null
  const next = normalizeTemplateInput(template, existing)

  const key = norm(next.name)
  const dup = list.findIndex((t, i) => i !== idxById && norm(t?.name || '') === key)
  if (dup >= 0) {
    const err = new Error('Template name already exists')
    err.code = 'TEMPLATE_NAME_EXISTS'
    throw err
  }

  if (idxById >= 0) list[idxById] = { ...existing, ...next }
  else list.push(next)

  store.templates = list
  return next
}

function deleteTemplate(store, idRaw) {
  const id = String(idRaw || '').trim()
  const before = Array.isArray(store?.templates) ? store.templates.length : 0
  store.templates = (store.templates || []).filter(t => String(t?.id || '') !== id)
  return before !== store.templates.length
}

function readRulesStore() {
  const raw = responseRules || defaultRulesConfig()
  raw.enabled = Boolean(raw.enabled)
  raw.rules = Array.isArray(raw.rules) ? raw.rules : []
  raw.updatedAt = Number(raw.updatedAt || Date.now())
  responseRules = raw
  return responseRules
}

function saveRulesStore() {
  try {
    responseRules = {
      enabled: Boolean(responseRules?.enabled),
      rules: Array.isArray(responseRules?.rules) ? responseRules.rules : [],
      updatedAt: Date.now()
    }
    writeKvToDb('rules', responseRules).catch(() => {})
  } catch (e) {
    console.warn('⚠️ Failed to save rules config:', e?.message)
  }
}

function ensureSchedulesStore() {
  // no-op: DB-backed
}

function readSchedulesStore() {
  const raw = schedulesStoreCache || defaultSchedulesConfig()
  raw.schedules = Array.isArray(raw.schedules) ? raw.schedules : []
  raw.updatedAt = Number(raw.updatedAt || Date.now())
  schedulesStoreCache = raw
  return schedulesStoreCache
}

function writeSchedulesStore(store) {
  const next = {
    schedules: Array.isArray(store?.schedules) ? store.schedules : [],
    updatedAt: Date.now()
  }
  schedulesStoreCache = next
  writeKvToDb('schedules', next).catch(() => {})
  return next
}

function ensureN8nDeadLettersStore() {
  // no-op: DB-backed
}

function readN8nDeadLettersStore() {
  const raw = deadLettersStoreCache || defaultN8nDeadLettersConfig()
  raw.items = Array.isArray(raw.items) ? raw.items : []
  raw.updatedAt = Number(raw.updatedAt || Date.now())
  deadLettersStoreCache = raw
  return deadLettersStoreCache
}

function writeN8nDeadLettersStore(store) {
  const next = {
    items: Array.isArray(store?.items) ? store.items.slice(-500) : [],
    updatedAt: Date.now()
  }
  deadLettersStoreCache = next
  writeKvToDb('n8n_dead_letters', next).catch(() => {})
  return next
}

function addN8nDeadLetter(entry) {
  const store = readN8nDeadLettersStore()
  store.items.push({
    id: makeId('n8n_dlq'),
    ts: Date.now(),
    ...entry
  })
  writeN8nDeadLettersStore(store)
}

function removeN8nDeadLetterById(id) {
  const safeId = String(id || '').trim()
  if (!safeId) return { removed: false, item: null, updatedAt: Date.now() }
  const store = readN8nDeadLettersStore()
  const idx = store.items.findIndex(x => String(x?.id || '') === safeId)
  if (idx < 0) return { removed: false, item: null, updatedAt: store.updatedAt }
  const [item] = store.items.splice(idx, 1)
  const saved = writeN8nDeadLettersStore(store)
  return { removed: true, item: item || null, updatedAt: saved.updatedAt }
}

function clearN8nDeadLetters() {
  const saved = writeN8nDeadLettersStore({ items: [] })
  return { ok: true, updatedAt: saved.updatedAt }
}

function retryDeadLetterItem(item, requestedBy = 'admin') {
  if (!item || typeof item !== 'object') return { ok: false, reason: 'missing-item' }
  const payload = item.payload && typeof item.payload === 'object' ? { ...item.payload } : null
  if (!payload) return { ok: false, reason: 'missing-payload' }

  payload.attempts = 0
  payload.deadLetterRetryTs = Date.now()
  payload.deadLetterRetryBy = String(requestedBy || 'admin')
  enqueueN8nEvent(payload)
  return { ok: true }
}

async function getDependencyHealthSnapshot() {
  const now = Date.now()

  let redisOk = false
  let redisLatencyMs = null
  let redisError = null
  const pingStart = Date.now()
  try {
    const pong = await redis.ping()
    redisLatencyMs = Date.now() - pingStart
    redisOk = String(pong || '').toUpperCase() === 'PONG'
    if (!redisOk) redisError = `Unexpected ping response: ${pong}`
  } catch (e) {
    redisOk = false
    redisLatencyMs = Date.now() - pingStart
    redisError = e?.message || 'Redis ping failed'
  }

  let oldestWaitingMs = null
  let oldestDelayedMs = null
  try {
    const waiting = await sendQueue.getWaiting(0, 0)
    const delayed = await sendQueue.getDelayed(0, 0)
    if (Array.isArray(waiting) && waiting.length) {
      oldestWaitingMs = Math.max(0, now - Number(waiting[0]?.timestamp || now))
    }
    if (Array.isArray(delayed) && delayed.length) {
      oldestDelayedMs = Math.max(0, now - Number(delayed[0]?.timestamp || now))
    }
  } catch {
    oldestWaitingMs = null
    oldestDelayedMs = null
  }

  const queueLagMs = Math.max(Number(oldestWaitingMs || 0), Number(oldestDelayedMs || 0)) || 0

  return {
    ts: now,
    redis: {
      ok: redisOk,
      latencyMs: redisLatencyMs,
      error: redisError
    },
    wa: {
      ok: connectionStatus === 'open',
      status: connectionStatus,
      hasQR: Boolean(lastQR)
    },
    queue: {
      lagMs: queueLagMs,
      oldestWaitingMs,
      oldestDelayedMs
    }
  }
}

function normalizeResponseRule(input = {}, existing = null) {
  const triggerType = ['text', 'voice_note'].includes(input.triggerType) ? input.triggerType : (existing?.triggerType || 'text')
  const scope = ['dm', 'group', 'both'].includes(input.scope) ? input.scope : (existing?.scope || 'both')
  const matchType = ['contains', 'equals', 'regex', 'any'].includes(input.matchType) ? input.matchType : (existing?.matchType || (triggerType === 'voice_note' ? 'any' : 'contains'))
  const dmFilterMode = ['all', 'include', 'exclude'].includes(input.dmFilterMode)
    ? input.dmFilterMode
    : (['all', 'include', 'exclude'].includes(existing?.dmFilterMode) ? existing.dmFilterMode : 'all')
  const dmFilterRaw = input.dmFilterValues ?? existing?.dmFilterValues ?? input.dmFilterList ?? existing?.dmFilterList ?? []
  const dmFilterValues = (Array.isArray(dmFilterRaw) ? dmFilterRaw : String(dmFilterRaw || '').split(/[\n,;]+/g))
    .map(v => String(v || '').trim())
    .filter(Boolean)
  const autoReplyCfg = getAutoReplyConfig()
  const groupPrefix = String(input.groupPrefix ?? existing?.groupPrefix ?? autoReplyCfg.groupPrefix).trim()
  const replyText = String(input.replyText ?? existing?.replyText ?? '').trim()
  const cooldownMs = Math.max(0, Number(input.cooldownMs ?? existing?.cooldownMs ?? autoReplyCfg.cooldownMs) || 0)

  return {
    id: String(input.id || existing?.id || makeId('rule')),
    name: String(input.name ?? existing?.name ?? '').trim() || `Rule ${Date.now()}`,
    enabled: input.enabled === undefined ? (existing?.enabled !== false) : Boolean(input.enabled),
    triggerType,
    scope,
    matchType,
    matchValue: String(input.matchValue ?? existing?.matchValue ?? '').trim(),
    dmFilterMode,
    dmFilterValues,
    requirePrefix: input.requirePrefix === undefined ? Boolean(existing?.requirePrefix) : Boolean(input.requirePrefix),
    groupPrefix,
    replyText,
    cooldownMs,
    createdAt: Number(existing?.createdAt || Date.now()),
    updatedAt: Date.now()
  }
}

function validateResponseRule(rule) {
  if (!rule.name) throw new Error('Rule name required')
  if (!rule.replyText) throw new Error('Reply text required')
  if (rule.triggerType === 'text' && rule.matchType !== 'any' && !String(rule.matchValue || '').trim()) {
    throw new Error('Match value required for text rules')
  }
  return rule
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

function normalizeRuntimeSettingsPatch(input = {}) {
  const current = getAutoReplyConfig()
  const currentQueue = getQueueConfig()
  const currentRateLimit = getRateLimitConfig()
  const currentApi = getApiConfig()
  const currentMessages = getMessageStorageConfig()
  const currentMedia = getMediaConfig()
  const auto = input.autoReply || {}
  const queue = input.queue || {}
  const queueQuiet = queue.quietHours || {}
  const rateLimit = input.rateLimit || {}
  const api = input.api || {}
  const messages = input.messages || {}
  const media = input.media || {}
  const out = {
    autoReply: {
      enabled: auto.enabled === undefined ? current.enabled : Boolean(auto.enabled),
      scope: ['dm', 'group', 'both'].includes(auto.scope) ? auto.scope : current.scope,
      matchType: ['contains', 'equals', 'regex'].includes(auto.matchType) ? auto.matchType : current.matchType,
      matchValue: String(auto.matchValue === undefined ? current.matchValue : auto.matchValue || '').trim(),
      text: String(auto.text === undefined ? current.text : auto.text || '').trim(),
      cooldownMs: Math.max(0, Number(auto.cooldownMs === undefined ? current.cooldownMs : auto.cooldownMs) || 0),
      groupPrefix: String(auto.groupPrefix === undefined ? current.groupPrefix : auto.groupPrefix || '').trim() || current.groupPrefix
    },
    queue: {
      baseDelayMs: Math.max(0, Number(queue.baseDelayMs === undefined ? currentQueue.baseDelayMs : queue.baseDelayMs) || 0),
      jitterMs: Math.max(0, Number(queue.jitterMs === undefined ? currentQueue.jitterMs : queue.jitterMs) || 0),
      perJidGapMs: Math.max(0, Number(queue.perJidGapMs === undefined ? currentQueue.perJidGapMs : queue.perJidGapMs) || 0),
      maxRetries: Math.max(0, Number(queue.maxRetries === undefined ? currentQueue.maxRetries : queue.maxRetries) || 0),
      retryBackoffMs: Math.max(0, Number(queue.retryBackoffMs === undefined ? currentQueue.retryBackoffMs : queue.retryBackoffMs) || 0),
      globalMinGapMs: Math.max(0, Number(queue.globalMinGapMs === undefined ? currentQueue.globalMinGapMs : queue.globalMinGapMs) || 0),
      quietHours: {
        enabled: queueQuiet.enabled === undefined ? Boolean(currentQueue?.quietHours?.enabled) : Boolean(queueQuiet.enabled),
        start: String(queueQuiet.start === undefined ? (currentQueue?.quietHours?.start || '22:00') : queueQuiet.start || '').trim() || '22:00',
        end: String(queueQuiet.end === undefined ? (currentQueue?.quietHours?.end || '06:00') : queueQuiet.end || '').trim() || '06:00',
        tz: String(queueQuiet.tz === undefined ? (currentQueue?.quietHours?.tz || 'Africa/Johannesburg') : queueQuiet.tz || '').trim() || 'Africa/Johannesburg'
      }
    },
    rateLimit: {
      windowMs: Math.max(1000, Number(rateLimit.windowMs === undefined ? currentRateLimit.windowMs : rateLimit.windowMs) || 0),
      max: Math.max(1, Number(rateLimit.max === undefined ? currentRateLimit.max : rateLimit.max) || 0)
    },
    api: {
      enabled: api.enabled === undefined ? currentApi.enabled : Boolean(api.enabled),
      sendTextEnabled: api.sendTextEnabled === undefined ? currentApi.sendTextEnabled : Boolean(api.sendTextEnabled),
      sendImageEnabled: api.sendImageEnabled === undefined ? currentApi.sendImageEnabled : Boolean(api.sendImageEnabled),
      sendDocumentEnabled: api.sendDocumentEnabled === undefined ? currentApi.sendDocumentEnabled : Boolean(api.sendDocumentEnabled)
    },
    messages: {
      uiFetchLimit: Math.min(2000, Math.max(50, Number(messages.uiFetchLimit === undefined ? currentMessages.uiFetchLimit : messages.uiFetchLimit) || 0)),
      persistMax: Math.max(0, Number(messages.persistMax === undefined ? currentMessages.persistMax : messages.persistMax) || 0)
    },
    media: {
      urlTtlSeconds: Math.max(60, Number(media.urlTtlSeconds === undefined ? currentMedia.urlTtlSeconds : media.urlTtlSeconds) || 0),
      retentionDays: Math.max(1, Number(media.retentionDays === undefined ? currentMedia.retentionDays : media.retentionDays) || 0)
    }
  }
  return out
}

function parseClockMinutes(value, fallback = 0) {
  const parts = String(value || '').split(':')
  if (parts.length !== 2) return fallback
  const hh = Number(parts[0])
  const mm = Number(parts[1])
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return fallback
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return fallback
  return hh * 60 + mm
}

function clockMinutesInTimezone(ts, tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).formatToParts(new Date(ts))
    const hh = Number(parts.find(p => p.type === 'hour')?.value || '0')
    const mm = Number(parts.find(p => p.type === 'minute')?.value || '0')
    return (Number.isFinite(hh) ? hh : 0) * 60 + (Number.isFinite(mm) ? mm : 0)
  } catch {
    const d = new Date(ts)
    return d.getHours() * 60 + d.getMinutes()
  }
}

function computeQuietHoursDelayMs(quietHours, nowTs = Date.now()) {
  if (!quietHours?.enabled) return 0

  const start = parseClockMinutes(quietHours.start, 22 * 60)
  const end = parseClockMinutes(quietHours.end, 6 * 60)
  if (start === end) return 0

  const nowMin = clockMinutesInTimezone(nowTs, quietHours.tz || 'Africa/Johannesburg')
  let inQuiet = false
  if (start < end) inQuiet = nowMin >= start && nowMin < end
  else inQuiet = nowMin >= start || nowMin < end
  if (!inQuiet) return 0

  let minutesUntilEnd = 0
  if (start < end) {
    minutesUntilEnd = end - nowMin
  } else if (nowMin >= start) {
    minutesUntilEnd = (24 * 60 - nowMin) + end
  } else {
    minutesUntilEnd = end - nowMin
  }

  return Math.max(0, minutesUntilEnd * 60 * 1000 + 5000)
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

function getAutomationWebhookUrls() {
  const list = []
  const single = String(automations?.webhookUrl || '').trim()
  if (single) list.push(single)
  if (Array.isArray(automations?.webhookUrls)) {
    for (const u of automations.webhookUrls) {
      const s = String(u || '').trim()
      if (s) list.push(s)
    }
  }
  return [...new Set(list)]
}

function shouldForwardToN8n(rec, textForRules) {
  if (!automations?.enabled) return false
  if (!getAutomationWebhookUrls().length) return false

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
        addN8nDeadLetter({
          error: e?.message || String(e),
          eventId: job?.eventId || null,
          chatJid: job?.chatJid || null,
          payload: job
        })
      }
    }
  }
  n8nWorkerRunning = false
}

async function postToN8n(evt) {
  const urls = getAutomationWebhookUrls()
  if (!urls.length) return

  const bodyString = JSON.stringify(evt)
  const headers = { 'Content-Type': 'application/json' }

  // optional shared secret header (no crypto)
  const secret = String(automations.sharedSecret || '').trim();
  if (secret) headers['x-watson-secret'] = secret;


  // Basic fetch with timeout
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), 15_000)
  try {
    for (const url of urls) {
      const res = await fetch(url, { method: 'POST', headers, body: bodyString, signal: controller.signal })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`n8n HTTP ${res.status} @ ${url}: ${text || res.statusText}`)
      }
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

// Queue objects will be created lazily once we know the instance ID
let sendQueue = null
let queueEvents = null

// Initialize or re-initialize queue with the correct queue name
function initializeQueue(queueName) {
  if (sendQueue) {
    console.log(`📦 Closing previous queue: ${sendQueue.name}`)
    sendQueue.close().catch(() => {})
  }
  if (queueEvents) {
    queueEvents.close().catch(() => {})
  }

  sendQueue = new Queue(queueName, {
    connection: redis,
    defaultJobOptions: {
      removeOnComplete: 2000,
      removeOnFail: 5000,
      attempts: (MAX_RETRIES_DEFAULT ?? 3) + 1, // include first attempt
      backoff: { type: 'exponential', delay: RETRY_BACKOFF_MS_DEFAULT ?? 1500 },
    },
  })

  // QueueEvents must use its own Redis connection
  const queueEventsConn = redis.duplicate()
  queueEvents = new QueueEvents(queueName, { connection: queueEventsConn })

  queueEvents.on('completed', ({ jobId }) => console.log('✅ job completed', jobId))
  queueEvents.on('failed', ({ jobId, failedReason }) => console.log('❌ job failed', jobId, failedReason))

  console.log(`📦 Queue initialized: ${queueName}`)
}

// Initialize with default queue name (will be re-initialized once socket connects)
initializeQueue(getWaQueueName())

if (!MEDIA_SIGNING_SECRET) {
  console.warn('⚠️ MEDIA_SIGNING_SECRET not set. Signed media links will NOT work securely.')
}
const MEDIA_URL_TTL_SECONDS_DEFAULT = Number(process.env.MEDIA_URL_TTL_SECONDS || 60 * 60 * 24 * 2) // 2 days

function hmacHex(input) {
  return crypto.createHmac('sha256', MEDIA_SIGNING_SECRET).update(input).digest('hex')
}

function hmacHexWithSecret(input, secret) {
  return crypto.createHmac('sha256', String(secret || '')).update(input).digest('hex')
}

function signMediaUrl(fileName, ttlSeconds = null) {
  const cfg = getMediaConfig()
  const safeTtl = Math.max(60, Number(ttlSeconds ?? cfg.urlTtlSeconds) || cfg.urlTtlSeconds)
  const exp = Math.floor(Date.now() / 1000) + safeTtl
  const payload = `${fileName}|${exp}`
  const sig = hmacHex(payload)
  return `/media/${encodeURIComponent(fileName)}?exp=${exp}&sig=${sig}`
}

function refreshMediaForClient(rec) {
  if (!rec || !rec.media) return rec
  const fileName = String(rec.media.fileName || '').trim()
  if (!fileName) return { ...rec, media: null }

  const full = path.join(UPLOAD_DIR, fileName)
  if (!fs.existsSync(full)) {
    return { ...rec, media: null }
  }

  return {
    ...rec,
    media: {
      ...rec.media,
      fileName,
      localUrl: signMediaUrl(fileName)
    }
  }
}

function resolveMediaMimeTypeByFileName(fileName) {
  const key = String(fileName || '').trim()
  if (!key) return ''

  for (let i = recentMessages.length - 1; i >= 0; i--) {
    const m = recentMessages[i]
    if (String(m?.media?.fileName || '') === key) {
      const mt = String(m?.media?.mimetype || '').trim()
      if (mt) return mt
    }
  }

  const store = readMessagesStore()
  const rows = Array.isArray(store?.messages) ? store.messages : []
  for (let i = rows.length - 1; i >= 0; i--) {
    const m = rows[i]
    if (String(m?.media?.fileName || '') === key) {
      const mt = String(m?.media?.mimetype || '').trim()
      if (mt) return mt
    }
  }

  return ''
}

function mimeFromFileExtension(fileName) {
  const n = String(fileName || '').toLowerCase()
  if (n.endsWith('.mp4')) return 'video/mp4'
  if (n.endsWith('.webm')) return 'video/webm'
  if (n.endsWith('.mov')) return 'video/quicktime'
  if (n.endsWith('.mkv')) return 'video/x-matroska'
  if (n.endsWith('.gif')) return 'image/gif'
  if (n.endsWith('.webp')) return 'image/webp'
  if (n.endsWith('.png')) return 'image/png'
  if (n.endsWith('.jpg') || n.endsWith('.jpeg')) return 'image/jpeg'
  if (n.endsWith('.pdf')) return 'application/pdf'
  return ''
}

function sniffMimeFromFileHead(fullPath) {
  try {
    const fd = fs.openSync(fullPath, 'r')
    const buf = Buffer.alloc(32)
    const read = fs.readSync(fd, buf, 0, 32, 0)
    fs.closeSync(fd)
    if (read <= 0) return ''

    const head = buf.subarray(0, read)
    if (head.length >= 4 && head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46) return 'application/pdf'
    if (head.length >= 6 && head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x38) return 'image/gif'
    if (head.length >= 8 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return 'image/png'
    if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg'
    if (head.length >= 12) {
      const ascii = head.toString('ascii')
      if (ascii.includes('ftyp')) return 'video/mp4'
      if (ascii.startsWith('RIFF') && ascii.includes('WEBP')) return 'image/webp'
    }
  } catch {}
  return ''
}


function verifyMediaSignature(fileName, exp, sig) {
  if (!MEDIA_SIGNING_SECRETS.length) return { ok: false, reason: 'no-secret' }

  const expSec = Number(exp)
  if (!fileName || !Number.isFinite(expSec) || !sig) return { ok: false, reason: 'missing' }

  const nowSec = Math.floor(Date.now() / 1000)
  if (expSec < nowSec) return { ok: false, reason: 'expired', payload: `${fileName}|${expSec}` }

  const payload = `${fileName}|${expSec}`

  for (const secret of MEDIA_SIGNING_SECRETS) {
    const expected = hmacHexWithSecret(payload, secret)
    try {
      const a = Buffer.from(String(sig), 'hex')
      const b = Buffer.from(String(expected), 'hex')
      if (a.length !== b.length) continue
      const ok = crypto.timingSafeEqual(a, b)
      if (ok) return { ok: true, reason: 'ok', payload, expected }
    } catch {
      return { ok: false, reason: 'bad-format', payload }
    }
  }

  return { ok: false, reason: 'bad-sig', payload }
}



const bootAutoReply = getAutoReplyConfig()
console.log('🤖 Settings:', {
  REQUIRE_API_KEY,
  REQUIRE_ADMIN_KEY,
  API_KEY_RING_SIZE: API_KEYS.length,
  ADMIN_KEY_RING_SIZE: ADMIN_KEYS.length,
  OPERATOR_KEY_RING_SIZE: OPERATOR_KEYS.length,
  VIEWER_KEY_RING_SIZE: VIEWER_KEYS.length,
  MEDIA_KEY_RING_SIZE: MEDIA_SIGNING_SECRETS.length,
  AUTO_REPLY_ENABLED: bootAutoReply.enabled,
  AUTO_REPLY_SCOPE: bootAutoReply.scope,
  AUTO_REPLY_MATCH_TYPE: bootAutoReply.matchType,
  AUTO_REPLY_MATCH_VALUE: bootAutoReply.matchValue,
  AUTO_REPLY_GROUP_PREFIX: bootAutoReply.groupPrefix,
  MAX_URL_FETCH_MB,
  URL_FETCH_TIMEOUT_MS,
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
function calcDelay() {
  const cfg = getQueueConfig()
  return cfg.baseDelayMs + Math.floor(Math.random() * cfg.jitterMs)
}
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

function stripPrefixByValue(text, prefixValue) {
  const t = String(text || '').trim()
  const p = String(prefixValue || '').trim()
  if (!p) return { ok: true, text: t }

  const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`^${escaped}(?:\\s|:|,|-)+`, 'i')

  if (re.test(t)) return { ok: true, text: t.replace(re, '').trim() }
  if (t.toLowerCase() === p.toLowerCase()) return { ok: true, text: '' }
  return { ok: false, text: t }
}

/**
 * "!bot hi" / "!bot: hi" / "!bot, hi" / "!bot - hi"
 */
function stripGroupPrefix(text) {
  return stripPrefixByValue(text, getAutoReplyConfig().groupPrefix)
}

function matchesAutoReply(text) {
  const cfg = getAutoReplyConfig()
  const t = String(text || '').trim()
  const v = String(cfg.matchValue || '').trim()
  if (!t || !v) return false

  if (cfg.matchType === 'equals') return t.toLowerCase() === v.toLowerCase()
  if (cfg.matchType === 'contains') return t.toLowerCase().includes(v.toLowerCase())
  if (cfg.matchType === 'regex') {
    try { return new RegExp(v, 'i').test(t) } catch { return false }
  }
  return false
}

const lastRuleReplyAt = new Map()

function matchValueByType(text, matchType, matchValue) {
  const t = String(text || '').trim()
  const v = String(matchValue || '').trim()
  if (matchType === 'any') return true
  if (!t || !v) return false
  if (matchType === 'equals') return t.toLowerCase() === v.toLowerCase()
  if (matchType === 'contains') return t.toLowerCase().includes(v.toLowerCase())
  if (matchType === 'regex') {
    try { return new RegExp(v, 'i').test(t) } catch { return false }
  }
  return false
}

function ruleScopeMatches(rule, isGroup) {
  if (rule.scope === 'both') return true
  if (rule.scope === 'group') return isGroup
  if (rule.scope === 'dm') return !isGroup
  return false
}

function normalizeDmFilterToken(raw) {
  return String(raw || '').trim().toLowerCase()
}

function collectDmIdentitySet(inbound) {
  const identities = new Set()
  const add = (v) => {
    const s = String(v || '').trim()
    if (!s) return
    identities.add(s.toLowerCase())
  }
  const addPhone = (v) => {
    const c = canonicalMsisdn(v)
    if (!c) return
    add(c)
    add(localMsisdnDisplay(c))
    add(intlMsisdnDisplay(c))
  }
  const addJid = (v) => {
    const j = normalizeJid(v)
    if (!j) return
    add(j)
    addPhone(msisdnFromJid(j))
  }

  const senderJid = normalizeJid(inbound?.senderJid || '')
  const chatJid = normalizeJid(inbound?.chatJid || '')
  addJid(senderJid)
  addJid(chatJid)

  const store = readContactsStore()
  const found = findContactByAnyDirectId(store, senderJid || chatJid || '', msisdnFromJid(senderJid || chatJid || ''))
  if (found) {
    add(found.name)
    addJid(found.jid)
    for (const a of normalizeAliasJids(found.aliasJids || [], found.jid || '')) addJid(a)
    addPhone(found.msisdn || '')
    addPhone(found.msisdnIntl || '')
  }

  return identities
}

function ruleDmFilterMatches(rule, inbound) {
  if (inbound?.isGroup) return true
  const mode = ['all', 'include', 'exclude'].includes(rule?.dmFilterMode) ? rule.dmFilterMode : 'all'
  if (mode === 'all') return true

  const values = Array.isArray(rule?.dmFilterValues)
    ? rule.dmFilterValues.map(normalizeDmFilterToken).filter(Boolean)
    : []
  if (!values.length) return mode !== 'include'

  const ids = collectDmIdentitySet(inbound)
  const matched = values.some(v => ids.has(v))
  if (mode === 'include') return matched
  if (mode === 'exclude') return !matched
  return true
}

function findMatchingResponseRule(inbound) {
  if (!responseRules?.enabled) return null

  const rules = Array.isArray(responseRules.rules) ? responseRules.rules : []
  for (const rawRule of rules) {
    const rule = normalizeResponseRule(rawRule, rawRule)
    if (!rule.enabled) continue
    if (!ruleScopeMatches(rule, inbound.isGroup)) continue
    if (!ruleDmFilterMatches(rule, inbound)) continue

    if (rule.triggerType === 'voice_note') {
      if (!inbound.voiceNote) continue
        console.log(`✅ Voice note rule matched: ${rule.id}`)
    } else {
      let candidateText = String(inbound.text || inbound.rawText || '').trim()
      if (!candidateText) continue

      if (inbound.isGroup && rule.requirePrefix) {
        const prefixed = stripPrefixByValue(candidateText, rule.groupPrefix || getAutoReplyConfig().groupPrefix)
        if (!prefixed.ok) continue
        candidateText = prefixed.text
        if (!candidateText && rule.matchType !== 'any') continue
      }

      if (!matchValueByType(candidateText, rule.matchType, rule.matchValue)) continue
    }

    const cooldownKey = `${rule.id}:${inbound.chatJid}`
    const last = lastRuleReplyAt.get(cooldownKey) || 0
    if (rule.cooldownMs > 0 && Date.now() - last < rule.cooldownMs) continue

    lastRuleReplyAt.set(cooldownKey, Date.now())
      console.log(`🎯 Response rule firing: ${rule.id} → "${rule.replyText.slice(0, 50)}"`)
    return rule
  }

  return null
}

async function queueAutoReplyMessage(chatJid, isGroup, replyText, source = 'auto', quotedMessageId = null) {
  const outMsgId = makeId(`out_${source}`)
  const payload = { text: String(replyText) }

  const outRec = {
    id: outMsgId,
    direction: 'out',
    ts: Date.now(),
    chatJid,
    senderJid: 'me',
    isGroup,
    type: 'text',
    text: payload.text,
    status: 'queued',
    media: null,
    quotedMessageId: quotedMessageId ? String(quotedMessageId) : null
  }
  addMessageRecord(outRec)
  upsertRecentMessage(outRec)

  await enqueue({
    id: makeId(`${source}_txt`),
    jid: chatJid,
    payload,
    createdAt: Date.now(),
    msgId: outMsgId,
    chatJid,
    quotedMessageId: quotedMessageId ? String(quotedMessageId) : null
  })

  return outMsgId
}

// SA normalization
function digitsOnly(input) {
  return String(input || '').replace(/[^\d]/g, '')
}

function canonicalMsisdn(input) {
  let digits = digitsOnly(input)
  if (!digits) return ''
  if (digits.startsWith('00')) digits = digits.slice(2)
  if (digits.startsWith('0')) digits = '27' + digits.slice(1)
  return digits
}

function localMsisdnDisplay(input) {
  const c = canonicalMsisdn(input)
  if (!c) return ''
  if (c.startsWith('27') && c.length >= 11) return '0' + c.slice(2)
  return c
}

function intlMsisdnDisplay(input) {
  const c = canonicalMsisdn(input)
  return c ? `+${c}` : ''
}

const lidReverseMsisdnCache = new Map()

function resolveLidToMsisdn(lidRaw) {
  const raw = String(lidRaw || '').trim()
  if (!raw) return ''

  const user = raw.includes('@') ? raw.split('@')[0] : raw
  const lid = user.replace(/\D+/g, '')
  if (!lid) return ''

  if (lidReverseMsisdnCache.has(lid)) {
    return lidReverseMsisdnCache.get(lid) || ''
  }

  // Avoid recursive/heavy lookups while contacts are being normalized.
  if (contactsNormalizationInProgress) return ''

  // Infer from in-memory contacts graph without triggering readContactsStore normalization.
  const lidJid = `${lid}@lid`
  const store = contactsStoreCache || { contacts: [] }
  const contact = (store.contacts || []).find(c => {
    if (String(c?.jid || '').trim().toLowerCase() === lidJid) return true
    const aliases = Array.isArray(c?.aliasJids) ? c.aliasJids : []
    return aliases.some(a => String(a || '').trim().toLowerCase() === lidJid)
  })

  const ms = canonicalMsisdn(contact?.msisdn || '')
  const local = localMsisdnDisplay(ms)
  lidReverseMsisdnCache.set(lid, local || '')
  return local || ''
}

function resolveLidToUserJid(lidRaw) {
  const msisdn = resolveLidToMsisdn(lidRaw)
  if (!msisdn) return ''
  try {
    return toUserJid(msisdn)
  } catch {
    return ''
  }
}

function msisdnFromJid(jidRaw) {
  const jid = String(jidRaw || '').trim()
  if (!jid) return ''
  if (jid.endsWith('@lid')) return canonicalMsisdn(resolveLidToMsisdn(jid))
  if (!jid.endsWith('@s.whatsapp.net') && !jid.endsWith('@w.whatsapp.net')) return ''
  const user = jid.split('@')[0] || ''
  return canonicalMsisdn(user)
}

function toUserJid(msisdn) {
  const raw = String(msisdn || '').trim()
  if (!raw) throw new Error('Invalid phone number (msisdn)')

  let digits = canonicalMsisdn(raw)
  if (digits.length < 9) throw new Error('Invalid phone number (too short)')

  return `${digits}@s.whatsapp.net`
}

function normalizeJid(jid) {
  const j = String(jid || '').trim()
  if (!j) return j
  // Already formatted: return as-is
  if (j.includes('@')) {
    const lower = j.toLowerCase()
    if (/^\d+@w\.whatsapp\.net$/.test(lower)) {
      return `${j.split('@')[0]}@s.whatsapp.net`
    }
    // NOTE: @lid JIDs are kept as-is here.
    // Resolving @lid → phone JID requires readContactsStore() which in turn calls
    // normalizeJid() via normalizeContactInput/normalizeAliasJids, causing infinite recursion.
    // Callers that need LID → phone resolution should call resolveLidToUserJid() explicitly.
    return j
  }
  // Looks like phone: convert
  if (looksLikePhone(j)) return toUserJid(j)
  // Unknown format: return as-is
  return j
}

function looksLikePhone(input) {
  const digits = String(input || '').replace(/[^\d]/g, '')
  return digits.length >= 9 && digits.length <= 15
}

function resolveBaileysBrowser() {
  try {
    if (WA_BROWSER_PROFILE === 'windows' || WA_BROWSER_PROFILE === 'win') return Browsers.windows('Desktop')
    if (WA_BROWSER_PROFILE === 'ubuntu' || WA_BROWSER_PROFILE === 'linux') return Browsers.ubuntu('Chrome')
    return Browsers.macOS('Desktop')
  } catch {
    return undefined
  }
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
  if (m.includes('mp4')) return 'mp4'
  if (m.includes('webm')) return 'webm'
  if (m.includes('quicktime') || m.includes('mov')) return 'mov'
  if (m.includes('x-matroska') || m.includes('mkv')) return 'mkv'
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
  const originalFileName = safeBase(fileNameRaw)
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
    fileName: outName,
    originalFileName,
    gifPlayback: Boolean(node?.gifPlayback)
  }
}

const LINK_PREVIEW_CACHE_TTL_MS = Math.max(60_000, Number(process.env.LINK_PREVIEW_CACHE_TTL_MS || 10 * 60 * 1000))
const LINK_PREVIEW_MAX_BYTES = Math.max(32_768, Number(process.env.LINK_PREVIEW_MAX_BYTES || 256 * 1024))
const linkPreviewCache = new Map()

function extractMetaTag(html, attr, name) {
  const key = String(name || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`<meta[^>]+${attr}=["']${key}["'][^>]*content=["']([^"']{1,600})["'][^>]*>`, 'i')
  const alt = new RegExp(`<meta[^>]+content=["']([^"']{1,600})["'][^>]*${attr}=["']${key}["'][^>]*>`, 'i')
  const m = html.match(re) || html.match(alt)
  return m?.[1] ? String(m[1]).trim() : ''
}

function extractTitleTag(html) {
  const m = String(html || '').match(/<title[^>]*>([\s\S]{1,400}?)<\/title>/i)
  if (!m?.[1]) return ''
  return String(m[1]).replace(/\s+/g, ' ').trim()
}

function normalizePreviewUrl(rawUrl) {
  const u = new URL(String(rawUrl || ''))
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only http/https URLs are supported')

  const host = String(u.hostname || '').toLowerCase()
  if (!host) throw new Error('Invalid URL host')
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') throw new Error('Localhost URLs are blocked')
  if (/^10\./.test(host)) throw new Error('Private network URL blocked')
  if (/^192\.168\./.test(host)) throw new Error('Private network URL blocked')
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) throw new Error('Private network URL blocked')

  return u
}

async function fetchLinkPreview(urlRaw) {
  const urlObj = normalizePreviewUrl(urlRaw)
  const cacheKey = urlObj.toString()
  const now = Date.now()
  const cached = linkPreviewCache.get(cacheKey)
  if (cached && Number(cached.expiresAt || 0) > now) return cached.preview

  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), 8_000)
  try {
    const res = await fetch(cacheKey, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': 'watson-link-preview/1.0' }
    })
    if (!res.ok) throw new Error(`Preview fetch failed: HTTP ${res.status}`)

    const ct = String(res.headers.get('content-type') || '').toLowerCase()
    if (!ct.includes('text/html')) throw new Error('URL is not an HTML page')

    const ab = await res.arrayBuffer()
    const buf = Buffer.from(ab)
    const safeBuf = buf.length > LINK_PREVIEW_MAX_BYTES ? buf.subarray(0, LINK_PREVIEW_MAX_BYTES) : buf
    const html = safeBuf.toString('utf8')

    const title = extractMetaTag(html, 'property', 'og:title') || extractTitleTag(html)
    const description = extractMetaTag(html, 'property', 'og:description') || extractMetaTag(html, 'name', 'description')
    const siteName = extractMetaTag(html, 'property', 'og:site_name') || urlObj.hostname
    const imageRaw = extractMetaTag(html, 'property', 'og:image')
    let image = ''
    if (imageRaw) {
      try { image = new URL(imageRaw, cacheKey).toString() } catch {}
    }

    const preview = {
      url: cacheKey,
      title: String(title || '').slice(0, 180),
      description: String(description || '').slice(0, 320),
      image,
      siteName: String(siteName || '').slice(0, 120),
      fetchedAt: Date.now()
    }

    linkPreviewCache.set(cacheKey, { preview, expiresAt: now + LINK_PREVIEW_CACHE_TTL_MS })
    return preview
  } finally {
    clearTimeout(t)
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
  // no-op: DB-backed
}

function readContactsStore() {
  if (!contactsStoreNeedsNormalize && contactsStoreCache && typeof contactsStoreCache === 'object') {
    return contactsStoreCache
  }

  const normalized = normalizeContactsStore(contactsStoreCache || { contacts: [], groups: [], updatedAt: Date.now() })
  if (normalized.__changed) {
    const { __changed, ...toSave } = normalized
    contactsStoreCache = toSave
    contactsStoreNeedsNormalize = false
    recanonicalizeMessagesUsingStore(toSave)
    return toSave
  }
  contactsStoreCache = normalized
  contactsStoreNeedsNormalize = false
  return normalized
}

function writeContactsStore(store) {
  const next = { ...store, updatedAt: Date.now() }
  dedupeContactsByIdentity(next)
  contactsStoreCache = next
  contactsStoreNeedsNormalize = false
  writeKvToDb('contacts', next).catch(() => {})
  recanonicalizeMessagesUsingStore(next)
  return next
}

function looksLikeAutoSuffixName(nameRaw = '') {
  const n = String(nameRaw || '').trim()
  if (!n) return false
  return /\(\d{3,8}\)(\s*#\d+)?$/.test(n)
}

function stripAutoSuffixName(nameRaw = '') {
  const n = String(nameRaw || '').trim()
  if (!n) return ''
  return n.replace(/\s*\(\d{3,8}\)(\s*#\d+)?$/, '').trim()
}

function pickPreferredContactName(currentNameRaw = '', incomingNameRaw = '') {
  const currentName = String(currentNameRaw || '').trim()
  const incomingName = String(incomingNameRaw || '').trim()
  if (!currentName) return incomingName
  if (!incomingName) return currentName

  const currentAuto = looksLikeAutoSuffixName(currentName)
  const incomingAuto = looksLikeAutoSuffixName(incomingName)
  if (currentAuto && !incomingAuto) return incomingName
  if (!currentAuto && incomingAuto) return currentName

  return incomingName.length > currentName.length ? incomingName : currentName
}

function normalizeAliasJids(values = [], preferredJidRaw = '') {
  const preferredJid = normalizeJid(preferredJidRaw)
  const rawList = Array.isArray(values)
    ? values
    : String(values || '')
      .split(/[\n,;]+/g)
      .map(v => v.trim())
      .filter(Boolean)

  const out = []
  const seen = new Set()
  for (const raw of rawList) {
    const j = normalizeJid(raw)
    if (!j) continue
    if (preferredJid && j === preferredJid) continue
    if (seen.has(j)) continue
    seen.add(j)
    out.push(j)
  }
  return out
}

function contactIdentityJids(contact) {
  const primary = normalizeJid(contact?.jid || '')
  return new Set([
    ...(primary ? [primary] : []),
    ...normalizeAliasJids(contact?.aliasJids || [], primary)
  ])
}

function contactIdentityMsisdns(contact) {
  const out = new Set()
  const direct = canonicalMsisdn(contact?.msisdn || '')
  if (direct) out.add(direct)
  for (const jid of contactIdentityJids(contact)) {
    const fromJid = msisdnFromJid(jid)
    if (fromJid) out.add(fromJid)
  }
  return out
}

function contactsShareIdentity(a, b) {
  if (!a || !b) return false

  const aJids = contactIdentityJids(a)
  const bJids = contactIdentityJids(b)
  for (const jid of aJids) {
    if (bJids.has(jid)) return true
  }

  const aMsisdns = contactIdentityMsisdns(a)
  const bMsisdns = contactIdentityMsisdns(b)
  for (const msisdn of aMsisdns) {
    if (bMsisdns.has(msisdn)) return true
  }

  return false
}

function mergeContactPair(baseContact, incomingContact) {
  const prev = baseContact || {}
  const normalized = normalizeContactInput(incomingContact || {})
  const mergedTags = Array.from(new Set([...(Array.isArray(prev.tags) ? prev.tags : []), ...(Array.isArray(normalized.tags) ? normalized.tags : [])]))
  const chosenName = pickPreferredContactName(prev.name, normalized.name)
  const preferredPrimaryJid = pickPreferredPrimaryJid(prev.jid, normalized.jid, normalized.msisdn || prev.msisdn || '')
  const mergedAliasJids = normalizeAliasJids([
    ...(Array.isArray(prev.aliasJids) ? prev.aliasJids : []),
    ...(Array.isArray(normalized.aliasJids) ? normalized.aliasJids : []),
    normalizeJid(prev.jid || ''),
    normalizeJid(normalized.jid || '')
  ], preferredPrimaryJid)

  const merged = {
    ...prev,
    ...normalized,
    name: chosenName,
    tags: mergedTags,
    jid: preferredPrimaryJid || normalized.jid || prev.jid || '',
    aliasJids: mergedAliasJids,
    msisdn: normalized.msisdn || prev.msisdn || '',
    msisdnIntl: normalized.msisdnIntl || prev.msisdnIntl || intlMsisdnDisplay(normalized.msisdn || prev.msisdn || '') || ''
  }

  if (!merged.msisdnIntl && merged.msisdn) {
    merged.msisdnIntl = intlMsisdnDisplay(merged.msisdn)
  }

  return merged
}

function dedupeContactsByIdentity(store) {
  const contacts = Array.isArray(store?.contacts) ? store.contacts : []
  if (contacts.length < 2) return false

  let changed = false
  const next = []

  for (const raw of contacts) {
    let merged = normalizeContactInput(raw || {})
    let mergedIntoExisting = false

    for (let i = 0; i < next.length; i++) {
      if (!contactsShareIdentity(next[i], merged)) continue
      next[i] = mergeContactPair(next[i], merged)
      mergedIntoExisting = true
      changed = true
      break
    }

    if (!mergedIntoExisting) next.push(merged)
  }

  if (changed) {
    store.contacts = next
  }

  return changed
}

function pickPreferredPrimaryJid(currentJidRaw = '', incomingJidRaw = '', msisdnRaw = '') {
  const currentJid = normalizeJid(currentJidRaw)
  const incomingJid = normalizeJid(incomingJidRaw)
  if (!currentJid) return incomingJid
  if (!incomingJid) return currentJid
  if (currentJid === incomingJid) return currentJid

  const isPhoneBased = (j) => j.endsWith('@s.whatsapp.net') || j.endsWith('@w.whatsapp.net')
  const currentPhone = isPhoneBased(currentJid)
  const incomingPhone = isPhoneBased(incomingJid)
  if (currentPhone && !incomingPhone) return currentJid
  if (!currentPhone && incomingPhone) return incomingJid

  const wantedCanonical = canonicalMsisdn(msisdnRaw || '')
  if (wantedCanonical) {
    const currentCanonical = msisdnFromJid(currentJid)
    const incomingCanonical = msisdnFromJid(incomingJid)
    if (incomingCanonical === wantedCanonical && currentCanonical !== wantedCanonical) return incomingJid
    if (currentCanonical === wantedCanonical && incomingCanonical !== wantedCanonical) return currentJid
  }

  return incomingJid
}

function normalizeContactsStore(storeRaw) {
  contactsNormalizationInProgress = true
  try {
  const base = {
    contacts: Array.isArray(storeRaw?.contacts) ? storeRaw.contacts : [],
    groups: Array.isArray(storeRaw?.groups) ? storeRaw.groups : [],
    updatedAt: Number(storeRaw?.updatedAt || Date.now())
  }

  const deduped = { contacts: [], groups: base.groups, updatedAt: base.updatedAt }
  for (const c of base.contacts) {
    try {
      upsertContact(deduped, c, { skipDedupe: true })
    } catch {}
  }

  if (dedupeContactsByIdentity(deduped)) {
    // keep processing below so any remaining name-based cleanup also applies
  }

  // Merge leftover name-collision duplicates like "Name" and "Name (1234)"
  // when one side is LID and the other is phone-based JID.
  const rows = [...deduped.contacts]
  const byBaseName = new Map()

  for (let i = 0; i < rows.length; i++) {
    const name = String(rows[i]?.name || '').trim()
    if (!name || looksLikeAutoSuffixName(name)) continue
    byBaseName.set(norm(name), i)
  }

  const removed = new Set()

  for (let i = 0; i < rows.length; i++) {
    if (removed.has(i)) continue
    const cur = rows[i]
    const curName = String(cur?.name || '').trim()
    const baseName = stripAutoSuffixName(curName)

    if (!looksLikeAutoSuffixName(curName) || !baseName) {
      continue
    }

    const targetIdx = byBaseName.get(norm(baseName))
    if (targetIdx == null || targetIdx === i || removed.has(targetIdx)) {
      continue
    }

    const target = rows[targetIdx]
    const curJid = normalizeJid(cur?.jid || '')
    const targetJid = normalizeJid(target?.jid || '')
    const lidInvolved = curJid.endsWith('@lid') || targetJid.endsWith('@lid')
    const phoneJidInvolved = curJid.endsWith('@s.whatsapp.net') || targetJid.endsWith('@s.whatsapp.net') || curJid.endsWith('@w.whatsapp.net') || targetJid.endsWith('@w.whatsapp.net')

    if (!(lidInvolved && phoneJidInvolved)) {
      continue
    }

    const mergedTags = Array.from(new Set([...(Array.isArray(target.tags) ? target.tags : []), ...(Array.isArray(cur.tags) ? cur.tags : [])]))
    const preferredJid = (targetJid.endsWith('@s.whatsapp.net') || targetJid.endsWith('@w.whatsapp.net'))
      ? targetJid
      : ((curJid.endsWith('@s.whatsapp.net') || curJid.endsWith('@w.whatsapp.net')) ? curJid : (targetJid || curJid || ''))
    const mergedAliasJids = normalizeAliasJids([
      ...(Array.isArray(target.aliasJids) ? target.aliasJids : []),
      ...(Array.isArray(cur.aliasJids) ? cur.aliasJids : []),
      targetJid,
      curJid
    ], preferredJid)

    rows[targetIdx] = {
      ...target,
      tags: mergedTags,
      jid: preferredJid || target.jid || cur.jid || '',
      aliasJids: mergedAliasJids,
      msisdn: String(target.msisdn || cur.msisdn || '').trim(),
      msisdnIntl: String(target.msisdnIntl || cur.msisdnIntl || '').trim(),
      name: pickPreferredContactName(target.name, baseName)
    }
    removed.add(i)
  }

  if (removed.size) {
    deduped.contacts = rows.filter((_, idx) => !removed.has(idx))
  }

  const before = JSON.stringify(base.contacts)
  const after = JSON.stringify(deduped.contacts)
  if (before !== after) return { ...deduped, __changed: true }
  return deduped
  } finally {
    contactsNormalizationInProgress = false
  }
}

function rebuildRecentChatIndex() {
  chatIndex.clear()
  for (const normalized of recentMessages) {
    const key = normalized.chatJid
    if (!key) continue
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
}

function buildCanonicalChatJidMap(store) {
  const out = new Map()
  for (const contact of (store?.contacts || [])) {
    const canonical = resolveCanonicalChatJidFromContact(contact)
    if (!canonical || isGroupJid(canonical)) continue
    out.set(canonical, canonical)
    const deliveryJid = resolveDeliveryJidFromContact(contact)
    if (deliveryJid) out.set(deliveryJid, canonical)
    for (const alias of normalizeAliasJids(contact?.aliasJids || [], contact?.jid || '')) {
      out.set(alias, canonical)
    }
    const msisdn = String(contact?.msisdn || '').trim()
    if (msisdn) {
      try { out.set(toUserJid(msisdn), canonical) } catch {}
    }
  }
  return out
}

function recanonicalizeMessagesUsingStore(store) {
  const canonicalByJid = buildCanonicalChatJidMap(store)
  if (!canonicalByJid.size) return false

  let changed = false
  const messageStore = readMessagesStore()
  for (let i = 0; i < messageStore.messages.length; i++) {
    const msg = messageStore.messages[i]
    const msgChatJid = normalizeJid(msg?.chatJid || '')
    const canonical = canonicalByJid.get(msgChatJid) || ''
    if (!msgChatJid || !canonical || msgChatJid === canonical) continue
    messageStore.messages[i] = { ...msg, chatJid: canonical }
    changed = true
  }
  if (changed) writeMessagesStore(messageStore)

  for (let i = 0; i < recentMessages.length; i++) {
    const msg = recentMessages[i]
    const msgChatJid = normalizeJid(msg?.chatJid || '')
    const canonical = canonicalByJid.get(msgChatJid) || ''
    if (!msgChatJid || !canonical || msgChatJid === canonical) continue
    recentMessages[i] = { ...msg, chatJid: canonical }
  }
  if (changed) rebuildRecentChatIndex()

  return changed
}

function recanonicalizeMessagesForContact(contact, storeOverride = null) {
  const store = storeOverride || readContactsStore()
  const canonical = resolveCanonicalChatJidFromContact(contact)
  if (!canonical || isGroupJid(canonical)) return false
  return recanonicalizeMessagesUsingStore({ ...store, contacts: [
    ...((store?.contacts || []).filter(c => !contactsShareIdentity(c, contact))),
    contact
  ]})
}

/**
 * ----------------------------
 * Notice boards store
 * ----------------------------
 */
let boards = [] // [{ slug, name, displayTitle, chatJid, enabled, showDir, size, density, createdAt, url }]

function normalizeBoardSize(sizeRaw = '') {
  const size = String(sizeRaw || '').trim().toLowerCase()
  return ['xs', 's', 'm', 'l', 'xl'].includes(size) ? size : 'm'
}

function normalizeBoardDensity(densityRaw = '') {
  const density = String(densityRaw || '').trim().toLowerCase()
  return ['wide', 'normal', 'compact'].includes(density) ? density : 'normal'
}

function buildBoardUrl(slug, reqLike = null, sizeRaw = 'm', densityRaw = 'normal') {
  const safeSlug = encodeURIComponent(String(slug || '').trim())
  const size = normalizeBoardSize(sizeRaw)
  const density = normalizeBoardDensity(densityRaw)
  const proto = String(reqLike?.headers?.['x-forwarded-proto'] || reqLike?.protocol || 'http').split(',')[0].trim()
  const host = String(reqLike?.headers?.['x-forwarded-host'] || reqLike?.get?.('host') || reqLike?.headers?.host || '').trim()
  const url = new URL(`${proto}://${host}/board/${safeSlug}`)
  url.searchParams.set('size', size)
  url.searchParams.set('density', density)
  return url.toString()
}

function normalizeBoards(raw) {
  return (Array.isArray(raw) ? raw : []).map((board) => {
    const size = normalizeBoardSize(board?.size || 'm')
    const density = normalizeBoardDensity(board?.density || 'normal')
    const baseUrl = String(board?.url || '').trim()
    if (!baseUrl) return { ...board, size, density }
    try {
      const u = new URL(baseUrl)
      u.searchParams.set('size', size)
      u.searchParams.set('density', density)
      return { ...board, size, density, url: u.toString() }
    } catch {
      return { ...board, size, density }
    }
  })
}

function loadBoards() {
  try {
    boards = normalizeBoards(boards)
    console.log(`📢 Loaded ${boards.length} notice board(s) (from db)`)
  } catch (e) {
    console.warn('⚠️ Failed to load boards:', e.message)
    boards = []
  }
}

function saveBoards() {
  writeKvToDb('boards', boards).catch(() => {})
}

function generateSlug(name) {
  const base = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return base || 'board'
}

function upsertContact(store, contact, opts = {}) {
  const normalized = normalizeContactInput(contact)
  const key = norm(normalized.name)
  if (!key) throw new Error('Contact name required')

  const incomingJid = normalizeJid(normalized.jid)
  const incomingMsisdnCanonical = canonicalMsisdn(normalized.msisdn || '') || msisdnFromJid(incomingJid)

  let idx = -1
  // CRITICAL: Match by identity (JID/MSISDN) first. Never merge different identities just because they have the same name.
  // This prevents "Pieter" with JID A from merging with "Pieter" with JID B.
  if (incomingJid || incomingMsisdnCanonical) {
    idx = (store.contacts || []).findIndex(c => {
      const cJid = normalizeJid(c?.jid)
      const cMsisdnCanonical = canonicalMsisdn(c?.msisdn || '') || msisdnFromJid(c?.jid || '')
      if (incomingJid && cJid === incomingJid) return true
      if (incomingMsisdnCanonical && cMsisdnCanonical === incomingMsisdnCanonical) return true
      return false
    })
  }
  // DO NOT fall back to name-based matching. Multiple different JIDs can have the same name.
  // Name-based deduplication happens only during normalizeContactsStore() with proper LID↔phone logic.

  if (idx >= 0) {
    const prev = store.contacts[idx] || {}
    const mergedTags = Array.from(new Set([...(Array.isArray(prev.tags) ? prev.tags : []), ...(Array.isArray(normalized.tags) ? normalized.tags : [])]))
    const chosenName = pickPreferredContactName(prev.name, normalized.name)
    const preferredPrimaryJid = pickPreferredPrimaryJid(prev.jid, normalized.jid, normalized.msisdn || prev.msisdn || '')
    const mergedAliasJids = normalizeAliasJids([
      ...(Array.isArray(prev.aliasJids) ? prev.aliasJids : []),
      ...(Array.isArray(normalized.aliasJids) ? normalized.aliasJids : []),
      normalizeJid(prev.jid || ''),
      normalizeJid(normalized.jid || '')
    ], preferredPrimaryJid)
    store.contacts[idx] = {
      ...prev,
      ...normalized,
      name: chosenName,
      tags: mergedTags,
      jid: preferredPrimaryJid || normalized.jid || prev.jid || '',
      aliasJids: mergedAliasJids,
      msisdn: normalized.msisdn || prev.msisdn || '',
      msisdnIntl: normalized.msisdnIntl || prev.msisdnIntl || intlMsisdnDisplay(normalized.msisdn || prev.msisdn || '') || ''
    }
    if (!store.contacts[idx].msisdnIntl && store.contacts[idx].msisdn) {
      store.contacts[idx].msisdnIntl = intlMsisdnDisplay(store.contacts[idx].msisdn)
    }
  } else {
    const next = { ...normalized }
    if (!next.msisdnIntl && next.msisdn) next.msisdnIntl = intlMsisdnDisplay(next.msisdn)
    next.aliasJids = normalizeAliasJids(next.aliasJids || [], next.jid)
    store.contacts.push(next)
  }
  if (!opts?.skipDedupe) dedupeContactsByIdentity(store)
  return store
}

function normalizeContactInput(contact) {
  const next = {
    name: String(contact?.name || '').trim(),
    tags: Array.isArray(contact?.tags) ? contact.tags : []
  }

  const rawJid = String(contact?.jid || '').trim()
  const rawMsisdn = String(contact?.msisdn || '').trim()

  if (rawJid) next.jid = normalizeJid(rawJid)

  const rawAliasJids = Object.prototype.hasOwnProperty.call(contact || {}, 'aliasJids')
    ? contact.aliasJids
    : []
  next.aliasJids = normalizeAliasJids(rawAliasJids, next.jid || '')

  if (rawMsisdn) {
    if (rawMsisdn.includes('@')) {
      next.jid = normalizeJid(rawMsisdn)
      const fromJid = localMsisdnDisplay(msisdnFromJid(next.jid))
      if (fromJid) next.msisdn = fromJid
    } else {
      next.msisdn = localMsisdnDisplay(rawMsisdn)
    }
  }

  if (!next.msisdn && next.jid) {
    const j = String(next.jid || '').toLowerCase()
    if (j.endsWith('@s.whatsapp.net') || j.endsWith('@w.whatsapp.net')) {
      const fromJid = localMsisdnDisplay(msisdnFromJid(next.jid))
      if (fromJid) next.msisdn = fromJid
    }
  }

  if (next.msisdn) {
    next.msisdnIntl = intlMsisdnDisplay(next.msisdn)
  }

  next.aliasJids = normalizeAliasJids(next.aliasJids || [], next.jid || '')

  return next
}

function resolveDeliveryJidFromContact(contact) {
  const aliases = normalizeAliasJids(contact?.aliasJids || [], contact?.jid || '')
  const lidAlias = aliases.find(a => a.endsWith('@lid'))
  if (lidAlias) return lidAlias

  const explicitJid = normalizeJid(contact?.jid || '')
  if (explicitJid) return explicitJid

  const msisdn = String(contact?.msisdn || '').trim()
  if (msisdn) {
    try {
      return toUserJid(msisdn)
    } catch {}
  }
  return normalizeJid(contact?.jid || '')
}

function resolveCanonicalChatJidFromContact(contact) {
  const primary = normalizeJid(contact?.jid || '')
  if (primary) return primary

  const msisdn = String(contact?.msisdn || '').trim()
  if (msisdn) {
    try {
      return toUserJid(msisdn)
    } catch {}
  }

  const aliases = normalizeAliasJids(contact?.aliasJids || [], '')
  return aliases[0] || ''
}

function findContactByAnyDirectId(store, jidRaw, msisdnRaw = '') {
  const jid = normalizeJid(jidRaw)
  const msisdnCanonical = canonicalMsisdn(msisdnRaw || '') || msisdnFromJid(jid)
  return (store.contacts || []).find(c => {
    const cJid = normalizeJid(c?.jid || '')
    if (jid && cJid === jid) return true
    const cAliases = normalizeAliasJids(c?.aliasJids || [], cJid)
    if (jid && cAliases.includes(jid)) return true
    const cMsisdnCanonical = canonicalMsisdn(c?.msisdn || '') || msisdnFromJid(cJid)
    if (msisdnCanonical && cMsisdnCanonical === msisdnCanonical) return true
    if (msisdnCanonical) {
      for (const a of cAliases) {
        if (msisdnFromJid(a) === msisdnCanonical) return true
      }
    }
    return false
  }) || null
}

function resolvePreferredChatJid(inputJidRaw) {
  const jid = normalizeJid(inputJidRaw)
  if (!jid || isGroupJid(jid)) return jid

  // Prefer phone JID when a LID can be mapped via contact identity cache.
  if (jid.endsWith('@lid')) {
    const lidResolved = resolveLidToUserJid(jid)
    if (lidResolved) return lidResolved
  }

  const store = readContactsStore()
  const found = findContactByAnyDirectId(store, jid, msisdnFromJid(jid))
  if (!found) return jid
  return resolveCanonicalChatJidFromContact(found) || jid
}

function resolveEquivalentChatJids(chatJidRaw) {
  const chatJid = normalizeJid(chatJidRaw)
  if (!chatJid) return new Set()
  if (isGroupJid(chatJid)) return new Set([chatJid])

  const out = new Set([chatJid])

  // Add direct LID ↔ phone equivalent when available, even without a full contact entry.
  if (chatJid.endsWith('@lid')) {
    const lidResolved = resolveLidToUserJid(chatJid)
    if (lidResolved) out.add(lidResolved)
  }

  const store = readContactsStore()
  const found = findContactByAnyDirectId(store, chatJid, msisdnFromJid(chatJid))
  if (!found) return out

  const canonical = resolveCanonicalChatJidFromContact(found)
  if (canonical) out.add(canonical)
  const preferred = resolveDeliveryJidFromContact(found)
  if (preferred) out.add(preferred)
  const storedJid = normalizeJid(found?.jid || '')
  if (storedJid) out.add(storedJid)
  for (const alias of normalizeAliasJids(found?.aliasJids || [], storedJid)) {
    out.add(alias)
  }
  if (found?.msisdn) {
    try { out.add(toUserJid(found.msisdn)) } catch {}
  }
  return out
}

function enrichContactIdentity(store, contact, { jid = '', msisdn = '', displayName = '' } = {}) {
  if (!contact || typeof contact !== 'object') return { contact, changed: false }

  const next = { ...contact }
  let changed = false

  const normalizedJid = normalizeJid(jid)
  const normalizedMsisdn = localMsisdnDisplay(msisdn || msisdnFromJid(normalizedJid || next.jid || ''))
  const normalizedName = String(displayName || '').trim()

  if (normalizedJid && normalizeJid(next.jid) !== normalizedJid) {
    const preferred = pickPreferredPrimaryJid(next.jid, normalizedJid, normalizedMsisdn || next.msisdn || '')
    const aliases = normalizeAliasJids([
      ...(Array.isArray(next.aliasJids) ? next.aliasJids : []),
      normalizeJid(next.jid || ''),
      normalizedJid
    ], preferred)
    if (normalizeJid(next.jid) !== preferred) {
      next.jid = preferred
      changed = true
    }
    if (JSON.stringify(aliases) !== JSON.stringify(Array.isArray(next.aliasJids) ? next.aliasJids : [])) {
      next.aliasJids = aliases
      changed = true
    }
  }

  if (normalizedMsisdn && String(next.msisdn || '').trim() !== normalizedMsisdn) {
    next.msisdn = normalizedMsisdn
    changed = true
  }

  const normalizedIntl = intlMsisdnDisplay(normalizedMsisdn || next.msisdn || '')
  if (normalizedIntl && String(next.msisdnIntl || '').trim() !== normalizedIntl) {
    next.msisdnIntl = normalizedIntl
    changed = true
  }

  if (!next.name && normalizedName) {
    next.name = normalizedName
    changed = true
  }

  if (!next.jid && next.msisdn) {
    next.jid = toUserJid(next.msisdn)
    changed = true
  }

  if (!Array.isArray(next.tags)) {
    next.tags = []
    changed = true
  }

  const aliasJids = normalizeAliasJids(next.aliasJids || [], next.jid || '')
  if (JSON.stringify(aliasJids) !== JSON.stringify(Array.isArray(next.aliasJids) ? next.aliasJids : [])) {
    next.aliasJids = aliasJids
    changed = true
  }

  return { contact: next, changed }
}

function contactNameExistsForDifferentJid(store, name, jid) {
  const wanted = norm(name)
  const targetJid = normalizeJid(jid)
  if (!wanted || !targetJid) return false
  return (store.contacts || []).some(c => norm(c.name) === wanted && normalizeJid(c.jid) !== targetJid)
}

function jidSuffixForName(jidRaw) {
  const jid = normalizeJid(jidRaw)
  const user = String(jid || '').split('@')[0] || ''
  if (!user) return 'user'
  const digits = user.replace(/\D+/g, '')
  if (digits.length >= 4) return digits.slice(-4)
  return user.slice(-4)
}

function makeUniqueContactName(store, baseName, jid) {
  const base = String(baseName || '').trim()
  if (!base) return ''
  if (!contactNameExistsForDifferentJid(store, base, jid)) return base
  const suffix = jidSuffixForName(jid)
  const candidate = `${base} (${suffix})`
  if (!contactNameExistsForDifferentJid(store, candidate, jid)) return candidate

  let i = 2
  while (i < 1000) {
    const alt = `${candidate} #${i}`
    if (!contactNameExistsForDifferentJid(store, alt, jid)) return alt
    i++
  }
  return `${candidate}-${Date.now()}`
}

function resolveInboundDisplayName(senderJid, pushNameRaw = '') {
  const fromPush = String(pushNameRaw || '').trim()
  if (fromPush) return fromPush

  const jid = normalizeJid(senderJid)
  const fromCache = String(contactCache.byJid.get(jid)?.name || '').trim()
  if (fromCache) return fromCache

  return ''
}

function autoAddInboundContact(senderJidRaw, displayNameRaw = '') {
  const jid = normalizeJid(senderJidRaw)
  if (!jid || jid.endsWith('@g.us')) return null

  const displayName = String(displayNameRaw || '').trim()

  const store = readContactsStore()
  const inboundMsisdn = localMsisdnDisplay(msisdnFromJid(jid))

  const existingIdx = findContactIndex(store, { jid, msisdn: inboundMsisdn })
  if (existingIdx >= 0) {
    const existing = store.contacts[existingIdx]
    const { contact: updated, changed } = enrichContactIdentity(store, existing, {
      jid,
      msisdn: inboundMsisdn,
      displayName
    })
    if (changed) {
      store.contacts[existingIdx] = updated
      writeContactsStore(store)
    }
    return updated
  }

  // If no direct jid/msisdn match was found, try a safe same-name merge first.
  // This avoids creating duplicate contacts when a manually-added phone contact
  // later replies from a LID identity.
  if (displayName) {
    const nameMatches = (store.contacts || [])
      .map((c, i) => ({ i, key: norm(c?.name || '') }))
      .filter(x => x.key && x.key === norm(displayName))

    if (nameMatches.length === 1) {
      const idx = nameMatches[0].i
      const existing = store.contacts[idx]
      const { contact: updated, changed } = enrichContactIdentity(store, existing, {
        jid,
        msisdn: inboundMsisdn,
        displayName
      })
      if (changed) {
        store.contacts[idx] = updated
        writeContactsStore(store)
      }
      return updated
    }
  }

  if (!displayName) return null

  const name = makeUniqueContactName(store, displayName, jid)
  if (!name) return null

  const contact = { name, jid, tags: [] }
  if (inboundMsisdn) {
    contact.msisdn = inboundMsisdn
  }

  upsertContact(store, contact)
  writeContactsStore(store)
  return contact
}

function deleteContact(store, name) {
  const before = store.contacts.length
  store.contacts = store.contacts.filter(c => norm(c.name) !== norm(name))
  return before !== store.contacts.length
}

function findContactIndex(store, matcher = {}) {
  const normalizeDigits = (v) => String(v || '').replace(/[^\d]/g, '')
  const byName = norm(matcher.name)
  const byJid = normalizeJid(matcher.jid)
  const byMsisdn = normalizeDigits(matcher.msisdn || '')

  return (store.contacts || []).findIndex(c => {
    if (byName && norm(c.name) === byName) return true
    if (byJid && normalizeJid(c.jid) === byJid) return true
    if (byJid) {
      const aliases = normalizeAliasJids(c?.aliasJids || [], c?.jid || '')
      if (aliases.includes(byJid)) return true
    }
    if (byMsisdn && normalizeDigits(c.msisdn || '') === byMsisdn) return true
    return false
  })
}

function renameOrUpdateContact(store, selector, patch = {}) {
  const idx = findContactIndex(store, selector)
  if (idx < 0) {
    const err = new Error('Contact not found')
    err.code = 'CONTACT_NOT_FOUND'
    throw err
  }

  const existing = store.contacts[idx] || {}
  const incomingName = String(patch.newName || patch.name || existing.name || '').trim()
  if (!incomingName) {
    const err = new Error('name required')
    err.code = 'CONTACT_NAME_REQUIRED'
    throw err
  }

  const normalizedPatch = normalizeContactInput({
    name: incomingName,
    msisdn: Object.prototype.hasOwnProperty.call(patch, 'msisdn') ? patch.msisdn : existing.msisdn,
    jid: Object.prototype.hasOwnProperty.call(patch, 'jid') ? patch.jid : existing.jid,
    aliasJids: Object.prototype.hasOwnProperty.call(patch, 'aliasJids') ? patch.aliasJids : existing.aliasJids,
    tags: Object.prototype.hasOwnProperty.call(patch, 'tags') ? patch.tags : existing.tags
  })

  const incomingMsisdn = String(normalizedPatch.msisdn || '').trim()
  const incomingJid = String(normalizedPatch.jid || '').trim()
  const incomingAliasJids = normalizeAliasJids(normalizedPatch.aliasJids || [], incomingJid)
  const incomingTags = Object.prototype.hasOwnProperty.call(patch, 'tags')
    ? (Array.isArray(patch.tags) ? patch.tags : [])
    : (Array.isArray(existing.tags) ? existing.tags : [])

  const nameKey = norm(incomingName)
  const targetJid = normalizeJid(incomingJid)
  const targetMsisdnCanonical = canonicalMsisdn(incomingMsisdn || '') || msisdnFromJid(targetJid)

  const duplicateNameIdx = (store.contacts || []).findIndex((c, i) => i !== idx && norm(c.name) === nameKey)
  if (duplicateNameIdx >= 0) {
    const err = new Error('Contact name already exists')
    err.code = 'CONTACT_NAME_EXISTS'
    throw err
  }

  if (targetJid) {
    const duplicateJidIdx = (store.contacts || []).findIndex((c, i) => {
      if (i === idx) return false
      const cPrimary = normalizeJid(c.jid)
      if (cPrimary === targetJid) return true
      const cAliases = normalizeAliasJids(c?.aliasJids || [], cPrimary)
      return cAliases.includes(targetJid)
    })
    if (duplicateJidIdx >= 0) {
      const err = new Error('Contact jid already exists')
      err.code = 'CONTACT_JID_EXISTS'
      throw err
    }
  }

  if (incomingAliasJids.length) {
    const duplicateAlias = incomingAliasJids.find(a => {
      return (store.contacts || []).some((c, i) => {
        if (i === idx) return false
        const cPrimary = normalizeJid(c.jid)
        if (cPrimary === a) return true
        const cAliases = normalizeAliasJids(c?.aliasJids || [], cPrimary)
        return cAliases.includes(a)
      })
    })
    if (duplicateAlias) {
      const err = new Error('Contact alias jid already exists')
      err.code = 'CONTACT_JID_EXISTS'
      throw err
    }
  }

  if (targetMsisdnCanonical) {
    const duplicateMsisdnIdx = (store.contacts || []).findIndex((c, i) => {
      if (i === idx) return false
      const cCanonical = canonicalMsisdn(c?.msisdn || '') || msisdnFromJid(c?.jid || '')
      return cCanonical === targetMsisdnCanonical
    })
    if (duplicateMsisdnIdx >= 0) {
      const err = new Error('Contact phone already exists')
      err.code = 'CONTACT_MSISDN_EXISTS'
      throw err
    }
  }

  const updated = {
    ...existing,
    name: incomingName,
    tags: incomingTags,
    aliasJids: incomingAliasJids,
  }

  if (incomingMsisdn) updated.msisdn = incomingMsisdn
  else delete updated.msisdn

  if (incomingJid) updated.jid = incomingJid
  else delete updated.jid

  store.contacts[idx] = updated
  return { before: existing, contact: updated }
}

function mergeContacts(store, { targetName = '', sourceName = '' } = {}) {
  const targetKey = String(targetName || '').trim()
  const sourceKey = String(sourceName || '').trim()
  if (!targetKey || !sourceKey) {
    const err = new Error('targetName and sourceName are required')
    err.code = 'CONTACT_MERGE_REQUIRED'
    throw err
  }
  if (norm(targetKey) === norm(sourceKey)) {
    const err = new Error('Pick two different contacts to merge')
    err.code = 'CONTACT_MERGE_SAME'
    throw err
  }

  const targetIdx = findContactIndex(store, { name: targetKey })
  const sourceIdx = findContactIndex(store, { name: sourceKey })
  if (targetIdx < 0 || sourceIdx < 0) {
    const err = new Error('Contact not found')
    err.code = 'CONTACT_NOT_FOUND'
    throw err
  }

  const target = store.contacts[targetIdx] || {}
  const source = store.contacts[sourceIdx] || {}
  const mergedBase = mergeContactPair(target, source)
  const preferredPrimaryJid = normalizeJid(target?.jid || '') || normalizeJid(mergedBase?.jid || '') || normalizeJid(source?.jid || '')
  const merged = {
    ...mergedBase,
    name: String(target?.name || mergedBase?.name || source?.name || '').trim(),
    jid: preferredPrimaryJid,
    aliasJids: normalizeAliasJids([
      ...(Array.isArray(mergedBase?.aliasJids) ? mergedBase.aliasJids : []),
      normalizeJid(target?.jid || ''),
      normalizeJid(source?.jid || '')
    ], preferredPrimaryJid)
  }

  store.contacts = (store.contacts || []).filter((_, idx) => idx !== targetIdx && idx !== sourceIdx)
  store.contacts.push(merged)
  dedupeContactsByIdentity(store)

  return { targetBefore: target, sourceBefore: source, contact: merged }
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

function readMessagesStore() {
  return messagesStoreCache
}

function writeMessagesStore(store) {
  const next = { ...store, updatedAt: Date.now() }
  messagesStoreCache = next
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
  const msgCfg = getMessageStorageConfig()
  const msg = {
    id: rec.id || makeId('msg'),
    waMsgId: rec.waMsgId ? String(rec.waMsgId) : null,
    ts: rec.ts || Date.now(),
    direction: rec.direction || 'in', // in | out
    chatJid: normalizeJid(rec.chatJid),
    senderJid: rec.senderJid ? String(rec.senderJid) : '',
    isGroup: Boolean(rec.isGroup),
    type: rec.type || 'text',
    text: rec.text ? String(rec.text) : '',
    media: rec.media || null,
    status: rec.status || null,
    quotedMessageId: rec.quotedMessageId ? String(rec.quotedMessageId) : null
  }

  if (!msg.chatJid) return msg

  store.messages.push(msg)
  const persistMax = Number(msgCfg.persistMax || 0)
  if (persistMax > 0 && store.messages.length > persistMax) {
    store.messages.splice(0, store.messages.length - persistMax)
  }
  writeMessagesStore(store)
  persistMessageRecordToDb(msg)
  return msg
}

function updateMessageStatus(id, patch) {
  const store = readMessagesStore();
  const idx = store.messages.findIndex(m => m.id === id);
  if (idx === -1) return null;

  const nextPatch = { ...patch, statusTs: Date.now() };   // ✅ add
  store.messages[idx] = { ...store.messages[idx], ...nextPatch };
  writeMessagesStore(store);
  patchMessageInDbById(id, { ...nextPatch });
  return store.messages[idx];
}

function updateMessageStatusByWaMsgId(waMsgId, patch) {
  const key = String(waMsgId || '').trim()
  if (!key) return null

  const store = readMessagesStore()
  const idx = store.messages.findIndex(m => String(m?.waMsgId || '') === key)
  if (idx === -1) return null

  const nextPatch = { ...patch, statusTs: Date.now() }
  store.messages[idx] = { ...store.messages[idx], ...nextPatch }
  writeMessagesStore(store)
  patchMessageInDbByWaMsgId(waMsgId, { ...nextPatch })
  return store.messages[idx]
}

function updateMessageStatusByAnyId(idOrWaId, patch) {
  const id = String(idOrWaId || '').trim()
  if (!id) return null
  return updateMessageStatus(id, patch) || updateMessageStatusByWaMsgId(id, patch)
}

function linkMessageWaId(messageId, waMsgId) {
  const id = String(messageId || '').trim()
  const waId = String(waMsgId || '').trim()
  if (!id || !waId) return null

  const store = readMessagesStore()
  const idx = store.messages.findIndex(m => String(m?.id || '') === id)
  if (idx === -1) return null

  const prev = store.messages[idx]
  if (String(prev?.waMsgId || '') === waId) return prev

  store.messages[idx] = { ...prev, waMsgId: waId }
  writeMessagesStore(store)
  patchMessageInDbById(id, { waMsgId: waId })
  return store.messages[idx]
}

function updateMessageChatJidById(id, chatJidRaw) {
  const nextJid = normalizeJid(chatJidRaw)
  if (!nextJid) return null

  const store = readMessagesStore()
  const idx = store.messages.findIndex(m => m.id === id)
  if (idx === -1) return null

  const prev = store.messages[idx]
  const prevJid = normalizeJid(prev.chatJid)
  if (!prevJid || prevJid === nextJid) return prev

  store.messages[idx] = { ...prev, chatJid: nextJid }
  writeMessagesStore(store)
  patchMessageInDbById(id, { chatJid: nextJid })
  return store.messages[idx]
}

function summarizeDeliveryLifecycle(windowSize = 2000, failedLimit = 8) {
  const store = readMessagesStore()
  const all = Array.isArray(store.messages) ? store.messages : []
  const safeWindow = Math.max(100, Number(windowSize) || 2000)
  const recent = all.slice(-safeWindow)

  const lifecycle = {
    queued: 0,
    retrying: 0,
    sent: 0,
    delivered: 0,
    read: 0,
    failed: 0,
    other: 0
  }

  let inbound = 0
  let outbound = 0
  const recentFailed = []

  for (const m of recent) {
    const direction = String(m?.direction || '').toLowerCase()
    if (direction === 'in') {
      inbound++
      continue
    }
    if (direction !== 'out') continue

    outbound++
    const status = String(m?.status || '').toLowerCase()
    if (Object.prototype.hasOwnProperty.call(lifecycle, status)) lifecycle[status]++
    else lifecycle.other++

    if (status === 'failed') {
      recentFailed.push({
        id: m?.id || null,
        chatJid: m?.chatJid || null,
        text: m?.text ? String(m.text).slice(0, 140) : '',
        ts: Number(m?.ts || 0) || null,
        statusTs: Number(m?.statusTs || 0) || null
      })
    }
  }

  const lastFailed = recentFailed.slice(-Math.max(1, Number(failedLimit) || 8)).reverse()
  return {
    windowSize: recent.length,
    inbound,
    outbound,
    lifecycle,
    recentFailed: lastFailed
  }
}

const IDEMPOTENCY_TTL_MS = Math.max(10_000, Number(process.env.IDEMPOTENCY_TTL_MS || 10 * 60 * 1000))
const idempotencyStore = new Map() // key -> { status, response, createdAt, expiresAt }

function pruneIdempotencyStore() {
  const now = Date.now()
  for (const [key, entry] of idempotencyStore.entries()) {
    if (!entry || Number(entry.expiresAt || 0) <= now) idempotencyStore.delete(key)
  }
}

function readIdempotencyKey(req) {
  const fromHeader = req.get('x-idempotency-key')
  const fromBody = req.body?.idempotencyKey
  const key = String(fromHeader || fromBody || '').trim()
  return key || ''
}

function beginIdempotentRequest(rawKey) {
  const key = String(rawKey || '').trim()
  if (!key) return { key: '', duplicate: false }

  pruneIdempotencyStore()
  const existing = idempotencyStore.get(key)
  if (existing) {
    if (existing.status === 'pending') {
      return { key, duplicate: true, pending: true, response: null }
    }
    return { key, duplicate: true, pending: false, response: existing.response || null }
  }

  idempotencyStore.set(key, {
    status: 'pending',
    response: null,
    createdAt: Date.now(),
    expiresAt: Date.now() + IDEMPOTENCY_TTL_MS
  })

  return { key, duplicate: false, pending: false, response: null }
}

function completeIdempotentRequest(key, response) {
  const k = String(key || '').trim()
  if (!k) return
  idempotencyStore.set(k, {
    status: 'done',
    response: response || null,
    createdAt: Date.now(),
    expiresAt: Date.now() + IDEMPOTENCY_TTL_MS
  })
}

function failIdempotentRequest(key) {
  const k = String(key || '').trim()
  if (!k) return
  idempotencyStore.delete(k)
}


/**
 * ----------------------------
 * In-memory message cache (for UI polling)
 * ----------------------------
 */
const recentMessages = []
const chatIndex = new Map() // chatJid -> summary
const quotedMessageCache = new Map() // messageId -> raw WA message
const QUOTED_CACHE_LIMIT = Number(process.env.QUOTED_CACHE_LIMIT || 1000)

function rememberQuotedMessage(messageId, rawMessage) {
  const id = String(messageId || '').trim()
  if (!id || !rawMessage) return
  quotedMessageCache.set(id, rawMessage)

  while (quotedMessageCache.size > QUOTED_CACHE_LIMIT) {
    const oldestKey = quotedMessageCache.keys().next().value
    if (!oldestKey) break
    quotedMessageCache.delete(oldestKey)
  }
}

function getQuotedMessage(messageId) {
  const id = String(messageId || '').trim()
  if (!id) return null
  return quotedMessageCache.get(id) || null
}

async function hydrateChatIndexFromPersistentStore(limit = 1000) {
  try {
    chatIndex.clear()

    if (pgPool || sqliteDb) {
      const { rows, error } = await loadChatSummariesFromDb({ pgPool, sqliteDb, limit, normalizeJid })
      if (error) {
        console.warn(`⚠️ Failed to load chat summaries from ${pgPool ? 'PostgreSQL' : 'SQLite'}:`, error?.message)
      } else {
        for (const r of rows) {
          chatIndex.set(r.chatJid, {
            chatJid: r.chatJid,
            isGroup: Boolean(r.isGroup),
            count: Number(r.count || 0),
            lastTs: Number(r.lastTs || 0),
            lastText: String(r.lastText || ''),
            lastSenderJid: String(r.lastSenderJid || '')
          })
        }
        console.log(`💾 Hydrated ${chatIndex.size} chat summaries (${pgPool ? 'postgres' : 'sqlite'})`)
        return
      }
    }

    const store = readMessagesStore()
    const rows = Array.isArray(store.messages) ? store.messages : []
    for (const m of rows) {
      const jid = normalizeJid(m?.chatJid)
      if (!jid) continue
      const prev = chatIndex.get(jid) || { chatJid: jid, isGroup: Boolean(m?.isGroup), count: 0, lastTs: 0, lastText: '', lastSenderJid: '' }
      const ts = Number(m?.ts || 0)
      const useLatest = ts >= Number(prev.lastTs || 0)
      chatIndex.set(jid, {
        chatJid: jid,
        isGroup: Boolean(prev.isGroup || m?.isGroup),
        count: Number(prev.count || 0) + 1,
        lastTs: Math.max(Number(prev.lastTs || 0), ts),
        lastText: useLatest ? String(m?.text || '') : String(prev.lastText || ''),
        lastSenderJid: useLatest ? String(m?.senderJid || '') : String(prev.lastSenderJid || '')
      })
    }
    console.log(`💾 Hydrated ${chatIndex.size} chat summaries (json fallback)`)
  } catch (e) {
    console.warn('⚠️ Chat summary hydration failed:', e?.message)
  }
}


/**
 * Bootstrap: load last N messages from persistent store into memory
 */
async function hydrateInMemoryFromStore() {
  // DISABLED: Loading 20k+ messages synchronously from SQLite blocks the event loop
  // Messages will be loaded lazily when accessed via the API
  console.log('⏭️ Message hydration skipped (lazy-loading enabled)')
  setTimeout(() => {
    hydrateChatIndexFromPersistentStore(1000).catch((e) => {
      console.warn('⚠️ Background chat summary hydration failed:', e?.message)
    })
  }, 0)
  return

  try {
    if (pgPool) {
      const out = await pgPool.query(
        `SELECT id, wa_msg_id, ts, direction, chat_jid, sender_jid, is_group, type, text_content, media, status, status_ts, quoted_message_id
         FROM messages
         ORDER BY ts DESC
         LIMIT $1`,
        [MESSAGES_MEMORY_LIMIT]
      )
      const rows = (out.rows || []).map(rowToMessage).filter(Boolean).reverse()
      console.log(`💾 Hydrating ${rows.length} messages into memory cache (postgres)...`)
      for (const m of rows) {
        upsertRecentMessageSilent({
          ts: m.ts,
          chatJid: m.chatJid,
          senderJid: m.senderJid,
          id: m.id,
          waMsgId: m.waMsgId || null,
          isGroup: Boolean(m.isGroup),
          text: m.text || '',
          direction: m.direction || 'in',
          status: m.status || null,
          statusTs: m.statusTs || null,
          type: m.type || 'text',
          media: m.media || null,
          quotedMessageId: m.quotedMessageId || null,
        })
      }
      console.log(`💾 Hydrated ${rows.length} messages into memory cache (postgres)`)
      return
    }

    if (sqliteDb) {
      const stmt = sqliteDb.prepare(
        `SELECT id, wa_msg_id, ts, direction, chat_jid, sender_jid, is_group, type, text_content, media, status, status_ts, quoted_message_id
         FROM messages
         ORDER BY ts DESC
         LIMIT ?`
      )
      const rows = (stmt.all(MESSAGES_MEMORY_LIMIT) || []).map(rowToMessage).filter(Boolean).reverse()
      console.log(`💾 Hydrating ${rows.length} messages into memory cache (sqlite)...`)
      for (const m of rows) {
        upsertRecentMessageSilent({
          ts: m.ts,
          chatJid: m.chatJid,
          senderJid: m.senderJid,
          id: m.id,
          waMsgId: m.waMsgId || null,
          isGroup: Boolean(m.isGroup),
          text: m.text || '',
          direction: m.direction || 'in',
          status: m.status || null,
          statusTs: m.statusTs || null,
          type: m.type || 'text',
          media: m.media || null,
          quotedMessageId: m.quotedMessageId || null,
        })
      }
      console.log(`💾 Hydrated ${rows.length} messages into memory cache (sqlite)`)
      return
    }

    const store = readMessagesStore()
    const all = Array.isArray(store.messages) ? store.messages : []
    const tail = all.slice(-MESSAGES_MEMORY_LIMIT)

    for (const m of tail) {
      upsertRecentMessage({
        ts: m.ts,
        chatJid: m.chatJid,
        senderJid: m.senderJid,
        id: m.id,
        waMsgId: m.waMsgId || null,
        isGroup: Boolean(m.isGroup),
        text: m.text || '',
        direction: m.direction || 'in',
        status: m.status || null,
        type: m.type || 'text',
        media: m.media || null,
        quotedMessageId: m.quotedMessageId || null,
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

let contactCache = {
  updatedAt: 0,
  byJid: new Map()
}

function upsertWaContactName(jidRaw, nameRaw) {
  const jid = normalizeJid(jidRaw)
  if (!jid || jid.endsWith('@g.us')) return

  const name = String(nameRaw || '').trim()
  if (!name) return

  const prev = contactCache.byJid.get(jid)
  const next = prev ? { ...prev, name } : { jid, name }
  contactCache.byJid.set(jid, next)
  contactCache.updatedAt = Date.now()
}

let sock = null
let relinkInProgress = false
let activeSocketToken = 0
let lastAutoRelinkAt = 0
let reconnectAttemptCount = 0
let lastNoQrRecoveryAt = 0
let startWhatsAppInProgress = false
let walHandshakeInProgress = false  // true between makeWASocket() and first open/close event — suppresses DB key writes
let preferLatestWaVersion = false   // auto-enabled after repeated 405 failures
let waVersionFallbackIndex = -1     // -1 = try auto-fetch; >=0 = cycle through WA_KNOWN_VERSIONS
let groupRefreshTimer = null
let groupRefreshInFlight = null
let lastGroupRefreshAttemptAt = 0

async function clearAuthStorage() {
  await clearAuthFromDb().catch((e) => { console.warn('⚠️ Failed to clear auth from DB:', e?.message) })
  console.log('🧹 Cleared auth credentials from DB')
}

async function triggerRelink(reason = 'manual', options = {}) {
  const clearAuth = Boolean(options?.clearAuth)
  if (relinkInProgress) return { ok: false, skipped: true, reason: 'already-in-progress' }

  logDiag('warn', 'wa.relink.requested', '♻️ Relink requested', { reason, clearAuth })

  relinkInProgress = true
  connectionStatus = 'relinking'
  lastQR = null
  lastQRPngBuffer = null
  lastQRPngBufferVersion = 0
  qrPngBuildPromise = null
  lastQRDataUrl = ''
  lastQRUpdatedAt = 0
  broadcast('status', { status: connectionStatus, hasQR: false, reason })

  try {
    try { sock?.ws?.close?.() } catch {}
    try { sock?.end?.() } catch {}
    sock = null

    await new Promise(resolve => setTimeout(resolve, 300))

    if (clearAuth) {
      await clearAuthStorage()
      logDiag('warn', 'wa.auth.cleared', '🧹 WA auth cleared for force re-pair', { reason })
    }
    // Start WhatsApp connection asynchronously (don't wait for it to complete)
    startWhatsApp().catch(e => console.warn('⚠️ startWhatsApp failed:', e?.message))
    return { ok: true }
  } finally {
    relinkInProgress = false
  }
}

async function refreshGroups() {
  if (groupRefreshInFlight) return groupRefreshInFlight

  groupRefreshInFlight = (async () => {
    if (!sock) throw new Error('WhatsApp socket not ready')
    lastGroupRefreshAttemptAt = Date.now()

    const groups = await sock.groupFetchAllParticipating()

    const byJid = new Map()
    const byName = new Map()

    for (const g of Object.values(groups)) {
      const jid = normalizeJid(g.id)
      if (!jid) continue

      const subject = (g.subject || '').trim()
      const key = norm(subject)
      const item = { jid, subject }

      byJid.set(jid, item)
      if (!byName.has(key)) byName.set(key, [])
      byName.get(key).push(item)
    }

    groupCache = { updatedAt: Date.now(), byJid, byName }

    let newChats = 0
    for (const group of byJid.values()) {
      const jid = normalizeJid(group.jid)
      if (!jid || !isGroupJid(jid)) continue

      const prev = chatIndex.get(jid)
      if (prev) {
        if (!prev.isGroup) {
          chatIndex.set(jid, { ...prev, chatJid: jid, isGroup: true })
        }
        continue
      }

      const summary = {
        chatJid: jid,
        isGroup: true,
        count: 0,
        lastTs: 0,
        lastText: '',
        lastSenderJid: ''
      }
      chatIndex.set(jid, summary)
      newChats += 1
      broadcastAdminMessageUpdate(jid, null, summary)
    }

    console.log(`👥 Group cache updated: ${byJid.size} groups${newChats ? ` (+${newChats} new chats)` : ''}`)
    return { count: byJid.size, updatedAt: groupCache.updatedAt, newChats }
  })()

  try {
    return await groupRefreshInFlight
  } finally {
    groupRefreshInFlight = null
  }
}

function scheduleGroupRefresh(reason = 'event', options = {}) {
  if (!sock || connectionStatus !== 'open') return

  const delayMs = Math.max(0, Number(options?.delayMs ?? GROUP_CACHE_REFRESH_DEBOUNCE_MS))
  const force = Boolean(options?.force)
  const now = Date.now()
  const minGapDelay = force ? 0 : Math.max(0, GROUP_CACHE_REFRESH_MIN_GAP_MS - Math.max(0, now - lastGroupRefreshAttemptAt))
  const waitMs = Math.max(delayMs, minGapDelay)

  if (groupRefreshTimer) clearTimeout(groupRefreshTimer)
  groupRefreshTimer = setTimeout(() => {
    groupRefreshTimer = null
    refreshGroups().catch((e) => {
      console.warn(`⚠️ Group cache refresh failed (${reason}):`, e?.message)
    })
  }, waitMs)
}

function ownParticipantJids() {
  const values = new Set()
  const candidates = [sock?.user?.id, currentWhatsAppJid]
  for (const raw of candidates) {
    const jid = normalizeJid(raw)
    if (!jid) continue
    values.add(jid)
    values.add(jid.replace('@s.whatsapp.net', '@w.whatsapp.net'))
  }
  return values
}

function participantsIncludeSelf(participants = []) {
  const mine = ownParticipantJids()
  if (!mine.size) return false
  for (const raw of participants || []) {
    const jid = normalizeJid(raw)
    if (jid && mine.has(jid)) return true
  }
  return false
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

  if (to.includes('@')) {
    const direct = normalizeJid(to)
    if (!direct || isGroupJid(direct)) return direct || to
    const store = readContactsStore()
    const found = findContactByAnyDirectId(store, direct)
    if (!found) return direct
    return resolveDeliveryJidFromContact(found) || direct
  }
  if (looksLikePhone(to)) return toUserJid(to)

  const store = readContactsStore()
  const key = norm(to)

  const ga = store.groups.find(g => norm(g.name) === key)
  if (ga?.jid) return ga.jid

  const c = store.contacts.find(c => norm(c.name) === key)
  if (c?.jid || c?.msisdn) {
    const resolved = resolveDeliveryJidFromContact(c)
    if (!resolved) {
      const err = new Error('Contact exists but has no resolvable jid/msisdn')
      err.code = 'UNRESOLVED_TO'
      throw err
    }
    const idx = findContactIndex(store, { name: c.name, jid: c.jid, msisdn: c.msisdn })
    if (idx >= 0) {
      const current = store.contacts[idx]
      const { contact: updated, changed } = enrichContactIdentity(store, current, {
        jid: normalizeJid(c.jid || ''),
        msisdn: c.msisdn,
        displayName: c.name
      })
      if (changed) {
        store.contacts[idx] = updated
        writeContactsStore(store)
      }
    }
    return resolved
  }

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
  if (req.path.startsWith('/board/')) return next()

  // ✅ signed media must be accessible without x-api-key
  if (req.path.startsWith('/media/')) return next()

  // ✅ avoid noise
  if (req.path === '/favicon.ico') return res.status(204).end()

  if (!REQUIRE_API_KEY) return next()
  const key = req.headers['x-api-key']
  if (!matchesSecretRing(key, API_KEYS)) return res.status(401).json({ ok: false, error: 'Unauthorized' })
  next()
}

function adminKeyMiddleware(req, res, next) {
  if (!REQUIRE_ADMIN_KEY) return res.status(500).json({ ok: false, error: 'Admin keys not set (WA_ADMIN_KEY / WA_OPERATOR_KEY / WA_VIEWER_KEY)' })
  const key = String(req.headers['x-admin-key'] || '')
  const roleFromKey = resolveAdminRoleFromKey(key)
  if (roleFromKey) {
    req.adminRole = roleFromKey
    req.adminAuthMode = 'api-key'
    return next()
  }
  const session = getAdminSession(req)
  if (session.ok) {
    req.adminRole = session.role
    req.adminAuthMode = 'session'
    return next()
  }
  return res.status(401).json({ ok: false, error: 'Unauthorized' })
}

function requireApiToggle(toggleKey = '', label = 'API') {
  return (req, res, next) => {
    const cfg = getApiConfig()
    if (!cfg.enabled) {
      return res.status(503).json({ ok: false, error: 'Public API disabled' })
    }
    if (toggleKey && !cfg[toggleKey]) {
      return res.status(503).json({ ok: false, error: `${label} disabled` })
    }
    return next()
  }
}

function hasValidAdminApiKey(req) {
  if (!REQUIRE_ADMIN_KEY) return false
  const key = String(req.headers['x-admin-key'] || '').trim()
  return Boolean(resolveAdminRoleFromKey(key))
}

function getAdminRoleFromApiKey(req) {
  const key = String(req.headers['x-admin-key'] || '').trim()
  return resolveAdminRoleFromKey(key)
}

function parseCookies(req) {
  const raw = String(req.headers.cookie || '')
  const out = {}
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=')
    if (idx === -1) continue
    const k = part.slice(0, idx).trim()
    const v = part.slice(idx + 1).trim()
    if (!k) continue
    out[k] = decodeURIComponent(v)
  }
  return out
}

function signAdminSession(expSec, role = 'admin') {
  const safeRole = normalizeAdminRole(role)
  const payload = `${expSec}|${safeRole}`
  const sig = crypto.createHmac('sha256', ADMIN_SESSION_SECRET).update(payload).digest('hex')
  return `${expSec}.${safeRole}.${sig}`
}

function verifyAdminSession(token) {
  const t = String(token || '').trim()
  if (!t) return { ok: false, role: 'viewer' }
  const parts = t.split('.')
  if (parts.length !== 2 && parts.length !== 3) return { ok: false, role: 'viewer' }

  const expStr = parts[0]
  const role = parts.length === 3 ? normalizeAdminRole(parts[1]) : 'admin' // backward compatible
  const sig = parts.length === 3 ? parts[2] : parts[1]
  const exp = Number(expStr)
  if (!Number.isFinite(exp) || !sig) return { ok: false, role: 'viewer' }
  if (exp <= Math.floor(Date.now() / 1000)) return { ok: false, role: 'viewer' }

  const expectedSig = signAdminSession(exp, role).split('.').pop()
  try {
    const a = Buffer.from(sig, 'hex')
    const b = Buffer.from(expectedSig, 'hex')
    if (a.length !== b.length) return { ok: false, role: 'viewer' }
    const ok = crypto.timingSafeEqual(a, b)
    return { ok, role: ok ? role : 'viewer' }
  } catch {
    return { ok: false, role: 'viewer' }
  }
}

function getAdminSession(req) {
  const cookies = parseCookies(req)
  const token = cookies[ADMIN_SESSION_COOKIE]
  return verifyAdminSession(token)
}

function hasValidAdminSession(req) {
  const session = getAdminSession(req)
  return Boolean(session.ok)
}

function getAdminRoleFromSession(req) {
  const session = getAdminSession(req)
  return session.ok ? session.role : ''
}

function resolveAdminAuthContext(req) {
  const keyRole = getAdminRoleFromApiKey(req)
  if (keyRole) return { authorized: true, role: keyRole, mode: 'api-key' }

  const session = getAdminSession(req)
  if (session.ok) return { authorized: true, role: session.role, mode: 'session' }

  return { authorized: false, role: '', mode: 'none' }
}

function setAdminSessionCookie(res, role = 'admin') {
  const maxAge = Math.max(300, ADMIN_SESSION_TTL_SEC)
  const expSec = Math.floor(Date.now() / 1000) + maxAge
  const token = signAdminSession(expSec, role)
  const parts = [
    `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    `Max-Age=${maxAge}`,
    'HttpOnly',
    'SameSite=Lax'
  ]
  res.setHeader('Set-Cookie', parts.join('; '))
}

function clearAdminSessionCookie(res) {
  res.setHeader('Set-Cookie', `${ADMIN_SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`)
}

function generateCsrfToken() {
  return crypto.randomBytes(24).toString('hex')
}

function setAdminCsrfCookie(res, token) {
  const safe = String(token || '').trim()
  if (!safe) return
  res.append('Set-Cookie', `${ADMIN_CSRF_COOKIE}=${encodeURIComponent(safe)}; Path=/; Max-Age=${Math.max(300, ADMIN_SESSION_TTL_SEC)}; SameSite=Lax`)
}

function clearAdminCsrfCookie(res) {
  res.append('Set-Cookie', `${ADMIN_CSRF_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`)
}

function isAdminMutatingMethod(req) {
  return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(req.method || '').toUpperCase())
}

function clientIp(req) {
  const xf = String(req.headers['x-forwarded-for'] || '').trim()
  if (xf) return xf.split(',')[0].trim()
  return String(req.ip || req.socket?.remoteAddress || '').trim()
}

function isIpAllowed(ip, allowList = ADMIN_IP_ALLOWLIST) {
  if (!Array.isArray(allowList) || allowList.length === 0) return true
  const needle = String(ip || '').trim()
  if (!needle) return false
  return allowList.some(rule => needle === rule || needle.startsWith(`${rule}:`) || needle.endsWith(`:${rule}`))
}

function readAdminAuditStore() {
  return adminAuditStoreCache
}

function appendAdminAuditLog(entry = {}) {
  try {
    const store = readAdminAuditStore()
    const row = {
      id: makeId('audit'),
      ts: Date.now(),
      action: String(entry.action || 'admin_action'),
      method: String(entry.method || ''),
      path: String(entry.path || ''),
      statusCode: Number(entry.statusCode || 0),
      ok: Boolean(entry.ok),
      actor: String(entry.actor || 'unknown'),
      authMode: String(entry.authMode || 'unknown'),
      ip: String(entry.ip || ''),
      userAgent: String(entry.userAgent || '').slice(0, 280),
      durationMs: Math.max(0, Number(entry.durationMs || 0))
    }
    store.items.push(row)
    if (store.items.length > ADMIN_AUDIT_MAX_ITEMS) {
      store.items.splice(0, store.items.length - ADMIN_AUDIT_MAX_ITEMS)
    }
    store.updatedAt = Date.now()
    adminAuditStoreCache = store
    writeKvToDb('admin_audit', store).catch(() => {})
  } catch (e) {
    console.warn('⚠️ Failed to append admin audit log:', e?.message)
  }
}

function requireAdminSessionAny(req, res, next) {
  const session = getAdminSession(req)
  if (session.ok) {
    req.adminRole = session.role
    req.adminAuthMode = 'session'
    return next()
  }
  const acceptsHtml = String(req.headers.accept || '').includes('text/html')
  if (acceptsHtml) return res.redirect(withBase(req, '/admin/login'))
  return res.status(401).json({ ok: false, error: 'Unauthorized' })
}

function b64urlEncodeUtf8(str) {
  return Buffer.from(String(str || ''), 'utf8').toString('base64url')
}

function b64urlDecodeUtf8(str) {
  return Buffer.from(String(str || ''), 'base64url').toString('utf8')
}

function noticeBoardPageHtml(slug, board) {
  const safeSlug = String(slug || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const title = String(board?.displayTitle || board?.name || 'Watson Notice Board').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    :root{
      --board-title-size: clamp(24px,2.6vw,40px);
      --board-sub-size: clamp(14px,1.2vw,20px);
      --board-meta-size: clamp(12px,0.95vw,16px);
      --board-text-size: clamp(26px,2.4vw,42px);
      --board-item-max-width: 88vw;
      --board-item-padding: 10px 12px;
      --board-feed-gap: 8px;
    }
    body{margin:0;background:#0b0d12;color:#fff;font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;min-height:100vh}
    .wrap{width:100vw;height:100vh;margin:0;padding:10px;display:flex;flex-direction:column;box-sizing:border-box}
    .head{position:sticky;top:0;background:#121722;border:1px solid #232a3a;border-radius:14px;padding:14px 16px;z-index:5;margin-bottom:10px}
    .h1{font-size:var(--board-title-size);font-weight:800;margin:0;line-height:1.15}
    .sub{font-size:var(--board-sub-size);color:#9aa4bb;margin-top:6px}
    .board-controls{margin-top:10px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
    .board-controls label{font-size:12px;color:#9aa4bb;display:flex;align-items:center;gap:6px}
    .board-controls select{background:#0f1420;color:#fff;border:1px solid #334155;border-radius:8px;padding:5px 8px}
    .feed{display:flex;flex-direction:column;gap:var(--board-feed-gap);overflow-y:auto;min-height:0;padding-bottom:8px}
    .item{background:#111827;border:1px solid #293145;border-radius:12px;padding:var(--board-item-padding);max-width:var(--board-item-max-width);width:fit-content}
    .item.incoming{align-self:flex-start;background:#111827;border-color:#2f3a52}
    .item.outgoing{align-self:flex-end;background:#25153a;border-color:#53307a}
    .item.new{animation:flashIn 1s ease-out 1}
    .meta{font-size:var(--board-meta-size);color:#94a3b8;margin-bottom:6px;display:flex;justify-content:space-between;gap:8px}
    .txt{font-size:var(--board-text-size);line-height:1.25;white-space:pre-wrap;word-break:break-word}
    .media{margin-top:8px}
    .media img{display:block;max-width:min(40vw,520px);max-height:28vh;border-radius:10px;border:1px solid #334155;object-fit:cover;background:#0b1220}
    .media video{display:block;max-width:min(44vw,560px);max-height:30vh;border-radius:10px;border:1px solid #334155;background:#0b1220}
    .media iframe{display:block;width:min(56vw,720px);height:min(42vh,420px);border-radius:10px;border:1px solid #334155;background:#0b1220}
    .media-links{margin-top:6px;display:flex;gap:12px;flex-wrap:wrap}
    .media-links a{font-size:clamp(12px,1vw,16px)}
    .link-card{margin-top:8px;display:grid;grid-template-columns:130px 1fr;gap:10px;text-decoration:none;border:1px solid #334155;background:#111827;border-radius:10px;overflow:hidden;max-width:min(62vw,820px)}
    .link-card img{display:block;width:100%;height:100%;object-fit:cover;background:#0b1220}
    .link-card-body{padding:8px 10px;min-width:0}
    .link-card-title{font-size:clamp(12px,1vw,16px);font-weight:700;color:#e2e8f0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .link-card-desc{margin-top:4px;font-size:clamp(11px,0.9vw,14px);color:#94a3b8;display:-webkit-box;-webkit-line-clamp:2;line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
    .link-card-site{margin-top:6px;font-size:clamp(10px,0.85vw,13px);color:#9cc7ff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .badge{display:inline-block;padding:3px 8px;border-radius:999px;font-size:clamp(11px,0.9vw,14px);font-weight:700}
    .in{background:rgba(59,130,246,.2);color:#93c5fd}
    .out{background:rgba(168,85,247,.2);color:#d8b4fe}
    @keyframes flashIn{
      0%{box-shadow:0 0 0 0 rgba(250,204,21,.55);transform:scale(1.01)}
      100%{box-shadow:0 0 0 0 rgba(250,204,21,0);transform:scale(1)}
    }
    a{color:#9cc7ff}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="head">
      <h1 class="h1">📢 ${title}</h1>
      <div class="sub" id="state">Connecting…</div>
      <div class="board-controls">
        <label>Size
          <select id="boardSizeControl" title="Board font size">
            <option value="xl">XL</option>
            <option value="l">L</option>
            <option value="m">M</option>
            <option value="s">S</option>
            <option value="xs">XS</option>
          </select>
        </label>
        <label>Density
          <select id="boardDensityControl" title="Board layout density">
            <option value="wide">TV / Wide</option>
            <option value="normal">Normal</option>
            <option value="compact">Tablet / Compact</option>
          </select>
        </label>
      </div>
    </div>
    <div class="feed" id="feed"></div>
  </div>
  <script>
    (function(){
      const slug = ${JSON.stringify(safeSlug)};
      const feed = document.getElementById('feed');
      const state = document.getElementById('state');
      const sizeControl = document.getElementById('boardSizeControl');
      const densityControl = document.getElementById('boardDensityControl');
      const MAX_ITEMS_IN_FEED = 260;
      const linkPreviewCache = new Map();
      const params = new URLSearchParams(location.search || '');

      function boardSizeFromQuery() {
        const named = String(params.get('size') || params.get('font') || '').trim().toLowerCase();
        if (['xs','s','m','l','xl'].includes(named)) return named;
        for (const key of ['xl','l','m','s','xs']) {
          if (params.has(key)) return key;
        }
        return 'm';
      }

      function boardDensityFromQuery() {
        const named = String(params.get('density') || params.get('layout') || params.get('width') || '').trim().toLowerCase();
        if (['wide','normal','compact'].includes(named)) return named;
        if (params.has('tv') || params.has('wide')) return 'wide';
        if (params.has('tablet') || params.has('compact')) return 'compact';
        return 'normal';
      }

      function applyBoardSize(size) {
        const sizes = {
          xs: {
            title: 'clamp(16px,1.6vw,24px)',
            sub: 'clamp(10px,0.8vw,13px)',
            meta: 'clamp(9px,0.72vw,11px)',
            text: 'clamp(12px,1.05vw,18px)',
          },
          s: {
            title: 'clamp(18px,1.9vw,28px)',
            sub: 'clamp(11px,0.95vw,15px)',
            meta: 'clamp(10px,0.78vw,12px)',
            text: 'clamp(16px,1.3vw,22px)',
          },
          m: {
            title: 'clamp(22px,2.3vw,34px)',
            sub: 'clamp(13px,1.05vw,17px)',
            meta: 'clamp(11px,0.85vw,14px)',
            text: 'clamp(20px,1.65vw,28px)',
          },
          l: {
            title: 'clamp(22px,2.3vw,36px)',
            sub: 'clamp(13px,1.1vw,18px)',
            meta: 'clamp(11px,0.88vw,14px)',
            text: 'clamp(22px,1.9vw,32px)',
          },
          xl: {
            title: 'clamp(32px,3.6vw,58px)',
            sub: 'clamp(18px,1.6vw,26px)',
            meta: 'clamp(15px,1.2vw,20px)',
            text: 'clamp(40px,3.7vw,72px)',
          }
        };
        const selected = sizes[size] || sizes.m;
        const root = document.documentElement;
        root.style.setProperty('--board-title-size', selected.title);
        root.style.setProperty('--board-sub-size', selected.sub);
        root.style.setProperty('--board-meta-size', selected.meta);
        root.style.setProperty('--board-text-size', selected.text);
      }

      function applyBoardDensity(density) {
        const densities = {
          wide: {
            width: '98vw',
            padding: '12px 16px',
            gap: '10px'
          },
          normal: {
            width: '82vw',
            padding: '10px 12px',
            gap: '8px'
          },
          compact: {
            width: '62vw',
            padding: '8px 10px',
            gap: '6px'
          }
        };
        const selected = densities[density] || densities.normal;
        const root = document.documentElement;
        root.style.setProperty('--board-item-max-width', selected.width);
        root.style.setProperty('--board-item-padding', selected.padding);
        root.style.setProperty('--board-feed-gap', selected.gap);
      }

      let activeSize = boardSizeFromQuery();
      let activeDensity = boardDensityFromQuery();

      function syncQueryToControls() {
        const url = new URL(location.href);
        url.searchParams.set('size', activeSize);
        url.searchParams.set('density', activeDensity);
        history.replaceState({}, '', url.pathname + '?' + url.searchParams.toString());
      }

      applyBoardSize(activeSize);
      applyBoardDensity(activeDensity);

      if (sizeControl) {
        sizeControl.value = activeSize;
        sizeControl.addEventListener('change', () => {
          activeSize = String(sizeControl.value || 'm').trim().toLowerCase();
          applyBoardSize(activeSize);
          syncQueryToControls();
        });
      }

      if (densityControl) {
        densityControl.value = activeDensity;
        densityControl.addEventListener('change', () => {
          activeDensity = String(densityControl.value || 'normal').trim().toLowerCase();
          applyBoardDensity(activeDensity);
          syncQueryToControls();
        });
      }

      function esc(s){ const d=document.createElement('div'); d.textContent=String(s||''); return d.innerHTML; }
      function scrollToEnd(){
        feed.scrollTop = feed.scrollHeight;
        requestAnimationFrame(() => { feed.scrollTop = feed.scrollHeight; });
        setTimeout(() => { feed.scrollTop = feed.scrollHeight; }, 80);
      }

      function trimFeed(){
        while (feed.children.length > MAX_ITEMS_IN_FEED) {
          feed.removeChild(feed.firstElementChild);
        }
      }

      function firstUrl(text){
        const raw = String(text || '');
        const parts = [];
        let cur = '';
        for (const ch of raw) {
          const code = ch.charCodeAt(0);
          const isWs = code === 32 || code === 9 || code === 10 || code === 13;
          if (isWs) {
            if (cur) parts.push(cur);
            cur = '';
          } else {
            cur += ch;
          }
        }
        if (cur) parts.push(cur);
        for (const part of parts) {
          try {
            const u = new URL(part);
            if (u.protocol === 'http:' || u.protocol === 'https:') return u.toString();
          } catch {}
        }
        return '';
      }

      async function getPreview(url){
        const u = String(url || '').trim();
        if (!u) return null;
        const cached = linkPreviewCache.get(u);
        if (cached && Number(cached.expiresAt || 0) > Date.now()) return cached.value;
        try {
          const res = await fetch('/board/link-preview?url=' + encodeURIComponent(u));
          const data = await res.json();
          const preview = data && data.ok ? data.preview : null;
          linkPreviewCache.set(u, { value: preview, expiresAt: Date.now() + 5 * 60 * 1000 });
          return preview;
        } catch {
          linkPreviewCache.set(u, { value: null, expiresAt: Date.now() + 60 * 1000 });
          return null;
        }
      }

      function previewHtml(p){
        if (!p) return '';
        const title = esc(p.title || p.url || 'Link preview');
        const desc = esc(p.description || '');
        const site = esc(p.siteName || p.url || '');
        const url = esc(p.url || '');
        const img = p.image ? '<img src="'+esc(p.image)+'" alt="Preview" loading="lazy" />' : '';
        return '<a class="link-card" href="'+url+'" target="_blank" rel="noopener"><div>'+img+'</div><div class="link-card-body"><div class="link-card-title">'+title+'</div>'+(desc?'<div class="link-card-desc">'+desc+'</div>':'')+'<div class="link-card-site">'+site+'</div></div></a>';
      }

      function addItem(m){
        const ts = new Date(Number(m.ts || Date.now()));
        const text = m.text || '[' + (m.type || 'message') + ']';
        const mediaUrl = m && m.media && m.media.localUrl ? String(m.media.localUrl) : '';
        const mediaType = String((m && m.media && m.media.mimetype) || '').toLowerCase();
        const isImage = !!mediaUrl && (mediaType.startsWith('image/') || String(m.type || '').toLowerCase() === 'image');
        const isVideo = !!mediaUrl && (mediaType.startsWith('video/') || String(m.type || '').toLowerCase() === 'video');
        const isGifLike = !!mediaUrl && (mediaType.includes('gif') || Boolean(m && m.media && m.media.gifPlayback));
        const mediaPath = String(mediaUrl || '').split('?')[0].toLowerCase();
        const isPdf = !!mediaUrl && (mediaType.includes('application/pdf') || (String(m.type || '').toLowerCase() === 'document' && mediaPath.endsWith('.pdf')));
        let media = '';
        if (mediaUrl && isImage) {
          media = '<div class="media"><a href="'+esc(mediaUrl)+'" target="_blank" rel="noopener"><img src="'+esc(mediaUrl)+'" alt="Image preview" loading="lazy" /></a><div class="media-links"><a href="'+esc(mediaUrl)+'" target="_blank" rel="noopener">Open image</a><a href="'+esc(mediaUrl)+'" download>Download</a></div></div>';
        } else if (mediaUrl && isVideo) {
          media = '<div class="media"><video src="'+esc(mediaUrl)+'" '+(isGifLike ? 'autoplay loop muted playsinline' : 'controls')+'></video><div class="media-links"><a href="'+esc(mediaUrl)+'" target="_blank" rel="noopener">Open video</a><a href="'+esc(mediaUrl)+'" download>Download</a></div></div>';
        } else if (mediaUrl && isPdf) {
          media = '<div class="media"><iframe src="'+esc(mediaUrl)+'#view=FitH" loading="lazy"></iframe><div class="media-links"><a href="'+esc(mediaUrl)+'" target="_blank" rel="noopener">Open PDF</a><a href="'+esc(mediaUrl)+'" download>Download</a></div></div>';
        } else if (mediaUrl) {
          media = '<div class="media-links"><a href="'+esc(mediaUrl)+'" target="_blank" rel="noopener">Open media</a><a href="'+esc(mediaUrl)+'" download>Download</a></div>';
        }
        const url = firstUrl(text);
        const previewSlot = url ? '<div class="preview-slot" data-url="'+encodeURIComponent(url)+'"></div>' : '';
        const who = m.direction === 'out' ? 'System' : (m.senderName || m.pushName || '');
        const badgeClass = m.direction === 'out' ? 'out' : 'in';
        const div = document.createElement('div');
        div.className = 'item ' + (m.direction === 'out' ? 'outgoing' : 'incoming') + ' new';
        div.innerHTML = '<div class="meta"><span><span class="badge '+badgeClass+'">'+(m.direction==='out'?'out':'in')+'</span>'+(who?' <strong>'+esc(who)+'</strong>':'')+'</span><span>'+esc(ts.toLocaleString())+'</span></div><div class="txt">'+esc(text)+'</div>' + previewSlot + media;
        feed.appendChild(div);
        trimFeed();

        const visual = div.querySelector('img,video,iframe');
        if (visual) {
          const settle = () => scrollToEnd();
          if (visual.tagName === 'IMG' && visual.complete) settle();
          else {
            visual.addEventListener('load', settle, { once: true });
            visual.addEventListener('error', settle, { once: true });
          }
        }

        const slot = div.querySelector('.preview-slot');
        if (slot) {
          const urlRaw = decodeURIComponent(slot.getAttribute('data-url') || '');
          getPreview(urlRaw).then((p) => {
            if (!p) {
              slot.innerHTML = '<div class="media-links"><a href="'+esc(urlRaw)+'" target="_blank" rel="noopener">Open link</a></div>';
              return;
            }
            slot.innerHTML = previewHtml(p);
            scrollToEnd();
          }).catch(() => {});
        }

        setTimeout(() => { div.classList.remove('new'); }, 1000);
        scrollToEnd();
      }

      const es = new EventSource('/board/' + encodeURIComponent(slug) + '/stream');
      es.addEventListener('batch', (evt) => {
        try {
          const data = JSON.parse(evt.data || '{}');
          const items = Array.isArray(data.messages) ? data.messages : [];
          for (const m of items) addItem(m);
          state.textContent = 'Live — updates stream automatically.';
        } catch {
          state.textContent = 'Stream parse error';
        }
      });
      es.addEventListener('ping', () => {
        state.textContent = 'Live — waiting for new messages…';
      });
      es.onerror = () => {
        state.textContent = 'Disconnected. Retrying…';
      };
    })();
  </script>
</body>
</html>`
}

function adminLoginPageHtml(req) {
  const loginAction = withBase(req, '/admin/login')
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Watson Login</title>
  <style>
    body{margin:0;background:#0b0b10;color:#fff;font-family:ui-sans-serif,system-ui,Segoe UI,Roboto,Arial;display:grid;place-items:center;min-height:100vh}
    .card{width:min(420px,92vw);background:#12121a;border:1px solid rgba(255,255,255,.12);border-radius:16px;padding:20px;box-shadow:0 16px 48px rgba(0,0,0,.45)}
    h1{margin:0 0 6px;font-size:20px}
    p{margin:0 0 14px;color:rgba(255,255,255,.7);font-size:13px}
    input{width:100%;padding:10px 12px;border-radius:12px;border:1px solid rgba(255,255,255,.16);background:rgba(0,0,0,.32);color:#fff;outline:none}
    button{margin-top:12px;width:100%;padding:10px 12px;border-radius:12px;border:1px solid rgba(138,43,226,.55);background:linear-gradient(135deg, rgba(138,43,226,.35), rgba(177,76,255,.18));color:#fff;font-weight:700;cursor:pointer}
    .err{margin-top:10px;color:#ff9bad;font-size:12px;min-height:18px}
  </style>
</head>
<body>
  <form class="card" method="post" action="${loginAction}">
    <h1>Watson Admin Login</h1>
    <p>Enter an admin, operator, or viewer key to access the dashboard.</p>
    <input type="password" name="adminKey" placeholder="WA_ADMIN_KEY / WA_OPERATOR_KEY / WA_VIEWER_KEY" autocomplete="current-password" required />
    <button type="submit">Login</button>
    <div class="err" id="err"></div>
  </form>
  <script>
    const q = new URLSearchParams(location.search);
    const e = q.get('e');
    if (e) document.getElementById('err').textContent = decodeURIComponent(e);
  </script>
</body>
</html>`
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
let lastQRUpdatedAt = 0
let lastQrTerminalLogAt = 0
let lastQRPngBuffer = null
let lastQRPngBufferVersion = 0
let qrPngBuildPromise = null
let lastQRDataUrl = ''

// SSE
const sseClients = new Set()
const adminMessageSseClients = new Set()
function sseSend(res, event, data) {
  res.write(`event: ${event}\n`)
  res.write(`data: ${JSON.stringify(data)}\n\n`)
}
function broadcast(event, data) {
  for (const res of sseClients) {
    try { sseSend(res, event, data) } catch {}
  }
}

function broadcastAdminMessageUpdate(chatJid, message, summary) {
  const jid = normalizeJid(chatJid)
  if (!jid) return

  const payload = {
    chatJid: jid,
    message: message ? refreshMediaForClient(message) : null,
    summary: summary || null,
    ts: Date.now()
  }

  for (const client of adminMessageSseClients) {
    try {
      const filterJid = client?.chatJid || ''
      const aliases = client?.aliases instanceof Set ? client.aliases : null
      if (filterJid) {
        if (aliases && aliases.size) {
          if (!aliases.has(jid)) continue
        } else if (filterJid !== jid) {
          continue
        }
      }
      sseSend(client.res, 'message-update', payload)
    } catch {}
  }
}

async function startWhatsApp() {
  if (startWhatsAppInProgress) return
  startWhatsAppInProgress = true

  try {
  connectionStatus = 'connecting'
  logDiag('info', 'wa.connect.start', '🔌 Starting WhatsApp connection', { reconnectAttemptCount })
  const { state, saveCreds } = await getAuthStateFromDb()
  
  // Preload all auth keys into memory cache BEFORE handshake to avoid sync DB hits
  await preloadAuthKeysToCache()

  let waVersion = parseWaVersionOverride(WA_WEB_VERSION_OVERRIDE) || undefined
  if (waVersion) {
    console.log('📦 Using WA Web version override from WA_WEB_VERSION_OVERRIDE:', waVersion.join('.'))
  } else if (waVersionFallbackIndex >= 0 && WA_KNOWN_VERSIONS.length > 0) {
    // A 405 occurred previously — cycle through the known-good fallback list
    const idx = waVersionFallbackIndex % WA_KNOWN_VERSIONS.length
    waVersion = WA_KNOWN_VERSIONS[idx]
    console.log(`📦 Using fallback WA Web version [${idx + 1}/${WA_KNOWN_VERSIONS.length}]: ${waVersion.join('.')} (after ${waVersionFallbackIndex} 405 attempt(s))`)
  } else {
    // No override, no 405 yet — try auto-fetching the latest supported version
    const forceLatest = String(process.env.WA_FORCE_LATEST_WEB_VERSION || '').trim() === '1' || preferLatestWaVersion
    if (forceLatest) {
      try {
        const info = await fetchLatestBaileysVersion()
        if (Array.isArray(info?.version) && info.version.length) {
          waVersion = info.version
          console.log('📦 Using WA Web version (auto-fetch):', waVersion.join('.'), '| isLatest:', Boolean(info?.isLatest))
          if (!info.isLatest) {
            console.warn('⚠️ Fetched WA version may not be the latest — will use fallback versions if 405 occurs.')
          }
        }
      } catch (e) {
        console.warn('⚠️ Failed to fetch latest WA Web version:', e?.message)
      }
    } else {
      console.log('📦 Using Baileys default WA Web version (WA_FORCE_LATEST_WEB_VERSION!=1)')
    }
  }

  sock = makeWASocket({
    auth: state,
    logger: P({ level: 'silent' }),
    browser: resolveBaileysBrowser(),
    ...(waVersion ? { version: waVersion } : {}),
    getMessage: async () => undefined
  })

  const socketToken = ++activeSocketToken
  const thisSock = sock
  walHandshakeInProgress = true  // suppress DB writes until open/close fires

  const noQrGuard = setTimeout(async () => {
    try {
      if (sock !== thisSock || socketToken !== activeSocketToken) return
      const noQr = !lastQR && lastQRUpdatedAt <= 0
      const stillNotOpen = connectionStatus !== 'open'
      if (!noQr || !stillNotOpen) return

      const now = Date.now()
      if (now - lastNoQrRecoveryAt < 60000) return
      lastNoQrRecoveryAt = now
      console.log('⚠️ No QR produced within startup window. Restarting WA socket...')
      try {
        await triggerRelink('no-qr-timeout')
      } catch (e) {
        console.warn('❌ no-qr timeout relink failed:', e?.message)
      }
    } catch {}
  }, 45000)
  let credsPersistTimer = null
  let credsPersistRunning = false
  let credsPersistPending = false
  
  // Batch auth key writes to avoid blocking on every crypto event
  let keysPersistTimer = null
  let keysPersistPending = null

  const flushCredsPersist = async () => {
    if (credsPersistRunning) {
      credsPersistPending = true
      return
    }

    credsPersistRunning = true
    try {
      await saveCreds()
    } catch (e) {
      console.warn('⚠️ Failed to persist WA creds:', e?.message)
    } finally {
      credsPersistRunning = false
      if (credsPersistPending) {
        credsPersistPending = false
        queueCredsPersist()
      }
    }
  }

  const queueCredsPersist = () => {
    if (credsPersistTimer) return
    credsPersistTimer = setTimeout(() => {
      credsPersistTimer = null
      flushCredsPersist().catch(() => {})
    }, 500)
  }
  
  const flushKeysPersist = async () => {
    if (!keysPersistPending) return
    const toWrite = keysPersistPending
    keysPersistPending = null
    // Yield to the event loop before the synchronous SQLite transaction runs
    await new Promise(resolve => setImmediate(resolve))
    await writeAuthKeysToDb(toWrite).catch(e => console.warn('⚠️ auth keys flush error:', e?.message))
  }
  
  const queueKeysPersist = (data) => {
    // Always update in-memory cache (no I/O)
    keysPersistPending = keysPersistPending || {}
    for (const [type, vals] of Object.entries(data || {})) {
      if (!keysPersistPending[type]) keysPersistPending[type] = {}
      Object.assign(keysPersistPending[type], vals || {})
    }
    
    // During WA handshake, skip scheduling DB writes entirely.
    // Keys stay in memory and get flushed in one batch after open/close fires.
    if (walHandshakeInProgress) return
    
    // Post-handshake: debounce DB writes at 1000ms to avoid hammering SQLite
    if (keysPersistTimer) clearTimeout(keysPersistTimer)
    keysPersistTimer = setTimeout(() => {
      keysPersistTimer = null
      flushKeysPersist().catch(() => {})
    }, 1000)
  }
  
  // Intercept keys.set to batch the writes
  const originalKeySet = state.keys.set
  state.keys.set = async (data) => {
    await originalKeySet(data)
    queueKeysPersist(data)
  }

  sock.ev.on('creds.update', queueCredsPersist)

  sock.ev.on('connection.update', async (update) => {
    if (sock !== thisSock || socketToken !== activeSocketToken) return

    const { connection, lastDisconnect, qr } = update

    if (qr) {
      const qrChanged = qr !== lastQR
      lastQR = qr

      if (qrChanged) {
        reconnectAttemptCount = 0
        lastQRUpdatedAt = Date.now()
        lastQRPngBuffer = null
        lastQRPngBufferVersion = 0
        qrPngBuildPromise = null
        lastQRDataUrl = ''

        const now = Date.now()
        if (now - lastQrTerminalLogAt > 1500) {
          lastQrTerminalLogAt = now
          console.log('📲 Scan QR to pair (WhatsApp > Linked devices):')
          qrcode.generate(qr, { small: true })
        }

        broadcast('qr', { qr, qrUpdatedAt: lastQRUpdatedAt })
        broadcast('status', { status: connectionStatus, hasQR: true, qrUpdatedAt: lastQRUpdatedAt })
      }
    }

    if (connection === 'open') {
      clearTimeout(noQrGuard)
      walHandshakeInProgress = false
      if (keysPersistPending) flushKeysPersist().catch(() => {})
      reconnectAttemptCount = 0
      waVersionFallbackIndex = -1     // reset: next connect will auto-fetch latest again
      preferLatestWaVersion = false   // cleared by successful connect
      connectionStatus = 'open'
      lastQR = null
      lastQRUpdatedAt = 0
      lastQRPngBuffer = null
      lastQRPngBufferVersion = 0
      qrPngBuildPromise = null
      lastQRDataUrl = ''
      
      // MULTI-INSTANCE ISOLATION: Update instance ID from WhatsApp JID
      const waJid = normalizeJid(sock?.user?.id || '')
      if (waJid && !INSTANCE_ID_OVERRIDE) {
        const newInstanceId = waJid.split('@')[0]
        if (newInstanceId && newInstanceId !== currentInstanceId) {
          currentInstanceId = newInstanceId
          currentWhatsAppJid = waJid
          const queueName = getWaQueueName()
          console.log(`🔐 Instance isolation: WhatsApp JID=${waJid}, instanceId=${currentInstanceId}, queue=${queueName}`)
          
          // Reinitialize queue and worker with the correct instance-specific names
          initializeQueue(queueName)
          initializeWorker(queueName)
        }
      } else if (waJid) {
        currentWhatsAppJid = waJid
        console.log(`🔐 Instance isolation: Using explicit INSTANCE_ID=${currentInstanceId}, WhatsApp JID=${waJid}`)
      }
      
      console.log('✅ WhatsApp connected')
      logDiag('info', 'wa.connect.open', '✅ WhatsApp connected', { reconnectAttemptCount })
      try { await refreshGroups() } catch (e) { console.warn('⚠️ Group cache refresh failed:', e?.message) }
      broadcast('status', { status: connectionStatus, hasQR: false, qrUpdatedAt: lastQRUpdatedAt })
    }

    if (connection === 'close') {
      clearTimeout(noQrGuard)
      walHandshakeInProgress = false
      if (keysPersistPending) flushKeysPersist().catch(() => {})
      connectionStatus = 'disconnected'
      const { statusCode, reason: disconnectReason, data: disconnectData } = parseDisconnectDetails(lastDisconnect)
      reconnectAttemptCount += 1

      if (relinkInProgress) {
        console.log('ℹ️ Reconnect suppressed (relink in progress)')
        broadcast('status', { status: connectionStatus, hasQR: Boolean(lastQR), relinking: true, qrUpdatedAt: lastQRUpdatedAt })
        return
      }

      if (statusCode === DisconnectReason.loggedOut) {
        const now = Date.now()
        if (now - lastAutoRelinkAt < 8000) {
          console.log('ℹ️ Logged-out relink throttled')
          broadcast('status', { status: connectionStatus, hasQR: false, relinking: true, qrUpdatedAt: lastQRUpdatedAt })
          return
        }
        lastAutoRelinkAt = now

        console.log('⚠️ Logged out detected. Auto relink initiated...')
        broadcast('status', { status: connectionStatus, hasQR: false, relinking: true, qrUpdatedAt: lastQRUpdatedAt })
        try {
          await triggerRelink('logged-out')
        } catch (e) {
          console.warn('❌ Auto relink failed:', e?.message)
        }
        return
      }

      if (Number(statusCode) === 405) {
        // 405 is often transient WA-side connection failure/rate-limiting.
        // Keep auth intact. Auth reset is manual-only from Pairing > Force Re-pair.
        preferLatestWaVersion = true
        waVersionFallbackIndex = Math.max(0, waVersionFallbackIndex + 1)  // advance fallback version for next retry

        const retryDelay = computeStatus405DelayMs(reconnectAttemptCount)
        console.log(`⚠️ Status 405 detected. Retrying in ${Math.round(retryDelay / 1000)}s (auth preserved, latest WA version preferred).`)
        broadcast('status', { status: connectionStatus, hasQR: Boolean(lastQR), qrUpdatedAt: lastQRUpdatedAt })

        // Safety valve: for sustained 405 without QR, restart socket with long cooldown.
        const now = Date.now()
        const noQrYet = !lastQR && lastQRUpdatedAt <= 0
        if (noQrYet && reconnectAttemptCount >= 6 && now - lastNoQrRecoveryAt >= 5 * 60 * 1000) {
          lastNoQrRecoveryAt = now
          console.log('⚠️ Sustained 405 failures without QR. Performing force re-pair recovery...')
          try {
            await triggerRelink('status-405-sustained-no-qr', { clearAuth: true })
          } catch (e) {
            console.warn('❌ 405 sustained recovery relink failed:', e?.message)
          }
          return
        }

        setTimeout(() => {
          startWhatsApp().catch(e => console.warn('⚠️ startWhatsApp (405 retry) failed:', e?.message))
        }, retryDelay)
        return
      }

      const shouldReconnect = statusCode !== DisconnectReason.loggedOut && Number(statusCode) !== 405

      console.log('❌ WhatsApp connection closed. Reconnect?', shouldReconnect, '| statusCode:', statusCode ?? 'n/a', '| reason:', disconnectReason, disconnectData ? `| data: ${disconnectData}` : '')
      logDiag('warn', 'wa.connect.close', '❌ WhatsApp connection closed', {
        shouldReconnect,
        statusCode: statusCode ?? null,
        reason: disconnectReason || 'unknown',
        reconnectAttemptCount
      })
      broadcast('status', { status: connectionStatus, hasQR: Boolean(lastQR), qrUpdatedAt: lastQRUpdatedAt })

      const now = Date.now()
      const noQrYet = !lastQR && lastQRUpdatedAt <= 0
      if (noQrYet && reconnectAttemptCount >= 4 && now - lastNoQrRecoveryAt >= 60000) {
        lastNoQrRecoveryAt = now
        console.log('⚠️ Repeated reconnect failures without QR. Restarting WA socket...')
        try {
          await triggerRelink('no-qr-repeated-failures')
        } catch (e) {
          console.warn('❌ no-qr repeated-failure relink failed:', e?.message)
        }
        return
      }

      if (shouldReconnect) {
        const retryDelayMs = computeReconnectDelayMs(statusCode, reconnectAttemptCount)
        console.log(`🔄 Reconnect #${reconnectAttemptCount} in ${Math.round(retryDelayMs / 1000)}s (status: ${statusCode ?? 'n/a'})`)
        setTimeout(() => {
          startWhatsApp().catch((e) => console.warn('⚠️ startWhatsApp retry failed:', e?.message))
        }, retryDelayMs)
      }
      else {
        if (Number(statusCode) === 405) {
          console.log('⚠️ Reconnect halted after status 405 (Connection Failure). Trigger a manual re-pair from Admin > Pairing.')
        } else {
          console.log('⚠️ Logged out. Auto relink failed; manual intervention may be required.')
        }
      }
    }
  })

  sock.ev.on('contacts.upsert', (items = []) => {
    try {
      for (const c of items || []) {
        const jid = c?.id || c?.jid || c?.remoteJid
        const name = c?.notify || c?.verifiedName || c?.name || c?.vname || ''
        upsertWaContactName(jid, name)
      }
    } catch (e) {
      console.warn('⚠️ contacts.upsert handling failed:', e?.message)
    }
  })

  sock.ev.on('contacts.update', (items = []) => {
    try {
      for (const c of items || []) {
        const jid = c?.id || c?.jid || c?.remoteJid
        const name = c?.notify || c?.verifiedName || c?.name || c?.vname || ''
        upsertWaContactName(jid, name)
      }
    } catch (e) {
      console.warn('⚠️ contacts.update handling failed:', e?.message)
    }
  })

  sock.ev.on('groups.upsert', (items = []) => {
    try {
      if ((items || []).some(g => isGroupJid(normalizeJid(g?.id || g?.jid)))) {
        scheduleGroupRefresh('groups.upsert', { delayMs: 500 })
      }
    } catch (e) {
      console.warn('⚠️ groups.upsert handling failed:', e?.message)
    }
  })

  sock.ev.on('groups.update', (items = []) => {
    try {
      if ((items || []).some(g => isGroupJid(normalizeJid(g?.id || g?.jid)))) {
        scheduleGroupRefresh('groups.update')
      }
    } catch (e) {
      console.warn('⚠️ groups.update handling failed:', e?.message)
    }
  })

  sock.ev.on('group-participants.update', (update = {}) => {
    try {
      const groupJid = normalizeJid(update?.id)
      if (!isGroupJid(groupJid)) return

      const action = String(update?.action || '').trim().toLowerCase()
      const participants = Array.isArray(update?.participants) ? update.participants : []
      const touchesSelf = participantsIncludeSelf(participants)
      const delayMs = touchesSelf ? 250 : GROUP_CACHE_REFRESH_DEBOUNCE_MS

      if (touchesSelf || action === 'add' || action === 'remove' || !groupCache.byJid.has(groupJid)) {
        scheduleGroupRefresh(`group-participants.update:${action || 'unknown'}`, { delayMs, force: touchesSelf })
      }
    } catch (e) {
      console.warn('⚠️ group-participants.update handling failed:', e?.message)
    }
  })

  sock.ev.on('chats.upsert', (items = []) => {
    try {
      if ((items || []).some(chat => {
        const jid = normalizeJid(chat?.id || chat?.jid)
        return isGroupJid(jid) && !groupCache.byJid.has(jid)
      })) {
        scheduleGroupRefresh('chats.upsert', { delayMs: 500 })
      }
    } catch (e) {
      console.warn('⚠️ chats.upsert handling failed:', e?.message)
    }
  })

  sock.ev.on('chats.update', (items = []) => {
    try {
      if ((items || []).some(chat => {
        const jid = normalizeJid(chat?.id || chat?.jid)
        return isGroupJid(jid) && !groupCache.byJid.has(jid)
      })) {
        scheduleGroupRefresh('chats.update')
      }
    } catch (e) {
      console.warn('⚠️ chats.update handling failed:', e?.message)
    }
  })

  // Initial MD history sync after fresh login/pair.
  // This populates contacts/chats/messages even before any new inbound event arrives.
  sock.ev.on('messaging-history.set', async (payload = {}) => {
    try {
      const contacts = Array.isArray(payload?.contacts) ? payload.contacts : []
      const allMessages = Array.isArray(payload?.messages) ? payload.messages : []
      const syncLimit = Math.max(1000, Number(WA_HISTORY_SYNC_MAX || 15000))
      const messages = allMessages.length > syncLimit ? allMessages.slice(-syncLimit) : allMessages

      for (const c of contacts) {
        const jid = c?.id || c?.jid || c?.remoteJid
        const name = c?.notify || c?.verifiedName || c?.name || c?.vname || ''
        upsertWaContactName(jid, name)
      }

      let processed = 0
      for (const msg of messages) {
        if (!msg?.message) continue

        const waMsgId = String(msg?.key?.id || '').trim()
        const rawChatJid = msg?.key?.remoteJid
        const isGroup = isGroupJid(rawChatJid)
        // IMPORTANT: during history sync, avoid resolvePreferredChatJid()
        // because it hits readContactsStore() and is too expensive per message.
        const chatJid = normalizeJid(rawChatJid)
        if (!chatJid) continue

        const fromMe = Boolean(msg?.key?.fromMe)
        const senderJid = fromMe
          ? (normalizeJid(sock?.user?.id || '') || chatJid)
          : (msg?.key?.participant || msg?.key?.remoteJid || '')

        // Handle protocol-level revoke events from history sync by flagging
        // the original message as deleted, while preserving its original text/media.
        const histProtocol = msg?.message?.protocolMessage
        const histProtocolType = Number(histProtocol?.type)
        const histRevokedTargetId = String(histProtocol?.key?.id || '').trim()
        if (histRevokedTargetId && (histProtocolType === 0 || String(histProtocol?.type || '').toUpperCase() === 'REVOKE')) {
          const deleted = updateMessageStatusByAnyId(histRevokedTargetId, { status: 'deleted' })
          if (deleted) upsertRecentMessageSilent(deleted)
          continue
        }

        const textRaw = extractTextMessage(msg)
        const hasImage = Boolean(msg.message?.imageMessage)
        const hasDoc = Boolean(msg.message?.documentMessage)
        const hasVideo = Boolean(msg.message?.videoMessage)
        const hasGif = Boolean(msg.message?.videoMessage?.gifPlayback)
        const hasAudio = Boolean(msg.message?.audioMessage)
        const hasVoiceNote = Boolean(msg.message?.audioMessage?.ptt)

        let type = 'text'
        if (hasImage) type = 'image'
        else if (hasDoc) type = 'document'
        else if (hasVideo) type = 'video'
        else if (hasVoiceNote) type = 'voice-note'
        else if (hasAudio) type = 'audio'

        let text = ''
        if (type === 'text') text = String(textRaw || '').trim()
        if (type === 'image') text = String(msg.message?.imageMessage?.caption || '').trim() || '[image]'
        if (type === 'document') {
          const fn = msg.message?.documentMessage?.fileName
          text = fn ? `[document] ${fn}` : '[document]'
        }
        if (type === 'video') {
          text = String(msg.message?.videoMessage?.caption || '').trim() || (hasGif ? '[gif]' : '[video]')
        }
        if (type === 'voice-note') text = '[voice note]'
        if (type === 'audio') text = '[audio]'
        if (type === 'text' && !text) continue

        const tsMs = Number(msg?.messageTimestamp || 0) > 0
          ? Number(msg.messageTimestamp) * 1000
          : Date.now()

        const rec = {
          id: waMsgId || makeId(fromMe ? 'out' : 'in'),
          waMsgId: waMsgId || null,
          ts: tsMs,
          chatJid,
          senderJid,
          isGroup,
          direction: fromMe ? 'out' : 'in',
          status: fromMe ? 'sent' : null,
          type,
          text,
          media: null
        }

        addMessageRecord(rec)
        upsertRecentMessageSilent(rec)
        processed += 1

        if (processed % 250 === 0) {
          await new Promise(resolve => setImmediate(resolve))
        }
      }

      if (processed > 0) {
        if (allMessages.length > messages.length) {
          const msg = `💾 History sync ingested ${processed}/${allMessages.length} message(s) (capped by WA_HISTORY_SYNC_MAX=${syncLimit})`
          console.log(msg)
          logDiag('info', 'wa.history.ingested', msg, { processed, total: allMessages.length, capped: true, syncLimit })
        } else {
          const msg = `💾 History sync ingested ${processed} message(s)`
          console.log(msg)
          logDiag('info', 'wa.history.ingested', msg, { processed, total: allMessages.length, capped: false, syncLimit })
        }
      }
    } catch (e) {
      console.warn('⚠️ messaging-history.set handling failed:', e?.message)
      logDiag('warn', 'wa.history.error', '⚠️ messaging-history.set handling failed', { error: e?.message || 'unknown' })
    }
  })

  // Inbound messages
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    const list = Array.isArray(messages) ? messages : []
    const isLiveNotify = String(type || '').toLowerCase() === 'notify'

    for (const msg of list) {
      if (!msg?.message) continue

      const rawChatJid = msg.key.remoteJid
      const group = isGroupJid(rawChatJid)
      const chatJid = group ? normalizeJid(rawChatJid) : resolvePreferredChatJid(rawChatJid)

      if (group && chatJid && !groupCache.byJid.has(chatJid)) {
        scheduleGroupRefresh('messages.upsert:new-group', { delayMs: 250 })
      }

      // ignore outgoing events here (we store outbound ourselves)
      if (msg.key.fromMe) continue

      const senderJid = msg.key.participant || msg.key.remoteJid
      upsertWaContactName(senderJid, msg.pushName || '')

      // Handle protocol-level revoke events by flagging the original message
      // as deleted, while preserving its original text/media in storage.
      const protocol = msg?.message?.protocolMessage
      const protocolType = Number(protocol?.type)
      const revokedTargetId = String(protocol?.key?.id || '').trim()
      if (revokedTargetId && (protocolType === 0 || String(protocol?.type || '').toUpperCase() === 'REVOKE')) {
        const deleted = updateMessageStatusByAnyId(revokedTargetId, { status: 'deleted' })
        if (deleted) upsertRecentMessage(deleted)
        continue
      }

      if (isLiveNotify) {
        try {
          const displayName = resolveInboundDisplayName(senderJid, msg.pushName || '')
          autoAddInboundContact(senderJid, displayName)
        } catch (e) {
          console.warn('⚠️ Auto-add contact failed:', e?.message)
        }
      }
      const msgId = msg.key.id || makeId('in')

      // Determine type + text
      const textRaw = extractTextMessage(msg)
      const hasImage = Boolean(msg.message?.imageMessage)
      const hasDoc = Boolean(msg.message?.documentMessage)
      const hasVideo = Boolean(msg.message?.videoMessage)
      const hasGif = Boolean(msg.message?.videoMessage?.gifPlayback)
      const hasAudio = Boolean(msg.message?.audioMessage)
      const hasVoiceNote = Boolean(msg.message?.audioMessage?.ptt)

      console.log('📩 New message:', { chatJid, rawChatJid, senderJid, textRaw, hasImage, hasDoc, hasVideo, hasGif, hasAudio, hasVoiceNote })
      let type = 'text'
      if (hasImage) type = 'image'
      else if (hasDoc) type = 'document'
      else if (hasVideo) type = 'video'
      else if (hasVoiceNote) type = 'voice-note'
      else if (hasAudio) type = 'audio'

      // Caption may be empty → still store placeholder
      let text = ''
      if (type === 'text') text = String(textRaw || '').trim()
      if (type === 'image') text = String(msg.message?.imageMessage?.caption || '').trim() || '[image]'
      if (type === 'document') {
        const fn = msg.message?.documentMessage?.fileName
        text = fn ? `[document] ${fn}` : '[document]'
      }
      if (type === 'video') {
        text = String(msg.message?.videoMessage?.caption || '').trim() || (hasGif ? '[gif]' : '[video]')
      }
      if (type === 'voice-note') text = '[voice note]'
      if (type === 'audio') text = '[audio]'

      // If it's a plain text message and still empty, skip
      if (type === 'text' && !text) continue

      console.log(`📩 ${chatJid}: ${text}`)

      // If media, download it so the UI can preview
      let media = null
      if (isLiveNotify) {
        try {
          if (type === 'image') media = await saveInboundMedia(msg, 'image', msgId)
          if (type === 'document') media = await saveInboundMedia(msg, 'document', msgId)
          if (type === 'video') media = await saveInboundMedia(msg, 'video', msgId)
        } catch (e) {
          console.warn('⚠️ Failed to download inbound media:', e?.message)
        }
      }

      const msgTs = Number(msg?.messageTimestamp || 0) > 0
        ? Number(msg.messageTimestamp) * 1000
        : Date.now()

      const rec = {
        ts: msgTs,
        chatJid,
        senderJid,
        id: msgId,
        waMsgId: msg.key.id ? String(msg.key.id) : null,
        isGroup: group,
        text,
        direction: 'in',
        status: null,
        type,
        media
      }

      rememberQuotedMessage(msgId, msg)

      // Persist + memory
      addMessageRecord(rec)
      upsertRecentMessage(rec)

      // Forward to n8n (if enabled + allowed by rules)
      if (isLiveNotify) {
        try {
          const textForRules = (type === 'text' ? text : (textRaw ? String(textRaw).trim() : ''))
          if (shouldForwardToN8n(rec, textForRules)) {
            enqueueN8nEvent(buildN8nEvent(rec, textForRules))
          }
        } catch (e) {
          console.warn('⚠️ n8n forward (skipped):', e?.message)
        }
      }

      // response rules (preferred)
      let handledByRule = false
      if (isLiveNotify) {
        try {
          const matchedRule = findMatchingResponseRule({
            chatJid,
            senderJid,
            isGroup: group,
            text,
            rawText: textRaw,
            type,
            voiceNote: hasVoiceNote,
            audio: hasAudio
          })

          if (matchedRule) {
            await queueAutoReplyMessage(chatJid, group, matchedRule.replyText, 'rule', msgId)
            handledByRule = true
          }
        } catch (e) {
          console.warn('⚠️ Response rule handling failed:', e?.message)
        }
      }

      // auto reply logic (optional / legacy fallback)
      const autoReplyCfg = getAutoReplyConfig()
      if (!handledByRule && autoReplyCfg.enabled) {
        if (autoReplyCfg.scope === 'dm' && group) continue
        if (autoReplyCfg.scope === 'group' && !group) continue

        let textToMatch = (type === 'text' ? text : (textRaw ? String(textRaw).trim() : ''))
        if (group) {
          const { ok, text } = stripPrefixByValue(textToMatch, autoReplyCfg.groupPrefix)
          if (!ok) continue
          textToMatch = text
          if (!textToMatch) continue
        }

        if (!matchesAutoReply(textToMatch)) continue

        // Use instance-isolated key for cooldown tracking: "instanceId:chatJid"
        const cooldownKey = `${currentInstanceId}:${chatJid}`
        const last = lastAutoReplyAt.get(cooldownKey) || 0
        if (Date.now() - last < autoReplyCfg.cooldownMs) continue
        lastAutoReplyAt.set(cooldownKey, Date.now())

        await queueAutoReplyMessage(chatJid, group, autoReplyCfg.text, 'auto', msgId)
      }
    }
  })

  sock.ev.on('messages.update', async (updates = []) => {
    try {
      for (const u of updates || []) {
        const id = u?.key?.id
        if (!id) continue

        const remoteJid = normalizeJid(u?.key?.remoteJid)
        if (remoteJid) {
          const relinked = updateMessageChatJidById(id, remoteJid)
          if (relinked) upsertRecentMessage(relinked)
        }

        // Handle protocol-level revoke updates
        const protocol = u?.update?.message?.protocolMessage
        const protocolType = Number(protocol?.type)
        const revokedTargetId = String(protocol?.key?.id || '').trim()
        if (revokedTargetId && (protocolType === 0 || String(protocol?.type || '').toUpperCase() === 'REVOKE')) {
          const deleted = updateMessageStatusByAnyId(revokedTargetId, { status: 'deleted' })
          if (deleted) upsertRecentMessage(deleted)
          continue
        }

        const st = Number(u?.update?.status)
        if (!Number.isFinite(st)) continue

        let mapped = null
        if (st >= 4) mapped = 'read'
        else if (st >= 3) mapped = 'delivered'
        else if (st >= 2) mapped = 'sent'
        if (!mapped) continue

        const updated = updateMessageStatusByAnyId(id, { status: mapped })
        if (updated) upsertRecentMessage(updated)
      }
    } catch (e) {
      console.warn('⚠️ messages.update handling failed:', e?.message)
    }
  })
  } finally {
    startWhatsAppInProgress = false
  }
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
  const q = getQueueConfig()
  const quietDelayMs = computeQuietHoursDelayMs(q?.quietHours, Date.now())
  const explicitDelayMs = Math.max(0, Number(job?.delayMs || 0))
  const delayMs = Math.max(quietDelayMs, explicitDelayMs)

  await sendQueue.add('send', job, {
    jobId,
    attempts: q.maxRetries + 1,
    backoff: { type: 'exponential', delay: q.retryBackoffMs },
    ...(delayMs > 0 ? { delay: delayMs } : {})
  })

  if (delayMs > 0 && job?.msgId) {
    const delayedUntilTs = Date.now() + delayMs
    const updated = updateMessageStatus(job.msgId, { status: 'queued', quietDelayedUntilTs: delayedUntilTs })
    if (updated) upsertRecentMessage(updated)
  }

  return jobId
}

let lastGlobalSendAt = 0

async function redisPerJidGate(jid) {
  // Durable per-JID last-send tracking in Redis
  const cfg = getQueueConfig()
  const key = `wa:lastSendAt:${jid}`
  const now = Date.now()

  const last = await redis.get(key)
  const lastNum = last ? Number(last) : 0
  const since = now - lastNum

  if (since < cfg.perJidGapMs) {
    await sleep(cfg.perJidGapMs - since)
  }

  // set new timestamp
  await redis.set(key, String(Date.now()))
}

async function globalGate() {
  const cfg = getQueueConfig()
  if (!cfg.globalMinGapMs) return
  const since = Date.now() - lastGlobalSendAt
  if (since < cfg.globalMinGapMs) await sleep(cfg.globalMinGapMs - since)
  lastGlobalSendAt = Date.now()
}

// Worker will be initialized lazily once queue is set up
let worker = null

function initializeWorker(queueName) {
  if (worker) {
    console.log('🔲 Closing previous worker...')
    worker.close().catch(() => {})
  }

  worker = new Worker(
    queueName,
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
        const quoted = job.quotedMessageId ? getQuotedMessage(job.quotedMessageId) : null
        const sendResult = await sock.sendMessage(job.jid, job.payload, quoted ? { quoted } : undefined)
        const waMsgId = String(sendResult?.key?.id || '').trim()

        if (job.msgId) {
          if (waMsgId) {
            const linked = linkMessageWaId(job.msgId, waMsgId)
            if (linked) upsertRecentMessage(linked)
          }
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

  console.log(`🔲 Worker initialized for queue: ${queueName}`)
}


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
    waMsgId: rec.waMsgId ? String(rec.waMsgId) : null,
    ts: rec.ts || Date.now(),
    chatJid: normalizeJid(rec.chatJid),
    senderJid: rec.senderJid || '',
    isGroup: Boolean(rec.isGroup),
    direction: rec.direction || 'in',
    status: rec.status ?? null,
    type: rec.type || 'text',
    text: rec.text || '',
    media: rec.media || null,
    quotedMessageId: rec.quotedMessageId || null,
  }

  if (!normalized.chatJid) return

  const idx = recentIndexById.get(normalized.id)
  if (idx === undefined) {
    recentMessages.push(normalized)
    recentIndexById.set(normalized.id, recentMessages.length - 1)
    // Trim array to limit without full rebuild
    if (recentMessages.length > MESSAGES_MEMORY_LIMIT) {
      const toRemove = recentMessages.length - MESSAGES_MEMORY_LIMIT
      const removed = recentMessages.splice(0, toRemove)
      // Only remove the deleted IDs from index, don't rebuild everything
      for (const r of removed) {
        if (r?.id) recentIndexById.delete(r.id)
      }
      // Update indices for remaining messages (shift down by toRemove)
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

  const summary = chatIndex.get(key)
  broadcastAdminMessageUpdate(key, normalized, summary)
}

// Faster version for bulk hydration (no broadcasts)
function upsertRecentMessageSilent(rec) {
  const normalized = {
    id: rec.id || makeId('msg'),
    waMsgId: rec.waMsgId ? String(rec.waMsgId) : null,
    ts: rec.ts || Date.now(),
    chatJid: normalizeJid(rec.chatJid),
    senderJid: rec.senderJid || '',
    isGroup: Boolean(rec.isGroup),
    direction: rec.direction || 'in',
    status: rec.status ?? null,
    type: rec.type || 'text',
    text: rec.text || '',
    media: rec.media || null,
    quotedMessageId: rec.quotedMessageId || null,
  }

  if (!normalized.chatJid) return

  const idx = recentIndexById.get(normalized.id)
  if (idx === undefined) {
    recentMessages.push(normalized)
    recentIndexById.set(normalized.id, recentMessages.length - 1)
    // Trim array to limit without full rebuild
    if (recentMessages.length > MESSAGES_MEMORY_LIMIT) {
      const toRemove = recentMessages.length - MESSAGES_MEMORY_LIMIT
      const removed = recentMessages.splice(0, toRemove)
      // Only remove the deleted IDs from index, don't rebuild everything
      for (const r of removed) {
        if (r?.id) recentIndexById.delete(r.id)
      }
      // Update indices for remaining messages (shift down by toRemove)
      for (let i = 0; i < recentMessages.length; i++) {
        if (recentMessages[i]?.id) recentIndexById.set(recentMessages[i].id, i)
      }
    }
  } else {
    recentMessages[idx] = { ...recentMessages[idx], ...normalized }
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
  // Skip broadcastAdminMessageUpdate for silent hydration
}

function splitTargetsInput(input) {
  if (Array.isArray(input)) {
    return input
      .map(v => String(v || '').trim())
      .filter(Boolean)
  }
  return String(input || '')
    .split(/[\n,;]+/g)
    .map(v => v.trim())
    .filter(Boolean)
}

function normalizeSchedulePayload(payload = {}) {
  const type = String(payload.type || 'text').trim()
  if (type !== 'text') throw new Error('Only text scheduled payload is supported currently')
  const message = String(payload.message || '').trim()
  if (!message) throw new Error('Scheduled text message is required')
  return { type: 'text', message }
}

async function queueScheduledText(to, message, scheduleId) {
  const jid = await resolveToJid(to)
  const msgId = makeId('out_sched_txt')
  const payload = { text: String(message) }

  const saved = addMessageRecord({
    id: msgId,
    direction: 'out',
    ts: Date.now(),
    chatJid: jid,
    senderJid: 'me',
    isGroup: isGroupJid(jid),
    type: 'text',
    text: payload.text,
    status: 'queued',
    scheduleId: scheduleId || null
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
    media: saved.media || null,
    quotedMessageId: saved.quotedMessageId || null
  })

  const jobId = await enqueue({
    id: makeId('job_sched_txt'),
    jid,
    payload,
    createdAt: Date.now(),
    msgId,
    chatJid: jid
  })

  return { to, jid, msgId, jobId }
}

let scheduleWorkerRunning = false

async function processDueSchedules() {
  if (scheduleWorkerRunning) return
  scheduleWorkerRunning = true

  try {
    const now = Date.now()
    const store = readSchedulesStore()
    const items = Array.isArray(store.schedules) ? store.schedules : []
    const due = items.filter(s => s && s.status === 'pending' && Number(s.sendAt || 0) <= now)
    if (!due.length) return

    for (const sched of due) {
      sched.status = 'processing'
      sched.startedAt = Date.now()
      sched.results = []

      const targets = splitTargetsInput(sched.targets)
      const message = String(sched?.payload?.message || '')

      for (const to of targets) {
        try {
          const r = await queueScheduledText(to, message, sched.id)
          sched.results.push({ ok: true, to, jid: r.jid, msgId: r.msgId, jobId: r.jobId })
        } catch (e) {
          sched.results.push({ ok: false, to, error: e?.message || String(e) })
        }
      }

      const okCount = sched.results.filter(r => r.ok).length
      if (!targets.length) sched.status = 'failed'
      else if (okCount === targets.length) sched.status = 'completed'
      else if (okCount > 0) sched.status = 'partial'
      else sched.status = 'failed'

      sched.completedAt = Date.now()
    }

    writeSchedulesStore(store)
  } catch (e) {
    console.warn('⚠️ schedule worker failed:', e?.message)
  } finally {
    scheduleWorkerRunning = false
  }
}



/**
 * ----------------------------
 * Express
 * ----------------------------
 */
const app = express()
app.disable('x-powered-by')
app.set('trust proxy', true)

function normalizeForwardedPrefix(raw = '') {
  const s = String(raw || '').trim()
  if (!s) return ''
  const first = s.split(',')[0].trim()
  if (!first) return ''
  const prefixed = first.startsWith('/') ? first : `/${first}`
  return prefixed.replace(/\/+$/, '')
}

function withBase(req, path = '') {
  const base = normalizeForwardedPrefix(req?.headers?.['x-forwarded-prefix'] || req?.basePath || '')
  const p = String(path || '').trim()
  if (!p) return base || ''
  if (/^https?:\/\//i.test(p)) return p
  const nextPath = p.startsWith('/') ? p : `/${p}`
  return `${base}${nextPath}`
}

app.use((req, res, next) => {
  req.basePath = normalizeForwardedPrefix(req.headers['x-forwarded-prefix'] || '')
  next()
})

// allow inline scripts in admin/pairing UI
app.use(helmet({ contentSecurityPolicy: false }))

app.use(express.json({ limit: '25mb' }))
app.use(express.urlencoded({ extended: false }))

const requestTracingMiddleware = createRequestTracingMiddleware({
  headerName: 'x-request-id',
  slowMs: Math.max(100, Number(process.env.HTTP_SLOW_MS || 800)),
  includePaths: ['/admin', '/pairing'],
  onEvent: (level, event, message, data) => {
    logDiag(level, event, message, data)
  }
})
app.use(requestTracingMiddleware)

let limiter = null
function rebuildRateLimiter() {
  const cfg = getRateLimitConfig()
  limiter = rateLimit({
    windowMs: cfg.windowMs,
    max: cfg.max,
    standardHeaders: true,
    legacyHeaders: false
  })
  return cfg
}
rebuildRateLimiter()

app.use((req, res, next) => {
  if (req.path.startsWith('/admin/')) return next()
  if (req.path.startsWith('/pairing/')) return next()
  return limiter(req, res, next)
})

app.use(apiKeyMiddleware)
registerAdminMiddlewares({
  app,
  clientIp,
  isIpAllowed,
  isAdminMutatingMethod,
  resolveAdminAuthContext,
  parseCookies,
  adminCsrfCookieName: ADMIN_CSRF_COOKIE,
  requiredRoleForAdminRequest,
  roleSatisfies,
  appendAdminAuditLog
})

app.get('/', (req, res) => {
  res.redirect(withBase(req, '/admin/ui'))
})

app.get('/admin/login', (req, res) => {
  if (!REQUIRE_ADMIN_KEY) return res.status(500).send('Admin keys not set (WA_ADMIN_KEY / WA_OPERATOR_KEY / WA_VIEWER_KEY)')
  if (hasValidAdminSession(req)) return res.redirect(withBase(req, '/admin/ui'))
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.send(adminLoginPageHtml(req))
})

app.post('/admin/login', (req, res) => {
  if (!REQUIRE_ADMIN_KEY) return res.status(500).send('Admin keys not set (WA_ADMIN_KEY / WA_OPERATOR_KEY / WA_VIEWER_KEY)')
  const key = String(req.body?.adminKey || req.body?.key || '').trim()
  const role = resolveAdminRoleFromKey(key)
  if (!role) {
    appendAdminAuditLog({
      action: 'admin_login',
      method: req.method,
      path: req.originalUrl || req.url,
      statusCode: 401,
      ok: false,
      actor: 'anonymous',
      authMode: 'none',
      ip: clientIp(req),
      userAgent: req.get('user-agent') || '',
      durationMs: 0
    })
    return res.redirect(withBase(req, '/admin/login?e=' + encodeURIComponent('Invalid key')))
  }
  setAdminSessionCookie(res, role)
  setAdminCsrfCookie(res, generateCsrfToken())
  appendAdminAuditLog({
    action: 'admin_login',
    method: req.method,
    path: req.originalUrl || req.url,
    statusCode: 200,
    ok: true,
    actor: `${role}-session`,
    authMode: 'session',
    ip: clientIp(req),
    userAgent: req.get('user-agent') || '',
    durationMs: 0
  })
  return res.redirect(withBase(req, '/admin/ui'))
})

app.post('/admin/logout', requireAdminSessionAny, (req, res) => {
  const role = req.adminRole || getAdminRoleFromSession(req) || 'viewer'
  clearAdminSessionCookie(res)
  clearAdminCsrfCookie(res)
  appendAdminAuditLog({
    action: 'admin_logout',
    method: req.method,
    path: req.originalUrl || req.url,
    statusCode: 200,
    ok: true,
    actor: `${role}-session`,
    authMode: 'session',
    ip: clientIp(req),
    userAgent: req.get('user-agent') || '',
    durationMs: 0
  })
  res.json({ ok: true })
})

app.get('/admin/csrf', requireAdminSessionAny, (req, res) => {
  const token = generateCsrfToken()
  setAdminCsrfCookie(res, token)
  res.json({ ok: true, csrfToken: token })
})

app.get('/admin/me', adminKeyMiddleware, (req, res) => {
  const ctx = resolveAdminAuthContext(req)
  res.json({ ok: true, role: ctx.role || req.adminRole || 'viewer', authMode: ctx.mode || req.adminAuthMode || 'unknown' })
})

// Admin static assets (CSS, JS)
app.use(
  '/admin/assets',
  requireAdminSessionAny,
  express.static(path.join(process.cwd(), 'ui/admin'), {
    etag: true,
    lastModified: false,
    setHeaders(res) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
      res.setHeader('Pragma', 'no-cache')
      res.setHeader('Expires', '0')
    }
  })
)


/**
 * Health
 */
app.get('/health', async (req, res) => {
  const counts = await sendQueue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed')
  const deps = await getDependencyHealthSnapshot()
  const schedules = readSchedulesStore()
  const deadLetters = readN8nDeadLettersStore()
  const autoReply = getAutoReplyConfig()
  const rateCfg = getRateLimitConfig()
  const apiCfg = getApiConfig()
  const mediaCfg = getMediaConfig()
  const msgCfg = getMessageStorageConfig()
  res.json({
    ok: true,
    wa: { status: connectionStatus, hasQR: Boolean(lastQR) },
    dependencies: deps,
    groupCache: { updatedAt: groupCache.updatedAt, count: groupCache.byJid.size },
    queue: { name: getWaQueueName(), ...counts },
    autoReply: { enabled: autoReply.enabled, scope: autoReply.scope },
    rateLimit: { windowMs: rateCfg.windowMs, max: rateCfg.max },
    api: {
      enabled: apiCfg.enabled,
      sendTextEnabled: apiCfg.sendTextEnabled,
      sendImageEnabled: apiCfg.sendImageEnabled,
      sendDocumentEnabled: apiCfg.sendDocumentEnabled
    },
    media: { urlTtlSeconds: mediaCfg.urlTtlSeconds, retentionDays: mediaCfg.retentionDays },
    responseRules: { enabled: Boolean(responseRules?.enabled), count: Array.isArray(responseRules?.rules) ? responseRules.rules.length : 0 },
    schedules: { count: schedules.schedules.length, pending: schedules.schedules.filter(s => s.status === 'pending').length },
    n8n: { webhookUrls: getAutomationWebhookUrls().length, deadLetters: deadLetters.items.length },
    messages: {
      storage: activeStorageBackend(),
      persistMax: msgCfg.persistMax,
      uiFetchLimit: msgCfg.uiFetchLimit,
      memLimit: MESSAGES_MEMORY_LIMIT
    }
  })
})


/**
 * Pairing
 */
async function servePairingQrPng(req, res) {
  try {
    if (!lastQR) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
      res.setHeader('Pragma', 'no-cache')
      res.setHeader('Expires', '0')
      return res.status(204).end()
    }
    res.setHeader('Content-Type', 'image/png')
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
    res.setHeader('Pragma', 'no-cache')
    res.setHeader('Expires', '0')
    res.setHeader('ETag', `"qr-${lastQRUpdatedAt}"`)

    if (!lastQRPngBuffer || lastQRPngBufferVersion !== lastQRUpdatedAt) {
      if (!qrPngBuildPromise) {
        qrPngBuildPromise = QRCode.toBuffer(lastQR, { type: 'png', width: 320 })
          .then((buf) => {
            lastQRPngBuffer = buf
            lastQRPngBufferVersion = lastQRUpdatedAt
            return buf
          })
          .finally(() => {
            qrPngBuildPromise = null
          })
      }
      await qrPngBuildPromise
    }

    res.send(lastQRPngBuffer)
  } catch (err) {
    res.status(500).send(err?.message || 'Failed to generate QR PNG')
  }
}

app.get('/pairing/qr.png', requireAdminSessionAny, servePairingQrPng)
app.get('/admin/pairing/qr.png', adminKeyMiddleware, servePairingQrPng)

function servePairingStream(req, res) {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-store, no-cache, no-transform, must-revalidate, max-age=0')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders?.()
  try { res.write(': connected\n\n') } catch {}

  sseClients.add(res)
  sseSend(res, 'status', { status: connectionStatus, hasQR: Boolean(lastQR), qrUpdatedAt: lastQRUpdatedAt })
  if (lastQR) sseSend(res, 'qr', { qr: lastQR, qrUpdatedAt: lastQRUpdatedAt })

  const ping = setInterval(() => {
    try { res.write(`event: ping\ndata: {}\n\n`) } catch {}
  }, 15000)

  req.on('close', () => {
    clearInterval(ping)
    sseClients.delete(res)
  })
}

app.get('/pairing/stream', requireAdminSessionAny, servePairingStream)
app.get('/admin/pairing/stream', adminKeyMiddleware, servePairingStream)

/**
 * Pairing UI (kept as you provided)
 */
app.get('/pairing/ui', (req, res) => {
  return res.redirect(withBase(req, '/admin/ui'))
})

/**
 * Unified public send endpoints
 * - UPDATED: store outbound in persistent store + memory with status queued/sent/failed
 */
app.post('/send', requireApiToggle('sendTextEnabled', 'Text API'), requireConnected, async (req, res) => {
  const idem = beginIdempotentRequest(readIdempotencyKey(req))
  if (idem.duplicate) {
    if (idem.pending) {
      return res.status(409).json({ ok: false, error: 'Duplicate request in progress', idempotencyKey: idem.key })
    }
    return res.json({ ...(idem.response || { ok: true, duplicate: true }), duplicate: true, idempotencyKey: idem.key })
  }

  try {
    const { to, message } = req.body || {}
    if (!to || !message) return res.status(400).json({ ok: false, error: 'Missing to/message' })
    const jid = await resolveToJid(to)
    const quotedMessageId = req.body?.quotedMessageId ? String(req.body.quotedMessageId).trim() : ''

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
      status: 'queued',
      quotedMessageId: quotedMessageId || null
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
        media: saved.media || null,
        quotedMessageId: saved.quotedMessageId || null
        })


    const jobId = await enqueue({
        id: makeId('job_txt'),
        jid,
        payload,
        createdAt: Date.now(),
        msgId,
        chatJid: jid,
        quotedMessageId: quotedMessageId || null
        })

      const responsePayload = { ok: true, to, jid, queued: true, jobId, msgId, quotedMessageId: quotedMessageId || null }
      completeIdempotentRequest(idem.key, responsePayload)
      res.json(responsePayload)
  } catch (err) {
    failIdempotentRequest(idem.key)
    if (err.code === 'AMBIGUOUS_GROUP') return res.status(409).json({ ok: false, error: err.message, matches: err.matches })
    res.status(400).json({ ok: false, error: err?.message || 'Failed to queue text' })
  }
})

app.post('/send/image', requireApiToggle('sendImageEnabled', 'Image API'), requireConnected, upload.single('image'), async (req, res) => {
  const idem = beginIdempotentRequest(readIdempotencyKey(req))
  if (idem.duplicate) {
    if (idem.pending) {
      return res.status(409).json({ ok: false, error: 'Duplicate request in progress', idempotencyKey: idem.key })
    }
    return res.json({ ...(idem.response || { ok: true, duplicate: true }), duplicate: true, idempotencyKey: idem.key })
  }

  try {
    const to = req.body?.to
    const caption = req.body?.caption || ''
    if (!to) return res.status(400).json({ ok: false, error: 'Missing to' })
    const jid = await resolveToJid(to)
    const quotedMessageId = req.body?.quotedMessageId ? String(req.body.quotedMessageId).trim() : ''

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
      status: 'queued',
      quotedMessageId: quotedMessageId || null
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
        media: saved.media || null,
        quotedMessageId: saved.quotedMessageId || null
        })


    const jobId = await enqueue({
        id: makeId('job_img'),
        jid,
        payload,
        createdAt: Date.now(),
        msgId,
        chatJid: jid,
        quotedMessageId: quotedMessageId || null
        })

      const responsePayload = { ok: true, to, jid, queued: true, jobId, msgId, quotedMessageId: quotedMessageId || null }
      completeIdempotentRequest(idem.key, responsePayload)
      res.json(responsePayload)
  } catch (err) {
    failIdempotentRequest(idem.key)
    if (err.code === 'AMBIGUOUS_GROUP') return res.status(409).json({ ok: false, error: err.message, matches: err.matches })
    res.status(400).json({ ok: false, error: err?.message || 'Failed to queue image' })
  }
})

app.post('/send/document', requireApiToggle('sendDocumentEnabled', 'Document API'), requireConnected, upload.single('document'), async (req, res) => {
  const idem = beginIdempotentRequest(readIdempotencyKey(req))
  if (idem.duplicate) {
    if (idem.pending) {
      return res.status(409).json({ ok: false, error: 'Duplicate request in progress', idempotencyKey: idem.key })
    }
    return res.json({ ...(idem.response || { ok: true, duplicate: true }), duplicate: true, idempotencyKey: idem.key })
  }

  try {
    const to = req.body?.to
    if (!to) return res.status(400).json({ ok: false, error: 'Missing to' })
    const jid = await resolveToJid(to)
    const quotedMessageId = req.body?.quotedMessageId ? String(req.body.quotedMessageId).trim() : ''

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
      status: 'queued',
      quotedMessageId: quotedMessageId || null
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
        media: saved.media || null,
        quotedMessageId: saved.quotedMessageId || null
        })


    const jobId = await enqueue({
    id: makeId('job_doc'),
    jid,
    payload,
    createdAt: Date.now(),
    msgId,
    chatJid: jid,
    quotedMessageId: quotedMessageId || null
    })

    const responsePayload = { ok: true, to, jid, queued: true, jobId, msgId, quotedMessageId: quotedMessageId || null }
    completeIdempotentRequest(idem.key, responsePayload)
    res.json(responsePayload)
  } catch (err) {
    failIdempotentRequest(idem.key)
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

  const mt = resolveMediaMimeTypeByFileName(name) || mimeFromFileExtension(name) || sniffMimeFromFileHead(full)
  if (mt) res.type(mt)

  res.setHeader('Content-Disposition', 'inline')
  res.setHeader('Accept-Ranges', 'bytes')
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

app.get('/admin/link-preview', adminKeyMiddleware, async (req, res) => {
  try {
    const url = String(req.query?.url || '').trim()
    if (!url) return res.status(400).json({ ok: false, error: 'url query is required' })
    const preview = await fetchLinkPreview(url)
    res.json({ ok: true, preview })
  } catch (e) {
    res.status(400).json({ ok: false, error: e?.message || 'Failed to fetch link preview' })
  }
})

app.get('/board/link-preview', async (req, res) => {
  try {
    const url = String(req.query?.url || '').trim()
    if (!url) return res.status(400).json({ ok: false, error: 'url query is required' })
    const preview = await fetchLinkPreview(url)
    res.json({ ok: true, preview })
  } catch (e) {
    res.status(400).json({ ok: false, error: e?.message || 'Failed to fetch link preview' })
  }
})



app.get('/admin/targets', adminKeyMiddleware, async (req, res) => {
  const store = contactsStoreCache || { contacts: [], groups: [], updatedAt: Date.now() }
  const contacts = (store.contacts || []).map(c => ({
    type: 'contact',
    name: c.name,
    msisdn: c.msisdn || localMsisdnDisplay(msisdnFromJid(c.jid || '')) || null,
    msisdnIntl: c.msisdnIntl || intlMsisdnDisplay(c.msisdn || msisdnFromJid(c.jid || '')) || null,
    to: (c.msisdn ? c.msisdn : '') || c.jid || '',
    jid: c.jid || null,
    aliasJids: normalizeAliasJids(c.aliasJids || [], c.jid || '')
  }))

  const groupAliases = (store.groups || []).map(g => ({
    type: 'group-alias',
    name: g.name,
    to: g.jid,
    jid: g.jid
  }))

  if (connectionStatus !== 'open' || !sock) {
    return res.json({
      ok: true,
      contacts,
      groupAliases,
      waGroups: [],
      waContacts: [],
      groupCacheUpdatedAt: groupCache.updatedAt,
      contactCacheUpdatedAt: contactCache.updatedAt,
      degraded: true
    })
  }

  const waGroups = Array.from(groupCache.byJid.values()).map(g => ({
    type: 'wa-group',
    name: g.subject,
    to: g.jid,
    jid: g.jid
  })).sort((a,b)=>String(a.name).localeCompare(String(b.name)))

  const waContacts = Array.from(contactCache.byJid.values())
    .map(c => ({
      type: 'wa-contact',
      name: c.name,
      to: c.jid,
      jid: c.jid
    }))
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')))

  res.json({
    ok: true,
    contacts,
    groupAliases,
    waGroups,
    waContacts,
    groupCacheUpdatedAt: groupCache.updatedAt,
    contactCacheUpdatedAt: contactCache.updatedAt
  })
})


// ---- Automations (n8n) config ----
app.get('/admin/settings/runtime', adminKeyMiddleware, async (req, res) => {
  let cfg = await readRuntimeSettingsFromDb()
  if (!cfg) cfg = readRuntimeSettingsStore()
  runtimeSettings = cfg
  res.json({ ok: true, settings: cfg, storage: activeStorageBackend() })
})

app.get('/admin/audit', adminKeyMiddleware, (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit || 100), 1), 1000)
  const store = readAdminAuditStore()
  const items = store.items.slice(-limit).reverse()
  res.json({ ok: true, count: items.length, items, updatedAt: store.updatedAt })
})

app.post('/admin/settings/runtime', adminKeyMiddleware, async (req, res) => {
  try {
    const patch = normalizeRuntimeSettingsPatch(req.body || {})
    runtimeSettings = {
      ...runtimeSettings,
      ...patch,
      updatedAt: Date.now(),
      lastSavedBy: 'admin'
    }
    saveRuntimeSettingsStore()
    rebuildRateLimiter()
    res.json({ ok: true, settings: runtimeSettings })
  } catch (e) {
    res.status(400).json({ ok: false, error: e?.message || 'Failed to save settings' })
  }
})

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

    next.updatedAt = Date.now()
    next.lastSavedBy = 'admin'
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
  automations.updatedAt = Date.now()
  automations.lastSavedBy = 'admin'

  saveAutomations(); // whatever your persistence function is
  res.json(automations);
});

app.post('/admin/automations/test', adminKeyMiddleware, async (req, res) => {
  try {
    const sample = {
      event: 'automation_test',
      eventId: makeId('n8n_test'),
      ts: Date.now(),
      chatJid: 'test@s.whatsapp.net',
      isGroup: false,
      senderJid: 'test@s.whatsapp.net',
      type: 'text',
      text: String(req.body?.text || 'n8n test event')
    }
    await postToN8n(sample)
    res.json({ ok: true, sent: true, urls: getAutomationWebhookUrls() })
  } catch (e) {
    res.status(400).json({ ok: false, error: e?.message || 'Failed to send test webhook' })
  }
})

app.get('/admin/n8n/dead-letters', adminKeyMiddleware, (req, res) => {
  const store = readN8nDeadLettersStore()
  const limit = Math.min(Math.max(Number(req.query.limit || 100), 1), 500)
  const items = store.items.slice(-limit).reverse()
  res.json({ ok: true, count: items.length, updatedAt: store.updatedAt, items })
})

app.post('/admin/n8n/dead-letters/:id/retry', adminKeyMiddleware, (req, res) => {
  const id = String(req.params.id || '').trim()
  const out = removeN8nDeadLetterById(id)
  if (!out.removed || !out.item) return res.status(404).json({ ok: false, error: 'Dead-letter item not found' })

  const retried = retryDeadLetterItem(out.item, req.adminRole || 'admin')
  if (!retried.ok) {
    addN8nDeadLetter(out.item)
    return res.status(400).json({ ok: false, error: `Retry failed: ${retried.reason}` })
  }

  res.json({ ok: true, retried: true, id, updatedAt: out.updatedAt })
})

app.post('/admin/n8n/dead-letters/retry-all', adminKeyMiddleware, (req, res) => {
  const store = readN8nDeadLettersStore()
  const items = Array.isArray(store.items) ? [...store.items] : []
  if (!items.length) return res.json({ ok: true, retried: 0, skipped: 0, updatedAt: store.updatedAt })

  let retried = 0
  let skipped = 0
  for (const item of items) {
    const out = retryDeadLetterItem(item, req.adminRole || 'admin')
    if (out.ok) retried += 1
    else skipped += 1
  }

  clearN8nDeadLetters()
  res.json({ ok: true, retried, skipped, updatedAt: Date.now() })
})

app.delete('/admin/n8n/dead-letters/:id', adminKeyMiddleware, (req, res) => {
  const id = String(req.params.id || '').trim()
  const out = removeN8nDeadLetterById(id)
  res.json({ ok: true, removed: out.removed, updatedAt: out.updatedAt })
})

app.delete('/admin/n8n/dead-letters', adminKeyMiddleware, (req, res) => {
  const out = clearN8nDeadLetters()
  res.json(out)
})

app.get('/admin/health/dependencies', adminKeyMiddleware, async (req, res) => {
  const deps = await getDependencyHealthSnapshot()
  res.json({ ok: true, dependencies: deps })
})

app.get('/admin/connection', adminKeyMiddleware, async (req, res) => {
  const counts = await sendQueue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed')
  const dependencies = await getDependencyHealthSnapshot()
  const schedules = readSchedulesStore()
  const deadLetters = readN8nDeadLettersStore()
  const delivery = summarizeDeliveryLifecycle(2000, 8)
  const queueCfg = getQueueConfig()
  const scheduleCounts = {
    pending: schedules.schedules.filter(s => s.status === 'pending').length,
    processing: schedules.schedules.filter(s => s.status === 'processing').length,
    completed: schedules.schedules.filter(s => s.status === 'completed').length,
    partial: schedules.schedules.filter(s => s.status === 'partial').length,
    failed: schedules.schedules.filter(s => s.status === 'failed').length,
    cancelled: schedules.schedules.filter(s => s.status === 'cancelled').length
  }

  res.json({
    ok: true,
    wa: { status: connectionStatus, hasQR: Boolean(lastQR) },
    dependencies,
    groupCache: { updatedAt: groupCache.updatedAt, count: groupCache.byJid.size },
    queue: { name: getWaQueueName(), ...counts, quietHours: queueCfg.quietHours },
    schedules: { total: schedules.schedules.length, ...scheduleCounts },
    n8n: { deadLetters: Array.isArray(deadLetters.items) ? deadLetters.items.length : 0 },
    delivery
  })
})

app.post('/admin/force-logout', adminKeyMiddleware, requireConnected, async (req, res) => {
  try {
    await sock.logout()
    res.json({ ok: true, status: 'logout-requested' })
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || 'Failed to logout' })
  }
})

app.post('/admin/group-cache/refresh', adminKeyMiddleware, requireConnected, async (req, res) => {
  try {
    const out = await refreshGroups()
    res.json({ ok: true, ...out })
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || 'Failed to refresh groups' })
  }
})

app.post('/admin/schedule', adminKeyMiddleware, (req, res) => {
  try {
    const targets = splitTargetsInput(req.body?.targets || req.body?.to || [])
    if (!targets.length) return res.status(400).json({ ok: false, error: 'targets required' })

    const payload = normalizeSchedulePayload(req.body?.payload || req.body)
    const sendAtRaw = req.body?.sendAt
    const sendAt = sendAtRaw ? new Date(sendAtRaw).getTime() : Date.now()
    if (!Number.isFinite(sendAt)) return res.status(400).json({ ok: false, error: 'Invalid sendAt' })

    const store = readSchedulesStore()
    const item = {
      id: makeId('schedule'),
      createdAt: Date.now(),
      sendAt,
      status: 'pending',
      targets,
      payload,
      meta: {
        note: String(req.body?.note || '').trim() || null,
        createdBy: 'admin'
      }
    }
    store.schedules.push(item)
    writeSchedulesStore(store)

    if (sendAt <= Date.now()) {
      processDueSchedules().catch(() => {})
    }

    res.json({ ok: true, schedule: item })
  } catch (e) {
    res.status(400).json({ ok: false, error: e?.message || 'Failed to create schedule' })
  }
})

app.get('/admin/schedule', adminKeyMiddleware, (req, res) => {
  const store = readSchedulesStore()
  const limit = Math.min(Math.max(Number(req.query.limit || 200), 1), 1000)
  const list = [...store.schedules].sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0)).slice(0, limit)
  res.json({ ok: true, count: list.length, updatedAt: store.updatedAt, schedules: list })
})

app.post('/admin/schedule/:id/run-now', adminKeyMiddleware, (req, res) => {
  const id = String(req.params.id || '').trim()
  const store = readSchedulesStore()
  const item = store.schedules.find(s => String(s.id) === id)
  if (!item) return res.status(404).json({ ok: false, error: 'Schedule not found' })
  if (!['pending', 'failed'].includes(item.status)) {
    return res.status(400).json({ ok: false, error: `Cannot run schedule in status ${item.status}` })
  }
  item.status = 'pending'
  item.sendAt = Date.now()
  writeSchedulesStore(store)
  processDueSchedules().catch(() => {})
  res.json({ ok: true, schedule: item })
})

app.delete('/admin/schedule/:id', adminKeyMiddleware, (req, res) => {
  const id = String(req.params.id || '').trim()
  const store = readSchedulesStore()
  const item = store.schedules.find(s => String(s.id) === id)
  if (!item) return res.status(404).json({ ok: false, error: 'Schedule not found' })
  if (item.status !== 'pending') {
    return res.status(400).json({ ok: false, error: 'Only pending schedules can be cancelled' })
  }
  item.status = 'cancelled'
  item.cancelledAt = Date.now()
  writeSchedulesStore(store)
  res.json({ ok: true, schedule: item })
})


// Convenience: enable/disable or tweak one chat/group rule
app.post('/admin/automations/chat/:jid', adminKeyMiddleware, (req, res) => {
  try {
    const jid = String(req.params.jid || '').trim()
    if (!jid) return res.status(400).json({ ok: false, error: 'jid required' })

    if (!automations.perChat) automations.perChat = {}
    const current = automations.perChat[jid] || {}
    const patch = req.body || {}

    automations.perChat[jid] = mergeDeep(current, patch)
    automations.updatedAt = Date.now()
    automations.lastSavedBy = 'admin'
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

app.get('/admin/rules', adminKeyMiddleware, (req, res) => {
  responseRules = readRulesStore()
  res.json({ ok: true, rulesConfig: responseRules })
})

app.get('/admin/templates', adminKeyMiddleware, (req, res) => {
  const store = readTemplatesStore()
  const templates = (store.templates || [])
    .slice()
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')))
  res.json({ ok: true, updatedAt: store.updatedAt, templates })
})

app.post('/admin/templates', adminKeyMiddleware, (req, res) => {
  try {
    const store = readTemplatesStore()
    const template = upsertTemplate(store, req.body || {})
    const saved = writeTemplatesStore(store)
    res.json({ ok: true, updatedAt: saved.updatedAt, template })
  } catch (e) {
    if (e?.code === 'TEMPLATE_NAME_EXISTS') {
      return res.status(409).json({ ok: false, error: e.message })
    }
    res.status(400).json({ ok: false, error: e?.message || 'Failed to save template' })
  }
})

app.delete('/admin/templates/:id', adminKeyMiddleware, (req, res) => {
  const store = readTemplatesStore()
  const removed = deleteTemplate(store, req.params.id)
  const saved = writeTemplatesStore(store)
  res.json({ ok: true, removed, updatedAt: saved.updatedAt })
})

app.post('/admin/rules/config', adminKeyMiddleware, (req, res) => {
  try {
    responseRules = readRulesStore()
    responseRules.enabled = Boolean(req.body?.enabled)
    saveRulesStore()
    res.json({ ok: true, rulesConfig: responseRules })
  } catch (e) {
    res.status(400).json({ ok: false, error: e?.message || 'Failed to save rules config' })
  }
})

app.post('/admin/rules', adminKeyMiddleware, (req, res) => {
  try {
    responseRules = readRulesStore()
    const incomingId = String(req.body?.id || '').trim()
    const idx = incomingId ? responseRules.rules.findIndex(r => String(r.id) === incomingId) : -1
    const existing = idx >= 0 ? responseRules.rules[idx] : null
    const rule = validateResponseRule(normalizeResponseRule(req.body || {}, existing))

    if (idx >= 0) responseRules.rules[idx] = rule
    else responseRules.rules.push(rule)

    if (rule.enabled) responseRules.enabled = true

    saveRulesStore()
    res.json({ ok: true, rule, rulesConfig: responseRules })
  } catch (e) {
    res.status(400).json({ ok: false, error: e?.message || 'Failed to save rule' })
  }
})

app.delete('/admin/rules/:id', adminKeyMiddleware, (req, res) => {
  try {
    responseRules = readRulesStore()
    const id = String(req.params.id || '').trim()
    const before = responseRules.rules.length
    responseRules.rules = responseRules.rules.filter(rule => String(rule.id) !== id)
    saveRulesStore()
    res.json({ ok: true, removed: before !== responseRules.rules.length, rulesConfig: responseRules })
  } catch (e) {
    res.status(400).json({ ok: false, error: e?.message || 'Failed to delete rule' })
  }
})

app.post('/admin/force-relink', adminKeyMiddleware, async (req, res) => {
  try {
    const result = await triggerRelink('admin-force-relink', { clearAuth: true })
    if (result?.skipped) {
      return res.status(409).json({ ok: false, error: 'Relink already in progress' })
    }
    logDiag('warn', 'wa.relink.forced', '🛠️ Force re-pair triggered from admin UI', { adminAuthMode: req.adminAuthMode || 'unknown' })
    res.json({ ok: true, status: connectionStatus })
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || 'Failed to force relink' })
  }
})

function buildAdminDebugState() {
  const mem = process.memoryUsage()
  return {
    ok: true,
    now: Date.now(),
    uptimeSec: Math.round(process.uptime()),
    connection: {
      status: connectionStatus,
      relinkInProgress,
      startWhatsAppInProgress,
      reconnectAttemptCount,
      hasQr: Boolean(lastQR),
      lastQRUpdatedAt,
      activeSocketToken
    },
    caches: {
      recentMessages: recentMessages.length,
      chatIndex: chatIndex.size,
      waContactCache: contactCache.byJid.size,
      waGroupCache: groupCache.byJid.size,
      quotedMessageCache: quotedMessageCache.size
    },
    diagnostics: diag.stats(),
    memory: {
      rss: mem.rss,
      heapTotal: mem.heapTotal,
      heapUsed: mem.heapUsed,
      external: mem.external
    }
  }
}

function listAdminDebugEvents(limit) {
  return diag.list(limit)
}

async function runAdminDebugChecks() {
  const startedAt = Date.now()
  const checks = {
    app: { ok: true, uptimeSec: Math.round(process.uptime()) },
    wa: {
      ok: connectionStatus === 'open' && Boolean(sock),
      status: connectionStatus,
      hasSocket: Boolean(sock)
    },
    storage: {
      backend: pgPool ? 'postgres' : (sqliteDb ? 'sqlite' : 'json'),
      ok: true,
      details: {}
    }
  }

  if (pgPool) {
    try {
      const r = await pgPool.query('SELECT COUNT(*)::int AS n FROM messages')
      checks.storage.details.messagesCount = Number(r.rows?.[0]?.n || 0)
    } catch (e) {
      checks.storage.ok = false
      checks.storage.details.error = e?.message || 'postgres check failed'
    }
  } else if (sqliteDb) {
    try {
      const row = sqliteDb.prepare('SELECT COUNT(*) AS n FROM messages').get()
      checks.storage.details.messagesCount = Number(row?.n || 0)
    } catch (e) {
      checks.storage.ok = false
      checks.storage.details.error = e?.message || 'sqlite check failed'
    }
  }

  const elapsedMs = Date.now() - startedAt
  const ok = checks.app.ok && checks.storage.ok
  return { ok, elapsedMs, checks }
}

registerAdminDebugRoutes({
  app,
  adminKeyMiddleware,
  buildDebugState: buildAdminDebugState,
  listDebugEvents: listAdminDebugEvents,
  runDebugChecks: runAdminDebugChecks
})

app.get('/admin/wa-groups', adminKeyMiddleware, requireConnected, async (req, res) => {
  try {
    if (!groupCache.byJid.size) await refreshGroups()
    const groups = Array.from(groupCache.byJid.values())
      .map(g => ({ jid: g.jid, subject: g.subject }))
      .sort((a, b) => String(a.subject).localeCompare(String(b.subject)))
    res.json({ ok: true, updatedAt: groupCache.updatedAt, count: groups.length, groups })
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || 'Failed to list groups' })
  }
})

function splitParticipantInputs(input) {
  const arr = Array.isArray(input) ? input : [input]
  return arr
    .flatMap(v => String(v || '').split(/[\n,;]+/g))
    .map(v => v.trim())
    .filter(Boolean)
}

async function resolveParticipantJids(rawList) {
  const out = []
  for (const entry of splitParticipantInputs(rawList)) {
    const jid = await resolveToJid(entry)
    if (isGroupJid(jid)) throw new Error(`Participant cannot be a group jid: ${entry}`)
    out.push(jid)
  }
  return [...new Set(out)]
}

app.post('/admin/groups/create', adminKeyMiddleware, requireConnected, async (req, res) => {
  try {
    const subject = String(req.body?.subject || '').trim()
    if (!subject) return res.status(400).json({ ok: false, error: 'subject required' })

    const participants = await resolveParticipantJids(req.body?.participants || [])
    const created = await sock.groupCreate(subject, participants)
    try { await refreshGroups() } catch {}

    res.json({ ok: true, group: created })
  } catch (e) {
    if (e.code === 'AMBIGUOUS_GROUP') return res.status(409).json({ ok: false, error: e.message, matches: e.matches })
    res.status(400).json({ ok: false, error: e?.message || 'Failed to create group' })
  }
})

app.get('/admin/groups/:jid/info', adminKeyMiddleware, requireConnected, async (req, res) => {
  try {
    const jid = String(req.params.jid || '').trim()
    if (!isGroupJid(jid)) return res.status(400).json({ ok: false, error: 'Invalid group jid' })
    const info = await sock.groupMetadata(jid)
    res.json({ ok: true, info })
  } catch (e) {
    res.status(400).json({ ok: false, error: e?.message || 'Failed to load group info' })
  }
})

app.post('/admin/groups/:jid/add', adminKeyMiddleware, requireConnected, async (req, res) => {
  try {
    const jid = String(req.params.jid || '').trim()
    if (!isGroupJid(jid)) return res.status(400).json({ ok: false, error: 'Invalid group jid' })
    const participants = await resolveParticipantJids(req.body?.participants || [])
    if (!participants.length) return res.status(400).json({ ok: false, error: 'participants required' })
    const result = await sock.groupParticipantsUpdate(jid, participants, 'add')
    try { await refreshGroups() } catch {}
    res.json({ ok: true, jid, action: 'add', participants, result })
  } catch (e) {
    res.status(400).json({ ok: false, error: e?.message || 'Failed to add participants' })
  }
})

app.post('/admin/groups/:jid/remove', adminKeyMiddleware, requireConnected, async (req, res) => {
  try {
    const jid = String(req.params.jid || '').trim()
    if (!isGroupJid(jid)) return res.status(400).json({ ok: false, error: 'Invalid group jid' })
    const participants = await resolveParticipantJids(req.body?.participants || [])
    if (!participants.length) return res.status(400).json({ ok: false, error: 'participants required' })
    const result = await sock.groupParticipantsUpdate(jid, participants, 'remove')
    res.json({ ok: true, jid, action: 'remove', participants, result })
  } catch (e) {
    res.status(400).json({ ok: false, error: e?.message || 'Failed to remove participants' })
  }
})

app.post('/admin/groups/:jid/promote', adminKeyMiddleware, requireConnected, async (req, res) => {
  try {
    const jid = String(req.params.jid || '').trim()
    if (!isGroupJid(jid)) return res.status(400).json({ ok: false, error: 'Invalid group jid' })
    const participants = await resolveParticipantJids(req.body?.participants || [])
    if (!participants.length) return res.status(400).json({ ok: false, error: 'participants required' })
    const result = await sock.groupParticipantsUpdate(jid, participants, 'promote')
    res.json({ ok: true, jid, action: 'promote', participants, result })
  } catch (e) {
    res.status(400).json({ ok: false, error: e?.message || 'Failed to promote participants' })
  }
})

app.post('/admin/groups/:jid/demote', adminKeyMiddleware, requireConnected, async (req, res) => {
  try {
    const jid = String(req.params.jid || '').trim()
    if (!isGroupJid(jid)) return res.status(400).json({ ok: false, error: 'Invalid group jid' })
    const participants = await resolveParticipantJids(req.body?.participants || [])
    if (!participants.length) return res.status(400).json({ ok: false, error: 'participants required' })
    const result = await sock.groupParticipantsUpdate(jid, participants, 'demote')
    res.json({ ok: true, jid, action: 'demote', participants, result })
  } catch (e) {
    res.status(400).json({ ok: false, error: e?.message || 'Failed to demote participants' })
  }
})

app.put('/admin/groups/:jid/subject', adminKeyMiddleware, requireConnected, async (req, res) => {
  try {
    const jid = String(req.params.jid || '').trim()
    const subject = String(req.body?.subject || '').trim()
    if (!isGroupJid(jid)) return res.status(400).json({ ok: false, error: 'Invalid group jid' })
    if (!subject) return res.status(400).json({ ok: false, error: 'subject required' })
    await sock.groupUpdateSubject(jid, subject)
    try { await refreshGroups() } catch {}
    res.json({ ok: true, jid, subject })
  } catch (e) {
    res.status(400).json({ ok: false, error: e?.message || 'Failed to update subject' })
  }
})

app.put('/admin/groups/:jid/description', adminKeyMiddleware, requireConnected, async (req, res) => {
  try {
    const jid = String(req.params.jid || '').trim()
    const description = String(req.body?.description || '').trim()
    if (!isGroupJid(jid)) return res.status(400).json({ ok: false, error: 'Invalid group jid' })
    await sock.groupUpdateDescription(jid, description)
    res.json({ ok: true, jid, description })
  } catch (e) {
    res.status(400).json({ ok: false, error: e?.message || 'Failed to update description' })
  }
})

app.post('/admin/groups/:jid/leave', adminKeyMiddleware, requireConnected, async (req, res) => {
  try {
    const jid = String(req.params.jid || '').trim()
    if (!isGroupJid(jid)) return res.status(400).json({ ok: false, error: 'Invalid group jid' })
    await sock.groupLeave(jid)
    try { await refreshGroups() } catch {}
    res.json({ ok: true, jid, left: true })
  } catch (e) {
    res.status(400).json({ ok: false, error: e?.message || 'Failed to leave group' })
  }
})

app.post('/admin/contacts', adminKeyMiddleware, (req, res) => {
  try {
    const { name, msisdn, jid, aliasJids = [], tags = [] } = req.body || {}
    if (!name) return res.status(400).json({ ok: false, error: 'name required' })

    const store = readContactsStore()
    const contact = normalizeContactInput({
      name: String(name).trim(),
      tags: Array.isArray(tags) ? tags : [],
      msisdn,
      jid,
      aliasJids
    })

    upsertContact(store, contact)
    const saved = writeContactsStore(store)

    res.json({ ok: true, updatedAt: saved.updatedAt, contact })
  } catch (err) {
    res.status(400).json({ ok: false, error: err?.message || 'Failed to save contact' })
  }
})

app.put('/admin/contacts/:name', adminKeyMiddleware, (req, res) => {
  try {
    const currentName = String(req.params.name || '').trim()
    if (!currentName) return res.status(400).json({ ok: false, error: 'current contact name required' })

    const store = readContactsStore()
    const result = renameOrUpdateContact(store, { name: currentName }, req.body || {})
    const saved = writeContactsStore(store)

    res.json({
      ok: true,
      updatedAt: saved.updatedAt,
      oldName: result.before?.name || currentName,
      contact: result.contact,
    })
  } catch (err) {
    if (err?.code === 'CONTACT_NOT_FOUND') return res.status(404).json({ ok: false, error: err.message })
    if (err?.code === 'CONTACT_NAME_EXISTS' || err?.code === 'CONTACT_JID_EXISTS' || err?.code === 'CONTACT_MSISDN_EXISTS') {
      return res.status(409).json({ ok: false, error: err.message })
    }
    res.status(400).json({ ok: false, error: err?.message || 'Failed to update contact' })
  }
})

app.post('/admin/contacts/merge', adminKeyMiddleware, (req, res) => {
  try {
    const targetName = String(req.body?.targetName || '').trim()
    const sourceName = String(req.body?.sourceName || '').trim()

    const store = readContactsStore()
    const result = mergeContacts(store, { targetName, sourceName })
    const saved = writeContactsStore(store)

    res.json({
      ok: true,
      updatedAt: saved.updatedAt,
      targetName: result.targetBefore?.name || targetName,
      sourceName: result.sourceBefore?.name || sourceName,
      contact: result.contact
    })
  } catch (err) {
    if (err?.code === 'CONTACT_NOT_FOUND') return res.status(404).json({ ok: false, error: err.message })
    res.status(400).json({ ok: false, error: err?.message || 'Failed to merge contacts' })
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
app.get('/admin/messages/chats', adminKeyMiddleware, async (req, res) => {
  const store = readContactsStore()
  const byChatJid = new Map()

  function mergeSummary(summary) {
    const key = normalizeJid(summary?.chatJid)
    if (!key) return
    const prev = byChatJid.get(key)
    if (!prev) {
      byChatJid.set(key, {
        chatJid: key,
        isGroup: Boolean(summary?.isGroup),
        count: Number(summary?.count || 0),
        lastTs: Number(summary?.lastTs || 0),
        lastText: summary?.lastText || '',
        lastSenderJid: summary?.lastSenderJid || ''
      })
      return
    }

    const nextLastTs = Math.max(Number(prev.lastTs || 0), Number(summary?.lastTs || 0))
    const useIncomingAsLatest = Number(summary?.lastTs || 0) >= Number(prev.lastTs || 0)
    byChatJid.set(key, {
      chatJid: key,
      isGroup: Boolean(prev.isGroup || summary?.isGroup),
      count: Number(prev.count || 0) + Number(summary?.count || 0),
      lastTs: nextLastTs,
      lastText: useIncomingAsLatest ? (summary?.lastText || '') : (prev.lastText || ''),
      lastSenderJid: useIncomingAsLatest ? (summary?.lastSenderJid || '') : (prev.lastSenderJid || '')
    })
  }

  if (pgPool || sqliteDb) {
    const { rows, error } = await loadChatSummariesFromDb({ pgPool, sqliteDb, limit: 1000, normalizeJid })
    if (error) {
      console.warn(`⚠️ Failed to load chat summaries from ${pgPool ? 'PostgreSQL' : 'SQLite'}:`, error?.message)
    } else {
      for (const row of rows) {
        const rawChatJid = normalizeJid(row?.chatJid)
        const chatJid = rawChatJid && !isGroupJid(rawChatJid) ? resolvePreferredChatJid(rawChatJid) : rawChatJid
        mergeSummary({
          chatJid,
          isGroup: Boolean(row?.isGroup),
          count: Number(row?.count || 0),
          lastTs: Number(row?.lastTs || 0),
          lastText: String(row?.lastText || ''),
          lastSenderJid: String(row?.lastSenderJid || '')
        })
      }
    }
  }

  for (const c of Array.from(chatIndex.values())) {
    const rawChatJid = normalizeJid(c.chatJid)
    const chatJid = rawChatJid && !isGroupJid(rawChatJid) ? resolvePreferredChatJid(rawChatJid) : rawChatJid
    mergeSummary({
      chatJid,
      isGroup: Boolean(c.isGroup),
      count: Number(c.count || 0),
      lastTs: Number(c.lastTs || 0),
      lastText: c.lastText || '',
      lastSenderJid: c.lastSenderJid || ''
    })
  }

  // Ensure all known WA groups appear in Messages panel, even with no history yet
  for (const g of groupCache.byJid.values()) {
    const jid = normalizeJid(g.jid)
    if (!jid) continue
    if (!byChatJid.has(jid)) {
      byChatJid.set(jid, {
        chatJid: jid,
        isGroup: true,
        count: 0,
        lastTs: 0,
        lastText: '',
        lastSenderJid: '',
      })
    }
  }

  // Also include admin-configured group aliases even if cache is stale
  for (const g of (store.groups || [])) {
    const jid = normalizeJid(g.jid)
    if (!jid || !jid.endsWith('@g.us')) continue
    if (!byChatJid.has(jid)) {
      byChatJid.set(jid, {
        chatJid: jid,
        isGroup: true,
        count: 0,
        lastTs: 0,
        lastText: '',
        lastSenderJid: '',
      })
    }
  }

  // Always include saved contacts, even if they have no message history yet
  for (const c of (store.contacts || [])) {
    const jid = resolveCanonicalChatJidFromContact(c) || normalizeJid(c.jid)
    if (!jid || jid.endsWith('@g.us')) continue
    if (!byChatJid.has(jid)) {
      byChatJid.set(jid, {
        chatJid: jid,
        isGroup: false,
        count: 0,
        lastTs: 0,
        lastText: '',
        lastSenderJid: '',
      })
    }
  }

  const list = Array.from(byChatJid.values())
    .sort((a, b) => {
      const dt = Number(b.lastTs || 0) - Number(a.lastTs || 0)
      if (dt !== 0) return dt
      return String(a.chatJid || '').localeCompare(String(b.chatJid || ''))
    })
    .slice(0, 1000)
  res.json({ ok: true, count: list.length, chats: list })
})

/**
 * Messages in a chat (poll this) — now includes outbound too
 */
app.get('/admin/messages/chat/:jid', adminKeyMiddleware, async (req, res) => {
  const chatJid = normalizeJid(req.params.jid);
  const msgCfg = getMessageStorageConfig()
  const defaultLimit = Number(msgCfg.uiFetchLimit || 500)
  const limit = Math.min(Math.max(Number(req.query.limit || defaultLimit), 1), 2000);
  const since = Number(req.query.since || 0);

  const aliases = resolveEquivalentChatJids(chatJid);
  const matchJids = aliases.size ? aliases : new Set([chatJid]);

  if (pgPool && matchJids.size) {
    try {
      const jidList = Array.from(matchJids)
      const params = [jidList, limit]
      let where = 'chat_jid = ANY($1::text[])'
      if (since > 0) {
        where += ' AND GREATEST(ts, COALESCE(status_ts, 0)) > $3'
        params.push(since)
      }

      const q = `
        SELECT id, wa_msg_id, ts, direction, chat_jid, sender_jid, is_group, type, text_content, media, status, status_ts, quoted_message_id
        FROM messages
        WHERE ${where}
        ORDER BY ts DESC
        LIMIT $2
      `
      const out = await pgPool.query(q, params)
      let msgs = (out.rows || []).map(rowToMessage).filter(Boolean).reverse()
      msgs = msgs.map(refreshMediaForClient)
      const latest = msgs.length
        ? Math.max(msgs[msgs.length - 1].ts || 0, msgs[msgs.length - 1].statusTs || 0)
        : since

      return res.json({ ok: true, chatJid, count: msgs.length, latestTs: latest, messages: msgs })
    } catch (e) {
      console.warn('⚠️ Failed to fetch chat messages from PostgreSQL:', e?.message)
    }
  }

  if (sqliteDb && matchJids.size) {
    try {
      const jidList = Array.from(matchJids)
      const jidPlaceholders = jidList.map(() => '?').join(', ')
      const whereParts = [`chat_jid IN (${jidPlaceholders})`]
      const params = [...jidList]
      if (since > 0) {
        whereParts.push('MAX(ts, COALESCE(status_ts, 0)) > ?')
        params.push(since)
      }
      params.push(limit)

      const q = `
        SELECT id, wa_msg_id, ts, direction, chat_jid, sender_jid, is_group, type, text_content, media, status, status_ts, quoted_message_id
        FROM messages
        WHERE ${whereParts.join(' AND ')}
        ORDER BY ts DESC
        LIMIT ?
      `
      const outRows = sqliteDb.prepare(q).all(...params)
      let msgs = (outRows || []).map(rowToMessage).filter(Boolean).reverse()
      msgs = msgs.map(refreshMediaForClient)
      const latest = msgs.length
        ? Math.max(msgs[msgs.length - 1].ts || 0, msgs[msgs.length - 1].statusTs || 0)
        : since

      return res.json({ ok: true, chatJid, count: msgs.length, latestTs: latest, messages: msgs })
    } catch (e) {
      console.warn('⚠️ Failed to fetch chat messages from SQLite:', e?.message)
    }
  }

  let msgs = recentMessages.filter(m => matchJids.has(normalizeJid(m.chatJid)));

  if (since) {
    msgs = msgs.filter(m => Math.max(m.ts || 0, m.statusTs || 0) > since); // ✅
  }

  msgs = msgs.slice(-limit);
  msgs = msgs.map(refreshMediaForClient)

  const latest = msgs.length
    ? Math.max(msgs[msgs.length - 1].ts || 0, msgs[msgs.length - 1].statusTs || 0)
    : since;

  res.json({ ok: true, chatJid, count: msgs.length, latestTs: latest, messages: msgs });
});

app.post('/admin/messages/:id/delete', adminKeyMiddleware, requireConnected, async (req, res) => {
  try {
    const rawId = String(req.params.id || '').trim()
    if (!rawId) return res.status(400).json({ ok: false, error: 'Message id required' })

    const deleteForAll = req.body?.deleteForAll !== false
    const found = await findMessageByAnyId(rawId)
    if (!found) return res.status(404).json({ ok: false, error: 'Message not found' })

    const direction = String(found.direction || '').toLowerCase()
    if (direction !== 'out') {
      return res.status(400).json({ ok: false, error: 'Only outbound messages can be revoked' })
    }

    const chatJid = normalizeJid(found.chatJid || req.body?.chatJid || '')
    if (!chatJid) return res.status(400).json({ ok: false, error: 'Missing chat JID for message' })

    const waMsgId = String(found.waMsgId || '').trim()
    const alreadyDeleted = String(found.status || '').toLowerCase() === 'deleted'

    if (deleteForAll && !alreadyDeleted) {
      if (!waMsgId) {
        return res.status(409).json({ ok: false, error: 'Message is not yet linked to a WhatsApp id (still queued or failed)' })
      }

      const key = {
        remoteJid: chatJid,
        fromMe: true,
        id: waMsgId
      }
      await sock.sendMessage(chatJid, { delete: key })
    }

    let updated = updateMessageStatus(rawId, { status: 'deleted' })
    if (!updated && waMsgId) updated = updateMessageStatusByWaMsgId(waMsgId, { status: 'deleted' })

    if (!updated) {
      const patch = { status: 'deleted', statusTs: Date.now() }
      if (found.id) patchMessageInDbById(found.id, patch)
      else if (waMsgId) patchMessageInDbByWaMsgId(waMsgId, patch)
      updated = { ...found, ...patch }
    }

    upsertRecentMessage(updated)

    res.json({
      ok: true,
      id: updated.id || found.id || rawId,
      waMsgId: updated.waMsgId || waMsgId || null,
      chatJid,
      status: updated.status || 'deleted',
      deletedForAll: Boolean(deleteForAll),
      alreadyDeleted
    })
  } catch (e) {
    res.status(400).json({ ok: false, error: e?.message || 'Failed to delete message' })
  }
})

app.get('/admin/messages/stream', requireAdminSessionAny, (req, res) => {
  const chatJid = normalizeJid(req.query?.chatJid || '')
  const aliases = chatJid ? resolveEquivalentChatJids(chatJid) : new Set()

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders?.()

  const client = { res, chatJid, aliases }
  adminMessageSseClients.add(client)

  sseSend(res, 'hello', { ok: true, chatJid: chatJid || null, ts: Date.now() })

  if (chatJid) {
    const rows = recentMessages
      .filter(m => (aliases.size ? aliases.has(normalizeJid(m.chatJid)) : normalizeJid(m.chatJid) === chatJid))
      .slice(-80)
      .map(refreshMediaForClient)
    sseSend(res, 'batch', { chatJid, count: rows.length, messages: rows, ts: Date.now() })
  }

  const ping = setInterval(() => {
    try { sseSend(res, 'ping', { ts: Date.now() }) } catch {}
  }, 15000)

  req.on('close', () => {
    clearInterval(ping)
    adminMessageSseClients.delete(client)
  })
})

app.get('/admin/messages/search', adminKeyMiddleware, async (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase()
  const chatJid = String(req.query.chatJid || '').trim()
  const direction = String(req.query.direction || '').trim()
  const type = String(req.query.type || '').trim()
  const offset = Math.max(0, Number(req.query.offset || 0))
  const limit = Math.min(Math.max(Number(req.query.limit || 100), 1), 1000)

  if (pgPool) {
    try {
      const clauses = []
      const values = []
      let i = 1

      if (chatJid) { clauses.push(`chat_jid = $${i++}`); values.push(chatJid) }
      if (direction) { clauses.push(`direction = $${i++}`); values.push(direction) }
      if (type) { clauses.push(`type = $${i++}`); values.push(type) }
      if (q) {
        clauses.push(`(
          LOWER(COALESCE(text_content,'')) LIKE $${i}
          OR LOWER(COALESCE(sender_jid,'')) LIKE $${i}
          OR LOWER(COALESCE(chat_jid,'')) LIKE $${i}
        )`)
        values.push(`%${q}%`)
        i += 1
      }

      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
      const totalQ = `SELECT COUNT(*)::int AS n FROM messages ${where}`
      const rowsQ = `
        SELECT id, wa_msg_id, ts, direction, chat_jid, sender_jid, is_group, type, text_content, media, status, status_ts, quoted_message_id
        FROM messages
        ${where}
        ORDER BY ts DESC
        OFFSET $${i} LIMIT $${i + 1}
      `
      const totalOut = await pgPool.query(totalQ, values)
      const rowsOut = await pgPool.query(rowsQ, [...values, offset, limit])
      const total = Number(totalOut.rows?.[0]?.n || 0)
      const items = (rowsOut.rows || []).map(rowToMessage).filter(Boolean)
      return res.json({ ok: true, total, offset, limit, count: items.length, items })
    } catch (e) {
      console.warn('⚠️ Failed to search messages in PostgreSQL:', e?.message)
    }
  }

  if (sqliteDb) {
    try {
      const clauses = []
      const values = []

      if (chatJid) { clauses.push('chat_jid = ?'); values.push(chatJid) }
      if (direction) { clauses.push('direction = ?'); values.push(direction) }
      if (type) { clauses.push('type = ?'); values.push(type) }
      if (q) {
        clauses.push(`(
          LOWER(COALESCE(text_content,'')) LIKE ?
          OR LOWER(COALESCE(sender_jid,'')) LIKE ?
          OR LOWER(COALESCE(chat_jid,'')) LIKE ?
        )`)
        const like = `%${q}%`
        values.push(like, like, like)
      }

      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
      const totalQ = `SELECT COUNT(*) AS n FROM messages ${where}`
      const rowsQ = `
        SELECT id, wa_msg_id, ts, direction, chat_jid, sender_jid, is_group, type, text_content, media, status, status_ts, quoted_message_id
        FROM messages
        ${where}
        ORDER BY ts DESC
        LIMIT ? OFFSET ?
      `

      const totalOut = sqliteDb.prepare(totalQ).get(...values)
      const rowsOut = sqliteDb.prepare(rowsQ).all(...values, limit, offset)
      const total = Number(totalOut?.n || 0)
      const items = (rowsOut || []).map(rowToMessage).filter(Boolean)
      return res.json({ ok: true, total, offset, limit, count: items.length, items })
    } catch (e) {
      console.warn('⚠️ Failed to search messages in SQLite:', e?.message)
    }
  }

  let rows = readMessagesStore().messages || []
  if (chatJid) rows = rows.filter(m => String(m.chatJid || '') === chatJid)
  if (direction) rows = rows.filter(m => String(m.direction || '') === direction)
  if (type) rows = rows.filter(m => String(m.type || '') === type)
  if (q) {
    rows = rows.filter(m => {
      const text = String(m.text || '').toLowerCase()
      const sender = String(m.senderJid || '').toLowerCase()
      const chat = String(m.chatJid || '').toLowerCase()
      return text.includes(q) || sender.includes(q) || chat.includes(q)
    })
  }

  rows = rows.sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0))
  const total = rows.length
  const items = rows.slice(offset, offset + limit)

  res.json({ ok: true, total, offset, limit, count: items.length, items })
})

// ── List boards (optionally filter by chatJid) ──────────────────────────────
app.get('/admin/notice-board/list', adminKeyMiddleware, (req, res) => {
  const chatJid = normalizeJid(req.query?.chatJid || '')
  const list = chatJid ? boards.filter(b => b.chatJid === chatJid) : boards
  res.json({ ok: true, boards: list })
})

// ── Create a permanent notice board ─────────────────────────────────────────
app.post('/admin/notice-board/create', adminKeyMiddleware, (req, res) => {
  try {
    const chatJid = normalizeJid(req.body?.chatJid || req.body?.jid || '')
    if (!chatJid) return res.status(400).json({ ok: false, error: 'chatJid is required' })

    const name = String(req.body?.name || '').trim() || 'Notice Board'
    const showDir = ['in', 'out', 'both'].includes(req.body?.showDir) ? req.body.showDir : 'both'
    const displayTitle = String(req.body?.displayTitle || name).trim()
    const size = normalizeBoardSize(req.body?.size || 'm')
    const density = normalizeBoardDensity(req.body?.density || 'normal')

    // Build a unique slug
    let baseSlug = String(req.body?.slug || '').trim() || generateSlug(name)
    baseSlug = baseSlug.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'board'
    let slug = baseSlug
    let counter = 2
    while (boards.some(b => b.slug === slug)) slug = `${baseSlug}-${counter++}`

    const url = buildBoardUrl(slug, req, size, density)

    const board = { slug, name, displayTitle, chatJid, enabled: true, showDir, size, density, createdAt: Date.now(), url }
    boards.push(board)
    saveBoards()
    res.json({ ok: true, board })
  } catch (err) {
    res.status(400).json({ ok: false, error: err?.message || 'Failed to create board' })
  }
})

// ── Update a board (enabled, name, showDir, displayTitle) ───────────────────
app.put('/admin/notice-board/:slug', adminKeyMiddleware, (req, res) => {
  const slug = String(req.params.slug || '').trim()
  const idx = boards.findIndex(b => b.slug === slug)
  if (idx < 0) return res.status(404).json({ ok: false, error: 'Board not found' })

  for (const key of ['enabled', 'name', 'displayTitle', 'showDir']) {
    if (req.body?.[key] !== undefined) boards[idx][key] = req.body[key]
  }
  if (req.body?.size !== undefined) boards[idx].size = normalizeBoardSize(req.body.size)
  if (req.body?.density !== undefined) boards[idx].density = normalizeBoardDensity(req.body.density)
  boards[idx].url = buildBoardUrl(boards[idx].slug, req, boards[idx].size || 'm', boards[idx].density || 'normal')
  saveBoards()
  res.json({ ok: true, board: boards[idx] })
})

// ── Delete a board ───────────────────────────────────────────────────────────
app.delete('/admin/notice-board/:slug', adminKeyMiddleware, (req, res) => {
  const slug = String(req.params.slug || '').trim()
  const idx = boards.findIndex(b => b.slug === slug)
  if (idx < 0) return res.status(404).json({ ok: false, error: 'Board not found' })
  boards.splice(idx, 1)
  saveBoards()
  res.json({ ok: true, slug })
})

// ── Public board page (no auth, slug-based, permanent) ──────────────────────
app.get('/board/:slug', (req, res) => {
  const slug = String(req.params.slug || '').trim()
  const board = boards.find(b => b.slug === slug)
  if (!board) return res.status(404).send('Notice board not found')
  if (!board.enabled) return res.status(403).send('This notice board is currently disabled')
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.send(noticeBoardPageHtml(slug, board))
})

// ── Public board SSE stream ──────────────────────────────────────────────────
app.get('/board/:slug/stream', (req, res) => {
  const slug = String(req.params.slug || '').trim()
  const board = boards.find(b => b.slug === slug)
  if (!board) return res.status(404).json({ ok: false, error: 'Board not found' })
  if (!board.enabled) return res.status(403).json({ ok: false, error: 'Board is disabled' })

  const chatJid = board.chatJid
  const showDir = board.showDir || 'both'
  let since = Number(req.query.since || 0)

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders?.()

  function sendBatch(initial = false) {
    const enrichForBoard = (m) => {
      const enriched = refreshMediaForClient(m)
      if (enriched && enriched.direction === 'in' && enriched.senderJid) {
        const jid = normalizeJid(enriched.senderJid)
        const name = String(contactCache.byJid.get(jid)?.name || '').trim()
        if (name) return { ...enriched, senderName: name }
      }
      return enriched
    }
    let rows = recentMessages
      .filter(m => m.chatJid === chatJid)
      .filter(m => showDir === 'both' || m.direction === showDir)
      .sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0))
      .map(enrichForBoard)

    if (since > 0) {
      rows = rows.filter(m => Math.max(Number(m.ts || 0), Number(m.statusTs || 0)) > since)
    } else if (initial) {
      rows = rows.slice(-120)
    }

    if (rows.length) {
      const latest = Math.max(...rows.map(m => Math.max(Number(m.ts || 0), Number(m.statusTs || 0))))
      since = latest
      res.write(`event: batch\ndata: ${JSON.stringify({ chatJid, latestTs: latest, messages: rows })}\n\n`)
      return
    }

    res.write(`event: ping\ndata: ${JSON.stringify({ chatJid, ts: Date.now() })}\n\n`)
  }

  sendBatch(true)
  const timer = setInterval(() => sendBatch(false), 3000)
  req.on('close', () => clearInterval(timer))
})


/**
 * Admin send helpers
 * - UPDATED: store outbound in persistent store + memory
 */
app.post('/admin/send/text', adminKeyMiddleware, requireConnected, async (req, res) => {
  const idem = beginIdempotentRequest(readIdempotencyKey(req))
  if (idem.duplicate) {
    if (idem.pending) {
      return res.status(409).json({ ok: false, error: 'Duplicate request in progress', idempotencyKey: idem.key })
    }
    return res.json({ ...(idem.response || { ok: true, duplicate: true }), duplicate: true, idempotencyKey: idem.key })
  }

  try {
    const { to, message } = req.body || {}
    if (!to || !message) return res.status(400).json({ ok: false, error: 'Missing to/message' })
    const jid = await resolveToJid(to)
    const quotedMessageId = req.body?.quotedMessageId ? String(req.body.quotedMessageId).trim() : ''

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
      status: 'queued',
      quotedMessageId: quotedMessageId || null
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
        media: saved.media || null,
        quotedMessageId: saved.quotedMessageId || null
        })


    const jobId = await enqueue({
    id: makeId('job_admin_txt'),
    jid,
    payload,
    createdAt: Date.now(),
    msgId,
    chatJid: jid,
    quotedMessageId: quotedMessageId || null
    })
    const responsePayload = { ok: true, to, jid, queued: true, jobId, msgId, quotedMessageId: quotedMessageId || null }
    completeIdempotentRequest(idem.key, responsePayload)
    res.json(responsePayload)
  } catch (err) {
    failIdempotentRequest(idem.key)
    if (err.code === 'AMBIGUOUS_GROUP') return res.status(409).json({ ok: false, error: err.message, matches: err.matches })
    res.status(400).json({ ok: false, error: err?.message || 'Failed to queue text' })
  }
})

app.post('/admin/send/image', adminKeyMiddleware, requireConnected, upload.single('image'), async (req, res) => {
  const idem = beginIdempotentRequest(readIdempotencyKey(req))
  if (idem.duplicate) {
    if (idem.pending) {
      return res.status(409).json({ ok: false, error: 'Duplicate request in progress', idempotencyKey: idem.key })
    }
    return res.json({ ...(idem.response || { ok: true, duplicate: true }), duplicate: true, idempotencyKey: idem.key })
  }

  try {
    const to = req.body?.to
    const caption = req.body?.caption || ''
    if (!to) return res.status(400).json({ ok: false, error: 'Missing to' })
    const jid = await resolveToJid(to)
    const quotedMessageId = req.body?.quotedMessageId ? String(req.body.quotedMessageId).trim() : ''

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
      status: 'queued',
      quotedMessageId: quotedMessageId || null
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
        media: saved.media || null,
        quotedMessageId: saved.quotedMessageId || null
        })


    const jobId = await enqueue({
    id: makeId('job_admin_img'),
    jid,
    payload,
    createdAt: Date.now(),
    msgId,
    chatJid: jid,
    quotedMessageId: quotedMessageId || null
    })
    const responsePayload = { ok: true, to, jid, queued: true, jobId, msgId, quotedMessageId: quotedMessageId || null }
    completeIdempotentRequest(idem.key, responsePayload)
    return res.json(responsePayload)
  } catch (err) {
    failIdempotentRequest(idem.key)
    if (err.code === 'AMBIGUOUS_GROUP') return res.status(409).json({ ok: false, error: err.message, matches: err.matches })
    res.status(400).json({ ok: false, error: err?.message || 'Failed to queue image' })
  }
})

app.post('/admin/send/document', adminKeyMiddleware, requireConnected, upload.single('document'), async (req, res) => {
  const idem = beginIdempotentRequest(readIdempotencyKey(req))
  if (idem.duplicate) {
    if (idem.pending) {
      return res.status(409).json({ ok: false, error: 'Duplicate request in progress', idempotencyKey: idem.key })
    }
    return res.json({ ...(idem.response || { ok: true, duplicate: true }), duplicate: true, idempotencyKey: idem.key })
  }

  try {
    const to = req.body?.to
    if (!to) return res.status(400).json({ ok: false, error: 'Missing to' })
    const jid = await resolveToJid(to)
    const quotedMessageId = req.body?.quotedMessageId ? String(req.body.quotedMessageId).trim() : ''

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
      status: 'queued',
      quotedMessageId: quotedMessageId || null
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
        media: saved.media || null,
        quotedMessageId: saved.quotedMessageId || null
        })


    const jobId = await enqueue({
    id: makeId('job_admin_doc'),
    jid,
    payload,
    createdAt: Date.now(),
    msgId,
    chatJid: jid,
    quotedMessageId: quotedMessageId || null
    })
    const responsePayload = { ok: true, to, jid, queued: true, jobId, msgId, quotedMessageId: quotedMessageId || null }
    completeIdempotentRequest(idem.key, responsePayload)
    return res.json(responsePayload)
  } catch (err) {
    failIdempotentRequest(idem.key)
    if (err.code === 'AMBIGUOUS_GROUP') return res.status(409).json({ ok: false, error: err.message, matches: err.matches })
    res.status(400).json({ ok: false, error: err?.message || 'Failed to queue document' })
  }
})

/**
 * Admin UI (dynamic messages + send panel) — Black/Yellow/Purple theme + Multi-send
 */
app.get('/admin/ui', (req, res) => {
  if (!hasValidAdminSession(req)) return res.redirect(withBase(req, '/admin/login'))
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
  res.setHeader('Pragma', 'no-cache')
  res.setHeader('Expires', '0')
  res.sendFile(path.join(UI_DIR, 'admin', 'admin-v2.html'))
})

app.get('/admin/ui-legacy', (req, res) => {
  if (!hasValidAdminSession(req)) return res.redirect(withBase(req, '/admin/login'))
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.sendFile(path.join(UI_DIR, 'admin', 'admin.html'))
})


/** * ----------------------------
 * Media cleanup
 * ----------------------------
 */
const MEDIA_CLEANUP_EVERY_HOURS = Number(process.env.MEDIA_CLEANUP_EVERY_HOURS || 12);

function cleanupOldUploads() {
  const retentionDays = Math.max(1, Number(getMediaConfig().retentionDays || 7))
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

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

    if (removed) console.log(`🧹 Media cleanup: removed ${removed} old file(s) (retention ${retentionDays} day(s))`);
  } catch (e) {
    console.warn('⚠️ Media cleanup failed:', e?.message);
  }
}

setInterval(cleanupOldUploads, MEDIA_CLEANUP_EVERY_HOURS * 60 * 60 * 1000);
cleanupOldUploads();

const groupCacheSyncTimer = setInterval(() => {
  if (!sock || connectionStatus !== 'open') return
  scheduleGroupRefresh('interval', { delayMs: 0 })
}, GROUP_CACHE_SYNC_INTERVAL_MS)

const scheduleTimer = setInterval(() => {
  processDueSchedules().catch(() => {})
}, Math.max(1000, SCHEDULE_POLL_MS))

async function shutdown() {
  try { clearInterval(groupCacheSyncTimer) } catch {}
  try { clearInterval(scheduleTimer) } catch {}
  try { await worker?.close() } catch {}
  try { await sendQueue?.close() } catch {}
  try { await queueEvents?.close() } catch {}
  try { await queueEventsConn?.quit() } catch {}
  try { await redis?.quit() } catch {}
  try { await pgPool?.end?.() } catch {}
  try { sqliteDb?.close?.() } catch {}
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

// ----------------------------
// Hydrate all KV stores from DB at startup (DB is authoritative)
// ----------------------------
async function hydrateStoresFromDb() {
  const ensureKv = async (key, defaultFn) => {
    const existing = await readKvFromDb(key, null)
    if (existing !== null) return existing
    const seeded = defaultFn ? defaultFn() : null
    if (seeded !== null) await writeKvToDb(key, seeded).catch(() => {})
    return seeded
  }

  // --- Contacts ---
  const contactsData = await ensureKv('contacts', () => ({ contacts: [], groups: [], updatedAt: Date.now() }))
  if (contactsData) {
    contactsStoreCache = {
      contacts: Array.isArray(contactsData?.contacts) ? contactsData.contacts : [],
      groups: Array.isArray(contactsData?.groups) ? contactsData.groups : [],
      updatedAt: Number(contactsData?.updatedAt || Date.now())
    }
    contactsStoreNeedsNormalize = true
  }

  // --- Automations ---
  const automationsData = await ensureKv('automations', defaultAutomationsConfig)
  if (automationsData) {
    automations = mergeDeep(defaultAutomationsConfig(), automationsData)
  }

  // --- Rules ---
  const rulesData = await ensureKv('rules', defaultRulesConfig)
  if (rulesData) {
    responseRules = rulesData
  }

  // --- Templates ---
  const templatesData = await ensureKv('templates', defaultTemplatesConfig)
  if (templatesData) {
    templatesStoreCache = mergeDeep(defaultTemplatesConfig(), templatesData)
  }

  // --- Schedules ---
  const schedulesData = await ensureKv('schedules', defaultSchedulesConfig)
  if (schedulesData) {
    schedulesStoreCache = {
      ...defaultSchedulesConfig(),
      ...(schedulesData || {}),
      jobs: Array.isArray(schedulesData?.jobs) ? schedulesData.jobs : []
    }
  }

  // --- N8n Dead Letters ---
  const deadLettersData = await ensureKv('n8n_dead_letters', defaultN8nDeadLettersConfig)
  if (deadLettersData) {
    deadLettersStoreCache = {
      ...defaultN8nDeadLettersConfig(),
      ...(deadLettersData || {}),
      items: Array.isArray(deadLettersData?.items) ? deadLettersData.items : []
    }
  }

  // --- Boards ---
  const boardsData = await ensureKv('boards', () => [])
  if (boardsData) {
    boards = Array.isArray(boardsData) ? boardsData : []
  }

  // --- Admin Audit ---
  const auditData = await ensureKv('admin_audit', () => ({ items: [], updatedAt: Date.now() }))
  if (auditData) {
    adminAuditStoreCache = {
      items: Array.isArray(auditData?.items) ? auditData.items : [],
      updatedAt: Number(auditData?.updatedAt || Date.now())
    }
  }

  console.log('📦 All KV stores hydrated from DB')
}

/**
 * ----------------------------
 * Start
 * ----------------------------
 */
app.listen(PORT, async () => {
  console.log(`✅ API listening on http://0.0.0.0:${PORT}`)
  if (!REQUIRE_API_KEY) console.log('⚠️ WARNING: WA_API_KEY not set. Set it in .env before VPS.')
  if (!REQUIRE_ADMIN_KEY) console.log('⚠️ WARNING: Admin keys not set (WA_ADMIN_KEY / WA_OPERATOR_KEY / WA_VIEWER_KEY). Admin UI/API will not work.')

  await initDatabaseStorage()
  runtimeSettings = (await readRuntimeSettingsFromDb()) || readRuntimeSettingsStore()
  rebuildRateLimiter()
  await hydrateStoresFromDb()
  responseRules = readRulesStore()
  await hydrateInMemoryFromStore()
  loadBoards()

  processDueSchedules().catch(() => {})

  const autoClearAuthOnBoot = String(process.env.WA_AUTO_CLEAR_AUTH_ON_BOOT || '0').trim() === '1'
  if (autoClearAuthOnBoot) {
    await clearAuthStorage().catch(() => {})
    console.log('🧹 Auto-cleared auth on boot (WA_AUTO_CLEAR_AUTH_ON_BOOT=1)')
  }

  await startWhatsApp()
})
