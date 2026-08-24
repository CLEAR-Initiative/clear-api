/**
 * Shared Portal Shell module
 *
 * Provides unified chrome for /portal, /portal/admin, and /docs surfaces.
 * Includes brand, nav (Menu + Resources + optional Admin), collapse, mobile drawer,
 * optional Account footer, and one-click sign out.
 */

import { createRequire } from "node:module";
import { renderThemeCustomProperties } from "../ui/theme.js";
import {
  renderPortalControlScript,
  renderPortalControlStyles,
} from "./controls.js";

const require = createRequire(import.meta.url);
const PORTAL_VERSION = (require("../../package.json") as { version: string }).version;

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderPortalToast(flash: {
  kind: "success" | "error";
  message: string;
}): string {
  const kind = flash.kind === "error" ? "error" : "success";
  return `<div class="portal-toast portal-toast--${kind}" role="status" aria-live="polite">${escapeHtml(flash.message)}</div>`;
}

const PORTAL_ICON_BASE = "/portal/icons";

export const PORTAL_SVGS = {
  rocket:
    '<svg class="nav-icon-img" viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M7 .5C5.35 2.6 4.5 4.85 4.5 7c0 1.15.25 2.2.7 3H3.25L1.75 12h3.1v1.5h4.3V12h3.1L10.75 10H8.8c.45-.8.7-1.85.7-3 0-2.15-.85-4.4-2.5-6.5ZM7 4.25A1.25 1.25 0 1 1 7 6.75 1.25 1.25 0 0 1 7 4.25Z"/></svg>',
  key: '<svg class="nav-icon-img" viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M9.188 9.625A4.812 4.812 0 1 0 4.602 6.28L.192 10.691a.656.656 0 0 0 0 .928.656.656 0 0 0 .465.193H2.844a.656.656 0 0 0 .656-.656V12.25h1.094a.656.656 0 0 0 .656-.656v-1.094h1.094c.175 0 .342-.068.465-.191l.91-.911a4.77 4.77 0 0 0 1.469.227Zm1.094-7a1.094 1.094 0 1 1-2.188 0 1.094 1.094 0 0 1 2.188 0Z"/></svg>',
  shield:
    '<svg class="nav-icon-img" viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M7 0c.126 0 .252.027.366.079l5.149 2.185c.602.254 1.05.847 1.047 1.564-.014 2.712-1.129 7.675-5.84 9.931a1.75 1.75 0 0 1-1.444 0C1.567 11.504.451 6.54.438 3.828.435 3.112.883 2.518 1.485 2.264L6.636.08A.75.75 0 0 1 7 0Zm0 1.827v10.336C10.773 10.336 11.788 6.292 11.813 3.866L7 1.827Z"/></svg>',
  lock: '<svg class="nav-icon-img" viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M7 0a3.5 3.5 0 0 0-3.5 3.5V5H2.75A1.75 1.75 0 0 0 1 6.75v5.5C1 13.216 1.784 14 2.75 14h8.5A1.75 1.75 0 0 0 13 12.25v-5.5A1.75 1.75 0 0 0 11.25 5H10.5V3.5A3.5 3.5 0 0 0 7 0Zm2 5H5V3.5a2 2 0 1 1 4 0V5Z"/></svg>',
  doc: '<svg class="nav-icon-img" viewBox="0 0 12.25 14" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M2.625 0C1.176 0 0 1.176 0 2.625v8.75C0 12.824 1.176 14 2.625 14h8.75c.484 0 .875-.391.875-.875a.875.875 0 0 0-.875-.875V10.5c.484 0 .875-.391.875-.875V.875A.875.875 0 0 0 11.375 0H2.625Zm0 10.5h7v1.75H2.625a.875.875 0 0 1-.875-.875c0-.484.391-.875.875-.875ZM3.5 3.938c0-.24.197-.438.438-.438h5.25a.438.438 0 0 1 0 .875h-5.25a.438.438 0 0 1-.438-.437Zm0 1.312a.438.438 0 0 0 0 .875h5.25a.438.438 0 0 0 0-.875h-5.25Z"/></svg>',
  chart:
    '<svg class="nav-icon-img" viewBox="0 0 12.25 14" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M4.375 2.188C4.375 1.463 4.963.875 5.688.875h.875C7.287.875 7.875 1.463 7.875 2.188v9.625c0 .725-.588 1.312-1.313 1.312h-.875c-.725 0-1.312-.587-1.312-1.312V2.188ZM0 7.438C0 6.713.588 6.125 1.313 6.125h.875C2.912 6.125 3.5 6.713 3.5 7.438v4.375c0 .725-.588 1.312-1.313 1.312h-.875C.588 13.125 0 12.537 0 11.812V7.438Zm10.063 2.625h.875c.725 0 1.312.588 1.312 1.313v4.375c0 .725-.587 1.312-1.312 1.312h-.875c-.725 0-1.313-.587-1.313-1.312V3.938c0-.725.588-1.313 1.313-1.313Z"/></svg>',
  sandbox:
    '<svg class="nav-icon-img" viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="M1 1h12v12H1V1Zm1.5 1.5v9h9v-9h-9Z" clip-rule="evenodd"/></svg>',
  signout:
    '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path fill="currentColor" d="M11.78 6.53a.75.75 0 0 0 0-1.06L8.78 2.47a.75.75 0 1 0-1.06 1.06L9.44 5.25H4.5a.75.75 0 0 0 0 1.5h4.94l-1.72 1.72a.75.75 0 1 0 1.06 1.06l3-3ZM3.75 2.25a.75.75 0 0 0 0-1.5H2.25A2.25 2.25 0 0 0 0 3v6a2.25 2.25 0 0 0 2.25 2.25H3.75a.75.75 0 0 0 0-1.5H2.25a.75.75 0 0 1-.75-.75V3a.75.75 0 0 1 .75-.75H3.75Z"/></svg>',
  hamburger:
    '<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><path fill="currentColor" d="M2 4h16v2H2V4zm0 5h16v2H2V9zm0 5h16v2H2v-2z"/></svg>',
  close:
    '<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><path fill="currentColor" d="M10 8.586l4.293-4.293 1.414 1.414L11.414 10l4.293 4.293-1.414 1.414L10 11.414l-4.293 4.293-1.414-1.414L8.586 10 4.293 5.707l1.414-1.414L10 8.586z"/></svg>',
  search:
    '<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><path fill="currentColor" d="M8 2a6 6 0 104.472 10.025l4.244 4.243 1.414-1.414-4.243-4.244A6 6 0 008 2zm0 2a4 4 0 110 8 4 4 0 010-8z"/></svg>',
} as const;

