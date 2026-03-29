/**
 * Bundle a site into a single self-contained HTML file
 *
 * Usage: bun run bundle [folder] [options]
 *
 * Options:
 *   -o, --out <dir>    Output directory [env: KITFLY_BUNDLE_OUT] [default: bundles]
 *   -n, --name <file>  Bundle filename [env: KITFLY_BUNDLE_NAME] [default: bundle.html]
 *   --profile <name>   Active content profile [env: KITFLY_PROFILE]
 *   --raw              Include raw markdown in bundle [env: KITFLY_BUNDLE_RAW] [default: true]
 *   --no-raw           Don't include raw markdown
 *   --help             Show help message
 *
 * Creates bundles/bundle.html - a single file containing all content,
 * styles, and scripts for offline viewing.
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { marked, Renderer } from "marked";
import { ENGINE_ASSETS_DIR } from "../src/engine.ts";
import { loadPluginInjections } from "../src/plugin-loader.ts";
import {
	buildBundleFooter,
	buildLogoImgHtml,
	buildSectionNav,
	// Navigation/template building
	buildSlideNavHierarchical,
	// Types
	type ContentFile,
	collectFiles,
	collectSlides,
	envBool,
	// Config helpers
	envString,
	// Formatting
	escapeHtml,
	filterByProfile,
	filterUnknownSlidesVisualsTypeDiagnostics,
	// YAML/Config parsing
	loadDataBindings,
	loadSiteConfig,
	mergeFrontmatterWithBody,
	// Markdown utilities
	pagePathForData,
	parseFrontmatter,
	parseYaml,
	resolveBindings,
	resolveSiteVersion,
	resolveStylesPath,
	runPrebuildHooks,
	type SiteConfig,
	slugify,
	validatePath,
	validateSlidesVisualsFences,
} from "../src/shared.ts";
import { generateThemeCSS, getPrismUrls, loadTheme } from "../src/theme.ts";

// Defaults
const DEFAULT_OUT = "bundles";
const DEFAULT_NAME = "bundle.html";

let ROOT = process.cwd();
let OUT_DIR = DEFAULT_OUT;
let BUNDLE_NAME = DEFAULT_NAME;
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
	name?: string;
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
		} else if ((arg === "--name" || arg === "-n") && next && !next.startsWith("-")) {
			result.name = next;
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

function getConfig(): {
	folder?: string;
	out: string;
	name: string;
	raw: boolean;
	profile?: string;
} {
	const args = parseArgs(process.argv.slice(2));
	const legacyOut = envString("KITFLY_BUILD_OUT", DEFAULT_OUT);
	const out = args.out ?? envString("KITFLY_BUNDLE_OUT", legacyOut);
	const legacyRaw = envBool("KITFLY_BUILD_RAW", true);
	const raw = args.raw ?? envBool("KITFLY_BUNDLE_RAW", legacyRaw);
	return {
		folder: args.folder,
		out,
		name: args.name ?? envString("KITFLY_BUNDLE_NAME", DEFAULT_NAME),
		raw,
		profile: args.profile ?? process.env.KITFLY_PROFILE,
	};
}

// Configure marked with custom renderer
const renderer = new Renderer();
const originalCode = renderer.code.bind(renderer);
renderer.code = (code: { type: "code"; raw: string; text: string; lang?: string }) => {
	if (code.lang === "mermaid") {
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

// MIME type from file extension
function imageMime(filePath: string): string | null {
	const ext = extname(filePath).toLowerCase();
	const map: Record<string, string> = {
		".png": "image/png",
		".jpg": "image/jpeg",
		".jpeg": "image/jpeg",
		".gif": "image/gif",
		".webp": "image/webp",
		".svg": "image/svg+xml",
		".ico": "image/x-icon",
	};
	return map[ext] ?? null;
}

// Resolve a local image path to an absolute filesystem path
async function resolveLocalImage(src: string, config: SiteConfig): Promise<string | null> {
	const clean = decodeURIComponent(src).replace(/^\//, "");

	// 1. /assets/... — try site assets then engine assets
	if (clean.startsWith("assets/")) {
		const rel = clean.slice("assets/".length);
		for (const base of [join(ROOT, "assets"), ENGINE_ASSETS_DIR]) {
			const p = join(base, rel);
			try {
				await stat(p);
				return p;
			} catch {
				/* continue */
			}
		}
	}

	// 2. Resolve via docroot (handles absolute content paths)
	const docPath = validatePath(ROOT, config.docroot, clean, false);
	if (docPath) {
		try {
			await stat(docPath);
			return docPath;
		} catch {
			/* continue */
		}
	}

	// 3. Search section directories
	for (const section of config.sections) {
		const sectionPath = validatePath(ROOT, config.docroot, section.path, false);
		if (!sectionPath) continue;
		const p = join(sectionPath, clean);
		try {
			await stat(p);
			return p;
		} catch {
			/* continue */
		}
	}

	return null;
}

