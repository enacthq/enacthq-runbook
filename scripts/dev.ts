/**
 * Kitfly - Development server with hot reload
 *
 * Usage: bun run dev [folder] [options]
 *
 * Options:
 *   -p, --port <number>   Port to serve on [env: KITFLY_DEV_PORT] [default: 3333]
 *   -H, --host <string>   Host to bind to [env: KITFLY_DEV_HOST] [default: localhost]
 *   --profile <name>      Active content profile [env: KITFLY_PROFILE]
 *   -o, --open            Open browser on start [env: KITFLY_DEV_OPEN] [default: true]
 *   --no-open             Don't open browser
 *   --help                Show help message
 *
 * Opens browser and watches for file changes, automatically reloading.
 */

import { watch } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { marked, Renderer } from "marked";
import { ENGINE_ASSETS_DIR, ENGINE_SITE_DIR } from "../src/engine.ts";
import {
	loadPluginInjections,
	PluginConfigError,
	PluginIntegrityError,
	PluginNetworkError,
	PluginPolicyError,
} from "../src/plugin-loader.ts";
import {
	buildBreadcrumbsSimple,
	buildFooter,
	buildLogoImgHtml,
	buildNavSimple,
	buildPageMeta,
	buildSlideNavHierarchical,
	buildToc,
	// Types
	type ContentFile,
	// Network utilities
	checkPortOrExit,
	// Navigation/template building
	collectFiles,
	collectSlides,
	envBool,
	envInt,
	// Config helpers
	envString,
	// Formatting
	escapeHtml,
	filterByProfile,
	filterUnknownSlidesVisualsTypeDiagnostics,
	// Provenance
	generateProvenance,
	loadDataBindings,
	// YAML/Config parsing
	loadSiteConfig,
	mergeFrontmatterWithBody,
	type Provenance,
	pagePathForData,
	// Markdown utilities
	parseFrontmatter,
	parseYaml,
	resolveBindings,
	resolveStylesPath,
	resolveTemplatePath,
	rewriteRelativeAssetUrls,
	runPrebuildHooks,
	type SiteConfig,
	slugify,
	validatePath,
	validateSlidesVisualsFences,
} from "../src/shared.ts";
import { generateThemeCSS, getPrismUrls, loadTheme, type Theme } from "../src/theme.ts";

// Defaults
const DEFAULT_PORT = 3333;
const DEFAULT_HOST = "localhost";

let PORT = DEFAULT_PORT;
let HOST = DEFAULT_HOST;
let ROOT = process.cwd();
let OPEN_BROWSER = true;
let LOG_FORMAT = ""; // "structured" when invoked by CLI daemon
let ACTIVE_PROFILE: string | undefined;

// Structured logger for daemon mode — set during main() init.
// When null, all output goes through console.log (standalone mode).
let daemonLog: {
	info: (msg: string) => void;
	warn: (msg: string) => void;
	error: (msg: string) => void;
} | null = null;

async function applyDataBindingsToMarkdown(
	rawMarkdown: string,
	filePath: string,
	config: SiteConfig,
): Promise<{ frontmatter: Record<string, unknown>; body: string }> {
	const parsed = parseFrontmatter(rawMarkdown);
	const dataRef = typeof parsed.frontmatter.data === "string" ? parsed.frontmatter.data.trim() : "";
	if (!dataRef) return parsed;

	const pagePath = pagePathForData(ROOT, config.docroot, filePath);
	const bindings = await loadDataBindings(dataRef, pagePath, ROOT, config.docroot, config.dataroot);
	return {
		frontmatter: parsed.frontmatter,
		body: resolveBindings(parsed.body, bindings, pagePath),
	};
}

async function applyDataBindingsForSlides(
	rawMarkdown: string,
	filePath: string,
	config: SiteConfig,
): Promise<string> {
	const resolved = await applyDataBindingsToMarkdown(rawMarkdown, filePath, config);
	return mergeFrontmatterWithBody(rawMarkdown, resolved.body);
}

function isPluginLoaderError(error: unknown): error is Error {
	return (
		error instanceof PluginConfigError ||
		error instanceof PluginIntegrityError ||
		error instanceof PluginPolicyError ||
		error instanceof PluginNetworkError
	);
}

function pluginVersionMismatchHint(message: string): string {
	const m = message.match(/^Plugin ([a-z0-9-]+) version mismatch: ([^ ]+) != ([^ ]+)$/i);
	if (!m) return "";
	const pluginId = m[1];
	const expected = m[3];
	return `Update <code>kitfly.plugins.yaml</code> to <code>${pluginId}@${expected}</code>, then refresh.`;
}

