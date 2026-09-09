import { readLaunch } from "@launchfile/sdk";
import { observe, type Provider } from "./adapters.js";
import { runWithPolicy } from "./policy.js";

const fixture = readLaunch(await Bun.file(new URL("../fixtures/Launchfile", import.meta.url)).text());
const providers: Provider[] = ["docker", "aws", "macos-dev"];
const runs = [];
for (const provider of providers) {
  const observation = observe(provider, fixture);
  for (const policy of ["default", "strict-schedule"]) {
    const events: string[] = [];
    const outcome = await runWithPolicy(observation.diagnostics, policy,
      (d) => { events.push(d.code); },
      () => { events.push("EXPERIMENT_CONTINUATION"); });
    runs.push({ provider, policy, allowed: outcome.decision.allowed,
      events, diagnostics: outcome.decision.diagnostics });
  }
}
console.log(JSON.stringify({
  status: "experiment-only; no app was started or infrastructure applied",
  aws: "real HCL translation; refusal is a non-success policy result, not a deployment result",
  runs,
}, null, 2));
