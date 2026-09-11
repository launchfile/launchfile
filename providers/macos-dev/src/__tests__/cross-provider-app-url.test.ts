/**
 * `$app.*` must name the same public port on every provider that runs the same
 * Launchfile (P-5). Both reference providers answer it from the first
 * `exposed: true` endpoint (D-27) — docker in `app-url.ts`, macos-dev through
 * the port it allocates — and nothing asserted that the two agree.
 *
 * The macos-dev half runs the real path: `allocatePorts` → `computeAppProperties`
 * → `buildResolverContext` → `writeAllEnvFiles`, so the resolved `$app.url` is
 * compared against the `PORT` the spawned process would actually bind.
 */

import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLaunch, resolveExpression } from "@launchfile/sdk";
import { describe, expect, it } from "vitest";
import { computeAppProperties as dockerAppProperties } from "../../../docker/src/app-url.js";
import {
	buildResolverContext,
	computeAppProperties,
	writeAllEnvFiles,
} from "../env-writer.js";
import { allocatePorts } from "../port-allocator.js";

// The first entry is internal, the second is the public one. Reading provides[0]
// answers 39000 here; reading the exposed endpoint answers 38080. Both sit above
// the registered-port range, so the allocator finds them free on any machine.
const TWO_ENDPOINT_FIXTURE = `
version: launch/v1
name: cross-provider-fixture
components:
  web:
    image: web-like
    provides:
      - name: internal
        protocol: http
        port: 39000
      - name: public
        protocol: http
        port: 38080
        exposed: true
`;

describe("$app.* agrees across providers (P-5, D-27)", () => {
	it("docker and macos-dev name the same port for the same file", async () => {
		const launch = readLaunch(TWO_ENDPOINT_FIXTURE);

		// macos-dev: no saved port, so the allocator runs the anchor rule this
		// test exists for. A saved port takes the reuse branch above it, and the
		// comparison would then hold whichever endpoint the anchor picked.
		const ports = await allocatePorts(launch.components, launch.name);
		const macos = computeAppProperties(launch, ports);

		// docker: same file, no host-port map, so its number comes from the
		// declared exposed endpoint rather than from what macos-dev allocated.
		const docker = dockerAppProperties(launch, undefined);

		expect(docker.port).toBe(38080);
		expect(macos.port).toBe(38080);
		expect(macos.url).toBe(docker.url);
		expect(macos.authority).toBe(docker.authority);
	});

	it("resolves $app.url to the port the process is told to bind", async () => {
		const launch = readLaunch(TWO_ENDPOINT_FIXTURE);
		const ports = await allocatePorts(launch.components, launch.name);
		const app = computeAppProperties(launch, ports);
		const context = buildResolverContext({}, ports, {}, app);

		const projectDir = await mkdtemp(join(tmpdir(), "cross-provider-"));
		const envs = await writeAllEnvFiles(launch, context, {}, ports, projectDir, {});

		const resolvedPort = new URL(resolveExpression("$app.url", context)).port;
		// The allocator may move off 8080 when it is taken, but $app.url and the
		// process's own PORT must move together — they are one number.
		expect(resolvedPort).toBe(String(ports.web));
		expect(envs.web?.PORT).toBe(String(ports.web));

		const written = await readFile(join(projectDir, ".launchfile", "env", "web.env"), "utf8");
		expect(written).toContain(`PORT=${ports.web}`);
	});
});
