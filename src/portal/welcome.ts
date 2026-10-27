/**
 * Developer Portal Welcome page (`/portal/welcome`).
 *
 * Where a self-registered Developer lands after sign-up: what happens
 * next, plus a form to tell us who they are and what they'd like to
 * contribute. Every signed-in user can reach it from the "Welcome" nav
 * item to update their details later. Server-rendered inside the shared
 * Portal Shell (ADR-0004); the form is a plain POST, no client JS.
 */

import {
  renderPortalShell,
  renderPortalShellScript,
  renderPortalShellStylesheetLink,
  renderPortalToast,
} from "./shell.js";
import { renderFontLinks } from "../ui/theme.js";
import { renderIconLinks } from "../ui/icons.js";
import {
  PROFILE_LIMITS,
  type DeveloperProfileDetails,
  type ProfileFormErrors,
  type ProfileFormField,
} from "../services/developer-profile.js";

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface WelcomePageOptions {
  account: { email: string; role?: string | null };
  /** The account's saved name (heading); not the submitted one. */
  name: string;
  /** Values to show in the form: saved profile, or the rejected submission. */
  values: Record<ProfileFormField, string>;
  /** True once a profile row exists — switches the button label. */
  hasProfile: boolean;
  errors?: ProfileFormErrors;
  flash?: { kind: "success" | "error"; message: string } | null;
}

/** Form values for a user and their (possibly missing) saved profile. */
export function welcomeFormValues(
  name: string,
  profile: DeveloperProfileDetails | null,
): Record<ProfileFormField, string> {
  return {
    name,
    personalWebsite: profile?.personalWebsite ?? "",
    organisation: profile?.organisation ?? "",
    organisationWebsite: profile?.organisationWebsite ?? "",
    linkedinUrl: profile?.linkedinUrl ?? "",
    githubUrl: profile?.githubUrl ?? "",
    contributionInterest: profile?.contributionInterest ?? "",
  };
}

interface FieldSpec {
  key: Exclude<ProfileFormField, "contributionInterest">;
  label: string;
  placeholder: string;
  autocomplete: string;
  maxlength: number;
  url?: boolean;
  required?: boolean;
}

const FIELDS: FieldSpec[] = [
  { key: "name", label: "Name", placeholder: "Your name", autocomplete: "name", maxlength: PROFILE_LIMITS.name, required: true },
  { key: "personalWebsite", label: "Personal website", placeholder: "https://", autocomplete: "url", maxlength: PROFILE_LIMITS.url, url: true },
  { key: "organisation", label: "Organisation you're affiliated with", placeholder: "e.g. NRC, a university, independent", autocomplete: "organization", maxlength: PROFILE_LIMITS.organisation },
  { key: "organisationWebsite", label: "Organisation website", placeholder: "https://", autocomplete: "off", maxlength: PROFILE_LIMITS.url, url: true },
  { key: "linkedinUrl", label: "LinkedIn URL", placeholder: "https://www.linkedin.com/in/…", autocomplete: "off", maxlength: PROFILE_LIMITS.url, url: true },
  { key: "githubUrl", label: "GitHub profile URL", placeholder: "https://github.com/…", autocomplete: "off", maxlength: PROFILE_LIMITS.url, url: true },
];

function renderField(
  spec: FieldSpec,
  value: string,
  error: string | undefined,
): string {
  const id = `welcome-${spec.key}`;
  const errorId = `${id}-error`;
  const optional = spec.required ? "" : ` <span class="welcome-optional">Optional</span>`;
  const describedBy = error ? ` aria-describedby="${errorId}" aria-invalid="true"` : "";
  return `<div class="form-field welcome-field${error ? " has-error" : ""}">
          <label for="${id}">${escapeHtml(spec.label)}${optional}</label>
          <input id="${id}" name="${spec.key}" type="text"${spec.url ? ' inputmode="url" spellcheck="false" autocapitalize="off"' : ""} autocomplete="${spec.autocomplete}" maxlength="${spec.maxlength}" placeholder="${escapeHtml(spec.placeholder)}" value="${escapeHtml(value)}"${spec.required ? " required" : ""}${describedBy}>
          ${error ? `<p class="welcome-error" id="${errorId}">${escapeHtml(error)}</p>` : ""}
        </div>`;
}