export function buildDevPluginErrorHtml(message: string): string {
	const hint = pluginVersionMismatchHint(message);
	const safeMessage = escapeHtml(message);
	const hintBlock = hint
		? `<p>${hint}</p>`
		: "<p>Check <code>kitfly.plugins.yaml</code> and <code>registry/plugins.yaml</code>, then refresh.</p>";
	return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Plugin Configuration Error</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 0; background: #0b1020; color: #e8ecf3; }
    main { max-width: 820px; margin: 8vh auto; padding: 1.25rem; }
    .card { background: #131a2e; border: 1px solid #2a3557; border-radius: 12px; padding: 1rem 1.1rem; }
    h1 { margin: 0 0 0.75rem; font-size: 1.25rem; }
    p, li { line-height: 1.5; }
    code { background: #0e1528; padding: 0.08rem 0.3rem; border-radius: 6px; border: 1px solid #2a3557; }
    pre { margin: 0.8rem 0 0; padding: 0.75rem; background: #0e1528; border: 1px solid #2a3557; border-radius: 8px; overflow: auto; }
    .muted { color: #b5bfd2; font-size: 0.92rem; }
  </style>
</head>
<body>
  <main>
    <div class="card">
      <h1>Plugin setup error</h1>
      <p>Kitfly could not load one or more plugins for dev preview.</p>
      ${hintBlock}
      <pre><code>${safeMessage}</code></pre>
      <p class="muted">After updating config, refresh this page. No dev server restart required.</p>
    </div>
  </main>
</body>
</html>`;
}

/** Log info — uses structured logger in daemon mode, console.log otherwise */
function logInfo(msg: string): void {
	if (daemonLog) daemonLog.info(msg);
	else console.log(msg);
}

/** Log warning — uses structured logger in daemon mode, console.warn otherwise */
function logWarn(msg: string): void {
	if (daemonLog) daemonLog.warn(msg);
	else console.warn(msg);
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

interface ParsedArgs {
	port?: number;
	host?: string;
	open?: boolean;
	folder?: string;
	logFormat?: string;
	profile?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
	const result: ParsedArgs = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = argv[i + 1];

		if ((arg === "--port" || arg === "-p") && next) {
			result.port = parseInt(next, 10);
			i++;
		} else if ((arg === "--host" || arg === "-H") && next && !next.startsWith("-")) {
			result.host = next;
			i++;
		} else if (arg === "--log-format") {
			result.logFormat = next;
			i++;
		} else if (arg === "--profile" && next && !next.startsWith("-")) {
			result.profile = next;
			i++;
		} else if (arg === "--open" || arg === "-o") {
			result.open = true;
		} else if (arg === "--no-open") {
			result.open = false;
		} else if (!arg.startsWith("-") && !result.folder) {
			result.folder = arg;
		}
	}
	return result;
}

function getConfig(): {
	port: number;
	host: string;
	open: boolean;
	folder?: string;
	logFormat?: string;
	profile?: string;
} {
	const args = parseArgs(process.argv.slice(2));
	return {
		port: args.port ?? envInt("KITFLY_DEV_PORT", DEFAULT_PORT),
		host: args.host ?? envString("KITFLY_DEV_HOST", DEFAULT_HOST),
		open: args.open ?? envBool("KITFLY_DEV_OPEN", true),
		folder: args.folder,
		logFormat: args.logFormat,
		profile: args.profile ?? process.env.KITFLY_PROFILE,
	};
}

async function getFilteredFiles(config: SiteConfig): Promise<ContentFile[]> {
	const files = await collectFiles(ROOT, config);
	return filterByProfile(files, ACTIVE_PROFILE, config.profiles);
}

function getContentType(filePath: string): string {
	const ext = extname(filePath).toLowerCase();
	switch (ext) {
		case ".css":
			return "text/css";
		case ".js":
			return "text/javascript";
		case ".json":
			return "application/json";
		case ".svg":
			return "image/svg+xml";
		case ".png":
			return "image/png";
		case ".jpg":
		case ".jpeg":
			return "image/jpeg";
		case ".gif":
			return "image/gif";
		case ".webp":
			return "image/webp";
		case ".ico":
			return "image/x-icon";
		case ".pdf":
			return "application/pdf";
		default:
			return "application/octet-stream";
	}
}

// Configure marked with custom renderer for mermaid support and heading IDs
const renderer = new Renderer();
const originalCode = renderer.code.bind(renderer);
renderer.code = (code: { type: "code"; raw: string; text: string; lang?: string }) => {
	if (code.lang === "mermaid") {
		// Store source in data attribute for theme toggle re-rendering
		const escaped = code.text.replace(/"/g, "&quot;");
		return `<pre class="mermaid" data-mermaid-source="${escaped}">${code.text}</pre>`;
	}
	return originalCode(code);
};
renderer.heading = ({ text, depth }: { text: string; depth: number }) => {
	const plain = text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
	const id = slugify(plain);
	const inner = marked.parseInline(text) as string;
	return `<h${depth} id="${id}">${inner}</h${depth}>\n`;
};
marked.use({ renderer });

// Track connected clients for hot reload
const clients: Set<ReadableStreamDefaultController> = new Set();

let pluginCache: { key: string; head: string; bodyEnd: string } | null = null;

async function isSlidesVisualsEnabled(): Promise<boolean> {
	const configPath = join(ROOT, "kitfly.plugins.yaml");
	try {
		const raw = await readFile(configPath, "utf-8");
		const parsed = parseYaml(raw) as unknown as Record<string, unknown>;
		const plugins = Array.isArray(parsed?.plugins) ? (parsed.plugins as unknown[]) : [];
		return plugins.some((p) => typeof p === "string" && p.startsWith("slides-visuals@"));
	} catch {
		return false;
	}
}

async function getPluginInjectionsCached(
	mode: "docs" | "slides",
): Promise<{ head: string; bodyEnd: string }> {
	const configPath = join(ROOT, "kitfly.plugins.yaml");
	let configMtime = "missing";
	try {
		configMtime = String((await stat(configPath)).mtimeMs);
	} catch {
		return { head: "", bodyEnd: "" };
	}

	const siteRegistryPath = join(ROOT, "registry", "plugins.yaml");
	let registryMtime = "none";
	try {
		registryMtime = String((await stat(siteRegistryPath)).mtimeMs);
	} catch {
		// Uses engine registry by default.
	}

	let pluginAssetsMtime = "none";
	try {
		const mtimes: number[] = [];
		const dirs = [join(ROOT, "plugins-dist"), join(ENGINE_SITE_DIR, "..", "plugins-dist")];
		for (const dir of dirs) {
			try {
				const entries = await readdir(dir);
				for (const name of entries) {
					if (!/\.(js|css)$/i.test(name)) continue;
					try {
						mtimes.push((await stat(join(dir, name))).mtimeMs);
					} catch {
						// ignore
					}
				}
			} catch {
				// ignore
			}
		}
		pluginAssetsMtime = mtimes.length ? String(Math.max(...mtimes)) : "none";
	} catch {
		// ignore
	}

	const key = `${mode}:${configMtime}:${registryMtime}:${pluginAssetsMtime}`;
	if (pluginCache && pluginCache.key === key) {
		return { head: pluginCache.head, bodyEnd: pluginCache.bodyEnd };
	}
	const injected = await loadPluginInjections({ root: ROOT, mode });
	pluginCache = { key, head: injected.head, bodyEnd: injected.bodyEnd };
	return injected;
}

// Convert markdown to HTML with template
async function renderPage(
	filePath: string,
	urlPath: string,
	provenance: Provenance,
	config: SiteConfig,
	theme: Theme,
): Promise<string> {
	const uiVersion = provenance.version ? `v${provenance.version}` : "unversioned";
	const content = await readFile(filePath, "utf-8");
	const template = await readFile(await resolveTemplatePath(ROOT), "utf-8");

	let title = basename(filePath, extname(filePath));
	let htmlContent: string;
	let pageMeta = "";

	if (filePath.endsWith(".yaml")) {
		// Render YAML as code block
		htmlContent = `<h1>${title}</h1>\n<pre><code class="language-yaml">${escapeHtml(content)}</code></pre>`;
	} else if (filePath.endsWith(".json")) {
		// Render JSON as code block (pretty-printed)
		let prettyJson = content;
		try {
			prettyJson = JSON.stringify(JSON.parse(content), null, 2);
		} catch {
			// Use original if not valid JSON
		}
		htmlContent = `<h1>${title}</h1>\n<pre><code class="language-json">${escapeHtml(prettyJson)}</code></pre>`;
	} else {
		const { frontmatter, body } = await applyDataBindingsToMarkdown(content, filePath, config);
		if (frontmatter.title) {
			title = frontmatter.title as string;
		}
		pageMeta = buildPageMeta(frontmatter);
		htmlContent = marked.parse(body) as string;
	}

	const files = await getFilteredFiles(config);
	const currentUrlPath = urlPath.slice(1).replace(/\.html$/, "");
	const pathPrefix = "/";
	const nav = buildNavSimple(files, config, currentUrlPath);
	const footer = buildFooter(provenance, config, pathPrefix);
	const breadcrumbs = buildBreadcrumbsSimple(urlPath, files, config);
	const toc = buildToc(htmlContent);
	const brandTarget = config.brand.external ? ' target="_blank" rel="noopener"' : "";
	const themeCSS = generateThemeCSS(theme);
	const prismUrls = getPrismUrls(theme);
	const plugins = await getPluginInjectionsCached(config.mode === "slides" ? "slides" : "docs");

	const hotReloadScript = `
<script>
  const es = new EventSource('/__reload');
  es.onmessage = () => location.reload();
  es.onerror = () => setTimeout(() => location.reload(), 1000);
</script>`;

	const logoClass = config.brand.logoType === "wordmark" ? "logo-wordmark" : "logo-icon";
	const brandInitial = escapeHtml(config.brand.name.trim().charAt(0).toUpperCase() || "K");
	const mobileLogoHtml = buildLogoImgHtml({
		logo: config.brand.logo || "assets/brand/logo.png",
		logoDark: config.brand.logoDark,
		alt: config.brand.name,
		className: `logo-img ${logoClass}`,
		pathPrefix,
		onerrorFallback: true,
	});
	const sidebarLogoHtml = buildLogoImgHtml({
		logo: config.brand.logo || "assets/brand/logo.png",
		logoDark: config.brand.logoDark,
		alt: config.brand.name,
		className: "logo-img",
		pathPrefix,
		onerrorFallback: true,
	});

	return template
		.replace("{{BODY_CLASS}}", "mode-docs")
		.replace(/\{\{PATH_PREFIX\}\}/g, () => pathPrefix)
		.replace(/\{\{BRAND_URL\}\}/g, () => config.brand.url)
		.replace(/\{\{BRAND_TARGET\}\}/g, () => brandTarget)
		.replace(/\{\{BRAND_NAME\}\}/g, () => config.brand.name)
		.replace(/\{\{BRAND_INITIAL\}\}/g, () => brandInitial)
		.replace("{{MOBILE_BRAND_LOGO_IMG}}", () => mobileLogoHtml)
		.replace("{{SIDEBAR_BRAND_LOGO_IMG}}", () => sidebarLogoHtml)
		.replace(/\{\{BRAND_LOGO\}\}/g, () => config.brand.logo || "assets/brand/logo.png")
		.replace(/\{\{BRAND_FAVICON\}\}/g, () => config.brand.favicon || "assets/brand/favicon.png")
		.replace(/\{\{BRAND_LOGO_CLASS\}\}/g, () => logoClass)
		.replace(/\{\{SITE_TITLE\}\}/g, () => config.title)
		.replace("{{TITLE}}", () => title)
		.replace("{{VERSION}}", () => uiVersion)
		.replace("{{BRANCH}}", () => provenance.gitBranch)
		.replace("{{BREADCRUMBS}}", () => breadcrumbs)
		.replace("{{PAGE_META}}", () => pageMeta)
		.replace("{{NAV}}", () => nav)
		.replace("{{CONTENT}}", () => htmlContent)
		.replace("{{TOC}}", () => toc)
		.replace("{{FOOTER}}", () => footer)
		.replace("{{THEME_CSS}}", () => themeCSS)
		.replace("{{PLUGIN_HEAD}}", () => plugins.head)
		.replace("{{PLUGIN_BODY_END}}", () => plugins.bodyEnd)
		.replace("{{PRISM_LIGHT_URL}}", () => prismUrls.light)
		.replace("{{PRISM_DARK_URL}}", () => prismUrls.dark)
		.replace("{{HOT_RELOAD_SCRIPT}}", () => hotReloadScript);
}

async function renderSlidesPage(
	provenance: Provenance,
	config: SiteConfig,
	theme: Theme,
): Promise<string> {
	const uiVersion = provenance.version ? `v${provenance.version}` : "unversioned";
	const template = await readFile(await resolveTemplatePath(ROOT), "utf-8");
	const files = await getFilteredFiles(config);
	const slides = await collectSlides(files, {
		markdownTransform: (raw, file) => applyDataBindingsForSlides(raw, file.path, config),
	});

	if (slides.length === 0) {
		return renderGettingStarted(provenance, config, theme);
	}
	const pathPrefix = "/";
	const validateFences = await isSlidesVisualsEnabled();

	const sections = await Promise.all(
		slides.map(async (slide, i) => {
			let inner = "";
			if (slide.kind === "markdown") {
				if (validateFences) {
					const diagnostics = filterUnknownSlidesVisualsTypeDiagnostics(
						validateSlidesVisualsFences(slide.body),
					);
					if (diagnostics.length) {
						const msg = diagnostics
							.slice(0, 12)
							.map((d) => `  - ${slide.sourcePath}:${d.line} ${d.message}`)
							.join("\n");
						throw new Error(`slides-visuals fence contract violations:\n${msg}`);
					}
				}
				inner = marked.parse(slide.body) as string;
			} else if (slide.kind === "yaml") {
				inner = `<pre><code class="language-yaml">${escapeHtml(slide.body)}</code></pre>`;
			} else {
				let prettyJson = slide.body;
				try {
					prettyJson = JSON.stringify(JSON.parse(slide.body), null, 2);
				} catch {
					// Use original if not valid JSON
				}
				inner = `<pre><code class="language-json">${escapeHtml(prettyJson)}</code></pre>`;
			}
			inner = rewriteRelativeAssetUrls(inner, slide.sourceUrlPath, pathPrefix);

			const classToken = slide.className ? ` ${slide.className}` : "";
			const activeClass = i === 0 ? " active" : "";
			return `<section id="${slide.id}" class="slide${classToken}${activeClass}" data-slide-index="${i}">${inner}</section>`;
		}),
	);

	const htmlContent = `
        <div class="slides-shell" style="--slide-aspect: ${config.aspect || "16/9"}">
          <div class="slide-viewport">
            <div class="slide-frame">
              ${sections.join("\n")}
            </div>
          </div>
          <div class="slide-nav" aria-label="Slide navigation">
            <button class="slide-prev" type="button" aria-label="Previous slide">Prev</button>
            <span class="slide-counter">1 / ${slides.length}</span>
            <button class="slide-next" type="button" aria-label="Next slide">Next</button>
            <div class="slide-progress" role="presentation">
              <span class="slide-progress-bar" style="width: ${(1 / slides.length) * 100}%"></span>
            </div>
          </div>
        </div>`;

	const nav = buildSlideNavHierarchical(slides, config, "slide-1");
	const footer = buildFooter(provenance, config, pathPrefix);
	const brandTarget = config.brand.external ? ' target="_blank" rel="noopener"' : "";
	const themeCSS = generateThemeCSS(theme);
	const prismUrls = getPrismUrls(theme);
	const hotReloadScript = `
<script>
  const es = new EventSource('/__reload');
  es.onmessage = () => location.reload();
  es.onerror = () => setTimeout(() => location.reload(), 1000);
</script>`;
	const plugins = await getPluginInjectionsCached("slides");
	const logoClass = config.brand.logoType === "wordmark" ? "logo-wordmark" : "logo-icon";
	const brandInitial = escapeHtml(config.brand.name.trim().charAt(0).toUpperCase() || "K");
	const mobileLogoHtml = buildLogoImgHtml({
		logo: config.brand.logo || "assets/brand/logo.png",
		logoDark: config.brand.logoDark,
		alt: config.brand.name,
		className: `logo-img ${logoClass}`,
		pathPrefix,
		onerrorFallback: true,
	});
	const sidebarLogoHtml = buildLogoImgHtml({
		logo: config.brand.logo || "assets/brand/logo.png",
		logoDark: config.brand.logoDark,
		alt: config.brand.name,
		className: "logo-img",
		pathPrefix,
		onerrorFallback: true,
	});

	return template
		.replace("{{BODY_CLASS}}", "mode-slides")
		.replace(/\{\{PATH_PREFIX\}\}/g, () => pathPrefix)
		.replace(/\{\{BRAND_URL\}\}/g, () => config.brand.url)
		.replace(/\{\{BRAND_TARGET\}\}/g, () => brandTarget)
		.replace(/\{\{BRAND_NAME\}\}/g, () => config.brand.name)
		.replace(/\{\{BRAND_INITIAL\}\}/g, () => brandInitial)
		.replace("{{MOBILE_BRAND_LOGO_IMG}}", () => mobileLogoHtml)
		.replace("{{SIDEBAR_BRAND_LOGO_IMG}}", () => sidebarLogoHtml)
		.replace(/\{\{BRAND_LOGO\}\}/g, () => config.brand.logo || "assets/brand/logo.png")
		.replace(/\{\{BRAND_FAVICON\}\}/g, () => config.brand.favicon || "assets/brand/favicon.png")
		.replace(/\{\{BRAND_LOGO_CLASS\}\}/g, () => logoClass)
		.replace(/\{\{SITE_TITLE\}\}/g, () => config.title)
		.replace("{{TITLE}}", () => config.title)
		.replace("{{VERSION}}", () => uiVersion)
		.replace("{{BRANCH}}", () => provenance.gitBranch)
		.replace("{{BREADCRUMBS}}", "")
		.replace("{{PAGE_META}}", "")
		.replace("{{NAV}}", () => nav)
		.replace("{{CONTENT}}", () => htmlContent)
		.replace("{{TOC}}", "")
		.replace("{{FOOTER}}", () => footer)
		.replace("{{THEME_CSS}}", () => themeCSS)
		.replace("{{PLUGIN_HEAD}}", () => plugins.head)
		.replace("{{PLUGIN_BODY_END}}", () => plugins.bodyEnd)
		.replace("{{PRISM_LIGHT_URL}}", () => prismUrls.light)
		.replace("{{PRISM_DARK_URL}}", () => prismUrls.dark)
		.replace("{{HOT_RELOAD_SCRIPT}}", () => hotReloadScript);
}

// Render Getting Started page when no config
async function renderGettingStarted(
	provenance: Provenance,
	config: SiteConfig,
	theme: Theme,
): Promise<string> {
	const uiVersion = provenance.version ? `v${provenance.version}` : "unversioned";
	const template = await readFile(await resolveTemplatePath(ROOT), "utf-8");
	const htmlContent = `
    <h1>Getting Started</h1>
    <p>Welcome! To configure your kitfly site, create a <code>site.yaml</code> file in the repository root:</p>
    <pre><code class="language-yaml"># yaml-language-server: $schema=./schemas/v0/site.schema.json
schemaVersion: "0.1.0"
docroot: "."
title: "My Docs"

brand:
  name: "My Brand"
  url: "https://example.com"
  external: true

sections:
  - name: "Overview"
    path: "."
    files: ["README.md"]
  - name: "Guides"
    path: "guides"
</code></pre>
    <p>Or create a <code>content/</code> directory with subdirectories for auto-discovery.</p>
  `;

	const brandTarget = config.brand.external ? ' target="_blank" rel="noopener"' : "";
	const themeCSS = generateThemeCSS(theme);
	const prismUrls = getPrismUrls(theme);
	const pathPrefix = "/";
	const plugins = await getPluginInjectionsCached(config.mode === "slides" ? "slides" : "docs");

	const hotReloadScript = `
<script>
  const es = new EventSource('/__reload');
  es.onmessage = () => location.reload();
  es.onerror = () => setTimeout(() => location.reload(), 1000);
</script>`;

	const logoClass = config.brand.logoType === "wordmark" ? "logo-wordmark" : "logo-icon";
	const brandInitial = escapeHtml(config.brand.name.trim().charAt(0).toUpperCase() || "K");
	const mobileLogoHtml = buildLogoImgHtml({
		logo: config.brand.logo || "assets/brand/logo.png",
		logoDark: config.brand.logoDark,
		alt: config.brand.name,
		className: `logo-img ${logoClass}`,
		pathPrefix,
		onerrorFallback: true,
	});
	const sidebarLogoHtml = buildLogoImgHtml({
		logo: config.brand.logo || "assets/brand/logo.png",
		logoDark: config.brand.logoDark,
		alt: config.brand.name,
		className: "logo-img",
		pathPrefix,
		onerrorFallback: true,
	});

	return template
		.replace("{{BODY_CLASS}}", "mode-docs")
		.replace(/\{\{PATH_PREFIX\}\}/g, () => pathPrefix)
		.replace(/\{\{BRAND_URL\}\}/g, () => config.brand.url)
		.replace(/\{\{BRAND_TARGET\}\}/g, () => brandTarget)
		.replace(/\{\{BRAND_NAME\}\}/g, () => config.brand.name)
		.replace(/\{\{BRAND_INITIAL\}\}/g, () => brandInitial)
		.replace("{{MOBILE_BRAND_LOGO_IMG}}", () => mobileLogoHtml)
		.replace("{{SIDEBAR_BRAND_LOGO_IMG}}", () => sidebarLogoHtml)
		.replace(/\{\{BRAND_LOGO\}\}/g, () => config.brand.logo || "assets/brand/logo.png")
		.replace(/\{\{BRAND_FAVICON\}\}/g, () => config.brand.favicon || "assets/brand/favicon.png")
		.replace(/\{\{BRAND_LOGO_CLASS\}\}/g, () => logoClass)
		.replace(/\{\{SITE_TITLE\}\}/g, () => config.title)
		.replace("{{TITLE}}", "Getting Started")
		.replace("{{VERSION}}", () => uiVersion)
		.replace("{{BRANCH}}", () => provenance.gitBranch)
		.replace("{{BREADCRUMBS}}", "")
		.replace("{{PAGE_META}}", "")
		.replace("{{NAV}}", "<ul></ul>")
		.replace("{{CONTENT}}", () => htmlContent)
		.replace("{{TOC}}", "")
		.replace("{{FOOTER}}", () => buildFooter(provenance, config, pathPrefix))
		.replace("{{THEME_CSS}}", () => themeCSS)
		.replace("{{PLUGIN_HEAD}}", () => plugins.head)
		.replace("{{PLUGIN_BODY_END}}", () => plugins.bodyEnd)
		.replace("{{PRISM_LIGHT_URL}}", () => prismUrls.light)
		.replace("{{PRISM_DARK_URL}}", () => prismUrls.dark)
		.replace("{{HOT_RELOAD_SCRIPT}}", () => hotReloadScript);
}

async function tryServeFile(filePath: string): Promise<Response | null> {
	try {
		const file = Bun.file(filePath);
		if (!(await file.exists())) return null;
		return new Response(file, {
			headers: {
				"Content-Type": getContentType(filePath),
				"Cache-Control": "no-cache",
			},
		});
	} catch {
		return null;
	}
}

async function tryServeContentAsset(
	urlPathname: string,
	config: SiteConfig,
): Promise<Response | null> {
	// Serve common binary assets from docroot (images, PDFs, etc.)
	if (!/\.[a-z0-9]+$/i.test(urlPathname)) return null;
	if (urlPathname.endsWith(".html")) return null;
	if (urlPathname === "/styles.css" || urlPathname.startsWith("/assets/")) return null;

	const rel = decodeURIComponent(urlPathname).replace(/^\//, "");
	if (!rel) return null;
	const fsPath = validatePath(ROOT, config.docroot, rel, true);
	if (!fsPath) return null;
	return tryServeFile(fsPath);
}

// Find file for a URL path
async function findFile(
	urlPath: string,
	config: SiteConfig,
	files: ContentFile[],
): Promise<string | null> {
	// Remove leading slash and .html extension (for compatibility with built links)
	const path = urlPath.slice(1).replace(/\.html$/, "") || "";

	// If empty (home page), check for dedicated home or use first file
	if (!path) {
		if (config.home) {
			const homePath = validatePath(ROOT, config.docroot, config.home, true);
			const homeFile = homePath ? files.find((file) => file.path === homePath) : undefined;
			if (homeFile) return homeFile.path;
		}
		// Fallback to first file
		return files.length > 0 ? files[0].path : null;
	}

	const directMatch = files.find((file) => file.urlPath === path);
	if (directMatch) return directMatch.path;

	const sectionIndex = files.find(
		(file) => file.urlPath === `${path}/index` || file.urlPath === path,
	);
	if (sectionIndex) return sectionIndex.path;

	return null;
}

// Notify all clients to reload
function notifyReload() {
	for (const controller of clients) {
		try {
			controller.enqueue("data: reload\n\n");
		} catch {
			clients.delete(controller);
		}
	}
}

// Start file watcher
function startWatcher(config: SiteConfig) {
	const watchDirs = [ROOT, ENGINE_SITE_DIR];

	// Watch site overrides if present
	const overrideDir = join(ROOT, "kitfly");
	watchDirs.push(overrideDir);

	// Add section directories
	for (const section of config.sections) {
		if (section.path !== ".") {
			const sectionPath = validatePath(ROOT, config.docroot, section.path);
			if (sectionPath) {
				watchDirs.push(sectionPath);
			}
		}
	}

	for (const dir of watchDirs) {
		try {
			watch(dir, { recursive: true }, (_event, filename) => {
				if (!filename) return;
				void (async () => {
					try {
						let hooksRan = 0;
						if (config.prebuild?.length) {
							hooksRan = await runPrebuildHooks(
								config.prebuild,
								ROOT,
								"dev",
								ACTIVE_PROFILE,
								config.dataroot || "data",
								filename,
							);
						}
						const shouldReload =
							hooksRan > 0 ||
							filename.endsWith(".md") ||
							filename.endsWith(".yaml") ||
							filename.endsWith(".json") ||
							filename.endsWith(".html") ||
							filename.endsWith(".css");
						if (shouldReload) {
							logInfo(`File changed: ${filename}`);
							notifyReload();
						}
					} catch (error) {
						logWarn(error instanceof Error ? error.message : String(error));
					}
				})();
			});
		} catch {
			// Directory doesn't exist, skip
		}
	}
}

// Main server startup
async function main() {
	// Initialize structured logger early so all daemon output is captured.
	// Dynamic import so standalone sites without tsfulmen don't break.
	if (LOG_FORMAT === "structured") {
		try {
			const { createStructuredLogger } = await import("@fulmenhq/tsfulmen/logging");
			daemonLog = createStructuredLogger("kitfly");
		} catch {
			// tsfulmen not available — fall back to console
		}
	}

	// Load configuration
	const config = await loadSiteConfig(ROOT);
	logInfo(`Loaded config: "${config.title}" (${config.sections.length} sections)`);
	if (config.prebuild?.length) {
		await runPrebuildHooks(config.prebuild, ROOT, "dev", ACTIVE_PROFILE, config.dataroot || "data");
		logInfo(`Ran prebuild hooks (${config.prebuild.length})`);
	}

	// Apply server config from site.yaml if CLI didn't override
	if (config.server?.port && PORT === DEFAULT_PORT) {
		PORT = config.server.port;
	}
	if (config.server?.host && HOST === DEFAULT_HOST) {
		HOST = config.server.host;
	}

	// Load theme
	const theme = await loadTheme(ROOT);
	logInfo(`Loaded theme: "${theme.name || "default"}"`);

	// Generate provenance once at startup (dev mode)
	const provenance = await generateProvenance(ROOT, true, config.version);

	// Check port availability before starting server
	await checkPortOrExit(PORT, HOST);

	// Core request handler
	async function handleRequest(req: Request): Promise<Response> {
		const url = new URL(req.url);

		// SSE endpoint for hot reload
		if (url.pathname === "/__reload") {
			const stream = new ReadableStream({
				start(controller) {
					clients.add(controller);
				},
				cancel(controller) {
					clients.delete(controller);
				},
			});

			return new Response(stream, {
				headers: {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
					Connection: "keep-alive",
				},
			});
		}

		// Serve provenance.json
		if (url.pathname === "/provenance.json") {
			return new Response(JSON.stringify(provenance, null, 2), {
				headers: { "Content-Type": "application/json" },
			});
		}

		// Serve CSS
		if (url.pathname === "/styles.css") {
			const css = await readFile(await resolveStylesPath(ROOT), "utf-8");
			return new Response(css, {
				headers: { "Content-Type": "text/css" },
			});
		}

		// Serve built-in or site-provided assets
		if (url.pathname.startsWith("/assets/")) {
			const rel = decodeURIComponent(url.pathname).replace(/^\/assets\//, "");
			const sitePath = join(ROOT, "assets", rel);
			const siteResp = await tryServeFile(sitePath);
			if (siteResp) return siteResp;

			const enginePath = join(ENGINE_ASSETS_DIR, rel);
			return (await tryServeFile(enginePath)) || new Response("Asset not found", { status: 404 });
		}

		// Serve content-linked assets (images, PDFs, etc.)
		const assetResponse = await tryServeContentAsset(url.pathname, config);
		if (assetResponse) return assetResponse;

		// Check for content
		const files = await getFilteredFiles(config);
		if (files.length === 0) {
			// No content - render Getting Started page
			const html = await renderGettingStarted(provenance, config, theme);
			return new Response(html, {
				headers: { "Content-Type": "text/html" },
			});
		}

		// Slides mode renders as a single-page deck with hash routing
		if (config.mode === "slides") {
			const html = await renderSlidesPage(provenance, config, theme);
			return new Response(html, {
				headers: { "Content-Type": "text/html" },
			});
		}

		// Find and render markdown/yaml file
		const filePath = await findFile(url.pathname, config, files);
		if (filePath) {
			// If this is an index/readme file and the URL lacks a trailing slash,
			// redirect so relative links resolve correctly (BUG-003)
			const stem = basename(filePath, extname(filePath)).toLowerCase();
			if (
				(stem === "index" || stem === "readme") &&
				!url.pathname.endsWith("/") &&
				url.pathname !== "/"
			) {
				return new Response(null, {
					status: 301,
					headers: { Location: `${url.pathname}/` },
				});
			}
			const html = await renderPage(filePath, url.pathname, provenance, config, theme);
			return new Response(html, {
				headers: { "Content-Type": "text/html" },
			});
		}

		// Check if this is a section path - redirect to first file
		const cleanPath = url.pathname.replace(/\/$/, "").slice(1); // Remove leading/trailing slashes
		for (const file of files) {
			const parts = file.urlPath.split("/");
			if (parts.length > 1) {
				const sectionPath = parts.slice(0, -1).join("/");
				if (sectionPath === cleanPath) {
					// Redirect to first file in this section
					return new Response(null, {
						status: 302,
						headers: { Location: `/${file.urlPath}` },
					});
				}
			}
		}

		// 404
		return new Response("Not found", { status: 404 });
	}

	// Wrap with request logging + friendly plugin errors.
	const fetch = async (req: Request) => {
		const start = performance.now();
		const url = new URL(req.url);
		try {
			const response = await handleRequest(req);
			if (daemonLog && url.pathname !== "/__reload") {
				const duration = (performance.now() - start).toFixed(0);
				daemonLog.info(`${req.method} ${url.pathname} ${response.status} ${duration}ms`);
			}
			return response;
		} catch (error) {
			const duration = (performance.now() - start).toFixed(0);
			const message = error instanceof Error ? error.message : String(error);
			if (isPluginLoaderError(error)) {
				if (daemonLog && url.pathname !== "/__reload") {
					daemonLog.warn(
						`${req.method} ${url.pathname} 500 ${duration}ms plugin error: ${message}`,
					);
				} else if (!daemonLog) {
					logWarn(`Plugin error: ${message}`);
				}
				return new Response(buildDevPluginErrorHtml(message), {
					status: 500,
					headers: { "Content-Type": "text/html; charset=utf-8" },
				});
			}
			if (daemonLog && url.pathname !== "/__reload") {
				daemonLog.error(`${req.method} ${url.pathname} 500 ${duration}ms ${message}`);
			} else if (!daemonLog) {
				console.error(error);
			}
			return new Response("Internal server error", {
				status: 500,
				headers: { "Content-Type": "text/plain; charset=utf-8" },
			});
		}
	};

	// Create server
	Bun.serve({
		port: PORT,
		hostname: HOST,
		fetch,
	});

	// Start watcher
	startWatcher(config);

	const displayHost = HOST === "0.0.0.0" ? "localhost" : HOST;
	const serverUrl = `http://${displayHost}:${PORT}`;

	if (daemonLog) {
		// Daemon mode — structured log lines, no ANSI
		logInfo(`Server started on ${serverUrl}`);
		logInfo(`Content root: ${ROOT}`);
		logInfo(`Version: ${provenance.version ? `v${provenance.version}` : "unversioned"}`);
		if (HOST === "0.0.0.0") {
			logWarn("Binding to all interfaces (0.0.0.0)");
		}
	} else {
		// Foreground mode — pretty banner
		console.log(`
\x1b[32m┌─────────────────────────────────────────┐
│                                         │
│   ${config.title.padEnd(35)}│
│                                         │
│   Local:   ${serverUrl.padEnd(28)}│
│   Version: ${(provenance.version ? `v${provenance.version}` : "unversioned").padEnd(29)}│
│                                         │
│   Hot reload enabled - edit any .md     │
│   or .yaml file to see changes          │
│                                         │
└─────────────────────────────────────────┘\x1b[0m
`);

		if (HOST === "0.0.0.0") {
			console.log("\x1b[33m⚠ Binding to all interfaces (0.0.0.0)\x1b[0m\n");
		}
	}

	// Open browser (cross-platform)
	if (OPEN_BROWSER) {
		try {
			if (process.platform === "win32") {
				// cmd.exe built-in: start
				// Empty title argument avoids treating URL as window title.
				Bun.spawn(["cmd", "/c", "start", "", serverUrl]);
			} else if (process.platform === "darwin") {
				Bun.spawn(["open", serverUrl]);
			} else {
				// Most Linux distros
				Bun.spawn(["xdg-open", serverUrl]);
			}
		} catch {
			// Non-fatal: server is already running; user can open manually.
		}
	}
}

// Export for CLI usage
export interface DevOptions {
	folder?: string;
	port?: number;
	host?: string;
	open?: boolean;
	logFormat?: string;
	profile?: string;
}

export async function dev(options: DevOptions = {}) {
	if (options.folder) {
		ROOT = resolve(process.cwd(), options.folder);
	}
	if (options.port) {
		PORT = options.port;
	}
	if (options.host) {
		HOST = options.host;
	}
	if (options.open === false) {
		OPEN_BROWSER = false;
	}
	if (options.logFormat) {
		LOG_FORMAT = options.logFormat;
	}
	ACTIVE_PROFILE = options.profile;
	await main();
}

// Run directly if executed as script
if (import.meta.main) {
	// Check for help flag
	if (process.argv.includes("--help")) {
		console.log(`
Usage: bun run dev [folder] [options]

Options:
  -p, --port <number>   Port to serve on [env: KITFLY_DEV_PORT] [default: ${DEFAULT_PORT}]
  -H, --host <string>   Host to bind to [env: KITFLY_DEV_HOST] [default: ${DEFAULT_HOST}]
  --profile <name>      Active content profile [env: KITFLY_PROFILE]
  -o, --open            Open browser on start [env: KITFLY_DEV_OPEN] [default: true]
  --no-open             Don't open browser
  --help                Show this help message

Examples:
  bun run dev
  bun run dev ./docs
  bun run dev --port 8080
  bun run dev ./docs -p 8080 --no-open
  KITFLY_DEV_PORT=8080 bun run dev
`);
		process.exit(0);
	}

	const cfg = getConfig();
	dev({
		folder: cfg.folder,
		port: cfg.port,
		host: cfg.host,
		open: cfg.open,
		logFormat: cfg.logFormat,
		profile: cfg.profile,
	}).catch(console.error);
}