const PORTAL_ASSETS = {
  logo: "clearapi_logo.png",
} as const;

function generateAvatarHtml(email: string): string {
  const initials = email
    .split("@")[0]
    .substring(0, 2)
    .toUpperCase();
  
  return `<div class="user-avatar" style="background: #FF5C00; color: white; display: flex; align-items: center; justify-content: center; font-weight: 600; font-size: 13px; width: 32px; height: 32px; border-radius: 9999px; border: 1px solid #333; flex-shrink: 0;">${initials}</div>`;
}

function formatAccountLabel(role?: string | null): string {
  switch (role) {
    case "admin":
      return "Admin Account";
    case "analyst":
      return "Analyst Account";
    case "viewer":
      return "Viewer Account";
    default:
      return "Developer Account";
  }
}

function portalNavButton(tab: string, label: string, icon: keyof typeof PORTAL_SVGS): string {
  // JSON.stringify + HTML-escape so tab never breaks out of the attribute/JS string.
  const onclick = `showTab(${JSON.stringify(tab)})`
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;");
  return `<button type="button" class="nav-item" data-tab="${escapeHtml(tab)}" title="${escapeHtml(label)}" onclick="${onclick}">${PORTAL_SVGS[icon]}<span class="nav-label">${escapeHtml(label)}</span></button>`;
}

