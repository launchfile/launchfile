// Site-level fragments injected into shared components (e.g. DocsHeader's CTA),
// so the shared shell in www-shared/ stays funnel-agnostic — the launchfile.io
// funnel URL lives here in the consuming site, not hardcoded in the shared code.
export const GET_STARTED = { href: "https://launchfile.io/get-started" };
