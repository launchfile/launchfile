import { describe, expect, it } from "vitest";
import { collectHostCapabilities } from "../commands.js";
import { lintLaunch } from "../lint.js";
import { readLaunch } from "../reader.js";
import { writeLaunch } from "../writer.js";

describe("host-capability entries (D-44)", () => {
	describe("parsing and normalization", () => {
		it("parses a required container_runtime capability with set_env", () => {
			const launch = readLaunch(`
name: dockge
image: louislam/dockge:1
requires:
  - host: { container_runtime: docker }
    set_env:
      DOCKER_HOST: $url
`);
			const reqs = launch.components.default!.requires!;
			expect(reqs).toHaveLength(1);
			expect(reqs[0]!.type).toBe("host");
			expect(reqs[0]!.host).toEqual({ container_runtime: "docker" });
			expect(reqs[0]!.set_env).toEqual({ DOCKER_HOST: "$url" });
		});

		it("parses an optional capability under supports", () => {
			const launch = readLaunch(`
name: beszel
image: henrygd/beszel:latest
supports:
  - host: { container_runtime: any }
`);
			const sups = launch.components.default!.supports!;
			expect(sups[0]!.host).toEqual({ container_runtime: "any" });
			expect(sups[0]!.set_env).toBeUndefined();
		});

		it("parses capability entries alongside backing services", () => {
			const launch = readLaunch(`
name: mixed
image: app:1
requires:
  - postgres
  - host: { container_runtime: docker }
`);
			const reqs = launch.components.default!.requires!;
			expect(reqs[0]).toEqual({ type: "postgres" });
			expect(reqs[1]!.host).toEqual({ container_runtime: "docker" });
		});

		it("parses the folded capabilities (network/filesystem/privileged)", () => {
			const launch = readLaunch(`
name: wg-easy
image: wg-easy:latest
requires:
  - host: { network: host }
  - host: { privileged: true }
  - host: { filesystem: read-write }
`);
			const reqs = launch.components.default!.requires!;
			expect(reqs[0]!.host).toEqual({ network: "host" });
			expect(reqs[1]!.host).toEqual({ privileged: true });
			expect(reqs[2]!.host).toEqual({ filesystem: "read-write" });
		});

		it("tolerates unknown capability names and values (open vocabulary, L-4)", () => {
			const launch = readLaunch(`
name: future
image: app:1
supports:
  - host: { device: usb }
`);
			expect(launch.components.default!.supports![0]!.host).toEqual({ device: "usb" });
		});

		it("keeps the legacy top-level host block valid and separate", () => {
			const launch = readLaunch(`
name: legacy
image: app:1
host:
  docker: required
  network: host
`);
			const comp = launch.components.default!;
			expect(comp.host).toEqual({ docker: "required", network: "host" });
			expect(comp.requires).toBeUndefined();
		});
	});

	describe("serialization (writer)", () => {
		it("round-trips a capability entry with the host: marker, not type", () => {
			const yaml = `
name: dockge
image: louislam/dockge:1
requires:
  - host: { container_runtime: docker }
    set_env:
      DOCKER_HOST: $url
`;
			const written = writeLaunch(readLaunch(yaml));
			expect(written).toContain("container_runtime: docker");
			expect(written).not.toContain("type: host");
			const reparsed = readLaunch(written);
			expect(reparsed.components.default!.requires![0]).toEqual({
				type: "host",
				host: { container_runtime: "docker" },
				set_env: { DOCKER_HOST: "$url" },
			});
		});
	});

	describe("lint (marker enforcement, advisory)", () => {
		it("warns when a known capability name appears as a backing-service type", () => {
			const launch = readLaunch(`
name: unmarked
image: app:1
requires:
  - type: container_runtime
`);
			const warnings = lintLaunch(launch, { suppressPortabilityWarnings: true });
			expect(warnings).toHaveLength(1);
			expect(warnings[0]).toContain("host:");
			expect(warnings[0]).toContain("container_runtime");
			expect(warnings[0]).toContain("D-44");
		});

		it("does not warn on properly marked capability entries", () => {
			const launch = readLaunch(`
name: marked
image: app:1
requires:
  - host: { container_runtime: docker }
supports:
  - host: { container_runtime: any }
`);
			expect(lintLaunch(launch, { suppressPortabilityWarnings: true })).toEqual([]);
		});

		it("does not report capability entries as conflicting resources", () => {
			const launch = readLaunch(`
name: acme
components:
  api:
    image: api:latest
    requires:
      - host: { container_runtime: docker }
  agent:
    image: agent:latest
    supports:
      - host: { network: host }
`);
			expect(lintLaunch(launch, { suppressPortabilityWarnings: true })).toEqual([]);
		});
	});

	describe("collectHostCapabilities (validate summary source)", () => {
		it("lists capabilities from the new entry form with required/optional", () => {
			const launch = readLaunch(`
name: dockge
image: louislam/dockge:1
requires:
  - host: { container_runtime: docker }
supports:
  - host: { network: host }
`);
			expect(collectHostCapabilities(launch)).toEqual([
				"container_runtime=docker (required)",
				"network=host (optional)",
			]);
		});

		it("lists capabilities from the legacy host block in the capability vocabulary", () => {
			const launch = readLaunch(`
name: legacy
image: app:1
host:
  docker: required
  network: host
  filesystem: read-write
  privileged: true
`);
			expect(collectHostCapabilities(launch)).toEqual([
				"container_runtime=docker (required)",
				"filesystem=read-write (required)",
				"network=host (required)",
				"privileged=true (required)",
			]);
		});

		it("merges both spellings and dedupes", () => {
			const launch = readLaunch(`
name: both
image: app:1
host:
  docker: required
requires:
  - host: { container_runtime: docker }
`);
			expect(collectHostCapabilities(launch)).toEqual([
				"container_runtime=docker (required)",
			]);
		});

		it("returns empty for apps with no host capabilities", () => {
			const launch = readLaunch(`
name: plain
image: app:1
requires: [postgres]
`);
			expect(collectHostCapabilities(launch)).toEqual([]);
		});
	});

	describe("a mixed type:/host: entry (D-44)", () => {
		const mixed = `
name: mixed
image: app:1
requires:
  - type: postgres
    host: { privileged: true }
`;

		it("is rejected, not silently stripped of its privilege marker", () => {
			expect(() => readLaunch(mixed)).toThrow(/never both/);
		});

		it("names the rule instead of failing with a bare union error", () => {
			expect(() => readLaunch(mixed)).toThrow(
				/backing service .*or a host capability/,
			);
		});

		it("still accepts each spelling on its own", () => {
			expect(() =>
				readLaunch(`
name: split
image: app:1
requires:
  - type: postgres
  - host: { privileged: true }
`),
			).not.toThrow();
		});

		it("keeps tolerating unrecognized keys on a backing-service entry", () => {
			// spec/examples/host-orchestrator.yaml carries `description:` here, so
			// closing this object outright would invalidate a shipped example.
			expect(() =>
				readLaunch(`
name: described
image: app:1
requires:
  - type: docker
    description: Orchestrates app containers on the host
`),
			).not.toThrow();
		});
	});
});
