/**
 * Argument-parsing rules (#248): a value-taking flag's value must never be
 * read as a positional, and the `--flag=value` spelling must parse — it is
 * the form the CLI roadmap's UC4 itself uses.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	BOOLEAN_FLAGS,
	flagPresent,
	getFlagValue,
	getFlagValues,
	getPositional,
	hasFlag,
	parseStoragePairs,
	suggestFlag,
	unknownFlags,
	VALUE_FLAGS,
	valuedBooleanFlag,
} from "../cli-args.js";

describe("getPositional (#248)", () => {
	it("skips the value of a value-taking flag", () => {
		const args = ["up", "--name", "foo"];
		expect(getPositional(args, 0)).toBe("up");
		// `foo` is --name's value, not the up target.
		expect(getPositional(args, 1)).toBeUndefined();
	});

	it("still finds a positional placed after a value-taking flag", () => {
		const args = ["up", "--name", "foo", "./app"];
		expect(getPositional(args, 0)).toBe("up");
		expect(getPositional(args, 1)).toBe("./app");
	});

	it("covers --component the same way", () => {
		const args = ["bootstrap", "--component", "web", "ghost"];
		expect(getPositional(args, 1)).toBe("ghost");
	});

	it("treats --flag=value as a single token needing no skip", () => {
		const args = ["up", "--name=foo", "./app"];
		expect(getPositional(args, 1)).toBe("./app");
		expect(getPositional(["up", "--name=foo"], 1)).toBeUndefined();
	});

	it("does not skip the token after a boolean flag", () => {
		const args = ["up", "--dry-run", "ghost"];
		expect(getPositional(args, 1)).toBe("ghost");
	});

	it("skips the --url value so a public URL is never the up target (D-58)", () => {
		const args = ["up", "--url", "https://x.example.com"];
		expect(getPositional(args, 0)).toBe("up");
		expect(getPositional(args, 1)).toBeUndefined();
		expect(getPositional(["up", "--url", "https://x.example.com", "ghost"], 1)).toBe("ghost");
	});

	it("skips --storage values so a pair is never the up target (D-50)", () => {
		const args = ["up", "--storage", "music=/srv/music", "--storage", "books=/srv/books"];
		expect(getPositional(args, 0)).toBe("up");
		expect(getPositional(args, 1)).toBeUndefined();
		expect(getPositional(["up", "--storage", "music=/x", "ghost"], 1)).toBe("ghost");
	});
});

describe("getFlagValues (repeatable --storage, D-50)", () => {
	it("collects every occurrence, in order", () => {
		const args = ["up", "--storage", "music=/a", "--storage", "books=/b"];
		expect(getFlagValues(args, "storage")).toEqual(["music=/a", "books=/b"]);
	});

	it("reads the inline --flag=value form too, mixed with the separate form", () => {
		const args = ["up", "--storage=music=/a", "--storage", "books=/b"];
		expect(getFlagValues(args, "storage")).toEqual(["music=/a", "books=/b"]);
	});

	it("returns an empty list when the flag is absent", () => {
		expect(getFlagValues(["up"], "storage")).toEqual([]);
	});
});

describe("parseStoragePairs (D-50)", () => {
	it("splits each pair on the first = only", () => {
		expect(parseStoragePairs(["music=/srv/music", "web.books=/x=y"])).toEqual({
			music: "/srv/music",
			"web.books": "/x=y",
		});
	});

	it("rejects a pair with no =", () => {
		expect(() => parseStoragePairs(["music"])).toThrow('Invalid --storage value "music"');
	});

	it("rejects an empty volume name or an empty path", () => {
		expect(() => parseStoragePairs(["=/srv/music"])).toThrow("Invalid --storage value");
		expect(() => parseStoragePairs(["music="])).toThrow("Invalid --storage value");
	});

	it("rejects a duplicate key instead of silently picking one", () => {
		expect(() => parseStoragePairs(["music=/a", "music=/b"])).toThrow(
			'Duplicate --storage key "music"',
		);
	});
});

describe("getFlagValue", () => {
	it("reads the separate-token form", () => {
		expect(getFlagValue(["up", "--name", "foo"], "name")).toBe("foo");
	});

	it("reads the --flag=value form (UC4's spelling)", () => {
		expect(getFlagValue(["up", "--name=ghost-test"], "name")).toBe("ghost-test");
	});

	it("returns undefined when the flag is absent or has no value", () => {
		expect(getFlagValue(["up"], "name")).toBeUndefined();
		expect(getFlagValue(["up", "--name"], "name")).toBeUndefined();
	});
});

describe("hasFlag", () => {
	it("matches long and short forms", () => {
		expect(hasFlag(["logs", "--follow"], "follow")).toBe(true);
		expect(hasFlag(["logs", "-f"], "follow")).toBe(true);
		expect(hasFlag(["logs"], "follow")).toBe(false);
	});
});

describe("flagPresent", () => {
	it("matches the bare and inline long forms only", () => {
		expect(flagPresent(["up", "--name"], "name")).toBe(true);
		expect(flagPresent(["up", "--name=a"], "name")).toBe(true);
		expect(flagPresent(["up", "-n"], "name")).toBe(false);
		expect(flagPresent(["up"], "name")).toBe(false);
	});
});

describe("launchfile up --name with no value (built CLI)", () => {
	const CLI = join(resolve(import.meta.dirname, "..", ".."), "dist", "cli.js");

	function run(cliArgs: string[]): { output: string; exitCode: number } {
		try {
			const output = execFileSync("node", [CLI, ...cliArgs], {
				encoding: "utf-8",
				stdio: ["ignore", "pipe", "pipe"],
			});
			return { output, exitCode: 0 };
		} catch (err) {
			const e = err as { stdout?: string; stderr?: string; status?: number };
			return { output: `${e.stdout ?? ""}${e.stderr ?? ""}`, exitCode: e.status ?? 1 };
		}
	}

	it("errors instead of silently launching the unnamed instance", () => {
		for (const argv of [
			["up", "--dry-run", "--name"],
			["up", "--name", "--dry-run"],
			["up", "--name=", "--dry-run"],
		]) {
			const { output, exitCode } = run(argv);
			expect(exitCode).toBe(1);
			expect(output).toContain("--name requires a value");
		}
	});
});

describe("--reveal on bootstrap (D-62): exact long form, no alias, no value", () => {
	it("is present only as the literal --reveal token", () => {
		expect(flagPresent(["bootstrap", "ghost", "--reveal"], "reveal")).toBe(true);
		expect(flagPresent(["bootstrap", "--reveal", "ghost"], "reveal")).toBe(true);
		expect(flagPresent(["bootstrap", "ghost"], "reveal")).toBe(false);
	});

	it("has no short alias", () => {
		expect(flagPresent(["bootstrap", "ghost", "-r"], "reveal")).toBe(false);
	});

	it("consumes no positional — the target after it is still the target", () => {
		const args = ["bootstrap", "--reveal", "ghost"];
		expect(getPositional(args, 0)).toBe("bootstrap");
		expect(getPositional(args, 1)).toBe("ghost");
	});
});

describe("valuedBooleanFlag (#485)", () => {
	it("accepts the bare form of every boolean flag", () => {
		for (const flag of BOOLEAN_FLAGS) {
			const args = ["up", `--${flag}`];
			expect(valuedBooleanFlag(args)).toBeUndefined();
			expect(hasFlag(args, flag)).toBe(true);
			expect(flagPresent(args, flag)).toBe(true);
		}
	});

	it("names a boolean flag written as --flag=false", () => {
		for (const flag of BOOLEAN_FLAGS) {
			expect(valuedBooleanFlag(["up", `--${flag}=false`])).toBe(flag);
		}
	});

	it("names a boolean flag written as --flag=true", () => {
		for (const flag of BOOLEAN_FLAGS) {
			expect(valuedBooleanFlag(["up", `--${flag}=true`])).toBe(flag);
		}
	});

	it("names a boolean flag written with an empty value", () => {
		expect(valuedBooleanFlag(["bootstrap", "ghost", "--reveal="])).toBe(
			"reveal",
		);
	});

	it("leaves the =-form of a value flag alone", () => {
		for (const flag of VALUE_FLAGS) {
			expect(valuedBooleanFlag(["up", `--${flag}=x`])).toBeUndefined();
		}
		expect(valuedBooleanFlag([])).toBeUndefined();
		expect(
			valuedBooleanFlag(["up", "--storage", "music=/srv/music"]),
		).toBeUndefined();
	});

	it("ignores a positional that happens to contain an =", () => {
		expect(valuedBooleanFlag(["up", "KEY=value"])).toBeUndefined();
		expect(valuedBooleanFlag(["up", "-json=false"])).toBeUndefined();
	});

	it("returns the first offender when several appear", () => {
		expect(valuedBooleanFlag(["up", "--dry-run=true", "--json=false"])).toBe(
			"dry-run",
		);
	});
});

describe("the flag tables cover cli.ts exactly (#485)", () => {
	it("declares no flag in both tables", () => {
		const both = [...BOOLEAN_FLAGS].filter((flag) => VALUE_FLAGS.has(flag));
		expect(both).toEqual([]);
	});

	/**
	 * A flag cli.ts reads but neither table names inherits #485's bug: an
	 * unlisted boolean silently accepts an ignored value. Reading the source is
	 * what makes the next flag added fail here rather than in an operator's CI log.
	 */
	it("names every long flag cli.ts reads in exactly one table", () => {
		const source = readFileSync(
			resolve(import.meta.dirname, "..", "cli.ts"),
			"utf-8",
		);
		const calls =
			/\b(?:args)?(?:[hH]asFlag|[fF]lagPresent|[gG]etFlagValues?)\(\s*(?:args,\s*)?"([^"]+)"/g;
		const read = new Set<string>();
		for (const [, flag] of source.matchAll(calls)) if (flag) read.add(flag);

		expect(read.size).toBeGreaterThan(0);
		const unlisted = [...read].filter(
			(flag) => !BOOLEAN_FLAGS.has(flag) && !VALUE_FLAGS.has(flag),
		);
		expect(unlisted).toEqual([]);
	});
});

