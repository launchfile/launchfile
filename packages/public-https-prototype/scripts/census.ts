import { readdir, readFile } from "node:fs/promises";
import { readLaunch } from "@launchfile/sdk";

const catalog = new URL("../../../catalog/", import.meta.url);
const marker = /WebAuthn|Web.?Crypto|secure.context|HTTPS.*required|required.*HTTPS|RP_ID|PROTOCOL_USESSL/i;
const files: Array<{ group: string; path: string; matched: boolean }> = [];
for (const group of ["apps", "drafts"]) {
  const directory = new URL(`${group}/`, catalog);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = `${group}/${entry.name}/Launchfile`;
    try {
      const yaml = await readFile(new URL(path, catalog), "utf8");
      files.push({ group, path, matched: marker.test(yaml) });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
// The only production edit is description text. Validate it with today's SDK;
// no public requirement is inserted and no catalog app is deployed by this script.
const vaultwarden = readLaunch(await readFile(new URL("apps/vaultwarden/Launchfile", catalog), "utf8"));
console.log(JSON.stringify({
  counts: {
    apps: files.filter((file) => file.group === "apps").length,
    drafts: files.filter((file) => file.group === "drafts").length,
    total: files.length,
  },
  markerMatches: files.filter((file) => file.matched).map((file) => file.path).sort(),
  sourceReviewedMotivations: ["vaultwarden web-vault/Web Crypto", "remote-claude-concentrator passkey/WebAuthn UI"],
  excludedCounterexample: "hedgedoc: CMD_PROTOCOL_USESSL tracks a scheme; it does not require HTTPS",
  caveat: "Marker coverage is not total demand for a currently unexpressible feature. The two examples motivate a secure browser origin; they do not prove strict HTTPS is invariant across all supported modes. No third example is claimed.",
  vaultwardenSchemaValidation: { result: "passed", name: vaultwarden.name },
}, null, 2));
