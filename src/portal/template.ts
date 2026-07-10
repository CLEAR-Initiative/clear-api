export interface PortalOptions {
  userEmail: string;
  /** Caller's global role. When `"admin"`, the nav exposes a link to
   *  `/portal/admin` so operators can hop straight to the approvals
   *  dashboard from the dev portal. Anything else hides the link. */
  userRole?: string | null;
}

const PORTAL_ICON_BASE = "/portal/icons";

const PORTAL_SVGS = {
  rocket:
    '<svg class="nav-icon-img" viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M4.284 10.525 3.439 9.68a.86.86 0 0 1-.21-.88c.082-.243.191-.56.323-.923H.658a.75.75 0 0 1-.57-1.33L1.528 4.465A2.1 2.1 0 0 1 3.22 3.5h2.25c.066-.11.132-.21.197-.309 2.24-3.303 5.575-3.412 7.566-3.046a.75.75 0 0 1 .623.623c.366 1.994.254 5.327-3.046 7.566-.096.066-.2.131-.31.197v2.25c0 .695-.366 1.34-.965 1.693l-2.42 1.435a.75.75 0 0 1-1.059-.32v-2.93a4.6 4.6 0 0 1-1.475.325.86.86 0 0 1-.87-.214ZM10.502 4.594a1.094 1.094 0 1 0 0-2.187 1.094 1.094 0 0 0 0 2.187Z"/></svg>',
  key: '<svg class="nav-icon-img" viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M9.188 9.625A4.812 4.812 0 1 0 4.602 6.28L.192 10.691a.656.656 0 0 0 0 .928.656.656 0 0 0 .465.193H2.844a.656.656 0 0 0 .656-.656V12.25h1.094a.656.656 0 0 0 .656-.656v-1.094h1.094c.175 0 .342-.068.465-.191l.91-.911a4.77 4.77 0 0 0 1.469.227Zm1.094-7a1.094 1.094 0 1 1-2.188 0 1.094 1.094 0 0 1 2.188 0Z"/></svg>',
  shield:
    '<svg class="nav-icon-img" viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M7 0c.126 0 .252.027.366.079l5.149 2.185c.602.254 1.05.847 1.047 1.564-.014 2.712-1.129 7.675-5.84 9.931a1.75 1.75 0 0 1-1.444 0C1.567 11.504.451 6.54.438 3.828.435 3.112.883 2.518 1.485 2.264L6.636.08A.75.75 0 0 1 7 0Zm0 1.827v10.336C10.773 10.336 11.788 6.292 11.813 3.866L7 1.827Z"/></svg>',
  doc: '<svg class="nav-icon-img" viewBox="0 0 12.25 14" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M2.625 0C1.176 0 0 1.176 0 2.625v8.75C0 12.824 1.176 14 2.625 14h8.75c.484 0 .875-.391.875-.875a.875.875 0 0 0-.875-.875V10.5c.484 0 .875-.391.875-.875V.875A.875.875 0 0 0 11.375 0H2.625Zm0 10.5h7v1.75H2.625a.875.875 0 0 1-.875-.875c0-.484.391-.875.875-.875ZM3.5 3.938c0-.24.197-.438.438-.438h5.25a.438.438 0 0 1 0 .875h-5.25a.438.438 0 0 1-.438-.437Zm0 1.312a.438.438 0 0 0 0 .875h5.25a.438.438 0 0 0 0-.875h-5.25Z"/></svg>',
  chart:
    '<svg class="nav-icon-img" viewBox="0 0 12.25 14" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M4.375 2.188C4.375 1.463 4.963.875 5.688.875h.875C7.287.875 7.875 1.463 7.875 2.188v9.625c0 .725-.588 1.312-1.313 1.312h-.875c-.725 0-1.312-.587-1.312-1.312V2.188ZM0 7.438C0 6.713.588 6.125 1.313 6.125h.875C2.912 6.125 3.5 6.713 3.5 7.438v4.375c0 .725-.588 1.312-1.313 1.312h-.875C.588 13.125 0 12.537 0 11.812V7.438Zm10.063 2.625h.875c.725 0 1.312.588 1.312 1.313v4.375c0 .725-.587 1.312-1.312 1.312h-.875c-.725 0-1.313-.587-1.313-1.312V3.938c0-.725.588-1.313 1.313-1.313Z"/></svg>',
  signout:
    '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path fill="currentColor" d="M11.78 6.53a.75.75 0 0 0 0-1.06L8.78 2.47a.75.75 0 1 0-1.06 1.06L9.44 5.25H4.5a.75.75 0 0 0 0 1.5h4.94l-1.72 1.72a.75.75 0 1 0 1.06 1.06l3-3ZM3.75 2.25a.75.75 0 0 0 0-1.5H2.25A2.25 2.25 0 0 0 0 3v6a2.25 2.25 0 0 0 2.25 2.25H3.75a.75.75 0 0 0 0-1.5H2.25a.75.75 0 0 1-.75-.75V3a.75.75 0 0 1 .75-.75H3.75Z"/></svg>',
  modalClose:
    '<svg width="15" height="20" viewBox="0 0 15 20" aria-hidden="true"><path fill="currentColor" d="M2.5 2.5 12.5 12.5M12.5 2.5 2.5 12.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  modalInfo:
    '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="6.25" stroke="currentColor" stroke-width="1.25" fill="none"/><path fill="currentColor" d="M7 6.25a.75.75 0 0 0-.75.75v3.5a.75.75 0 0 0 1.5 0V7a.75.75 0 0 0-.75-.75ZM7 4.25a.875.875 0 1 0 0 1.75.875.875 0 0 0 0-1.75Z"/></svg>',
  modalCopy:
    '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><rect x="4.5" y="4.5" width="7.5" height="7.5" rx="1.25" stroke="currentColor" stroke-width="1.25" fill="none"/><path fill="currentColor" d="M3.25 9.5h-.5A1.25 1.25 0 0 1 1.5 8.25V3.25A1.25 1.25 0 0 1 2.75 2h5A1.25 1.25 0 0 1 9 3.25v.5"/></svg>',
  modalCheck:
    '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path fill="currentColor" d="M5.6 10.15 2.85 7.4l.95-.95 1.8 1.8 4.55-4.55.95.95-5.5 5.5Z"/></svg>',
  modalCheckWatermark:
    '<svg width="136" height="136" viewBox="0 0 136 136" aria-hidden="true"><path fill="#22c55e" d="M48 68 62 82 88 54" stroke="#22c55e" stroke-width="10" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>',
} as const;

const PORTAL_ASSETS = {
  logo: "logo.png",
} as const;

/**
 * Generate avatar HTML with initials on orange background (matching clear-mvp pattern).
 * Falls back to first two characters of email if no proper name available.
 */
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
  return `<button type="button" class="nav-item" data-tab="${tab}" title="${escapeHtml(label)}" onclick="showTab('${tab}')">${PORTAL_SVGS[icon]}<span class="nav-label">${escapeHtml(label)}</span></button>`;
}

function portalNavLink(href: string, label: string, icon: keyof typeof PORTAL_SVGS): string {
  return `<a href="${href}" class="nav-item nav-item--link" title="${escapeHtml(label)}">${PORTAL_SVGS[icon]}<span class="nav-label">${escapeHtml(label)}</span></a>`;
}

