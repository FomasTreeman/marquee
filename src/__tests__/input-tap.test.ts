import { beforeEach, describe, expect, it, vi } from 'vitest'

// `listen` resolves asynchronously; a tap stopped before then must still detach.
let resolveListen: (un: () => void) => void = () => {}
vi.mock('@tauri-apps/api/event', () => ({
  listen: () => new Promise<() => void>((resolve) => { resolveListen = resolve }),
}))
vi.mock('../host', () => ({ inApp: true, call: async () => undefined }))

const { onAnyInput } = await import('../input')

describe('a tap on the input stream', () => {
  let unlistened = 0
  beforeEach(() => { unlistened = 0 })

  it('unlistens on the Rust side once stopped', async () => {
    const stop = onAnyInput(() => {}, () => {})
    resolveListen(() => { unlistened += 1 })
    await Promise.resolve()
    stop()
    expect(unlistened).toBe(1)
  })

  it('still unlistens when stopped before Rust has answered', async () => {
    const stop = onAnyInput(() => {}, () => {})
    stop()
    resolveListen(() => { unlistened += 1 })
    await Promise.resolve()
    expect(unlistened).toBe(1)
  })
})