// Convert a local file to a base64 data URI
async function fileToDataUri(filePath: string): Promise<string | null> {
	const mime = imageMime(filePath);
	if (!mime) return null;
	const bytes = await readFile(filePath);
	const base64 = Buffer.from(bytes).toString("base64");
	return `data:${mime};base64,${base64}`;
}

// Inline all local <img src="..."> references as base64 data URIs
async function inlineLocalImages(html: string, config: SiteConfig): Promise<string> {
	const imgRegex = /<img\s[^>]*src="([^"]+)"[^>]*>/g;
	const matches = [...html.matchAll(imgRegex)];
	let result = html;

	for (const match of matches) {
		const src = match[1];
		// Skip external URLs and already-inlined data URIs
		if (/^(https?:|data:)/i.test(src)) continue;

		const resolved = await resolveLocalImage(src, config);
		if (!resolved) {
			console.warn(`  ⚠ Image not found for inlining: ${src}`);
			continue;
		}
		const dataUri = await fileToDataUri(resolved);
		if (!dataUri) continue;
		result = result.replace(match[0], match[0].replace(`src="${src}"`, `src="${dataUri}"`));
	}

	return result;
}

// Rewrite internal content links to hash navigation for single-file bundle
function rewriteContentLinks(
	html: string,
	files: ContentFile[],
	currentUrlPath?: string,
	docroot?: string,
): string {
	// Build lookup maps: urlPath -> sectionId, plus docroot-stripped variants
	const lookup = new Map<string, string>();
	for (const file of files) {
		const sid = slugify(file.urlPath);
		lookup.set(file.urlPath, sid);
		// Also register without the docroot prefix so content-relative links match
		if (docroot && docroot !== "." && file.urlPath.startsWith(`${docroot}/`)) {
			lookup.set(file.urlPath.slice(docroot.length + 1), sid);
		}
	}

	function resolve(href: string): string | null {
		let cleaned = href;

		// Resolve relative links against current page's urlPath
		if (currentUrlPath && !cleaned.startsWith("/")) {
			const base = currentUrlPath.includes("/")
				? currentUrlPath.slice(0, currentUrlPath.lastIndexOf("/"))
				: "";
			cleaned = base ? `${base}/${cleaned}` : cleaned;

			// Resolve ../ segments
			const parts = cleaned.split("/");
			const resolved: string[] = [];
			for (const part of parts) {
				if (part === "..") {
					resolved.pop();
				} else if (part !== ".") {
					resolved.push(part);
				}
			}
			cleaned = resolved.join("/");
		}

		// Normalize
		cleaned = cleaned
			.replace(/^\//, "")
			.replace(/\.(html|md)$/, "")
			.replace(/\/$/, "");

		return lookup.get(cleaned) ?? null;
	}

	return html.replace(/<a\s([^>]*?)href="([^"]*)"([^>]*?)>/g, (_match, before, href, after) => {
		// Skip external, anchor-only, and data links
		if (/^(https?:|mailto:|data:|#)/i.test(href)) {
			return `<a ${before}href="${href}"${after}>`;
		}

		const sectionId = resolve(href);
		if (sectionId) {
			return `<a ${before}href="#${sectionId}"${after}>`;
		}

		// Leave unmatched links unchanged
		return `<a ${before}href="${href}"${after}>`;
	});
}

