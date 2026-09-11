import { parseLaunchYaml, validateLaunch, type NormalizedLaunch } from "@launchfile/sdk";

export class ForeignProposalError extends Error {
  constructor() {
    super("TLS, public HTTPS, and variants require their separate demonstrations; strictness cannot interpret those contracts.");
  }
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Fence the sibling experiments before today's permissive reader drops them. */
export function readStrictnessLaunch(yaml: string): NormalizedLaunch {
  const raw: unknown = parseLaunchYaml(yaml);
  function inspect(scope: unknown): void {
    if (!record(scope)) return; // Let normal schema validation diagnose shape.
    if (["tls", "public", "variants"].some((key) => Object.hasOwn(scope, key))) throw new ForeignProposalError();
    if (Array.isArray(scope.provides) && scope.provides.some((entry: unknown) =>
      record(entry) && Object.hasOwn(entry, "tls"))) throw new ForeignProposalError();
    for (const field of ["requires", "supports"]) {
      const entries = scope[field];
      if (Array.isArray(entries) && entries.some((entry: unknown) =>
        entry === "certificate" || (record(entry) && (entry.type === "certificate" || Object.hasOwn(entry, "public"))))) {
        throw new ForeignProposalError();
      }
    }
  }
  inspect(raw);
  if (record(raw) && record(raw.components)) for (const component of Object.values(raw.components)) inspect(component);
  return validateLaunch(raw);
}
