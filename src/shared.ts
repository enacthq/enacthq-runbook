/**
 * Shared utilities for Kitfly scripts (dev, build, bundle)
 *
 * This module contains common functions used across multiple scripts
 * to reduce duplication and ensure consistency.
 */

import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ENGINE_SITE_DIR, siteOverridePath } from "./engine.ts";

// ---------------------------------------------------------------------------
// Type definitions
// ---------------------------------------------------------------------------

export interface SiteSection {
	name: string;
	path: string;
	files?: string[];
	maxDepth?: number; // Max directory depth for auto-discovery (default: 4, max: 10)
	exclude?: string[]; // Glob patterns to exclude from auto-discovery
}

export interface SiteBrand {
	name: string;
	url: string;
	external?: boolean;
	logo?: string; // Path to logo image (default: assets/brand/logo.png)
	logoDark?: string; // Optional dark-mode logo image
	favicon?: string; // Path to favicon (default: assets/brand/favicon.png)
	logoType?: "icon" | "wordmark"; // icon = square, wordmark = wide
}

export interface KitflyBrand {
	readonly name: string;
	readonly url: string;
	readonly logo: string;
	readonly favicon: string;
}

export const KITFLY_BRAND: Readonly<KitflyBrand> = {
	name: "Kitfly",
	url: "https://kitfly.dev",
	logo: "assets/brand/kitfly-neon-128.png",
	favicon: "assets/brand/kitfly-favicon-32.png",
} as const;

export interface FooterLink {
	text: string;
	url: string;
}

export interface SiteFooter {
	copyright?: string;
	copyrightUrl?: string;
	links?: FooterLink[];
	attribution?: boolean;
	logo?: string;
	logoDark?: string;
	logoUrl?: string;
	logoAlt?: string;
	logoHeight?: number;
	// social?: SocialLinks; // Reserved for future
}

export interface SiteServer {
	port?: number; // Default dev server port
	host?: string; // Default dev server host
}

export interface ProfileConfig {
	description?: string;
	include?: {
		tags?: string[];
	};
}

export interface PrebuildHook {
	command: string;
	watch?: string[];
}

export type SiteMode = "docs" | "slides";
export type SlideAspect = "16/9" | "4/3" | "3/2" | "16/10";

export interface SiteConfig {
	docroot: string;
	dataroot?: string;
	title: string;
	version?: string;
	mode?: SiteMode;
	aspect?: SlideAspect;
	home?: string;
	brand: SiteBrand;
	sections: SiteSection[];
	footer?: SiteFooter;
	server?: SiteServer;
	profiles?: Record<string, ProfileConfig>;
	prebuild?: PrebuildHook[];
}

export interface Provenance {
	version?: string;
	buildDate: string;
	gitCommit: string;
	gitCommitDate: string;
	gitBranch: string;
}

export interface ContentFile {
	path: string;
	urlPath: string;
	section: string;
	sectionBase?: string;
}

export interface SlideSegment {
	index: number;
	frontmatter: Record<string, unknown>;
	body: string;
	title: string;
	className?: string;
}

export interface SlideContent extends SlideSegment {
	id: string;
	section: string;
	sourcePath: string;
	sourceUrlPath: string;
	kind: "markdown" | "yaml" | "json";
}

export interface CollectSlidesOptions {
	markdownTransform?: (raw: string, file: ContentFile) => Promise<string> | string;
}

export interface DataSnippet {
	slot: string;
	content: string;
}

export interface DataBindings {
	globals: Record<string, string>;
	inject: Record<string, string>;
	snippets: DataSnippet[];
}

// ---------------------------------------------------------------------------
// Environment and CLI helpers
// ---------------------------------------------------------------------------

export function envString(name: string, fallback: string): string {
	return process.env[name] ?? fallback;
}

export function envInt(name: string, fallback: number): number {
	const val = process.env[name];
	if (!val) return fallback;
	const parsed = parseInt(val, 10);
	return Number.isNaN(parsed) ? fallback : parsed;
}

export function envBool(name: string, fallback: boolean): boolean {
	const val = process.env[name]?.toLowerCase();
	if (!val) return fallback;
	if (["true", "1", "yes"].includes(val)) return true;
	if (["false", "0", "no"].includes(val)) return false;
	return fallback;
}

// ---------------------------------------------------------------------------
// Network utilities
// ---------------------------------------------------------------------------

/**
 * Check if a port is available by attempting to connect to it.
 * Returns true if port is free, false if in use.
 */
export async function isPortAvailable(port: number, host = "localhost"): Promise<boolean> {
	return new Promise((resolve) => {
		const net = require("node:net");
		const socket = new net.Socket();

		socket.setTimeout(1000);

		socket.on("connect", () => {
			socket.destroy();
			resolve(false); // Port is in use (connection succeeded)
		});

		socket.on("timeout", () => {
			socket.destroy();
			resolve(true); // Timeout = likely no one listening
		});

		socket.on("error", (err: NodeJS.ErrnoException) => {
			socket.destroy();
			if (err.code === "ECONNREFUSED") {
				resolve(true); // Connection refused = port is free
			} else {
				resolve(true); // Other errors = assume free
			}
		});

		socket.connect(port, host);
	});
}

/**
 * Check port and exit with error if in use.
 * Call this before starting a server.
 */
export async function checkPortOrExit(port: number, host = "localhost"): Promise<void> {
	const available = await isPortAvailable(port, host);
	if (!available) {
		console.error(`\x1b[31mError: Port ${port} is already in use\x1b[0m\n`);
		console.error(`Another process is listening on ${host}:${port}.`);
		console.error(`\nOptions:`);
		console.error(`  • Use a different port: --port ${port + 1}`);
		console.error(`  • Stop the other process first`);
		process.exit(1);
	}
}

// ---------------------------------------------------------------------------
// YAML/Config parsing
// ---------------------------------------------------------------------------

export function parseYaml(content: string): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	const lines = content.split("\n");

	function stripInlineComment(raw: string): string {
		let inSingle = false;
		let inDouble = false;
		let escaped = false;
		for (let i = 0; i < raw.length; i++) {
			const ch = raw[i];
			if (escaped) {
				escaped = false;
				continue;
			}
			if (ch === "\\") {
				escaped = true;
				continue;
			}
			if (!inDouble && ch === "'") {
				inSingle = !inSingle;
				continue;
			}
			if (!inSingle && ch === '"') {
				inDouble = !inDouble;
				continue;
			}
			if (!inSingle && !inDouble && ch === "#") {
				// YAML inline comment (outside quotes)
				return raw.slice(0, i).trimEnd();
			}
		}
		return raw.trimEnd();
	}

	// Stack tracks current object context with its base indentation
	const stack: { obj: Record<string, unknown>; indent: number }[] = [{ obj: result, indent: -2 }];

	function foldBlockScalarLines(blockLines: string[]): string {
		let output = "";
		for (let idx = 0; idx < blockLines.length; idx++) {
			const line = blockLines[idx];
			if (idx === 0) {
				output = line;
				continue;
			}
			const prev = blockLines[idx - 1];
			if (line === "") {
				output += "\n";
				continue;
			}
			output += prev === "" ? line : ` ${line}`;
		}
		return output;
	}

	function parseBlockHeader(
		token: string,
	): { style: "|" | ">"; chomp: "clip" | "strip" | "keep" } | null {
		if (!token) return null;
		const style = token[0];
		if (style !== "|" && style !== ">") return null;
		const tail = token.slice(1);
		if (tail && !/^([1-9][+-]?|[+-][1-9]?|[+-])$/.test(tail)) {
			return null;
		}
		const chomp = tail.includes("+") ? "keep" : tail.includes("-") ? "strip" : "clip";
		return { style, chomp };
	}

	function parseBlockScalar(
		startLine: number,
		baseIndent: number,
		style: "|" | ">",
		chomp: "clip" | "strip" | "keep",
	): { value: string; endLine: number } {
		const rawBlock: string[] = [];
		let cursor = startLine;

		while (cursor < lines.length) {
			const candidate = lines[cursor];
			if (candidate.trim() === "") {
				rawBlock.push("");
				cursor += 1;
				continue;
			}
			const candidateIndent = candidate.search(/\S/);
			if (candidateIndent <= baseIndent) break;
			rawBlock.push(candidate);
			cursor += 1;
		}

		const indentLevels = rawBlock
			.filter((line) => line.trim() !== "")
			.map((line) => line.search(/\S/));
		const blockIndent = indentLevels.length > 0 ? Math.min(...indentLevels) : 0;
		const blockLines = rawBlock.map((line) => {
			if (line === "") return "";
			return line.slice(blockIndent);
		});

		let value = style === "|" ? blockLines.join("\n") : foldBlockScalarLines(blockLines);
		if (chomp === "strip") value = value.replace(/\n+$/g, "");
		if (chomp === "keep" && value !== "" && !value.endsWith("\n")) value += "\n";
		return { value, endLine: cursor - 1 };
	}

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		// Skip comments and empty lines
		if (line.trim().startsWith("#") || line.trim() === "") continue;

		const indent = line.search(/\S/);
		const trimmed = line.trim();

		// Pop stack when we dedent
		while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
			stack.pop();
		}

		// Array item (starts with "- ")
		if (trimmed.startsWith("- ")) {
			const afterDash = trimmed.slice(2);
			const colonIndex = afterDash.indexOf(":");

			if (colonIndex > 0) {
				// Object in array: "- name: value"
				const key = afterDash.slice(0, colonIndex).trim();
				const val = stripInlineComment(afterDash.slice(colonIndex + 1).trim());

				// Create new object for this array item
				const obj: Record<string, unknown> = {};

				// Handle inline array value like files: ["a", "b"]
				if (val.startsWith("[") && val.endsWith("]")) {
					const arrContent = val.slice(1, -1);
					obj[key] = arrContent.split(",").map((s) => stripQuotes(s.trim()));
				} else {
					const header = parseBlockHeader(val);
					if (header) {
						const block = parseBlockScalar(i + 1, indent, header.style, header.chomp);
						obj[key] = block.value;
						i = block.endLine;
					} else if (val === "") {
						// Nested structure will follow
						obj[key] = null; // Placeholder
					} else {
						obj[key] = parseValue(val);
					}
				}

				// Find the array in parent
				const parent = stack[stack.length - 1].obj;
				const arrays = Object.entries(parent).filter(([, v]) => Array.isArray(v));
				if (arrays.length > 0) {
					const [, arr] = arrays[arrays.length - 1];
					(arr as unknown[]).push(obj);
				}

				// Push this object onto stack for subsequent properties
				stack.push({ obj, indent });
			} else {
				// Simple array item: "- value"
				const parent = stack[stack.length - 1].obj;
				const arrays = Object.entries(parent).filter(([, v]) => Array.isArray(v));
				if (arrays.length > 0) {
					const [, arr] = arrays[arrays.length - 1];
					const itemValue = stripInlineComment(afterDash.trim());
					const header = parseBlockHeader(itemValue);
					if (header) {
						const block = parseBlockScalar(i + 1, indent, header.style, header.chomp);
						(arr as unknown[]).push(block.value);
						i = block.endLine;
					} else {
						(arr as unknown[]).push(stripQuotes(itemValue));
					}
				}
			}
			continue;
		}

		// Key: value pair
		const colonIndex = trimmed.indexOf(":");
		if (colonIndex > 0) {
			const key = trimmed.slice(0, colonIndex).trim();
			const value = stripInlineComment(trimmed.slice(colonIndex + 1).trim());
			const parent = stack[stack.length - 1].obj;

			if (value === "") {
				// Check if next non-empty line is an array or object
				let nextIdx = i + 1;
				while (nextIdx < lines.length && lines[nextIdx].trim() === "") nextIdx++;

				if (nextIdx < lines.length && lines[nextIdx].trim().startsWith("- ")) {
					// It's an array
					parent[key] = [];
				} else {
					// It's a nested object
					const nested: Record<string, unknown> = {};
					parent[key] = nested;
					stack.push({ obj: nested, indent });
				}
			} else if (value.startsWith("[") && value.endsWith("]")) {
				// Inline array
				const arrContent = value.slice(1, -1);
				parent[key] = arrContent.split(",").map((s) => stripQuotes(s.trim()));
			} else {
				const header = parseBlockHeader(value);
				if (header) {
					const block = parseBlockScalar(i + 1, indent, header.style, header.chomp);
					parent[key] = block.value;
					i = block.endLine;
				} else {
					parent[key] = parseValue(value);
				}
			}
		}
	}

	return result;
}

