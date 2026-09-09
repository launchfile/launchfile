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
});