export function renderPortal({ userEmail, userRole }: PortalOptions): string {
  const isAdmin = userRole === "admin";
  const accountLabel = formatAccountLabel(userRole);
  const adminAccountHtml = isAdmin
    ? `<a href="/portal/admin" class="user-role">${escapeHtml(accountLabel)}</a>`
    : `<div class="user-role">${escapeHtml(accountLabel)}</div>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Developer Portal</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <meta name="theme-color" content="#0a0a0b">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    :root {
      --color-bg: #0a0a0a;
      --color-surface: #0d0d0d;
      --color-surface-2: #111111;
      --color-surface-3: #141414;
      --color-border: #1f1f1f;
      --color-border-2: #222222;
      --color-accent: #ff5c00;
      --color-accent-hover: #ff6a1a;
      --color-accent-soft: rgba(255, 92, 0, 0.1);
      --color-text: #ffffff;
      --color-muted: #999999;
      --color-label: #666666;
      --color-section: #444444;
      --on-accent: #ffffff;
      --color-success: #22c55e;
      --color-danger: #ef4444;
      --color-warning: #f59e0b;
      --color-code-bg: #0e0e10;
      --radius: 12px;
      --radius-sm: 6px;
      --font: 'Inter', ui-sans-serif, -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif;
      --font-mono: 'JetBrains Mono', "SF Mono", "Fira Code", ui-monospace, Consolas, monospace;
      --sidebar-width: 288px;
      --sidebar-width-collapsed: 72px;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: var(--font); background: var(--color-bg); color: var(--color-text); line-height: 1.6; min-height: 100vh; -webkit-font-smoothing: antialiased; }
    a { color: var(--color-accent); text-decoration: none; }
    a:hover { text-decoration: underline; }

    /* Shell */
    .portal-shell { display: flex; min-height: 100vh; }

    /* Sidebar */
    .sidebar {
      width: var(--sidebar-width); flex-shrink: 0; background: var(--color-surface);
      border-right: 1px solid var(--color-border); display: flex; flex-direction: column;
      justify-content: space-between; min-height: 100vh;
      transition: width 0.2s ease;
      overflow: hidden;
    }
    .portal-shell.sidebar-collapsed .sidebar { width: var(--sidebar-width-collapsed); justify-content: flex-start; }
    .sidebar-top { padding: 32px 32px 0; display: flex; flex-direction: column; gap: 48px; transition: padding 0.2s ease; }
    .portal-shell.sidebar-collapsed .sidebar-top { padding: 20px 12px 0; gap: 24px; }
    .sidebar-brand {
      display: flex; align-items: center; gap: 12px;
      flex-shrink: 0;
    }
    .portal-shell.sidebar-collapsed .sidebar-brand {
      flex-direction: column; gap: 10px; align-items: center;
    }
    .brand-logo-img { width: 36px; height: 36px; border-radius: 12px; flex-shrink: 0; display: block; }
    .brand-text { min-width: 0; overflow: hidden; white-space: nowrap; transition: opacity 0.15s, max-width 0.2s ease; max-width: 200px; }
    .portal-shell.sidebar-collapsed .brand-text { opacity: 0; max-width: 0; pointer-events: none; }
    .brand-title { font-weight: 700; font-size: 14px; letter-spacing: 1.4px; text-transform: uppercase; color: var(--color-text); line-height: 14px; }
    .brand-sub { font-size: 10px; font-weight: 500; color: var(--color-label); margin-top: 4px; line-height: 15px; }
    .sidebar-toggle {
      margin-left: auto; flex-shrink: 0;
      width: 28px; height: 28px; display: flex; align-items: center; justify-content: center;
      border: 1px solid var(--color-border); border-radius: 6px; background: transparent;
      color: var(--color-muted); cursor: pointer; font-family: var(--font);
      transition: color 0.15s, border-color 0.15s, transform 0.2s ease;
    }
    .sidebar-toggle:hover { color: var(--color-text); border-color: var(--color-border-2); }
    .portal-shell.sidebar-collapsed .sidebar-toggle { margin-left: 0; transform: rotate(180deg); }

    .nav-section {
      font-size: 10px; font-weight: 700; letter-spacing: 2px;
      text-transform: uppercase; color: var(--color-section);
      padding: 0 16px; margin-bottom: 6px;
      white-space: nowrap; overflow: hidden;
      transition: opacity 0.15s, max-height 0.2s ease; max-height: 24px;
    }
    .portal-shell.sidebar-collapsed .nav-section {
      opacity: 0; max-height: 0; margin: 0; padding: 0; pointer-events: none;
    }
    .nav-list { display: flex; flex-direction: column; gap: 6px; }
    .nav-item {
      display: flex; align-items: center; gap: 12px; width: 100%;
      min-height: 40px; padding: 10px 16px; border: none; background: none;
      color: var(--color-muted); font-size: 14px; font-weight: 500;
      cursor: pointer; text-align: left; font-family: var(--font);
      border-right: 2px solid transparent; border-radius: var(--radius-sm);
      transition: color 0.15s, background 0.15s, border-color 0.15s, padding 0.2s ease;
      text-decoration: none;
    }
    .portal-shell.sidebar-collapsed .nav-item {
      justify-content: center; padding: 10px 8px; gap: 0;
      border-right-color: transparent !important;
    }
    .nav-label {
      white-space: nowrap; overflow: hidden;
      transition: opacity 0.15s, max-width 0.2s ease; max-width: 180px;
    }
    .portal-shell.sidebar-collapsed .nav-label {
      opacity: 0; max-width: 0; pointer-events: none;
    }
    .nav-item:hover { color: var(--color-text); text-decoration: none; }
    .nav-item.active {
      color: var(--color-accent); border-right-color: var(--color-accent);
      background: var(--color-accent-soft);
    }
    .nav-icon-img { flex-shrink: 0; display: block; color: inherit; }
    .nav-item:not(.active) .nav-icon-img { opacity: 0.6; }
    .nav-item.active .nav-icon-img { opacity: 1; color: var(--color-accent); }

    .sidebar-footer { padding: 24px; transition: padding 0.2s ease; flex-shrink: 0; }
    .portal-shell.sidebar-collapsed .sidebar-footer {
      padding: 0 12px 16px; margin-top: auto;
      display: flex; flex-direction: column; align-items: center; gap: 10px;
    }
    .user-card {
      display: flex; align-items: center; gap: 12px;
      background: var(--color-surface-3); border-radius: 8px; padding: 8px; margin-bottom: 16px;
      transition: background 0.2s ease, padding 0.2s ease;
    }
    .portal-shell.sidebar-collapsed .user-card {
      justify-content: center; gap: 0; padding: 0; margin-bottom: 0; background: transparent;
    }
    .user-avatar {
      width: 32px; height: 32px; border-radius: 9999px; border: 1px solid #333;
      object-fit: cover; flex-shrink: 0; display: block;
    }
    .user-details { min-width: 0; overflow: hidden; transition: opacity 0.15s, max-width 0.2s ease; max-width: 200px; }
    .portal-shell.sidebar-collapsed .user-details { display: none; }
    .user-email { font-size: 12px; font-weight: 500; color: var(--color-text); line-height: 16px; word-break: break-all; }
    .user-role { font-size: 10px; color: var(--color-label); line-height: 15px; margin-top: 0; text-decoration: none; display: block; }
    a.user-role:hover { color: var(--color-accent); }
    .signout-btn {
      width: 100%; display: flex; align-items: center; justify-content: center; gap: 8px;
      padding: 12px; border-radius: var(--radius); border: 1px solid var(--color-border);
      background: transparent; color: var(--color-label); font-size: 12px; font-weight: 700;
      cursor: pointer; font-family: var(--font);
      transition: padding 0.2s ease, width 0.2s ease, height 0.2s ease;
    }
    .portal-shell.sidebar-collapsed .signout-btn {
      width: 40px; height: 40px; padding: 0; margin: 0 auto; gap: 0;
    }
    .signout-btn:hover { color: var(--color-text); border-color: var(--color-border-2); }
    .signout-btn svg { color: var(--color-label); flex-shrink: 0; }
    .signout-label { white-space: nowrap; transition: opacity 0.15s, max-width 0.2s ease; max-width: 80px; overflow: hidden; }
    .portal-shell.sidebar-collapsed .signout-label { opacity: 0; max-width: 0; }

    /* Main */
    .main { flex: 1; min-width: 0; display: flex; flex-direction: column; background: var(--color-bg); }
    .main-header {
      display: flex; align-items: center; justify-content: flex-end;
      padding: 20px 32px; border-bottom: 1px solid var(--color-border);
      background: rgba(13, 13, 13, 0.8); backdrop-filter: blur(6px);
    }
    .system-status {
      display: inline-flex; align-items: center; gap: 8px;
      font-size: 11px; font-weight: 500; color: #aaaaaa;
      background: #1a1a1a; border: 1px solid var(--color-border-2);
      border-radius: 9999px; padding: 4px 12px;
    }
    .system-status .dot {
      width: 8px; height: 8px; border-radius: 50%; background: var(--color-success); flex-shrink: 0;
    }
    .main-content { flex: 1; overflow-y: auto; padding: 32px; max-width: 1280px; width: 100%; }

    /* Tab panels */
    .tab-panel { display: none; }
    .tab-panel.active { display: block; }
    .tab-panel h1 { font-size: 24px; font-weight: 700; line-height: 32px; margin-bottom: 8px; letter-spacing: -0.02em; }
    .tab-panel h2 { font-size: 1.15rem; margin: 2rem 0 0.75rem; color: var(--color-text); }
    .tab-panel h3 { font-size: 1rem; margin: 1.5rem 0 0.5rem; color: var(--color-muted); }
    .tab-panel p { color: #888888; margin-bottom: 0.75rem; font-size: 14px; line-height: 20px; }
    .tab-panel ul { padding-left: 1.5rem; color: #888888; }
    .tab-panel li { margin: 0.4rem 0; }
    .subtitle { font-size: 14px; color: #888888; margin-bottom: 0; line-height: 20px; }

    /* Page header row */
    .page-header {
      display: flex; align-items: center; justify-content: space-between;
      gap: 24px; margin-bottom: 40px; flex-wrap: wrap;
    }
    .page-header-text { flex: 1; min-width: 240px; }

    /* Create key button */
    .btn-create-key {
      display: inline-flex; align-items: center; justify-content: center; gap: 8px;
      min-width: 202px; height: 48px; padding: 0 20px 0 16px;
      background: var(--color-accent); color: var(--on-accent); border: none;
      border-radius: var(--radius); font-size: 14px; font-weight: 700;
      cursor: pointer; font-family: var(--font); white-space: nowrap;
      box-shadow: 0 10px 15px -3px rgba(255, 92, 0, 0.1), 0 4px 6px -4px rgba(255, 92, 0, 0.1);
      transition: background 0.15s;
    }
    .btn-create-key:hover { background: var(--color-accent-hover); }
    .btn-create-key-plus { font-size: 24px; font-weight: 700; line-height: 1; margin-right: 2px; }

    /* Keys panel */
    .keys-panel {
      background: var(--color-surface-2); border: 1px solid var(--color-border);
      border-radius: var(--radius); min-height: 164px; overflow: hidden;
    }
    .keys-empty {
      min-height: 164px; display: flex; align-items: center; justify-content: center;
      color: #888888; font-size: 14px; line-height: 20px;
    }
    .keys-table { margin: 0; }
    .keys-table th {
      background: var(--color-bg); font-size: 10px; letter-spacing: 0.08em;
      text-transform: uppercase; color: var(--color-label); font-weight: 700;
      padding: 12px 20px; border-bottom: 1px solid var(--color-border);
    }
    .keys-table td {
      padding: 14px 20px; border-bottom: 1px solid var(--color-border);
      font-size: 14px; color: var(--color-text);
    }
    .keys-table tr:last-child td { border-bottom: none; }
    .keys-table .actions-col { text-align: right; }

    /* Modal */
    .modal-overlay {
      position: fixed; inset: 0; background: rgba(0, 0, 0, 0.72);
      display: flex; align-items: center; justify-content: center;
      padding: 24px; z-index: 200;
    }
    .modal {
      width: 100%; max-width: 440px; background: var(--color-surface-3);
      border: 1px solid var(--color-border); border-radius: var(--radius);
      padding: 24px;
    }
    .modal.modal--key-created {
      max-width: 520px; padding: 0; background: #111;
      border: 1px solid #1f1f1f; border-radius: 16px;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
      overflow: hidden; position: relative;
    }
    .modal h3 { font-size: 16px; font-weight: 700; color: var(--color-text); margin-bottom: 4px; }
    .modal p { font-size: 13px; color: var(--color-label); margin-bottom: 20px; }
    .modal-actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 20px; }
    .btn-ghost {
      padding: 10px 16px; border-radius: var(--radius-sm); border: 1px solid var(--color-border);
      background: transparent; color: var(--color-muted); font-size: 14px; font-weight: 500;
      cursor: pointer; font-family: var(--font);
    }
    .btn-ghost:hover { color: var(--color-text); border-color: var(--color-border-2); }

    /* Key created modal (Figma 87-1173 / 87-1956) */
    .key-created-watermark {
      position: absolute; right: 23px; top: 30px; width: 136px; height: 136px;
      opacity: 0; pointer-events: none; transition: opacity 0.2s ease;
    }
    .key-created-modal.key-copied .key-created-watermark { opacity: 0.1; }
    .key-created-header {
      display: flex; align-items: flex-start; justify-content: space-between;
      gap: 16px; padding: 24px 24px 16px;
    }
    .key-created-header h3 {
      font-size: 20px; font-weight: 700; letter-spacing: -0.5px; line-height: 30px;
      color: #fff; margin: 0 0 8px;
    }
    .key-created-header p {
      font-size: 14px; line-height: 20px; color: #888; margin: 0;
    }
    .modal-close-btn {
      flex-shrink: 0; width: 32px; height: 32px; display: flex; align-items: center;
      justify-content: center; border: none; background: transparent; color: #666;
      cursor: pointer; padding: 0; border-radius: 6px;
    }
    .modal-close-btn:hover { color: #fff; }
    .key-created-body { padding: 8px 24px; display: flex; flex-direction: column; gap: 20px; }
    .key-created-warning {
      display: flex; gap: 12px; align-items: flex-start;
      padding: 16px; border-radius: 12px;
      background: rgba(255, 92, 0, 0.05); border: 1px solid rgba(255, 92, 0, 0.2);
      color: #ff5c00; font-size: 13px; font-weight: 500; line-height: 19.5px;
    }
    .key-created-warning svg { flex-shrink: 0; margin-top: 2px; color: #ff5c00; }
    .key-created-field-wrap label {
      display: block; font-size: 11px; font-weight: 600; letter-spacing: 0.5px;
      text-transform: uppercase; color: #666; margin-bottom: 8px;
    }
    .key-created-field {
      display: flex; align-items: center; gap: 8px;
      background: #0a0a0a; border: 1px solid #222; border-radius: 8px;
      padding: 14px 16px; transition: border-color 0.2s, background 0.2s;
    }
    .key-created-modal.key-copied .key-created-field {
      background: #0b120e; border-color: #166534;
    }
    .key-created-field code {
      flex: 1; min-width: 0; font-family: var(--font-mono); font-size: 14px;
      line-height: 20px; color: #fff; letter-spacing: -0.027px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .key-created-modal.key-copied .key-created-field code { color: #22c55e; }
    .key-field-copy-btn {
      flex-shrink: 0; width: 28px; height: 28px; display: flex; align-items: center;
      justify-content: center; border: none; background: transparent; color: #666;
      cursor: pointer; padding: 0; border-radius: 4px;
    }
    .key-field-copy-btn:hover { color: #fff; }
    .key-created-modal.key-copied .key-field-copy-btn { display: none; }
    .key-created-footer {
      display: flex; justify-content: flex-end; padding: 24px;
    }
    .btn-copy-key {
      display: inline-flex; align-items: center; gap: 8px;
      padding: 12px 32px; border: none; border-radius: 8px;
      background: #ff5c00; color: #fff; font-size: 14px; font-weight: 600;
      letter-spacing: 0.16px; cursor: pointer; font-family: var(--font);
      box-shadow: 0 4px 6px rgba(255, 92, 0, 0.25);
    }
    .btn-copy-key:hover { background: #ff6a1a; }
    .btn-copy-key svg { flex-shrink: 0; }

    /* Confirm modal (revoke, etc.) */
    .modal.modal--confirm {
      max-width: 440px; padding: 0; background: #111;
      border: 1px solid #1f1f1f; border-radius: 16px;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
    }
    .confirm-modal-header {
      display: flex; align-items: flex-start; justify-content: space-between;
      gap: 16px; padding: 24px 24px 0;
    }
    .confirm-modal-header h3 {
      font-size: 20px; font-weight: 700; letter-spacing: -0.5px; line-height: 30px;
      color: #fff; margin: 0;
    }
    .confirm-modal-body { padding: 16px 24px 0; }
    .confirm-modal-body p {
      font-size: 14px; line-height: 20px; color: #888; margin: 0;
    }
    .confirm-modal-body strong { color: #fff; font-weight: 600; }
    .confirm-modal-warning {
      display: flex; gap: 12px; align-items: flex-start; margin-top: 16px;
      padding: 16px; border-radius: 12px;
      background: rgba(239, 68, 68, 0.05); border: 1px solid rgba(239, 68, 68, 0.2);
      color: #f87171; font-size: 13px; font-weight: 500; line-height: 19.5px;
    }
    .confirm-modal-warning svg { flex-shrink: 0; margin-top: 1px; color: #f87171; }
    .confirm-modal-footer {
      display: flex; gap: 10px; justify-content: flex-end;
      padding: 24px;
    }
    .btn-danger-solid {
      display: inline-flex; align-items: center; justify-content: center;
      padding: 12px 24px; border: none; border-radius: 8px;
      background: #ef4444; color: #fff; font-size: 14px; font-weight: 600;
      cursor: pointer; font-family: var(--font);
      box-shadow: 0 4px 6px rgba(239, 68, 68, 0.2);
    }
    .btn-danger-solid:hover { background: #dc2626; }
    .btn-danger-solid:disabled { opacity: 0.5; cursor: not-allowed; }

    /* Code blocks */
    pre { background: var(--color-code-bg); border: 1px solid var(--color-border); border-radius: var(--radius); padding: 1rem; overflow-x: auto; position: relative; margin: 0.75rem 0; }
    code { font-family: var(--font-mono); font-size: 0.85rem; color: #cdd1d6; }
    p code, li code { background: var(--color-code-bg); padding: 0.15rem 0.4rem; border-radius: 4px; font-size: 0.8rem; }

    /* Copy button */
    .copy-btn { position: absolute; top: 0.5rem; right: 0.5rem; padding: 0.25rem 0.6rem; background: var(--color-border); border: none; border-radius: 4px; color: var(--color-muted); cursor: pointer; font-size: 0.75rem; font-family: var(--font); }
    .copy-btn:hover { background: var(--color-accent); color: var(--on-accent); }

    /* Steps */
    .steps { margin-top: 1rem; }
    .step { display: flex; gap: 1.25rem; margin: 1.75rem 0; }
    .step-num { width: 2rem; height: 2rem; border-radius: 50%; background: var(--color-accent); display: flex; align-items: center; justify-content: center; font-weight: 700; flex-shrink: 0; font-size: 0.875rem; color: #1a0a02; }
    .step-content h3 { margin: 0 0 0.25rem; color: var(--color-text); }
    .step-content p { margin: 0.25rem 0; }

    /* Key table */
    .key-table { width: 100%; border-collapse: collapse; margin: 1rem 0; }
    .key-table th { text-align: left; padding: 0.5rem 1rem; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--color-muted); border-bottom: 1px solid var(--color-border); }
    .key-table td { padding: 0.75rem 1rem; border-bottom: 1px solid var(--color-border); font-size: 0.875rem; }
    .badge { display: inline-flex; align-items: center; padding: 0.2rem 0.6rem; border-radius: 999px; font-size: 0.7rem; font-weight: 600; }
    .badge-active { background: #14532d; color: #4ade80; }
    .badge-revoked { background: #450a0a; color: #f87171; }
    .badge-expired { background: #431407; color: #fb923c; }

    input[type="text"], input[type="date"] { padding: 0.5rem 0.75rem; border-radius: var(--radius); border: 1px solid var(--color-border); background: var(--color-code-bg); color: var(--color-text); font-size: 0.875rem; font-family: var(--font); }
    input:focus { outline: none; border-color: var(--color-accent); }
    .form-group label { display: block; font-size: 0.8rem; color: var(--color-muted); margin-bottom: 0.25rem; }

    /* Buttons */
    .btn { padding: 0.5rem 1rem; border-radius: var(--radius); border: none; font-weight: 500; cursor: pointer; font-size: 0.875rem; transition: all 0.15s; font-family: var(--font); }
    .btn-primary { background: var(--color-accent); color: var(--on-accent); }
    .btn-primary:hover { background: var(--color-accent-hover); }
    .btn-danger { background: transparent; border: 1px solid var(--color-danger); color: var(--color-danger); }
    .btn-danger:hover { background: var(--color-danger); color: #fff; }
    .btn-sm { padding: 0.3rem 0.6rem; font-size: 0.75rem; }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }

    /* Notices */
    .notice { padding: 0.75rem 1rem; border-radius: var(--radius); margin: 1rem 0; font-size: 0.875rem; }
    .notice-warning { background: #451a03; border: 1px solid var(--color-warning); color: #fde68a; }
    .notice-info { background: #0c1a3a; border: 1px solid #3b82f6; color: #93c5fd; }

    .error-text { color: var(--color-danger); font-size: 0.875rem; margin-top: 0.5rem; }
    .empty-state { color: var(--color-muted); padding: 2rem; text-align: center; }

    /* Usage analytics */
    .stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 1rem; margin: 1.5rem 0 2rem; }
    .stat-card { background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius); padding: 1.1rem 1.2rem; }
    .stat-label { font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--color-label); font-weight: 600; margin-bottom: 0.35rem; }
    .stat-value { font-size: 1.75rem; font-weight: 700; color: var(--color-text); font-variant-numeric: tabular-nums; }
    .stat-sub { font-size: 0.75rem; color: var(--color-muted); margin-top: 0.25rem; }

    /* Getting started CTAs */
    .getting-started-ctas {
      display: flex; gap: 16px; flex-wrap: wrap; margin-top: 48px;
    }
    .btn-cta-secondary {
      display: inline-flex; align-items: center; justify-content: center;
      min-height: 48px; padding: 12px 24px; border-radius: var(--radius);
      border: 1px solid rgba(255, 92, 0, 0.4); background: rgba(204, 88, 23, 0.2);
      color: var(--color-text); font-size: 14px; font-weight: 700;
      text-decoration: none; font-family: var(--font);
    }
    .btn-cta-secondary:hover { text-decoration: none; border-color: var(--color-accent); }
    .btn-cta-primary {
      display: inline-flex; align-items: center; justify-content: center;
      min-height: 48px; padding: 12px 24px; border-radius: var(--radius);
      border: none; background: var(--color-accent); color: var(--on-accent);
      font-size: 14px; font-weight: 700; cursor: pointer; font-family: var(--font);
      box-shadow: 0 10px 15px -3px rgba(255, 92, 0, 0.1), 0 4px 6px -4px rgba(255, 92, 0, 0.1);
    }
    .btn-cta-primary:hover { background: var(--color-accent-hover); }

    @media (max-width: 768px) {
      .portal-shell { flex-direction: column; }
      .portal-shell.sidebar-collapsed .sidebar { width: 100%; }
      .sidebar { width: 100%; min-height: auto; border-right: none; border-bottom: 1px solid var(--color-border); }
      .sidebar-top { padding: 20px 20px 0; gap: 24px; }
      .sidebar-footer { display: none; }
      .main-content { padding: 20px; }
      .main-header { padding: 16px 20px; }
      .page-header { margin-bottom: 24px; }
      .btn-create-key { width: 100%; }
    }
  </style>
</head>
<body>
  <div class="portal-shell" id="portal-shell">
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
          <div class="nav-section">Menu</div>
          ${portalNavButton("getting-started", "Getting Started", "rocket")}
          ${portalNavButton("api-keys", "API Keys", "key")}
          ${portalNavButton("authentication", "Authentication", "shield")}

          <div class="nav-section" style="margin-top:18px">Resources</div>
          ${portalNavButton("reference", "API Reference", "doc")}
          ${portalNavLink("/docs", "API Docs", "doc")}
          ${portalNavButton("usage-analytics", "Usage Analytics", "chart")}
          ${isAdmin ? `
          <div class="nav-section" style="margin-top:18px">Admin</div>
          ${portalNavLink("/portal/admin", "Admin Panel", "shield")}
          ` : ""}
        </nav>
      </div>

      <div class="sidebar-footer">
        <div class="user-card">
          ${generateAvatarHtml(userEmail)}
          <div class="user-details">
            <div class="user-email">${escapeHtml(userEmail)}</div>
            ${adminAccountHtml}
          </div>
        </div>
        <button type="button" class="signout-btn" onclick="signOut()" title="Sign out">
          ${PORTAL_SVGS.signout}
          <span class="signout-label">Sign Out</span>
        </button>
      </div>
    </aside>

    <div class="main">
      <header class="main-header">
        <div class="system-status" title="All systems operational"><span class="dot"></span> System Status: Operational</div>
      </header>
      <div class="main-content">
  <div id="tab-getting-started" class="tab-panel active">
    <h1>Getting Started</h1>
    <p class="subtitle">Start making authenticated API calls in minutes.</p>

    <div class="steps">
      <div class="step">
        <div class="step-num">1</div>
        <div class="step-content">
          <h3>Create an API Key</h3>
          <p>Go to the <a href="#api-keys" onclick="showTab('api-keys')">API Keys</a> tab and click <strong>Create New API Key</strong>. Give it a descriptive name like <code>my-app-prod</code>.</p>
        </div>
      </div>
      <div class="step">
        <div class="step-num">2</div>
        <div class="step-content">
          <h3>Save Your Key Immediately</h3>
          <p>The full key is shown <strong>once</strong> and is never stored in plaintext. Copy it to your secrets manager or <code>.env</code> file right away.</p>
        </div>
      </div>
      <div class="step">
        <div class="step-num">3</div>
        <div class="step-content">
          <h3>Make Your First Request</h3>
          <p>Send the key as a Bearer token in the <code>Authorization</code> header:</p>
          <pre><code>curl -X POST ${escapeHtml(baseUrl)}/graphql \\
  -H "Authorization: Bearer sk_live_..." \\
  -H "Content-Type: application/json" \\
  -d '{"query":"{ me { id email } }"}'</code><button class="copy-btn" onclick="copyCode(this)">Copy</button></pre>
        </div>
      </div>
      <div class="step">
        <div class="step-num">4</div>
        <div class="step-content">
          <h3>Explore the Schema</h3>
          <p>Use the <a href="/graphql" target="_blank">Apollo Sandbox</a> to browse all available queries, mutations, and types interactively.</p>
        </div>
      </div>
    </div>

    <div class="getting-started-ctas">
      <a href="/docs" class="btn-cta-secondary">Read documentation</a>
      <button type="button" class="btn-cta-primary" onclick="showTab('api-keys')">Manage API Keys &rarr;</button>
    </div>
  </div>

  <!-- API Keys -->
  <div id="tab-api-keys" class="tab-panel">
    <div class="page-header">
      <div class="page-header-text">
        <h1>API Keys</h1>
        <p class="subtitle">Manage your personal API keys. Maximum 10 active keys per account.</p>
      </div>
      <button type="button" class="btn-create-key" onclick="openCreateKeyModal()">
        <span class="btn-create-key-plus">+</span>
        Create New API Key
      </button>
    </div>

    <div class="keys-panel" id="keys-panel">
      <div id="keys-empty" class="keys-empty">No API Keys yet.</div>
      <table class="key-table keys-table" id="keys-table" style="display:none">
        <thead>
          <tr>
            <th>Key</th>
            <th>Name</th>
            <th>Status</th>
            <th>Last Used</th>
            <th class="actions-col">Actions</th>
          </tr>
        </thead>
        <tbody id="key-table-body"></tbody>
      </table>
    </div>
  </div>

  <div id="create-key-modal" class="modal-overlay" style="display:none" onclick="if(event.target===this)closeCreateKeyModal()">
    <div class="modal" id="create-key-modal-panel" role="dialog" aria-labelledby="create-key-title">
      <div id="create-key-form-view">
        <h3 id="create-key-title">Create New Key</h3>
        <p>Give your key a descriptive name. You can optionally set an expiry date.</p>
        <div class="form-group" style="margin-bottom:12px">
          <label for="key-name">Name (required)</label>
          <input type="text" id="key-name" placeholder="my-app-prod" style="width:100%">
        </div>
        <div class="form-group" style="margin-bottom:4px">
          <label for="key-expires">Expires (optional)</label>
          <input type="date" id="key-expires" style="width:100%">
        </div>
        <div id="create-error" class="error-text"></div>
        <div class="modal-actions">
          <button type="button" class="btn-ghost" onclick="closeCreateKeyModal()">Cancel</button>
          <button type="button" class="btn btn-primary" id="create-btn" onclick="createKey()">Create Key</button>
        </div>
      </div>
      <div id="create-key-success-view" class="key-created-modal" style="display:none">
        <div class="key-created-watermark">${PORTAL_SVGS.modalCheckWatermark}</div>
        <div class="key-created-header">
          <div>
            <h3 id="create-key-success-title">Your API Key has been created</h3>
            <p>Your API Key is a secure credential for accessing the API. Do not share it or expose it in browsers, or other client-side code.</p>
          </div>
          <button type="button" class="modal-close-btn" onclick="closeCreateKeyModal()" aria-label="Close">${PORTAL_SVGS.modalClose}</button>
        </div>
        <div class="key-created-body">
          <div class="key-created-warning">
            ${PORTAL_SVGS.modalInfo}
            <div>
              <div>Important: your API Key will only be displayed once.</div>
              <div>Please store it securely.</div>
            </div>
          </div>
          <div class="key-created-field-wrap">
            <label for="new-key-value">API Key</label>
            <div class="key-created-field">
              <code id="new-key-value"></code>
              <button type="button" class="key-field-copy-btn" onclick="copyApiKey()" aria-label="Copy API key">${PORTAL_SVGS.modalCopy}</button>
            </div>
          </div>
        </div>
        <div class="key-created-footer">
          <button type="button" class="btn-copy-key" id="copy-key-btn" onclick="copyApiKey()">
            ${PORTAL_SVGS.modalCopy}
            <span class="btn-copy-key-label">Copy Key</span>
          </button>
        </div>
      </div>
    </div>
  </div>

  <div id="revoke-key-modal" class="modal-overlay" style="display:none" onclick="if(event.target===this)closeRevokeKeyModal()">
    <div class="modal modal--confirm" role="alertdialog" aria-labelledby="revoke-key-title" aria-describedby="revoke-key-desc">
      <div class="confirm-modal-header">
        <h3 id="revoke-key-title">Revoke API Key?</h3>
        <button type="button" class="modal-close-btn" onclick="closeRevokeKeyModal()" aria-label="Close">${PORTAL_SVGS.modalClose}</button>
      </div>
      <div class="confirm-modal-body">
        <p id="revoke-key-desc">Are you sure you want to revoke <strong id="revoke-key-name"></strong>? This action cannot be undone.</p>
        <div class="confirm-modal-warning">
          ${PORTAL_SVGS.modalInfo}
          <div>Revoked keys stop working immediately. Any integrations using this key will fail until you create a new one.</div>
        </div>
        <div id="revoke-error" class="error-text" style="margin-top:12px"></div>
      </div>
      <div class="confirm-modal-footer">
        <button type="button" class="btn-ghost" onclick="closeRevokeKeyModal()">Cancel</button>
        <button type="button" class="btn-danger-solid" id="revoke-confirm-btn" onclick="confirmRevokeKey()">Revoke Key</button>
      </div>
    </div>
  </div>

  <!-- Authentication -->
  <div id="tab-authentication" class="tab-panel">
    <h1>Authentication</h1>

    <h2>API Keys (server-to-server)</h2>
    <p>Pass your key in the <code>Authorization</code> header as a Bearer token:</p>
    <pre><code>Authorization: Bearer sk_live_your_key_here</code><button class="copy-btn" onclick="copyCode(this)">Copy</button></pre>

    <div class="notice notice-warning">
      Never expose API keys in client-side code, browser console, or version control. Store them in environment variables or a secrets manager.
    </div>

    <h2>Session Cookies (browser clients)</h2>
    <p>Sign in via the auth REST API. The session cookie is set automatically and sent with subsequent requests:</p>
    <pre><code>// Sign in
const res = await fetch('/api/auth/sign-in/email', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  credentials: 'include',
  body: JSON.stringify({
    email: 'user@example.com',
    password: 'your-password',
  }),
});

// Subsequent GraphQL calls (cookie sent automatically)
const data = await fetch('/graphql', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  credentials: 'include',
  body: JSON.stringify({ query: '{ me { id email } }' }),
});</code><button class="copy-btn" onclick="copyCode(this)">Copy</button></pre>

    <h2>Key Lifecycle</h2>
    <ul>
      <li>Keys are prefixed <code>sk_live_</code> and contain 256 bits of entropy</li>
      <li>Only a short prefix is stored for display &mdash; the full key is hashed with SHA-256</li>
      <li>Keys can optionally have an expiry date; expired keys are rejected automatically</li>
      <li>Revoking a key is <strong>permanent</strong> and cannot be undone</li>
      <li>Maximum <strong>10 active keys</strong> per account</li>
    </ul>

    <h2>Error Responses</h2>
    <p>Unauthenticated or unauthorized requests return standard GraphQL errors:</p>
    <pre><code>{
  "errors": [{
    "message": "You must be logged in to perform this action",
    "extensions": { "code": "UNAUTHENTICATED" }
  }],
  "data": null
}</code><button class="copy-btn" onclick="copyCode(this)">Copy</button></pre>
  </div>

  <!-- API Reference -->
  <div id="tab-reference" class="tab-panel">
    <h1>API Reference</h1>

    <div class="notice notice-info">
      This API uses <strong>GraphQL</strong>. All operations are sent as POST requests to <code>/graphql</code>.
    </div>

    <h2>Interactive Explorer</h2>
    <p>Browse the full schema, autocomplete queries, and test requests in the browser.</p>
    <a href="/graphql" target="_blank" class="btn btn-primary" style="display:inline-block;margin:0.75rem 0">Open Apollo Sandbox &rarr;</a>

    <h2>Base URL &amp; Headers</h2>
    <pre><code>POST /graphql
Content-Type: application/json
Authorization: Bearer sk_live_...</code><button class="copy-btn" onclick="copyCode(this)">Copy</button></pre>

    <h2>Request Format</h2>
    <pre><code>{
  "query": "query { me { id email role } }",
  "variables": {}
}</code><button class="copy-btn" onclick="copyCode(this)">Copy</button></pre>

    <h2>Code Examples</h2>

    <h3>curl</h3>
    <pre><code>curl -X POST ${escapeHtml(baseUrl)}/graphql \\
  -H "Authorization: Bearer sk_live_..." \\
  -H "Content-Type: application/json" \\
  -d '{"query":"{ me { id email role } }"}'</code><button class="copy-btn" onclick="copyCode(this)">Copy</button></pre>

    <h3>JavaScript (fetch)</h3>
    <pre><code>const response = await fetch('${escapeHtml(baseUrl)}/graphql', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer sk_live_...',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    query: \\\`{ me { id email role } }\\\`,
  }),
});
const { data } = await response.json();
console.log(data.me);</code><button class="copy-btn" onclick="copyCode(this)">Copy</button></pre>

    <h3>Python (requests)</h3>
    <pre><code>import requests

response = requests.post(
    '${escapeHtml(baseUrl)}/graphql',
    headers={
        'Authorization': 'Bearer sk_live_...',
        'Content-Type': 'application/json',
    },
    json={'query': '{ me { id email role } }'},
)
data = response.json()['data']
print(data['me'])</code><button class="copy-btn" onclick="copyCode(this)">Copy</button></pre>

    <h2>Rate Limits</h2>
    <table class="key-table">
      <thead><tr><th>Limit</th><th>Value</th></tr></thead>
      <tbody>
        <tr><td>Active API keys per account</td><td>10</td></tr>
        <tr><td>Session duration (cookie auth)</td><td>7 days</td></tr>
        <tr><td>Session refresh</td><td>After 1 day of activity</td></tr>
      </tbody>
    </table>
  </div>

  <!-- Usage Analytics -->
  <div id="tab-usage-analytics" class="tab-panel">
    <h1>Usage Analytics</h1>
    <p class="subtitle">API key activity for your account. Last-used timestamps update when a key authenticates a request.</p>

    <div id="usage-stats" class="stat-grid">
      <div class="stat-card"><div class="stat-label">Active keys</div><div class="stat-value" id="stat-active">—</div></div>
      <div class="stat-card"><div class="stat-label">Total keys</div><div class="stat-value" id="stat-total">—</div></div>
      <div class="stat-card"><div class="stat-label">Last activity</div><div class="stat-value" id="stat-last" style="font-size:1.1rem">—</div><div class="stat-sub" id="stat-last-sub"></div></div>
    </div>

    <table class="key-table">
      <thead>
        <tr>
          <th>Key</th>
          <th>Name</th>
          <th>Status</th>
          <th>Created</th>
          <th>Last used</th>
        </tr>
      </thead>
      <tbody id="usage-table-body">
        <tr><td colspan="5" class="empty-state">Loading...</td></tr>
      </tbody>
    </table>
  </div>

      </div><!-- /.main-content -->
    </div><!-- /.main -->
  </div><!-- /.portal-shell -->

  <script>
    // --- Tab routing ---
    function showTab(name) {
      document.querySelectorAll('.tab-panel').forEach(function(p) { p.classList.remove('active'); });
      document.querySelectorAll('.nav-item[data-tab]').forEach(function(b) { b.classList.remove('active'); });
      var panel = document.getElementById('tab-' + name);
      var btn = document.querySelector('.nav-item[data-tab="' + name + '"]');
      if (panel) panel.classList.add('active');
      if (btn) btn.classList.add('active');
      history.replaceState(null, '', '#' + name);
      if (name === 'api-keys') loadApiKeys();
      if (name === 'usage-analytics') loadUsageAnalytics();
    }

    // Init from hash
    var initialTab = location.hash.slice(1) || 'getting-started';
    if (document.getElementById('tab-' + initialTab)) {
      showTab(initialTab);
    }

    // --- Collapsible sidebar ---
    function toggleSidebar() {
      var shell = document.getElementById('portal-shell');
      var collapsed = shell.classList.toggle('sidebar-collapsed');
      localStorage.setItem('portal-sidebar-collapsed', collapsed ? '1' : '0');
      var toggleBtn = document.getElementById('sidebar-toggle');
      if (toggleBtn) {
        var label = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
        toggleBtn.setAttribute('aria-label', label);
        toggleBtn.title = label;
      }
    }

    (function initSidebar() {
      if (localStorage.getItem('portal-sidebar-collapsed') === '1') {
        var shell = document.getElementById('portal-shell');
        shell.classList.add('sidebar-collapsed');
        var toggleBtn = document.getElementById('sidebar-toggle');
        if (toggleBtn) {
          toggleBtn.setAttribute('aria-label', 'Expand sidebar');
          toggleBtn.title = 'Expand sidebar';
        }
      }
    })();

    // --- GraphQL helper ---
    async function gql(query, variables) {
      var res = await fetch('/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ query: query, variables: variables || {} }),
      });
      var json = await res.json();
      if (json.errors && json.errors.length) throw new Error(json.errors[0].message);
      return json.data;
    }

    // --- API Key Management ---
    var keysLoaded = false;

    function openCreateKeyModal() {
      resetCreateKeyModal();
      document.getElementById('create-key-modal').style.display = 'flex';
      document.getElementById('key-name').focus();
    }

    function resetCreateKeyModal() {
      var panel = document.getElementById('create-key-modal-panel');
      var successView = document.getElementById('create-key-success-view');
      panel.classList.remove('modal--key-created');
      document.getElementById('create-key-form-view').style.display = '';
      successView.style.display = 'none';
      successView.classList.remove('key-copied');
      document.getElementById('key-name').value = '';
      document.getElementById('key-expires').value = '';
      document.getElementById('new-key-value').textContent = '';
      document.getElementById('new-key-value').removeAttribute('data-full-key');
      var copyLabel = document.querySelector('#copy-key-btn .btn-copy-key-label');
      if (copyLabel) copyLabel.textContent = 'Copy Key';
      var copyBtn = document.getElementById('copy-key-btn');
      if (copyBtn) copyBtn.innerHTML = '${PORTAL_SVGS.modalCopy.replace(/'/g, "\\'")}<span class="btn-copy-key-label">Copy Key</span>';
      showCreateError('');
      var btn = document.getElementById('create-btn');
      btn.disabled = false;
      btn.textContent = 'Create Key';
    }

    function closeCreateKeyModal() {
      document.getElementById('create-key-modal').style.display = 'none';
      resetCreateKeyModal();
    }

    function maskApiKey(key) {
      if (!key || key.length < 16) return key;
      var start = key.slice(0, 12);
      var end = key.slice(-4);
      var dotCount = Math.min(28, Math.max(12, key.length - 16));
      return start + '.'.repeat(dotCount) + end;
    }

    function showKeyCreated(fullKey) {
      var panel = document.getElementById('create-key-modal-panel');
      var successView = document.getElementById('create-key-success-view');
      var valueEl = document.getElementById('new-key-value');
      valueEl.setAttribute('data-full-key', fullKey);
      valueEl.textContent = maskApiKey(fullKey);
      document.getElementById('create-key-form-view').style.display = 'none';
      successView.style.display = '';
      successView.classList.remove('key-copied');
      panel.classList.add('modal--key-created');
    }

    async function copyApiKey() {
      var valueEl = document.getElementById('new-key-value');
      var fullKey = valueEl.getAttribute('data-full-key');
      if (!fullKey) return;
      try {
        await navigator.clipboard.writeText(fullKey);
      } catch (e) {
        var ta = document.createElement('textarea');
        ta.value = fullKey;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      var successView = document.getElementById('create-key-success-view');
      successView.classList.add('key-copied');
      valueEl.textContent = maskApiKey(fullKey) + ' ✓';
      var copyBtn = document.getElementById('copy-key-btn');
      if (copyBtn) {
        copyBtn.innerHTML = '${PORTAL_SVGS.modalCheck.replace(/'/g, "\\'")}<span class="btn-copy-key-label">Key copied!</span>';
      }
    }

    async function loadApiKeys() {
      if (keysLoaded) return;
      var empty = document.getElementById('keys-empty');
      var table = document.getElementById('keys-table');
      empty.style.display = 'flex';
      empty.textContent = 'Loading...';
      table.style.display = 'none';
      try {
        var data = await gql('query { myApiKeys { id name prefix expiresAt lastUsedAt revokedAt createdAt } }');
        keysLoaded = true;
        renderKeyTable(data.myApiKeys);
      } catch (e) {
        empty.style.display = 'flex';
        empty.textContent = e.message;
        table.style.display = 'none';
      }
    }

    function renderKeyTable(keys) {
      var empty = document.getElementById('keys-empty');
      var table = document.getElementById('keys-table');
      var tbody = document.getElementById('key-table-body');
      if (!keys.length) {
        empty.style.display = 'flex';
        empty.textContent = 'No API Keys yet.';
        table.style.display = 'none';
        return;
      }
      empty.style.display = 'none';
      table.style.display = 'table';
      tbody.innerHTML = keys.map(function(k) {
        var now = new Date();
        var status = k.revokedAt ? 'revoked' : (k.expiresAt && new Date(k.expiresAt) < now) ? 'expired' : 'active';
        var lastUsed = k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleDateString() : 'Never';
        return '<tr>'
          + '<td><code>' + k.prefix + '...</code></td>'
          + '<td>' + escapeHtmlJs(k.name) + '</td>'
          + '<td><span class="badge badge-' + status + '">' + status + '</span></td>'
          + '<td>' + lastUsed + '</td>'
          + '<td class="actions-col">' + (status === 'active'
            ? '<button type="button" class="btn btn-danger btn-sm" data-revoke-id="' + escapeHtmlJs(k.id) + '" data-revoke-name="' + escapeHtmlJs(k.name) + '">Revoke</button>'
            : '&mdash;')
          + '</td></tr>';
      }).join('');
    }

    async function createKey() {
      var nameInput = document.getElementById('key-name');
      var expiresInput = document.getElementById('key-expires');
      var name = nameInput.value.trim();
      if (!name) { showCreateError('Key name is required.'); return; }
      var btn = document.getElementById('create-btn');
      btn.disabled = true;
      btn.textContent = 'Creating...';
      showCreateError('');
      try {
        var input = { name: name };
        if (expiresInput.value) input.expiresAt = new Date(expiresInput.value).toISOString();
        var data = await gql(
          'mutation CreateApiKey($input: CreateApiKeyInput!) { createApiKey(input: $input) { key apiKey { id name prefix createdAt } } }',
          { input: input }
        );
        showKeyCreated(data.createApiKey.key);
        keysLoaded = false;
        usageLoaded = false;
        loadApiKeys();
      } catch (e) {
        showCreateError(e.message);
      } finally {
        btn.disabled = false;
        btn.textContent = 'Create Key';
      }
    }

    var pendingRevoke = { id: null, name: null };

    function openRevokeKeyModal(id, name) {
      pendingRevoke.id = id;
      pendingRevoke.name = name;
      document.getElementById('revoke-key-name').textContent = name;
      document.getElementById('revoke-error').textContent = '';
      var btn = document.getElementById('revoke-confirm-btn');
      btn.disabled = false;
      btn.textContent = 'Revoke Key';
      document.getElementById('revoke-key-modal').style.display = 'flex';
    }

    function closeRevokeKeyModal() {
      document.getElementById('revoke-key-modal').style.display = 'none';
      pendingRevoke.id = null;
      pendingRevoke.name = null;
      document.getElementById('revoke-error').textContent = '';
    }

    async function confirmRevokeKey() {
      if (!pendingRevoke.id) return;
      var btn = document.getElementById('revoke-confirm-btn');
      btn.disabled = true;
      btn.textContent = 'Revoking...';
      document.getElementById('revoke-error').textContent = '';
      try {
        await gql('mutation RevokeApiKey($id: String!) { revokeApiKey(id: $id) { id revokedAt } }', { id: pendingRevoke.id });
        closeRevokeKeyModal();
        keysLoaded = false;
        usageLoaded = false;
        await loadApiKeys();
      } catch (e) {
        document.getElementById('revoke-error').textContent = e.message;
        btn.disabled = false;
        btn.textContent = 'Revoke Key';
      }
    }

    document.getElementById('keys-table').addEventListener('click', function(e) {
      var btn = e.target.closest('[data-revoke-id]');
      if (!btn) return;
      openRevokeKeyModal(btn.getAttribute('data-revoke-id'), btn.getAttribute('data-revoke-name'));
    });

    function showCreateError(msg) {
      document.getElementById('create-error').textContent = msg;
    }

    // --- Usage Analytics ---
    var usageLoaded = false;

    async function loadUsageAnalytics() {
      if (usageLoaded) return;
      var tbody = document.getElementById('usage-table-body');
      tbody.innerHTML = '<tr><td colspan="5" class="empty-state">Loading...</td></tr>';
      try {
        var data = await gql('query { myApiKeys { id name prefix expiresAt lastUsedAt revokedAt createdAt } }');
        usageLoaded = true;
        renderUsageAnalytics(data.myApiKeys);
      } catch (e) {
        tbody.innerHTML = '<tr><td colspan="5" class="error-text">' + e.message + '</td></tr>';
      }
    }

    function renderUsageAnalytics(keys) {
      var now = new Date();
      var active = keys.filter(function(k) {
        return !k.revokedAt && (!k.expiresAt || new Date(k.expiresAt) >= now);
      });
      var lastUsedDates = keys.map(function(k) { return k.lastUsedAt ? new Date(k.lastUsedAt) : null; }).filter(Boolean);
      var mostRecent = lastUsedDates.length ? new Date(Math.max.apply(null, lastUsedDates.map(function(d) { return d.getTime(); }))) : null;

      document.getElementById('stat-active').textContent = String(active.length);
      document.getElementById('stat-total').textContent = String(keys.length);
      document.getElementById('stat-last').textContent = mostRecent ? mostRecent.toLocaleDateString() : 'Never';
      document.getElementById('stat-last-sub').textContent = mostRecent ? mostRecent.toLocaleTimeString() : 'No authenticated requests yet';

      var tbody = document.getElementById('usage-table-body');
      if (!keys.length) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty-state">No API keys yet. Create one on the API Keys page.</td></tr>';
        return;
      }
      tbody.innerHTML = keys.map(function(k) {
        var status = k.revokedAt ? 'revoked' : (k.expiresAt && new Date(k.expiresAt) < now) ? 'expired' : 'active';
        var created = new Date(k.createdAt).toLocaleDateString();
        var lastUsed = k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : 'Never';
        return '<tr>'
          + '<td><code>' + k.prefix + '...</code></td>'
          + '<td>' + escapeHtmlJs(k.name) + '</td>'
          + '<td><span class="badge badge-' + status + '">' + status + '</span></td>'
          + '<td>' + created + '</td>'
          + '<td>' + lastUsed + '</td>'
          + '</tr>';
      }).join('');
    }

    // --- Clipboard ---
    function copyCode(btn) {
      var code = btn.closest('pre').querySelector('code');
      copyText(code.textContent, btn);
    }

    async function copyText(text, btn) {
      try {
        await navigator.clipboard.writeText(text);
        var orig = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(function() { btn.textContent = orig; }, 2000);
      } catch (e) {
        // Fallback
        var ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        var orig = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(function() { btn.textContent = orig; }, 2000);
      }
    }

    // --- Sign Out ---
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

    // --- Escape helper (client-side) ---
    function escapeHtmlJs(str) {
      var div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    }
  </script>
</body>
</html>`;
}

