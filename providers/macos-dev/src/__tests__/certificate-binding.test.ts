import { readLaunch } from "@launchfile/sdk";
import { describe, expect, it } from "vitest";
import {
	applyCertificateRefusals,
	refusedCertificates,
} from "../provider.js";

/**
 * This provider has no supplied-resource channel, so it can never receive a
 * `cert_file`/`key_file` pair and can never activate native TLS (D-next rule
 * 5, PROVIDERS.md §10 item 5).
 *
 * Selection here is `--with-optional`, the only switch that turns a
 * `supports:` entry on. Without it a certificate binding is inactive and the
 * declared HTTP baseline is the correct deployment (D-8); with it the operator
 * asked for TLS this provider cannot give, and the component is refused rather
 * than started in cleartext.
 */

const mk = (body: string) =>
	readLaunch(`version: launch/v1\nname: app\n${body}`);

const WEB = `provides:
  - name: web
    protocol: http
    port: 8080
    exposed: true
    tls: server-cert
supports:
  - name: server-cert
    type: certificate
    set_env:
      CERT_FILE: $cert_file
      KEY_FILE: $key_file
commands:
  start: run
`;

describe("refusedCertificates (D-next rule 5)", () => {
	it("refuses a component whose certificate binding the operator selected", () => {
		const launch = mk(WEB);
		expect([...refusedCertificates(launch, true).keys()]).toEqual(["default"]);
		expect(refusedCertificates(launch, true).get("default")).toEqual([
			'server-cert (endpoint "web")',
		]);
	});

	it("refuses nothing when the capability was not selected", () => {
		expect(refusedCertificates(mk(WEB), false).size).toBe(0);
	});

	it("ignores an app that declares no `tls:` binding", () => {
		const plain = `provides:
  - name: web
    protocol: http
    port: 8080
    exposed: true
commands:
  start: run
`;
		expect(refusedCertificates(mk(plain), true).size).toBe(0);
	});

	it("names an unnamed listener by shape, not by a made-up name", () => {
		const unnamed = `provides:
  - protocol: http
    port: 8080
    exposed: true
    tls: server-cert
supports:
  - name: server-cert
    type: certificate
commands:
  start: run
`;
		expect(refusedCertificates(mk(unnamed), true).get("default")).toEqual([
			"server-cert (endpoint (unnamed))",
		]);
	});
});

describe("applyCertificateRefusals — the refusal is the removal", () => {
	/**
	 * Gutting the removal leaves every assertion above passing while the
	 * component still installs, wires, registers and starts — in cleartext on
	 * the listener the operator asked to secure. Only the outcome pins it.
	 */
	it("removes the refused component from the run", () => {
		const launch = mk(WEB);
		expect(applyCertificateRefusals(launch, true)).toBe("none-left");
		expect(Object.keys(launch.components)).toEqual([]);
	});

	it("leaves the component in place when nothing was selected", () => {
		const launch = mk(WEB);
		expect(applyCertificateRefusals(launch, false)).toBe("ok");
		expect(Object.keys(launch.components)).toEqual(["default"]);
	});

	it("keeps the components that declared no binding", () => {
		const launch = readLaunch(`version: launch/v1
name: app
components:
  web:
    image: web
    provides:
      - name: web
        protocol: http
        port: 8080
        exposed: true
        tls: server-cert
    supports:
      - name: server-cert
        type: certificate
  worker:
    image: worker
`);
		expect(applyCertificateRefusals(launch, true)).toBe("ok");
		expect(Object.keys(launch.components)).toEqual(["worker"]);
	});
});
