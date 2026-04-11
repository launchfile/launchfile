# Open Source Governance Research for Launchfile

This note captures governance and maintainer patterns from mature open source projects so Launchfile can tighten the steward persona and operating instructions without losing its constitutional model.

## Repeated Patterns Across Strong Projects

### 1. Authority is explicit, but used sparingly

Healthy projects define who can make final decisions, then treat that authority as a last resort rather than a first reflex.

- Python's steering council has broad authority, but is expected to seek consensus before acting formally and to use its powers as little as possible.
- Node.js explicitly uses a consensus-seeking model.
- Rust separates project coordination from other responsibilities instead of collapsing everything into one authority path.

**Implication for Launchfile:** keep the Authors + Steward split, but teach the steward to seek the narrowest acceptable path before escalating to REJECT or DEFER.

### 2. Maintainership is broader than merge access

Mature projects treat triage, review, docs, support, and community work as real contributions, not side chores.

- Python explicitly counts triage, reviews, community management, support, infra, and design work as contributions that matter for trusted membership.
- Django distinguishes triagers, reviewers, bug fixers, and mergers, and makes most of those roles open to anyone.

**Implication for Launchfile:** the steward should reinforce contributor ladders, not just gate merges.

### 3. Triage is a workflow, not an improvisation

Strong projects classify incoming work quickly and make the next step obvious.

- Django uses explicit ticket stages and flags such as accepted, needs tests, and patch needs improvement.
- Kubernetes classifies issues by kind, ownership, priority, and state; duplicates, support requests, and missing-info reports each have a defined path.

**Implication for Launchfile:** add an explicit issue triage workflow to the steward instructions instead of treating everything like a PR review.

### 4. Closing issues well is part of being welcoming

The best maintainers do not leave people guessing why something was closed or how to proceed.

- Django says to explain the decision, say how the ticket could be improved or reopened, reference duplicates, and stay polite because closure can be discouraging.
- Kubernetes routes support questions away from the issue tracker, references the right channel, and closes duplicates and unreproducible reports with an explanation.

**Implication for Launchfile:** issue closure language should always include rationale, next step, and a polite reopening path.

### 5. Reviews should separate blockers from optional guidance

High-bar projects are direct, but they do not turn every possible improvement into a merge blocker.

- Django advises reviewers to use GitHub suggestions for small or nitpicky feedback and to ask why before requesting several changes if the author's approach differs from expectation.
- Kubernetes distinguishes priority, backlog, and awaiting-more-evidence instead of flattening all feedback into the same urgency level.

**Implication for Launchfile:** keep a hard quality bar, but distinguish merge blockers from optional suggestions and future ideas.

### 6. Governance and moderation are separate concerns

Technical disagreement and conduct violations need different processes.

- Rust documents leadership coordination separately from moderation.
- Contributor Covenant gives community leaders enforcement responsibilities and expects fair corrective action, with moderation reasons communicated when appropriate.

**Implication for Launchfile:** the steward should not use design review as a substitute for moderation. Conduct issues should be escalated through a separate path.

### 7. Healthy repos front-load expectations

Good projects reduce ambiguity with clear templates, contributor docs, support routing, and labels.

- GitHub's own guidance recommends contributor guidelines, code of conduct, support resources, community health files, and labels to make contributions more useful.
- Kubernetes relies heavily on labels, templates, and canned triage flows to keep a large tracker workable.

**Implication for Launchfile:** the steward docs should be paired with crisp issue-routing expectations, not just evaluation principles.

## Gaps Worth Addressing Later

- The repo does not currently expose a `CODE_OF_CONDUCT.md`. A constitutional governance model is stronger when technical decision-making and conduct enforcement have separate homes.
- The repo has issue templates, but `bug-or-question.yml` still mixes support/questions with actionable bug reports. Splitting those flows would reduce noise in the tracker.
- If Launchfile adds GitHub Discussions or another support venue, the steward docs should explicitly route usage questions there.

## Sources

- Python PEP 13: https://peps.python.org/pep-0013/
- Node.js governance: https://nodejs.org/en/about/governance
- Rust Forge governance: https://forge.rust-lang.org/governance/index.html
- Django ticket triage: https://docs.djangoproject.com/en/dev/internals/contributing/triaging-tickets/
- Kubernetes issue triage: https://www.kubernetes.dev/docs/guide/issue-triage/
- GitHub healthy contributions guidance: https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions
- Contributor Covenant 2.1: https://www.contributor-covenant.org/version/2/1/code_of_conduct/