export function renderLoginPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Developer Portal &mdash; Sign In</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <meta name="theme-color" content="#0a0a0b">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Inter', ui-sans-serif, -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif; background: #0a0a0b; color: #f5f5f6; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { background: #141417; border: 1px solid #26262b; border-radius: 12px; padding: 2rem; width: 380px; }
    .card h1 { font-size: 1.25rem; margin-bottom: 0.25rem; }
    .card p { font-size: 0.85rem; color: #9a9ca3; margin-bottom: 1.5rem; }
    label { display: block; font-size: 0.8rem; color: #9a9ca3; margin-bottom: 0.25rem; }
    input { width: 100%; padding: 0.5rem 0.75rem; border-radius: 8px; border: 1px solid #26262b; background: #0e0e10; color: #f5f5f6; font-size: 0.875rem; margin-bottom: 1rem; font-family: inherit; }
    input:focus { outline: none; border-color: #f2612a; }
    button { width: 100%; padding: 0.6rem; background: #f2612a; color: #0a0a0b; border: none; border-radius: 8px; font-size: 0.875rem; cursor: pointer; font-family: inherit; font-weight: 600; }
    button:hover { background: #ff6a33; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .error { color: #ef4444; font-size: 0.8rem; margin-top: 0.75rem; min-height: 1.2em; }
    .toggle { text-align: center; font-size: 0.8rem; color: #9a9ca3; margin-top: 1.25rem; }
    .toggle a { color: #f2612a; text-decoration: none; }
    .toggle a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="card">
    <!-- Sign In Form -->
    <div id="signin-form">
      <h1>Developer Portal</h1>
      <p>Sign in to manage your API keys and view documentation.</p>
      <label for="signin-email">Email</label>
      <input type="email" id="signin-email" autocomplete="email" placeholder="you@example.com">
      <label for="signin-password">Password</label>
      <input type="password" id="signin-password" autocomplete="current-password" placeholder="Your password">
      <button id="signin-btn" onclick="signIn()">Sign In</button>
      <div class="error" id="signin-error"></div>
      <div class="toggle">Don't have an account? <a href="#" onclick="showForm('register'); return false;">Create one</a></div>
    </div>

    <!-- Register Form -->
    <div id="register-form" style="display:none">
      <h1>Create Account</h1>
      <p>Sign up to get started with the API.</p>
      <label for="register-name">Name</label>
      <input type="text" id="register-name" autocomplete="name" placeholder="Your name">
      <label for="register-email">Email</label>
      <input type="email" id="register-email" autocomplete="email" placeholder="you@example.com">
      <label for="register-password">Password</label>
      <input type="password" id="register-password" autocomplete="new-password" placeholder="Min. 8 characters">
      <button id="register-btn" onclick="register()">Create Account</button>
      <div class="error" id="register-error"></div>
      <div class="toggle">Already have an account? <a href="#" onclick="showForm('signin'); return false;">Sign in</a></div>
    </div>
  </div>
  <script>
    function showForm(name) {
      document.getElementById('signin-form').style.display = name === 'signin' ? 'block' : 'none';
      document.getElementById('register-form').style.display = name === 'register' ? 'block' : 'none';
      document.getElementById('signin-error').textContent = '';
      document.getElementById('register-error').textContent = '';
    }

    async function signIn() {
      var email = document.getElementById('signin-email').value.trim();
      var password = document.getElementById('signin-password').value;
      if (!email || !password) {
        document.getElementById('signin-error').textContent = 'Email and password are required.';
        return;
      }
      var btn = document.getElementById('signin-btn');
      btn.disabled = true;
      btn.textContent = 'Signing in...';
      document.getElementById('signin-error').textContent = '';
      try {
        var res = await fetch('/api/auth/sign-in/email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ email: email, password: password }),
        });
        if (res.ok) {
          window.location.href = '/portal';
        } else {
          var err = {};
          try { err = await res.json(); } catch(e) {}
          document.getElementById('signin-error').textContent = err.message || 'Invalid email or password.';
        }
      } catch (e) {
        document.getElementById('signin-error').textContent = 'Network error. Please try again.';
      } finally {
        btn.disabled = false;
        btn.textContent = 'Sign In';
      }
    }

    async function register() {
      var name = document.getElementById('register-name').value.trim();
      var email = document.getElementById('register-email').value.trim();
      var password = document.getElementById('register-password').value;
      if (!name || !email || !password) {
        document.getElementById('register-error').textContent = 'All fields are required.';
        return;
      }
      if (password.length < 8) {
        document.getElementById('register-error').textContent = 'Password must be at least 8 characters.';
        return;
      }
      var btn = document.getElementById('register-btn');
      btn.disabled = true;
      btn.textContent = 'Creating account...';
      document.getElementById('register-error').textContent = '';
      try {
        var res = await fetch('/api/auth/sign-up/email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ name: name, email: email, password: password }),
        });
        if (res.ok) {
          window.location.href = '/portal';
        } else {
          var err = {};
          try { err = await res.json(); } catch(e) {}
          document.getElementById('register-error').textContent = err.message || 'Registration failed. Email may already be in use.';
        }
      } catch (e) {
        document.getElementById('register-error').textContent = 'Network error. Please try again.';
      } finally {
        btn.disabled = false;
        btn.textContent = 'Create Account';
      }
    }

    document.getElementById('signin-password').addEventListener('keydown', function(e) {
      if (e.key === 'Enter') signIn();
    });
    document.getElementById('signin-email').addEventListener('keydown', function(e) {
      if (e.key === 'Enter') document.getElementById('signin-password').focus();
    });
    document.getElementById('register-password').addEventListener('keydown', function(e) {
      if (e.key === 'Enter') register();
    });
  </script>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ─── Admin dashboard ──────────────────────────────────────────────────────

export interface AdminPendingUser {
  id: string;
  email: string;
  name: string;
  createdAt: Date;
}

/**
 * Admin-side platform metrics. Computed in the route handler and
 * passed to the renderer; the renderer never touches Prisma so a UI
 * change can't accidentally widen the query surface.
 *
 * Counts are integers; the renderer formats them with thousands
 * separators. Dau/mau are distinct-user-id counts over the trailing
 * 24h / 30d in the activity_logs table.
 */
export interface AdminMetrics {
  engagement: {
    dau: number;
    mau: number;
    totalUsers: number;
    usersByRole: { admin: number; analyst: number; viewer: number; pending: number };
  };
  content: {
    signals: number;
    events: number;
    publishedAlerts: number;
    crises: number;
  };
  org: {
    organisations: number;
    teams: number;
  };
  newsletter: {
    configured: boolean;
    count: number | null;
    error?: string;
  };
}

export type AdminTab = "dashboard" | "pending" | "organisations";

interface AdminShellOptions {
  currentUserEmail: string;
  activeTab: AdminTab;
  pendingCount: number;
  flash?:
    | { kind: "success"; message: string }
    | { kind: "error"; message: string }
    | null;
  /** Inner HTML for the active tab. */
  content: string;
  /** Subtitle line shown under the page title (specific to the tab). */
  subtitle: string;
  /** Page title shown in the H1. */
  title: string;
}

/**
 * Shared `<head>` + nav + tab bar for both admin tabs. Both panels
 * embed inside this so the visual chrome is identical and a tab swap
 * is a single anchor click. Server-side rendering only — no JS
 * required.
 */
function renderAdminShell(opts: AdminShellOptions): string {
  const { currentUserEmail, activeTab, pendingCount, flash, content, subtitle, title } = opts;

  const flashHtml = !flash
    ? ""
    : `<div style="
        margin: 0 0 1.5rem;
        padding: 0.75rem 1rem;
        border-radius: var(--radius);
        background: ${flash.kind === "success" ? "#0d2818" : "#2a0c0c"};
        border: 1px solid ${flash.kind === "success" ? "var(--color-success)" : "var(--color-danger)"};
        color: ${flash.kind === "success" ? "var(--color-success)" : "var(--color-danger)"};
        font-size: 0.875rem;
      ">${escapeHtml(flash.message)}</div>`;

  const tabLink = (tab: AdminTab, label: string, badge?: string) => {
    const active = tab === activeTab;
    const badgeHtml = badge
      ? `<span style="display:inline-flex;align-items:center;justify-content:center;min-width:1.25rem;height:1.25rem;padding:0 0.4rem;margin-left:0.4rem;border-radius:999px;font-size:0.7rem;font-weight:600;background:${active ? "var(--color-accent)" : "var(--color-border)"};color:${active ? "var(--on-accent)" : "var(--color-muted)"};">${escapeHtml(badge)}</span>`
      : "";
    return `<a href="/portal/admin?tab=${tab}" class="admin-tab${active ? " active" : ""}">${escapeHtml(label)}${badgeHtml}</a>`;
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Admin · ${escapeHtml(title)}</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    :root {
      --color-bg: #0a0a0b; --color-surface: #141417; --color-border: #26262b;
      --color-accent: #f2612a; --color-accent-hover: #ff6a33;
      --color-text: #f5f5f6; --color-muted: #9a9ca3; --color-label: #75777e;
      --on-accent: #0a0a0b;
      --color-success: #22c55e; --color-danger: #ef4444; --color-warning: #f59e0b;
      --radius: 10px;
      --font: 'Inter', ui-sans-serif, -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif;
      --font-mono: 'JetBrains Mono', "SF Mono", "Fira Code", ui-monospace, monospace;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: var(--font); background: var(--color-bg); color: var(--color-text); line-height: 1.6; }
    a { color: var(--color-accent); text-decoration: none; }
    .nav { display: flex; align-items: center; justify-content: space-between; padding: 0.75rem 2rem; border-bottom: 1px solid var(--color-border); background: var(--color-surface); }
    .nav-brand { font-weight: 800; font-size: 1.05rem; }
    .nav-brand a { color: inherit; }
    .nav-brand .c { color: var(--color-accent); }
    .nav-user { font-size: 0.8rem; color: var(--color-muted); }

    /* Tabs */
    .admin-tabs { display: flex; gap: 0; padding: 0 2rem; border-bottom: 1px solid var(--color-border); background: var(--color-surface); }
    .admin-tab { padding: 0.85rem 1.2rem; color: var(--color-muted); text-decoration: none; font-size: 0.875rem; font-weight: 500; border-bottom: 2px solid transparent; display: inline-flex; align-items: center; transition: all 0.15s; }
    .admin-tab:hover { color: var(--color-text); }
    .admin-tab.active { color: var(--color-accent); border-bottom-color: var(--color-accent); }

    /* Content shell */
    .wrap { max-width: 1080px; margin: 0 auto; padding: 2.5rem 2rem; }
    h1 { font-size: 1.4rem; margin-bottom: 0.4rem; }
    h2 { font-size: 1rem; margin: 2rem 0 1rem; color: var(--color-muted); text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; }
    .subtitle { color: var(--color-muted); margin-bottom: 1.5rem; font-size: 0.95rem; }
    code { font-family: var(--font-mono); font-size: 0.8rem; color: var(--color-text); }

    /* Table */
    .table { width: 100%; border-collapse: collapse; background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius); overflow: hidden; }
    .table th { text-align: left; padding: 0.65rem 1rem; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--color-muted); border-bottom: 1px solid var(--color-border); background: var(--color-bg); }
    .table td { padding: 0.75rem 1rem; border-bottom: 1px solid var(--color-border); font-size: 0.875rem; }
    .table tr:last-child td { border-bottom: none; }
    .badge { display: inline-flex; align-items: center; padding: 0.2rem 0.6rem; border-radius: 999px; font-size: 0.7rem; font-weight: 600; }

    /* Buttons */
    .btn { border-radius: var(--radius); border: none; font-weight: 500; cursor: pointer; font-family: var(--font); }
    .btn-primary { background: var(--color-accent); color: var(--on-accent); }
    .btn-primary:hover { background: var(--color-accent-hover); }
    .btn-sm { padding: 0.35rem 0.8rem; font-size: 0.78rem; }

    /* Metric cards */
    .metric-grid { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); margin-bottom: 0.5rem; }
    .metric-card { background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius); padding: 1.25rem 1.25rem 1.1rem; transition: border-color 0.15s; }
    .metric-card:hover { border-color: var(--color-border); }
    .metric-card.accent { border-color: var(--color-accent); }
    .metric-label { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--color-muted); font-weight: 600; margin-bottom: 0.5rem; }
    .metric-value { font-size: 2rem; font-weight: 700; line-height: 1.1; color: var(--color-text); font-variant-numeric: tabular-nums; }
    .metric-card.accent .metric-value { color: var(--color-accent); }
    .metric-sub { font-size: 0.75rem; color: var(--color-muted); margin-top: 0.4rem; }
    .metric-breakdown { display: flex; flex-wrap: wrap; gap: 0.4rem 0.85rem; margin-top: 0.75rem; font-size: 0.78rem; color: var(--color-muted); }
    .metric-breakdown span strong { color: var(--color-text); font-weight: 600; }

    /* Forms */
    .form-card { background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius); padding: 1.25rem; margin-bottom: 1.5rem; }
    .form-grid { display: grid; gap: 0.85rem; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); align-items: end; }
    .form-field label { display: block; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--color-muted); margin-bottom: 0.35rem; font-weight: 600; }
    .form-field input, .form-field select { width: 100%; padding: 0.55rem 0.7rem; border-radius: var(--radius); border: 1px solid var(--color-border); background: var(--color-bg); color: var(--color-text); font-family: var(--font); font-size: 0.875rem; }
    .form-actions { display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center; }
    .btn-danger { background: transparent; color: var(--color-danger); border: 1px solid var(--color-danger); }
    .btn-danger:hover { background: #2a0c0c; }
    .inline-form { display: inline-flex; gap: 0.35rem; align-items: center; flex-wrap: wrap; }
    .note { font-size: 0.8rem; color: var(--color-muted); margin: 0.75rem 0 0; }
    .org-link { font-weight: 600; }
    .team-card { margin-bottom: 1.5rem; }
    .team-card h3 { font-size: 0.95rem; margin: 0 0 0.75rem; color: var(--color-text); text-transform: none; letter-spacing: normal; font-weight: 600; }
    .team-meta { font-size: 0.78rem; color: var(--color-muted); margin-bottom: 0.75rem; }
  </style>
</head>
<body>
  <nav class="nav">
    <div class="nav-brand"><a href="/portal">CLEAR<span class="c">_</span>API</a> &nbsp;<span style="color: var(--color-muted); font-weight: 500;">· Admin</span></div>
    <div class="nav-user">${escapeHtml(currentUserEmail)} &nbsp;|&nbsp; <a href="/portal">Portal</a></div>
  </nav>
  <div class="admin-tabs">
    ${tabLink("dashboard", "Dashboard")}
    ${tabLink("organisations", "Organisations")}
    ${tabLink("pending", "Pending Users", pendingCount > 0 ? String(pendingCount) : undefined)}
  </div>
  <main class="wrap">
    <h1>${escapeHtml(title)}</h1>
    <p class="subtitle">${subtitle}</p>
    ${flashHtml}
    ${content}
  </main>
</body>
</html>`;
}

/** Format an integer with thousands separators (en-US-style). */
function formatNumber(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
}

function teamRoleSelectOptions(selected: string): string {
  return ["team_member", "field_coordinator", "team_admin"]
    .map(
      (r) => `<option value="${r}"${selected === r ? " selected" : ""}>${r}</option>`,
    )
    .join("");
}

interface RenderAdminPendingOptions {
  currentUserEmail: string;
  pendingUsers: AdminPendingUser[];
  pendingCount: number;
  flash?:
    | { kind: "success"; message: string }
    | { kind: "error"; message: string }
    | null;
}

/**
 * "Pending Users" tab — the original admin page, now embedded in the
 * shared tab shell.
 */
export function renderAdminPending(opts: RenderAdminPendingOptions): string {
  const { currentUserEmail, pendingUsers, pendingCount, flash } = opts;
  const rows = pendingUsers.length === 0
    ? `<tr><td colspan="4" style="text-align: center; padding: 2rem; color: var(--color-muted);">No pending users — every signup has been approved.</td></tr>`
    : pendingUsers
        .map((u) => `
        <tr>
          <td>${escapeHtml(u.name)}</td>
          <td><code>${escapeHtml(u.email)}</code></td>
          <td><span class="badge" style="background: #2a1f0a; color: var(--color-warning);">PENDING</span></td>
          <td style="text-align: right;">
            <form method="POST" action="/portal/admin/approve" style="display: inline;">
              <input type="hidden" name="userId" value="${escapeHtml(u.id)}" />
              <button type="submit" class="btn btn-primary btn-sm">Approve</button>
            </form>
          </td>
        </tr>`)
        .join("");

  const content = `<table class="table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Email</th>
          <th>Status</th>
          <th style="text-align: right;">Action</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;

  return renderAdminShell({
    currentUserEmail,
    activeTab: "pending",
    pendingCount,
    flash,
    content,
    title: "Pending user approvals",
    subtitle: `${pendingUsers.length} user${pendingUsers.length === 1 ? "" : "s"} waiting for approval. Approving flips the user's role to <code>viewer</code> and moves their CRM contact from the prospects collection to the approved collection (firing the welcome email automation).`,
  });
}

