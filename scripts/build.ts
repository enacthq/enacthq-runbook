/**
 * Build static site from markdown files
 *
 * Usage: bun run build [folder] [options]
 *
 * Options:
 *   -o, --out <dir>   Output directory [env: KITFLY_BUILD_OUT] [default: dist]
 *   --profile <name>  Active content profile [env: KITFLY_PROFILE]
 *   --raw             Include raw markdown files [env: KITFLY_BUILD_RAW] [default: true]
 *   --no-raw          Don't include raw markdown files
 *   --help            Show help message
 *
 * Outputs to dist/ directory by default.
 */

import { copyFile, cp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { marked, Renderer } from "marked";
import { ENGINE_ASSETS_DIR } from "../src/engine.ts";
import { loadPluginInjections, type PluginInjections } from "../src/plugin-loader.ts";
import {
	buildBreadcrumbsStatic,
	buildFooter,
	buildLogoImgHtml,
	buildNavStatic,
	buildPageMeta,
	buildSlideNavHierarchical,
	buildToc,
	type ContentFile,
	collectFiles,
	// Navigation/template building
	collectSlides,
	envBool,
	// Config helpers
	envString,
	// Formatting
	escapeHtml,
	// File utilities
	exists,
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
	// Types
	type SiteConfig,
	slugify,
	validatePath,
	validateSlidesVisualsFences,
} from "../src/shared.ts";
import { generateThemeCSS, getPrismUrls, loadTheme, type Theme } from "../src/theme.ts";

// Defaults
const DEFAULT_OUT = "dist";

let ROOT = process.cwd();
let OUT_DIR = DEFAULT_OUT;
let ACTIVE_PROFILE: string | undefined;

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

function normalizeMsysPath(p: string): string {
	// Git Bash / MSYS-style paths: /c/Users/... -> C:\Users\...
	if (process.platform !== "win32") return p;
	const m = p.match(/^\/([a-zA-Z])\/(.*)$/);
	if (!m) return p;
	return `${m[1].toUpperCase()}:\\${m[2].replaceAll("/", "\\")}`;
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

interface ParsedArgs {
	folder?: string;
	out?: string;
	raw?: boolean;
	profile?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
	const result: ParsedArgs = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = argv[i + 1];

		if ((arg === "--out" || arg === "-o") && next && !next.startsWith("-")) {
			result.out = next;
			i++;
		} else if (arg === "--profile" && next && !next.startsWith("-")) {
			result.profile = next;
			i++;
		} else if (arg === "--raw") {
			result.raw = true;
		} else if (arg === "--no-raw") {
			result.raw = false;
		} else if (!arg.startsWith("-") && !result.folder) {
			result.folder = arg;
		}
	}
	return result;
}

function getConfig(): { folder?: string; out: string; raw: boolean; profile?: string } {
	const args = parseArgs(process.argv.slice(2));
	return {
		folder: args.folder,
		out: args.out ?? envString("KITFLY_BUILD_OUT", DEFAULT_OUT),
		raw: args.raw ?? envBool("KITFLY_BUILD_RAW", true),
		profile: args.profile ?? process.env.KITFLY_PROFILE,
	};
}

async function resolveSiteAssetsDir(siteRoot: string): Promise<string | null> {
	const overrideDir = join(siteRoot, "assets");
	if (await exists(overrideDir)) return overrideDir;
	return null;
}

function computePathPrefix(urlKey: string): string {
	const clean = urlKey.replace(/^\/+/, "").replace(/\.html$/, "");
	if (!clean) return "./";
	const depth = Math.max(0, clean.split("/").length - 1);
	return depth === 0 ? "./" : "../".repeat(depth);
}

async function copyStaticAssetsFromDir(srcDir: string, destDir: string): Promise<void> {
	try {
		await mkdir(destDir, { recursive: true });
		const entries = await readdir(srcDir, { withFileTypes: true });
		for (const entry of entries) {
			const srcPath = join(srcDir, entry.name);
			const destPath = join(destDir, entry.name);

			if (entry.isDirectory()) {
				// Skip hidden folders
				if (entry.name.startsWith(".")) continue;
				await copyStaticAssetsFromDir(srcPath, destPath);
				continue;
			}

			if (!entry.isFile()) continue;
			const ext = extname(entry.name).toLowerCase();
			if (ext === ".md" || ext === ".yaml" || ext === ".yml") continue;

			await mkdir(dirname(destPath), { recursive: true });
			await copyFile(srcPath, destPath);
		}
	} catch {
		// Skip missing/unreadable directories
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

// Render a single file
async function renderFile(
	filePath: string,
	urlKey: string,
	template: string,
	files: ContentFile[],
	provenance: Provenance,
	config: SiteConfig,
	theme: Theme,
	plugins: PluginInjections,
): Promise<string> {
	const uiVersion = provenance.version ? `v${provenance.version}` : "unversioned";
	const content = await readFile(filePath, "utf-8");

	let title = basename(filePath, extname(filePath));
	let htmlContent: string;
	let pageMeta = "";

	if (filePath.endsWith(".yaml")) {
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

	const pathPrefix = computePathPrefix(urlKey);
	const nav = buildNavStatic(files, urlKey, config, pathPrefix);
	const footer = buildFooter(provenance, config, pathPrefix);
	const breadcrumbs = buildBreadcrumbsStatic(urlKey, pathPrefix, files, config);
	const toc = buildToc(htmlContent);
	const brandTarget = config.brand.external ? ' target="_blank" rel="noopener"' : "";
	const themeCSS = generateThemeCSS(theme);
	const prismUrls = getPrismUrls(theme);
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
		.replace("{{HOT_RELOAD_SCRIPT}}", "");
}

// Render Getting Started page when no config
function renderGettingStarted(
	template: string,
	provenance: Provenance,
	config: SiteConfig,
	theme: Theme,
	plugins: PluginInjections,
): string {
	const uiVersion = provenance.version ? `v${provenance.version}` : "unversioned";
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
	const pathPrefix = "./";
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
		.replace("{{HOT_RELOAD_SCRIPT}}", "");
}

async function renderSlidesIndex(
	template: string,
	files: ContentFile[],
	provenance: Provenance,
	config: SiteConfig,
	theme: Theme,
	plugins: PluginInjections,
): Promise<string> {
	const uiVersion = provenance.version ? `v${provenance.version}` : "unversioned";
	const pathPrefix = "./";
	const slides = await collectSlides(files, {
		markdownTransform: (raw, file) => applyDataBindingsForSlides(raw, file.path, config),
	});
	let validateFences = false;
	try {
		const raw = await readFile(join(ROOT, "kitfly.plugins.yaml"), "utf-8");
		const parsed = parseYaml(raw) as unknown as Record<string, unknown>;
		const enabled = Array.isArray(parsed?.plugins) ? (parsed.plugins as unknown[]) : [];
		validateFences = enabled.some((p) => typeof p === "string" && p.startsWith("slides-visuals@"));
	} catch {
		// no config, skip
	}
	const renderedSlides = await Promise.all(
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

			const activeClass = i === 0 ? " active" : "";
			const classToken = slide.className ? ` ${slide.className}` : "";
			return `<section id="${slide.id}" class="slide${classToken}${activeClass}" data-slide-index="${i}">${inner}</section>`;
		}),
	);

	const htmlContent = `
        <div class="slides-shell" style="--slide-aspect: ${config.aspect || "16/9"}">
          <div class="slide-viewport">
            <div class="slide-frame">
              ${renderedSlides.join("\n")}
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
	const brandTarget = config.brand.external ? ' target="_blank" rel="noopener"' : "";
	const logoClass = config.brand.logoType === "wordmark" ? "logo-wordmark" : "logo-icon";
	const themeCSS = generateThemeCSS(theme);
	const prismUrls = getPrismUrls(theme);
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
		.replace("{{FOOTER}}", () => buildFooter(provenance, config, pathPrefix))
		.replace("{{THEME_CSS}}", () => themeCSS)
		.replace("{{PLUGIN_HEAD}}", () => plugins.head)
		.replace("{{PLUGIN_BODY_END}}", () => plugins.bodyEnd)
		.replace("{{PRISM_LIGHT_URL}}", () => prismUrls.light)
		.replace("{{PRISM_DARK_URL}}", () => prismUrls.dark)
		.replace("{{HOT_RELOAD_SCRIPT}}", "");
}

// Export for CLI usage
export interface BuildOptions {
	folder?: string;
	out?: string;
	raw?: boolean; // Include raw markdown files (default: true)
	profile?: string;
}

let INCLUDE_RAW = true;

export async function build(options: BuildOptions = {}) {
	if (options.folder) {
		ROOT = resolve(process.cwd(), options.folder);
	}
	if (options.out) {
		OUT_DIR = options.out;
	}
	if (options.raw === false) {
		INCLUDE_RAW = false;
	}
	ACTIVE_PROFILE = options.profile;
	await buildSite();
}

// Rename internal function
async function buildSite() {
	const DIST = resolve(ROOT, normalizeMsysPath(OUT_DIR));

	console.log("Building site...\n");

	// Load configuration
	const config = await loadSiteConfig(ROOT);
	console.log(`  ✓ Loaded config: "${config.title}" (${config.sections.length} sections)`);
	if (config.prebuild?.length) {
		await runPrebuildHooks(
			config.prebuild,
			ROOT,
			"build",
			ACTIVE_PROFILE,
			config.dataroot || "data",
		);
		console.log(`  ✓ prebuild hooks (${config.prebuild.length})`);
	}

	// Load theme
	const theme = await loadTheme(ROOT);
	console.log(`  ✓ Loaded theme: "${theme.name || "default"}"`);

	// Create dist directory
	await mkdir(DIST, { recursive: true });

	// Generate provenance (build mode)
	const provenance = await generateProvenance(ROOT, false, config.version);
	await writeFile(join(DIST, "provenance.json"), JSON.stringify(provenance, null, 2));
	console.log(
		`  ✓ provenance.json (${provenance.version ? `v${provenance.version}` : "unversioned"}, ${provenance.gitCommit})`,
	);

	// Read template
	const template = await readFile(await resolveTemplatePath(ROOT), "utf-8");

	// Load plugin injections (optional; no-op when kitfly.plugins.yaml is absent)
	const plugins = await loadPluginInjections({
		root: ROOT,
		mode: config.mode === "slides" ? "slides" : "docs",
	});

	// Copy CSS
	const css = await readFile(await resolveStylesPath(ROOT), "utf-8");
	await writeFile(join(DIST, "styles.css"), css);
	console.log("  ✓ styles.css");

	// Copy engine assets, then overlay site assets if present
	try {
		await stat(ENGINE_ASSETS_DIR);
		await cp(ENGINE_ASSETS_DIR, join(DIST, "assets"), { recursive: true });
		console.log("  ✓ assets/ (engine)");
	} catch {
		// No engine assets, skip
	}

	const siteAssetsDir = await resolveSiteAssetsDir(ROOT);
	if (siteAssetsDir) {
		try {
			await cp(siteAssetsDir, join(DIST, "assets"), { recursive: true });
			console.log("  ✓ assets/ (site override)");
		} catch {
			// Skip
		}
	}

	// Copy non-markdown assets referenced by docs (images, PDFs, etc.)
	for (const section of config.sections) {
		const sectionSrc = validatePath(ROOT, config.docroot, section.path);
		if (!sectionSrc) continue;
		const sectionDest = section.path === "." ? DIST : join(DIST, section.path);
		await copyStaticAssetsFromDir(sectionSrc, sectionDest);
	}

	// Collect and render all files
	const files = await filterByProfile(
		await collectFiles(ROOT, config),
		ACTIVE_PROFILE,
		config.profiles,
	);

	if (files.length === 0) {
		// No content - render Getting Started page
		const html = renderGettingStarted(template, provenance, config, theme, plugins);
		await writeFile(join(DIST, "index.html"), html);
		console.log("  ✓ index.html (Getting Started)");
		console.log(`\n\x1b[33mNo content found. Create site.yaml or content/ directory.\x1b[0m`);
		return;
	}

	if (config.mode === "slides") {
		const html = await renderSlidesIndex(template, files, provenance, config, theme, plugins);
		await writeFile(join(DIST, "index.html"), html);
		console.log(`  ✓ index.html (slides mode, ${files.length} source files)`);
		await generateAIAccessibility(DIST, files, config, provenance);
		console.log(`\n\x1b[32mBuild complete! Output in ${OUT_DIR}/\x1b[0m`);
		console.log(`\nTo view locally: open ${OUT_DIR}/index.html`);
		return;
	}

	for (const file of files) {
		const html = await renderFile(
			file.path,
			file.urlPath,
			template,
			files,
			provenance,
			config,
			theme,
			plugins,
		);

		// Create output path
		const outPath = join(DIST, `${file.urlPath}.html`);
		await mkdir(dirname(outPath), { recursive: true });
		await writeFile(outPath, html);

		console.log(`  ✓ ${file.urlPath}.html`);
	}

	// Create index.html
	if (config.home) {
		// Render dedicated home page
		const homePath = validatePath(ROOT, config.docroot, config.home);
		if (homePath) {
			try {
				await stat(homePath);
				const homeHtml = await renderFile(
					homePath,
					"",
					template,
					files,
					provenance,
					config,
					theme,
					plugins,
				);
				await writeFile(join(DIST, "index.html"), homeHtml);
				console.log(`  ✓ index.html (from ${config.home})`);
			} catch {
				console.warn(`  ⚠ Home page ${config.home} not found, using first file`);
				const firstFile = files[0];
				const indexHtml = await renderFile(
					firstFile.path,
					"",
					template,
					files,
					provenance,
					config,
					theme,
					plugins,
				);
				await writeFile(join(DIST, "index.html"), indexHtml);
				console.log("  ✓ index.html");
			}
		}
	} else {
		// Fallback: copy first file as index
		const firstFile = files[0];
		const indexHtml = await renderFile(
			firstFile.path,
			"",
			template,
			files,
			provenance,
			config,
			theme,
			plugins,
		);
		await writeFile(join(DIST, "index.html"), indexHtml);
		console.log("  ✓ index.html");
	}

	// Create section redirect files (for breadcrumb navigation)
	const sectionFirstFile: Map<string, string> = new Map();
	for (const file of files) {
		if (!sectionFirstFile.has(file.section)) {
			const parts = file.urlPath.split("/");
			if (parts.length > 1) {
				const sectionPath = parts.slice(0, -1).join("/");
				sectionFirstFile.set(sectionPath, file.urlPath);
			}
		}
	}

	for (const [sectionPath, firstFilePath] of sectionFirstFile) {
		const targetName = firstFilePath.split("/").pop() || firstFilePath;
		const targetHref = `./${targetName}.html`;
		const redirectHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="refresh" content="0; url=${targetHref}">
  <title>Redirecting...</title>
</head>
<body>
  <p>Redirecting to <a href="${targetHref}">${targetName}</a>...</p>
</body>
</html>`;
		const redirectPath = join(DIST, sectionPath, "index.html");
		await mkdir(dirname(redirectPath), { recursive: true });
		await writeFile(redirectPath, redirectHtml);
		console.log(`  ✓ ${sectionPath}/index.html (redirect)`);
	}

	// Generate AI accessibility files
	await generateAIAccessibility(DIST, files, config, provenance);

	console.log(`\n\x1b[32mBuild complete! Output in ${OUT_DIR}/\x1b[0m`);
	console.log(`\nTo view locally: open ${OUT_DIR}/index.html`);
}

// Generate AI accessibility files: content-index.json, llms.txt, and optionally _raw/
async function generateAIAccessibility(
	dist: string,
	files: ContentFile[],
	config: SiteConfig,
	provenance: Provenance,
) {
	// 1. Generate content-index.json
	const contentIndex = {
		version: provenance.version,
		generated: new Date().toISOString(),
		title: config.title,
		baseUrl: "/",
		rawMarkdownPath: INCLUDE_RAW ? "/_raw" : null,
		pages: await Promise.all(
			files.map(async (file) => {
				let title = basename(file.path).replace(/\.(md|yaml|json)$/, "");
				let description: string | undefined;

				// Try to extract title and description from frontmatter
				if (file.path.endsWith(".md")) {
					try {
						const content = await readFile(file.path, "utf-8");
						const { frontmatter } = parseFrontmatter(content);
						if (frontmatter.title) title = frontmatter.title as string;
						if (frontmatter.description) description = frontmatter.description as string;
					} catch {
						// Use defaults
					}
				}

				return {
					path: `/${file.urlPath}`,
					htmlPath: `/${file.urlPath}.html`,
					rawPath: INCLUDE_RAW ? `/_raw/${file.urlPath}.md` : undefined,
					title,
					section: file.section,
					source: file.path.replace(`${ROOT}/`, ""),
					description,
				};
			}),
		),
	};

	await writeFile(join(dist, "content-index.json"), JSON.stringify(contentIndex, null, 2));
	console.log("  ✓ content-index.json (AI accessibility)");

	// 2. Generate llms.txt
	const llmsTxt = `# llms.txt - AI agent guidance for ${config.title}
# Learn more: https://llmstxt.org/

# Site metadata
name: ${config.title}
version: ${provenance.version}
generated: ${new Date().toISOString()}

# Content discovery
content-index: /content-index.json
${INCLUDE_RAW ? "raw-markdown: /_raw/{path}.md" : "# raw-markdown: disabled"}

# Preferred format for content consumption
preferred-format: markdown

# Site structure
sections: ${config.sections.map((s) => s.name).join(", ")}
total-pages: ${files.length}
`;

	await writeFile(join(dist, "llms.txt"), llmsTxt);
	console.log("  ✓ llms.txt (AI accessibility)");

	// 3. Copy raw markdown files to _raw/ if enabled
	if (INCLUDE_RAW) {
		const rawDir = join(dist, "_raw");
		await mkdir(rawDir, { recursive: true });

		for (const file of files) {
			if (file.path.endsWith(".md")) {
				try {
					const content = await readFile(file.path, "utf-8");
					const rawPath = join(rawDir, `${file.urlPath}.md`);
					await mkdir(dirname(rawPath), { recursive: true });
					await writeFile(rawPath, content);
				} catch {
					// Skip if can't read
				}
			}
		}
		console.log("  ✓ _raw/ (raw markdown for AI agents)");
	}
}

// Run directly if executed as script
if (import.meta.main) {
	// Check for help flag
	if (process.argv.includes("--help")) {
		console.log(`
Usage: bun run build [folder] [options]

Options:
  -o, --out <dir>       Output directory [env: KITFLY_BUILD_OUT] [default: ${DEFAULT_OUT}]
  --profile <name>      Active content profile [env: KITFLY_PROFILE]
  --raw                 Include raw markdown files [env: KITFLY_BUILD_RAW] [default: true]
  --no-raw              Don't include raw markdown files
  --help                Show this help message

Examples:
  bun run build
  bun run build ./docs
  bun run build --out ./public
  bun run build ./docs --out ./public --no-raw
  KITFLY_BUILD_OUT=public bun run build
`);
		process.exit(0);
	}

	const cfg = getConfig();
	build({
		folder: cfg.folder,
		out: cfg.out,
		raw: cfg.raw,
		profile: cfg.profile,
	}).catch(console.error);
}
