/**
 * Shared visual tokens for HTML surfaces (portal, admin, docs, home, auth).
 *
 * Two themes, one name set (`--color-*`). Marketing pages also emit legacy
 * aliases (`--bg`, `--accent`, …) so existing home CSS stays pixel-identical.
 *
 * Do not collapse these themes: portal chrome uses a darker burnt orange on
 * near-black, marketing/auth uses a brighter orange on #0a0a0b.
 */

export type ThemeName = "portal" | "marketing";

const FONT =
  "'Inter', ui-sans-serif, -apple-system, BlinkMacSystemFont, \"Helvetica Neue\", Arial, sans-serif";
const FONT_MONO =
  "'JetBrains Mono', \"SF Mono\", \"Fira Code\", ui-monospace, Consolas, monospace";

export const THEMES = {
  portal: {
    colorBg: "#0a0a0a",
    colorSurface: "#0d0d0d",
    colorSurface2: "#111111",
    colorSurface3: "#141414",
    colorBorder: "#1f1f1f",
    colorBorder2: "#222222",
    colorAccent: "#c2410c",
    colorAccentHover: "#d14a12",
    colorAccentBorder: "#7c2d12",
    colorAccentSoft: "rgba(194, 65, 12, 0.12)",
    colorText: "#ffffff",
    colorMuted: "#999999",
    colorLabel: "#666666",
    colorSection: "#444444",
    onAccent: "#fff7ed",
    colorSuccess: "#22c55e",
    colorDanger: "#ef4444",
    colorWarning: "#f59e0b",
    colorCodeBg: "#0e0e10",
    colorYellow: "#fbbf24",
    colorRed: "#f87171",
    radius: "12px",
    radiusSm: "6px",
    font: FONT,
    fontMono: FONT_MONO,
  },
  marketing: {
    colorBg: "#0a0a0b",
    colorSurface: "#141417",
    colorSurface2: "#1b1b1f",
    colorSurface3: "#141414",
    colorBorder: "#26262b",
    colorBorder2: "#3a3a42",
    colorAccent: "#f2612a",
    colorAccentHover: "#ff6a33",
    colorAccentBorder: "#f2612a",
    colorAccentSoft: "rgba(242, 97, 42, 0.12)",
    colorText: "#f5f5f6",
    colorMuted: "#9a9ca3",
    colorLabel: "#75777e",
    colorSection: "#444444",
    onAccent: "#0a0a0b",
    colorSuccess: "#4ade80",
    colorDanger: "#ef4444",
    colorWarning: "#f59e0b",
    colorCodeBg: "#0e0e10",
    colorYellow: "#fbbf24",
    colorRed: "#f87171",
    radius: "10px",
    radiusSm: "6px",
    font: FONT,
    fontMono: FONT_MONO,
  },
} as const;

export const FONT_STYLESHEET_HREF =
  "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap";

export function renderFontLinks(opts?: { mono?: boolean }): string {
  const href =
    opts?.mono === false
      ? "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap"
      : FONT_STYLESHEET_HREF;
  return `<link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="${href}" rel="stylesheet">`;
}

function emitVars(theme: ThemeName): string {
  const t = THEMES[theme];
  return `      --color-bg: ${t.colorBg};
      --color-surface: ${t.colorSurface};
      --color-surface-2: ${t.colorSurface2};
      --color-surface-3: ${t.colorSurface3};
      --color-border: ${t.colorBorder};
      --color-border-2: ${t.colorBorder2};
      --color-accent: ${t.colorAccent};
      --color-accent-hover: ${t.colorAccentHover};
      --color-accent-border: ${t.colorAccentBorder};
      --color-accent-soft: ${t.colorAccentSoft};
      --color-text: ${t.colorText};
      --color-muted: ${t.colorMuted};
      --color-label: ${t.colorLabel};
      --color-section: ${t.colorSection};
      --on-accent: ${t.onAccent};
      --color-success: ${t.colorSuccess};
      --color-danger: ${t.colorDanger};
      --color-warning: ${t.colorWarning};
      --color-code-bg: ${t.colorCodeBg};
      --radius: ${t.radius};
      --radius-sm: ${t.radiusSm};
      --font: ${t.font};
      --font-mono: ${t.fontMono};`;
}

/** Legacy home names — same computed values as today. */
function emitMarketingAliases(): string {
  return `
      --bg: var(--color-bg);
      --surface: var(--color-surface);
      --surface-2: var(--color-surface-2);
      --border: var(--color-border);
      --border-hover: var(--color-border-2);
      --accent: var(--color-accent);
      --accent-hover: var(--color-accent-hover);
      --text: var(--color-text);
      --muted: var(--color-muted);
      --label: var(--color-label);
      --code-bg: var(--color-code-bg);
      --mono: var(--font-mono);
      --green: var(--color-success);
      --yellow: ${THEMES.marketing.colorYellow};
      --red: ${THEMES.marketing.colorRed};`;
}

export function renderThemeCustomProperties(theme: ThemeName): string {
  const aliases = theme === "marketing" ? emitMarketingAliases() : "";
  return `${emitVars(theme)}${aliases}`;
}

export function renderThemeRoot(theme: ThemeName): string {
  return `:root {
${renderThemeCustomProperties(theme)}
    }`;
}

/**
 * Scoped tokens for the home `.apisec` block. Values match the previous
 * inline palette (slightly different neutrals than the page `--bg`).
 */
export function renderApisecThemeProperties(): string {
  return `--bg:#0a0a0a; --bg-2:#111111; --bg-3:#161616;
      --line:#212121; --line-2:#2c2c2c;
      --ink:#f4f4f3; --ink-2:#b8b8b6; --ink-3:#7a7a78; --ink-4:#4a4a48;
      --orange:#f2612a; --orange-2:#ff6a33;
      --orange-dim:rgba(242,97,42,.13); --orange-line:rgba(242,97,42,.4);`;
}
