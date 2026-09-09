import { readLaunch } from "@launchfile/sdk";
import { observe, type Provider } from "./adapters.js";
import { decide } from "./policy.js";

const [provider, path, ...flags] = Bun.argv.slice(2);
if (!provider || !["docker", "aws", "macos-dev"].includes(provider) || !path
  || flags.some((flag) => flag !== "--strict") || flags.length > 1) {
  console.error("Usage: bun run plan <docker|aws|macos-dev> <Launchfile> [--strict]");
  process.exitCode = 2;
} else {
  try {
    const observation = observe(provider as Provider, readLaunch(await Bun.file(path).text()));
    const decision = decide(observation.diagnostics, flags.includes("--strict") ? "strict-schedule" : "default");
    console.log(JSON.stringify({
      status: "experiment-only; policy result, not deployment readiness",
      provider, allowed: decision.allowed, diagnostics: decision.diagnostics,
    }, null, 2));
    // AWS keeps its conformance/HCL internally; a refusal reports non-success
    // without claiming any resources were provisioned or the app was verified.
    process.exitCode = decision.allowed ? 0 : 1;
  } catch {
    // Parser exceptions can quote raw YAML before secrets are registered.
    console.error("Cannot evaluate Launchfile. Check the file path and syntax; no application was started.");
    process.exitCode = 2;
  }
}
