import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { ENGINE_ROOT } from "./engine.ts";
import { exists, parseYaml, validatePath } from "./shared.ts";

export class PluginNetworkError extends Error {}
export class PluginIntegrityError extends Error {}
export class PluginPolicyError extends Error {}
export class PluginConfigError extends Error {}

export type PluginInjections = {
	head: string;
	bodyEnd: string;
};

export type KitflyMode = "docs" | "slides";

type RegistryAssetChecksums = {
	js?: string;
	css?: string;
};

type RegistryAssets = {
	js?: string;
	css?: string;
	assetSha256: RegistryAssetChecksums;
};

type RegistryPlugin = {
	name: string;
	description: string;
	version: string;
	contract: string;
	kitfly: string;
	license: string;
	verified: boolean;
	modes?: KitflyMode[];
	assets: RegistryAssets;
};

type PluginRegistry = {
	version: number;
	updated: string;
	baseUrl: string;
	plugins: Record<string, RegistryPlugin>;
};

type CanonicalPluginRef = {
	id: string;
	version: string;
};

const PLUGIN_ID_RE = /^[a-z][a-z0-9-]*$/;
const SEMVER_RE =
	/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function parseCanonicalRef(spec: string): CanonicalPluginRef | null {
	const at = spec.lastIndexOf("@");
	if (at <= 0) return null;
	const id = spec.slice(0, at).trim();
	const version = spec.slice(at + 1).trim();
	if (!id || !version) return null;
	if (!PLUGIN_ID_RE.test(id) || id.length > 40) return null;
	if (!SEMVER_RE.test(version)) return null;
	return { id, version };
}

