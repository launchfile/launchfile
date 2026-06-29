import { registerMermaidTests } from "./mermaid-tests";

// Two run modes (mirrors search.spec.ts):
//
// 1. Post-deploy smoke (default — no env): test the live launchfile.org /design
//    page, which renders the architecture diagram.
// 2. Pre-merge CI (MERMAID_BASE_URL set): test ONE locally-served build. Only
//    launchfile.org has diagrams, so the `websites` matrix sets MERMAID_PATH for
//    www-org and leaves it empty for www-dev — when it's empty we register
//    nothing (the diagram-less site contributes no mermaid tests).
const localBase = process.env.MERMAID_BASE_URL;
const localPath = process.env.MERMAID_PATH;

if (localBase) {
  if (localPath) {
    registerMermaidTests(
      process.env.MERMAID_SITE ?? "local build",
      localBase,
      localPath,
    );
  }
} else {
  registerMermaidTests("launchfile.org", "https://launchfile.org", "/design/");
}
