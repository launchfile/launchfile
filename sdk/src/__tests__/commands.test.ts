import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cmdValidate } from "../commands.js";

function fixture(yaml: string): string {
	const dir = mkdtempSync(join(tmpdir(), "sdk-cmdvalidate-"));
	const path = join(dir, "Launchfile");
	writeFileSync(path, yaml, "utf-8");
	return path;
}

describe("cmdValidate — control-character sanitization (#279, CWE-117)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("keeps a hostile storage-key lint warning on one line", () => {
		const path = fixture(
			'version: launch/v1\nname: acme\nimage: app:1\nstorage:\n  "evil\\n\\u2713 valid":\n    path: /data\n    unknown_key: true\n',
		);
		const result = cmdValidate(path, { quiet: true, noColor: true });

		expect(result.valid).toBe(true);
		const warning = result.warnings?.find((w) =>
			w.includes("unrecognized keys"),
		);
		expect(warning).toBeDefined();
		expect(warning).not.toContain("\n");
		expect(warning).toContain("evil\\n✓ valid");
	});

	it("keeps the printed host-capabilities summary line on one line for a hostile capability name", () => {
		const path = fixture(
			'version: launch/v1\nname: acme\nimage: app:1\nrequires:\n  - host:\n      "evil\\n\\u2713 valid": required\n',
		);
		const logs: string[] = [];
		vi.spyOn(console, "log").mockImplementation((msg: unknown) => {
			logs.push(String(msg));
		});

		cmdValidate(path, { noColor: true });

		const summaryLine = logs.find((l) =>
			l.includes("host capabilities requested:"),
		);
		expect(summaryLine).toBeDefined();
		expect(summaryLine).not.toContain("\n");
		expect(summaryLine).toContain("evil\\n✓ valid");
	});

	it("keeps the printed components line on one line for a hostile component name", () => {
		const path = fixture(
			'version: launch/v1\nname: acme\ncomponents:\n  "evil\\n\\u2713 acme is valid":\n    image: app:1\n',
		);
		const logs: string[] = [];
		vi.spyOn(console, "log").mockImplementation((msg: unknown) => {
			logs.push(String(msg));
		});

		cmdValidate(path, { noColor: true });

		const summaryLine = logs.find((l) => l.includes("components:"));
		expect(summaryLine).toBeDefined();
		expect(summaryLine).not.toContain("\n");
		expect(summaryLine).toContain("evil\\n✓ acme is valid");
	});

	it("keeps the printed requires line on one line for a hostile requirement type", () => {
		const path = fixture(
			'version: launch/v1\nname: acme\nimage: app:1\nrequires:\n  - type: "evil\\n\\u2713 valid"\n',
		);
		const logs: string[] = [];
		vi.spyOn(console, "log").mockImplementation((msg: unknown) => {
			logs.push(String(msg));
		});

		cmdValidate(path, { noColor: true });

		const summaryLine = logs.find((l) => l.includes("requires:"));
		expect(summaryLine).toBeDefined();
		expect(summaryLine).not.toContain("\n");
		expect(summaryLine).toContain("evil\\n✓ valid");
	});

	it("keeps the printed operator-storage summary line on one line for a hostile volume name", () => {
		const path = fixture(
			'version: launch/v1\nname: acme\nimage: app:1\nstorage:\n  "evil\\n\\u2713 valid":\n    path: /data\n    content: operator\n',
		);
		const logs: string[] = [];
		vi.spyOn(console, "log").mockImplementation((msg: unknown) => {
			logs.push(String(msg));
		});

		cmdValidate(path, { noColor: true });

		const summaryLine = logs.find((l) =>
			l.includes("operator-supplied storage:"),
		);
		expect(summaryLine).toBeDefined();
		expect(summaryLine).not.toContain("\n");
		expect(summaryLine).toContain("evil\\n✓ valid");
	});
	it("keeps the printed deprecation line on one line for a hostile component name", () => {
		const path = fixture(
			'version: launch/v1\nname: acme\ncomponents:\n  "evil\\n\\u2713 acme is valid":\n    image: app:1\n    host:\n      docker: required\n',
		);
		const errors: string[] = [];
		vi.spyOn(console, "error").mockImplementation((msg: unknown) => {
			errors.push(String(msg));
		});

		cmdValidate(path, { noColor: true });

		const deprecationLine = errors.find((l) => l.includes("deprecated:"));
		expect(deprecationLine).toBeDefined();
		expect(deprecationLine).not.toContain("\n");
		expect(deprecationLine).toContain("evil\\n✓ acme is valid");
	});

	it("keeps a validation-failure line on one line when a hostile component name is in the error path", () => {
		const path = fixture(
			'version: launch/v1\nname: acme\ncomponents:\n  "evil\\n\\u2713 ok":\n    image: 5\n',
		);
		const errors: string[] = [];
		vi.spyOn(console, "error").mockImplementation((msg: unknown) => {
			errors.push(String(msg));
		});
		vi.spyOn(process, "exit").mockImplementation((() => {
			throw new Error("process.exit");
		}) as never);

		expect(() => cmdValidate(path, { noColor: true })).toThrow("process.exit");

		const pathLine = errors.find((l) => l.includes("evil"));
		expect(pathLine).toBeDefined();
		expect(pathLine).not.toContain("\n");
		expect(pathLine).toContain("evil\\n✓ ok");
	});

	it("strips ANSI escapes from a YAML syntax error that quotes the offending line", () => {
		// `yaml` builds parse errors with prettyErrors on, so the message embeds
		// the failing source line verbatim — the file's own bytes, escapes
		// included, reaching `console.error` under "Validation failed".
		const path = fixture(
			'version: launch/v1\nname: acme\nbad: [[31mRED[0m\n',
		);
		const errors: string[] = [];
		vi.spyOn(console, "error").mockImplementation((msg: unknown) => {
			errors.push(String(msg));
		});
		vi.spyOn(process, "exit").mockImplementation((() => {
			throw new Error("process.exit");
		}) as never);

		expect(() => cmdValidate(path, { noColor: true })).toThrow("process.exit");

		const printed = errors.join("\n");
		expect(printed).toContain("RED");
		expect(printed).not.toContain("");
		const disallowed = [...printed].filter((ch) => {
			const code = ch.charCodeAt(0);
			if (ch === "\n" || ch === "\t") return false;
			return code < 0x20 || (code >= 0x7f && code <= 0x9f);
		});
		expect(disallowed).toEqual([]);
	});

	it("keeps the parse error's pretty snippet on its own lines", () => {
		const path = fixture("version: launch/v1\nname: acme\nbad: [unclosed\n");
		const errors: string[] = [];
		vi.spyOn(console, "error").mockImplementation((msg: unknown) => {
			errors.push(String(msg));
		});
		vi.spyOn(process, "exit").mockImplementation((() => {
			throw new Error("process.exit");
		}) as never);

		expect(() => cmdValidate(path, { noColor: true })).toThrow("process.exit");

		// The caret line under the offending source is part of the diagnostic,
		// so this branch keeps `\n` instead of escaping it.
		const snippet = errors.find((l) => l.includes("bad: [unclosed"));
		expect(snippet).toBeDefined();
		expect(snippet).toContain("\n");
		expect(snippet).toContain("^");
	});
});
