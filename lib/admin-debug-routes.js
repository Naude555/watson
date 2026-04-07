export function registerAdminDebugRoutes({ app, adminKeyMiddleware, buildDebugState, listDebugEvents, runDebugChecks }) {
  if (!app) throw new Error('registerAdminDebugRoutes: app is required')
  if (typeof adminKeyMiddleware !== 'function') throw new Error('registerAdminDebugRoutes: adminKeyMiddleware is required')
  if (typeof buildDebugState !== 'function') throw new Error('registerAdminDebugRoutes: buildDebugState is required')
  if (typeof listDebugEvents !== 'function') throw new Error('registerAdminDebugRoutes: listDebugEvents is required')
  if (typeof runDebugChecks !== 'function') throw new Error('registerAdminDebugRoutes: runDebugChecks is required')

  app.get('/admin/debug/state', adminKeyMiddleware, (req, res) => {
    try {
      return res.json(buildDebugState(req))
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || 'Failed to build debug state' })
    }
  })

  app.get('/admin/debug/events', adminKeyMiddleware, (req, res) => {
    try {
      const limit = Math.min(Math.max(Number(req.query.limit || 200), 1), 2000)
      return res.json({ ok: true, count: limit, events: listDebugEvents(limit) })
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || 'Failed to list debug events' })
    }
  })

  app.get('/admin/debug/checks', adminKeyMiddleware, async (req, res) => {
    try {
      const out = await runDebugChecks(req)
      const ok = Boolean(out?.ok)
      return res.status(ok ? 200 : 500).json(out)
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || 'Failed to run debug checks' })
    }
  })
}
