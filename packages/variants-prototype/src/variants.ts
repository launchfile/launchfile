import {
  parseExpression,
  parseLaunchYaml,
  RESOURCE_PROPERTY_VOCABULARY,
  validateLaunch,
  type NormalizedLaunch,
  type NormalizedRequirement,
} from "@launchfile/sdk";

type RecordValue = Record<string, unknown>;
export const REPLACEABLE_FIELDS = ["provides", "requires", "supports", "env", "health", "storage"] as const;
const ROOT_FIELDS = [
  "version", "generator", "name", "description", "repository", "website", "logo", "keywords",
  "secrets", "image", "restart", "singleton", ...REPLACEABLE_FIELDS,
];
const RESERVED = new Set(["app", "components", "storage", "secrets"]);
const NAME = /^[a-z][a-z0-9-]{0,62}$/;
const APP_PROPERTIES = ["url", "host", "port", "name", "authority", "scheme", "tls"];

export interface VariantPreview {
  selected: string | null;
  available: string[];
  validated: string[];
  requiredInputs: string[];
  launch: NormalizedLaunch;
}

function fail(where: string, message: string): never {
  throw new Error(`${where}: ${message}`);
}

function record(value: unknown, where: string): RecordValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(where, "expected a map");
  return value as RecordValue;
}

function keys(value: unknown, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(record(value, where))) {
    if (!allowed.includes(key)) fail(`${where}.${key}`, "unsupported field in this prototype");
  }
}

// Aliases may share objects, but cyclic graphs and magic object keys cannot be input.
function checkGraph(value: unknown, parents = new Set<object>()): void {
  if (value === null || typeof value !== "object") return;
  if (parents.has(value)) fail("Launchfile", "cyclic aliases are unsupported");
  if (!Array.isArray(value) && ![null, Object.prototype].includes(Object.getPrototypeOf(value))) {
    fail("Launchfile", "expected plain YAML data");
  }
  parents.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (["__proto__", "prototype", "constructor"].includes(key)) fail("Launchfile", "unsafe map key");
    checkGraph(child, parents);
  }
  parents.delete(value);
}

function checkRawFields(raw: RecordValue, where: string): void {
  keys(raw, ROOT_FIELDS, where);
  if (typeof raw.image !== "string" || raw.image.trim() === "") fail(where, "this prototype requires an image-based component");
  if (raw.version !== undefined && raw.version !== "launch/v1") fail(where, "unsupported baseline version");
  if (raw.provides !== undefined) {
    if (!Array.isArray(raw.provides)) fail(`${where}.provides`, "expected a list");
    raw.provides.forEach((endpoint, index) => keys(endpoint, ["name", "protocol", "port", "bind", "exposed", "spec"], `${where}.provides[${index}]`));
  }
  for (const field of ["requires", "supports"]) {
    if (raw[field] === undefined) continue;
    if (!Array.isArray(raw[field])) fail(`${where}.${field}`, "expected a list");
    (raw[field] as unknown[]).forEach((requirement, index) => {
      if (typeof requirement === "string") return;
      keys(requirement, ["name", "type", "version", "set_env"], `${where}.${field}[${index}]`);
    });
  }
  for (const [name, value] of Object.entries(raw.env === undefined ? {} : record(raw.env, `${where}.env`))) {
    if (typeof value === "object" && value !== null) {
      keys(value, ["default", "description", "label", "required", "generator", "sensitive"], `${where}.env.${name}`);
    }
  }
  for (const [name, value] of Object.entries(raw.storage === undefined ? {} : record(raw.storage, `${where}.storage`))) {
    if (!NAME.test(name)) fail(`${where}.storage`, "invalid volume name");
    keys(value, ["path", "size", "persistent", "content"], `${where}.storage.${name}`);
  }
  for (const [name, value] of Object.entries(raw.secrets === undefined ? {} : record(raw.secrets, `${where}.secrets`))) {
    if (!NAME.test(name)) fail(`${where}.secrets`, "invalid secret name");
    keys(value, ["generator", "description"], `${where}.secrets.${name}`);
  }
  if (raw.health !== undefined && typeof raw.health !== "string") {
    keys(raw.health, ["path", "command", "interval", "timeout", "retries", "start_period"], `${where}.health`);
  }
}