function buildBundleNav(files: ContentFile[], config: SiteConfig): string {
	const sectionFiles = new Map<string, ContentFile[]>();
	for (const file of files) {
		if (!sectionFiles.has(file.section)) {
			sectionFiles.set(file.section, []);
		}
		sectionFiles.get(file.section)?.push(file);
	}

	const makeHref = (urlPath: string) => `#${slugify(urlPath)}`;
	let html = '<ul class="bundle-nav">';
	if (config.home) {
		html += '<li><a href="#home" class="nav-home">Home</a></li>';
	}
	html += buildSectionNav(sectionFiles, config, null, makeHref);
	html += "</ul>";
	return html;
}

async function buildSlidesBundleContent(files: ContentFile[], config: SiteConfig): Promise<string> {
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
					// Keep original text
				}
				inner = `<pre><code class="language-json">${escapeHtml(prettyJson)}</code></pre>`;
			}

			inner = await inlineLocalImages(inner, config);
			inner = rewriteContentLinks(inner, files, slide.sourceUrlPath, config.docroot);

			const activeClass = i === 0 ? " active" : "";
			const classToken = slide.className ? ` ${slide.className}` : "";
			return `<section id="${slide.id}" class="slide${classToken}${activeClass}" data-slide-index="${i}">${inner}</section>`;
		}),
	);

	return `
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
}

function buildBundleSidebarHeader(
	config: SiteConfig,
	version: string | undefined,
	brandLogo: string,
	brandLogoDark?: string,
): string {
	const brandTarget = config.brand.external ? ' target="_blank" rel="noopener"' : "";
	const logoClass = config.brand.logoType === "wordmark" ? "logo-wordmark" : "logo-icon";
	const productHref = config.home ? "#home" : "#";
	const versionLabel = version ? `v${version}` : "unversioned";
	const brandInitial = escapeHtml(config.brand.name.trim().charAt(0).toUpperCase() || "K");
	const brandLogoHtml = buildLogoImgHtml({
		logo: brandLogo,
		logoDark: brandLogoDark,
		alt: config.brand.name,
		className: "logo-img",
		onerrorFallback: true,
	});

	return `
      <div class="sidebar-header">
        <div class="logo ${logoClass}">
          <a href="${config.brand.url}" class="logo-icon" data-initial="${brandInitial}"${brandTarget}>
            ${brandLogoHtml}
          </a>
          <span class="logo-text">
            <a href="${config.brand.url}" class="brand"${brandTarget}>${config.brand.name}</a>
            <a href="${productHref}" class="product">Bundle</a>
          </span>
        </div>
        <div class="header-tools">
          <button class="theme-toggle" onclick="toggleTheme()" title="Toggle theme" aria-label="Toggle theme">
            <svg class="icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="5"/>
              <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>
            </svg>
            <svg class="icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
            </svg>
          </button>
	          <div class="sidebar-meta">
	            <span class="meta-version">${versionLabel}</span>
	            <span class="meta-branch">bundle</span>
	          </div>
        </div>
      </div>`;
}

// Resolve and inline a brand asset path, returning data URI or original path
async function inlineBrandAsset(assetPath: string): Promise<string> {
	const clean = assetPath.replace(/^\//, "");
	for (const base of [join(ROOT, "assets"), ENGINE_ASSETS_DIR]) {
		// assetPath is typically "assets/brand/logo.png" — strip leading "assets/"
		const rel = clean.startsWith("assets/") ? clean.slice("assets/".length) : clean;
		const p = join(base, rel);
		try {
			await stat(p);
			const uri = await fileToDataUri(p);
			if (uri) return uri;
		} catch {
			/* continue */
		}
	}

	// Support any safe site-root-relative path (e.g., logos/footer.png).
	const siteRootPath = validatePath(ROOT, ".", clean, false);
	if (siteRootPath) {
		try {
			await stat(siteRootPath);
			const uri = await fileToDataUri(siteRootPath);
			if (uri) return uri;
		} catch {
			/* continue */
		}
	}
	return assetPath;
}

// Fetch and cache external scripts for offline bundle
async function fetchScript(url: string): Promise<string> {
	console.log(`  ↓ Fetching ${url.split("/").pop()}...`);
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`Failed to fetch ${url}: ${response.status}`);
	}
	return response.text();
}

async function fetchExternalAssets(prismUrls: { light: string; dark: string }): Promise<{
	prismCss: string;
	prismCssDark: string;
	prismCore: string;
	prismAutoloader: string;
	mermaid: string;
}> {
	const [prismCss, prismCssDark, prismCore, prismAutoloader, mermaid] = await Promise.all([
		fetchScript(prismUrls.light),
		fetchScript(prismUrls.dark),
		fetchScript("https://cdn.jsdelivr.net/npm/prismjs@1/components/prism-core.min.js"),
		fetchScript(
			"https://cdn.jsdelivr.net/npm/prismjs@1/plugins/autoloader/prism-autoloader.min.js",
		),
		fetchScript("https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"),
	]);

	return { prismCss, prismCssDark, prismCore, prismAutoloader, mermaid };
}

// Build the bundle
async function bundle() {
	console.log("Bundling site...\n");

	const config = await loadSiteConfig(ROOT, "Documentation");
	console.log(`  ✓ Loaded config: "${config.title}" (${config.sections.length} sections)`);
	if (config.prebuild?.length) {
		await runPrebuildHooks(
			config.prebuild,
			ROOT,
			"bundle",
			ACTIVE_PROFILE,
			config.dataroot || "data",
		);
		console.log(`  ✓ prebuild hooks (${config.prebuild.length})`);
	}

	const theme = await loadTheme(ROOT);
	console.log(`  ✓ Loaded theme: "${theme.name || "default"}"`);
	const prismUrls = getPrismUrls(theme);

	const files = await filterByProfile(
		await collectFiles(ROOT, config),
		ACTIVE_PROFILE,
		config.profiles,
	);
	if (files.length === 0) {
		console.error("No content files found. Cannot create bundle.");
		process.exit(1);
	}

	// Read CSS
	const css = await readFile(await resolveStylesPath(ROOT), "utf-8");
	console.log("  ✓ Loaded styles.css");

	// Fetch external assets for offline support
	const assets = await fetchExternalAssets(prismUrls);
	console.log("  ✓ Fetched external assets (Prism, Mermaid)");

	// Resolve site version (site.yaml version, then git tag)
	const version = await resolveSiteVersion(ROOT, config.version);

	// Collect page metadata and raw content for AI accessibility
	const pageIndex: {
		path: string;
		title: string;
		section: string;
		description?: string;
	}[] = [];
	const rawMarkdown: { path: string; content: string }[] = [];
	let navHtml = "";
	let contentHtml = "";

	if (config.mode === "slides") {
		const slides = await collectSlides(files);
		for (const file of files) {
			const content = await readFile(file.path, "utf-8");
			if (INCLUDE_RAW && file.path.endsWith(".md")) {
				rawMarkdown.push({ path: file.urlPath, content });
			}
		}
		for (const slide of slides) {
			pageIndex.push({
				path: slide.id,
				title: slide.title,
				section: slide.section,
			});
		}
		navHtml = buildSlideNavHierarchical(slides, config, "slide-1");
		contentHtml = await buildSlidesBundleContent(files, config);
	} else {
		// Build navigation and content sections
		const sections: Map<string, { id: string; title: string; html: string }[]> = new Map();

		// Add home page as first item if specified
		if (config.home) {
			const homePath = validatePath(ROOT, config.docroot, config.home);
			if (homePath) {
				try {
					await stat(homePath);
					const content = await readFile(homePath, "utf-8");
					const { frontmatter, body } = await applyDataBindingsToMarkdown(
						content,
						homePath,
						config,
					);
					const title = (frontmatter.title as string) || "Home";
					let htmlContent = marked.parse(body) as string;
					htmlContent = await inlineLocalImages(htmlContent, config);
					htmlContent = rewriteContentLinks(htmlContent, files, undefined, config.docroot);
					sections.set("Home", [{ id: "home", title, html: htmlContent }]);
					console.log(`  ✓ Added home page: ${config.home}`);
				} catch {
					console.warn(`  ⚠ Home page ${config.home} not found`);
				}
			}
		}

		for (const file of files) {
			const content = await readFile(file.path, "utf-8");
			let title = basename(file.path).replace(/\.(md|yaml|json)$/, "");
			let description: string | undefined;
			let htmlContent: string;

			if (file.path.endsWith(".yaml")) {
				htmlContent = `<pre><code class="language-yaml">${escapeHtml(content)}</code></pre>`;
			} else if (file.path.endsWith(".json")) {
				// Render JSON as code block (pretty-printed)
				let prettyJson = content;
				try {
					prettyJson = JSON.stringify(JSON.parse(content), null, 2);
				} catch {
					// Use original if not valid JSON
				}
				htmlContent = `<pre><code class="language-json">${escapeHtml(prettyJson)}</code></pre>`;
			} else {
				const { frontmatter, body } = await applyDataBindingsToMarkdown(content, file.path, config);
				if (frontmatter.title) {
					title = frontmatter.title as string;
				}
				if (frontmatter.description) {
					description = frontmatter.description as string;
				}
				htmlContent = marked.parse(body) as string;

				// Collect raw markdown for AI accessibility
				if (INCLUDE_RAW) {
					rawMarkdown.push({ path: file.urlPath, content });
				}
			}

			// Collect page metadata for content index
			pageIndex.push({
				path: file.urlPath,
				title,
				section: file.section,
				description,
			});

			// Inline any SVG references
			htmlContent = await inlineLocalImages(htmlContent, config);
			htmlContent = rewriteContentLinks(htmlContent, files, file.urlPath, config.docroot);

			const sectionId = slugify(file.urlPath);

			if (!sections.has(file.section)) {
				sections.set(file.section, []);
			}
			sections.get(file.section)?.push({ id: sectionId, title, html: htmlContent });
		}

		// Build navigation HTML from shared hierarchical nav tree
		navHtml = buildBundleNav(files, config);

		// Build content HTML
		for (const [, items] of sections) {
			for (const item of items) {
				contentHtml += `
        <section id="${item.id}" class="bundle-section">
          <h1 class="section-title">${item.title}</h1>
          ${item.html}
        </section>
      `;
			}
		}
	}

	const themeCSS = generateThemeCSS(theme);
	const plugins = await loadPluginInjections({
		root: ROOT,
		mode: config.mode === "slides" ? "slides" : "docs",
	});

	// Inline brand assets for self-contained bundle
	const brandLogo = await inlineBrandAsset(config.brand.logo || "assets/brand/logo.png");
	const brandLogoDark =
		typeof config.brand.logoDark === "string"
			? await inlineBrandAsset(config.brand.logoDark)
			: undefined;
	const brandFavicon = await inlineBrandAsset(config.brand.favicon || "assets/brand/favicon.png");
	const footerLogo =
		typeof config.footer?.logo === "string"
			? await inlineBrandAsset(config.footer.logo)
			: undefined;
	const footerLogoDark =
		typeof config.footer?.logoDark === "string"
			? await inlineBrandAsset(config.footer.logoDark)
			: undefined;

	// Build the complete HTML document
	const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${config.title}</title>
  <link rel="icon" href="${brandFavicon}">
  <style>
${css}

/* Bundle-specific styles */
.bundle-nav { position: sticky; top: 1rem; }
.bundle-section {
  padding: 2rem 0;
  border-bottom: 1px solid var(--color-border);
  scroll-margin-top: 1rem;
}
.bundle-section:last-child { border-bottom: none; }
.section-title { margin-top: 0; }

/* Print styles for bundle */
@media print {
  .sidebar { display: none !important; }
  .bundle-section { page-break-inside: avoid; }
}
  </style>
  ${themeCSS}
  <style id="prism-light">
${assets.prismCss}
  </style>
  <style id="prism-dark" disabled>
${assets.prismCssDark}
  </style>
  ${plugins.head}
  <script>
    (function() {
      const saved = localStorage.getItem('theme');
      if (saved) {
        document.documentElement.setAttribute('data-theme', saved);
      }
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      const isDark = saved === 'dark' || (!saved && prefersDark);
      if (isDark) {
        document.getElementById('prism-light')?.setAttribute('disabled', '');
        document.getElementById('prism-dark')?.removeAttribute('disabled');
      }
    })();
  </script>
</head>
<body class="${config.mode === "slides" ? "mode-slides" : "mode-docs"}">
  <div class="layout">
    <nav class="sidebar">
${buildBundleSidebarHeader(config, version, brandLogo, brandLogoDark)}
      <div class="sidebar-nav">
        ${navHtml}
      </div>
    </nav>
    <main class="content">
      <article class="prose">
        ${contentHtml}
      </article>
    </main>
  </div>
  ${buildBundleFooter(version, config, footerLogo, footerLogoDark)}
  <script>
${assets.prismCore}
  </script>
  <script>
${assets.prismAutoloader}
  </script>
  <script>
${assets.mermaid}
  </script>
  ${plugins.bodyEnd}
  <script>
    // Initialize Mermaid
    function getMermaidTheme() {
      const theme = document.documentElement.getAttribute('data-theme');
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      const isDark = theme === 'dark' || (!theme && prefersDark);
      return isDark ? 'dark' : 'neutral';
    }

    mermaid.initialize({ startOnLoad: true, theme: getMermaidTheme() });

    window.reinitMermaid = async function() {
      mermaid.initialize({ startOnLoad: false, theme: getMermaidTheme() });
      const diagrams = document.querySelectorAll('.mermaid');
      for (const el of diagrams) {
        const code = el.getAttribute('data-mermaid-source');
        if (code) {
          el.innerHTML = code;
          el.removeAttribute('data-processed');
        }
      }
      await mermaid.run({ nodes: diagrams });
    };
  </script>
  <script>
    function toggleTheme() {
      const html = document.documentElement;
      const current = html.getAttribute('data-theme');
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;

      let next;
      if (current === 'dark') {
        next = 'light';
      } else if (current === 'light') {
        next = 'dark';
      } else {
        next = prefersDark ? 'light' : 'dark';
      }

      html.setAttribute('data-theme', next);
      localStorage.setItem('theme', next);

      const prismLight = document.getElementById('prism-light');
      const prismDark = document.getElementById('prism-dark');
      if (next === 'dark') {
        prismLight?.setAttribute('disabled', '');
        prismDark?.removeAttribute('disabled');
      } else {
        prismLight?.removeAttribute('disabled');
        prismDark?.setAttribute('disabled', '');
      }

      if (window.reinitMermaid) {
        window.reinitMermaid();
      }
      if (window.reinitCharts) {
        window.reinitCharts();
      }
    }

    // Slides mode hash routing
    (function initSlidesMode() {
      const shell = document.querySelector('.slides-shell');
      if (!shell) {
        // Docs mode: retain smooth in-page anchor scrolling.
        document.querySelectorAll('a[href^="#"]').forEach((link) => {
          link.addEventListener('click', (e) => {
            const href = link.getAttribute('href') || '';
            if (href.length <= 1) return;
            const target = document.querySelector(href);
            if (!target) return;
            e.preventDefault();
            target.scrollIntoView({ behavior: 'smooth', block: 'start' });
            history.replaceState(null, '', href);
          });
        });
        return;
      }

      const slides = Array.from(document.querySelectorAll('.slide'));
      if (!slides.length) return;

      const prevBtn = document.querySelector('.slide-prev');
      const nextBtn = document.querySelector('.slide-next');
      const counter = document.querySelector('.slide-counter');
      const progressBar = document.querySelector('.slide-progress-bar');
      const navLinks = Array.from(document.querySelectorAll('.sidebar-nav a[href^="#slide-"]'));
      let current = 0;

      function setActive(n) {
        current = Math.max(0, Math.min(n, slides.length - 1));
        slides.forEach((slide, idx) => slide.classList.toggle('active', idx === current));
        navLinks.forEach((link) => {
          const active = link.getAttribute('href') === '#' + slides[current].id;
          link.classList.toggle('active', active);
        });
        if (counter) counter.textContent = (current + 1) + ' / ' + slides.length;
        if (progressBar) progressBar.style.width = (((current + 1) / slides.length) * 100) + '%';
        if (prevBtn) prevBtn.disabled = current === 0;
        if (nextBtn) nextBtn.disabled = current === slides.length - 1;
        history.replaceState(null, '', '#'+slides[current].id);
      }

      function setFromHash() {
        const hash = window.location.hash || '';
        const idx = slides.findIndex((s) => '#'+s.id === hash);
        if (idx >= 0) setActive(idx);
        else setActive(0);
      }

      prevBtn?.addEventListener('click', () => setActive(current - 1));
      nextBtn?.addEventListener('click', () => setActive(current + 1));

      document.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowRight' || e.key === ' ') {
          e.preventDefault();
          setActive(current + 1);
        } else if (e.key === 'ArrowLeft') {
          e.preventDefault();
          setActive(current - 1);
        } else if (e.key === 'Home') {
          e.preventDefault();
          setActive(0);
        } else if (e.key === 'End') {
          e.preventDefault();
          setActive(slides.length - 1);
        }
      });

      window.addEventListener('hashchange', setFromHash);
      setFromHash();
    })();
  </script>
  <!-- AI Accessibility: Content Index -->
  <script type="application/json" id="kitfly-content-index">
${JSON.stringify(
	{
		version,
		title: config.title,
		generated: new Date().toISOString(),
		format: "bundle",
		pages: pageIndex.map((p) => ({
			id: slugify(p.path),
			path: p.path,
			title: p.title,
			section: p.section,
			description: p.description,
		})),
	},
	null,
	2,
)}
  </script>
${
	INCLUDE_RAW
		? `  <!-- AI Accessibility: Raw Markdown -->
  <script type="application/json" id="kitfly-raw-markdown">
