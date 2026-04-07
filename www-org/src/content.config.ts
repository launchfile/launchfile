import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const spec = defineCollection({
  loader: glob({
    pattern: "*.md",
    base: resolve(root, "spec"),
  }),
});

const catalog = defineCollection({
  loader: glob({
    pattern: "*.md",
    base: resolve(root, "catalog"),
  }),
});

export const collections = { spec, catalog };
