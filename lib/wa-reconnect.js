export function parseDisconnectDetails(lastDisconnect) {
  const statusCode =
    lastDisconnect?.error?.output?.statusCode ||
    lastDisconnect?.error?.statusCode ||
    lastDisconnect?.error?.data?.statusCode ||
    null

  const reason =
    lastDisconnect?.error?.message ||
    lastDisconnect?.error?.output?.payload?.message ||
    'unknown'

  const data = lastDisconnect?.error?.data ? JSON.stringify(lastDisconnect.error.data) : ''

  return { statusCode, reason, data }
}

export function computeReconnectDelayMs(statusCode, reconnectAttemptCount, options = {}) {
  const base408 = Number(options.base408 || 10000)
  const baseDefault = Number(options.baseDefault || 3000)
  const maxDelay = Number(options.maxDelay || 60000)

  const baseDelay = Number(statusCode) === 408 ? base408 : baseDefault
  const expBackoff = baseDelay * Math.pow(2, Math.max(0, Number(reconnectAttemptCount || 1) - 1))
  return Math.min(expBackoff, maxDelay)
}

export function computeStatus405DelayMs(reconnectAttemptCount, options = {}) {
  const base = Number(options.base || 15000)
  const maxDelay = Number(options.maxDelay || 120000)
  const expBackoff = base * Math.pow(2, Math.max(0, Number(reconnectAttemptCount || 1) - 1))
  return Math.min(expBackoff, maxDelay)
}