${JSON.stringify(
	rawMarkdown.reduce(
		(acc, { path, content }) => {
			acc[path] = content;
			return acc;
		},
		{} as Record<string, string>,
	),
)}
  </script>`
		: "<!-- Raw markdown disabled (--no-raw) -->"
}
</body>
</html>`;

	// Write the bundle
	const outDir = resolve(ROOT, normalizeMsysPath(OUT_DIR));
	await mkdir(outDir, { recursive: true });
	const bundlePath = join(outDir, BUNDLE_NAME);
	await writeFile(bundlePath, html);

	const sizeKB = (Buffer.byteLength(html, "utf-8") / 1024).toFixed(1);
	console.log(`  ✓ ${BUNDLE_NAME} (${sizeKB} KB, ${files.length} pages)`);

	console.log(`\n\x1b[32mBundle complete! Output: ${OUT_DIR}/${BUNDLE_NAME}\x1b[0m`);
	console.log(`\nTo view: open ${OUT_DIR}/${BUNDLE_NAME}`);
}

export interface BundleOptions {
	folder?: string;
	out?: string;
	name?: string;
	raw?: boolean; // Include raw markdown in bundle (default: true)
	profile?: string;
}

let INCLUDE_RAW = true;

export {
	buildBundleNav,
	buildBundleSidebarHeader,
	fileToDataUri,
	imageMime,
	inlineBrandAsset,
	inlineLocalImages,
	parseArgs,
	resolveLocalImage,
	rewriteContentLinks,
};