interface RenderAdminMetricsOptions {
  currentUserEmail: string;
  metrics: AdminMetrics;
  pendingCount: number;
  flash?:
    | { kind: "success"; message: string }
    | { kind: "error"; message: string }
    | null;
}

/**
 * "Dashboard" tab — at-a-glance platform metrics in card grids.
 * Pure presentation; metric values come from the route handler so the
 * renderer never touches Prisma.
 */
export function renderAdminMetrics(opts: RenderAdminMetricsOptions): string {
  const { currentUserEmail, metrics, pendingCount, flash } = opts;
  const { engagement, content, org, newsletter } = metrics;

  const card = (
    label: string,
    value: number,
    sub: string,
    opts2?: { accent?: boolean; breakdownHtml?: string },
  ) => `
    <div class="metric-card${opts2?.accent ? " accent" : ""}">
      <div class="metric-label">${escapeHtml(label)}</div>
      <div class="metric-value">${formatNumber(value)}</div>
      <div class="metric-sub">${sub}</div>
      ${opts2?.breakdownHtml ?? ""}
    </div>`;

  const textCard = (
    label: string,
    value: string,
    sub: string,
    opts2?: { accent?: boolean },
  ) => `
    <div class="metric-card${opts2?.accent ? " accent" : ""}">
      <div class="metric-label">${escapeHtml(label)}</div>
      <div class="metric-value">${escapeHtml(value)}</div>
      <div class="metric-sub">${escapeHtml(sub)}</div>
    </div>`;

  const newsletterValue =
    newsletter.configured && newsletter.count !== null
      ? formatNumber(newsletter.count)
      : "—";
  const newsletterSub = !newsletter.configured
    ? "BUTTONDOWN_API_KEY not configured."
    : newsletter.error
      ? newsletter.error
      : "Subscribers on the public Buttondown list.";

  const usersBreakdown = `
    <div class="metric-breakdown">
      <span><strong>${formatNumber(engagement.usersByRole.admin)}</strong> admin</span>
      <span><strong>${formatNumber(engagement.usersByRole.analyst)}</strong> analyst</span>
      <span><strong>${formatNumber(engagement.usersByRole.viewer)}</strong> viewer</span>
      <span><strong>${formatNumber(engagement.usersByRole.pending)}</strong> pending</span>
    </div>`;

  const html = `
    <h2>Newsletter</h2>
    <div class="metric-grid">
      ${textCard("Newsletter subscribers", newsletterValue, newsletterSub, {
        accent: newsletter.configured && newsletter.count !== null,
      })}
    </div>

    <h2>Engagement</h2>
    <div class="metric-grid">
      ${card("Daily active users", engagement.dau, "Distinct users active in the last 24 hours.", { accent: true })}
      ${card("Monthly active users", engagement.mau, "Distinct users active in the last 30 days.")}
      ${card("Total users", engagement.totalUsers, "All registered accounts.", { breakdownHtml: usersBreakdown })}
    </div>

    <h2>Content</h2>
    <div class="metric-grid">
      ${card("Signals", content.signals, "Non-dummy signals ingested.")}
      ${card("Events", content.events, "Non-dummy events grouped from signals.")}
      ${card("Published alerts", content.publishedAlerts, "Alerts currently in the published state.")}
      ${card("Crises", content.crises, "Long-running crisis aggregates.")}
    </div>

    <h2>Organisations &amp; teams</h2>
    <div class="metric-grid">
      ${card("Organisations", org.organisations, "Tenant accounts on the platform.")}
      ${card("Teams", org.teams, "Sub-tenants across every organisation.")}
    </div>
    <p class="note" style="margin-top:0.25rem;"><a href="/portal/admin?tab=organisations">Manage organisations →</a></p>
  `;

  return renderAdminShell({
    currentUserEmail,
    activeTab: "dashboard",
    pendingCount,
    flash,
    content: html,
    title: "Platform dashboard",
    subtitle: "At-a-glance metrics for the CLEAR platform. Counts are live.",
  });
}