export function parseValue(value: string): unknown {
	const stripped = stripQuotes(value);
	if (stripped === "true") return true;
	if (stripped === "false") return false;
	return stripped;
}

export function stripQuotes(value: string): string {
	if (
		(value.startsWith('"') && value.endsWith('"')) ||
		(value.startsWith("'") && value.endsWith("'"))
	) {
		return value.slice(1, -1);
	}
	return value;
}

// ---------------------------------------------------------------------------
// File utilities
// ---------------------------------------------------------------------------

export async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * Validate path doesn't escape repo root
 * @param root - The root directory
 * @param docroot - The document root relative to ROOT
 * @param requestedPath - The requested path
 * @param logErrors - Whether to log errors (default: false)
 * @returns The resolved path or null if invalid
 */
export function validatePath(
	root: string,
	docroot: string,
	requestedPath: string,
	logErrors = false,
): string | null {
	const resolved = resolve(root, docroot, requestedPath);
	const normalizedRoot = resolve(root);
	if (!resolved.startsWith(`${normalizedRoot}${sep}`) && resolved !== normalizedRoot) {
		if (logErrors) {
			console.error(`Path escapes repo root: ${requestedPath}`);
		}
		return null;
	}
	return resolved;
}

/**
 * Normalize a resolved path to a URL-safe path relative to ROOT
 * Handles ../docs/decisions -> docs/decisions
 */
export function toUrlPath(root: string, resolvedPath: string): string {
	const normalizedRoot = resolve(root);
	if (resolvedPath.startsWith(`${normalizedRoot}${sep}`)) {
		return resolvedPath.slice(normalizedRoot.length + 1).replaceAll("\\", "/");
	}
	return resolvedPath;
}

export async function resolveTemplatePath(siteRoot: string): Promise<string> {
	const override = siteOverridePath(siteRoot, "template.html");
	if (await exists(override)) return override;
	return join(ENGINE_SITE_DIR, "template.html");
}

export async function resolveStylesPath(siteRoot: string): Promise<string> {
	const override = siteOverridePath(siteRoot, "styles.css");
	if (await exists(override)) return override;
	return join(ENGINE_SITE_DIR, "styles.css");
}

// ---------------------------------------------------------------------------
// Markdown utilities
// ---------------------------------------------------------------------------

export function parseFrontmatter(content: string): {
	frontmatter: Record<string, unknown>;
	body: string;
} {
	const normalized = content.replace(/^\uFEFF/, "").replaceAll("\r\n", "\n");
	const lines = normalized.split("\n");

	let i = 0;
	while (i < lines.length && lines[i].trim() === "") i += 1;
	if (i >= lines.length || lines[i].trim() !== "---") {
		return { frontmatter: {}, body: content };
	}

	i += 1;
	const fmLines: string[] = [];
	while (i < lines.length && lines[i].trim() !== "---") {
		fmLines.push(lines[i]);
		i += 1;
	}
	if (i >= lines.length) return { frontmatter: {}, body: content };
	i += 1; // consume closing ---

	const body = lines.slice(i).join("\n");

	const frontmatter: Record<string, unknown> = {};
	for (const line of fmLines) {
		const colonIndex = line.indexOf(":");
		if (colonIndex > 0) {
			const key = line.slice(0, colonIndex).trim();
			let value = line.slice(colonIndex + 1).trim();
			// Remove quotes if present
			if (
				(value.startsWith('"') && value.endsWith('"')) ||
				(value.startsWith("'") && value.endsWith("'"))
			) {
				value = value.slice(1, -1);
			}
			frontmatter[key] = value;
		}
	}

	return { frontmatter, body };
}

export function mergeFrontmatterWithBody(originalContent: string, body: string): string {
	const normalized = originalContent.replace(/^\uFEFF/, "").replaceAll("\r\n", "\n");
	const lines = normalized.split("\n");

	let i = 0;
	while (i < lines.length && lines[i].trim() === "") i += 1;
	if (i >= lines.length || lines[i].trim() !== "---") {
		return body;
	}

	i += 1;
	while (i < lines.length && lines[i].trim() !== "---") {
		i += 1;
	}
	if (i >= lines.length) return body;
	i += 1; // consume closing ---

	const prefix = lines.slice(0, i).join("\n");
	return `${prefix}\n${body}`;
}

export function normalizeProfileTags(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value
			.filter((entry): entry is string => typeof entry === "string")
			.map((entry) => entry.trim().toLowerCase())
			.filter((entry) => entry.length > 0);
	}

	if (typeof value !== "string") return [];
	const raw = value.trim();
	if (!raw) return [];

	if (raw.startsWith("[") && raw.endsWith("]")) {
		const inner = raw.slice(1, -1).trim();
		if (!inner) return [];
		return inner
			.split(",")
			.map((entry) => stripQuotes(entry.trim()).toLowerCase())
			.filter((entry) => entry.length > 0);
	}

	return [stripQuotes(raw).toLowerCase()].filter((entry) => entry.length > 0);
}

function normalizePathForMatch(pathValue: string): string {
	return pathValue
		.replaceAll("\\", "/")
		.replace(/^\.\/+/, "")
		.replace(/^\/+/, "");
}

export function pagePathForData(siteRoot: string, docroot: string, filePath: string): string {
	const relFromDocroot = normalizePathForMatch(relative(resolve(siteRoot, docroot), filePath));
	if (relFromDocroot && !relFromDocroot.startsWith("../")) return relFromDocroot;
	return normalizePathForMatch(relative(siteRoot, filePath));
}

function toStringRecord(raw: unknown): Record<string, string> {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		if (typeof value === "string") result[key] = value;
		else if (typeof value === "number" || typeof value === "boolean") result[key] = String(value);
	}
	return result;
}

function toSnippetArray(raw: unknown): DataSnippet[] {
	if (!Array.isArray(raw)) return [];
	return raw
		.map((item) => {
			if (!item || typeof item !== "object") return null;
			const entry = item as Record<string, unknown>;
			if (typeof entry.slot !== "string" || typeof entry.content !== "string") return null;
			return { slot: entry.slot, content: entry.content };
		})
		.filter((item): item is DataSnippet => !!item);
}

function validateSchemaNode(
	value: unknown,
	schema: unknown,
	pathLabel: string,
	dataPath: string,
): void {
	if (!schema || typeof schema !== "object") return;
	const schemaObj = schema as Record<string, unknown>;
	const type = typeof schemaObj.type === "string" ? schemaObj.type : undefined;

	if (type) {
		const valid =
			(type === "object" && value !== null && typeof value === "object" && !Array.isArray(value)) ||
			(type === "array" && Array.isArray(value)) ||
			(type === "string" && typeof value === "string") ||
			(type === "number" && typeof value === "number") ||
			(type === "boolean" && typeof value === "boolean");
		if (!valid) {
			throw new Error(`schema validation failed at ${pathLabel} in ${dataPath}: expected ${type}`);
		}
	}

	if (type === "string" && typeof value === "string" && typeof schemaObj.pattern === "string") {
		const re = new RegExp(schemaObj.pattern);
		if (!re.test(value)) {
			throw new Error(
				`schema validation failed at ${pathLabel} in ${dataPath}: value does not match pattern`,
			);
		}
	}

	if (type === "object" && value && typeof value === "object" && !Array.isArray(value)) {
		const obj = value as Record<string, unknown>;
		const required = Array.isArray(schemaObj.required)
			? schemaObj.required.filter((key): key is string => typeof key === "string")
			: [];
		for (const key of required) {
			if (!(key in obj)) {
				throw new Error(`schema validation failed at ${pathLabel}.${key} in ${dataPath}: required`);
			}
		}
		if (schemaObj.properties && typeof schemaObj.properties === "object") {
			for (const [key, subSchema] of Object.entries(
				schemaObj.properties as Record<string, unknown>,
			)) {
				if (key in obj) {
					validateSchemaNode(obj[key], subSchema, `${pathLabel}.${key}`, dataPath);
				}
			}
		}
	}

	if (type === "array" && Array.isArray(value) && schemaObj.items) {
		for (const [idx, item] of value.entries()) {
			validateSchemaNode(item, schemaObj.items, `${pathLabel}[${idx}]`, dataPath);
		}
	}
}

