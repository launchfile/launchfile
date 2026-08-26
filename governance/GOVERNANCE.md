# Launchfile Governance

## Model: Constitutional Governance

The Launchfile specification is governed by a constitutional model: human authors define the principles; an AI applies them consistently.

---

## Roles

### Authors (Human)

Listed in the `AUTHORS` file at the repository root. Authors:

- Write and amend the constitution (DESIGN.md principles P-1 through P-14)
- Have final authority over all specification decisions
- Can override any AI recommendation with documented rationale
- Add new Authors by consensus

The first active Author listed has tie-breaking authority when Authors disagree.

### Active Status

An Author is **active** if they have participated in a spec decision or contributed to the repository within the last 12 months. Inactivity does not remove an Author — it suspends their voting authority until they participate again.

### Adding Authors

While there are 5 or fewer Authors: by consensus (unanimity) of active Authors. Above 5: by 2/3 majority of active Authors.

### Removing Authors

- **Voluntary**: an Author may remove themselves from `AUTHORS` at any time.
- **Inactivity**: after 12 months of inactivity, 2/3 of remaining active Authors may vote to remove an inactive Author.
- An Author who is removed for inactivity may be re-added through the normal addition process.

### Last Resort

If no active Authors remain, the specification is frozen at its last published version. The MIT license permits anyone to fork and continue the work under a new name.

### Steward (AI)

An AI model that evaluates proposals against the documented principles:

- Must cite specific P-\* and D-\* references in every recommendation
- Defers to Authors exactly where the escalation table in [`spec/DESIGN.md` §1b](../spec/DESIGN.md#uncertainty-escalation) routes a question to them
- Changes to the Steward's operating rules — the evaluation process and the escalation table — are decided by Authors regardless of any Steward verdict; the Steward never self-ratifies a change to its own authority
- Cannot amend principles — only apply them
- Publishes all reasoning publicly

The Steward posts on GitHub as `launchfile-steward[bot]` via a GitHub App, keeping its activity distinct from any human Author's. Its review framework grounds every verdict in the principles and decisions documented in `spec/DESIGN.md` and `spec/SPEC.md`, so any contributor can trace a review comment back to a published rule. Implementation lives outside this repository; the public commitment is the set of principles, decisions, and the transparent review output. Rules that change verdict outcomes — the evaluation axes and the escalation table — are part of the public commitment; the machinery that applies them is not.

---

## Decision Process

### 1. Proposal

Open a GitHub issue with:

- Problem statement
- Proposed solution
- 3+ real-app motivations from the [catalog](../catalog/)
- Self-assessment against P-1 through P-14 — required for spec proposals. Process, documentation, and catalog-fix changes state that no principle applies instead of force-fitting citations; P-1 through P-14 govern the Launchfile format, not project process.

### 2. AI Evaluation

The Steward evaluates on five axes:

1. **Principle alignment** — cite each relevant principle, pass/fail
2. **Precedent consistency** — cite relevant D-\* decisions
3. **Catalog impact** — percentage of catalog apps affected
4. **Complexity cost** — parser change required, or schema-only?
5. **Reversibility** — additive? can be removed without breaking existing files?

Output: **ACCEPT** / **REJECT** / **DEFER** with structured reasoning.

**How an evaluation is produced.** Every evaluation runs as a staged process, not a single pass: **intake** (fast triage — duplicate check, already-addressed check against the decision log, completeness, bundling scope; a proposal the record already resolves is answered directly with the citation), then **grounding** (every factual claim verified against the repository and mapped to the principles and decisions it touches, before any judgment is formed; unverifiable claims are labeled as such, never treated as fact), then the **verdict**, rendered by applying the escalation table in [`spec/DESIGN.md` §1b](../spec/DESIGN.md#uncertainty-escalation) and naming the row it routed through — so the routing itself is contestable.

**Consistency measures.** For precedent-setting proposals the verdict stage runs twice, independently; any disagreement between the runs goes to the Authors instead of being posted. The Steward's tooling refuses to post a second verdict on a thread that already carries one: a superseding verdict must name what it replaces, and the replaced verdict is annotated and retained, never deleted.

### 3. Author Review

- **ACCEPT** recommendations: Authors may approve or override
- **REJECT** recommendations: Authors may override with documented rationale (becomes a new D-\* decision)
- **DEFER** recommendations: Authors make the call and document the new precedent

### 4. Implementation

- PR against SPEC.md + JSON Schema + examples
- New D-\* entry in DESIGN.md documenting the decision

### 5. Merge mechanics

Every pull request into `main` must pass the `steward/review` status check plus the repository's required CI checks. The `steward/review` check is named here because this document explains what it means; the CI check names are not, because they change as jobs are added or consolidated. The merge box on your PR always shows the current list.

What the `steward/review` state in your PR's merge box means, and what to do:

- **"Expected — waiting for status"** — this commit has not been reviewed yet. Merging is blocked until a review concludes.
- **In progress** — a steward review is running.
- **Green** — the steward accepted this exact commit.
- **Red** — the review found blockers. Read the review and its inline suggestions; suggestions can be committed with one click.
- **"Action required"** — the review did not reach a decision on this commit. Check the pull request conversation and the linked proposal issue: either a point is with the Authors to decide, or the review returned the PR to you as incomplete or already covered elsewhere — in that case the next move is yours.
- **Cancelled** — a review started on this commit and stopped before reaching a decision. Merging stays blocked until a review concludes on your current commit; a maintainer re-runs it. If it stays cancelled, ask in a comment.

The check binds to the head commit. Pushing new commits dismisses the previous review and returns the merge box to "Expected": the new commit is unreviewed, and that is expected behavior, not a malfunction.

**Contributing from a fork:** a maintainer must approve each CI workflow run on a fork pull request before it starts. This is a supply-chain safety measure applied to all external contributors, not a judgment of the contribution. If your CI shows "workflows awaiting approval", a maintainer will act on it — no action is needed from you.

---

## Constitutional Amendments

- Only Authors can amend P-\* principles
- Requires written rationale and review of existing D-\* decisions for consistency
- New principles require consensus among active Authors

---

## Transparency

- All AI evaluations are posted publicly on the GitHub issue
- Override decisions are documented as new D-\* entries in DESIGN.md
- The AI's reasoning is part of the permanent public record

---

## Why This Model

Specification governance is often bottlenecked by a single maintainer's availability and shaped by personal preference. This model separates the two concerns: Authors define *what matters* (the principles); the AI applies those principles *consistently* to every proposal.

This is an experiment. If it produces more consistent, transparent decisions than traditional governance, we will document what worked. If it does not, we will adapt. The principles and the decision record remain valuable regardless of who — or what — applies them.
