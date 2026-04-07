export function createDiagnosticsBuffer(capacity = 500) {
  const max = Math.max(100, Number(capacity || 500))
  const events = []
  const counters = new Map()

  const push = ({ level = 'info', event = 'log', message = '', meta = null }) => {
    const item = {
      ts: Date.now(),
      level: String(level || 'info'),
      event: String(event || 'log'),
      message: String(message || ''),
      meta: meta && typeof meta === 'object' ? meta : null
    }
    events.push(item)
    while (events.length > max) events.shift()
    counters.set(item.event, Number(counters.get(item.event) || 0) + 1)
    return item
  }

  const list = (limit = 200) => {
    const n = Math.max(1, Math.min(Number(limit || 200), max))
    return events.slice(-n)
  }

  const stats = () => ({
    capacity: max,
    size: events.length,
    counters: Object.fromEntries(counters.entries())
  })

  const clear = () => {
    events.splice(0, events.length)
    counters.clear()
  }

  return { push, list, stats, clear }
}
