import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const sdk = defineCollection({
  loader: glob({
    pattern: "README.md",
    base: resolve(root, "sdk"),
  }),
});

export const collections = { sdk };