// ─── Organisations tab (SuperAdmin) ───────────────────────────────────────

export interface AdminOrgListRow {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
  memberCount: number;
  teamCount: number;
  createdAt: Date;
}

export interface AdminOrgDetailView {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
  createdAt: Date;
  teams: {
    id: string;
    name: string;
    slug: string;
    description: string | null;
    members: {
      userId: string;
      email: string;
      name: string;
      teamRole: string;
    }[];
  }[];
  members: {
    userId: string;
    email: string;
    name: string;
    globalRole: string | null;
    orgRole: string;
    joinedAt: Date;
  }[];
  importableTeams: { id: string; label: string; memberCount: number }[];
}

interface RenderAdminOrganisationsOptions {
  currentUserEmail: string;
  pendingCount: number;
  organisations: AdminOrgListRow[];
  flash?:
    | { kind: "success"; message: string }
    | { kind: "error"; message: string }
    | null;
}

export function renderAdminOrganisations(opts: RenderAdminOrganisationsOptions): string {
  const { currentUserEmail, pendingCount, organisations, flash } = opts;

  const rows =
    organisations.length === 0
      ? `<tr><td colspan="5" style="text-align:center;padding:2rem;color:var(--color-muted);">No organisations yet. Create one below.</td></tr>`
      : organisations
          .map(
            (o) => `
        <tr>
          <td><a class="org-link" href="/portal/admin?tab=organisations&amp;org=${escapeHtml(o.id)}">${escapeHtml(o.name)}</a></td>
          <td><code>${escapeHtml(o.slug)}</code></td>
          <td>${formatNumber(o.memberCount)}</td>
          <td>${formatNumber(o.teamCount)}</td>
          <td style="color:var(--color-muted);font-size:0.8rem;">${escapeHtml(o.createdAt.toISOString().slice(0, 10))}</td>
        </tr>`,
          )
          .join("");

  const content = `
    <table class="table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Slug</th>
          <th>Members</th>
          <th>Teams</th>
          <th>Created</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>

    <h2>Create organisation</h2>
    <div class="form-card">
      <form method="POST" action="/portal/admin/orgs/create">
        <div class="form-grid">
          <div class="form-field">
            <label for="org-name">Name</label>
            <input id="org-name" name="name" required placeholder="Acme Response" />
          </div>
          <div class="form-field">
            <label for="org-slug">Slug</label>
            <input id="org-slug" name="slug" required placeholder="acme-response" pattern="[a-z0-9]+(-[a-z0-9]+)*" />
          </div>
          <div class="form-actions">
            <button type="submit" class="btn btn-primary btn-sm">Create</button>
          </div>
        </div>
        <p class="note">A default team with the same name and slug is created automatically. The first member you invite or add becomes <code>org_admin</code> (portal convention — see backend gaps doc).</p>
      </form>
    </div>`;

  return renderAdminShell({
    currentUserEmail,
    activeTab: "organisations",
    pendingCount,
    flash,
    content,
    title: "Organisations",
    subtitle: "Create and manage tenant organisations. Open an organisation to invite users and set org-level roles.",
  });
}

