import { httpsOriginSatisfied, InvalidAppUrlError } from "../../../providers/docker/src/app-url.ts";

/**
 * True when an app that requires an `https-origin` (D-60) must be skipped
 * because `appUrl` is absent or not https. A malformed URL is not a skip:
 * test-app.ts refuses it and reports a failure.
 */
export function skipsForHttpsOrigin(requiresHttpsOrigin: boolean, appUrl: string | undefined): boolean {
  if (!requiresHttpsOrigin) return false;
  try {
    return !httpsOriginSatisfied(appUrl);
  } catch (e) {
    if (e instanceof InvalidAppUrlError) return false;
    throw e;
  }
}
