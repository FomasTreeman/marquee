import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWebPad } from '../webpad'
import type { ActionEvent } from '../input'

/**
 * The fallback only ever runs when the native path has already failed, which
 * means it is the code that has to work on the machine where nothing else
 * does. It cannot be tested by holding a controller; it can be tested by
 * feeding it the shape the Gamepad API produces.
 */

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
    // Both running at once means every press fires twice, and a doubled A
    // launches a game twice. This is the property that makes the fallback safe
    // to ship rather than a coin flip.
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
  it('arms later if the native path looked fine at first and then did not', () => {
    // Reported from Windows: "Windows.Gaming.Input sees: (nothing enumerated),
    // the webview sees: xbox 360 controller - standard mapping", and nothing
    // happened. Arming was a single check 2.5s after startup; standing down
    // was continuous. If native looked fine at that one instant -- a pad still
    // waking, a transient count -- it never armed again, and a machine whose
    // native backend enumerates nothing was left with neither path driving.
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
    // The native path still gets first refusal; that is the whole reason for
    // the delay. It just is not a one-shot decision any more.
    const w = createWebPad((e) => events.push(e), () => false, 2500)
    pads = [press(fakePad(), 0)]
    tick(); tick()
    expect(events).toEqual([])
    w.stop()
  })

  it('takes over when it can see hardware the native path cannot', () => {
    // The reported case: a DualSense works natively, an Xbox controller
    // plugged in beside it is not recognised at all. Standing down because
    // *one* pad delivered natively left every pad gilrs could not read with
    // nothing driving it.
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
    // A vJoy virtual controller reports a non-standard mapping. Counting it
    // would keep the webview driving forever on a machine where the native
    // path is handling every real pad perfectly well.
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
    // The sequence from a real log: the app starts with nothing plugged in,
    // this arms after 2.5s, and the controller connects half a minute later.
    // Asking `nativeIsAlive` only at arming time left both paths delivering
    // for the rest of the session -- every press twice, a doubled A launching
    // a game twice.
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
    // Otherwise the press it was holding at the moment it stood down is
    // remembered, and reappears as a phantom release later.
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
      [10, 'sort'], [11, 'filter'],
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
    // Indices 6 and 7. They rest at a non-zero value on some pads and are
    // reported as axes as well as buttons, so giving them the bumpers' action
    // made the two interfere -- a page that sometimes happened and sometimes
    // did not, for no reason visible from the sofa.
    pads = [press(fakePad(), 6, 7)]
    tick(); tick()
    expect(events).toEqual([])
  })

  it('ignores a pad with no standard mapping rather than guessing', () => {
    // Chromium reports `mapping: ""` for a device it cannot recognise, and
    // hands the buttons back in whatever order the device chose. Reading
    // index 4 as a bumper would be a guess, and a guess produces a pad where
    // some buttons do the wrong thing -- worse than one that does nothing.
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
    // A repeating A launches the game under the cursor over and over.
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
    // Worn sticks rest off-centre. Without a deadzone the grid drifts on its
    // own, which looks like the app is possessed.
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
