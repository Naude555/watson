export function registerAdminMiddlewares(options = {}) {
  const {
    app,
    clientIp,
    isIpAllowed,
    isAdminMutatingMethod,
    resolveAdminAuthContext,
    parseCookies,
    adminCsrfCookieName,
    requiredRoleForAdminRequest,
    roleSatisfies,
    appendAdminAuditLog
  } = options

  if (!app) throw new Error('registerAdminMiddlewares: app is required')
  if (typeof clientIp !== 'function') throw new Error('registerAdminMiddlewares: clientIp is required')
  if (typeof isIpAllowed !== 'function') throw new Error('registerAdminMiddlewares: isIpAllowed is required')
  if (typeof isAdminMutatingMethod !== 'function') throw new Error('registerAdminMiddlewares: isAdminMutatingMethod is required')
  if (typeof resolveAdminAuthContext !== 'function') throw new Error('registerAdminMiddlewares: resolveAdminAuthContext is required')
  if (typeof parseCookies !== 'function') throw new Error('registerAdminMiddlewares: parseCookies is required')
  if (!adminCsrfCookieName) throw new Error('registerAdminMiddlewares: adminCsrfCookieName is required')
  if (typeof requiredRoleForAdminRequest !== 'function') throw new Error('registerAdminMiddlewares: requiredRoleForAdminRequest is required')
  if (typeof roleSatisfies !== 'function') throw new Error('registerAdminMiddlewares: roleSatisfies is required')
  if (typeof appendAdminAuditLog !== 'function') throw new Error('registerAdminMiddlewares: appendAdminAuditLog is required')

  app.use('/admin', (req, res, next) => {
    const ip = clientIp(req)
    if (!isIpAllowed(ip)) {
      return res.status(403).json({ ok: false, error: 'Forbidden by admin IP allowlist' })
    }
    next()
  })

  app.use('/admin', (req, res, next) => {
    if (!isAdminMutatingMethod(req)) return next()
    if (String(req.path || '') === '/login') return next()

    const ctx = resolveAdminAuthContext(req)
    if (ctx.mode === 'api-key') return next()
    if (!ctx.authorized) return res.status(401).json({ ok: false, error: 'Unauthorized' })

    const cookies = parseCookies(req)
    const cookieToken = String(cookies[adminCsrfCookieName] || '').trim()
    const headerToken = String(req.headers['x-csrf-token'] || '').trim()
    if (!cookieToken || !headerToken || cookieToken !== headerToken) {
      return res.status(403).json({ ok: false, error: 'CSRF token invalid or missing' })
    }
    next()
  })

  app.use('/admin', (req, res, next) => {
    if (String(req.path || '') === '/login') return next()

    const ctx = resolveAdminAuthContext(req)
    const acceptsHtml = String(req.headers.accept || '').includes('text/html')
    if (!ctx.authorized) {
      if (acceptsHtml) return res.redirect('/admin/login')
      return res.status(401).json({ ok: false, error: 'Unauthorized' })
    }

    const requiredRole = requiredRoleForAdminRequest(req)
    if (!roleSatisfies(ctx.role, requiredRole)) {
      return res.status(403).json({ ok: false, error: `Forbidden: requires ${requiredRole} role`, requiredRole, currentRole: ctx.role })
    }

    req.adminRole = ctx.role
    req.adminAuthMode = ctx.mode
    next()
  })

  app.use('/admin', (req, res, next) => {
    if (!isAdminMutatingMethod(req)) return next()

    const startedAt = Date.now()
    const ip = clientIp(req)
    const ctx = resolveAdminAuthContext(req)
    const authMode = ctx.mode || 'unknown'
    const actor = ctx.authorized ? `${ctx.role}-${authMode}` : 'anonymous'

    res.on('finish', () => {
      appendAdminAuditLog({
        action: 'admin_request',
        method: req.method,
        path: req.originalUrl || req.url,
        statusCode: res.statusCode,
        ok: res.statusCode >= 200 && res.statusCode < 400,
        actor,
        authMode,
        ip,
        userAgent: req.get('user-agent') || '',
        durationMs: Date.now() - startedAt
      })
    })

    next()
  })
}
