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

console.log('\nthe card never goes backwards')
// `claude-working` comes off when a run ends. With no pull request the answer
// used to fall through to Todo, so a card went from In Progress back to the
// queue it started in and a failed run looked like an untouched issue.
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
check('queued for a person is not ours', shouldPickUp(issue({ labels: ['no-ai'] })), false)
check('already running', shouldPickUp(issue({ labels: ['claude-working'] })), false)
check('waiting on a person', shouldPickUp(issue({ labels: ['needs-decision'] })), false)
check('a pull request is already open', shouldPickUp(issue({ openPr: 7 })), false)
check('a red pull request is still not ours', shouldPickUp(issue({ openPr: 7, prFailing: true })), false)
check('closed', shouldPickUp(issue({ state: 'CLOSED' })), false)

// The cooldown is the whole safety of this. An issue whose run failed, or
// whose pull request was closed unmerged, lands back in Todo and would
// otherwise be offered again every sweep, forever, at a full run each time.
check('offered an hour ago, so not again yet', shouldPickUp(issue({ labels: ['claude'] }), 1), false)
check('offered six hours ago, so try again', shouldPickUp(issue({ labels: ['claude'] }), 6), true)
check('exactly at the boundary counts', shouldPickUp(issue({ labels: ['claude'] }), 6, 6), true)
check('a longer cooldown holds it back', shouldPickUp(issue({ labels: ['claude'] }), 6, 12), false)

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

// The column said Needs Decision at three attempts while the label did not,
// and the label is what claude.yml reads to let a plain reply restart the
// issue. A card in Needs Decision with no label was one nobody could resume.
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
// Reading the facts. `factsFor` takes `github` as an argument precisely so it
// can be handed a fake one, and the two bugs below were both in the shape of
// the query rather than in the rules -- which is why the rules all passed
// while the card sat still.
// ---------------------------------------------------------------------------

const pr = (number, over = {}) => ({
  number, state: 'OPEN', isDraft: false,
  commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
  ...over,
})

const labelled = (name) => ({ label: { name } })

// A fake `github` that records the query it was given and replays the linked
// pull requests and the label timeline.
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

const facts = async (shape, spy) => factsFor(fakeGithub(shape, spy), 'o', 'r', 1)

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

// Three unrelated pull requests cited #76 in their commit messages, and a
// timeline scan for CrossReferencedEvent took the newest of them as its pull
// request. The card sat In Review with nothing to review. Only a pull request
// that *closes* the issue counts, and that is a different field entirely.
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

// A timeline is oldest first. `first: 50` on an issue with any history returns
// the opening chatter and drops the newest labels off the end.
check('the timeline is read from the newest end', /timelineItems\(last: 50/.test(spy.query), true)

// ---------------------------------------------------------------------------
// Reconciling. The hourly sweep visits every open issue whether or not
// anything changed, so what it does when nothing has changed is the case that
// decides what the sweep costs.
// ---------------------------------------------------------------------------

const project = {
  id: 'P_1',
  field: { id: 'F_1', options: Object.values(S).map((name, i) => ({ id: `O_${i}`, name })) },
}

// Records every call so a run that should be silent can be shown to be silent.
function harness({ column, labels = [], prs = [pr(7)] }) {
  const calls = { mutations: [], labelWrites: [], logs: [] }
  const github = {
    graphql: async () => ({
      repository: { issue: {
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
      return { node: { projectItems: { nodes: [{
        id: 'PI_1',
        project: { id: 'P_1' },
        fieldValueByName: { nodes: [{ name: column, field: { id: 'F_1' } }] },
      }] } } }
    }
    calls.mutations.push(query.includes('updateProjectV2ItemFieldValue') ? 'update' : 'add')
    return { addProjectV2ItemById: { item: { id: 'PI_1' } } }
  }
  const core = { info: (m) => calls.logs.push(m), warning: () => {}, setFailed: (m) => calls.logs.push(`FAILED ${m}`) }
  return { calls, run: () => reconcile({ github, project, projectApi, core, owner: 'o', repo: 'r', number: 1 }) }
}

console.log('\nreconciling an issue that has not changed')

// A green pull request already in In Review and already labelled: the sweep's
// ordinary case, and it used to cost a mutation per issue per hour regardless.
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

// ---------------------------------------------------------------------------
// The queries themselves, read from the source.
//
// Everything above hands `projectApi` and `github.graphql` a fake, and a fake
// will accept any string at all. So a query can be malformed in a way that
// every test passes and the board still dies on its next real run -- which is
// exactly what happened: a `$field` variable was declared, filtered on in
// JavaScript instead, and never used in the query body. GraphQL rejects that
// outright ("Variable $field is declared by anonymous query but not used"),
// the hourly sweep failed on every issue, and nothing here noticed.
//
// This reads the actual file, so it cannot be fooled by a stub.
// ---------------------------------------------------------------------------

console.log('\nthe queries are well formed')

const source = readFileSync(new URL('./board.mjs', import.meta.url), 'utf8')
// Every query lives in a backtick literal. Odd-numbered pieces of a backtick
// split are the literals themselves.
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
