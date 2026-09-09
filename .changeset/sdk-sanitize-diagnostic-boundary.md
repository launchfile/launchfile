---
"@launchfile/sdk": patch
"launchfile": patch
---

Sanitize file-derived text at `validate`'s diagnostic boundaries. Every lint warning (`checkResourceProperties`, the unknown-storage-key check, D-24/D-40/D-43/D-44/D-50 checks) embeds strings taken verbatim from the parsed Launchfile — resource types, storage keys, component names — and so do the `host capabilities requested:` and `operator-supplied storage:` summary lines `validate` prints. A crafted key containing a newline or an ANSI escape sequence could inject a spoofed line or terminal control codes into that output (CWE-117) when validating an untrusted third-party Launchfile.

`sdk/src/errors.ts` now exports `stripControlInline`, applied where lint warnings are joined into `ValidateResult.warnings`, at every file-derived value `cmdValidate` prints (`name`, `components`, `requires`, `host capabilities requested:`, `operator-supplied storage:`, and each `deprecated:` line's path), and on the validation-failure lines `formatZodErrors` builds — a component name is an unconstrained map key, so it reaches the error path verbatim. It builds on the existing `stripControl` (ANSI-escape and control-character stripping) and additionally escapes any embedded tab or newline into its visible two-character form, so a diagnostic that must render as one line always does — `stripControl` alone keeps `\t`/`\n` literal, which is correct for its own multi-line command-output-tail use but not for a single-line diagnostic. No behavior change for any well-formed document.
