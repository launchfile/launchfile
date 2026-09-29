---
"@launchfile/aws": patch
---

`launchfile-aws` now refuses, before anything runs, an argument it does not
read — on stderr, exit 1, nothing written ([D-67] shape, #528). It used to
read its two flags by position and drop the rest: `translate app --regoin
eu-north-1` wrote a `main.tf` for the default region with nothing to say so,
`--region` as the last token fell through to the default the same way,
`launchfile-aws deploy app` printed usage and exited 0, and `translate --out
dir app` tried to open a file named `--out`. The operator's next step after
each is `terraform apply`.

Refused now:

- an unknown `--` flag: `no such flag --regoin`, with the known flags listed
  (`--out, --region, --rekey, --help`); a bare `--` has its own message
- `--out`, `--region` or `--rekey` with no value, or written `--flag=value`
- any verb but `translate` — `Unknown command: deploy`, exit 1
- a `--` token where the command belongs, a second Launchfile path, or a
  single-value flag given twice

Exit 0 is kept for a bare invocation and `--help` only. `--help` counts only
where a flag stands, never as the value after `--out`, `--region` or
`--rekey`. `translate` with no Launchfile path now prints its refusal on
stderr instead of usage on stdout; its exit code (1) is unchanged. The
Launchfile path is the first non-flag token, so flags may sit on either side
of it.

A script that passed a stray or typo'd flag, or a verb other than
`translate`, and relied on exit 0 now fails. Single-dash tokens are unchanged
(#529).
