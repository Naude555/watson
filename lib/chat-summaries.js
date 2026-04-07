export async function loadChatSummariesFromDb({ pgPool, sqliteDb, limit = 1000, normalizeJid }) {
  const safeLimit = Math.max(50, Number(limit || 1000))

  if (pgPool) {
    try {
      const out = await pgPool.query(
        `SELECT
           s.chat_jid,
           s.is_group,
           s.count,
           s.last_ts,
           COALESCE((
             SELECT m2.text_content
             FROM messages m2
             WHERE m2.chat_jid = s.chat_jid
             ORDER BY m2.ts DESC
             LIMIT 1
           ), '') AS last_text,
           COALESCE((
             SELECT m2.sender_jid
             FROM messages m2
             WHERE m2.chat_jid = s.chat_jid
             ORDER BY m2.ts DESC
             LIMIT 1
           ), '') AS last_sender_jid
         FROM (
           SELECT
             chat_jid,
             MAX(CASE WHEN is_group THEN 1 ELSE 0 END) AS is_group,
             COUNT(*) AS count,
             MAX(ts) AS last_ts
           FROM messages
           GROUP BY chat_jid
           ORDER BY MAX(ts) DESC
           LIMIT $1
         ) s
         ORDER BY s.last_ts DESC`,
        [safeLimit]
      )

      const rows = (out.rows || []).map((row) => ({
        chatJid: normalizeJid(row?.chat_jid),
        isGroup: Number(row?.is_group || 0) > 0,
        count: Number(row?.count || 0),
        lastTs: Number(row?.last_ts || 0),
        lastText: String(row?.last_text || ''),
        lastSenderJid: String(row?.last_sender_jid || '')
      })).filter(r => r.chatJid)
      return { rows, error: null }
    } catch (e) {
      return { rows: [], error: e }
    }
  }

  if (sqliteDb) {
    try {
      const rows = sqliteDb.prepare(
        `SELECT
           s.chat_jid,
           s.is_group,
           s.count,
           s.last_ts,
           COALESCE((
             SELECT m2.text_content
             FROM messages m2
             WHERE m2.chat_jid = s.chat_jid
             ORDER BY m2.ts DESC
             LIMIT 1
           ), '') AS last_text,
           COALESCE((
             SELECT m2.sender_jid
             FROM messages m2
             WHERE m2.chat_jid = s.chat_jid
             ORDER BY m2.ts DESC
             LIMIT 1
           ), '') AS last_sender_jid
         FROM (
           SELECT
             chat_jid,
             MAX(CASE WHEN is_group THEN 1 ELSE 0 END) AS is_group,
             COUNT(*) AS count,
             MAX(ts) AS last_ts
           FROM messages
           GROUP BY chat_jid
           ORDER BY MAX(ts) DESC
           LIMIT ?
         ) s
         ORDER BY s.last_ts DESC`
      ).all(safeLimit)

      const mapped = (rows || []).map((row) => ({
        chatJid: normalizeJid(row?.chat_jid),
        isGroup: Number(row?.is_group || 0) > 0,
        count: Number(row?.count || 0),
        lastTs: Number(row?.last_ts || 0),
        lastText: String(row?.last_text || ''),
        lastSenderJid: String(row?.last_sender_jid || '')
      })).filter(r => r.chatJid)
      return { rows: mapped, error: null }
    } catch (e) {
      return { rows: [], error: e }
    }
  }

  return { rows: [], error: null }
}