export async function bundleSite(options: BundleOptions = {}) {
	if (options.folder) {
		ROOT = resolve(process.cwd(), options.folder);
	}
	if (options.out) {
		OUT_DIR = options.out;
	}
	if (options.name) {
		BUNDLE_NAME = options.name;
	}
	if (options.raw === false) {
		INCLUDE_RAW = false;
	}
	ACTIVE_PROFILE = options.profile;
	await bundle();
}

if (import.meta.main) {
	// Check for help flag
	if (process.argv.includes("--help")) {
		console.log(`
Usage: bun run bundle [folder] [options]

Options:
  -o, --out <dir>       Output directory [env: KITFLY_BUNDLE_OUT] [default: ${DEFAULT_OUT}]
  -n, --name <file>     Bundle filename [env: KITFLY_BUNDLE_NAME] [default: ${DEFAULT_NAME}]
  --profile <name>      Active content profile [env: KITFLY_PROFILE]
  --raw                 Include raw markdown in bundle [env: KITFLY_BUNDLE_RAW] [default: true]
  --no-raw              Don't include raw markdown
  --help                Show this help message

Examples:
  bun run bundle
  bun run bundle ./docs
  bun run bundle --name docs.html
  bun run bundle ./docs --out ./bundles --name handbook.html
  KITFLY_BUNDLE_NAME=docs.html bun run bundle
  KITFLY_BUNDLE_OUT=release bun run bundle
`);
		process.exit(0);
	}

	const cfg = getConfig();
	bundleSite({
		folder: cfg.folder,
		out: cfg.out,
		name: cfg.name,
		raw: cfg.raw,
		profile: cfg.profile,
	}).catch(console.error);
}
