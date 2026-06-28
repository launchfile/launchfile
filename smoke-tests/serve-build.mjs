// Minimal static file server for the pre-deploy search test (CI `websites` job).
// Serves a built site directory (`<site>/dist/client`) with correct
// content-types — notably `application/wasm` for Pagefind's index, which the
// default `python -m http.server` does not reliably set across runner images.
//
//   node smoke-tests/serve-build.mjs <dir> [port]
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname, normalize, relative, isAbsolute, resolve as resolvePath } from "node:path";

const dir = resolvePath(process.argv[2] ?? ".");
const port = Number(process.argv[3] ?? 8080);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
};

async function resolveFile(pathname) {
  const candidate = normalize(join(dir, decodeURIComponent(pathname)));
  // path-traversal guard: candidate must be inside dir (not a `..` escape and
  // not a sibling like `dist/clientX` that prefix-matches `dist/client`).
  const rel = relative(dir, candidate);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  try {
    if ((await stat(candidate)).isDirectory()) {
      const index = join(candidate, "index.html");
      await stat(index);
      return index;
    }
    return candidate;
  } catch {
    // Clean URLs: /spec/storage → /spec/storage/index.html
    const index = join(candidate, "index.html");
    try {
      await stat(index);
      return index;
    } catch {
      return null;
    }
  }
}

createServer(async (req, res) => {
  const file = await resolveFile(new URL(req.url, "http://localhost").pathname);
  if (!file) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  const body = await readFile(file);
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  res.end(body);
}).listen(port, "127.0.0.1", () => console.log(`serving ${dir} on http://127.0.0.1:${port}`));