function portalNavLink(href: string, label: string, icon: keyof typeof PORTAL_SVGS, isActive = false, openInNewTab = false): string {
  const targetAttr = openInNewTab ? ' target="_blank" rel="noopener noreferrer"' : '';
  const activeClass = isActive ? ' active' : '';
  return `<a href="${href}" class="nav-item nav-item--link${activeClass}" title="${escapeHtml(label)}"${targetAttr}>${PORTAL_SVGS[icon]}<span class="nav-label">${escapeHtml(label)}</span></a>`;
}

export interface PortalShellOptions {
  /** Which surface is using the shell: portal (tab buttons), docs/admin (links) */
  surface: "portal" | "docs" | "admin";
  /** Account info (email + role); null for anonymous */
  account: { email: string; role?: string | null } | null;
  /** Optional href to mark as active (for docs/admin link highlighting) */
  activeHref?: string;
}

/**
 * Render shared Portal Shell styles (CSS variables + sidebar + mobile drawer)
 */
export function renderPortalShellStyles(): string {
  return `  <style>
    :root {
${renderThemeCustomProperties("portal")}
      --sidebar-width: 288px;
      --sidebar-width-collapsed: 72px;
      --control-height: 2.5rem;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: var(--font); background: var(--color-bg); color: var(--color-text); line-height: 1.6; min-height: 100vh; -webkit-font-smoothing: antialiased; }
    a { color: var(--color-accent); text-decoration: none; }
    code { font-family: var(--font-mono); font-size: 0.8rem; color: var(--color-text); }

    /* Portal shell layout */
    .portal-shell { display: flex; min-height: 100vh; }

    /* Sidebar (desktop) */
    .sidebar {
      width: var(--sidebar-width); flex-shrink: 0; background: var(--color-surface);
      border-right: 1px solid var(--color-border); display: flex; flex-direction: column;
      justify-content: space-between;
      height: 100vh;
      position: sticky;
      top: 0;
      transition: width 0.25s cubic-bezier(0.4, 0, 0.2, 1);
      overflow: hidden;
      z-index: 100;
    }
    .portal-shell.sidebar-collapsed .sidebar { 
      width: var(--sidebar-width-collapsed); 
      justify-content: flex-start;
      /* Let the edge chevron paint into main content. overflow:hidden
         on .sidebar/.sidebar-top clips it regardless of z-index. */
      overflow: visible;
      z-index: 200;
    }
    
    .sidebar-top {
      padding: 32px 32px 0;
      display: flex;
      flex-direction: column;
      gap: 48px;
      overflow-y: auto;
      overflow-x: hidden;
      flex: 1;
      min-height: 0;
      transition: padding 0.25s cubic-bezier(0.4, 0, 0.2, 1), gap 0.25s cubic-bezier(0.4, 0, 0.2, 1);
      scrollbar-width: thin;
      scrollbar-color: transparent transparent;
    }
    .sidebar-top:hover {
      scrollbar-color: var(--color-border) transparent;
    }
    .sidebar-top::-webkit-scrollbar {
      width: 6px;
    }
    .sidebar-top::-webkit-scrollbar-track {
      background: transparent;
    }
    .sidebar-top::-webkit-scrollbar-thumb {
      background: transparent;
      border-radius: 3px;
    }
    .sidebar-top:hover::-webkit-scrollbar-thumb {
      background: var(--color-border);
    }
    .portal-shell.sidebar-collapsed .sidebar-top {
      /* Tighter left inset than expanded (32px → 12px). Icons stay
         flex-start so they ease left with padding, not with width. */
      padding: 32px 12px 0;
      overflow: visible;
    }
    
    .sidebar-brand {
      display: flex; 
      align-items: center; 
      gap: 12px;
      flex-shrink: 0;
      position: relative;
      /* Two-line brand text is taller than the 36px logo; lock the
         row so taking .brand-text out of flow does not lift the nav. */
      min-height: 44px;
    }
    .brand-logo-img {
      flex-shrink: 0;
      border-radius: 8px;
    }
    .portal-shell.sidebar-collapsed .sidebar-brand {
      /* Toggle is position:absolute; keep the brand from becoming its
         containing block so right is relative to the sidebar edge.
         Stay left-aligned so the logo does not slide as width animates. */
      position: static;
    }
    .brand-text {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
      transition: opacity 0.2s cubic-bezier(0.4, 0, 0.2, 1);
    }
    .brand-title {
      font-size: 15px;
      font-weight: 700;
      letter-spacing: -0.02em;
      color: var(--color-text);
      white-space: nowrap;
    }
    .brand-sub {
      font-size: 11px;
      color: var(--color-label);
      font-weight: 500;
      white-space: nowrap;
    }
    .portal-shell.sidebar-collapsed .brand-text {
      opacity: 0;
      pointer-events: none;
      position: absolute;
    }
    .sidebar-toggle {
      background: none;
      border: none;
      color: var(--color-muted);
      cursor: pointer;
      padding: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 6px;
      transition: transform 0.25s cubic-bezier(0.4, 0, 0.2, 1), background 0.15s, color 0.15s, right 0.25s cubic-bezier(0.4, 0, 0.2, 1);
      margin-left: auto;
      flex-shrink: 0;
      position: relative;
    }
    .sidebar-toggle:hover {
      background: var(--color-surface-2);
      color: var(--color-text);
    }
    .portal-shell.sidebar-collapsed .sidebar-toggle {
      position: absolute;
      top: 24px;
      right: -14px;
      margin-left: 0;
      transform: rotate(180deg);
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      /* Above .main / admin tabs (later in the DOM); below modals (300). */
      z-index: 250;
    }
    .nav-section + .nav-section,
    .nav-list .nav-section:not(:first-child) {
      margin-top: 18px;
    }
    .nav-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .nav-section {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--color-section);
      padding: 8px 12px 4px;
      transition: opacity 0.2s cubic-bezier(0.4, 0, 0.2, 1);
    }
    .portal-shell.sidebar-collapsed .nav-section {
      opacity: 0;
      pointer-events: none;
      overflow: hidden;
      white-space: nowrap;
    }
    .nav-item {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 10px 12px;
      /* 10px+10px padding + 14px label line-height (1.6 × 14px). Keeps
         the row from shrinking when .nav-label is taken out of flow. */
      min-height: calc(20px + 1.6em);
      border-radius: 8px;
      color: var(--color-muted);
      background: transparent;
      border: none;
      cursor: pointer;
      font-family: var(--font);
      font-size: 14px;
      transition: background 0.15s, color 0.15s;
      text-decoration: none;
      position: relative;
      width: 100%;
      text-align: left;
    }
    .nav-item:hover {
      background: var(--color-surface-2);
      color: var(--color-text);
    }
    .nav-item.active {
      background: var(--color-accent-soft);
      color: var(--color-accent);
    }
    .nav-icon-img {
      flex-shrink: 0;
      display: block;
      width: 14px;
      height: 14px;
    }
    .nav-label {
      white-space: nowrap;
      transition: opacity 0.2s cubic-bezier(0.4, 0, 0.2, 1);
    }
    .portal-shell.sidebar-collapsed .nav-label {
      opacity: 0;
      pointer-events: none;
      position: absolute;
    }
    .sidebar-footer {
      padding: 16px 20px 6px;
      border-top: 1px solid var(--color-border);
      display: flex;
      flex-direction: column;
      gap: 12px;
      flex-shrink: 0;
      transition: padding 0.25s cubic-bezier(0.4, 0, 0.2, 1);
    }
    .portal-shell.sidebar-collapsed .sidebar-footer {
      padding: 16px 12px 6px;
    }
    .user-card {
      display: flex;
      align-items: center;
      gap: 12px;
      min-width: 0;
    }
    .user-details {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
      flex: 1;
      transition: opacity 0.2s cubic-bezier(0.4, 0, 0.2, 1);
    }
    .portal-shell.sidebar-collapsed .user-card {
      justify-content: flex-start;
    }
    .user-avatar {
      flex-shrink: 0;
    }
    .portal-shell.sidebar-collapsed .user-details {
      opacity: 0;
      pointer-events: none;
      position: absolute;
    }
    .user-email {
      font-size: 13px;
      font-weight: 500;
      color: var(--color-text);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .user-role {
      font-size: 11px;
      color: var(--color-label);
      white-space: nowrap;
    }
    .signout-btn {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      background: transparent;
      border: 1px solid var(--color-border);
      border-radius: 6px;
      color: var(--color-muted);
      cursor: pointer;
      font-family: var(--font);
      font-size: 13px;
      transition: all 0.15s;
      justify-content: center;
    }
    .signout-btn:hover {
      background: var(--color-surface-2);
      border-color: var(--color-border-2);
      color: var(--color-text);
    }
    a.signin-link {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 8px 12px;
      background: var(--color-accent);
      border: 1px solid var(--color-accent-border);
      border-radius: 6px;
      color: var(--on-accent);
      font-family: var(--font);
      font-size: 13px;
      font-weight: 600;
      text-decoration: none;
    }
    a.signin-link:hover {
      background: var(--color-accent-hover);
      color: var(--on-accent);
      text-decoration: none;
    }
    .portal-shell.sidebar-collapsed a.signin-link .signin-label {
      opacity: 0;
      position: absolute;
      pointer-events: none;
    }
    .portal-shell.sidebar-collapsed .signout-btn {
      padding: 8px;
      width: 40px;
    }
    .signout-label {
      white-space: nowrap;
      transition: opacity 0.2s cubic-bezier(0.4, 0, 0.2, 1);
    }
    .portal-shell.sidebar-collapsed .signout-label {
      opacity: 0;
      pointer-events: none;
      position: absolute;
    }

    /* Mobile hamburger button (hidden on desktop) */
    .mobile-menu-btn {
      display: none;
      position: fixed;
      top: 16px;
      right: 16px;
      z-index: 200;
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: 8px;
      padding: 10px;
      color: var(--color-text);
      cursor: pointer;
    }
    .mobile-menu-btn:hover {
      background: var(--color-surface-2);
    }
    
    /* System status in sidebar — mobile menu only (desktop uses main-header pill) */
    .system-status-inline {
      display: none;
      padding: 8px 16px;
      margin: auto 16px 8px 16px;
      background: transparent;
      border: 1px solid rgba(34, 197, 94, 0.3);
      border-radius: 20px;
      font-size: 0.75rem;
      color: rgba(34, 197, 94, 1);
      align-items: center;
      gap: 8px;
      justify-content: center;
    }
    
    .status-dot {
      width: 6px;
      height: 6px;
      background: rgba(34, 197, 94, 1);
      border-radius: 50%;
      display: inline-block;
      animation: pulse 2s infinite;
      flex-shrink: 0;
    }
    
    .status-text {
      transition: opacity 0.2s cubic-bezier(0.4, 0, 0.2, 1);
    }
    
    /* When sidebar is collapsed, hide text and show only dot */
    .portal-shell.sidebar-collapsed .system-status-inline {
      justify-content: center;
      padding: 8px;
      gap: 0;
    }
    
    .portal-shell.sidebar-collapsed .status-text {
      opacity: 0;
      position: absolute;
      pointer-events: none;
    }
    
    /* Version indicator */
    .version-indicator {
      text-align: center;
      font-size: 0.65rem;
      color: var(--color-muted);
      margin: 2px 16px 12px 16px;
      padding: 0;
    }
    
    .portal-shell.sidebar-collapsed .version-indicator {
      opacity: 0;
      position: absolute;
      pointer-events: none;
    }
    
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }
    
    /* Mobile drawer overlay */
    .mobile-drawer-overlay {
      display: none;
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.7);
      z-index: 150;
      opacity: 0;
      transition: opacity 0.25s ease;
    }
    .mobile-drawer-overlay.active {
      opacity: 1;
    }

    /* Mobile: drawer overlay mode */
    @media (max-width: 768px) {
      .system-status-inline {
        display: flex;
      }
      .mobile-menu-btn {
        display: flex;
        align-items: center;
        justify-content: center;
      }
      body.modal-open .mobile-menu-btn {
        display: none;
      }
      .sidebar {
        position: fixed;
        top: 0;
        left: 0;
        height: 100vh;
        transform: translateX(-100%);
        transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        width: 280px;
        z-index: 160;
        display: flex;
        flex-direction: column;
      }
      .sidebar.mobile-open {
        transform: translateX(0);
      }
      .mobile-drawer-overlay {
        display: block;
      }
      .sidebar-top {
        flex: 1;
        padding: 20px;
        gap: 16px;
      }
      .sidebar-toggle {
        display: none;
      }
      .portal-shell.sidebar-collapsed .sidebar {
        width: 280px;
        transform: translateX(-100%);
        overflow: hidden;
        z-index: 160;
      }
      .portal-shell.sidebar-collapsed .sidebar.mobile-open {
        transform: translateX(0);
      }
      .portal-shell.sidebar-collapsed .sidebar-top,
      .portal-shell.sidebar-collapsed .brand-text,
      .portal-shell.sidebar-collapsed .nav-label,
      .portal-shell.sidebar-collapsed .user-details,
      .portal-shell.sidebar-collapsed .signout-label {
        opacity: 1;
        pointer-events: auto;
        position: static;
      }
      .portal-shell.sidebar-collapsed .sidebar-top {
        padding: 20px;
        gap: 16px;
      }
      .portal-shell.sidebar-collapsed .nav-item {
        justify-content: flex-start;
        padding: 10px 12px;
      }
      .portal-shell.sidebar-collapsed .signout-btn {
        padding: 8px 12px;
        width: auto;
        justify-content: center;
      }
      .portal-shell.sidebar-collapsed .nav-section {
        opacity: 1;
        pointer-events: auto;
        overflow: visible;
      }
      .portal-shell.sidebar-collapsed .sidebar-footer {
        padding: 16px 20px 6px;
        align-items: stretch;
      }
    }

    .portal-toast {
      position: fixed;
      right: max(1.25rem, env(safe-area-inset-right));
      bottom: max(1.25rem, env(safe-area-inset-bottom));
      z-index: 400;
      max-width: min(22rem, calc(100vw - 2rem));
      padding: 0.75rem 1rem;
      border-radius: var(--radius);
      font-size: 0.875rem;
      font-weight: 500;
      line-height: 1.4;
      box-shadow: 0 16px 40px rgba(0, 0, 0, 0.5);
      pointer-events: none;
      animation: portal-toast-in 0.28s cubic-bezier(0.4, 0, 0.2, 1);
    }
    .portal-toast--success {
      background: #0d2818;
      border: 1px solid var(--color-success);
      color: var(--color-success);
    }
    .portal-toast--error {
      background: #2a0c0c;
      border: 1px solid var(--color-danger);
      color: var(--color-danger);
    }
    .portal-toast.is-leaving {
      animation: portal-toast-out 0.28s cubic-bezier(0.4, 0, 0.2, 1) forwards;
    }
    @keyframes portal-toast-in {
      from { opacity: 0; transform: translate3d(12px, 16px, 0); }
      to { opacity: 1; transform: translate3d(0, 0, 0); }
    }
    @keyframes portal-toast-out {
      from { opacity: 1; transform: translate3d(0, 0, 0); }
      to { opacity: 0; transform: translate3d(8px, 12px, 0); }
    }
    @media (prefers-reduced-motion: reduce) {
      .portal-toast,
      .portal-toast.is-leaving {
        animation: none;
      }
    }
    ${renderPortalControlStyles()}
  </style>`;
}

