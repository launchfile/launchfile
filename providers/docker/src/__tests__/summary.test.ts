import { describe, expect, it } from "vitest";
import { summaryLines } from "../provider.js";

describe("summaryLines", () => {
	const ports = { frontend: 54000, backend: 54001 };

	it("reports every component when no selector is given", () => {
		const lines = summaryLines("acme", ports);
		expect(lines).toHaveLength(2);
		expect(lines).toContain("  frontend is running at http://localhost:54000");
		expect(lines).toContain("  backend is running at http://localhost:54001");
	});

	it("reports only the components actually started under a selector", () => {
		const lines = summaryLines("acme", ports, new Set(["backend"]));
		expect(lines).toEqual(["  backend is running at http://localhost:54001"]);
	});

	it("uses the app name as the label for the default component", () => {
		const lines = summaryLines("acme", { default: 54000 });
		expect(lines).toEqual(["  acme is running at http://localhost:54000"]);
	});

	it("returns no lines when the selected set matches nothing", () => {
		expect(summaryLines("acme", ports, new Set(["nope"]))).toEqual([]);
	});
});
