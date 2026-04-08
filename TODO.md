# TODO

Tracked improvements and future work for the Launchfile project.

## Spec

- [ ] Formal dot-path grammar (PEG or BNF) — see DESIGN.md L-1
- [ ] Machine-readable resource property registry — see DESIGN.md L-4
- [ ] Environment-specific override pattern (`Launchfile.override`) — see DESIGN.md L-3
- [ ] Rejected proposals appendix (D-R*) for governance calibration — see DESIGN.md §1b

## SDK

- [ ] Publish `@launchfile/sdk` to npm
- [ ] Reserve unscoped `launchfile` npm package as redirect
- [ ] Post-parse validation for resource property typos (e.g. `$hoost`)
- [ ] YAML Language Server config snippet to suppress `$` warnings

## Catalog

- [ ] Integration test harness to validate catalog Launchfiles actually launch
- [ ] Address remaining yellow/green gaps in GAPS.md

## Tooling

- [ ] Automate CHANGELOG generation from conventional commits
- [ ] GitHub Actions CI for SDK (typecheck, test, lint)
- [ ] GitHub Actions for catalog validation (schema check on PR)

## Governance

- [ ] Website governance page (`www-org/src/pages/governance.astro`)
- [ ] First AI Steward evaluation on a real proposal (test the process)
