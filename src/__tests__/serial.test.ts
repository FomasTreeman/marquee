import { describe, expect, it } from 'vitest'
import { serialised } from '../serial'

/** A job that finishes only when told to, so overlap can be arranged. */
function job() {
  const releases: Array<() => void> = []
  let runs = 0
  const run = serialised(() => {
    runs += 1
    const n = runs
    return new Promise<number>((resolve) => { releases.push(() => resolve(n)) })
  })
  return { run, release: () => releases.shift()?.(), runs: () => runs }
}

describe('a serialised job', () => {
  it('runs once for a single call', async () => {
    const j = job()
    const p = j.run()
    j.release()
    expect(await p).toBe(1)
    expect(j.runs()).toBe(1)
  })

  it('does not start a second run while the first is in flight', () => {
    const j = job()
    void j.run()
    void j.run()
    expect(j.runs()).toBe(1)
  })

  it('runs once more after the first, for everyone who asked during it', async () => {
    const j = job()
    const first = j.run()
    const second = j.run()
    const third = j.run()
    j.release()
    await first
    // The follow-up starts only once the first has settled.
    await Promise.resolve()
    expect(j.runs()).toBe(2)
    j.release()
    expect(await second).toBe(2)
    expect(await third).toBe(2)
    expect(j.runs()).toBe(2)
  })

  it('runs again after the follow-up when asked during that too', async () => {
    const j = job()
    const first = j.run()
    const second = j.run()
    j.release()
    await first
    await Promise.resolve()
    const third = j.run()
    expect(j.runs()).toBe(2)
    j.release()
    await second
    await Promise.resolve()
    j.release()
    expect(await third).toBe(3)
  })

  it('still runs the follow-up when the first run fails', async () => {
    let calls = 0
    const run = serialised(async () => {
      calls += 1
      if (calls === 1) throw new Error('first')
      return calls
    })
    const first = run()
    const second = run()
    await expect(first).rejects.toThrow('first')
    expect(await second).toBe(2)
  })
})
