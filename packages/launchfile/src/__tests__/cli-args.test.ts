/**
 * Argument-parsing rules (#248): a value-taking flag's value must never be
 * read as a positional, and the `--flag=value` spelling must parse — it is
 * the form the CLI roadmap's UC4 itself uses.
 */

import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	flagPresent,
	getFlagValue,
	getFlagValues,
	getPositional,
	hasFlag,
	parseComponentNames,
	parseStoragePairs,
	selectorRefusal,
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

	it("skips --components values so a name is never the up target (D-41)", () => {
		const args = ["up", "--components", "web"];
		expect(getPositional(args, 0)).toBe("up");
		// `web` is the selector's value; the target stays the cwd.
		expect(getPositional(args, 1)).toBeUndefined();
		expect(getPositional(["up", "--components", "web", "ghost"], 1)).toBe("ghost");
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

describe("parseComponentNames (--components, D-41)", () => {
	it("splits a comma-separated value", () => {
		expect(parseComponentNames(["web,api"])).toEqual(["web", "api"]);
	});

	it("composes repeated flags with comma lists, in order", () => {
		expect(parseComponentNames(["web,api", "worker"])).toEqual(["web", "api", "worker"]);
	});

	it("trims spacing and drops blanks and duplicates", () => {
		expect(parseComponentNames([" web , ,api", "web"])).toEqual(["web", "api"]);
	});

	it("returns no names for an empty value — D-41's select-nothing means all", () => {
		expect(parseComponentNames([""])).toEqual([]);
		expect(parseComponentNames([])).toEqual([]);
	});
});

describe("selectorRefusal (D-41, #232)", () => {
	it("refuses both spellings on a verb that acts on the whole deployment", () => {
		for (const argv of [
			["down", "--components", "web"],
			["down", "--components=web"],
			["down", "--component", "web"],
		]) {
			const lines = selectorRefusal(argv, "down", "stops the whole deployment");
			expect(lines).toBeDefined();
			expect(lines?.[0]).toContain("`down` stops the whole deployment");
		}
	});

	it("names the spelling typed and the verb that spelling belongs to", () => {
		const plural = selectorRefusal(["down", "--components", "web"], "down", "x");
		const singular = selectorRefusal(["down", "--component", "web"], "down", "x");
		expect(plural?.[0]).toContain("--components selects which components `up`/`dev` start");
		expect(singular?.[0]).toContain("--component limits `bootstrap` to a single component");
	});

	it("stays out of the way when no selector is given", () => {
		expect(selectorRefusal(["down", "--destroy"], "down", "x")).toBeUndefined();
		expect(selectorRefusal(["status"], "status", "x")).toBeUndefined();
	});
});

describe("down/status refuse a selector rather than swallowing it (built CLI)", () => {
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

	// `--components` is in the global VALUE_FLAGS table, so it parses on every
	// verb. Without the refusal, `down --destroy --components web` would drop
	// `web` and destroy the whole app the operator was narrowing.
	it("exits 1 and never reaches the provider", () => {
		for (const argv of [
			["down", "--components", "web"],
			["down", "--destroy", "--components", "web"],
			["down", "--component", "web"],
			["status", "--components", "web"],
			["status", "--components=web"],
		]) {
			const { output, exitCode } = run(argv);
			expect(exitCode).toBe(1);
			expect(output).toMatch(/^--components?\s/);
			// Nothing was resolved, stopped, or reported behind the ignored flag.
			expect(output).not.toContain("No deployment");
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