interface RenderAdminOrgDetailOptions {
  currentUserEmail: string;
  pendingCount: number;
  org: AdminOrgDetailView;
  defaultInviteOrgRole: "org_admin" | "member";
  flash?:
    | { kind: "success"; message: string }
    | { kind: "error"; message: string }
    | null;
}

export function renderAdminOrgDetail(opts: RenderAdminOrgDetailOptions): string {
  const { currentUserEmail, pendingCount, org, defaultInviteOrgRole, flash } = opts;
  const orgParam = escapeHtml(org.id);

  const inviteOrgRoleOptions = ["org_admin", "member"]
    .map(
      (r) =>
        `<option value="${r}"${defaultInviteOrgRole === r ? " selected" : ""}>${r}</option>`,
    )
    .join("");

  const importOptions =
    org.importableTeams.length === 0
      ? `<option value="" disabled>No teams available to import</option>`
      : `<option value="">Select a team…</option>${org.importableTeams
          .map(
            (t) =>
              `<option value="${escapeHtml(t.id)}">${escapeHtml(t.label)} (${formatNumber(t.memberCount)} members)</option>`,
          )
          .join("")}`;

  // Build a per-user team count map for sole-team detection
  const teamCountByUser = new Map<string, number>();
  for (const t of org.teams) {
    for (const m of t.members) {
      teamCountByUser.set(m.userId, (teamCountByUser.get(m.userId) ?? 0) + 1);
    }
  }

  const teamSections = org.teams
    .map((team) => {
      const teamParam = escapeHtml(team.id);
      const memberRows =
        team.members.length === 0
          ? `<tr><td colspan="4" style="text-align:center;padding:1.25rem;color:var(--color-muted);font-size:0.85rem;">No members in this team yet.</td></tr>`
          : team.members
              .map((m) => `
        <tr>
          <td>${escapeHtml(m.name)}</td>
          <td><code>${escapeHtml(m.email)}</code></td>
          <td>
            <form class="inline-form" method="POST" action="/portal/admin/orgs/teams/members/role">
              <input type="hidden" name="orgId" value="${orgParam}" />
              <input type="hidden" name="teamId" value="${teamParam}" />
              <input type="hidden" name="userId" value="${escapeHtml(m.userId)}" />
              <select name="teamRole">${teamRoleSelectOptions(m.teamRole)}</select>
              <button type="submit" class="btn btn-sm" style="background:var(--color-border);color:var(--color-text);">Update</button>
            </form>
          </td>
          <td style="text-align:right;">
            <form method="POST" action="${teamCountByUser.get(m.userId) === 1 ? "/portal/admin/orgs/members/remove" : "/portal/admin/orgs/teams/members/remove"}" onsubmit="return confirm('${teamCountByUser.get(m.userId) === 1 ? "User will be removed from the organisation if removed from this team. Do you want to proceed?" : "Remove this user from the team?"}');">
              <input type="hidden" name="orgId" value="${orgParam}" />
              ${teamCountByUser.get(m.userId) === 1 ? "" : `<input type="hidden" name="teamId" value="${teamParam}" />`}
              <input type="hidden" name="userId" value="${escapeHtml(m.userId)}" />
              <button type="submit" class="btn btn-danger btn-sm">Remove</button>
            </form>
          </td>
        </tr>`)
              .join("");

      return `
    <div class="form-card team-card">
      <h3>${escapeHtml(team.name)}</h3>
      <p class="team-meta"><code>${escapeHtml(team.slug)}</code>${team.description ? ` · ${escapeHtml(team.description)}` : ""} · ${team.members.length} member${team.members.length === 1 ? "" : "s"}</p>
      <form method="POST" action="/portal/admin/orgs/teams/delete" style="margin-bottom:1rem;" onsubmit="return confirm('Delete this team? Members stay in the organisation.');">
        <input type="hidden" name="orgId" value="${orgParam}" />
        <input type="hidden" name="teamId" value="${teamParam}" />
        <button type="submit" class="btn btn-danger btn-sm">Delete team</button>
      </form>
      <table class="table" style="margin-bottom:1rem;">
        <thead>
          <tr>
            <th>Name</th>
            <th>Email</th>
            <th>Team role</th>
            <th style="text-align:right;">Actions</th>
          </tr>
        </thead>
        <tbody>${memberRows}</tbody>
      </table>
      <div class="form-grid">
        <div class="form-field" style="grid-column: 1 / -1;">
          <label>Invite to this team</label>
          <form method="POST" action="/portal/admin/orgs/invite">
            <input type="hidden" name="orgId" value="${orgParam}" />
            <input type="hidden" name="teamId" value="${teamParam}" />
            <div class="form-grid">
              <div class="form-field">
                <input name="email" type="email" required placeholder="user@example.com" />
              </div>
              <div class="form-field">
                <select name="orgRole">${inviteOrgRoleOptions}</select>
              </div>
              <div class="form-field">
                <select name="teamRole">${teamRoleSelectOptions("team_member")}</select>
              </div>
              <div class="form-actions">
                <button type="submit" class="btn btn-primary btn-sm">Send invite</button>
              </div>
            </div>
          </form>
        </div>
        <div class="form-field" style="grid-column: 1 / -1;">
          <label>Add existing user to this team</label>
          <form method="POST" action="/portal/admin/orgs/teams/members/add">
            <input type="hidden" name="orgId" value="${orgParam}" />
            <input type="hidden" name="teamId" value="${teamParam}" />
            <div class="form-grid">
              <div class="form-field">
                <input name="email" type="email" required placeholder="existing-user@example.com" />
              </div>
              <div class="form-field">
                <select name="teamRole">${teamRoleSelectOptions("team_member")}</select>
              </div>
              <div class="form-actions">
                <button type="submit" class="btn btn-primary btn-sm">Add to team</button>
              </div>
            </div>
          </form>
        </div>
      </div>
    </div>`;
    })
    .join("");

  const memberRows =
    org.members.length === 0
      ? `<tr><td colspan="5" style="text-align:center;padding:2rem;color:var(--color-muted);">No org members yet. Invite or add a user to a team below — the first member should be the org admin.</td></tr>`
      : org.members
          .map((m) => {
            const roleOptions = ["org_admin", "member"]
              .map(
                (r) =>
                  `<option value="${r}"${m.orgRole === r ? " selected" : ""}>${r}</option>`,
              )
              .join("");
            return `
        <tr>
          <td>
            <form class="inline-form" method="POST" action="/portal/admin/orgs/members/name">
              <input type="hidden" name="orgId" value="${orgParam}" />
              <input type="hidden" name="userId" value="${escapeHtml(m.userId)}" />
              <input name="name" value="${escapeHtml(m.name)}" size="18" />
              <button type="submit" class="btn btn-sm" style="background:var(--color-border);color:var(--color-text);">Save</button>
            </form>
          </td>
          <td><code>${escapeHtml(m.email)}</code></td>
          <td><span class="badge" style="background:#1a1a22;color:var(--color-muted);">${escapeHtml(m.globalRole ?? "—")}</span></td>
          <td>
            <form class="inline-form" method="POST" action="/portal/admin/orgs/members/role">
              <input type="hidden" name="orgId" value="${orgParam}" />
              <input type="hidden" name="userId" value="${escapeHtml(m.userId)}" />
              <select name="role">${roleOptions}</select>
              <button type="submit" class="btn btn-sm" style="background:var(--color-border);color:var(--color-text);">Update</button>
            </form>
          </td>
          <td style="text-align:right;">
            <form method="POST" action="/portal/admin/orgs/members/remove" onsubmit="return confirm('Remove this member from the organisation?');">
              <input type="hidden" name="orgId" value="${orgParam}" />
              <input type="hidden" name="userId" value="${escapeHtml(m.userId)}" />
              <button type="submit" class="btn btn-danger btn-sm">Remove</button>
            </form>
          </td>
        </tr>`;
          })
          .join("");

  const content = `
    <p style="margin-bottom:1.25rem;"><a href="/portal/admin?tab=organisations">← All organisations</a></p>

    <div class="form-card">
      <form method="POST" action="/portal/admin/orgs/update">
        <input type="hidden" name="orgId" value="${orgParam}" />
        <div class="form-grid">
          <div class="form-field">
            <label for="edit-name">Name</label>
            <input id="edit-name" name="name" value="${escapeHtml(org.name)}" required />
          </div>
          <div class="form-field">
            <label for="edit-slug">Slug</label>
            <input id="edit-slug" name="slug" value="${escapeHtml(org.slug)}" required pattern="[a-z0-9]+(-[a-z0-9]+)*" />
          </div>
          <div class="form-actions">
            <button type="submit" class="btn btn-primary btn-sm">Save changes</button>
          </div>
        </div>
      </form>
      <form method="POST" action="/portal/admin/orgs/delete" style="margin-top:1rem;" onsubmit="return confirm('Delete this organisation and all its teams, members, and invitations?');">
        <input type="hidden" name="orgId" value="${orgParam}" />
        <button type="submit" class="btn btn-danger btn-sm">Delete organisation</button>
      </form>
    </div>

    <h2>Teams</h2>
    ${teamSections || `<p class="note">No teams yet.</p>`}

    <h2>Create team</h2>
    <div class="form-card">
      <form method="POST" action="/portal/admin/orgs/teams/create">
        <input type="hidden" name="orgId" value="${orgParam}" />
        <div class="form-grid">
          <div class="form-field">
            <label for="team-name">Name</label>
            <input id="team-name" name="name" required placeholder="Field response" />
          </div>
          <div class="form-field">
            <label for="team-slug">Slug</label>
            <input id="team-slug" name="slug" required placeholder="field-response" pattern="[a-z0-9]+(-[a-z0-9]+)*" />
          </div>
          <div class="form-field">
            <label for="team-desc">Description (optional)</label>
            <input id="team-desc" name="description" placeholder="Optional" />
          </div>
          <div class="form-actions">
            <button type="submit" class="btn btn-primary btn-sm">Create empty team</button>
          </div>
        </div>
        <p class="note">New teams start with no members. Add or invite users per team below.</p>
      </form>
    </div>

    <h2>Import team</h2>
    <div class="form-card">
      <form method="POST" action="/portal/admin/orgs/teams/import">
        <input type="hidden" name="orgId" value="${orgParam}" />
        <div class="form-grid">
          <div class="form-field">
            <label for="import-team">Team from another organisation</label>
            <select id="import-team" name="sourceTeamId" required ${org.importableTeams.length === 0 ? "disabled" : ""}>${importOptions}</select>
          </div>
          <div class="form-actions">
            <button type="submit" class="btn btn-primary btn-sm" ${org.importableTeams.length === 0 ? "disabled" : ""}>Import team &amp; members</button>
          </div>
        </div>
        <p class="note">Copies the team into this organisation and adds all of its current members (creating org memberships when needed).</p>
      </form>
    </div>

    <h2>Organisation members</h2>
    <table class="table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Email</th>
          <th>Global role</th>
          <th>Org role</th>
          <th style="text-align:right;">Actions</th>
        </tr>
      </thead>
      <tbody>${memberRows}</tbody>
    </table>
    <p class="note">Org roles apply across all teams. Use the team sections above to add users to specific teams or send invites.</p>`;

  return renderAdminShell({
    currentUserEmail,
    activeTab: "organisations",
    pendingCount,
    flash,
    content,
    title: org.name,
    subtitle: `Organisation · <code>${escapeHtml(org.slug)}</code> · ${org.members.length} member${org.members.length === 1 ? "" : "s"} · ${org.teams.length} team${org.teams.length === 1 ? "" : "s"}`,
  });
}

