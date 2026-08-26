#!/usr/bin/env node
/**
 * Fail when normative spec prose points forward at a closed GitHub issue.
 *
 * The convention this enforces: a sentence that promises future work must name
 * an OPEN tracker. A closed issue may appear only as a parenthetical archive
 * ("(#205, closed)", "This closed with #192"), never as the thing that will
 * settle, track, or land something. A reader following a forward-looking
 * citation to a closed issue reasonably concludes the question was answered.
 *
 * Usage:
 *   node scripts/lint-spec-citations.mjs [paths...]   # default: spec/
 *
 * Auth: reads GITHUB_TOKEN if set (raises the rate limit and is what CI
 * supplies). Unauthenticated runs work for small diffs but share the 60/hr
 * anonymous budget.
 *
 * Exit codes: 0 clean, 1 violations found, 2 the linter itself failed.
 */

import { readFileSync } from "node:fs";
import { readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const REPO = process.env.GITHUB_REPOSITORY ?? "launchfile/launchfile";
const TOKEN = process.env.GITHUB_TOKEN ?? "";

/**
 * Forward-looking citation shapes. Each must capture the issue number in group
 * 1. Deliberately conservative: provenance idioms the spec uses constantly
 * ("See #211", "ratifying parent #113", "This closed with #192", "predecessor
 * #207") are NOT matched, because a closed issue is the correct target there.
 */
const PATTERNS = [
	{ name: "until #N", re: /\buntil\s+\[?#(\d+)/gi },
	{ name: "tracked in/as/by #N", re: /\btracked\s+(?:in|as|by)\s+\[?#(\d+)/gi },
	{ name: "#N settles", re: /\[?#(\d+)\]?(?:\([^)]*\))?\s+settles\b/gi },
	{ name: "#N lands", re: /\[?#(\d+)\]?(?:\([^)]*\))?\s+lands\b/gi },
	{ name: "pending #N", re: /\bpending\s+\[?#(\d+)/gi },
	{ name: "awaiting #N", re: /\bawait(?:s|ing)\s+\[?#(\d+)/gi },
	{ name: "blocked on #N", re: /\bblocked\s+on\s+\[?#(\d+)/gi },
	{ name: "is #N (tracking assignment)", re: /\bis\s+\[#(\d+)\]/gi },
];

function walk(path) {
	if (statSync(path).isFile()) return extname(path) === ".md" ? [path] : [];
	return readdirSync(path).flatMap((entry) => walk(join(path, entry)));
}

/** Issue state, or null when GitHub could not be reached for it. */
async function issueState(number) {
	const headers = { accept: "application/vnd.github+json", "user-agent": "launchfile-spec-lint" };
	if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
	try {
		const res = await fetch(`https://api.github.com/repos/${REPO}/issues/${number}`, { headers });
		if (!res.ok) return null;
		const body = await res.json();
		// A PR is also an issue here. A merged PR is a legitimate archive target
		// ("shipped in #220"), so only real issues are candidates for the rule.
		if (body.pull_request) return "pull_request";
		return body.state;
	} catch {
		return null;
	}
}

const targets = process.argv.slice(2);
const files = (targets.length ? targets : ["spec"]).flatMap(walk).sort();

const hits = [];
for (const file of files) {
	const lines = readFileSync(file, "utf8").split("\n");
	lines.forEach((text, i) => {
		for (const { name, re } of PATTERNS) {
			re.lastIndex = 0;
			let m;
			while ((m = re.exec(text)) !== null) {
				hits.push({ file, line: i + 1, number: Number(m[1]), shape: name, text: text.trim() });
			}
		}
	});
}

const numbers = [...new Set(hits.map((h) => h.number))];
const states = new Map();
for (const n of numbers) states.set(n, await issueState(n));

const violations = hits.filter((h) => states.get(h.number) === "closed");
const unknown = hits.filter((h) => states.get(h.number) === null);

for (const h of hits) {
	const state = states.get(h.number);
	const label = state === null ? "unknown" : state;
	console.log(`  ${label.padEnd(12)} ${h.file}:${h.line}  #${h.number}  (${h.shape})`);
}

if (unknown.length > 0) {
	console.warn(
		`\nwarning: could not resolve ${unknown.length} citation(s) against GitHub; not failing on those.`,
	);
}

if (violations.length === 0) {
	console.log(`\nOK — ${files.length} file(s), ${hits.length} forward-looking citation(s), none closed.`);
	process.exit(0);
}

console.error(`\nFAIL — ${violations.length} forward-looking citation(s) point at a closed issue:\n`);
for (const v of violations) {
	console.error(`  ${v.file}:${v.line}  #${v.number}  matched "${v.shape}"`);
	console.error(`    ${v.text.slice(0, 200)}\n`);
}
console.error(
	"A sentence promising future work must name an OPEN tracker. If the work is done,\n" +
		"rewrite it past-tense and cite the decision that executed it, keeping the issue as a\n" +
		"parenthetical archive — e.g. \"executed as D-54 (#120, closed)\". If it is still owed,\n" +
		"file a successor issue and cite that instead.",
);
process.exit(1);
