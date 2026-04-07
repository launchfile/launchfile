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

## Security

- [ ] Catalog signing: implement Sigstore/cosign or SHA256 manifest for catalog entries to verify integrity beyond GitHub access controls
- [ ] Consider `safe-regex` or RE2 library for executing output.pattern against command output (current fix validates regex compiles, but doesn't prevent all ReDoS)
- [ ] Process group cleanup in macOS provider: use `kill(-pid, signal)` to ensure child processes of `sh -c` are cleaned up on shutdown
- [ ] Scope Cloudflare API token to only the specific Pages projects needed (verify in Cloudflare dashboard)
- [ ] Docker provider: consider separate bridge networks for backing services vs. app components for network isolation
- [ ] Docker provider: pin images by digest (e.g. `postgres@sha256:...`) in generated compose files for reproducibility

## Tooling

- [ ] Automate CHANGELOG generation from conventional commits
- [x] GitHub Actions CI for SDK (typecheck, test, lint) — added `.github/workflows/ci.yml`
- [ ] GitHub Actions for catalog validation (schema check on PR)
- [ ] Enable Dependabot alerts in GitHub repo settings (Settings > Code security and analysis)
- [ ] Enable Dependabot security updates (auto-PRs for vulnerable deps)
- [ ] Upgrade `www-io/` to Astro 6, Cloudflare adapter 13, TypeScript 6 (currently untracked)
- [ ] Upgrade `providers/docker/` to TypeScript 6 (currently untracked)

## Governance

- [ ] Website governance page (`www-org/src/pages/governance.astro`)
- [ ] First AI Steward evaluation on a real proposal (test the process)
