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

  // An agent has been at this and there is still nothing to review.
  //
  // This is the transition that was wrong. `claude-working` comes off when the
  // run ends, and with no pull request the answer fell straight through to
  // Todo -- so a card went *backwards*, from In Progress to the queue it
  // started in, and a run that had failed looked exactly like an issue nobody
  // had ever touched. Three of those in a row is not a queue position, it is a
  // question for a person, and three is the same count ci-repair.yml stops at
  // for the same reason: an agent that has not managed it in three goes is not
  // going to manage it on the ninth.
  //
  // Below three it stays in Todo on purpose, because Todo is drained by
  // pick-up-todo.yml now. It is a queue with a consumer rather than a place
  // things go to rest.
  // Whose queue this is, asked before how the agent got on, because they are
  // different questions. Needs Decision means the agent is stuck and wants an
  // answer; an issue marked for a person was never the agent's to be stuck on,
  // so stray attempts on one do not turn it into a question.
  if (has(labels.human)) return status.todoHuman

  if (facts.attempts >= 3) return status.needsDecision

  return status.todo
}

/**
 * Is this issue waiting for an agent that is not coming?
 *
 * `Todo` was a dead end, and it read as a queue. An issue reaches it only when
 * it is open, unblocked, has no pull request and carries no `claude-working`
 * -- and the sole thing that sets `claude-working` is a claude.yml run, which
 * starts on a label *event* or an `@claude` comment and nothing else. So an
 * issue sitting in Todo has by definition already spent its only trigger.
 * Nothing was ever going to fire again, and the card said "queued" while the
 * comment above promised an agent that was "about to take" it.
 *
 * Four issues sat like that for hours. The board was not lying about the facts
 * -- there really was no pull request and nothing really was running -- it was
 * describing a queue with no consumer at the far end.
 *
 * The cooldown is what keeps this from becoming one. An issue whose run fails,
 * or whose pull request is closed unmerged, returns to Todo and would
 * otherwise be picked up again on the next sweep, at a full run of
 * subscription usage each time.
 *
 * An hour, down from six. Six was set when the sweep was the only bound and
 * a failing issue could be offered forever; now three attempts send it to
 * Needs Decision, so the most a broken issue can cost is three runs, and the
 * cooldown only decides whether those happen this afternoon or over two days.
 * #76 failed in four seconds on a workflow bug and then sat for six hours
 * waiting to be allowed another go, which read as the loop having died.
 */
export function shouldPickUp(facts, hoursSinceHandover, cooldownHours = 1, graceMinutes = 10) {
  if (statusFor(facts) !== CONFIG.status.todo) return false
  // The label went on moments ago, so a run is already starting -- it just
  // has not set `claude-working` yet. Those seconds between the trigger and
  // the run's first label write are the only time an issue is in Todo *and*
  // spoken for, and this sweep fires on every run finishing, which is exactly
  // when triage tends to be labelling the next one. Handing over here started
  // a second run that then cancelled the first, or the other way round: a
  // quarter of all agent runs ended "cancelled" that way.
  if (facts.minutesSinceTrigger !== undefined && facts.minutesSinceTrigger < graceMinutes) return false
  // Never handed over, so this is the first offer.
  if (hoursSinceHandover === undefined || hoursSinceHandover === null) return true
  return hoursSinceHandover >= cooldownHours
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
  const has = (name) => facts.labels.includes(name)
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
  // Three runs with nothing to show is a question for a person, and the
  // column said so while the label did not. The label is what claude.yml
  // reads to let a reply restart the issue without `@claude`, so a card in
  // Needs Decision with no label was one a reply could not resume. Added
  // only, never removed short of closing: the agent sets it too, at fewer
  // than three, and that one is not the board's to clear.
  if (!closed && !facts.openPr && !has(labels.working) && !has(labels.human)
      && facts.attempts >= 3) add.push(labels.blocked)

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
export async function factsFor(github, owner, repo, number, now = Date.now()) {
  // The pull request *for* an issue is one that closes it -- `Closes #N` in
  // the body, or a link made in the Development sidebar -- and that is what
  // `closedByPullRequestsReferences` holds. This used to scan the timeline
  // for any CrossReferencedEvent, which is any pull request that so much as
  // mentions the number: three unrelated pull requests cited #76 in their
  // commit messages, so #76 sat In Review with no pull request of its own,
  // and nothing was going to pick it up while any of them stayed open.
  //
  // `includeClosedPrs` so a merged one is visible too. It is not used for the
  // column yet, but a merged pull request whose `Closes` never fired -- it
  // happens when the base was another branch -- is the case to add next.
  //
  // `last`, not `first`, on the timeline. It is oldest first, so `first: 50`
  // on an issue with any history returned the opening chatter and dropped
  // the newest labels off the end -- which are the ones the count depends on.
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

  // The newest, not the oldest. Where an issue has had a pull request
  // abandoned and reopened, the later one is the live one.
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
    // Only a definite failure counts. Checks still running are not a failure,
    // and treating them as one would flap the card on every push.
    prFailing: rollup === 'FAILURE' || rollup === 'ERROR',

    // How many times an agent has actually started on this, counted from the
    // `claude-working` label going on rather than from anything self-reported.
    // Without it a run that ended with nothing to show is indistinguishable
    // from an issue nobody has ever touched, which is how a card went
    // backwards from In Progress to Todo.
    //
    // Counted since the brief last changed: a reopen, or a person answering
    // a `needs-decision` question. An issue reopened because its merged fix
    // did not do what was intended starts a new job, and the run that
    // delivered the first fix was a success, not a failed attempt at this
    // one. Likewise a run that stopped to ask did what it was told, and the
    // answer is a new brief -- #91 had one proper stop and one failed run
    // after the answer, and counting both left it one failure from Needs
    // Decision when the rule everywhere else is three.
    attempts: sinceLastRestart(issue.timelineItems.nodes)
      .filter((n) => n?.__typename === 'LabeledEvent' && n?.label?.name === CONFIG.labels.working).length,

    // How long ago the agent label last went on, or undefined if it never
    // has. A label event is a run starting, and a run takes a minute or two
    // to set `claude-working`; `shouldPickUp` needs to know it is inside that
    // window rather than looking at an issue nobody has started.
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
  // Where the card already is. The hourly sweep visits every open issue
  // whether or not anything about it changed, and wrote the Status field on
  // every one of them regardless -- so an idle board still spent a mutation
  // per issue per hour, and every run's log read identically whether the
  // sweep had found something or nothing at all.
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
    // Loud. A missing column is a typo, and doing nothing about it looks
    // exactly like the automation working.
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

  // Only say something when something happened. A log line per issue per hour
  // that reads the same whether the sweep corrected anything or not is a log
  // nobody reads, and the sweep exists precisely to catch the rare case.
  if (moved || add.length || remove.length) {
    core.info(
      `#${number} ${current ? `${current} -> ` : '-> '}${status}` +
      (add.length ? `  +${add.join(',')}` : '') +
      (remove.length ? `  -${remove.join(',')}` : ''),
    )
  }
}
