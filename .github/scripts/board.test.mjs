/**
 * The board rules, exercised without a network, including the failure states.
 * Run with: node .github/scripts/board.test.mjs
 */
import { readFileSync } from 'node:fs'
import { CONFIG, statusFor, labelsFor, factsFor, reconcile, shouldPickUp } from './board.mjs'

const S = CONFIG.status
let failed = 0

function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failed++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n         got ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`)
}

const issue = (over = {}) => ({ state: 'OPEN', labels: [], openPr: undefined, prFailing: false, attempts: 0, ...over })

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
// A question the agent stopped on still needs a person's answer.
check('a question outranks the human queue',
  statusFor(issue({ labels: ['no-ai', 'needs-decision'] })), S.needsDecision)

console.log('\nthe card never goes backwards')
// A failed run used to send the card from In Progress back to Todo.
check('one attempt, nothing to show, still queued',
  statusFor(issue({ labels: ['claude'], attempts: 1 })), S.todo)
check('two attempts, still queued',
  statusFor(issue({ labels: ['claude'], attempts: 2 })), S.todo)
check('three attempts is a question for a person',
  statusFor(issue({ labels: ['claude'], attempts: 3 })), S.needsDecision)
check('attempts do not outrank a pull request',
  statusFor(issue({ openPr: 7, attempts: 5 })), S.inReview)
check('attempts do not outrank a run in flight',
  statusFor(issue({ labels: ['claude-working'], attempts: 5 })), S.inProgress)
check('attempts do not outrank closed',
  statusFor(issue({ state: 'CLOSED', attempts: 5 })), S.done)
check('a human queue is not pushed to Needs Decision',
  statusFor(issue({ labels: ['no-ai'], attempts: 3 })), S.todoHuman)

console.log('\nwho gets picked up out of Todo')
check('queued for the agent, never offered', shouldPickUp(issue({ labels: ['claude'] })), true)
// Callers have passed both `undefined` and `null` for "never offered".
check('null for never offered means the same', shouldPickUp(issue({ labels: ['claude'] }), null), true)
check('queued for a person is not ours', shouldPickUp(issue({ labels: ['no-ai'] })), false)
check('already running', shouldPickUp(issue({ labels: ['claude-working'] })), false)
check('waiting on a person', shouldPickUp(issue({ labels: ['needs-decision'] })), false)
check('a pull request is already open', shouldPickUp(issue({ openPr: 7 })), false)
check('a red pull request is still not ours', shouldPickUp(issue({ openPr: 7, prFailing: true })), false)
check('closed', shouldPickUp(issue({ state: 'CLOSED' })), false)

// The cooldown stops two sweeps in quick succession offering the same issue.
check('offered twenty minutes ago, so not again yet', shouldPickUp(issue({ labels: ['claude'] }), 0.33), false)
check('offered an hour ago, so try again', shouldPickUp(issue({ labels: ['claude'] }), 1), true)
check('exactly at the boundary counts', shouldPickUp(issue({ labels: ['claude'] }), 6, 6), true)
check('a longer cooldown holds it back', shouldPickUp(issue({ labels: ['claude'] }), 6, 12), false)

// A run just triggered has not yet set `claude-working`; handing over in that
// gap started a second run and the two cancelled each other.
check('labelled moments ago, so a run is already on its way',
  shouldPickUp(issue({ labels: ['claude'], minutesSinceTrigger: 0.2 })), false)
check('labelled a while ago and still nobody on it, so it is really waiting',
  shouldPickUp(issue({ labels: ['claude'], minutesSinceTrigger: 45 })), true)
check('the grace window is a parameter, like the cooldown',
  shouldPickUp(issue({ labels: ['claude'], minutesSinceTrigger: 5 }), undefined, 1, 3), true)

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

// claude.yml reads the label to let a reply restart the issue.
check('three attempts with nothing to show earns needs-decision',
  labelsFor(issue({ labels: ['claude'], attempts: 3 })), { add: ['needs-decision'], remove: [] })
check('two attempts do not',
  labelsFor(issue({ labels: ['claude'], attempts: 2 })), { add: [], remove: [] })
check('not while a run is still going',
  labelsFor(issue({ labels: ['claude-working'], attempts: 3 })), { add: [], remove: [] })
check('not for a human queue',
  labelsFor(issue({ labels: ['no-ai'], attempts: 3 })), { add: [], remove: [] })
check('not when a pull request is open',
  labelsFor(issue({ openPr: 7, attempts: 3 })), { add: ['in-review'], remove: [] })
check('not once closed',
  labelsFor(issue({ state: 'CLOSED', attempts: 3 })), { add: [], remove: [] })
check('the agent setting it earlier is not the board\'s to clear',
  labelsFor(issue({ labels: ['needs-decision'], attempts: 1 })), { add: [], remove: [] })

console.log('\nrepeating a run changes nothing')
const settled = issue({ openPr: 7, labels: ['in-review'] })
check('already correct, so no writes', labelsFor(settled), { add: [], remove: [] })
check('and the same column', statusFor(settled), S.inReview)

// ---------------------------------------------------------------------------
// Reading the facts, through a fake `github`. Both past bugs here were in the
// query shape, not the rules.
// ---------------------------------------------------------------------------

const pr = (number, over = {}) => ({
  number, state: 'OPEN', isDraft: false,
  commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
  ...over,
})

const labelled = (name, createdAt) => ({ __typename: 'LabeledEvent', label: { name }, ...(createdAt ? { createdAt } : {}) })
const reopened = () => ({ __typename: 'ReopenedEvent' })
const unlabelled = (name) => ({ __typename: 'UnlabeledEvent', label: { name } })

const fakeGithub = ({ prs = [], events = [] }, spy = {}) => ({
  graphql: async (query) => {
    spy.query = query
    return {
      repository: {
        issue: {
          id: 'I_1', state: 'OPEN',
          labels: { nodes: [] },
          closedByPullRequestsReferences: { nodes: prs },
          timelineItems: { nodes: events },
        },
      },
    }
  },
})

const NOW = Date.parse('2026-09-02T12:00:00Z')
const facts = async (shape, spy) => factsFor(fakeGithub(shape, spy), 'o', 'r', 1, NOW)

console.log('\nreading the pull request for an issue')

check('a pull request that closes the issue is found',
  (await facts({ prs: [pr(7)] })).openPr, 7)

check('a closed pull request is not an open one',
  (await facts({ prs: [pr(7, { state: 'CLOSED' })] })).openPr, undefined)

check('the newest open pull request wins, not the oldest',
  (await facts({ prs: [pr(9), pr(7)] })).openPr, 9)

check('a red pull request is reported failing',
  (await facts({ prs: [pr(7, {
    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE' } } }] } })] })).prFailing, true)

check('checks still running are not a failure',
  (await facts({ prs: [pr(7, {
    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'PENDING' } } }] } })] })).prFailing, false)

// A timeline cross-reference scan once took an unrelated PR that mentioned
// the issue as its pull request. Only a closing reference counts.
const spy = {}
await facts({ prs: [pr(7)] }, spy)
check('a mere mention is not a pull request for the issue',
  /CROSS_REFERENCED_EVENT|CONNECTED_EVENT/.test(spy.query), false)
check('the link the pull request declares is what is read',
  /closedByPullRequestsReferences\(/.test(spy.query), true)

console.log('\ncounting attempts off the timeline')

check('no runs yet', (await facts({})).attempts, 0)
check('each time the working label goes on is a run',
  (await facts({ events: [labelled('claude-working'), labelled('claude'), labelled('claude-working')] })).attempts, 2)

// A reopen starts a new brief, so earlier runs do not count.
check('attempts restart when the issue is reopened',
  (await facts({ events: [labelled('claude-working'), labelled('claude-working'), reopened(), labelled('claude-working')] })).attempts, 1)
check('a reopen with no run since counts none',
  (await facts({ events: [labelled('claude-working'), reopened()] })).attempts, 0)
check('reopens are asked for, or nothing separates the old attempts from the new',
  /REOPENED_EVENT/.test(spy.query), true)

// An answered question is a new brief: the count restarts when claude.yml
// removes `needs-decision`.
check('attempts restart when a needs-decision question is answered',
  (await facts({ events: [labelled('claude-working'), labelled('needs-decision'), unlabelled('needs-decision'), labelled('claude-working')] })).attempts, 1)
check('taking off some other label restarts nothing',
  (await facts({ events: [labelled('claude-working'), unlabelled('claude'), labelled('claude-working')] })).attempts, 2)
check('a label coming off is not a run starting',
  (await facts({ events: [labelled('claude-working'), unlabelled('claude-working')] })).attempts, 1)

// The timeline is oldest first, so `first: 50` dropped the newest labels.
check('the timeline is read from the newest end', /timelineItems\(last: 50/.test(spy.query), true)

console.log('\nhow recently the agent was asked')

check('never labelled, so no trigger to be recent',
  (await facts({ events: [labelled('claude-working')] })).minutesSinceTrigger, undefined)
check('minutes since the label went on',
  (await facts({ events: [labelled('claude', '2026-09-02T11:58:00Z')] })).minutesSinceTrigger, 2)
check('the newest time the label went on, not the first',
  (await facts({ events: [labelled('claude', '2026-09-02T09:00:00Z'), unlabelled('claude'), labelled('claude', '2026-09-02T11:30:00Z')] })).minutesSinceTrigger, 30)
check('the label event carries its time, or there is nothing to measure',
  /on LabeledEvent \{ createdAt/.test(spy.query), true)

// ---------------------------------------------------------------------------
// Reconciling. The hourly sweep visits every open issue, so the unchanged
// case decides what it costs.
// ---------------------------------------------------------------------------

const project = {
  id: 'P_1',
  field: { id: 'F_1', options: Object.values(S).map((name, i) => ({ id: `O_${i}`, name })) },
}

function harness({ column, labels = [], prs = [pr(7)], card = true, gone = false }) {
  const calls = { mutations: [], labelWrites: [], logs: [] }
  const github = {
    graphql: async () => ({
      repository: { issue: gone ? null : {
        id: 'I_1', state: 'OPEN',
        labels: { nodes: labels.map((name) => ({ name })) },
        closedByPullRequestsReferences: { nodes: prs },
        timelineItems: { nodes: [] },
      } },
    }),
    rest: { issues: {
      addLabels: async ({ labels: l }) => calls.labelWrites.push(`+${l}`),
      removeLabel: async ({ name }) => calls.labelWrites.push(`-${name}`),
    } },
  }
  const projectApi = async (query) => {
    if (query.includes('projectItems')) {
      return { node: { projectItems: { nodes: card ? [{
        id: 'PI_1',
        project: { id: 'P_1' },
        fieldValueByName: { nodes: [{ name: column, field: { id: 'F_1' } }] },
      }] : [] } } }
    }
    calls.mutations.push(query.includes('updateProjectV2ItemFieldValue') ? 'update' : 'add')
    return { addProjectV2ItemById: { item: { id: 'PI_1' } } }
  }
  const core = { info: (m) => calls.logs.push(m), warning: () => {}, setFailed: (m) => calls.logs.push(`FAILED ${m}`) }
  return { calls, run: () => reconcile({ github, project, projectApi, core, owner: 'o', repo: 'r', number: 1 }) }
}

console.log('\nreconciling an issue that has not changed')

// The sweep's ordinary case, which used to cost a mutation every hour.
const settledRun = harness({ column: S.inReview, labels: ['in-review'] })
await settledRun.run()
check('nothing is written when nothing moved', settledRun.calls.mutations, [])
check('and no labels are touched either', settledRun.calls.labelWrites, [])
check('and it says nothing', settledRun.calls.logs, [])

const movedRun = harness({ column: S.todo, labels: [] })
await movedRun.run()
check('a card that should move is moved', movedRun.calls.mutations, ['update'])
check('and the move is reported', movedRun.calls.logs.length, 1)

const relabelRun = harness({ column: S.inReview, labels: [] })
await relabelRun.run()
check('a correct column with a missing label still writes the label',
  relabelRun.calls.labelWrites, ['+in-review'])
check('but does not rewrite the column', relabelRun.calls.mutations, [])

// No card yet: a new issue, or one filed while the board was broken.
const newRun = harness({ column: undefined, labels: [], card: false })
await newRun.run()
check('an issue with no card is added and then placed', newRun.calls.mutations, ['add', 'update'])

// A number that no longer resolves must write nothing.
const goneRun = harness({ column: S.todo, gone: true })
await goneRun.run()
check('an issue that is not there writes nothing', goneRun.calls.mutations, [])
check('and touches no labels', goneRun.calls.labelWrites, [])

// ---------------------------------------------------------------------------
// The queries, read from source, since the fakes above accept any string.
// An unused `$field` variable once broke every real sweep while tests passed.
// ---------------------------------------------------------------------------

console.log('\nthe queries are well formed')

const source = readFileSync(new URL('./board.mjs', import.meta.url), 'utf8')
// Odd-numbered pieces of a backtick split are the literals.
const literals = source.split('`').filter((_, i) => i % 2 === 1)
const operations = literals.filter((l) => /\b(query|mutation)\s*\(/.test(l))

check('every query in the file was found', operations.length > 0, true)

for (const op of operations) {
  const head = op.match(/\b(query|mutation)\s*\(([^)]*)\)/)
  const name = op.trim().split('\n')[0].slice(0, 44)
  const declared = [...head[2].matchAll(/\$(\w+)\s*:/g)].map((m) => m[1])
  const body = op.slice(head.index + head[0].length)
  const unused = declared.filter((v) => !new RegExp(`\\$${v}\\b`).test(body))
  check(`no unused variable in \`${name}\``, unused, [])
}

console.log(failed ? `\n  ${failed} failed\n` : '\n  all rules hold\n')
process.exit(failed ? 1 : 0)
