import { describe, expect, it } from "vitest";
import {
	indexOperatorStoragePaths,
	MissingOperatorStoragePathError,
	UnboundOperatorStorageError,
} from "../operator-storage.js";
import { readLaunch } from "../reader.js";

/**
 * The key rule is prose in D-50 rule 1 and identical in every provider, so it
 * is pinned here rather than in each of them. The refusal messages are pinned
 * too: they are the operator's only instruction for fixing the launch, and a
 * provider that silently reworded one would still pass its own tests.
 */

const ONE_COMPONENT = readLaunch(`
version: launch/v1
name: navidrome
image: navidrome/navidrome
commands: { start: "navidrome" }
storage:
  music: { path: /music, content: operator }
  cache: { path: /cache }
`);

// Two components declaring a same-named `media` volume — the ambiguous case —
// plus a name only one of them declares.
const TWO_COMPONENTS = readLaunch(`
version: launch/v1
name: acme
components:
  web:
    image: acme/web
    commands: { start: "web" }
    storage:
      media: { path: /media, content: operator }
      books: { path: /books, content: operator }
  worker:
    image: acme/worker
    commands: { start: "worker" }
    storage:
      media: { path: /media, content: operator }
`);

describe("indexOperatorStoragePaths key rule (D-50 rule 1)", () => {
	it("matches a bare key to a volume of that name", () => {
		const index = indexOperatorStoragePaths(ONE_COMPONENT, { music: "/srv/music" });
		expect(index.lookup("default", "music")).toEqual({ key: "music", path: "/srv/music" });
	});

	it("routes a component-qualified key to that component only", () => {
		const index = indexOperatorStoragePaths(TWO_COMPONENTS, { "web.media": "/srv/web" });
		expect(index.lookup("web", "media")).toEqual({ key: "web.media", path: "/srv/web" });
		expect(index.lookup("worker", "media")).toBeUndefined();
	});

	it("fans a bare key out to every component declaring that volume", () => {
		const index = indexOperatorStoragePaths(TWO_COMPONENTS, { media: "/srv/media" });
		expect(index.lookup("web", "media")?.path).toBe("/srv/media");
		expect(index.lookup("worker", "media")?.path).toBe("/srv/media");
	});

	it("prefers the qualified key over a bare one naming the same volume", () => {
		const index = indexOperatorStoragePaths(TWO_COMPONENTS, {
			media: "/srv/media",
			"web.media": "/srv/web",
		});
		expect(index.lookup("web", "media")?.path).toBe("/srv/web");
		expect(index.lookup("worker", "media")?.path).toBe("/srv/media");
	});

	it("treats a dotted key whose left half names no component as a whole volume name", () => {
		const dotted = readLaunch(`
version: launch/v1
name: acme
image: acme/app
commands: { start: "app" }
storage:
  "my.data": { path: /data, content: operator }
`);
		const index = indexOperatorStoragePaths(dotted, { "my.data": "/srv/data" });
		expect(index.lookup("default", "my.data")?.path).toBe("/srv/data");
	});

	it("treats a leading-dot key as a bare volume name — the split needs a left half", () => {
		const index = indexOperatorStoragePaths(TWO_COMPONENTS, { ".media": "/srv/media" });
		// It names no volume, so it binds nothing and reports as unused.
		expect(index.lookup("web", "media")).toBeUndefined();
		expect(index.unusedKeys(new Set())).toEqual([".media"]);
	});

	it("returns nothing when no paths were supplied", () => {
		const index = indexOperatorStoragePaths(ONE_COMPONENT, undefined);
		expect(index.lookup("default", "music")).toBeUndefined();
		expect(index.unusedKeys(new Set())).toEqual([]);
	});
});

describe("indexOperatorStoragePaths flag spelling (D-50 rule 2, row 2)", () => {
	it("suggests the bare spelling when one component declares the volume", () => {
		const index = indexOperatorStoragePaths(TWO_COMPONENTS, {});
		expect(index.flagFor("web", "books")).toBe("--storage books=<path>");
	});

	it("suggests the qualified spelling when the volume name is ambiguous", () => {
		const index = indexOperatorStoragePaths(TWO_COMPONENTS, {});
		expect(index.flagFor("web", "media")).toBe("--storage web.media=<path>");
	});
});

describe("indexOperatorStoragePaths unusedKeys", () => {
	it("reports a key the caller never accepted", () => {
		const index = indexOperatorStoragePaths(ONE_COMPONENT, {
			music: "/srv/music",
			typo: "/srv/typo",
		});
		expect(index.unusedKeys(new Set(["music"]))).toEqual(["typo"]);
	});

	it("reports a key naming an unmarked volume — row 4 leaves those alone", () => {
		const index = indexOperatorStoragePaths(ONE_COMPONENT, { cache: "/srv/cache" });
		expect(index.unusedKeys(new Set())).toEqual(["cache"]);
	});
});

describe("UnboundOperatorStorageError (D-50 rule 2, row 2)", () => {
	it("names every volume and the flag that satisfies it", () => {
		const err = new UnboundOperatorStorageError([
			{ component: "web", volume: "media", flag: "--storage web.media=<path>" },
			{ component: "worker", volume: "media", flag: "--storage worker.media=<path>" },
		]);
		expect(err.message).toContain("2 volumes marked");
		expect(err.message).toContain("  - web: media — supply it with --storage web.media=<path>");
		expect(err.message).toContain(
			"  - worker: media — supply it with --storage worker.media=<path>",
		);
	});

	it("uses the singular noun for one volume", () => {
		const err = new UnboundOperatorStorageError([
			{ component: "default", volume: "music", flag: "--storage music=<path>" },
		]);
		expect(err.message).toContain("1 volume marked");
	});

	it("is an expected refusal, so callers print it instead of a stack", () => {
		const err = new UnboundOperatorStorageError([
			{ component: "default", volume: "music", flag: "--storage music=<path>" },
		]);
		expect(err.expectedRefusal).toBe(true);
		expect(err.name).toBe("UnboundOperatorStorageError");
	});
});

describe("MissingOperatorStoragePathError (D-50 rule 2, row 3)", () => {
	const bind = {
		component: "default",
		volume: "music",
		key: "music",
		hostPath: "/srv/gone",
		containerPath: "/music",
	};

	it("uses the prose sentence for a single path and echoes the key as typed", () => {
		const err = new MissingOperatorStoragePathError([bind]);
		expect(err.message).toContain(
			"Cannot launch: a supplied storage path does not exist or is not readable.",
		);
		expect(err.message).toContain("  - default: music — --storage music=/srv/gone");
	});

	it("counts when more than one path is missing", () => {
		const err = new MissingOperatorStoragePathError([
			bind,
			{ ...bind, volume: "podcasts", key: "podcasts", hostPath: "/srv/also-gone" },
		]);
		expect(err.message).toContain(
			"Cannot launch: 2 supplied storage paths do not exist or are not readable.",
		);
	});

	it("is an expected refusal, so callers print it instead of a stack", () => {
		const err = new MissingOperatorStoragePathError([bind]);
		expect(err.expectedRefusal).toBe(true);
		expect(err.name).toBe("MissingOperatorStoragePathError");
	});
});
