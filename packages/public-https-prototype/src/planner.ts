import { parseLaunchYaml, validateLaunch, type NormalizedLaunch } from "@launchfile/sdk";

type ObjectValue = Record<string, unknown>;
const NAME = /^[a-z][a-z0-9-]{0,62}$/;
const own = (value: object, key: string): boolean => Object.hasOwn(value, key);

export interface PublicHttpsRequirement {
  component: string;
  endpoint: string;
  scheme: "https";
  url: string;
  status: "unresolved";
}

export interface PublicHttpsPlan {
  launch: NormalizedLaunch;
  requirements: PublicHttpsRequirement[];
  /** Translation cannot establish the existence or identity of a public route. */
  status: "unresolved" | "no-public-https-requirement";
}

function object(value: unknown, label: string): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as ObjectValue;
}

function keys(value: ObjectValue, allowed: string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`Unknown ${label} field: ${key}`);
  }
}

/** A publication origin; URL parsing must not silently repair malformed input. */
export function publicationOrigin(value: string | undefined): string {
  if (typeof value !== "string" || !/^https?:\/\/[^/?#\\]/i.test(value) ||
      /[\u0000-\u0020\u007f\\@?#]/.test(value)) {
    throw new Error("publicUrl must be an absolute HTTP(S) origin");
  }
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("publicUrl must be an absolute HTTP(S) origin"); }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("publicUrl must be an origin without credentials, path, query, or fragment");
  }
  return url.origin;
}

/** Preprocess the proposed contract before today's reader can discard its marker. */
export function planPublicHttps(yaml: string, options: { publicUrl?: string } = {}): PublicHttpsPlan {
  const raw = object(parseLaunchYaml(yaml), "Launchfile");
  const components = raw.components === undefined ? undefined : object(raw.components, "components");
  const multi = components !== undefined && Object.keys(components).length > 0;
  const declared: Array<{ component: string; endpoint: string }> = [];

  function preprocess(source: ObjectValue, component: string, ignoredDefaults = false): ObjectValue {
    if (own(source, "public")) throw new Error("public belongs in requires");
    if (own(source, "variants") || own(source, "tls")) {
      throw new Error("Variants and native TLS are separate proposals, unsupported by this demonstration");
    }
    if (Array.isArray(source.provides)) {
      for (const entry of source.provides) {
        const endpoint = object(entry, `${component}.provides entry`);
        if (own(endpoint, "tls") || own(endpoint, "public")) {
          throw new Error("Endpoint TLS capabilities are separate; public belongs in requires");
        }
      }
    }
    const result = { ...source };
    for (const field of ["requires", "supports"] as const) {
      if (!Array.isArray(source[field])) continue;
      result[field] = source[field].filter((entry: unknown) => {
        if (entry === "public") throw new Error("public requires an object with endpoint and scheme");
        if (!entry || typeof entry !== "object" || !own(entry, "public")) return true;
        if (field !== "requires") throw new Error("public is a mandatory requirement; it cannot appear in supports");
        if (ignoredDefaults) throw new Error("Declare public requirements on their component; top-level requirements are not inherited");
        const wrapper = object(entry, "Public requirement");
        keys(wrapper, ["public"], "requirement");
        const requirement = object(wrapper.public, "public");
        keys(requirement, ["endpoint", "scheme"], "public");
        if (typeof requirement.endpoint !== "string" || !NAME.test(requirement.endpoint)) {
          throw new Error("public.endpoint must name an endpoint in this component (no cross-component addressing)");
        }
        if (requirement.scheme !== "https") throw new Error("public.scheme must be https");
        if (declared.some((r) => r.component === component && r.endpoint === requirement.endpoint)) {
          throw new Error("Duplicate public requirement");
        }
        declared.push({ component, endpoint: requirement.endpoint });
        return false;
      });
    }
    return result;
  }

  const ordinary = preprocess(raw, "default", multi);
  if (multi) {
    ordinary.components = Object.fromEntries(Object.entries(components).map(([name, value]) =>
      [name, preprocess(object(value, `components.${name}`), name)]));
  }
  const launch = validateLaunch(ordinary);
  if (declared.length === 0) {
    return { launch, requirements: [], status: "no-public-https-requirement" };
  }

  // D-58 publication context is for the first exposed endpoint, in declaration
  // order. A later HTTP endpoint cannot borrow an earlier endpoint's address.
  const endpoints = Object.entries(launch.components).flatMap(([component, value]) =>
    (value.provides ?? []).map((endpoint) => ({ component, endpoint })));
  const primary = endpoints.find(({ endpoint }) => endpoint.exposed === true);
  const publicUrl = publicationOrigin(options.publicUrl);
  if (new URL(publicUrl).protocol !== "https:") throw new Error("The required public origin must use HTTPS");

  const requirements: PublicHttpsRequirement[] = declared.map((requirement) => {
    const matches = endpoints.filter(({ component, endpoint }) =>
      component === requirement.component && endpoint.name === requirement.endpoint);
    if (matches.length !== 1) throw new Error("public.endpoint must resolve to exactly one endpoint in its component");
    const target = matches[0]!;
    if (target.endpoint.exposed !== true) throw new Error("public.endpoint must be explicitly exposed");
    if (!["http", "https"].includes(target.endpoint.protocol)) throw new Error("public.endpoint must be an HTTP(S) listener");
    if (target !== primary) throw new Error("Only the primary endpoint has publication context; other endpoints need a separate contract");
    return { ...requirement, scheme: "https", url: publicUrl, status: "unresolved" };
  });
  return { launch, requirements, status: "unresolved" };
}
