/**
 * Run an async job one at a time. Calls made during a run share one follow-up
 * run, so they see current state. Concurrent library reloads used to race.
 */
export function serialised<T>(run: () => Promise<T>): () => Promise<T> {
  let current: Promise<T> | undefined
  let queued: Promise<T> | undefined
  const start = (): Promise<T> => {
    current = run().finally(() => { current = undefined })
    return current
  }
  return () => {
    if (!current) return start()
    // Through start(), so later calls can queue behind it in turn.
    queued ??= current
      .catch(() => { /* the first run's failure is its own callers' to hear */ })
      .then(() => { queued = undefined; return start() })
    return queued
  }
}
