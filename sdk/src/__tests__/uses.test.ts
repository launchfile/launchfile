/**
 * The `uses` item decoders (SPEC.md § Resource uses): a bare token and a
 * single-key map both reduce to one use key, and the key splits back.
 */

import { describe, expect, it } from "vitest";
import { declaredUse, formatUseKey, parseUseKey, useKey, useKeys } from "../uses.js";

describe("declaredUse", () => {
	it("decodes a bare token as an unnamed use", () => {
		expect(declaredUse("db")).toEqual({ use: "db" });
	});

	it("decodes a single-key map as a named use", () => {
		expect(declaredUse({ db: "cache" })).toEqual({ use: "db", name: "cache" });
	});
});

describe("useKey / useKeys", () => {
	it("keys a bare token by the token and a named use by token.name", () => {
		expect(useKey("db")).toBe("db");
		expect(useKey({ db: "cache" })).toBe("db.cache");
		expect(useKey({ use: "db", name: "sessions" })).toBe("db.sessions");
		expect(useKey({ use: "pubsub" })).toBe("pubsub");
	});

	it("keys a whole list in declaration order, and an absent list as empty", () => {
		expect(useKeys([{ db: "cache" }, "pubsub", { db: "sessions" }])).toEqual([
			"db.cache",
			"pubsub",
			"db.sessions",
		]);
		expect(useKeys(undefined)).toEqual([]);
	});
});

describe("parseUseKey / formatUseKey", () => {
	it("splits a key back into token and name", () => {
		expect(parseUseKey("db")).toEqual({ use: "db" });
		expect(parseUseKey("db.cache")).toEqual({ use: "db", name: "cache" });
	});

	it("spells a named key the way the file does", () => {
		expect(formatUseKey("db")).toBe("db");
		expect(formatUseKey("db.cache")).toBe("db: cache");
	});
});