describe("launchfile --flag=value on a boolean flag (built CLI, #485)", () => {
	const CLI = join(resolve(import.meta.dirname, "..", ".."), "dist", "cli.js");

	function run(cliArgs: string[]): { output: string; exitCode: number } {
		try {
			const output = execFileSync("node", [CLI, ...cliArgs], {
				encoding: "utf-8",
				stdio: ["ignore", "pipe", "pipe"],
			});
			return { output, exitCode: 0 };
		} catch (err) {
			const e = err as { stdout?: string; stderr?: string; status?: number };
			return {
				output: `${e.stdout ?? ""}${e.stderr ?? ""}`,
				exitCode: e.status ?? 1,
			};
		}
	}

	it.each([...BOOLEAN_FLAGS])("refuses a value on --%s", (flag) => {
		for (const value of ["false", "true"]) {
			const { output, exitCode } = run(["up", `--${flag}=${value}`]);
			expect(exitCode).toBe(1);
			expect(output).toContain(`--${flag} takes no value, e.g. --${flag}`);
		}
	});

	it("refuses before dispatch, so bootstrap never prints the sensitive capture (D-62)", () => {
		const { output, exitCode } = run(["bootstrap", "ghost", "--reveal=false"]);
		expect(exitCode).toBe(1);
		expect(output).toContain("--reveal takes no value, e.g. --reveal");
	});

	it("still accepts the =-form of a value flag", () => {
		const { output } = run(["schema", "--schema-path=/nope/schema.json"]);
		expect(output).not.toContain("takes no value");
	});
});