/**
 * Render shared Portal Shell script (collapse, mobile drawer, sign out)
 */
export function renderPortalShellScript(): string {
  return `<script>
    // Load collapsed state from localStorage (default: expanded)
    (function() {
      const collapsed = localStorage.getItem('sidebar-collapsed') === 'true';
      if (collapsed) {
        document.getElementById('portal-shell').classList.add('sidebar-collapsed');
      }
      // Sidebar is expanded by default (no initial class needed)
    })();

    function toggleSidebar() {
      const shell = document.getElementById('portal-shell');
      if (shell) {
        shell.classList.toggle('sidebar-collapsed');
        const isCollapsed = shell.classList.contains('sidebar-collapsed');
        localStorage.setItem('sidebar-collapsed', isCollapsed ? 'true' : 'false');
      }
    }

    // Mobile drawer controls
    function toggleMobileDrawer() {
      const sidebar = document.querySelector('.sidebar');
      const overlay = document.querySelector('.mobile-drawer-overlay');
      const isOpen = sidebar && sidebar.classList.contains('mobile-open');
      
      if (isOpen) {
        closeMobileDrawer();
      } else {
        openMobileDrawer();
      }
    }
    
    function openMobileDrawer() {
      const sidebar = document.querySelector('.sidebar');
      const overlay = document.querySelector('.mobile-drawer-overlay');
      if (sidebar) sidebar.classList.add('mobile-open');
      if (overlay) overlay.classList.add('active');
    }

    function closeMobileDrawer() {
      const sidebar = document.querySelector('.sidebar');
      const overlay = document.querySelector('.mobile-drawer-overlay');
      if (sidebar) sidebar.classList.remove('mobile-open');
      if (overlay) overlay.classList.remove('active');
    }

    // Close drawer when clicking overlay
    document.addEventListener('DOMContentLoaded', function() {
      const overlay = document.querySelector('.mobile-drawer-overlay');
      if (overlay) {
        overlay.addEventListener('click', closeMobileDrawer);
      }
      
      // Close drawer when clicking any nav link
      const navLinks = document.querySelectorAll('.nav-item');
      navLinks.forEach(function(link) {
        link.addEventListener('click', function() {
          if (window.innerWidth <= 768) {
            closeMobileDrawer();
          }
        });
      });
    });
    
    // Better Auth only accepts POST on /api/auth/sign-out. A GET via
    // location.href returns 404. Fetch, then redirect to the login page.
    // No confirmation dialog (one-click sign out).
    async function signOut() {
      try {
        await fetch('/api/auth/sign-out', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({}),
        });
      } catch (e) {}
      window.location.href = '/portal';
    }

    (function dismissPortalToast() {
      var toast = document.querySelector('.portal-toast');
      if (!toast) return;
      var params = new URLSearchParams(window.location.search);
      if (params.has('flash') || params.has('msg')) {
        params.delete('flash');
        params.delete('msg');
        var qs = params.toString();
        history.replaceState({}, '', window.location.pathname + (qs ? '?' + qs : '') + window.location.hash);
      }
      window.setTimeout(function () {
        toast.classList.add('is-leaving');
        window.setTimeout(function () {
          if (toast.parentNode) toast.parentNode.removeChild(toast);
        }, 280);
      }, 2000);
    })();
    ${renderPortalControlScript()}
  </script>`;
}