// ─── Waiting-for-approval screen ──────────────────────────────────────────

export interface WaitingForApprovalOptions {
  userEmail: string;
}

/**
 * What a pending user sees when they hit /portal after signing up.
 * No tabs, no API key UI — just a confirmation that the account
 * exists and an admin will reach out by email once they're approved.
 */
export function renderWaitingForApproval(opts: WaitingForApprovalOptions): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Pending approval · CLEAR API</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    :root {
      --color-bg: #0a0a0b; --color-surface: #141417; --color-border: #26262b;
      --color-accent: #f2612a; --color-text: #f5f5f6; --color-muted: #9a9ca3;
      --color-warning: #f59e0b; --radius: 10px;
      --font: 'Inter', ui-sans-serif, -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: var(--font); background: var(--color-bg); color: var(--color-text); line-height: 1.6; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 2rem; }
    .card { max-width: 480px; width: 100%; background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius); padding: 2.5rem; text-align: center; }
    .badge { display: inline-block; padding: 0.3rem 0.75rem; border-radius: 999px; background: #2a1f0a; color: var(--color-warning); font-size: 0.72rem; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; margin-bottom: 1.25rem; }
    h1 { font-size: 1.4rem; margin-bottom: 0.75rem; }
    p { color: var(--color-muted); font-size: 0.95rem; margin-bottom: 1rem; }
    .email { color: var(--color-text); font-weight: 500; }
    .signout { margin-top: 1.5rem; display: inline-block; color: var(--color-muted); font-size: 0.85rem; text-decoration: underline; cursor: pointer; background: none; border: none; font-family: var(--font); }
    .signout:hover { color: var(--color-text); }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">Pending approval</div>
    <h1>Thanks for registering</h1>
    <p>You're signed in as <span class="email">${escapeHtml(opts.userEmail)}</span>. An admin will review your application and reach out by email once approved. You'll be able to access the developer dashboard at that point.</p>
    <p style="font-size: 0.85rem;">No action needed from you for now.</p>
    <button type="button" class="signout" onclick="signOut()">Sign out</button>
  </div>
  <script>
    // Better Auth's /api/auth/sign-out endpoint clears the session cookie
    // and responds with JSON. A plain HTML form POST would leave the
    // browser sitting on that JSON page; instead we fetch it from JS
    // then redirect back to /portal, which renders the login page now
    // that the session is gone. Mirrors the signOut() helper on the
    // main developer portal.
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
  </script>
</body>
</html>`;
}

const baseUrl = "https://your-api.example.com";
