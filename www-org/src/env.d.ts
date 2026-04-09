/// <reference types="astro/client" />

// CDN module declarations for runtime-loaded libraries
declare module "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs" {
  const mermaid: {
    initialize: (config: Record<string, unknown>) => void;
    run: (config: Record<string, unknown>) => Promise<void>;
  };
  export default mermaid;
}