export function renderWelcomePage(opts: WelcomePageOptions): string {
  const { account, name, values, hasProfile, errors = {}, flash } = opts;
  const isPending = account.role === "pending";
  const sidebar = renderPortalShell({
    surface: "welcome",
    account,
    activeHref: "/portal/welcome",
  });

  const status = isPending
    ? `<span class="welcome-badge welcome-badge--pending">Pending approval</span>`
    : `<span class="welcome-badge welcome-badge--approved">Approved</span>`;

  const intro = isPending
    ? `<p>We've automatically requested API key access for your account. You'll get an email as soon as it's approved.</p>
        <p>The CLEAR maintainer has been told you've signed up and will get in touch about contributing.</p>`
    : `<p>Your account is approved. Create and manage keys under <a href="/portal#api-keys">API Keys</a>.</p>`;

  const fieldByKey = new Map(FIELDS.map((f) => [f.key, f]));
  const field = (key: FieldSpec["key"]) =>
    renderField(fieldByKey.get(key)!, values[key], errors[key]);

  const interestError = errors.contributionInterest;
  const interestDescribedBy = interestError
    ? "welcome-contributionInterest-hint welcome-contributionInterest-error"
    : "welcome-contributionInterest-hint";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Welcome · CLEAR Developer Portal</title>
  ${renderIconLinks()}
  <meta name="theme-color" content="#0a0a0b">
  ${renderFontLinks()}
  ${renderPortalShellStylesheetLink()}
  <style>
    .main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
    .main-content { flex: 1; padding: 48px 32px 64px; }
    .welcome { max-width: 720px; }
    .welcome-badge {
      display: inline-block; padding: 0.25rem 0.7rem; border-radius: 999px;
      font-size: 0.7rem; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase;
      margin-bottom: 1rem;
    }
    .welcome-badge--pending { background: rgba(245, 158, 11, 0.12); color: var(--color-warning); border: 1px solid rgba(245, 158, 11, 0.35); }
    .welcome-badge--approved { background: rgba(34, 197, 94, 0.12); color: var(--color-success); border: 1px solid rgba(34, 197, 94, 0.35); }
    .welcome h1 { font-size: 28px; line-height: 1.25; font-weight: 700; letter-spacing: -0.02em; margin-bottom: 16px; overflow-wrap: anywhere; }
    .welcome-intro p { color: var(--color-muted); font-size: 15px; line-height: 1.6; margin-bottom: 10px; }
    .welcome-card {
      margin-top: 32px; padding: 24px; background: var(--color-surface);
      border: 1px solid var(--color-border); border-radius: var(--radius);
    }
    .welcome-card h2 { font-size: 17px; font-weight: 600; margin-bottom: 6px; }
    .welcome-card > p { color: var(--color-muted); font-size: 14px; line-height: 1.55; margin-bottom: 20px; }
    .welcome-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px 20px; }
    .welcome-field--wide { grid-column: 1 / -1; }
    .welcome-field label { display: block; font-size: 13px; font-weight: 500; color: var(--color-text); margin-bottom: 6px; }
    .welcome-optional { font-weight: 400; color: var(--color-label); font-size: 12px; margin-left: 4px; }
    .welcome-field textarea {
      width: 100%; min-height: 120px; resize: vertical; padding: 0.6rem 0.7rem;
      border-radius: var(--radius-sm); border: 1px solid var(--color-border);
      background: var(--color-bg); color: var(--color-text); font-family: var(--font);
      font-size: 0.875rem; line-height: 1.5; color-scheme: dark;
    }
    .welcome-field textarea:hover { border-color: var(--color-border-2); }
    .welcome-field textarea:focus { outline: none; border-color: var(--color-accent); }
    .welcome-field.has-error input,
    .welcome-field.has-error textarea { border-color: var(--color-danger); }
    .welcome-hint { font-size: 12px; color: var(--color-label); margin-top: 6px; line-height: 1.45; }
    .welcome-error { font-size: 12px; color: var(--color-danger); margin-top: 6px; }
    .welcome-actions { display: flex; justify-content: flex-end; margin-top: 24px; }
    .welcome-submit {
      display: inline-flex; align-items: center; justify-content: center;
      min-height: 44px; padding: 10px 24px; border-radius: var(--radius);
      border: none; background: var(--color-accent); color: var(--on-accent);
      font-size: 14px; font-weight: 700; cursor: pointer; font-family: var(--font);
    }
    .welcome-submit:hover { background: var(--color-accent-hover); }
    @media (max-width: 768px) {
      .main-content { padding: 72px 16px 40px; }
      .welcome h1 { font-size: 24px; }
      .welcome-card { padding: 18px 16px; }
      .welcome-grid { grid-template-columns: minmax(0, 1fr); }
      .welcome-submit { width: 100%; }
    }
  </style>
</head>
<body>
  <div class="portal-shell" id="portal-shell">
    ${sidebar}
    <main class="main">
      <div class="main-content">
        <section class="welcome" aria-labelledby="welcome-title">
          ${status}
          <h1 id="welcome-title">Welcome to CLEAR, ${escapeHtml(name || "developer")}.</h1>
          <div class="welcome-intro">
            ${intro}
          </div>

          <div class="welcome-card">
            <h2>About you</h2>
            <p>Tell us a bit about yourself, and especially what kind of contribution you'd like to make. It helps us point you at the right work.</p>
            <form method="POST" action="/portal/welcome">
              <div class="welcome-grid">
                ${field("name")}
                ${field("organisation")}
                ${field("organisationWebsite")}
                ${field("personalWebsite")}
                ${field("linkedinUrl")}
                ${field("githubUrl")}
                <div class="form-field welcome-field welcome-field--wide${interestError ? " has-error" : ""}">
                  <label for="welcome-contributionInterest">What would you like to contribute? <span class="welcome-optional">Optional</span></label>
                  <textarea id="welcome-contributionInterest" name="contributionInterest" maxlength="${PROFILE_LIMITS.contributionInterest}" aria-describedby="${interestDescribedBy}"${interestError ? ' aria-invalid="true"' : ""}>${escapeHtml(values.contributionInterest)}</textarea>
                  <p class="welcome-hint" id="welcome-contributionInterest-hint">For example: frontend, the API, the data pipeline and LLMs, data or domain expertise, docs, or something else.</p>
                  ${interestError ? `<p class="welcome-error" id="welcome-contributionInterest-error">${escapeHtml(interestError)}</p>` : ""}
                </div>
              </div>
              <div class="welcome-actions">
                <button type="submit" class="welcome-submit">${hasProfile ? "Save changes" : "Save details"}</button>
              </div>
            </form>
          </div>
        </section>
      </div>
    </main>
  </div>
  ${flash ? renderPortalToast(flash) : ""}
  ${renderPortalShellScript()}
</body>
</html>`;
}
