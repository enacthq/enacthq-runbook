/**
 * Paths for Kitfly's built-in engine assets.
 *
 * The "engine" lives next to the CLI code (template, styles, default assets).
 * A user's "site" lives in the folder they point Kitfly at.
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ENGINE_ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), ".."));

export const ENGINE_SITE_DIR = join(ENGINE_ROOT, "src/site");
export const ENGINE_ASSETS_DIR = join(ENGINE_ROOT, "assets");

export const SITE_OVERRIDE_DIRNAME = "kitfly";

export function siteOverridePath(siteRoot: string, relPathFromKitflyDir: string): string {
	return join(siteRoot, SITE_OVERRIDE_DIRNAME, relPathFromKitflyDir);
}
