/**
 * `launchfile diagnose [id|slug]` — show why the last launch failed.
 *
 * Reads the record the failing process captured (see `state/errors.ts`). It does
 * not re-run anything and it does not redact anything: by the time this runs the
 * provider's secret registry is gone with the process that held it, so the file
 * on disk is either already safe or unfixable. Redaction happens at capture.
 */

import {
	type LaunchDisposition,
	type LaunchErrorContext,
	type LaunchPhase,
} from "@launchfile/sdk";
import { errorsDir, readLaunchErrorRecord } from "../state/errors.js";
import { dockerSlugFor, findDeployment, loadIndex } from "../state/index.js";

export interface DiagnoseFlags {
	json?: boolean;
}

/** Injectable streams, so the stream discipline below is testable. */
export interface DiagnoseIO {
	out: (text: string) => void;
	err: (text: string) => void;
}

const defaultIO: DiagnoseIO = {
	out: (text) => process.stdout.write(text),
	err: (text) => process.stderr.write(text),
};

/** What each phase means, in the words a user would use. */
const PHASE_LABEL: Record<LaunchPhase, string> = {
	prereq: "prerequisite check",
	resolve: "resolving the source",
	parse: "reading the Launchfile",
	provision: "provisioning",
	prepare: "prepare slot (build/install)",
	release: "release slot",
	run: "run slot (start/dev)",
	health: "health check",
	bootstrap: "bootstrap slot",
	"on-demand": "on-demand command",
	unknown: "an unclassified step",
};

const DISPOSITION_LABEL: Record<LaunchDisposition, string> = {
	"failed-invocation": "failed the invocation — nothing is serving (D-48)",
	"failed-deploy": "failed the deploy — the release stage aborted it (D-48)",
	reported: "reported only — deploy status is unaffected (D-48)",
};

/** Render a record as the human-readable report. Pure, so it is easy to test. */
export function renderDiagnosis(context: LaunchErrorContext): string {
	const lines: string[] = [];
	const identity = context.app ?? context.slug ?? context.key;

	lines.push(`${identity} failed during ${PHASE_LABEL[context.phase]}`);
	lines.push(`  when:        ${context.timestamp}`);
	lines.push(`  provider:    ${context.provider}`);
	lines.push(`  phase:       ${context.phase}`);
	lines.push(`  disposition: ${DISPOSITION_LABEL[context.disposition]}`);
	if (context.component) lines.push(`  component:   ${context.component}`);
	if (context.exitCode !== undefined) lines.push(`  exit code:   ${context.exitCode}`);
	lines.push("");
	lines.push(context.message);

	if (context.command) {
		lines.push("", "Command:", `  ${context.command}`);
	}

	if (context.unsupplied?.length) {
		lines.push("", "Unsupplied required variables:");
		for (const u of context.unsupplied) {
			lines.push(`  ${u.component}: ${u.variable}`);
		}
	}

	for (const [label, text] of [
		["stderr", context.stderr],
		["stdout", context.stdout],
	] as const) {
		if (text?.trim()) lines.push("", `${label}:`, indent(text));
	}

	if (context.serviceLogs) {
		for (const [service, log] of Object.entries(context.serviceLogs)) {
			if (!log.trim()) continue;
			lines.push("", `logs (${service}):`, indent(log));
		}
	}

	if (context.warnings?.length) {
		lines.push("", "Warnings reported by this launch:");
		for (const warning of context.warnings) lines.push(`  - ${warning}`);
	}

	if (context.envKeys?.length) {
		// Names only. There is no field in the record that could hold a value.
		lines.push("", `Declared env variables: ${context.envKeys.join(", ")}`);
	}

	lines.push("", `Record: ~/.launchfile/errors/${context.key}.json`);
	return `${lines.join("\n")}\n`;
}

function indent(text: string): string {
	return text
		.split("\n")
		.map((line) => `  ${line}`)
		.join("\n");
}

/**
 * Resolve what the user typed to a record key. A record is filed under the
 * provider's key (a docker slug, or a hash of the source for a failure that
 * happened before a slug existed), so a deployment id or a user-assigned name
 * has to be translated first.
 */
async function resolveKey(target: string, dir: string): Promise<string> {
	const direct = await readLaunchErrorRecord(target, dir);
	if (direct) return target;

	const matches = findDeployment(await loadIndex(), target);
	const entry = matches[0]?.entry;
	return entry ? dockerSlugFor(entry) : target;
}

/**
 * Returns the process exit code. `--json` puts the record and nothing else on
 * stdout; every other word this command writes goes to stderr, so a pipe into
 * `jq` stays clean (CLAUDE.md: the two streams never mix).
 */
export async function handleDiagnose(
	target: string | undefined,
	flags: DiagnoseFlags,
	io: DiagnoseIO = defaultIO,
	dir: string = errorsDir(),
): Promise<number> {
	const key = target ? await resolveKey(target, dir) : undefined;
	const context = await readLaunchErrorRecord(key, dir);

	if (!context) {
		io.err(
			target
				? `No captured launch failure for "${target}".\n`
				: "No captured launch failure.\n",
		);
		io.err("A failure is recorded the next time `launchfile up` or `dev` fails.\n");
		return 1;
	}

	if (flags.json) {
		io.out(`${JSON.stringify(context, null, 2)}\n`);
		return 0;
	}

	io.out(renderDiagnosis(context));
	return 0;
}
