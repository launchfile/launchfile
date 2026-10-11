/**
 * `uses:` on an `https-origin` entry (D-65): the harness grades declared uses
 * the way `@launchfile/docker` does, against the origin's one property map
 * (`{ url }`, D-60 rule 4), with coverage read from the provider's use
 * registry — never a list kept here (L-4).
 *
 * The #536 reproduction runs in both moods. `supports:` with an uncovered
 * use is unfulfilled, never refused (D-65 rule 4): bindings absent, a warning
 * naming the use, the component deploys. `requires:` with an uncovered use
 * takes D-64's refuse branch (D-65 rule 3): that component is absent,
 * siblings deploy. Each mood is then run through the shipped Docker provider
 * on the same input and the outcomes compared — the harness exists to predict
 * what the provider does, so a divergence here is the defect.
 */

import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { launchToCompose as dockerLaunchToCompose } from "../../../providers/docker/src/compose-generator.ts";
import { coveredUses } from "../../../providers/docker/src/resource-uses.ts";
import { readLaunch } from "../../../sdk/src/reader.ts";
import { launchToCompose } from "./launch-to-compose.ts";

type Services = Record<string, { environment?: Record<string, string> }>;

function services(yaml: string): Services {
  return (parse(yaml) as { services?: Services }).services ?? {};
}

const APP_URL = "https://repro.example.com";

// The issue #536 reproduction: a use token no registry entry covers for this
// type. `uses:` is an open vocabulary, so the file validates; coverage decides.
const SUPPORTS = `
version: launch/v1
name: repro
image: nginx
provides:
  - name: web
    protocol: http
    port: 80
    exposed: true
supports:
  - type: https-origin
    endpoint: web
    uses:
      - anything: x
    set_env:
      SOME_URL: $https-origin.anything.x.url
`;

const REQUIRES = `
version: launch/v1
name: repro
components:
  web:
    image: nginx
    provides:
      - name: ui
        protocol: http
        port: 80
        exposed: true
    requires:
      - type: https-origin
        endpoint: ui
        uses:
          - anything: x
        set_env:
          SOME_URL: $https-origin.anything.x.url
  worker:
    image: worker:1
`;

describe("supports: https-origin with an uncovered use (D-65 rule 4)", () => {
  it("leaves the entry unfulfilled — bindings absent, a warning names the use, the component deploys", () => {
    const result = launchToCompose(readLaunch(SUPPORTS), { appUrl: APP_URL });
    const repro = services(result.yaml).repro;
    expect(repro).toBeDefined();
    expect(repro?.environment?.SOME_URL).toBeUndefined();
    expect(result.originRefusals).toEqual([]);
    const warning = result.warnings.find((w) =>
      w.includes("optional public HTTPS origin https-origin"),
    );
    expect(warning).toContain("does not cover every declared use");
    expect(warning).toContain("anything: x");
    expect(warning).toContain("set_env bindings are omitted");
  });

  it("wires the entry when it declares no uses", () => {
    const noUses = SUPPORTS.replace("    uses:\n      - anything: x\n", "").replace(
      "$https-origin.anything.x.url",
      "$url",
    );
    const result = launchToCompose(readLaunch(noUses), { appUrl: APP_URL });
    expect(services(result.yaml).repro?.environment).toMatchObject({ SOME_URL: APP_URL });
    expect(result.warnings).toEqual([]);
  });

  it("reports an unsatisfied origin, not the use, when no appUrl is supplied", () => {
    const result = launchToCompose(readLaunch(SUPPORTS));
    expect(services(result.yaml).repro?.environment?.SOME_URL).toBeUndefined();
    expect(result.warnings.join("\n")).toContain("not satisfied — running degraded");
    expect(result.warnings.join("\n")).not.toContain("anything: x");
  });
});

describe("requires: https-origin with an uncovered use (D-65 rule 3, D-64)", () => {
  it("refuses that component, names the use, and still deploys the sibling", () => {
    const result = launchToCompose(readLaunch(REQUIRES), { appUrl: APP_URL });
    const emitted = services(result.yaml);
    expect(emitted["repro-web"]).toBeUndefined();
    expect(emitted["repro-worker"]).toBeDefined();
    expect(result.originRefusals).toHaveLength(1);
    expect(result.originRefusals[0]).toMatchObject({
      component: "web",
      entry: 'https-origin (endpoint "ui")',
    });
    expect(result.originRefusals[0]?.message).toContain("does not cover every declared use");
    expect(result.originRefusals[0]?.message).toContain("anything: x");
    expect(result.warnings.join("\n")).not.toContain("anything: x");
  });

  it("refuses on the scheme first when the origin itself is unsatisfied", () => {
    const result = launchToCompose(readLaunch(REQUIRES), { appUrl: "http://repro.example.com" });
    expect(services(result.yaml)["repro-web"]).toBeUndefined();
    expect(result.originRefusals).toHaveLength(1);
    expect(result.originRefusals[0]?.message).toContain('scheme is "http"');
    expect(result.originRefusals[0]?.message).not.toContain("anything: x");
  });
});

describe("parity with @launchfile/docker on the #536 reproduction", () => {
  // The registry, not this file, decides coverage: `https-origin` registers
  // no uses today, so every declared token is uncovered on both sides. Were a
  // use added to the registry, both would cover it without a change here.
  it("reads coverage from the provider's use registry", () => {
    expect(coveredUses("https-origin")).toEqual([]);
  });

  it("supports: both deploy the component without the binding and name the use", () => {
    const launch = readLaunch(SUPPORTS);
    const harness = launchToCompose(launch, { appUrl: APP_URL });
    const docker = dockerLaunchToCompose(launch, { appUrl: APP_URL });
    for (const result of [harness, docker]) {
      expect(Object.keys(services(result.yaml))).toEqual(["repro"]);
      expect(services(result.yaml).repro?.environment?.SOME_URL).toBeUndefined();
      expect(result.warnings.some((w) => w.startsWith("refused:"))).toBe(false);
      expect(
        result.warnings.find((w) => w.includes("optional public HTTPS origin https-origin")),
      ).toContain("anything: x");
    }
  });

  it("requires: both refuse the component, name the use, and deploy the sibling", () => {
    const launch = readLaunch(REQUIRES);
    const harness = launchToCompose(launch, { appUrl: APP_URL });
    const docker = dockerLaunchToCompose(launch, { appUrl: APP_URL });
    expect(Object.keys(services(harness.yaml))).toEqual(Object.keys(services(docker.yaml)));
    expect(Object.keys(services(harness.yaml))).toEqual(["repro-worker"]);
    const dockerRefusal = docker.warnings.find((w) => w.startsWith("refused: web"));
    expect(dockerRefusal).toContain("anything: x");
    expect(harness.originRefusals[0]?.message).toContain("anything: x");
  });
});
