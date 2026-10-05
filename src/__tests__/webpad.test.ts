import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWebPad } from '../webpad'
import type { ActionEvent } from '../input'

let pads: unknown[] = []
let frame: (() => void) | undefined
let events: ActionEvent[] = []

function fakePad(over: Partial<Gamepad> = {}): Gamepad {
  return {
    id: 'Test Pad', index: 0, connected: true, mapping: 'standard',
    buttons: Array.from({ length: 16 }, () => ({ pressed: false, touched: false, value: 0 })),
    axes: [0, 0, 0, 0], timestamp: 0, vibrationActuator: null,
    ...over,
  } as Gamepad
}

/** Press by index, using the W3C standard mapping order. */
function press(pad: Gamepad, ...indices: number[]): Gamepad {
  const buttons = pad.buttons.map((b, i) => (
    indices.includes(i) ? { ...b, pressed: true, value: 1 } : b
  ))
  return { ...pad, buttons } as Gamepad
}

/** Advance the render loop and the clock together. */
function tick(ms = 16): void {
  vi.advanceTimersByTime(ms)
  frame?.()
}

beforeEach(() => {
  vi.useFakeTimers()
  events = []
  pads = []
  frame = undefined
  vi.stubGlobal('navigator', { getGamepads: () => pads })
  vi.stubGlobal('performance', { now: () => Date.now() })
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => { frame = cb; return 1 })
  vi.stubGlobal('cancelAnimationFrame', () => { frame = undefined })
  vi.stubGlobal('window', {
    addEventListener: () => {}, removeEventListener: () => {},
    setTimeout: (f: () => void, ms: number) => setTimeout(f, ms),
    clearTimeout: (h: number) => clearTimeout(h),
  })
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

function start(nativeAlive = false) {
  return createWebPad((e) => events.push(e), () => nativeAlive, 2500)
}

describe('arming', () => {
  it('stays silent while the native path is working', () => {
    const w = start(true)
    pads = [press(fakePad(), 0)]
    vi.advanceTimersByTime(5000)
    tick(); tick()
    expect(events).toEqual([])
    w.stop()
  })

  it('does not fire before it has armed', () => {
    const w = start(false)
    pads = [press(fakePad(), 0)]
    tick(); tick()
    expect(events).toEqual([])
    w.stop()
  })

  it('takes over once the native path has visibly not', () => {
    const w = start(false)
    vi.advanceTimersByTime(2600)
    pads = [press(fakePad(), 0)]
    tick()
    expect(events.map((e) => e.action)).toEqual(['a'])
    w.stop()
  })
})

describe('choosing which path drives', () => {
  it('drives when the native path claims a pad but never sends anything', () => {
    // gilrs has reported one connected pad, enumerated none and sent nothing.
    const nativeDelivered = false
    const nativePads = 1
    const usable = () => pads.filter((p) => (p as Gamepad | null)?.mapping === 'standard').length
    const w = createWebPad(
      (e) => events.push(e),
      () => nativeDelivered && nativePads >= usable(),
      2500,
    )
    pads = [fakePad({ id: 'Xbox 360 Controller' })]
    vi.advanceTimersByTime(2600)
    pads = [press(fakePad({ id: 'Xbox 360 Controller' }), 0)]
    tick()
    expect(events.map((e) => e.action), 'a claimed-but-silent native pad must not win')
      .toEqual(['a'])
    w.stop()
  })

  it('reports whether it is the one driving', () => {
    let delivered = false
    const w = createWebPad((e) => events.push(e), () => delivered, 2500)
    expect(w.armed(), 'not during the settle period').toBe(false)
    pads = [fakePad()]
    vi.advanceTimersByTime(2600); tick()
    expect(w.armed(), 'driving once native has shown nothing').toBe(true)
    delivered = true
    tick()
    expect(w.armed(), 'stood down once native delivered').toBe(false)
    w.stop()
  })

  it('arms later if the native path looked fine at first and then did not', () => {
    let nativePads = 1
    const w = createWebPad((e) => events.push(e), () => nativePads > 0, 2500)
    pads = [fakePad()]
    vi.advanceTimersByTime(2600)
    tick()
    expect(events, 'native looked fine, so nothing yet').toEqual([])

    nativePads = 0            // gilrs turns out to see nothing at all
    pads = [press(fakePad(), 0)]
    tick(); tick()
    expect(events.map((e) => e.action), 'must take over when native falls away')
      .toContain('a')
    w.stop()
  })

  it('does nothing at all during the settle period', () => {
    const w = createWebPad((e) => events.push(e), () => false, 2500)
    pads = [press(fakePad(), 0)]
    tick(); tick()
    expect(events).toEqual([])
    w.stop()
  })

  it('takes over when it can see hardware the native path cannot', () => {
    // A DualSense works natively; the Xbox pad beside it is invisible to gilrs.
    let nativePads = 1
    const usable = () => pads.filter((p) => (p as Gamepad | null)?.mapping === 'standard').length
    const w = createWebPad(
      (e) => events.push(e),
      () => nativePads >= usable(),
      2500,
    )
    pads = [fakePad({ id: 'DualSense' }), fakePad({ id: 'Xbox' })]
    vi.advanceTimersByTime(2600)

    pads = [fakePad({ id: 'DualSense' }), press(fakePad({ id: 'Xbox' }), 0)]
    tick()
    expect(events.map((e) => e.action), 'the pad gilrs cannot see must still work')
      .toEqual(['a'])
    w.stop()
  })

  it('stands aside once the native path covers everything', () => {
    let nativePads = 1
    const usable = () => pads.filter((p) => (p as Gamepad | null)?.mapping === 'standard').length
    const w = createWebPad((e) => events.push(e), () => nativePads >= usable(), 2500)
    pads = [fakePad(), fakePad()]
    vi.advanceTimersByTime(2600)
    pads = [press(fakePad(), 0), fakePad()]
    tick()
    expect(events).toHaveLength(1)

    events = []
    nativePads = 2          // the second pad wakes up natively
    pads = [fakePad(), fakePad()]; tick()
    pads = [press(fakePad(), 0), fakePad()]; tick(); tick()
    expect(events, 'must not double what the native path is already sending').toEqual([])
    w.stop()
  })

  it('does not count a pad it could never drive', () => {
    // A vJoy virtual controller reports a non-standard mapping.
    let nativePads = 1
    const usable = () => pads.filter((p) => (p as Gamepad | null)?.mapping === 'standard').length
    const w = createWebPad((e) => events.push(e), () => nativePads >= usable(), 2500)
    pads = [fakePad({ id: 'Real' }), fakePad({ id: 'vJoy', mapping: '' as GamepadMappingType })]
    vi.advanceTimersByTime(2600)
    pads = [press(fakePad({ id: 'Real' }), 0), fakePad({ id: 'vJoy', mapping: '' as GamepadMappingType })]
    tick(); tick()
    expect(events, 'one real pad, handled natively, so nothing here').toEqual([])
    w.stop()
  })
})

describe('standing down', () => {
  it('stops the moment the native path wakes up', () => {
    // Start with nothing plugged in, arm, then the pad connects natively.
    let alive = false
    const w = createWebPad((e) => events.push(e), () => alive, 2500)
    vi.advanceTimersByTime(2600)

    pads = [press(fakePad(), 0)]
    tick()
    expect(events.map((e) => e.action), 'armed while nothing else was').toEqual(['a'])

    alive = true          // the pad connects; gilrs starts delivering
    events = []
    pads = [fakePad()]; tick()
    pads = [press(fakePad(), 0)]; tick(); tick()
    expect(events, 'must not double the native path').toEqual([])
    w.stop()
  })

  it('forgets what was held when it stands down', () => {
    let alive = false
    const w = createWebPad((e) => events.push(e), () => alive, 2500)
    vi.advanceTimersByTime(2600)
    pads = [press(fakePad(), 13)]
    tick()
    alive = true
    tick()
    events = []
    for (let i = 0; i < 20; i++) tick(50)
    expect(events).toEqual([])
    w.stop()
  })
})

describe('once armed', () => {
  let w: ReturnType<typeof createWebPad>
  beforeEach(() => { w = start(false); vi.advanceTimersByTime(2600) })
  afterEach(() => w.stop())

  it('maps the standard button order', () => {
    const cases: Array<[number, string]> = [
      [0, 'a'], [1, 'b'], [2, 'x'], [3, 'y'],
      [4, 'lb'], [5, 'rb'],
      [8, 'add'], [9, 'menu'],
      [10, 'sort'], [11, 'search'],
      [12, 'up'], [13, 'down'], [14, 'left'], [15, 'right'],
    ]
    for (const [index, action] of cases) {
      events = []
      pads = [press(fakePad(), index)]
      tick()
      expect(events.map((e) => e.action), `button ${index}`).toEqual([action])
      pads = [fakePad()]
      tick()
    }
  })

  it('pages on the bumpers', () => {
    pads = [press(fakePad(), 4)]
    tick()
    expect(events.map((e) => e.action)).toEqual(['lb'])
    events = []
    pads = [fakePad()]; tick()
    pads = [press(fakePad(), 5)]; tick()
    expect(events.map((e) => e.action)).toEqual(['rb'])
  })

  it('leaves the analogue triggers alone', () => {
    // Some pads rest the triggers at a non-zero value, which paged at random.
    pads = [press(fakePad(), 6, 7)]
    tick(); tick()
    expect(events).toEqual([])
  })

  it('ignores a pad with no standard mapping rather than guessing', () => {
    pads = [press(fakePad({ mapping: '' as GamepadMappingType }), 0)]
    tick(); tick()
    expect(events).toEqual([])
  })

  it('fires once per press, not once per frame', () => {
    pads = [press(fakePad(), 0)]
    tick(); tick(); tick()
    expect(events.filter((e) => e.action === 'a')).toHaveLength(1)
  })

  it('fires again after a release', () => {
    pads = [press(fakePad(), 0)]; tick()
    pads = [fakePad()]; tick()
    pads = [press(fakePad(), 0)]; tick()
    expect(events.filter((e) => e.action === 'a')).toHaveLength(2)
  })

  it('repeats a held direction, after a delay', () => {
    pads = [press(fakePad(), 13)]
    tick()
    expect(events).toHaveLength(1)
    tick(300)
    expect(events, 'must not repeat before the delay').toHaveLength(1)
    tick(120)
    expect(events.length, 'must repeat after it').toBeGreaterThan(1)
    expect(events[events.length - 1]?.repeat).toBe(true)
  })

  it('never repeats confirm', () => {
    pads = [press(fakePad(), 0)]
    tick()
    for (let i = 0; i < 40; i++) tick(50)
    expect(events.filter((e) => e.action === 'a')).toHaveLength(1)
  })

  it('reads the left stick, with the spec s inverted Y', () => {
    pads = [fakePad({ axes: [0, -1, 0, 0] })]
    tick()
    expect(events.map((e) => e.action)).toEqual(['up'])
    events = []
    pads = [fakePad({ axes: [0, 1, 0, 0] })]
    tick()
    expect(events.map((e) => e.action)).toEqual(['down'])
  })

  it('ignores a stick inside the deadzone', () => {
    // Worn sticks rest off-centre.
    pads = [fakePad({ axes: [0.4, -0.4, 0, 0] })]
    tick(); tick()
    expect(events).toEqual([])
  })

  it('counts a button that reports a value but not a press', () => {
    // Some third-party pads never set `pressed`, only `value`.
    const pad = fakePad()
    const buttons = pad.buttons.map((b, i) => (i === 0 ? { ...b, value: 1 } : b))
    pads = [{ ...pad, buttons }]
    tick()
    expect(events.map((e) => e.action)).toEqual(['a'])
  })

  it('skips a disconnected pad', () => {
    pads = [press(fakePad({ connected: false }), 0)]
    tick()
    expect(events).toEqual([])
  })

  it('survives the nulls getGamepads returns for empty slots', () => {
    pads = [null, undefined, press(fakePad(), 1)]
    tick()
    expect(events.map((e) => e.action)).toEqual(['b'])
  })

  it('stops dispatching once stopped', () => {
    w.stop()
    pads = [press(fakePad(), 0)]
    frame?.()
    expect(events).toEqual([])
  })
})
