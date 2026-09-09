/** Experimental RFC C record. No SDK/provider contract has adopted these codes. */
export interface Diagnostic {
  readonly code: string;
  readonly component: string;
  readonly field: string;
  readonly reason: string;
  readonly next_action: string;
  readonly severity: "warning" | "error";
  readonly phase: "validation" | "execution";
}

export type Policy = "default" | "strict-schedule";
export interface Decision {
  readonly allowed: boolean;
  readonly diagnostics: readonly Diagnostic[];
}

/** D-40/D-46/D-56 and unknown future codes are deliberately absent. */
const ELIGIBLE_CODES: ReadonlySet<string> = new Set(["SCHEDULE_NOT_EXECUTED"]);

export function decide(
  diagnostics: readonly Diagnostic[],
  policy: string = "default",
  supported = true,
): Decision {
  const result = [...diagnostics];
  if (policy !== "default" && (policy !== "strict-schedule" || !supported)) {
    result.push({
      code: "POLICY_UNSUPPORTED", component: "*", field: "operator.policy",
      reason: "This implementation cannot honor the requested policy.",
      next_action: "Use an implementation that supports the requested policy.",
      severity: "error", phase: "execution",
    });
  } else if (policy === "strict-schedule") {
    for (const diagnostic of diagnostics) {
      if (diagnostic.phase !== "execution" || diagnostic.severity !== "warning"
        || !ELIGIBLE_CODES.has(diagnostic.code)) continue;
      // Retain D-51's warning verbatim; operator policy adds a separate refusal.
      result.push({
        ...diagnostic, code: "STRICT_POLICY_REFUSAL", severity: "error",
        reason: "The requested operator policy refuses an unexecuted schedule.",
      });
    }
  }
  return {
    allowed: !result.some((d) => d.severity === "error"),
    diagnostics: result,
  };
}

/** The caller supplies its real lifecycle entry point; the demo supplies a spy. */
export async function runWithPolicy<T>(
  diagnostics: readonly Diagnostic[],
  policy: string,
  emit: (diagnostic: Diagnostic) => void | Promise<void>,
  start: () => T | Promise<T>,
  supported = true,
): Promise<{ decision: Decision; started: boolean; value?: T }> {
  const decision = decide(diagnostics, policy, supported);
  for (const diagnostic of decision.diagnostics) await emit(diagnostic);
  if (!decision.allowed) return { decision, started: false };
  return { decision, started: true, value: await start() };
}

/** Keep stable identifiers intact; scrub every user-controlled display field. */
export function redactDiagnostic(d: Diagnostic, redact: (text: string) => string): Diagnostic {
  return {
    ...d, component: redact(d.component), field: redact(d.field),
    reason: redact(d.reason), next_action: redact(d.next_action),
  };
}
