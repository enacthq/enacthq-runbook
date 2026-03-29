/**
 * Theme loading and CSS generation for kitfly
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

// Theme types
export interface ThemeColors {
	background: string;
	surface: string;
	text: string;
	textMuted?: string;
	heading: string;
	primary: string;
	primaryHover?: string;
	accent?: string;
	border: string;
}

export interface Theme {
	name?: string;
	layout?: {
		sidebarWidth?: string;
	};
	colors: {
		light: ThemeColors;
		dark: ThemeColors;
	};
	code?: {
		light?: string;
		dark?: string;
	};
	typography?: {
		body?: string;
		headings?: string;
		code?: string;
		baseSize?: string;
		scale?: string;
	};
}

// Default theme (kitfly brand)
export const DEFAULT_THEME: Theme = {
	name: "Kitfly Default",
	colors: {
		light: {
			background: "#ffffff",
			surface: "#f5f7f8",
			text: "#374151",
			textMuted: "#6b7280",
			heading: "#152F46",
			primary: "#007182",
			primaryHover: "#0a6172",
			accent: "#D17059",
			border: "#e5e7eb",
		},
		dark: {
			background: "#0d1117",
			surface: "#152F46",
			text: "#e5e7eb",
			textMuted: "#9ca3af",
			heading: "#f9fafb",
			primary: "#709EA6",
			primaryHover: "#8fb5bc",
			accent: "#e8947f",
			border: "#374151",
		},
	},
	code: {
		light: "default",
		dark: "okaidia",
	},
	layout: {
		sidebarWidth: "280px",
	},
	typography: {
		body: "system",
		headings: "system",
		code: "mono",
		baseSize: "16px",
		scale: "1.25",
	},
};

// Font stack presets
const FONT_STACKS: Record<string, string> = {
	system:
		'-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
	mono: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
	serif: 'Georgia, Cambria, "Times New Roman", Times, serif',
	readable: 'Charter, "Bitstream Charter", "Sitka Text", Cambria, serif',
};

// Prism theme CDN URLs
const PRISM_THEMES: Record<string, string> = {
	default: "https://cdn.jsdelivr.net/npm/prismjs@1/themes/prism.min.css",
	coy: "https://cdn.jsdelivr.net/npm/prismjs@1/themes/prism-coy.min.css",
	"solarized-light": "https://cdn.jsdelivr.net/npm/prismjs@1/themes/prism-solarizedlight.min.css",
	tomorrow: "https://cdn.jsdelivr.net/npm/prismjs@1/themes/prism-tomorrow.min.css",
	okaidia: "https://cdn.jsdelivr.net/npm/prismjs@1/themes/prism-okaidia.min.css",
	"tomorrow-night": "https://cdn.jsdelivr.net/npm/prismjs@1/themes/prism-tomorrow.min.css",
	nord: "https://cdn.jsdelivr.net/npm/prism-themes@1/themes/prism-nord.min.css",
	dracula: "https://cdn.jsdelivr.net/npm/prism-themes@1/themes/prism-dracula.min.css",
	"one-dark": "https://cdn.jsdelivr.net/npm/prism-themes@1/themes/prism-one-dark.min.css",
	synthwave84: "https://cdn.jsdelivr.net/npm/prism-themes@1/themes/prism-synthwave84.min.css",
};

// Simple YAML parser for theme files (reuses pattern from dev.ts)
function parseThemeYaml(content: string): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	const lines = content.split("\n");
	const stack: { obj: Record<string, unknown>; indent: number }[] = [{ obj: result, indent: -2 }];

	for (const line of lines) {
		if (line.trim().startsWith("#") || line.trim() === "") continue;

		const indent = line.search(/\S/);
		const trimmed = line.trim();

		while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
			stack.pop();
		}

		const colonIndex = trimmed.indexOf(":");
		if (colonIndex > 0) {
			const key = trimmed.slice(0, colonIndex).trim();
			const value = trimmed.slice(colonIndex + 1).trim();
			const parent = stack[stack.length - 1].obj;

			if (value === "") {
				const nested: Record<string, unknown> = {};
				parent[key] = nested;
				stack.push({ obj: nested, indent });
			} else {
				// Strip quotes
				let v = value;
				if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
					v = v.slice(1, -1);
				}
				parent[key] = v;
			}
		}
	}

	return result;
}

// Load theme from file with fallback to defaults
export async function loadTheme(root: string): Promise<Theme> {
	try {
		const content = await readFile(join(root, "theme.yaml"), "utf-8");
		const parsed = parseThemeYaml(content);
		return deepMerge(DEFAULT_THEME, parsed as Partial<Theme>) as Theme;
	} catch {
		return DEFAULT_THEME;
	}
}

// Deep merge utility
function deepMerge(target: unknown, source: unknown): unknown {
	if (typeof target !== "object" || target === null) return source;
	if (typeof source !== "object" || source === null) return source;

	const result = { ...(target as Record<string, unknown>) };
	for (const key of Object.keys(source as Record<string, unknown>)) {
		const sourceVal = (source as Record<string, unknown>)[key];
		const targetVal = result[key];
		if (
			typeof sourceVal === "object" &&
			sourceVal !== null &&
			typeof targetVal === "object" &&
			targetVal !== null
		) {
			result[key] = deepMerge(targetVal, sourceVal);
		} else if (sourceVal !== undefined) {
			result[key] = sourceVal;
		}
	}
	return result;
}

// Generate CSS from theme
export function generateThemeCSS(theme: Theme): string {
	const light = theme.colors.light;
	const dark = theme.colors.dark;
	const typo = theme.typography ?? DEFAULT_THEME.typography ?? {};
	const layout = theme.layout ?? DEFAULT_THEME.layout ?? {};

	const fontSans = FONT_STACKS[typo.body || "system"];
	const fontHeadings = FONT_STACKS[typo.headings || "system"];
	const fontMono = FONT_STACKS.mono;
	const baseSize = typo.baseSize || "16px";
	const sidebarWidth = layout.sidebarWidth || "280px";

	// Map theme colors to CSS variables
	const lightVars = `
    --color-bg: ${light.background};
    --color-bg-sidebar: ${light.surface};
    --color-text: ${light.text};
    --color-text-muted: ${light.textMuted || light.text};
    --color-border: ${light.border};
    --color-link: ${light.primary};
    --color-link-hover: ${light.primaryHover || light.primary};
    --color-accent: ${light.heading};
    --color-code-bg: ${light.surface};
    --color-logo: ${light.heading};
    --sidebar-width: ${sidebarWidth};
    --font-sans: ${fontSans};
    --font-headings: ${fontHeadings};
    --font-mono: ${fontMono};
  `.trim();

	const darkVars = `
    --color-bg: ${dark.background};
    --color-bg-sidebar: ${dark.surface};
    --color-text: ${dark.text};
    --color-text-muted: ${dark.textMuted || dark.text};
    --color-border: ${dark.border};
    --color-link: ${dark.primary};
    --color-link-hover: ${dark.primaryHover || dark.primary};
    --color-accent: ${dark.heading};
    --color-code-bg: ${dark.surface};
    --color-logo: ${dark.heading};
  `.trim();

	return `<style id="kitfly-theme">
  :root { ${lightVars} }
  html { font-size: ${baseSize}; }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) { ${darkVars} }
  }
  [data-theme="dark"] { ${darkVars} }
  [data-theme="light"] { ${lightVars} }
</style>`;
}

// Get Prism theme URLs
export function getPrismUrls(theme: Theme): { light: string; dark: string } {
	const code = theme.code ?? DEFAULT_THEME.code ?? {};
	return {
		light: PRISM_THEMES[code.light || "default"] || PRISM_THEMES.default,
		dark: PRISM_THEMES[code.dark || "okaidia"] || PRISM_THEMES.okaidia,
	};
}
