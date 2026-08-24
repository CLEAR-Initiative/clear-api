/**
 * Shared chrome for unauthenticated card pages (login, reset/setup password).
 * Uses the marketing theme so these pages keep their existing brighter orange.
 */

import { renderIconLinks } from "./icons.js";
import { renderFontLinks, renderThemeRoot, THEMES } from "./theme.js";

export function renderAuthPageStyles(opts?: { prose?: boolean }): string {
  const prose = opts?.prose
    ? `
    .card p { line-height: 1.5; }`
    : "";

  return `<style>
    ${renderThemeRoot("marketing")}
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: var(--font); background: var(--color-bg); color: var(--color-text); display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { background: var(--color-surface); border: 1px solid var(--color-border); border-radius: 12px; padding: 2rem; width: 380px; }
    .card h1 { font-size: 1.25rem; margin-bottom: 0.25rem; }
    .card p { font-size: 0.85rem; color: var(--color-muted); margin-bottom: 1.5rem; }${prose}
    label { display: block; font-size: 0.8rem; color: var(--color-muted); margin-bottom: 0.25rem; }
    input { width: 100%; padding: 0.5rem 0.75rem; border-radius: 8px; border: 1px solid var(--color-border); background: var(--color-code-bg); color: var(--color-text); font-size: 0.875rem; margin-bottom: 1rem; font-family: inherit; }
    input:focus { outline: none; border-color: var(--color-accent); }
    button { width: 100%; padding: 0.6rem; background: var(--color-accent); color: var(--on-accent); border: none; border-radius: 8px; font-size: 0.875rem; cursor: pointer; font-family: inherit; font-weight: 600; }
    button:hover { background: var(--color-accent-hover); }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .error { color: var(--color-danger); font-size: 0.8rem; margin-top: 0.75rem; min-height: 1.2em; }
    .notice { color: var(--color-success); font-size: 0.8rem; margin-top: 0.25rem; line-height: 1.4; }
    .toggle { text-align: center; font-size: 0.8rem; color: var(--color-muted); margin-top: 1.25rem; }
    .toggle a { color: var(--color-accent); text-decoration: none; }
    .toggle a:hover { text-decoration: underline; }
  </style>`;
}

export function renderAuthPageHead(opts: {
  title: string;
  extraMeta?: string;
  prose?: boolean;
}): string {
  const extra = opts.extraMeta ? `\n  ${opts.extraMeta}` : "";
  return `<meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${opts.title}</title>
  ${renderIconLinks()}
  <meta name="theme-color" content="${THEMES.marketing.colorBg}">${extra}
  ${renderFontLinks()}
  ${renderAuthPageStyles({ prose: opts.prose })}`;
}

export function renderWaitingPageStyles(): string {
  return `<style>
    ${renderThemeRoot("marketing")}
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: var(--font); background: var(--color-bg); color: var(--color-text); line-height: 1.6; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 2rem; }
    .card { max-width: 480px; width: 100%; background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius); padding: 2.5rem; text-align: center; }
    .badge { display: inline-block; padding: 0.3rem 0.75rem; border-radius: 999px; background: #2a1f0a; color: var(--color-warning); font-size: 0.72rem; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; margin-bottom: 1.25rem; }
    h1 { font-size: 1.4rem; margin-bottom: 0.75rem; }
    p { color: var(--color-muted); font-size: 0.95rem; margin-bottom: 1rem; }
    .email { color: var(--color-text); font-weight: 500; }
    .signout { margin-top: 1.5rem; display: inline-block; color: var(--color-muted); font-size: 0.85rem; text-decoration: underline; cursor: pointer; background: none; border: none; font-family: var(--font); }
    .signout:hover { color: var(--color-text); }
    .docs-link { color: var(--color-accent); text-decoration: underline; }
    .docs-link:hover { color: var(--color-text); }
  </style>`;
}
