import { describe, it, expect } from "vitest";
import { publishedSlots } from "../own-ports.js";

describe("publishedSlots", () => {
	it("parses newline-delimited rows and arrays, tcp and udp", () => {
		const row = (p: number, proto: string) =>
			JSON.stringify({ Publishers: [{ PublishedPort: p, Protocol: proto }, { PublishedPort: 0, Protocol: "tcp" }] });
		expect([...publishedSlots(`${row(8080, "tcp")}\n${row(53, "udp")}`)].sort()).toEqual(["53/udp", "8080/tcp"]);
		expect([...publishedSlots(`[${row(9000, "tcp")}]`)]).toEqual(["9000/tcp"]);
	});

	it("returns an empty set for empty or malformed output", () => {
		expect(publishedSlots("").size).toBe(0);
		expect(publishedSlots("not json").size).toBe(0);
	});
});