async function maybeValidateDataSchema(resolvedDataPath: string, parsed: unknown): Promise<void> {
	const schemaPath = resolvedDataPath.replace(/\.(ya?ml|json)$/i, ".schema.json");
	if (!(await exists(schemaPath))) return;

	let schema: unknown;
	try {
		schema = JSON.parse(await readFile(schemaPath, "utf-8"));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`schema validation failed: invalid schema JSON ${schemaPath} (${message})`);
	}

	validateSchemaNode(parsed, schema, "$", normalizePathForMatch(schemaPath));
}

function parseNumeric(value: string, formatter: string, key: string, filePath: string): number {
	const n = Number(value);
	if (Number.isNaN(n)) {
		throw new Error(
			`${formatter} formatter: "${value}" is not a number (key "${key}" in ${filePath})`,
		);
	}
	return n;
}

function applyFormatter(formatter: string, value: string, key: string, filePath: string): string {
	const round = formatter.match(/^round\((\d+)\)$/);
	if (round) {
		const n = parseNumeric(value, formatter, key, filePath);
		return n.toFixed(parseInt(round[1], 10));
	}

	switch (formatter) {
		case "dollar": {
			const n = parseNumeric(value, formatter, key, filePath);
			return Number.isInteger(n)
				? `$${n.toLocaleString("en-US")}`
				: `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
		}
		case "number":
			return parseNumeric(value, formatter, key, filePath).toLocaleString("en-US");
		case "percent":
			return `${parseNumeric(value, formatter, key, filePath) * 100}%`;
		case "upper":
			return value.toUpperCase();
		case "lower":
			return value.toLowerCase();
		default:
			throw new Error(`unknown formatter "${formatter}" in ${filePath}`);
	}
}

export async function loadDataBindings(
	dataPath: string,
	pagePath: string,
	siteRoot: string,
	docroot = ".",
	dataroot = "data",
): Promise<DataBindings> {
	const siteRootReal = await realpath(siteRoot);
	const normalizedDataPath = normalizePathForMatch(dataPath);
	const dataDir = validatePath(siteRoot, ".", dataroot);
	const resolved = validatePath(siteRoot, ".", normalizedDataPath);
	if (!dataDir || !resolved) throw new Error(`data path escapes kitsite: ${dataPath}`);
	if (!resolved.startsWith(`${dataDir}${sep}`) && resolved !== dataDir) {
		throw new Error(`data path escapes dataroot: ${dataPath}`);
	}
	if (!(await exists(resolved))) {
		throw new Error(`data file not found: ${dataPath}`);
	}
	const dataDirReal = await realpath(dataDir);
	const resolvedReal = await realpath(resolved);
	if (!dataDirReal.startsWith(`${siteRootReal}${sep}`) && dataDirReal !== siteRootReal) {
		throw new Error(`data path escapes kitsite: ${dataPath}`);
	}
	if (!resolvedReal.startsWith(`${siteRootReal}${sep}`) && resolvedReal !== siteRootReal) {
		throw new Error(`data path escapes kitsite: ${dataPath}`);
	}
	if (!resolvedReal.startsWith(`${dataDirReal}${sep}`) && resolvedReal !== dataDirReal) {
		throw new Error(`data path escapes dataroot: ${dataPath}`);
	}

	const raw = await readFile(resolved, "utf-8");
	const parsed = normalizedDataPath.endsWith(".json")
		? JSON.parse(raw)
		: (parseYaml(raw) as Record<string, unknown>);
	await maybeValidateDataSchema(resolved, parsed);

	const doc = parsed as Record<string, unknown>;
	const globals = toStringRecord(doc.globals);
	const normalizedPagePath = normalizePathForMatch(pagePath);
	const rootRelativePagePath = normalizePathForMatch(
		relative(siteRoot, resolve(siteRoot, docroot, normalizedPagePath)),
	);
	const pages = Array.isArray(doc.pages) ? doc.pages : [];
	const pageEntry = pages.find((entry) => {
		if (!entry || typeof entry !== "object") return false;
		const pathValue = normalizePathForMatch((entry as Record<string, unknown>).path as string);
		return pathValue === normalizedPagePath || pathValue === rootRelativePagePath;
	}) as Record<string, unknown> | undefined;

	return {
		globals,
		inject: pageEntry ? toStringRecord(pageEntry.inject) : {},
		snippets: pageEntry ? toSnippetArray(pageEntry.snippets) : [],
	};
}

export function resolveBindings(content: string, bindings: DataBindings, filePath: string): string {
	const values = { ...bindings.globals, ...bindings.inject };

	const resolvedSnippets = content.replace(
		/\{\{\s*snippet:([A-Za-z0-9][\w-]*)\s*\}\}/g,
		(_match, slot: string) => {
			const snippet = bindings.snippets.find((entry) => entry.slot === slot);
			if (!snippet) throw new Error(`unknown snippet "${slot}" in ${filePath}`);
			return snippet.content;
		},
	);

	return resolvedSnippets.replace(
		/\{\{\s*([A-Za-z0-9][\w-]*)(\s*(?:\|[^}]+)?)\s*\}\}/g,
		(_match, key: string, rawPipeline: string) => {
			const value = values[key];
			if (value === undefined) throw new Error(`unresolved binding "${key}" in ${filePath}`);
			const steps = rawPipeline
				.split("|")
				.map((part) => part.trim())
				.filter(Boolean);
			return steps.reduce((acc, step) => applyFormatter(step, acc, key, filePath), value);
		},
	);
}

function commandForPlatform(command: string): string[] {
	if (process.platform === "win32") return ["cmd", "/d", "/s", "/c", command];
	return ["sh", "-lc", command];
}

export async function runPrebuildHooks(
	hooks: PrebuildHook[],
	siteRoot: string,
	buildMode: "dev" | "build" | "bundle",
	profile?: string,
	dataroot = "data",
	changedPath?: string,
): Promise<number> {
	if (!hooks.length) return 0;
	const normalizedChangedPath = changedPath ? normalizePathForMatch(changedPath) : undefined;
	const filteredHooks = normalizedChangedPath
		? hooks.filter((hook) =>
				Array.isArray(hook.watch)
					? hook.watch.some((pattern) => globMatch(pattern, normalizedChangedPath))
					: false,
			)
		: hooks;
	if (!filteredHooks.length) return 0;

	const normalizedDataDir = `${normalizePathForMatch(dataroot).replace(/\/+$/, "") || "data"}/`;
	const env = {
		...process.env,
		KITFLY_SITE_ROOT: siteRoot,
		KITFLY_DATA_DIR: normalizedDataDir,
		KITFLY_BUILD_MODE: buildMode,
		...(profile ? { KITFLY_PROFILE: profile } : {}),
	};

	for (const hook of filteredHooks) {
		if (!hook.command) continue;
		const result = Bun.spawnSync(commandForPlatform(hook.command), {
			cwd: siteRoot,
			env,
			stdout: "inherit",
			stderr: "pipe",
		});
		if (result.exitCode !== 0) {
			const stderr = new TextDecoder().decode(result.stderr).trim();
			const detail = stderr ? `\n${stderr}` : "";
			throw new Error(`prebuild hook failed (exit ${result.exitCode}): ${hook.command}${detail}`);
		}
	}

	return filteredHooks.length;
}

export async function filterByProfile(
	files: ContentFile[],
	activeProfile?: string,
	profileConfig?: Record<string, ProfileConfig>,
): Promise<ContentFile[]> {
	const normalizedProfile = activeProfile?.trim().toLowerCase();
	const hasProfilesConfig = !!profileConfig && Object.keys(profileConfig).length > 0;
	if (!normalizedProfile && !hasProfilesConfig) {
		// Backward compatibility: no profiles configured means no filtering at all.
		return files;
	}

	let allowedTags = normalizedProfile ? [normalizedProfile] : [];
	if (normalizedProfile && profileConfig?.[normalizedProfile]?.include?.tags) {
		allowedTags = normalizeProfileTags(profileConfig[normalizedProfile].include?.tags ?? []);
	}

	const filtered: ContentFile[] = [];
	for (const file of files) {
		let content = "";
		try {
			content = await readFile(file.path, "utf-8");
		} catch {
			// If a file disappears during watch/build, skip it.
			continue;
		}
		const { frontmatter } = parseFrontmatter(content);
		const tags = normalizeProfileTags(frontmatter.profile);

		// Untagged content is always included.
		if (tags.length === 0) {
			filtered.push(file);
			continue;
		}

		// Tagged content is opt-in via active profile match.
		if (normalizedProfile && tags.some((tag) => allowedTags.includes(tag))) {
			filtered.push(file);
		}
	}

	return filtered;
}

export function slugify(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^\w\s-]/g, "")
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-")
		.trim();
}

export type SlidesVisualsFenceDiagnostic = {
	line: number;
	message: string;
	type?: string;
};

interface FenceState {
	char: "`" | "~";
	length: number;
}

interface FenceMarker extends FenceState {
	trailer: string;
}

function parseFenceMarker(trimmed: string): FenceMarker | null {
	const match = trimmed.match(/^([`~]{3,})(.*)$/);
	if (!match) return null;
	const marker = match[1];
	if (!marker.split("").every((ch) => ch === marker[0])) return null;
	const char = marker[0] as "`" | "~";
	return { char, length: marker.length, trailer: match[2] };
}

function updateFenceState(trimmed: string, fence: FenceState | null): FenceState | null {
	const marker = parseFenceMarker(trimmed);
	if (!marker) return fence;

	if (!fence) {
		return { char: marker.char, length: marker.length };
	}

	// Markdown closing fences must use the same fence character and at least the same length.
	if (marker.char === fence.char && marker.length >= fence.length && marker.trailer.trim() === "") {
		return null;
	}

	return fence;
}

const SLIDES_VISUALS_TYPES = new Set([
	"kpi",
	"stat-grid",
	"compare",
	"quadrant-grid",
	"scorecard",
	"comparison-table",
	"layer-cake",
	"pyramid",
	"funnel",
	"timeline-horizontal",
	"timeline-vertical",
	"flow-branching",
	"flow-converging",
	"staircase",
]);

const SLIDES_VISUALS_RULES: Record<
	string,
	{
		required: string[];
		scalars: string[];
		lists: Record<
			string,
			{ kind: "strings" } | { kind: "objects"; fields: string[]; optional?: string[] }
		>;
	}
> = {
	kpi: {
		required: ["label", "value"],
		scalars: ["label", "value", "trend"],
		lists: {},
	},
	"stat-grid": {
		required: ["metrics"],
		scalars: [],
		lists: { metrics: { kind: "objects", fields: ["label", "value"], optional: ["trend"] } },
	},
	compare: {
		required: ["left", "right"],
		scalars: ["left-title", "right-title"],
		lists: { left: { kind: "strings" }, right: { kind: "strings" } },
	},
	"quadrant-grid": {
		required: ["tl", "tr", "bl", "br"],
		scalars: ["axis-x", "axis-y", "tl", "tr", "bl", "br"],
		lists: {},
	},
	scorecard: {
		required: ["metrics"],
		scalars: [],
		lists: { metrics: { kind: "objects", fields: ["label", "value"], optional: ["trend"] } },
	},
	"comparison-table": {
		required: ["headers", "rows"],
		scalars: [],
		lists: { headers: { kind: "strings" }, rows: { kind: "strings" } },
	},
	"layer-cake": {
		required: ["layers"],
		scalars: [],
		lists: { layers: { kind: "strings" } },
	},
	pyramid: {
		required: ["levels"],
		scalars: [],
		lists: { levels: { kind: "strings" } },
	},
	funnel: {
		required: ["stages"],
		scalars: [],
		lists: { stages: { kind: "strings" } },
	},
	"timeline-horizontal": {
		required: ["events"],
		scalars: [],
		lists: { events: { kind: "objects", fields: ["label"], optional: ["date"] } },
	},
	"timeline-vertical": {
		required: ["events"],
		scalars: [],
		lists: { events: { kind: "objects", fields: ["label"], optional: ["date"] } },
	},
	"flow-branching": {
		required: ["source", "branches"],
		scalars: ["source", "split"],
		lists: { branches: { kind: "strings" } },
	},
	"flow-converging": {
		required: ["sources", "target"],
		scalars: ["target", "merge"],
		lists: { sources: { kind: "strings" } },
	},
	staircase: {
		required: ["steps"],
		scalars: ["direction"],
		lists: { steps: { kind: "strings" } },
	},
};

/**
 * Validate slides-visuals `:::` blocks in a single markdown slide body.
 * This contract is intentionally strict so writers/devs don’t guess at edge cases.
 */
export function validateSlidesVisualsFences(markdown: string): SlidesVisualsFenceDiagnostic[] {
	const diagnostics: SlidesVisualsFenceDiagnostic[] = [];
	const lines = markdown.replaceAll("\r\n", "\n").split("\n");

	let mdFence: FenceState | null = null;
	let inVisual = false;
	let visualType = "";
	let visualStart = 0;
	let seenKeys = new Set<string>();
	let currentListKey: string | null = null;
	let listItems = 0;
	let listItemFields: Record<string, Set<string>> | null = null;

	function err(line: number, message: string) {
		diagnostics.push({ line, message, type: inVisual ? visualType : undefined });
	}

	function finishFence(closeLine: number) {
		const rules = SLIDES_VISUALS_RULES[visualType];
		if (!rules) return;

		for (const key of rules.required) {
			if (!seenKeys.has(key)) {
				err(visualStart, `Missing required key: ${key}`);
			}
		}

		if (currentListKey && listItems === 0) {
			err(closeLine, `List '${currentListKey}' must have at least one item`);
		}

		if (listItemFields) {
			for (const [requiredKey, fields] of Object.entries(listItemFields)) {
				const listRule = rules.lists[requiredKey];
				if (!listRule || listRule.kind !== "objects") continue;
				for (const req of listRule.fields) {
					if (!fields.has(req))
						err(visualStart, `List '${requiredKey}' items must include '${req}'`);
				}
			}
		}
	}

	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i];
		const trimmed = raw.trim();

		mdFence = updateFenceState(trimmed, mdFence);
		if (mdFence) continue;

		if (!inVisual) {
			if (trimmed.startsWith(":::") && !raw.startsWith(":::")) {
				const mBad = trimmed.match(/^:::\s*([a-z0-9-]+)\s*$/i);
				const type = mBad?.[1]?.toLowerCase();
				diagnostics.push({
					line: i + 1,
					message: "Opening ::: fence must start at column 0",
					type,
				});
				continue;
			}
			const m = raw.match(/^:::\s*([a-z0-9-]+)\s*$/i);
			if (!m) continue;
			const type = m[1].toLowerCase();
			if (!SLIDES_VISUALS_TYPES.has(type)) {
				diagnostics.push({
					line: i + 1,
					message: `Unknown slides-visuals block type: ${type}`,
					type,
				});
				continue;
			}
			inVisual = true;
			visualType = type;
			visualStart = i + 1;
			seenKeys = new Set();
			currentListKey = null;
			listItems = 0;
			listItemFields = null;
			continue;
		}

		// inside visual fence
		if (trimmed === ":::" && !raw.startsWith(":::")) {
			err(i + 1, "Closing ::: fence must start at column 0");
			continue;
		}

		if (raw.match(/^:::\s*$/)) {
			finishFence(i + 1);
			inVisual = false;
			visualType = "";
			currentListKey = null;
			continue;
		}

		if (trimmed === "") {
			err(i + 1, "Blank lines are not allowed inside ::: blocks");
			continue;
		}

		if (/^\s/.test(raw)) {
			// list item or list continuation
			if (!currentListKey) {
				err(i + 1, "Indented content is only allowed inside a list");
				continue;
			}

			const listRule = SLIDES_VISUALS_RULES[visualType]?.lists[currentListKey];
			const item = raw.match(/^ {2}-\s+(.+)$/);
			if (item) {
				listItems += 1;
				if (listRule?.kind === "objects") {
					const kv = item[1].match(/^([a-z][a-z0-9-]*)\s*:\s*(.+)$/i);
					if (!listItemFields) listItemFields = {};
					const fields = listItemFields;
					fields[currentListKey] ??= new Set<string>();
					if (kv) fields[currentListKey].add(kv[1].toLowerCase());
				}
				continue;
			}

			const cont = raw.match(/^ {4}([a-z][a-z0-9-]*)\s*:\s*(.+)$/i);
			if (cont) {
				if (listRule?.kind !== "objects") {
					err(i + 1, `List '${currentListKey}' items must be strings (no object fields)`);
					continue;
				}
				if (!listItemFields) listItemFields = {};
				const fields = listItemFields;
				fields[currentListKey] ??= new Set<string>();
				fields[currentListKey].add(cont[1].toLowerCase());
				continue;
			}

			err(i + 1, "Invalid list syntax (expected '  - ...' or '    field: value')");
			continue;
		}

		const rules = SLIDES_VISUALS_RULES[visualType];
		if (!rules) continue;

		const kv = raw.match(/^([a-z][a-z0-9-]*)\s*:\s*(.*)$/i);
		if (!kv) {
			err(i + 1, "Invalid line inside ::: block (expected 'key: value' or 'key:')");
			continue;
		}

		const key = kv[1].toLowerCase();
		const value = kv[2];

		if (value === "") {
			// list key
			const listRule = rules.lists[key];
			if (!listRule) {
				err(i + 1, `Key '${key}' is not a supported list for ${visualType}`);
				continue;
			}
			seenKeys.add(key);
			currentListKey = key;
			listItems = 0;
			continue;
		}

		// scalar key
		if (!rules.scalars.includes(key)) {
			err(i + 1, `Key '${key}' is not a supported scalar for ${visualType}`);
			continue;
		}
		seenKeys.add(key);
		currentListKey = null;
	}

	if (inVisual) {
		diagnostics.push({
			line: visualStart,
			message: `Unclosed ::: block (missing closing ':::')`,
			type: visualType,
		});
	}

	return diagnostics;
}

export function filterUnknownSlidesVisualsTypeDiagnostics(
	diagnostics: SlidesVisualsFenceDiagnostic[],
): SlidesVisualsFenceDiagnostic[] {
	return diagnostics.filter((d) => !d.message.startsWith("Unknown slides-visuals block type:"));
}

/**
 * Split markdown content into slide chunks using explicit delimiter.
 * Delimiter lines inside fenced code blocks are ignored.
 */
export function splitSlides(content: string): string[] {
	const lines = content.split(/\r?\n/);
	const slides: string[] = [];
	let current: string[] = [];
	let fence: FenceState | null = null;

	for (const line of lines) {
		const trimmed = line.trim();
		fence = updateFenceState(trimmed, fence);

		if (!fence && trimmed === "--- slide ---") {
			slides.push(current.join("\n"));
			current = [];
			continue;
		}

		current.push(line);
	}
	slides.push(current.join("\n"));

	return slides.filter((s) => s.trim() !== "");
}

function extractHeadingTitle(markdown: string): string | undefined {
	const lines = markdown.split(/\r?\n/);
	let fence: FenceState | null = null;

	for (const line of lines) {
		const trimmed = line.trim();
		fence = updateFenceState(trimmed, fence);

		if (fence) continue;
		const match = trimmed.match(/^#{1,6}\s+(.+)$/);
		if (match) {
			return match[1].replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").trim();
		}
	}

	return undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed === "" ? undefined : trimmed;
}

function sanitizeClassNameList(value: unknown): string | undefined {
	const classList = asNonEmptyString(value);
	if (!classList) return undefined;

	const safeTokens = classList
		.split(/\s+/)
		.map((token) => token.trim())
		.filter(Boolean)
		.filter((token) => /^[A-Za-z0-9_-]+$/.test(token));

	return safeTokens.length > 0 ? safeTokens.join(" ") : undefined;
}

/**
 * Parse markdown into slide segments with resolved titles and optional classes.
 * Title precedence: frontmatter.title -> first heading -> fallback title.
 */
export function segmentSlides(content: string, fallbackTitle: string): SlideSegment[] {
	const parts = splitSlides(content);
	const total = parts.length;

	return parts.map((part, index) => {
		const { frontmatter, body } = parseFrontmatter(part);
		const fmTitle = asNonEmptyString(frontmatter.title);
		const headingTitle = extractHeadingTitle(body);
		const autoFallback = total > 1 ? `${fallbackTitle} (${index + 1})` : fallbackTitle;
		const title = fmTitle || headingTitle || autoFallback;
		const className = sanitizeClassNameList(frontmatter.class);

		return {
			index,
			frontmatter,
			body,
			title,
			className,
		};
	});
}

/**
 * Collect slide content objects from discovered content files.
 * Markdown files can produce multiple slides via explicit delimiters.
 */
export async function collectSlides(
	files: ContentFile[],
	options: CollectSlidesOptions = {},
): Promise<SlideContent[]> {
	const slides: SlideContent[] = [];
	let index = 0;

	for (const file of files) {
		const raw = await readFile(file.path, "utf-8");
		const stem = basename(file.path, extname(file.path));

		if (file.path.endsWith(".md")) {
			const markdown = options.markdownTransform ? await options.markdownTransform(raw, file) : raw;
			const segments = segmentSlides(markdown, stem);
			for (const segment of segments) {
				index += 1;
				slides.push({
					...segment,
					id: `slide-${index}`,
					section: file.section,
					sourcePath: file.path,
					sourceUrlPath: file.urlPath,
					kind: "markdown",
				});
			}
			continue;
		}

		index += 1;
		slides.push({
			index: 0,
			frontmatter: {},
			body: raw,
			title: stem,
			className: undefined,
			id: `slide-${index}`,
			section: file.section,
			sourcePath: file.path,
			sourceUrlPath: file.urlPath,
			kind: file.path.endsWith(".yaml") ? "yaml" : "json",
		});
	}

	return slides;
}

interface SlideNavGroup {
	name: string;
	groups: Map<string, SlideNavGroup>;
	slides: SlideContent[];
}

function sectionRelativePath(sourceUrlPath: string, sectionBase: string): string {
	if (!sectionBase) return sourceUrlPath;
	if (sourceUrlPath === sectionBase) return "";
	if (sourceUrlPath.startsWith(`${sectionBase}/`))
		return sourceUrlPath.slice(sectionBase.length + 1);
	return sourceUrlPath;
}

function toTitleCaseSlug(segment: string): string {
	return segment
		.split(/[-_]/)
		.filter(Boolean)
		.map((token) => token.charAt(0).toUpperCase() + token.slice(1))
		.join(" ");
}

function createSlideNavGroup(name: string): SlideNavGroup {
	return { name, groups: new Map(), slides: [] };
}

function buildSlideSectionTree(items: SlideContent[], sectionBase: string): SlideNavGroup {
	const root = createSlideNavGroup("");
	for (const slide of items) {
		const rel = sectionRelativePath(slide.sourceUrlPath, sectionBase);
		const segments = rel.split("/").filter(Boolean);
		segments.pop(); // Drop file stem so nav groups only reflect subfolders.

		let node = root;
		for (const segment of segments) {
			let next = node.groups.get(segment);
			if (!next) {
				next = createSlideNavGroup(toTitleCaseSlug(segment));
				node.groups.set(segment, next);
			}
			node = next;
		}
		node.slides.push(slide);
	}
	return root;
}

function slideGroupContains(group: SlideNavGroup, currentSlideId: string | undefined): boolean {
	if (!currentSlideId) return false;
	if (group.slides.some((slide) => slide.id === currentSlideId)) return true;
	for (const child of group.groups.values()) {
		if (slideGroupContains(child, currentSlideId)) return true;
	}
	return false;
}

function renderSlideGroup(group: SlideNavGroup, currentSlideId?: string): string {
	let html = "<ul>";

	for (const slide of group.slides) {
		const active = currentSlideId === slide.id ? ' class="active"' : "";
		html += `<li><a href="#${slide.id}"${active}>${escapeHtml(slide.title)}</a></li>`;
	}

	for (const child of group.groups.values()) {
		const open = slideGroupContains(child, currentSlideId) ? " open" : "";
		html += `<li><details${open}><summary class="nav-group">${escapeHtml(child.name)}</summary>`;
		html += renderSlideGroup(child, currentSlideId);
		html += "</details></li>";
	}

	html += "</ul>";
	return html;
}

export function buildSlideNavHierarchical(
	slides: SlideContent[],
	config: SiteConfig,
	currentSlideId?: string,
): string {
	const grouped = new Map<string, SlideContent[]>();
	for (const slide of slides) {
		if (!grouped.has(slide.section)) grouped.set(slide.section, []);
		grouped.get(slide.section)?.push(slide);
	}

	let html = "<ul>";
	for (const section of config.sections) {
		const items = grouped.get(section.name);
		if (!items || items.length === 0) continue;
		const sectionBase = section.path.replace(/^\/+|\/+$/g, "");
		const tree = buildSlideSectionTree(items, sectionBase);
		html += `<li><span class="nav-section">${escapeHtml(section.name)}</span>`;
		html += renderSlideGroup(tree, currentSlideId);
		html += "</li>";
	}
	html += "</ul>";
	return html;
}

// Backwards-compatible alias.
export function buildSlideNav(
	slides: SlideContent[],
	config: SiteConfig,
	currentSlideId?: string,
): string {
	return buildSlideNavHierarchical(slides, config, currentSlideId);
}

function resolveRelativeContentPath(pathOrRef: string, currentUrlPath?: string): string {
	let cleaned = pathOrRef;
	if (currentUrlPath && !cleaned.startsWith("/")) {
		const base = currentUrlPath.includes("/")
			? currentUrlPath.slice(0, currentUrlPath.lastIndexOf("/"))
			: "";
		cleaned = base ? `${base}/${cleaned}` : cleaned;
	}

	const segments = cleaned.split("/");
	const resolved: string[] = [];
	for (const segment of segments) {
		if (!segment || segment === ".") continue;
		if (segment === "..") resolved.pop();
		else resolved.push(segment);
	}
	return resolved.join("/");
}

function splitUrlSuffix(url: string): { path: string; suffix: string } {
	const idx = url.search(/[?#]/);
	if (idx < 0) return { path: url, suffix: "" };
	return { path: url.slice(0, idx), suffix: url.slice(idx) };
}

function isExternalOrAnchorRef(ref: string): boolean {
	return /^(https?:|mailto:|tel:|data:|javascript:|#|\/\/)/i.test(ref);
}

// Rewrite relative href/src URLs so slide assets resolve from their source folder.
export function rewriteRelativeAssetUrls(
	html: string,
	currentUrlPath?: string,
	pathPrefix = "/",
): string {
	const assetHrefPattern =
		/\.(pdf|png|jpe?g|gif|webp|svg|ico|bmp|avif|json|ya?ml|csv|txt|zip|mp4|webm|mov|mp3|wav|ogg)$/i;

	return html.replace(/\b(href|src)="([^"]+)"/g, (_m, attr, value: string) => {
		if (isExternalOrAnchorRef(value) || value.startsWith("/")) {
			return `${attr}="${value}"`;
		}
		if (attr === "href") {
			const isExplicitRelative = value.startsWith("./") || value.startsWith("../");
			const { path } = splitUrlSuffix(value);
			if (!isExplicitRelative || !assetHrefPattern.test(path)) {
				return `${attr}="${value}"`;
			}
		}

		const { path, suffix } = splitUrlSuffix(value);
		const resolved = resolveRelativeContentPath(path, currentUrlPath);
		const prefix = pathPrefix.endsWith("/") ? pathPrefix : `${pathPrefix}/`;
		const rewritten = `${prefix}${resolved}${suffix}`;
		return `${attr}="${rewritten}"`;
	});
}

// ---------------------------------------------------------------------------
// Navigation/template building
// ---------------------------------------------------------------------------

/** Hard ceiling — guards against symlink loops or pathological trees */
const MAX_DISCOVERY_DEPTH = 10;

/** Default depth for auto-discovered sections (keeps nav manageable) */
const DEFAULT_DISCOVERY_DEPTH = 4;

/**
 * Recursively collect content files from a directory.
 */
async function walkContentDir(
	dir: string,
	urlBase: string,
	section: string,
	sectionBase: string,
	relBase: string,
	depth: number,
	maxDepth: number,
	exclude: string[],
	files: ContentFile[],
): Promise<void> {
	if (depth > maxDepth) return;

	let entries: import("node:fs").Dirent[];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}

	// Sort for consistent cross-platform ordering
	entries.sort((a, b) => a.name.localeCompare(b.name));

	for (const entry of entries) {
		if (entry.name.startsWith(".")) continue;
		const relPath = relBase ? `${relBase}/${entry.name}` : entry.name;
		if (matchesExclude(relPath, exclude)) continue;

		if (entry.isDirectory()) {
			await walkContentDir(
				join(dir, entry.name),
				`${urlBase}/${entry.name}`,
				section,
				sectionBase,
				relPath,
				depth + 1,
				maxDepth,
				exclude,
				files,
			);
		} else if (entry.isFile()) {
			const name = entry.name;
			if (!name.endsWith(".md") && !name.endsWith(".yaml") && !name.endsWith(".json")) continue;

			const stem = name.replace(/\.(md|yaml|json)$/, "");
			let urlPath: string;
			if (stem.toLowerCase() === "index" || stem.toLowerCase() === "readme") {
				// Use directory path as URL — parent dir name becomes display name
				urlPath = urlBase;
			} else {
				urlPath = `${urlBase}/${stem}`;
			}

			files.push({
				path: join(dir, name),
				urlPath,
				section,
				sectionBase,
			});
		}
	}
}

function matchesExclude(name: string, patterns: string[]): boolean {
	if (patterns.length === 0) return false;
	return patterns.some((pattern) => globMatch(pattern, name));
}

function globMatch(pattern: string, str: string): boolean {
	const escapeRegex = (s: string) => s.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
	let regexPattern = "";
	for (const ch of pattern) {
		if (ch === "*") regexPattern += "[^/]*";
		else if (ch === "?") regexPattern += "[^/]";
		else regexPattern += escapeRegex(ch);
	}
	const regex = `^${regexPattern}$`;
	return new RegExp(regex).test(str);
}

/**
 * Collect all content files based on config
 */
export async function collectFiles(root: string, config: SiteConfig): Promise<ContentFile[]> {
	const files: ContentFile[] = [];

	for (const section of config.sections) {
		const sectionPath = validatePath(root, config.docroot, section.path);
		if (!sectionPath) continue;

		// Compute URL base from resolved path (handles ../docs/decisions -> docs/decisions)
		const urlBase = toUrlPath(root, sectionPath);

		if (section.files) {
			// Explicit file list (for root-level sections like Overview)
			for (const file of section.files) {
				const filePath = join(sectionPath, file);
				try {
					await stat(filePath);
					const name = file.replace(/\.(md|yaml|json)$/, "");
					files.push({
						path: filePath,
						urlPath: name.toLowerCase(),
						section: section.name,
						sectionBase: urlBase,
					});
				} catch {
					// Skip if doesn't exist
				}
			}
		} else {
			// Auto-discover from directory (recursive)
			const maxDepth = Math.min(
				typeof section.maxDepth === "number" ? section.maxDepth : DEFAULT_DISCOVERY_DEPTH,
				MAX_DISCOVERY_DEPTH,
			);
			await walkContentDir(
				sectionPath,
				urlBase,
				section.name,
				urlBase,
				"",
				0,
				maxDepth,
				section.exclude ?? [],
				files,
			);
		}
	}

	return files;
}

// ---------------------------------------------------------------------------
// Hierarchical navigation tree
// ---------------------------------------------------------------------------

interface NavNode {
	name: string;
	urlPath: string | null; // null for dirs without index.md
	children: NavNode[];
}

/**
 * Derive section URL base from a group of files (fallback when sectionBase not set)
 */
function findSectionBase(urlPaths: string[]): string {
	if (urlPaths.length === 0) return "";
	if (urlPaths.length === 1) {
		const parts = urlPaths[0].split("/");
		return parts.length > 1 ? parts.slice(0, -1).join("/") : "";
	}
	const split = urlPaths.map((p) => p.split("/"));
	let commonLen = 0;
	for (let i = 0; i < Math.min(...split.map((s) => s.length)); i++) {
		if (split.every((s) => s[i] === split[0][i])) commonLen = i + 1;
		else break;
	}
	return split[0].slice(0, commonLen).join("/");
}

/**
 * Build a NavNode tree from a flat file list for one section.
 * Returns the tree and the section root index urlPath (if any).
 */
function buildNavTree(
	files: ContentFile[],
	sectionBase: string,
): { tree: NavNode[]; indexUrlPath: string | null } {
	const root: NavNode = { name: "", urlPath: null, children: [] };
	let indexUrlPath: string | null = null;

	for (const file of files) {
		const rel =
			file.urlPath.length > sectionBase.length ? file.urlPath.slice(sectionBase.length + 1) : "";

		if (rel === "") {
			// Section root index — becomes section header link
			indexUrlPath = file.urlPath;
			continue;
		}

		const segments = rel.split("/");
		let node = root;

		for (let i = 0; i < segments.length; i++) {
			const seg = segments[i];
			const isLeaf = i === segments.length - 1;

			if (isLeaf) {
				const existing = node.children.find((c) => c.name === seg);
				if (existing && existing.children.length > 0 && !existing.urlPath) {
					// Directory node exists without a link — this is its index file
					existing.urlPath = file.urlPath;
				} else {
					node.children.push({ name: seg, urlPath: file.urlPath, children: [] });
				}
			} else {
				let child = node.children.find((c) => c.name === seg);
				if (!child) {
					child = { name: seg, urlPath: null, children: [] };
					node.children.push(child);
				}
				node = child;
			}
		}
	}

	return { tree: root.children, indexUrlPath };
}

function nodeContainsPath(node: NavNode, urlPath: string): boolean {
	if (node.urlPath === urlPath) return true;
	return node.children.some((c) => nodeContainsPath(c, urlPath));
}

/**
 * Render a NavNode tree to HTML with collapsible groups.
 */
function renderNavTree(
	nodes: NavNode[],
	currentUrlPath: string | null,
	makeHref: (urlPath: string) => string,
): string {
	if (nodes.length === 0) return "";

	let html = "<ul>";
	for (const node of nodes) {
		if (node.children.length > 0) {
			// Directory with children — collapsible group
			const isOpen = currentUrlPath ? nodeContainsPath(node, currentUrlPath) : false;
			const open = isOpen ? " open" : "";
			html += `<li><details${open}><summary class="nav-group">`;
			if (node.urlPath) {
				const active = currentUrlPath === node.urlPath ? ' class="active"' : "";
				html += `<a href="${makeHref(node.urlPath)}"${active}>${node.name}</a>`;
			} else {
				html += node.name;
			}
			html += `</summary>`;
			html += renderNavTree(node.children, currentUrlPath, makeHref);
			html += `</details></li>`;
		} else {
			// Leaf file
			const active = currentUrlPath === node.urlPath ? ' class="active"' : "";
			html += `<li><a href="${makeHref(node.urlPath ?? "")}"${active}>${node.name}</a></li>`;
		}
	}
	html += "</ul>";
	return html;
}

/**
 * Build section nav HTML using tree renderer.
 * Shared logic for buildNavSimple and buildNavStatic.
 */
export function buildSectionNav(
	sectionFiles: Map<string, ContentFile[]>,
	config: SiteConfig,
	currentUrlPath: string | null,
	makeHref: (urlPath: string) => string,
): string {
	let html = "";

	// Render sections in config order
	for (const section of config.sections) {
		const items = sectionFiles.get(section.name);
		if (!items || items.length === 0) continue;

		const sBase = items[0]?.sectionBase ?? findSectionBase(items.map((f) => f.urlPath));
		const { tree, indexUrlPath } = buildNavTree(items, sBase);

		// Section header — clickable if section has root index
		if (indexUrlPath) {
			const active = currentUrlPath === indexUrlPath ? ' class="active"' : "";
			html += `<li><a href="${makeHref(indexUrlPath)}"${active} class="nav-section">${section.name}</a>`;
		} else {
			html += `<li><span class="nav-section">${section.name}</span>`;
		}

		html += renderNavTree(tree, currentUrlPath, makeHref);
		html += `</li>`;
	}

	return html;
}

/**
 * Build navigation HTML for dev server (simple, no path prefix)
 */
export function buildNavSimple(
	files: ContentFile[],
	config: SiteConfig,
	currentUrlPath?: string,
): string {
	// Group files by section
	const sectionFiles = new Map<string, ContentFile[]>();
	for (const file of files) {
		if (!sectionFiles.has(file.section)) {
			sectionFiles.set(file.section, []);
		}
		sectionFiles.get(file.section)?.push(file);
	}

	const makeHref = (urlPath: string) => `/${urlPath}`;
	let html = "<ul>";

	if (config.home) {
		html += `<li><a href="/" class="nav-home">Home</a></li>`;
	}

	html += buildSectionNav(sectionFiles, config, currentUrlPath ?? null, makeHref);
	html += "</ul>";

	return html;
}

/**
 * Build navigation HTML for static build (with path prefix and active state)
 */
export function buildNavStatic(
	files: ContentFile[],
	currentKey: string,
	config: SiteConfig,
	pathPrefix: string,
): string {
	// Group files by section
	const sectionFiles = new Map<string, ContentFile[]>();
	for (const file of files) {
		if (!sectionFiles.has(file.section)) {
			sectionFiles.set(file.section, []);
		}
		sectionFiles.get(file.section)?.push(file);
	}

	const makeHref = (urlPath: string) => `${pathPrefix}${urlPath}.html`;
	let html = "<ul>";

	if (config.home) {
		const homeActive = currentKey === "" ? ' class="active"' : "";
		html += `<li><a href="${pathPrefix}index.html"${homeActive} class="nav-home">Home</a></li>`;
	}

	html += buildSectionNav(sectionFiles, config, currentKey || null, makeHref);
	html += "</ul>";

	return html;
}

/**
 * Extract TOC from rendered HTML
 */
export function buildToc(html: string): string {
	const headings: { level: number; id: string; text: string }[] = [];
	const regex = /<h([23])\s+id="([^"]+)"[^>]*>([^<]+)<\/h[23]>/gi;
	let match: RegExpExecArray | null = null;
	while (true) {
		match = regex.exec(html);
		if (match === null) break;
		headings.push({
			level: parseInt(match[1], 10),
			id: match[2],
			text: match[3].trim(),
		});
	}

	if (headings.length < 2) return "";

	let tocHtml = '<aside class="toc"><span class="toc-title">On this page</span><ul>';
	for (const h of headings) {
		const levelClass = h.level === 3 ? ' class="toc-h3"' : "";
		tocHtml += `<li${levelClass}><a href="#${h.id}">${h.text}</a></li>`;
	}
	tocHtml += "</ul></aside>";
	return tocHtml;
}

/**
 * Find the first file in a section that matches the given path prefix
 */
function findFirstFileInSection(files: ContentFile[], pathPrefix: string): ContentFile | undefined {
	return files.find((file) => file.urlPath.startsWith(`${pathPrefix}/`));
}

/**
 * Build breadcrumbs for dev server (simple, no path prefix)
 * Links to first file in each section instead of non-existent index pages
 */
export function buildBreadcrumbsSimple(
	urlPath: string,
	files: ContentFile[],
	_config: SiteConfig,
): string {
	const parts = urlPath.split("/").filter(Boolean);
	if (parts.length <= 1) return "";

	let html = '<nav class="breadcrumbs">';
	let path = "";
	for (let i = 0; i < parts.length - 1; i++) {
		path += (path ? "/" : "") + parts[i];
		const name = parts[i].charAt(0).toUpperCase() + parts[i].slice(1);

		// Find first file in this section to link to
		const firstFile = findFirstFileInSection(files, path);
		const href = firstFile ? `/${firstFile.urlPath}` : `/${path}/`;

		html += `<a href="${href}">${name}</a><span class="separator">›</span>`;
	}
	html += `<span>${parts[parts.length - 1]}</span>`;
	html += "</nav>";
	return html;
}

/**
 * Build breadcrumbs for static build (with path prefix)
 * Links to first file in each section instead of non-existent index pages
 */
export function buildBreadcrumbsStatic(
	urlKey: string,
	pathPrefix: string,
	files: ContentFile[],
	_config: SiteConfig,
): string {
	const parts = urlKey.split("/").filter(Boolean);
	if (parts.length <= 1) return "";

	let html = '<nav class="breadcrumbs">';
	let path = "";
	for (let i = 0; i < parts.length - 1; i++) {
		path += (path ? "/" : "") + parts[i];
		const name = parts[i].charAt(0).toUpperCase() + parts[i].slice(1);

		// Find first file in this section to link to
		const firstFile = findFirstFileInSection(files, path);
		const href = firstFile
			? `${pathPrefix}${firstFile.urlPath}.html`
			: `${pathPrefix}${path}/index.html`;

		html += `<a href="${href}">${name}</a><span class="separator">›</span>`;
	}
	html += `<span>${parts[parts.length - 1]}</span>`;
	html += "</nav>";
	return html;
}

/**
 * Build page meta (last updated date)
 */
export function buildPageMeta(frontmatter: Record<string, unknown>): string {
	const lastUpdated = frontmatter.last_updated as string | undefined;
	if (!lastUpdated) return "";
	const formatted = formatDate(lastUpdated);
	return `<div class="page-meta">Last updated: ${formatted}</div>`;
}

interface LogoImgHtmlOptions {
	logo: string;
	logoDark?: string;
	alt: string;
	className?: string;
	pathPrefix?: string;
	onerrorFallback?: boolean;
	style?: string;
}

export function buildLogoImgHtml(options: LogoImgHtmlOptions): string {
	const className = options.className || "logo-img";
	const pathPrefix = options.pathPrefix || "";
	const onerror = options.onerrorFallback
		? `onerror="this.onerror=null;this.style.display='none';this.parentElement.classList.add('logo-fallback')"`
		: `onerror="this.onerror=null;this.style.display='none'"`;
	const style = options.style ? `style="${escapeHtml(options.style)}"` : "";
	const lightSrc = `${pathPrefix}${options.logo}`;
	const alt = escapeHtml(options.alt);

	if (!options.logoDark) {
		return `<img src="${escapeHtml(lightSrc)}" alt="${alt}" class="${className}" ${style} ${onerror}>`;
	}

	const darkSrc = `${pathPrefix}${options.logoDark}`;
	return `<img src="${escapeHtml(lightSrc)}" alt="${alt}" class="${className} logo-light" ${style} ${onerror}>
<img src="${escapeHtml(darkSrc)}" alt="${alt}" class="${className} logo-dark" ${style} onerror="this.onerror=null;this.style.display='none'">`;
}

/**
 * Build footer HTML from provenance
 */
function renderFooterLogo(
	footer: SiteFooter,
	config: SiteConfig,
	pathPrefix: string,
	logoOverride?: string,
	logoDarkOverride?: string,
): string {
	const footerLogo = logoOverride || footer.logo;
	if (!footerLogo) return "";

	const altText = footer.logoAlt || footer.copyright || config.brand.name;
	const logoHeight = footer.logoHeight ?? 20;
	const logoDark = logoDarkOverride || footer.logoDark;
	const image = buildLogoImgHtml({
		logo: footerLogo,
		logoDark,
		alt: altText,
		className: "footer-logo-img",
		pathPrefix: logoOverride ? "" : pathPrefix,
		onerrorFallback: false,
		style: `max-height: ${logoHeight}px`,
	});
	const wrapped = footer.logoUrl
		? `<a href="${escapeHtml(footer.logoUrl)}" class="footer-logo-link">${image}</a>`
		: `<span class="footer-logo-link">${image}</span>`;

	return `${wrapped}<span class="footer-separator">·</span>`;
}

export function buildFooter(provenance: Provenance, config: SiteConfig, pathPrefix = ""): string {
	const commitDate = formatDate(provenance.gitCommitDate);
	const publishYear = Number.isNaN(new Date(provenance.gitCommitDate).getTime())
		? new Date().getFullYear().toString()
		: new Date(provenance.gitCommitDate).getUTCFullYear().toString();
	const footer = config.footer || {};
	const copyrightText = footer.copyright
		? escapeHtml(footer.copyright)
		: `© ${publishYear} ${escapeHtml(config.brand.name)}`;
	const copyrightHtml = footer.copyrightUrl
		? `<a href="${escapeHtml(footer.copyrightUrl)}" class="footer-link">${copyrightText}</a>`
		: copyrightText;
	const hasCustomLinks = Array.isArray(footer.links);
	const brandLinkText = /^https?:\/\//.test(config.brand.url)
		? config.brand.url.replace(/^https?:\/\//, "")
		: config.brand.name;
	const linksHtml = hasCustomLinks
		? (footer.links ?? [])
				.map(
					(link) =>
						`<a href="${escapeHtml(link.url)}" class="footer-link">${escapeHtml(link.text)}</a>`,
				)
				.join('<span class="footer-separator">·</span>')
		: `<a href="${escapeHtml(config.brand.url)}" class="footer-link"${config.brand.external ? ' target="_blank" rel="noopener"' : ""}>${escapeHtml(brandLinkText)}</a>`;
	const attributionEnabled = footer.attribution !== false;
	const versionHtml = provenance.version
		? `<span class="footer-version">v${escapeHtml(provenance.version)}</span>
          <span class="footer-separator">·</span>`
		: "";
	const footerLogoHtml = renderFooterLogo(footer, config, pathPrefix);

	return `
    <footer class="site-footer">
      <div class="footer-content">
        <div class="footer-left">
          ${footerLogoHtml}
          ${versionHtml}
          <span class="footer-commit" title="Commit: ${escapeHtml(provenance.gitCommit)}">Published ${commitDate}</span>
        </div>
        <div class="footer-center">
          <span class="footer-copyright">${copyrightHtml}</span>
          ${linksHtml ? `<span class="footer-separator">·</span>${linksHtml}` : ""}
        </div>
        ${
					attributionEnabled
						? `<div class="footer-right">
          <a href="${KITFLY_BRAND.url}" class="footer-link">Built with ${KITFLY_BRAND.name}</a>
        </div>`
						: ""
				}
      </div>
    </footer>`;
}

/**
 * Build bundle footer HTML.
 */
export function buildBundleFooter(
	version: string | undefined,
	config: SiteConfig,
	logoOverride?: string,
	logoDarkOverride?: string,
): string {
	const footer = config.footer || {};
	const copyrightText = footer.copyright
		? escapeHtml(footer.copyright)
		: `© ${new Date().getFullYear()} ${escapeHtml(config.brand.name)}`;
	const copyrightHtml = footer.copyrightUrl
		? `<a href="${escapeHtml(footer.copyrightUrl)}" class="footer-link">${copyrightText}</a>`
		: copyrightText;
	const hasCustomLinks = Array.isArray(footer.links);
	const brandLinkText = /^https?:\/\//.test(config.brand.url)
		? config.brand.url.replace(/^https?:\/\//, "")
		: config.brand.name;
	const linksHtml = hasCustomLinks
		? (footer.links ?? [])
				.map(
					(link) =>
						`<a href="${escapeHtml(link.url)}" class="footer-link">${escapeHtml(link.text)}</a>`,
				)
				.join('<span class="footer-separator">·</span>')
		: `<a href="${escapeHtml(config.brand.url)}" class="footer-link"${config.brand.external ? ' target="_blank" rel="noopener"' : ""}>${escapeHtml(brandLinkText)}</a>`;
	const attributionEnabled = footer.attribution !== false;
	const versionHtml = version
		? `<span class="footer-version">v${escapeHtml(version)}</span>
        <span class="footer-separator">·</span>`
		: "";
	const footerLogoHtml = renderFooterLogo(footer, config, "", logoOverride, logoDarkOverride);

	return `
  <footer class="site-footer">
    <div class="footer-content">
      <div class="footer-left">
        ${footerLogoHtml}
        ${versionHtml}
        <span class="footer-commit">Published (offline bundle)</span>
      </div>
      <div class="footer-center">
        <span class="footer-copyright">${copyrightHtml}</span>
        ${linksHtml ? `<span class="footer-separator">·</span>${linksHtml}` : ""}
      </div>
      ${
				attributionEnabled
					? `<div class="footer-right">
        <a href="${KITFLY_BRAND.url}" class="footer-link">Built with ${KITFLY_BRAND.name}</a>
      </div>`
					: ""
			}
    </div>
  </footer>`;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");
}

/**
 * Format date for display (YYYY-MM-DD for consistency)
 */
export function formatDate(isoDate: string): string {
	if (isoDate === "unknown" || isoDate === "dev") return isoDate;
	try {
		const date = new Date(isoDate);
		return date.toISOString().split("T")[0];
	} catch {
		return isoDate;
	}
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

/**
 * Get git information
 * @param root - The root directory for git commands
 * @param devMode - If true, use "dev"/"local" defaults; if false, use "unknown" defaults
 */
export async function getGitInfo(
	root: string,
	devMode = false,
): Promise<{
	commit: string;
	commitDate: string;
	branch: string;
}> {
	const defaultInfo = devMode
		? {
				commit: "dev",
				commitDate: new Date().toISOString(),
				branch: "local",
			}
		: {
				commit: "unknown",
				commitDate: "unknown",
				branch: "unknown",
			};

	try {
		async function runGit(args: string[]): Promise<string> {
			const proc = Bun.spawn(["git", ...args], {
				cwd: root,
				stdout: "pipe",
				stderr: "ignore",
			});
			const out = (await new Response(proc.stdout).text()).trim();
			const code = await proc.exited;
			return code === 0 ? out : "";
		}

		const commit = await runGit(["rev-parse", "--short", "HEAD"]);
		const commitDate = await runGit(["log", "-1", "--format=%cI"]);
		const branch = await runGit(["rev-parse", "--abbrev-ref", "HEAD"]);

		return {
			commit: commit || defaultInfo.commit,
			commitDate: commitDate || defaultInfo.commitDate,
			branch: branch || defaultInfo.branch,
		};
	} catch {
		return defaultInfo;
	}
}

export async function resolveSiteVersion(
	root: string,
	configuredVersion?: string,
): Promise<string | undefined> {
	if (typeof configuredVersion === "string" && configuredVersion.trim() !== "") {
		const value = configuredVersion.trim();
		const lower = value.toLowerCase();

		if (lower === "auto") {
			const autoVersion = await readVersionLine(join(root, "VERSION"));
			if (autoVersion) return autoVersion;
		} else if (lower.startsWith("file:")) {
			const rawPath = value.slice(5).trim();
			if (!rawPath) {
				console.warn("version file: path is empty");
			} else if (isAbsoluteVersionPath(rawPath)) {
				console.warn(`version file: absolute paths are not allowed: ${rawPath}`);
			} else {
				const normalizedRoot = resolve(root);
				const resolvedPath = resolve(root, rawPath);
				const rel = relative(normalizedRoot, resolvedPath);
				if (rel.startsWith("..") || rel === ".." || rel.includes(`${sep}..${sep}`)) {
					console.warn(`version file: path escapes site root: ${rawPath}`);
				} else {
					const fileVersion = await readVersionLine(resolvedPath);
					if (fileVersion) return fileVersion;
				}
			}
		} else {
			return value;
		}
	}

	try {
		const proc = Bun.spawn(["git", "describe", "--tags", "--exact-match", "HEAD"], {
			cwd: root,
			stdout: "pipe",
			stderr: "ignore",
		});
		const out = (await new Response(proc.stdout).text()).trim();
		const code = await proc.exited;
		if (code === 0 && out) {
			return out.replace(/^v/, "");
		}
	} catch {
		// No git tag fallback available
	}

	return undefined;
}

function isAbsoluteVersionPath(pathValue: string): boolean {
	return isAbsolute(pathValue) || /^[A-Za-z]:/.test(pathValue) || pathValue.startsWith("\\\\");
}

async function readVersionLine(path: string): Promise<string | undefined> {
	try {
		const content = await readFile(path, "utf-8");
		for (const line of content.split(/\r?\n/)) {
			const trimmed = line.trim();
			if (trimmed) return trimmed;
		}
	} catch {
		// Fall through to git tag resolution
	}
	return undefined;
}

/**
 * Generate provenance information
 * @param root - The root directory
 * @param devMode - If true, use dev-friendly defaults
 */
export async function generateProvenance(
	root: string,
	devMode = false,
	siteVersion?: string,
): Promise<Provenance> {
	const version = await resolveSiteVersion(root, siteVersion);
	const gitInfo = await getGitInfo(root, devMode);

	return {
		version,
		buildDate: new Date().toISOString(),
		gitCommit: gitInfo.commit,
		gitCommitDate: gitInfo.commitDate,
		gitBranch: gitInfo.branch,
	};
}

// ---------------------------------------------------------------------------
// Site configuration
// ---------------------------------------------------------------------------

function normalizeFooter(footer: unknown): SiteFooter | undefined {
	if (!footer || typeof footer !== "object") return undefined;
	const raw = footer as Record<string, unknown>;
	let links: FooterLink[] | undefined;
	let logoHeight: number | undefined;

	if (Array.isArray(raw.links)) {
		links = raw.links
			.filter(
				(link): link is FooterLink =>
					typeof link === "object" &&
					link !== null &&
					typeof (link as Record<string, unknown>).text === "string" &&
					typeof (link as Record<string, unknown>).url === "string",
			)
			.slice(0, 10);

		if (raw.links.length > 10) {
			console.warn("⚠ site.yaml footer.links supports at most 10 links; truncating extras.");
		}
	}
	const parsedLogoHeight =
		typeof raw.logoHeight === "number"
			? raw.logoHeight
			: typeof raw.logoHeight === "string"
				? Number.parseInt(raw.logoHeight, 10)
				: NaN;
	if (Number.isInteger(parsedLogoHeight)) {
		logoHeight = Math.max(10, Math.min(40, parsedLogoHeight));
	}

	return {
		copyright: typeof raw.copyright === "string" ? raw.copyright : undefined,
		copyrightUrl: typeof raw.copyrightUrl === "string" ? raw.copyrightUrl : undefined,
		links,
		attribution: typeof raw.attribution === "boolean" ? raw.attribution : undefined,
		logo: typeof raw.logo === "string" ? raw.logo : undefined,
		logoDark: typeof raw.logoDark === "string" ? raw.logoDark : undefined,
		logoUrl: typeof raw.logoUrl === "string" ? raw.logoUrl : undefined,
		logoAlt: typeof raw.logoAlt === "string" ? raw.logoAlt : undefined,
		logoHeight,
	};
}

function normalizeProfiles(raw: unknown): Record<string, ProfileConfig> | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const entries = Object.entries(raw as Record<string, unknown>);
	if (entries.length === 0) return undefined;

	const profiles: Record<string, ProfileConfig> = {};
	for (const [name, value] of entries) {
		if (!value || typeof value !== "object") continue;
		const profileRaw = value as Record<string, unknown>;
		const tags = normalizeProfileTags(
			(profileRaw.include as Record<string, unknown> | undefined)?.tags,
		);
		profiles[name.trim().toLowerCase()] = {
			description: typeof profileRaw.description === "string" ? profileRaw.description : undefined,
			include: tags.length > 0 ? { tags } : undefined,
		};
	}

	return Object.keys(profiles).length > 0 ? profiles : undefined;
}

function normalizePrebuild(raw: unknown): PrebuildHook[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const hooks = raw
		.map((entry) => {
			if (!entry || typeof entry !== "object") return null;
			const record = entry as Record<string, unknown>;
			if (typeof record.command !== "string" || !record.command.trim()) return null;
			const watch = Array.isArray(record.watch)
				? record.watch.filter((item): item is string => typeof item === "string" && !!item.trim())
				: undefined;
			return { command: record.command.trim(), watch } as PrebuildHook;
		})
		.filter((hook): hook is PrebuildHook => !!hook);
	return hooks.length > 0 ? hooks : undefined;
}

/**
 * Load site configuration with fallback chain
 * @param root - The root directory
 * @param defaultTitle - Default title if no config found (default: "Getting Started")
 */
export async function loadSiteConfig(
	root: string,
	defaultTitle = "Getting Started",
): Promise<SiteConfig> {
	// Try site.yaml first
	try {
		const configPath = join(root, "site.yaml");
		const content = await readFile(configPath, "utf-8");
		const parsed = parseYaml(content) as unknown as SiteConfig;
		const parsedRecord = parsed as unknown as Record<string, unknown>;

		// Validate required fields
		if (!parsed.title || !parsed.brand || !parsed.sections) {
			throw new Error("site.yaml missing required fields: title, brand, sections");
		}

		return {
			docroot: parsed.docroot || ".",
			dataroot: typeof parsedRecord.dataroot === "string" ? parsedRecord.dataroot : "data",
			title: parsed.title,
			version: typeof parsedRecord.version === "string" ? parsedRecord.version : undefined,
			mode: parsedRecord.mode === "slides" ? "slides" : "docs",
			aspect:
				parsedRecord.aspect === "4/3" ||
				parsedRecord.aspect === "3/2" ||
				parsedRecord.aspect === "16/10" ||
				parsedRecord.aspect === "16/9"
					? parsedRecord.aspect
					: "16/9",
			home: parsed.home as string | undefined,
			brand: {
				...parsed.brand,
				logo: parsed.brand.logo || "assets/brand/logo.png",
				logoDark: typeof parsed.brand.logoDark === "string" ? parsed.brand.logoDark : undefined,
				favicon: parsed.brand.favicon || "assets/brand/favicon.png",
				logoType: parsed.brand.logoType || "icon",
			},
			sections: parsed.sections,
			footer: normalizeFooter(parsedRecord.footer),
			server: parsed.server,
			profiles: normalizeProfiles(parsedRecord.profiles),
			prebuild: normalizePrebuild(parsedRecord.prebuild),
		};
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
			throw e;
		}
	}

	// Fallback: check for content/ directory
	try {
		const contentDir = join(root, "content");
		await stat(contentDir);

		// Auto-discover sections from subdirectories
		const entries = await readdir(contentDir, { withFileTypes: true });
		const sections: SiteSection[] = [];

		for (const entry of entries) {
			if (entry.isDirectory()) {
				sections.push({
					name: entry.name.charAt(0).toUpperCase() + entry.name.slice(1),
					path: entry.name,
				});
			}
		}

		if (sections.length > 0) {
			return {
				docroot: "content",
				dataroot: "data",
				title: "Documentation",
				mode: "docs",
				aspect: "16/9",
				brand: { name: "Docs", url: "/" },
				sections,
			};
		}
	} catch {
		// content/ doesn't exist
	}

	// Final fallback
	return {
		docroot: ".",
		dataroot: "data",
		title: defaultTitle,
		mode: "docs",
		aspect: "16/9",
		brand: { name: "Handbook", url: "/" },
		sections: [],
	};
}
