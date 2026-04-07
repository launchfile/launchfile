# Contributing to the Launchfile Spec

## How Decisions Are Made

Proposals are evaluated against the [13 design principles](DESIGN.md) by an AI Steward, with Authors (listed in [AUTHORS](../AUTHORS)) having final authority. See [GOVERNANCE.md](GOVERNANCE.md) for the full governance model.

## How to Propose Changes

The Launchfile specification evolves through a lightweight RFC process.

### Minor Changes (typos, clarifications, examples)

Open a pull request directly. No RFC needed.

### New Fields or Behavioral Changes

1. **Open an issue** describing the problem and proposed solution
2. **Include real-world motivation** — which apps need this? Show concrete Launchfile snippets
3. **Evaluate against design principles** — does the proposal align with P-1 through P-13? (see [DESIGN.md](DESIGN.md))
4. **Draft the spec change** — PR against SPEC.md with the new field/behavior documented
5. **Update the JSON Schema** — if adding fields, update `schema/launchfile.schema.json`
6. **Add or update examples** — demonstrate the new feature in `examples/`

### What Makes a Good Proposal

- Motivated by real apps (ideally 3+ examples from the [catalog](../catalog/))
- Additive (doesn't break existing Launchfiles — see P-13)
- Simple (if it can't be explained in one paragraph, it's probably too complex)
- Platform-agnostic (doesn't assume Docker, Kubernetes, or any specific runtime)

### What Gets Rejected

- Infrastructure-specific fields (violates P-1)
- Templating or conditional logic (violates P-6)
- Changes that break existing valid Launchfiles
- Features that solve one app's problem but add complexity for everyone

## Spec Review Checklist

When reviewing spec PRs, check:

- [ ] Does SPEC.md fully document the new field/behavior?
- [ ] Is the JSON Schema updated and consistent with the spec text?
- [ ] Are examples provided that demonstrate the feature?
- [ ] Does DESIGN.md have a new decision entry explaining the rationale?
- [ ] Does this align with the 13 design principles?
- [ ] Are existing valid Launchfiles still valid?
