import { describe, expect, it } from "vitest";
import { scheduleWarning } from "../provider.js";

/**
 * PROVIDERS.md §10 item 8 (D-51). This provider has no scheduler, so a
 * declared `schedule` must be reported at launch rather than dropped —
 * an unexecuted schedule produces no error and no missing endpoint, so
 * silence reads as success.
 */
describe("scheduleWarning (D-51)", () => {
	it("names the component and quotes the schedule", () => {
		const w = scheduleWarning("cron", "*/5 * * * *");
		expect(w).toContain("[cron]");
		expect(w).toContain("*/5 * * * *");
	});

	it("states what the provider does, not what the app will do", () => {
		// diun and nextcloud's cron both schedule themselves; asserting the job
		// will not run would be false about them.
		const w = scheduleWarning("default", "0 0 * * *");
		expect(w).toContain("this provider will not run it on a timer");
		expect(w).toContain("If the component does not schedule itself");
	});

	it("does not claim the job will not run", () => {
		expect(scheduleWarning("default", "0 0 * * *")).not.toMatch(
			/^.*nothing will run it on a timer/,
		);
	});
});
