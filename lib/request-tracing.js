import crypto from 'crypto'

export function createRequestTracingMiddleware(options = {}) {
  const {
    headerName = 'x-request-id',
    slowMs = 800,
    includePaths = ['/admin', '/pairing'],
    onEvent = null
  } = options

  const safeSlowMs = Math.max(50, Number(slowMs || 800))

  return function requestTracingMiddleware(req, res, next) {
    const path = String(req.path || req.originalUrl || '')
    const shouldTrace = includePaths.some((p) => path.startsWith(p))
    if (!shouldTrace) return next()

    const reqId = String(req.headers[headerName] || '').trim() || crypto.randomUUID()
    req.requestId = reqId
    res.setHeader(headerName, reqId)

    const startedAt = Date.now()
    const method = String(req.method || 'GET').toUpperCase()

    res.on('finish', () => {
      const durationMs = Date.now() - startedAt
      const statusCode = Number(res.statusCode || 0)
      const level = statusCode >= 500 ? 'error' : (statusCode >= 400 ? 'warn' : 'info')
      const event = durationMs >= safeSlowMs ? 'http.slow' : 'http.request'
      const message = durationMs >= safeSlowMs
        ? `🐢 ${method} ${path} ${statusCode} in ${durationMs}ms`
        : `🌐 ${method} ${path} ${statusCode} in ${durationMs}ms`

      if (typeof onEvent === 'function') {
        onEvent(level, event, message, {
          requestId: reqId,
          method,
          path,
          statusCode,
          durationMs,
          ip: req.ip || req.socket?.remoteAddress || ''
        })
      }
    })

    next()
  }
}