describe("unknownFlags (#510)", () => {
	it("reports an unknown flag in the --flag value form", () => {
		expect(unknownFlags(["up", ".", "--docker", "--totally-bogus-flag", "xyz"])).toEqual([
			"totally-bogus-flag",
		]);
	});

	it("reports an unknown flag in the --flag=value form", () => {
		expect(unknownFlags(["up", ".", "--totally-bogus-flag=xyz"])).toEqual([
			"totally-bogus-flag",
		]);
	});

	it("accepts every name in both tables, in every spelling cli.ts reads", () => {
		for (const flag of VALUE_FLAGS) {
			expect(unknownFlags(["up", `--${flag}`, "value"])).toEqual([]);
			expect(unknownFlags(["up", `--${flag}=value`])).toEqual([]);
		}
		for (const flag of BOOLEAN_FLAGS) {
			expect(unknownFlags(["up", `--${flag}`])).toEqual([]);
		}
	});

	it("does not report a value-flag's value that starts with --", () => {
		// `--name`'s own refusal owns this case: the token is its value, not a flag.
		expect(unknownFlags(["up", "--name", "--bogus"])).toEqual([]);
		expect(unknownFlags(["up", "--url", "--dry-run"])).toEqual([]);
	});

	it("judges long flags only — positionals and single-dash tokens pass", () => {
		expect(unknownFlags(["up", "ghost", "KEY=value", "-f", "-d"])).toEqual([]);
		expect(unknownFlags([])).toEqual([]);
	});

	it("is one allowlist for every verb — a declared flag a verb does not read is not unknown", () => {
		expect(unknownFlags(["up", "--url", "https://x.example.com"])).toEqual([]);
		expect(unknownFlags(["down", "--url", "https://x.example.com"])).toEqual([]);
		expect(unknownFlags(["schema", "--url=https://x.example.com"])).toEqual([]);
		expect(unknownFlags(["inspect", "--jsonn"])).toEqual(["jsonn"]);
	});

	it("names the flag that would otherwise make xyz the up target", () => {
		const args = ["up", "--totally-bogus-flag", "xyz", "."];
		// Without the refusal, getPositional reads the unknown flag's value as the target.
		expect(getPositional(args, 1)).toBe("xyz");
		expect(unknownFlags(args)).toEqual(["totally-bogus-flag"]);
	});

	it("returns every unknown flag in argv order", () => {
		expect(unknownFlags(["up", "--storagex", "a=b", "--env", "FOO=bar"])).toEqual([
			"storagex",
			"env",
		]);
	});
});

