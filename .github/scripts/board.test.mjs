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
import { CONFIG, statusFor, labelsFor, factsFor, reconcile } from './board.mjs'

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

// A fake `github` that records the query it was given and replays a timeline.
const fakeGithub = (nodes, spy = {}) => ({
  graphql: async (query) => {
    spy.query = query
    return {
      repository: {
        issue: {
          id: 'I_1', state: 'OPEN',
          labels: { nodes: [] },
          timelineItems: { nodes },
        },
      },
    }
  },
})

const facts = async (nodes, spy) => factsFor(fakeGithub(nodes, spy), 'o', 'r', 1)

console.log('\nreading a pull request off the timeline')

check('a cross-referenced pull request is found',
  (await facts([{ source: pr(7) }])).openPr, 7)

// A pull request linked through the Development sidebar rather than by being
// mentioned raises a ConnectedEvent and nothing else. The query asked for
// those and then only destructured `source`, which exists on
// CrossReferencedEvent alone, so every one of them mapped to undefined and was
// filtered away -- the issue's card never moved and nothing failed.
check('a connected pull request is found too',
  (await facts([{ subject: pr(7) }])).openPr, 7)

check('one pull request raising both events is still one',
  (await facts([{ source: pr(7) }, { subject: pr(7) }])).openPr, 7)

check('a closed pull request is not an open one',
  (await facts([{ source: pr(7, { state: 'CLOSED' }) }])).openPr, undefined)

check('the newest open pull request wins, not the oldest',
  (await facts([{ source: pr(7) }, { source: pr(9) }])).openPr, 9)

check('a red pull request is reported failing',
  (await facts([{ source: pr(7, {
    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE' } } }] } }) }])).prFailing, true)

check('checks still running are not a failure',
  (await facts([{ source: pr(7, {
    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'PENDING' } } }] } }) }])).prFailing, false)

// A timeline is oldest first. `first: 50` on an issue with any history returns
// the opening chatter and drops the newest pull request off the end.
const spy = {}
await facts([{ source: pr(7) }], spy)
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
function harness({ column, labels = [], nodes = [{ source: pr(7) }] }) {
  const calls = { mutations: [], labelWrites: [], logs: [] }
  const github = {
    graphql: async () => ({
      repository: { issue: {
        id: 'I_1', state: 'OPEN',
        labels: { nodes: labels.map((name) => ({ name })) },
        timelineItems: { nodes },
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

console.log(failed ? `\n  ${failed} failed\n` : '\n  all rules hold\n')
process.exit(failed ? 1 : 0)
