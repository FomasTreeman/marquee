/**
 * Decides each issue's board column and labels from facts read through the
 * API, and writes both in one run. Chaining workflows through label events
 * failed silently, because events caused by GITHUB_TOKEN trigger nothing.
 * Only CONFIG is specific to this repository.
 */

/** Everything project-specific. */
export const CONFIG = {
  statusField: 'Status',
  /** Board columns, in the order a piece of work moves through them. */
  status: {
    todoHuman: 'Todo (Human)',
    todo: 'Todo',
    inProgress: 'In Progress',
    needsDecision: 'Needs Decision',
    inReview: 'In Review',
    done: 'Done',
  },
  labels: {
    /** Hand it to the agent. */
    agent: 'claude',
    /** Keep the agent off it. */
    human: 'no-ai',
    /** The agent is running right now. */
    working: 'claude-working',
    /** Waiting on a person to answer something. */
    blocked: 'needs-decision',
    /** A pull request is open for it. */
    review: 'in-review',
    /** The pull request is open but its checks are failing. */
    failing: 'ci-failing',
  },
}

/**
 * The column an issue belongs in. Pure; the first matching rule wins, so a
 * question for a person outranks an open pull request.
 */
export function statusFor(facts) {
  const { status, labels } = CONFIG
  const has = (name) => facts.labels.includes(name)

  if (facts.state === 'CLOSED') return status.done

  if (has(labels.blocked)) return status.needsDecision

  // A failing pull request is not ready to review.
  if (facts.openPr) {
    return facts.prFailing ? status.inProgress : status.inReview
  }

  if (has(labels.working)) return status.inProgress

  // `no-ai` issues are never the agent's to be stuck on. Otherwise three
  // failed attempts become a question for a person, matching ci-repair.yml;
  // without this a failed run sent the card back to Todo.
  if (has(labels.human)) return status.todoHuman

  if (facts.attempts >= 3) return status.needsDecision

  return status.todo
}

/**
 * Whether pick-up-todo.yml should hand this issue to the agent. The cooldown
 * paces retries of an issue whose run failed; three attempts cap the total.
 */
export function shouldPickUp(facts, hoursSinceHandover, cooldownHours = 1, graceMinutes = 10) {
  if (statusFor(facts) !== CONFIG.status.todo) return false
  // A run triggered moments ago has not yet set `claude-working`. Handing over
  // in that gap started duplicate runs that cancelled each other.
  if (facts.minutesSinceTrigger !== undefined && facts.minutesSinceTrigger < graceMinutes) return false
  if (hoursSinceHandover === undefined || hoursSinceHandover === null) return true
  return hoursSinceHandover >= cooldownHours
}

/**
 * The labels to add and remove, as a complete intent rather than a patch, so
 * no stale label survives a transition.
 */
export function labelsFor(facts) {
  const { labels } = CONFIG
  const has = (name) => facts.labels.includes(name)
  const add = []
  const remove = []
  const want = (name, yes) => (yes ? add : remove).push(name)

  const closed = facts.state === 'CLOSED'
  want(labels.review, !closed && !!facts.openPr && !facts.prFailing)
  want(labels.failing, !closed && !!facts.openPr && !!facts.prFailing)
  // `claude-working` belongs to the run; this only clears it.
  if (closed || facts.openPr) remove.push(labels.working)
  if (closed) remove.push(labels.blocked)
  // claude.yml reads `needs-decision` to let a reply resume the issue. Only
  // added here: the agent also sets it, and that one is not ours to clear.
  if (!closed && !facts.openPr && !has(labels.working) && !has(labels.human)
      && facts.attempts >= 3) add.push(labels.blocked)

  return {
    add: add.filter((l) => !facts.labels.includes(l)),
    remove: remove.filter((l) => facts.labels.includes(l)),
  }
}

// ---------------------------------------------------------------------------
// Everything below talks to GitHub; the rules above are pure.
// ---------------------------------------------------------------------------

/**
 * GraphQL caller for the board. User-owned Projects need a classic token with
 * `project` scope, so it is kept to the board alone; everything else uses
 * GITHUB_TOKEN rather than a classic token with `repo`.
 */
export function projectCaller(token) {
  return async (query, variables) => {
    const res = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        authorization: `bearer ${token}`,
        'content-type': 'application/json',
        'user-agent': 'marquee-board',
      },
      body: JSON.stringify({ query, variables }),
    })
    const body = await res.json()
    if (body.errors?.length) {
      throw new Error(body.errors.map((e) => e.message).join('; '))
    }
    if (!res.ok) throw new Error(`GraphQL ${res.status}`)
    return body.data
  }
}

/** The project, its Status field, and the option ids, fetched once. */
export async function loadProject(project, owner, number) {
  const q = await project(
    `query($owner: String!, $number: Int!, $field: String!) {
       user(login: $owner) {
         projectV2(number: $number) {
           id
           field(name: $field) {
             ... on ProjectV2SingleSelectField { id options { id name } }
           }
         }
       }
     }`,
    { owner, number, field: CONFIG.statusField },
  )
  const found = q.user?.projectV2
  if (!found) {
    throw new Error(
      `No project ${number} for ${owner}. A user-owned board needs a classic ` +
      `token with the \`project\` scope -- a fine-grained one cannot see it.`)
  }
  if (!found.field) throw new Error(`Project ${number} has no "${CONFIG.statusField}" field.`)
  return found
}

/**
 * What is true about an issue now, read rather than inferred from the event,
 * so a missed event costs nothing.
 */
