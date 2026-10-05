/**
 * On-screen keyboard for typing with a pad. It writes into a real `<input>`
 * rather than its own buffer, so existing listeners and a physical keyboard
 * keep working.
 */

const ROWS: string[][] = [
  ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
  ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
  ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', "'"],
  ['z', 'x', 'c', 'v', 'b', 'n', 'm', ',', '.', ':'],
]

export interface Osk {
  readonly isOpen: boolean
  attach(field: HTMLInputElement): void
  close(): void
  handle(action: string): boolean
}

export function createOsk(): Osk {
  const root = document.createElement('div')
  root.className = 'osk'
  root.hidden = true

  const grid = document.createElement('div')
  grid.className = 'osk-grid'
  root.appendChild(grid)

  const keys: HTMLElement[][] = ROWS.map((row) => {
    const line = document.createElement('div')
    line.className = 'osk-row'
    grid.appendChild(line)
    return row.map((ch) => {
      const key = document.createElement('span')
      key.className = 'osk-key'
      key.textContent = ch
      line.appendChild(key)
      return key
    })
  })

  const hint = document.createElement('div')
  hint.className = 'osk-hint'
  hint.textContent = 'A type · X delete · Y space · B done'
  root.appendChild(hint)
  document.body.appendChild(root)

  let field: HTMLInputElement | undefined
  let row = 1
  let col = 0

  function paint(): void {
    keys.forEach((line, r) =>
      line.forEach((key, c) => {
        key.dataset['on'] = r === row && c === col ? '1' : '0'
      }),
    )
  }

  /** Setting `.value` from script fires no `input` event, so dispatch one. */
  function emit(mutate: (value: string) => string): void {
    if (!field) return
    field.value = mutate(field.value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  }

  return {
    get isOpen() { return !root.hidden },

    attach(next) {
      field = next
      row = 1
      col = 0
      paint()
      root.hidden = false
      // Lets centred panels move clear of the keyboard as they grow.
      document.body.classList.add('osk-open')
    },

    close() {
      root.hidden = true
      field = undefined
      document.body.classList.remove('osk-open')
    },

    handle(action) {
      if (root.hidden) return false
      switch (action) {
        case 'up': row = (row - 1 + ROWS.length) % ROWS.length; break
        case 'down': row = (row + 1) % ROWS.length; break
        case 'left': col = (col - 1 + ROWS[row]!.length) % ROWS[row]!.length; break
        case 'right': col = (col + 1) % ROWS[row]!.length; break
        case 'a': emit((v) => v + (ROWS[row]![col] ?? '')); break
        case 'x': emit((v) => v.slice(0, -1)); break
        case 'y': emit((v) => `${v} `); break
        case 'b': this.close(); return true
        default: return true
      }
      paint()
      return true
    },
  }
}
