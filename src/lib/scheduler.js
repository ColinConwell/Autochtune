// Fires callbacks at absolute offsets from one fixed origin.
//
// Chaining relative setTimeout calls — each callback scheduling the next with a
// fixed delay — lets every callback's own lateness carry into the following
// one, so a long loop walks away from its tempo. Deriving each delay from the
// origin and the current clock keeps late events from moving the ones after
// them. It cannot make a late event early, but the error stops accumulating.

const defaultClock = () => (typeof performance === 'undefined' ? Date.now() : performance.now())

export function createScheduler({
  now = defaultClock,
  setTimer = (callback, delay) => setTimeout(callback, delay),
  clearTimer = (handle) => clearTimeout(handle),
} = {}) {
  const origin = now()
  let timers = []
  let cancelled = false

  return {
    origin,
    at(offsetMs, callback) {
      if (cancelled) return null
      const delay = Math.max(0, origin + offsetMs - now())
      const handle = setTimer(() => {
        if (!cancelled) callback()
      }, delay)
      timers.push(handle)
      return handle
    },
    cancel() {
      cancelled = true
      timers.forEach(clearTimer)
      timers = []
    },
    get pending() {
      return timers.length
    },
  }
}
