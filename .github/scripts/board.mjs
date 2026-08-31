/**
 * The board, decided in one place from facts.
 *
 * ## Why this is one file
 *
 * The state of an issue used to be spread across three workflows. `claude.yml`
 * set `claude-working`, `pr-labels.yml` set `in-review`, and
 * `project-automation.yml` watched for label events and moved the card. Each
 * was reasonable alone and together they were unreliable, for one specific
 * reason: **GitHub does not run a workflow off an event that GITHUB_TOKEN
 * caused.** So a label applied by one workflow was invisible to the next, the
 * card never moved, and nothing failed anywhere. Only the one status that
 * happened to be set before an action with its own token ever worked.
 *
 * Chaining workflows through label events was the mistake. This computes the
 * answer from what is *true* -- the issue's state, its linked pull requests,
 * whether their checks pass -- and writes the label and the card itself, in
 * one run, with no second trigger to be suppressed.
 *
 * ## Portable
 *
 * Nothing here is specific to this repository except CONFIG below. Copy the
 * file, change the project number and the labels, and it works.
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
 * The column an issue belongs in.
 *
 * Pure, and the only place the rule lives. Order is priority: the first thing
 * that is true wins, so a question waiting on a person outranks a pull request
 * sitting there, because one of those needs somebody and the other does not.
 *
 * `facts` is deliberately plain data so this can be tested without a network.
 */
export function statusFor(facts) {
  const { status, labels } = CONFIG
  const has = (name) => facts.labels.includes(name)

  if (facts.state === 'CLOSED') return status.done

  // Waiting on a person, whichever kind of waiting it is.
  if (has(labels.blocked)) return status.needsDecision

  // A pull request exists. Its health decides whether it is yours to read or
  // still the machine's to finish -- a red pull request is not review-ready,
  // and putting it in the same column as a green one is how a person ends up
  // reviewing something that does not build.
  if (facts.openPr) {
    return facts.prFailing ? status.inProgress : status.inReview
  }

  if (has(labels.working)) return status.inProgress

  // Nobody has picked it up. Which queue it sits in depends on who is meant
  // to: an issue marked for a person should not sit in the same column as one
  // the agent is about to take, or the agent's queue reads as a to-do list
  // nobody is working through.
  return has(labels.human) ? status.todoHuman : status.todo
}

/**
 * The labels an issue should carry, given the same facts.
 *
 * Returned as a complete intent -- what to add and what to remove -- rather
 * than as a patch, so there is no way for a label to survive a transition that
 * should have cleared it. Stale labels are the whole reason a board stops
 * being believed.
 */
export function labelsFor(facts) {
  const { labels } = CONFIG
  const add = []
  const remove = []
  const want = (name, yes) => (yes ? add : remove).push(name)

  const closed = facts.state === 'CLOSED'
  want(labels.review, !closed && !!facts.openPr && !facts.prFailing)
  want(labels.failing, !closed && !!facts.openPr && !!facts.prFailing)
  // `claude-working` is owned by the run itself, which knows something this
  // cannot: whether it is still going. Only cleared here, never set.
  if (closed || facts.openPr) remove.push(labels.working)
  if (closed) remove.push(labels.blocked)

  return {
    add: add.filter((l) => !facts.labels.includes(l)),
    remove: remove.filter((l) => facts.labels.includes(l)),
  }
}

// ---------------------------------------------------------------------------
// Everything below talks to GitHub. The rules above do not, on purpose.
// ---------------------------------------------------------------------------

/**
 * A GraphQL caller for the project, authenticated separately.
 *
 * A user-owned Projects board has no fine-grained token permission -- that
 * exists for organisation projects only -- so reaching one needs a classic
 * token with `project` scope. Classic tokens are coarse, so this keeps it as
 * far from everything else as possible: it is used for the board and nothing
 * else, while labels and issue reads go through the workflow's own
 * GITHUB_TOKEN, which cannot reach the board but does not need to.
 *
 * The alternative was one classic token carrying `repo` as well, which would
 * have granted write access to every repository on the account in order to add
 * a label to this one.
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
 * What is true about an issue right now.
 *
 * Read rather than inferred from whatever event woke us up. An event says what
 * changed; this says what *is*, which is the only thing the rules should
 * depend on -- and it means a missed event costs nothing, because the next run
 * for any reason puts the card right.
 */
export async function factsFor(github, owner, repo, number) {
  const q = await github.graphql(
    `query($owner: String!, $repo: String!, $number: Int!) {
       repository(owner: $owner, name: $repo) {
         issue(number: $number) {
           id state
           labels(first: 50) { nodes { name } }
           timelineItems(first: 50, itemTypes: [CROSS_REFERENCED_EVENT, CONNECTED_EVENT]) {
             nodes {
               ... on CrossReferencedEvent {
                 source {
                   ... on PullRequest {
                     number state isDraft
                     commits(last: 1) { nodes { commit {
                       statusCheckRollup { state }
                     } } }
                   }
                 }
               }
             }
           }
         }
       }
     }`,
    { owner, repo, number },
  )
  const issue = q.repository?.issue
  if (!issue) return undefined

  const prs = issue.timelineItems.nodes
    .map((n) => n.source)
    .filter((s) => s && s.number && s.state === 'OPEN')
  const openPr = prs[0]
  const rollup = openPr?.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state

  return {
    id: issue.id,
    number,
    state: issue.state,
    labels: issue.labels.nodes.map((l) => l.name),

    openPr: openPr ? openPr.number : undefined,
    // Only a definite failure counts. Checks still running are not a failure,
    // and treating them as one would flap the card on every push.
    prFailing: rollup === 'FAILURE' || rollup === 'ERROR',
  }
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
      // A label that is already gone is a 404, and it means the state is what
      // we wanted anyway.
      .catch(() => {})
  }

  // Only issues go on the board. A pull request is reachable from the issue it
  // closes, and adding both put thirty-four cards beside thirteen -- a board
  // showing the same work twice is one nobody reads.
  // Which card, if any, this issue already has. Asked through the project
  // token: `projectItems` on an issue is invisible to a token that cannot see
  // the project, and reading it with the repository token returned nothing --
  // silently, so every run would have added a duplicate card.
  const existing = await projectApi(
    `query($id: ID!) {
       node(id: $id) {
         ... on Issue { projectItems(first: 20) { nodes { id project { id } } } }
       }
     }`,
    { id: facts.id },
  )
  let itemId = existing.node.projectItems.nodes
    .find((i) => i.project.id === project.id)?.id
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
    // Loud. A missing column is a typo, and doing nothing about it looks
    // exactly like the automation working.
    core.setFailed(
      `No "${CONFIG.statusField}" option named "${status}". ` +
      `The board has: ${project.field.options.map((o) => o.name).join(', ')}`)
    return
  }

  await projectApi(
    `mutation($p: ID!, $i: ID!, $f: ID!, $o: String!) {
       updateProjectV2ItemFieldValue(input: {
         projectId: $p, itemId: $i, fieldId: $f, value: { singleSelectOptionId: $o }
       }) { projectV2Item { id } }
     }`,
    { p: project.id, i: itemId, f: project.field.id, o: option.id },
  )

  core.info(
    `#${number} -> ${status}` +
    (add.length ? `  +${add.join(',')}` : '') +
    (remove.length ? `  -${remove.join(',')}` : ''),
  )
}