export async function factsFor(github, owner, repo, number, now = Date.now()) {
  // `closedByPullRequestsReferences` holds only pull requests that close the
  // issue; scanning timeline cross-references counted any PR mentioning it.
  // `last: 50` because the timeline is oldest first and the newest labels count.
  const q = await github.graphql(
    `query($owner: String!, $repo: String!, $number: Int!) {
       repository(owner: $owner, name: $repo) {
         issue(number: $number) {
           id state
           labels(first: 50) { nodes { name } }
           closedByPullRequestsReferences(first: 20, includeClosedPrs: true) {
             nodes {
               number state
               commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
             }
           }
           timelineItems(last: 50, itemTypes: [LABELED_EVENT, UNLABELED_EVENT, REOPENED_EVENT]) {
             nodes {
               __typename
               ... on LabeledEvent { createdAt label { name } }
               ... on UnlabeledEvent { label { name } }
             }
           }
         }
       }
     }`,
    { owner, repo, number },
  )
  const issue = q.repository?.issue
  if (!issue) return undefined

  // The newest open pull request is the live one.
  const prs = issue.closedByPullRequestsReferences.nodes
    .filter((p) => p.state === 'OPEN')
    .sort((a, b) => a.number - b.number)
  const openPr = prs[prs.length - 1]
  const rollup = openPr?.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state

  return {
    id: issue.id,
    number,
    state: issue.state,
    labels: issue.labels.nodes.map((l) => l.name),

    openPr: openPr ? openPr.number : undefined,
    // Only a definite failure, so running checks do not flap the card.
    prFailing: rollup === 'FAILURE' || rollup === 'ERROR',

    // Agent runs started, counted from `claude-working` going on, since the
    // last reopen or answered `needs-decision`: those start a new brief.
    attempts: sinceLastRestart(issue.timelineItems.nodes)
      .filter((n) => n?.__typename === 'LabeledEvent' && n?.label?.name === CONFIG.labels.working).length,

    // Lets `shouldPickUp` see a run that is starting but not yet labelled.
    minutesSinceTrigger: minutesSince(newestTrigger(issue.timelineItems.nodes), now),
  }
}

function newestTrigger(nodes) {
  return nodes
    .filter((n) => n?.__typename === 'LabeledEvent' && n?.label?.name === CONFIG.labels.agent && n?.createdAt)
    .pop()
}

function minutesSince(event, now) {
  if (!event) return undefined
  const at = Date.parse(event.createdAt)
  return Number.isNaN(at) ? undefined : (now - at) / 60000
}

function sinceLastRestart(nodes) {
  const restart = (n) => n?.__typename === 'ReopenedEvent'
    || (n?.__typename === 'UnlabeledEvent' && n?.label?.name === CONFIG.labels.blocked)
  const at = nodes.map(restart).lastIndexOf(true)
  return at < 0 ? nodes : nodes.slice(at + 1)
}

/** Put one issue where it belongs, labels and card together. */
export async function reconcile({ github, project, projectApi, core, owner, repo, number }) {
  const facts = await factsFor(github, owner, repo, number)
  if (!facts) return
  const status = statusFor(facts)
  const { add, remove } = labelsFor(facts)

  for (const name of add) {
    await github.rest.issues.addLabels({ owner, repo, issue_number: number, labels: [name] })
      .catch((e) => core.warning(`#${number}: could not add ${name}: ${e.message}`))
  }
  for (const name of remove) {
    await github.rest.issues.removeLabel({ owner, repo, issue_number: number, name })
      // Already gone (404) is the state we wanted.
      .catch(() => {})
  }

  // Issues only; a pull request is reached through the issue it closes.
  // Read with the project token: the repository token silently sees no
  // `projectItems`, which made every run add a duplicate card.
  const existing = await projectApi(
    `query($id: ID!) {
       node(id: $id) {
         ... on Issue {
           projectItems(first: 20) {
             nodes {
               id
               project { id }
               fieldValueByName: fieldValues(first: 50) {
                 nodes {
                   ... on ProjectV2ItemFieldSingleSelectValue {
                     name
                     field { ... on ProjectV2SingleSelectField { id } }
                   }
                 }
               }
             }
           }
         }
       }
     }`,
    { id: facts.id },
  )
  const item = existing.node.projectItems.nodes
    .find((i) => i.project.id === project.id)
  let itemId = item?.id
  // Skip the mutation when the column is already right; the hourly sweep
  // otherwise wrote every issue.
  const current = item?.fieldValueByName?.nodes
    ?.find((v) => v?.field?.id === project.field.id)?.name
  if (!itemId) {
    const added = await projectApi(
      `mutation($p: ID!, $c: ID!) {
         addProjectV2ItemById(input: { projectId: $p, contentId: $c }) { item { id } }
       }`,
      { p: project.id, c: facts.id },
    )
    itemId = added.addProjectV2ItemById.item.id
  }

  const option = project.field.options.find((o) => o.name === status)
  if (!option) {
    // Loud: a missing column is a typo that otherwise looks like success.
    core.setFailed(
      `No "${CONFIG.statusField}" option named "${status}". ` +
      `The board has: ${project.field.options.map((o) => o.name).join(', ')}`)
    return
  }

  const moved = current !== status
  if (moved) {
    await projectApi(
      `mutation($p: ID!, $i: ID!, $f: ID!, $o: String!) {
         updateProjectV2ItemFieldValue(input: {
           projectId: $p, itemId: $i, fieldId: $f, value: { singleSelectOptionId: $o }
         }) { projectV2Item { id } }
       }`,
      { p: project.id, i: itemId, f: project.field.id, o: option.id },
    )
  }

  // Log only changes, so the sweep's rare corrections stand out.
  if (moved || add.length || remove.length) {
    core.info(
      `#${number} ${current ? `${current} -> ` : '-> '}${status}` +
      (add.length ? `  +${add.join(',')}` : '') +
      (remove.length ? `  -${remove.join(',')}` : ''),
    )
  }
}