describe("suggestFlag (#510)", () => {
	it("suggests the one declared flag within edit distance 2", () => {
		expect(suggestFlag("components")).toBe("component");
		expect(suggestFlag("storagex")).toBe("storage");
		expect(suggestFlag("jsonn")).toBe("json");
		expect(suggestFlag("detac")).toBe("detach");
	});

	it("suggests on a prefix match in either direction", () => {
		expect(suggestFlag("stor")).toBe("storage");
		expect(suggestFlag("storage-dir")).toBe("storage");
	});

	it("suggests nothing when no declared flag is near", () => {
		expect(suggestFlag("env")).toBeUndefined();
		expect(suggestFlag("totally-bogus-flag")).toBeUndefined();
	});

	it("suggests nothing when several declared flags fit equally", () => {
		// `d` is a prefix of five flags; docker and detach are equally near.
		expect(suggestFlag("d")).toBeUndefined();
		expect(suggestFlag("detache")).toBeUndefined(); // detach vs detached, both 1 away
	});

	it("picks the nearest of several prefix matches when one is nearer", () => {
		// `n` is a prefix of name, native and no-color; name is nearest.
		expect(suggestFlag("n")).toBe("name");
	});
});

describe("launchfile with an unknown long flag (built CLI, #510)", () => {
	const CLI = join(resolve(import.meta.dirname, "..", ".."), "dist", "cli.js");

	function run(cliArgs: string[]): { stdout: string; stderr: string; exitCode: number } {
		try {
			const stdout = execFileSync("node", [CLI, ...cliArgs], {
				encoding: "utf-8",
				stdio: ["ignore", "pipe", "pipe"],
			});
			return { stdout, stderr: "", exitCode: 0 };
		} catch (err) {
			const e = err as { stdout?: string; stderr?: string; status?: number };
			return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", exitCode: e.status ?? 1 };
		}
	}

	it("refuses up . --docker --totally-bogus-flag xyz on stderr with exit 1, no suggestion", () => {
		const { stdout, stderr, exitCode } = run([
			"up",
			".",
			"--docker",
			"--totally-bogus-flag",
			"xyz",
		]);
		expect(exitCode).toBe(1);
		expect(stderr).toContain("no such flag --totally-bogus-flag\n");
		expect(stderr).not.toContain("did you mean");
		expect(stderr).toContain("Run `launchfile --help` for usage.");
		expect(stdout).toBe("");
	});

	it("names the nearest declared flag for a typo", () => {
		const { stderr, exitCode } = run(["up", ".", "--docker", "--storagex", "vol=/tmp"]);
		expect(exitCode).toBe(1);
		expect(stderr).toContain("no such flag --storagex — did you mean --storage?");
	});

	it("refuses on every verb, not only the deploying ones", () => {
		const { stderr, exitCode } = run(["inspect", "--jsonn"]);
		expect(exitCode).toBe(1);
		expect(stderr).toContain("no such flag --jsonn — did you mean --json?");
	});

	it("refuses before --version and --help are honoured", () => {
		for (const argv of [["--bogus", "--version"], ["up", "--bogus", "--help"]]) {
			const { stdout, stderr, exitCode } = run(argv);
			expect(exitCode).toBe(1);
			expect(stderr).toContain("no such flag --bogus");
			expect(stdout).toBe("");
		}
	});

	it("passes a declared flag on a verb that does not read it (one allowlist)", () => {
		const { stderr } = run(["schema", "--url", "https://x.example.com", "--schema-path", "/nope"]);
		expect(stderr).not.toContain("no such flag");
	});
});
