/**
 * Runtime installer registry.
 */

import type { Runtime } from "@launchfile/sdk";
import type { RuntimeInstaller } from "./types.js";
import { NodeInstaller } from "./node.js";
import { BunInstaller } from "./bun.js";
import { RubyInstaller } from "./ruby.js";
import { PythonInstaller } from "./python.js";

const installers: Partial<Record<Runtime, RuntimeInstaller>> = {
	node: new NodeInstaller(),
	bun: new BunInstaller(),
	ruby: new RubyInstaller(),
	python: new PythonInstaller(),
	// go, rust, etc. can be added later
};

export function getRuntimeInstaller(runtime: Runtime): RuntimeInstaller | undefined {
	return installers[runtime];
}

export type { RuntimeInstaller } from "./types.js";
