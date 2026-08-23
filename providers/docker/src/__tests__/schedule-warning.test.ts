import { readLaunch } from "@launchfile/sdk";
import { describe, expect, it } from "vitest";
import { launchToCompose } from "../compose-generator.js";

/**
 * PROVIDERS.md §10 item 8 (D-51): a provider that does not execute a
 * component's `schedule` MUST say so at launch, naming the component.
 *
 * The warning must describe what *this provider* does, not what will happen
 * to the app — `catalog/drafts/diun` and `catalog/drafts/nextcloud` both
 * schedule themselves, so "nothing will run it" would be false about them.
 */
describe("schedule warning (D-51)", () => {
	const compose = (body: string) =>
		launchToCompose(readLaunch(`version: launch/v1\nname: app\nimage: x:1\n${body}`));

	it("warns when a component declares a schedule", () => {
		const { warnings } = compose('schedule: "0 */6 * * *"\n');
		expect(warnings.join(" ")).toContain("declares a schedule");
	});

	it("names the component", () => {
		const { warnings } = compose(
			"components:\n  cron:\n    image: x:1\n    schedule: \"*/5 * * * *\"\n  web:\n    image: x:1\n",
		);
		expect(warnings.some((w) => w.startsWith("cron:"))).toBe(true);
		expect(warnings.some((w) => w.startsWith("web:"))).toBe(false);
	});

	it("states what the provider does, not what the app will do", () => {
		// A self-scheduling app (diun, nextcloud cron) runs fine on a timer of
		// its own; asserting otherwise would make the warning false.
		const w = compose('schedule: "0 0 * * *"\n').warnings.join(" ");
		expect(w).toContain("this provider will not run it on a timer");
		expect(w).not.toContain("won't cron");
	});

	it("stays silent for a component with no schedule", () => {
		const { warnings } = compose("");
		expect(warnings.join(" ")).not.toContain("schedule");
	});
});