function sha256Hex(data: Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

function requiredSha256Hex(expected: string, context: string): string {
	if (!expected.startsWith("sha256:")) {
		throw new PluginConfigError(`${context}: expected sha256:<hex>, got ${expected}`);
	}
	const hex = expected.slice("sha256:".length);
	if (!/^[0-9a-f]{64}$/i.test(hex)) {
		throw new PluginConfigError(`${context}: invalid sha256 hex`);
	}
	return hex.toLowerCase();
}

function templateBaseUrl(url: string, baseUrl: string): string {
	const token = "${" + "baseUrl}";
	return url.replaceAll(token, baseUrl);
}

async function fetchTextOrThrow(url: string): Promise<string> {
	if (!/^https?:\/\//.test(url)) {
		throw new PluginConfigError(`Unsupported URL scheme: ${url}`);
	}
	let res: Response;
	try {
		res = await fetch(url);
	} catch (e) {
		throw new PluginNetworkError(`Failed to fetch ${url}: ${String(e)}`);
	}
	if (!res.ok)
		throw new PluginNetworkError(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
	return res.text();
}

async function readLocalTextOrThrow(root: string, relOrAbs: string): Promise<string> {
	const rel = relOrAbs.replace(/^\//, "");
	const fsPath = validatePath(root, ".", rel, true);
	if (!fsPath) throw new PluginConfigError(`Invalid local plugin asset path: ${relOrAbs}`);
	return readFile(fsPath, "utf-8");
}

async function fetchWithSha256Cache(
	cacheFile: string,
	url: string,
	expectedSha256Hex: string,
	assetRoot: string,
): Promise<string> {
	if (!/^https?:\/\//.test(url)) {
		const text = await readLocalTextOrThrow(assetRoot, url);
		const actual = sha256Hex(new TextEncoder().encode(text));
		if (actual !== expectedSha256Hex) {
			throw new PluginIntegrityError(
				`CHECKSUM MISMATCH for ${url}\n  expected: ${expectedSha256Hex}\n  got:      ${actual}`,
			);
		}
		return text;
	}

	if (await exists(cacheFile)) {
		const cached = await readFile(cacheFile);
		if (sha256Hex(cached) === expectedSha256Hex) return cached.toString("utf-8");
	}

	const text = await fetchTextOrThrow(url);
	const bytes = new TextEncoder().encode(text);
	const actual = sha256Hex(bytes);
	if (actual !== expectedSha256Hex) {
		throw new PluginIntegrityError(
			`CHECKSUM MISMATCH for ${url}\n  expected: ${expectedSha256Hex}\n  got:      ${actual}`,
		);
	}

	await mkdir(dirname(cacheFile), { recursive: true });
	await writeFile(cacheFile, text, "utf-8");
	return text;
}

export async function loadPluginRegistry(registryPath: string): Promise<PluginRegistry> {
	const raw = await readFile(registryPath, "utf-8");
	const parsed = parseYaml(raw) as unknown as PluginRegistry;
	if (!parsed || typeof parsed !== "object") throw new PluginConfigError("Invalid plugin registry");
	if (typeof parsed.baseUrl !== "string")
		throw new PluginConfigError("Invalid plugin registry shape");
	if (!parsed.plugins || typeof parsed.plugins !== "object") {
		throw new PluginConfigError("Invalid plugin registry shape");
	}
	return parsed;
}

export async function loadPluginInjections(opts: {
	root: string;
	mode?: KitflyMode;
	registryPath?: string;
	configPath?: string;
	cacheDir?: string;
	allowUntrusted?: boolean;
}): Promise<PluginInjections> {
	const configPath = opts.configPath ?? join(opts.root, "kitfly.plugins.yaml");
	const cacheDir = opts.cacheDir ?? join(opts.root, "node_modules", ".kitfly-plugins");
	const allowUntrusted = opts.allowUntrusted ?? false;
	const mode: KitflyMode = opts.mode ?? "docs";

	if (!(await exists(configPath))) return { head: "", bodyEnd: "" };

	const engineRegistryPath = join(ENGINE_ROOT, "registry", "plugins.yaml");
	const siteRegistryPath = join(opts.root, "registry", "plugins.yaml");
	const hasSiteRegistry = await exists(siteRegistryPath);
	const registryPath =
		opts.registryPath ?? (hasSiteRegistry ? siteRegistryPath : engineRegistryPath);
	const assetRoot = hasSiteRegistry ? opts.root : ENGINE_ROOT;

	if (!(await exists(registryPath)))
		throw new PluginConfigError(`Missing registry: ${registryPath}`);

	const registry = await loadPluginRegistry(registryPath);
	const config = parseYaml(await readFile(configPath, "utf-8")) as Record<string, unknown>;
	const plugins = Array.isArray(config.plugins) ? config.plugins : [];

	let head = "";
	let bodyEnd = "";

	for (const entry of plugins) {
		if (typeof entry !== "string") {
			if (allowUntrusted) {
				throw new PluginPolicyError("Third-party plugin objects are not supported yet");
			}
			throw new PluginPolicyError("Third-party plugins require --allow-untrusted");
		}

		const ref = parseCanonicalRef(entry);
		if (!ref) throw new PluginConfigError(`Invalid plugin ref: ${entry}`);
		const reg = registry.plugins?.[ref.id];
		if (!reg) throw new PluginConfigError(`Plugin not in registry: ${ref.id}`);
		if (reg.version !== ref.version) {
			throw new PluginConfigError(
				`Plugin ${ref.id} version mismatch: ${ref.version} != ${reg.version}`,
			);
		}

		if (Array.isArray(reg.modes)) {
			if (reg.modes.length === 0) continue;
			if (!reg.modes.includes(mode)) continue;
		}

		const assets = reg.assets;
		const pluginCacheDir = join(cacheDir, `${ref.id}@${ref.version}`);

		if (assets.css) {
			const url = templateBaseUrl(assets.css, registry.baseUrl);
			const expected = requiredSha256Hex(
				assets.assetSha256.css ?? "",
				`${ref.id}: assetSha256.css`,
			);
			const css = await fetchWithSha256Cache(
				join(pluginCacheDir, basename(url)),
				url,
				expected,
				assetRoot,
			);
			head += `\n<style data-kitfly-plugin="${ref.id}@${ref.version}">\n${css}\n</style>\n`;
		}
		if (assets.js) {
			const url = templateBaseUrl(assets.js, registry.baseUrl);
			const expected = requiredSha256Hex(assets.assetSha256.js ?? "", `${ref.id}: assetSha256.js`);
			const js = await fetchWithSha256Cache(
				join(pluginCacheDir, basename(url)),
				url,
				expected,
				assetRoot,
			);
			bodyEnd += `\n<script data-kitfly-plugin="${ref.id}@${ref.version}">\n${js}\n</script>\n`;
		}
	}

	return { head, bodyEnd };
}
