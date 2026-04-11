# Launchfile Governance

## Model: Constitutional Governance

The Launchfile specification is governed by a constitutional model: human authors define the principles; an AI applies them consistently.

---

## Roles

### Authors (Human)

Listed in the `AUTHORS` file at the repository root. Authors:

- Write and amend the constitution (DESIGN.md principles P-1 through P-13)
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
- Flags uncertainty and defers to Authors on low-confidence decisions
- Cannot amend principles — only apply them
- Publishes all reasoning publicly

The Steward posts on GitHub as `launchfile-steward[bot]` via a GitHub App, keeping its activity distinct from any human Author's. Its review framework grounds every verdict in the principles and decisions documented in `spec/DESIGN.md` and `spec/SPEC.md`, so any contributor can trace a review comment back to a published rule. Implementation lives outside this repository; the public commitment is the set of principles, decisions, and the transparent review output.

---

## Decision Process

### 1. Proposal

Open a GitHub issue with:

- Problem statement
- Proposed solution
- 3+ real-app motivations from the [catalog](../catalog/)
- Self-assessment against P-1 through P-13

### 2. AI Evaluation

The Steward evaluates on five axes:

1. **Principle alignment** — cite each relevant principle, pass/fail
2. **Precedent consistency** — cite relevant D-\* decisions
3. **Catalog impact** — percentage of catalog apps affected
4. **Complexity cost** — parser change required, or schema-only?
5. **Reversibility** — additive? can be removed without breaking existing files?

Output: **ACCEPT** / **REJECT** / **DEFER** with structured reasoning.

### 3. Author Review

- **ACCEPT** recommendations: Authors may approve or override
- **REJECT** recommendations: Authors may override with documented rationale (becomes a new D-\* decision)
- **DEFER** recommendations: Authors make the call and document the new precedent

### 4. Implementation

- PR against SPEC.md + JSON Schema + examples
- New D-\* entry in DESIGN.md documenting the decision

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