/**
 * Render the Portal Shell sidebar HTML
 */
export function renderPortalShell(opts: PortalShellOptions): string {
  const { surface, account, activeHref } = opts;
  const isAdmin = account?.role === "admin";
  
  // Determine nav rendering mode
  const useButtons = surface === "portal";
  
  // Build nav (Menu + Resources)
  const menuNav = useButtons ? `
    <div class="nav-section">Menu</div>
    ${portalNavButton("getting-started", "Getting Started", "rocket")}
    ${portalNavButton("api-keys", "API Keys", "key")}
    ${portalNavButton("authentication", "Authentication", "lock")}
  ` : `
    <div class="nav-section">Menu</div>
    ${portalNavLink("/portal#getting-started", "Getting Started", "rocket", activeHref === "/portal#getting-started")}
    ${portalNavLink("/portal#api-keys", "API Keys", "key", activeHref === "/portal#api-keys")}
    ${portalNavLink("/portal#authentication", "Authentication", "lock", activeHref === "/portal#authentication")}
  `;

  const resourcesNav = useButtons ? `
    <div class="nav-section">Resources</div>
    ${portalNavButton("reference", "API Reference", "doc")}
    ${portalNavLink("/docs", "API Docs", "doc", activeHref === "/docs")}
    ${portalNavLink("/graphql", "Sandbox", "sandbox", false, true)}
    ${portalNavButton("usage-analytics", "Usage Analytics", "chart")}
  ` : `
    <div class="nav-section">Resources</div>
    ${portalNavLink("/portal#reference", "API Reference", "doc", activeHref === "/portal#reference")}
    ${portalNavLink("/docs", "API Docs", "doc", activeHref === "/docs")}
    ${portalNavLink("/graphql", "Sandbox", "sandbox", false, true)}
    ${portalNavLink("/portal#usage-analytics", "Usage Analytics", "chart", activeHref === "/portal#usage-analytics")}
  `;

  // Admin nav (only if admin role)
  const adminNav = isAdmin ? `
    <div class="nav-section">Admin</div>
    <a href="/portal/admin" class="nav-item nav-item--link${activeHref === "/portal/admin" ? " active" : ""}" title="Admin Panel">
      ${PORTAL_SVGS.shield}
      <span class="nav-label">Admin Panel</span>
    </a>
  ` : "";
  
  // Account footer when signed in; Sign in CTA when anonymous so home/docs/portal
  // are not a dead end for existing accounts.
  const footerHtml = account
    ? `
    <div class="sidebar-footer">
      <div class="user-card">
        ${generateAvatarHtml(account.email)}
        <div class="user-details">
          <div class="user-email">${escapeHtml(account.email)}</div>
          <div class="user-role">${escapeHtml(formatAccountLabel(account.role))}</div>
        </div>
      </div>
      <button type="button" class="signout-btn" onclick="signOut()" title="Sign out">
        ${PORTAL_SVGS.signout}
        <span class="signout-label">Sign Out</span>
      </button>
    </div>
  `
    : `
    <div class="sidebar-footer">
      <a href="/portal/login" class="signin-link" title="Sign in">
        <span class="signin-label">Sign in</span>
      </a>
    </div>
  `;
  
  return `
    <button type="button" class="mobile-menu-btn" onclick="toggleMobileDrawer()" aria-label="Toggle menu">
      ${PORTAL_SVGS.hamburger}
    </button>
    <div class="mobile-drawer-overlay"></div>
    <aside class="sidebar">
      <div class="sidebar-top">
        <div class="sidebar-brand">
          <img src="${PORTAL_ICON_BASE}/${PORTAL_ASSETS.logo}" alt="CLEAR" class="brand-logo-img" width="36" height="36">
          <div class="brand-text">
            <div class="brand-title">Clear API</div>
            <div class="brand-sub">Developer Portal</div>
          </div>
          <button type="button" class="sidebar-toggle" id="sidebar-toggle" onclick="toggleSidebar()" aria-label="Collapse sidebar" title="Collapse sidebar">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>
          </button>
        </div>

        <nav class="nav-list" aria-label="Portal navigation">
          ${menuNav}
          ${resourcesNav}
          ${adminNav}
        </nav>
      </div>

      <div class="system-status-inline">
        <span class="status-dot"></span>
        <span class="status-text">System Operational</span>
      </div>

      ${footerHtml}

      <div class="version-indicator">v${escapeHtml(PORTAL_VERSION)}</div>
    </aside>
  `;
}