function checkReferences(launch: NormalizedLaunch, where: string): void {
  const component = launch.components.default!;
  const resources = new Map<string, { requirement: NormalizedRequirement; optional: boolean }>();
  for (const [optional, entries] of [[false, component.requires ?? []], [true, component.supports ?? []]] as const) {
    for (const requirement of entries) {
      const name = requirement.name ?? requirement.type;
      if (!NAME.test(name) || RESERVED.has(name)) fail(where, "invalid or reserved resource name");
      if (resources.has(name)) fail(where, "duplicate resource name across requires/supports");
      if (!Object.hasOwn(RESOURCE_PROPERTY_VOCABULARY, requirement.type)) {
        fail(where, "this prototype only checks SDK standard backing-service types; host/public/certificate contracts are unsupported");
      }
      resources.set(name, { requirement, optional });
    }
  }
  const names = new Set<string>();
  const sockets = new Set<string>();
  for (const endpoint of component.provides ?? []) {
    const name = endpoint.name ?? "(unnamed)";
    if (names.has(name)) fail(where, "duplicate endpoint name (name each additional endpoint)");
    names.add(name);
    const socket = `${endpoint.protocol === "udp" ? "udp" : "tcp"}:${endpoint.port}`;
    if (sockets.has(socket)) fail(where, "duplicate listener port for the same transport");
    sockets.add(socket);
  }

  function inspect(value: string, location: string, enclosing?: NormalizedRequirement): void {
    const parsed = parseExpression(value);
    const references = parsed.kind === "reference" ? [parsed] : parsed.kind === "template" ? parsed.parts.filter((part) => part.kind === "ref") : [];
    for (const reference of references) {
      const path = reference.path;
      const [first, second, third] = path;
      let valid = false;
      if (reference.transforms?.some((transform) => !["base64", "hex"].includes(transform))) {
        fail(location, "unsupported expression transform");
      }
      if (first === "app") {
        valid = path.length === 2 && APP_PROPERTIES.includes(second!);
        if (valid && second !== "name" && (component.provides ?? []).filter((endpoint) => endpoint.exposed && ["http", "https"].includes(endpoint.protocol)).length !== 1) {
          fail(location, "URL-shaped app references require one exposed HTTP(S) endpoint in this prototype");
        }
      }
      else if (first === "storage") valid = path.length === 3 && Object.hasOwn(component.storage ?? {}, second!) && third === "path";
      else if (first === "secrets") valid = path.length === 2 && Object.hasOwn(launch.secrets ?? {}, second!);
      else if (first === "components") fail(location, "component references are outside this single-component prototype");
      else if (path.length === 1 && enclosing) valid = RESOURCE_PROPERTY_VOCABULARY[enclosing.type]!.includes(first!);
      else if (path.length === 2 && first && resources.has(first)) {
        const resource = resources.get(first)!;
        valid = RESOURCE_PROPERTY_VOCABULARY[resource.requirement.type]!.includes(second!);
        if (resource.optional && resource.requirement !== enclosing && reference.fallback === undefined) {
          fail(location, "reference to optional resource requires an explicit fallback");
        }
      }
      if (!valid) fail(location, "unknown or unsupported reference (including references with fallbacks)");
    }
  }

  for (const [key, value] of Object.entries(component.env ?? {})) {
    if (typeof value.default === "string") inspect(value.default, `${where}.env.${key}`);
  }
  for (const { requirement } of resources.values()) {
    for (const [key, value] of Object.entries(requirement.set_env ?? {})) {
      inspect(value, `${where}.set_env.${key}`, requirement);
    }
  }
}

function validateCandidate(raw: RecordValue, where: string): NormalizedLaunch {
  checkRawFields(raw, where);
  let normalized: NormalizedLaunch;
  try {
    normalized = validateLaunch(raw);
  } catch {
    // SDK schema errors can include received values. Do not echo possible credentials.
    fail(where, "invalid Launchfile field value (SDK schema validation failed)");
  }
  checkReferences(normalized, where);
  return normalized;
}

/** Expand one author-named configuration; never resolve values or run providers. */
export function expandVariants(input: unknown, selection?: string): VariantPreview {
  checkGraph(input);
  const raw = record(input, "Launchfile");
  keys(raw, [...ROOT_FIELDS, "variants"], "Launchfile");
  const variants = raw.variants === undefined ? {} : record(raw.variants, "variants");
  if (Object.keys(variants).length > 32) fail("variants", "at most 32 candidates are supported by this prototype");
  const { variants: _variants, ...baseline } = raw;
  const normalized = new Map<string | null, NormalizedLaunch>();
  normalized.set(null, validateCandidate(structuredClone(baseline), "baseline"));
  for (const [name, overlay] of Object.entries(variants)) {
    if (!NAME.test(name) || name === "baseline") fail("variants", "invalid or reserved variant name");
    keys(overlay, REPLACEABLE_FIELDS, `variants.${name}`);
    // Deliberately shallow: a present field replaces that field in full.
    normalized.set(name, validateCandidate(structuredClone({ ...baseline, ...record(overlay, name) }), `variants.${name}`));
  }
  const selected = selection ?? null;
  const launch = normalized.get(selected);
  if (!launch) fail("selection", "unknown variant; choose one author-defined name");
  const bindings = new Set((launch.components.default!.requires ?? []).flatMap((entry) => Object.keys(entry.set_env ?? {})));
  return {
    selected,
    available: Object.keys(variants),
    validated: ["baseline", ...Object.keys(variants)],
    requiredInputs: Object.entries(launch.components.default!.env ?? {})
      .filter(([key, value]) => value.required && value.default === undefined && !value.generator && !bindings.has(key))
      .map(([key]) => key),
    launch,
  };
}

export function readVariants(yaml: string, selection?: string): VariantPreview {
  let raw: unknown;
  try {
    raw = parseLaunchYaml(yaml);
  } catch {
    fail("Launchfile", "invalid YAML or parser size/alias limit exceeded");
  }
  return expandVariants(raw, selection);
}

/** Presentation copy only; generated secrets and resource values never enter this program. */
export function redactPreview(preview: VariantPreview): VariantPreview {
  const copy = structuredClone(preview);
  const sensitiveKey = /(?:password|passwd|secret|token|api[_-]?key|private[_-]?key)/i;
  for (const component of Object.values(copy.launch.components)) {
    for (const [key, value] of Object.entries(component.env ?? {})) {
      if (value.default !== undefined && (value.sensitive || sensitiveKey.test(key))) value.default = "[redacted]";
    }
    for (const entry of [...(component.requires ?? []), ...(component.supports ?? [])]) {
      for (const [key, value] of Object.entries(entry.set_env ?? {})) {
        const parsed = parseExpression(value);
        if ((sensitiveKey.test(key) || component.env?.[key]?.sensitive) && (parsed.kind !== "reference" || parsed.fallback !== undefined)) {
          entry.set_env![key] = "[redacted]";
        }
      }
    }
  }
  return copy;
}
