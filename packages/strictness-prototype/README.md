# Operator strictness experiment

Runnable, private demonstration for [RFC C #444](https://github.com/launchfile/launchfile/issues/444), related to [#314](https://github.com/launchfile/launchfile/issues/314). This is a draft for review. It does not install a flag in the shipping CLI or change the SDK, schema, spec, or providers.

The [Steward verdict is DEFER](https://github.com/launchfile/launchfile/issues/444#issuecomment-5603457977): Authors must decide whether operator policy may add refusal to a warn-only execution gap. A shared diagnostic record emitted natively by all three providers is a prerequisite to shipping any flag. The sidecar adapters here demonstrate that proposed record; they do not complete that migration.

## Author and operator experience

The app file is unchanged:

```yaml
name: nightly-job
image: example/nightly-job:latest
schedule: "0 2 * * *"
```

The fixture also includes portable runtime/commands so the AWS translator can exercise its source-contract path and macOS can illustrate its source-mode seam. This is an illustrative job, not a catalog motivation or a runnable container image. The experiment never fetches the image or executes those commands.

From this package directory, after `bun install` at the repository root:

```sh
bun run verify
bun run demo
bun run plan docker fixtures/Launchfile
bun run plan docker fixtures/Launchfile --strict
bun run plan aws fixtures/Launchfile --strict
bun run plan macos-dev fixtures/Launchfile --strict
```

The strict commands intentionally exit **1**. Their JSON says this is a policy result, not deployment readiness. The demonstration matrix runs both policies successfully as an experiment and exits 0. All script entry points use Bun; the macOS package is declared for macOS, so the complete three-provider verification is currently a macOS reproduction path.

| Provider seam | Default policy                         | Strict schedule policy                       | Actual work performed                                                |
| ------------- | -------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------- |
| Docker        | Warning, allow experiment continuation | Same warning, then refusal                   | Real `launchToCompose`, no Docker daemon                             |
| AWS           | Warning, allow experiment continuation | Same warning, then non-success policy result | Real `translate`, retain HCL/ledger, no apply                        |
| macOS dev     | Warning, allow experiment continuation | Same warning, then refusal                   | Production `scheduleWarning` and host-refusal helpers, no `launchUp` |

`runWithPolicy` calls an injected lifecycle callback only after all diagnostics have been delivered and the decision permits it. Tests and `demo` inject an in-memory continuation; no process, container, Homebrew service, AWS resource, or application starts. In production, the callback seam would need to surround the provider's actual start path. This experiment cannot establish that every gap is knowable before provisioning.

## Proposed shared diagnostic record

```json
{
  "code": "SCHEDULE_NOT_EXECUTED",
  "component": "default",
  "field": "schedule",
  "reason": "This provider does not execute the declared schedule; the app may schedule itself.",
  "next_action": "Choose a provider that executes schedule, or explicitly accept this gap with the default policy.",
  "severity": "warning",
  "phase": "execution"
}
```

All three proposed adapters emit this record from typed component/capability facts. No policy decision parses warning text. Original Docker warnings/YAML and the AWS HCL/conformance ledger remain available unchanged; the macOS adapter calls its existing warning helper. The policy allowlist has exactly one stable code, `SCHEDULE_NOT_EXECUTED`; message wording cannot change eligibility.

Strictness keeps the warning object and adds `STRICT_POLICY_REFUSAL` after it. D-51's warning obligation remains true in both modes. Default behavior returns the same diagnostic records without adding a refusal. Unknown codes are not implicitly eligible, and an unsupported requested policy produces `POLICY_UNSUPPORTED` instead of silently falling back. The code names are experimental and do not reserve public API names.

Mandatory errors are an independent floor. Unsupplied required environment values and refused required host capabilities remain errors with either policy; Docker's unbound operator storage also remains an error. The demo's provider adapters use an empty operator environment, no optional-resource provisioning, and no supplied storage bindings. They are not a complete readiness validator. Callers are responsible for selecting the relevant component closure before observation; no component-selection CLI is implemented here.

The CLI uses `readStrictnessLaunch` to refuse the TLS, public HTTPS, and variants proposal markers before permissive normalization could strip them. This targeted boundary does not turn strictness into a generic unknown-field validator. The library's `observe` accepts an already normalized launch; its caller owns that same input boundary and must not pass a contract that normalization silently weakened.

D-40's validation-only diagnostic and the D-46/D-56 resource-property warnings are deliberately absent from the escalation allowlist. Tests supply representative records with those codes and prove that strictness leaves them untouched, including misleading schedule-like text. These are policy-boundary tests, not a claim that production providers already emit those codes. Existing provider source and default output remain unchanged because this package does not modify them.

The display sink reuses the existing provider redactors for component, field, reason, and next action. A registered short declared secret and credentials embedded in a URL are tested. Stable identifiers remain intact. As in the existing providers, a caller must register sensitive values before presenting diagnostics. The CLI only prints policy diagnostics, never the generated HCL, Compose environment, or raw input. Parsing failures produce a generic diagnostic because raw parser exceptions can include secret-bearing YAML before redaction registration.

## Decision requested, separately from implementation

Proposed **D-next** for Authors to assess, not an amendment committed by this PR:

> An explicitly requested operator policy may add refusal to the unexecuted-schedule execution gap. Providers still emit the D-51 warning in both modes. The initial eligible code covers only unexecuted scheduling; D-40 and the D-46/D-56 property cases are ineligible. Mandatory failures cannot be waived by policy. All supported providers must emit the shared record and honor the policy, or explicitly reject an unsupported policy, before the flag ships.

This follows the Steward's distinction: D-51 does not need weakening, but the new operator input needs its own decision. The existing refusal-before-start precedent is [PROVIDERS.md §11](../../spec/PROVIDERS.md) / D-53. Runtime failures discovered later still require the ordinary provider error/cleanup path; the experiment propagates a start callback failure without retrying or masking it.

The demand here is **operator-side**, not app-side. A search of the current catalog apps and drafts found no `schedule:` declaration, consistent with the Steward's reported 0/72 apps and 0/41 drafts at review time. `spec/examples/cron-job.yaml` is an illustration; an application's own scheduling environment variable is not this field. Scheduling is the smallest first case because it is rare and already has a ratified diagnostic. Authors must decide whether operator demand can substitute for governance's three real-app motivations here.

Principles: P-1/P-11 put policy with the operator; P-5 motivates one record and consistent behavior across providers; P-13/P-14 preserve existing files and default consumers. P-2/P-3/P-4/P-6/P-7/P-8/P-9/P-10/P-12 receive no new authoring syntax, configuration, resources, or expression rules. The unresolved tension is the new operator-controlled escalation axis, not TLS or variants. Those RFCs are independent.

## Verification and limits

`bun run verify` builds the SDK and all three providers, checks this package under strict TypeScript, and runs **54 tests** covering unchanged real translator output, three-provider diagnostic shape, warning-before-refusal ordering, no continuation on strict refusal, mandatory env/host and validation failures, satisfied synthetic scheduling, excluded/future codes, redaction, parser-error secrecy, refusal of foreign proposal contracts, unsupported policy, and subprocess exit behavior.

No real scheduler, deployment, Terraform validation, release/build integration, cleanup integration, or complete gap inventory is provided. The fulfilled-schedule test passes a synthetic capability fact; none of the three current providers gained scheduling. The macOS seam uses internal compiled exports and will need a supported shared interface before production adoption. There is no evidence here that a generalized strict policy is ready to ship.

The lockfile was generated with Bun. Besides the private workspace entry and current Bun types, Bun refreshed stale workspace versions to match the existing package manifests; no production manifest was edited.
