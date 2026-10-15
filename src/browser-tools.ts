import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
export const playwrightRoot = dirname(
	require.resolve("playwright/package.json"),
);
const playwrightRequire = createRequire(join(playwrightRoot, "package.json"));
export const playwrightCoreRoot = dirname(
	playwrightRequire.resolve("playwright-core/package.json"),
);
export const browserSkill = join(
	playwrightCoreRoot,
	"lib/tools/skills/playwright-cli",
);
// Fixed Playwright's own registry supplies platform revisions and cache paths.
const { registry } = require(join(playwrightCoreRoot, "lib/coreBundle.js"));
export const browserCacheDirectory: string = registry.registryDirectory;
export const browserResourcePaths: string[] = registry.registry
	.executables()
	.flatMap((entry: { directory?: string }) =>
		entry.directory ? [entry.directory] : [],
	);
