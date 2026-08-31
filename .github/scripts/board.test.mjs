/**
 * The board rules, exercised without a network.
 *
 * Run with: node .github/scripts/board.test.mjs
 *
 * These are the rules that decide what a person sees when they come back to a
 * pile of work, so every state a real issue can reach is checked -- including
 * the ones that only happen when something goes wrong, which are the ones that
 * used to leave a card lying about a thing nobody was doing.
 */
import { CONFIG, statusFor, labelsFor } from './board.mjs'

const S = CONFIG.status
let failed = 0

function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failed++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n         got ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`)
}

const issue = (over = {}) => ({ state: 'OPEN', labels: [], openPr: undefined, prFailing: false, ...over })

console.log('\nwhere an issue belongs')
check('filed, for the agent', statusFor(issue({ labels: ['claude'] })), S.todo)
check('filed, for a person', statusFor(issue({ labels: ['no-ai'] })), S.todoHuman)
check('agent is running', statusFor(issue({ labels: ['claude-working'] })), S.inProgress)
check('pull request open and green', statusFor(issue({ openPr: 7 })), S.inReview)
check('pull request open and red', statusFor(issue({ openPr: 7, prFailing: true })), S.inProgress)
check('blocked on a question', statusFor(issue({ labels: ['needs-decision'] })), S.needsDecision)
check('closed', statusFor(issue({ state: 'CLOSED' })), S.done)

console.log('\nwhen two things are true at once')
check('a question outranks an open pull request',
  statusFor(issue({ openPr: 7, labels: ['needs-decision'] })), S.needsDecision)
check('closed outranks everything',
  statusFor(issue({ state: 'CLOSED', openPr: 7, labels: ['needs-decision', 'claude-working'] })), S.done)
check('a red pull request is not review-ready even while working',
  statusFor(issue({ openPr: 7, prFailing: true, labels: ['claude-working'] })), S.inProgress)
check('a pull request outranks a stale working label',
  statusFor(issue({ openPr: 7, labels: ['claude-working'] })), S.inReview)

console.log('\nlabels follow the same facts')
check('a green pull request earns in-review',
  labelsFor(issue({ openPr: 7 })), { add: ['in-review'], remove: [] })
check('a red one earns ci-failing instead',
  labelsFor(issue({ openPr: 7, prFailing: true })), { add: ['ci-failing'], remove: [] })
check('going green swaps them',
  labelsFor(issue({ openPr: 7, labels: ['ci-failing'] })), { add: ['in-review'], remove: ['ci-failing'] })
check('opening a pull request clears the working label',
  labelsFor(issue({ openPr: 7, labels: ['claude-working'] })),
  { add: ['in-review'], remove: ['claude-working'] })
check('closing clears everything transient',
  labelsFor(issue({ state: 'CLOSED', labels: ['in-review', 'claude-working', 'needs-decision'] })),
  { add: [], remove: ['in-review', 'claude-working', 'needs-decision'] })
check('nothing to do is nothing to do',
  labelsFor(issue({ labels: ['bug'] })), { add: [], remove: [] })
check('it never sets claude-working itself',
  labelsFor(issue({ labels: [] })).add.includes('claude-working'), false)

console.log('\nrepeating a run changes nothing')
const settled = issue({ openPr: 7, labels: ['in-review'] })
check('already correct, so no writes', labelsFor(settled), { add: [], remove: [] })
check('and the same column', statusFor(settled), S.inReview)

console.log(failed ? `\n  ${failed} failed\n` : '\n  all rules hold\n')
process.exit(failed ? 1 : 0)
