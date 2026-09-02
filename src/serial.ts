/**
 * Run an async job at most once at a time. A call made while one is in flight
 * gets a single follow-up run, started when the first finishes and shared by
 * every caller that arrived during it, so the answer they get reflects the
 * state at the time they asked rather than an earlier one.
 *
 * Library reloads are triggered by the window regaining focus, by Settings,
 * by the detail view and by the picker, and two arriving together used to
 * race: both scanned, both rebuilt the grid, and whichever finished second
 * won regardless of which had the newer facts.
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
    // One queued run answers everyone who asked during the current one, and
    // goes through start() so that it, too, can be queued behind.
    queued ??= current
      .catch(() => { /* the first run's failure is its own callers' to hear */ })
      .then(() => { queued = undefined; return start() })
    return queued
  }
}
