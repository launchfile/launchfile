import { translate, type TranslateResult } from "@launchfile/aws";
import { launchToCompose, redactSecrets, type ComposeResult } from "@launchfile/docker";
import { type NormalizedLaunch, unsuppliedRequiredEnv } from "@launchfile/sdk";
// Deliberate internal seams: no production diagnostic API exists yet.
import { refusedHostCapabilities, scheduleWarning } from "@launchfile/macos-dev/dist/provider.js";
import { getProvisioner } from "@launchfile/macos-dev/dist/resources/index.js";
import { redactSecrets as redactMac } from "@launchfile/macos-dev/dist/redact.js";
import { type Diagnostic, redactDiagnostic } from "./policy.js";

export type Provider = "docker" | "aws" | "macos-dev";
export interface Observation {
  provider: Provider;
  diagnostics: Diagnostic[];
  /** Unmodified provider output: never used to decide strictness by text. */
  original: ComposeResult | TranslateResult | { warnings: string[] };
}

/** Capability fact, not a warning-string parser. A real scheduler can fulfill it. */
export function scheduleDiagnostics(launch: NormalizedLaunch, executesSchedule: boolean): Diagnostic[] {
  if (executesSchedule) return [];
  return Object.entries(launch.components).flatMap(([component, value]) => value.schedule ? [{
    code: "SCHEDULE_NOT_EXECUTED", component, field: "schedule",
    reason: "This provider does not execute the declared schedule; the app may schedule itself.",
    next_action: "Choose a provider that executes schedule, or explicitly accept this gap with the default policy.",
    severity: "warning" as const, phase: "execution" as const,
  }] : []);
}

function missingEnv(component: string, key: string): Diagnostic {
  return {
    code: "REQUIRED_ENV_UNSUPPLIED", component, field: `env.${key}`,
    reason: "A required environment value has not been supplied.",
    next_action: "Supply the value through the provider's operator environment channel.",
    severity: "error", phase: "execution",
  };
}

function refusedHosts(launch: NormalizedLaunch): Diagnostic[] {
  return [...refusedHostCapabilities(launch).keys()].map((component) => ({
    code: "REQUIRED_HOST_REFUSED", component, field: "requires.host",
    reason: "The provider cannot grant a mandatory host capability.",
    next_action: "Choose a provider that can grant the declared capability.",
    severity: "error", phase: "execution",
  }));
}

/**
 * These sidecar adapters exercise actual provider functions but do not install a
 * flag in any provider. A production change must emit these records natively at
 * the source of each gap, then route all three lifecycles through the policy.
 */
export function observe(provider: Provider, launch: NormalizedLaunch): Observation {
  let original: Observation["original"];
  const diagnostics = scheduleDiagnostics(launch, false);
  // All three current providers refuse these host grants. The macOS helper is
  // a real, pure implementation of that common fact, not a provisioner call.
  diagnostics.push(...refusedHosts(launch));
  if (provider === "docker") {
    const composition = launchToCompose(launch);
    original = composition;
    diagnostics.push(...composition.unsuppliedRequired.map(({ component, key }) => missingEnv(component, key)));
    diagnostics.push(...composition.unboundOperatorVolumes.map(({ component, volume }) => ({
      code: "OPERATOR_STORAGE_UNBOUND", component, field: `storage.${volume}`,
      reason: "An operator-owned volume has no supplied path.",
      next_action: "Supply its existing path through the provider's storage channel.",
      severity: "error" as const, phase: "execution" as const,
    })));
  } else if (provider === "aws") {
    original = translate(launch);
    // Existing AWS gaps are already structural. Retain the entire ledger in
    // original; only the schedule code is eligible for operator escalation.
    for (const gap of original.conformance.gaps) {
      if (gap.field === "schedule") continue;
      diagnostics.push({
        code: "AWS_CONFORMANCE_GAP", component: gap.component ?? "*", field: gap.field,
        reason: gap.reason, next_action: gap.suggestion ?? "Review the conformance ledger.",
        severity: "warning", phase: "execution",
      });
      // The real translator records missing required vars as env.<key>; this
      // floor is experiment policy, not a claim that AWS ran an application.
      if (gap.component && gap.field.startsWith("env.")) {
        const key = gap.field.slice(4);
        const component = launch.components[gap.component];
        if (component?.env?.[key]?.required) {
          diagnostics.push(missingEnv(gap.component, key));
        }
      }
    }
  } else {
    original = { warnings: Object.entries(launch.components).flatMap(([component, value]) =>
      value.schedule ? [scheduleWarning(component, value.schedule)] : []) };
    for (const [name, component] of Object.entries(launch.components)) {
      // Same preflight arrival rule as launchUp, with no optional resources and
      // an empty operator environment. This never inherits this process's env.
      const arriving = new Set((component.requires ?? [])
        .filter((req) => !req.host && getProvisioner(req.type))
        .flatMap((req) => Object.keys(req.set_env ?? {})));
      for (const { key } of unsuppliedRequiredEnv(component, arriving)) diagnostics.push(missingEnv(name, key));
    }
  }
  const redact = provider === "macos-dev" ? redactMac : redactSecrets;
  return { provider, original, diagnostics: diagnostics.map((d) => redactDiagnostic(d, redact)) };
}
