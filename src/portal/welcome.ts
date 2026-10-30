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
  /** API-key milestones; both default to false. */
  apiKeys?: { created: boolean; used: boolean };
  errors?: ProfileFormErrors;
  flash?: { kind: "success" | "error"; message: string } | null;
}

// ─── Onboarding steps ──────────────────────────────────────────────────────
//
// Sign-up to first request, derived from existing rows (no stored state).
// Milestones are one-way: revoking every key doesn't un-tick "first key".
// The profile gates approval, so until it's saved the approval step is
// waiting on the developer, not on us.

/** Who has to act for a step to move. */
export type OnboardingActor = "you" | "team";

/**
 * - `done`: finished.
 * - `current`: the developer's next step (at most one).
 * - `todo`: the developer can do it now, but it isn't the next step.
 * - `waiting`: with the CLEAR team.
 * - `locked`: needs an earlier step first.
 */
export type OnboardingStepState = "done" | "current" | "todo" | "waiting" | "locked";

export interface OnboardingStep {
  key: "account" | "profile" | "approval" | "apiKey" | "firstRequest";
  title: string;
  actor: OnboardingActor;
  state: OnboardingStepState;
  detail: string;
  action?: { href: string; label: string };
}

export interface OnboardingProgress {
  approved: boolean;
  hasProfile: boolean;
  /** Any key ever created, revoked or not. */
  hasApiKey: boolean;
  /** Any key has authenticated a request. */
  hasUsedApiKey: boolean;
}

export function onboardingSteps(p: OnboardingProgress): OnboardingStep[] {
  const hasKey = p.hasApiKey || p.hasUsedApiKey;
  const steps: OnboardingStep[] = [
    {
      key: "account",
      title: "Create your account",
      actor: "you",
      state: "done",
      detail: "You're signed up and signed in.",
    },
    p.hasProfile
      ? {
          key: "profile",
          title: "Tell us about yourself",
          actor: "you",
          state: "done",
          detail: "Saved. You can update your details below at any time.",
        }
      : {
          key: "profile",
          title: "Tell us about yourself",
          actor: "you",
          state: "todo",
          detail: p.approved
            ? "Tell us what you'd like to work on so we can point you at the right things."
            : "Required before we can review your account.",
          action: { href: "#about-you", label: "Fill in your details" },
        },
    p.approved
      ? {
          key: "approval",
          title: "Get approved",
          actor: "team",
          state: "done",
          detail: "Approved. API access is unlocked.",
        }
      : p.hasProfile
        ? {
            key: "approval",
            title: "Get approved",
            actor: "team",
            state: "waiting",
            detail: "We're reviewing your account, usually within 24 hours. We'll email you when it's done.",
          }
        : {
            key: "approval",
            title: "Get approved",
            actor: "team",
            state: "locked",
            detail: "We start once you've told us about yourself. Reviews usually take under 24 hours.",
          },
    hasKey
      ? {
          key: "apiKey",
          title: "Create your first API key",
          actor: "you",
          state: "done",
          detail: "You have an API key.",
          action: { href: "/portal#api-keys", label: "Manage your keys" },
        }
      : {
          key: "apiKey",
          title: "Create your first API key",
          actor: "you",
          state: p.approved ? "todo" : "locked",
          detail: p.approved
            ? "Create a key to authenticate your requests."
            : "Unlocks once you're approved.",
          ...(p.approved ? { action: { href: "/portal#api-keys", label: "Create a key" } } : {}),
        },
    p.hasUsedApiKey
      ? {
          key: "firstRequest",
          title: "Make your first request",
          actor: "you",
          state: "done",
          detail: "Your key has made a request. You're all set.",
        }
      : {
          key: "firstRequest",
          title: "Make your first request",
          actor: "you",
          state: p.approved && hasKey ? "todo" : "locked",
          detail: !p.approved
            ? "Unlocks once you're approved."
            : hasKey
              ? "Send a query to /graphql with your key in the Authorization header."
              : "Needs an API key first.",
          ...(p.approved && hasKey
            ? { action: { href: "/portal#getting-started", label: "See the quick start" } }
            : {}),
        },
  ];

  const next = steps.find((s) => s.state === "todo");
  if (next) next.state = "current";
  return steps;
}

const STEP_STATE_LABEL: Record<OnboardingStepState, string> = {
  done: "Done",
  current: "Your next step",
  todo: "To do",
  waiting: "In review",
  locked: "Not yet available",
};

const STEP_ICONS = {
  check:
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="M3.5 8.5l3 3 6-7"/></svg>',
  clock:
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.8"/><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M8 4.75V8l2.25 1.5"/></svg>',
  lock:
    '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M8 1a3.5 3.5 0 0 0-3.5 3.5V6H3.75A1.75 1.75 0 0 0 2 7.75v5.5C2 14.216 2.784 15 3.75 15h8.5A1.75 1.75 0 0 0 14 13.25v-5.5A1.75 1.75 0 0 0 12.25 6H11.5V4.5A3.5 3.5 0 0 0 8 1Zm2 5H6V4.5a2 2 0 1 1 4 0V6Z"/></svg>',
};

/** One-line status above the steps: whose move it is. */
function progressHeadline(steps: OnboardingStep[]): string {
  const current = steps.find((s) => s.state === "current");
  if (current) return `Next: ${current.title.toLowerCase()}`;
  if (steps.some((s) => s.state === "waiting")) return "Over to us: we're reviewing your account";
  return "You're all set";
}

function renderStepMarker(step: OnboardingStep, index: number): string {
  switch (step.state) {
    case "done":
      return STEP_ICONS.check;
    case "waiting":
      return STEP_ICONS.clock;
    case "locked":
      return STEP_ICONS.lock;
    default:
      return String(index + 1);
  }
}

// ─── While you wait ────────────────────────────────────────────────────────
//
// Pending only: what a developer can do before they have a key, so the
// wait for approval is never a dead end.

const CONTRIBUTING_SETUP_URL =
  "https://github.com/CLEAR-Initiative/clear-api/blob/dev/CONTRIBUTING.md#explore-on-your-own-no-account-needed";

const REPOS = [
  { name: "clear-api", stack: "TypeScript · GraphQL · Prisma", blurb: "The API, database schema and auth. Everything else reads and writes through it." },
  { name: "clear-pipeline", stack: "Python · Dagster · LLMs", blurb: "Ingests crisis signals, classifies them with LLMs and builds the knowledge base." },
  { name: "clear-mvp", stack: "Next.js · React", blurb: "The web app NRC teams use in Sudan, Afghanistan and Venezuela." },
];

const EXTERNAL = ' target="_blank" rel="noopener noreferrer"';

function renderWhileYouWait(): string {
  const repos = REPOS.map(
    (r) => `<li>
                  <a class="welcome-repo" href="https://github.com/CLEAR-Initiative/${r.name}"${EXTERNAL}>
                    <span class="welcome-repo-name">${r.name}<span class="visually-hidden"> (opens in a new tab)</span></span>
                    <span class="welcome-repo-stack">${r.stack}</span>
                    <span class="welcome-repo-blurb">${r.blurb}</span>
                  </a>
                </li>`,
  ).join("\n                ");

  return `<div class="welcome-card welcome-wait" aria-labelledby="welcome-wait-title" role="region">
            <h2 id="welcome-wait-title">While you wait</h2>
            <p>You don't need approval to get started. Everything here is open now.</p>
            <ul class="welcome-wait-list">
              <li class="welcome-wait-item">
                <h3>Run CLEAR on your machine</h3>
                <p>Clone the API, run its tests and start a local copy with its own database. No account needed, just Bun, Git and Docker.</p>
                <a class="welcome-step-action" href="${CONTRIBUTING_SETUP_URL}"${EXTERNAL}>Read the setup guide <span aria-hidden="true">&nearr;</span><span class="visually-hidden"> (opens in a new tab)</span></a>
              </li>
              <li class="welcome-wait-item">
                <h3>Learn the API</h3>
                <p>Every query, mutation and type, so your first requests are ready when your key is.</p>
                <span class="welcome-wait-links">
                  <a class="welcome-step-action" href="/portal#getting-started">Getting started <span aria-hidden="true">&rarr;</span></a>
                  <a class="welcome-step-action" href="/portal#reference">API reference <span aria-hidden="true">&rarr;</span></a>
                  <a class="welcome-step-action" href="/docs">API docs <span aria-hidden="true">&rarr;</span></a>
                </span>
              </li>
              <li class="welcome-wait-item">
                <h3>Find your corner of the code</h3>
                <p>CLEAR is three open-source repos. Pick the one closest to what you'd like to work on.</p>
                <ul class="welcome-repos">
                ${repos}
                </ul>
              </li>
            </ul>
          </div>`;
}

function renderOnboardingSteps(steps: OnboardingStep[]): string {
  const doneCount = steps.filter((s) => s.state === "done").length;
  const items = steps
    .map((step, i) => {
      const actor = step.actor === "team" ? "CLEAR team" : "You";
      const status =
        step.state === "waiting" || step.state === "current"
          ? `<span class="welcome-step-status">${STEP_STATE_LABEL[step.state]}</span>`
          : `<span class="visually-hidden">${STEP_STATE_LABEL[step.state]}</span>`;
      const action = step.action
        ? `<a class="welcome-step-action" href="${escapeHtml(step.action.href)}">${escapeHtml(step.action.label)} <span aria-hidden="true">&rarr;</span></a>`
        : "";
      return `<li class="welcome-step welcome-step--${step.state}" data-step="${step.key}"${step.state === "current" ? ' aria-current="step"' : ""}>
              <span class="welcome-step-marker" aria-hidden="true">${renderStepMarker(step, i)}</span>
              <div class="welcome-step-body">
                <div class="welcome-step-head">
                  <span class="welcome-step-title">${escapeHtml(step.title)}</span>
                  <span class="welcome-step-actor">${actor}</span>
                  ${status}
                </div>
                <p class="welcome-step-detail">${escapeHtml(step.detail)}</p>
                ${action}
              </div>
            </li>`;
    })
    .join("\n            ");

  return `<div class="welcome-card welcome-progress">
            <div class="welcome-progress-head">
              <h2 id="welcome-progress-title">${escapeHtml(progressHeadline(steps))}</h2>
              <span class="welcome-progress-count">${doneCount} of ${steps.length} done</span>
            </div>
            <div class="welcome-progress-bar" role="progressbar" aria-labelledby="welcome-progress-title" aria-valuemin="0" aria-valuemax="${steps.length}" aria-valuenow="${doneCount}" aria-valuetext="${doneCount} of ${steps.length} steps done"><span style="width: ${Math.round((doneCount / steps.length) * 100)}%"></span></div>
            <ol class="welcome-steps" aria-label="Getting set up">
            ${items}
            </ol>
          </div>`;
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
  const { account, name, values, hasProfile, apiKeys, errors = {}, flash } = opts;
  const isPending = account.role === "pending";
  const steps = onboardingSteps({
    approved: !isPending,
    hasProfile,
    hasApiKey: apiKeys?.created ?? false,
    hasUsedApiKey: apiKeys?.used ?? false,
  });
  const sidebar = renderPortalShell({
    surface: "welcome",
    account,
    activeHref: "/portal/welcome",
  });

  const status = isPending
    ? `<span class="welcome-badge welcome-badge--pending">Pending approval</span>`
    : `<span class="welcome-badge welcome-badge--approved">Approved</span>`;

  const intro = isPending
    ? `<p>We've automatically requested API key access for your account. ${
        hasProfile
          ? "We're reviewing it now, usually within 24 hours, and you'll get an email as soon as it's approved."
          : "Tell us about yourself below so we can review it, usually within 24 hours. You'll get an email as soon as it's approved."
      }</p>
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
    #about-you { scroll-margin-top: 24px; }
    .welcome-card h2 { font-size: 17px; font-weight: 600; margin-bottom: 6px; }
    .welcome-card > p { color: var(--color-muted); font-size: 14px; line-height: 1.55; margin-bottom: 20px; }
    .welcome-progress-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
    .welcome-progress-head h2 { margin-bottom: 0; }
    .welcome-progress-count { font-size: 13px; color: var(--color-label); font-variant-numeric: tabular-nums; }
    .welcome-progress-bar { height: 4px; border-radius: 999px; background: var(--color-surface-3); overflow: hidden; margin-bottom: 22px; }
    .welcome-progress-bar > span { display: block; height: 100%; background: var(--color-success); border-radius: inherit; }
    .welcome-steps { list-style: none; margin: 0; padding: 0; }
    .welcome-step { position: relative; display: grid; grid-template-columns: 28px minmax(0, 1fr); gap: 14px; padding-bottom: 20px; }
    .welcome-step:last-child { padding-bottom: 0; }
    .welcome-step:not(:last-child)::after {
      content: ""; position: absolute; left: 13px; top: 32px; bottom: 4px; width: 2px;
      border-radius: 1px; background: var(--color-border);
    }
    .welcome-step--done:not(:last-child)::after { background: rgba(34, 197, 94, 0.35); }
    .welcome-step-marker {
      width: 28px; height: 28px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center;
      border: 2px solid var(--color-border-2); color: var(--color-muted);
      font-size: 12px; font-weight: 700; font-variant-numeric: tabular-nums; background: var(--color-bg);
    }
    .welcome-step--done .welcome-step-marker { border-color: transparent; background: rgba(34, 197, 94, 0.15); color: var(--color-success); }
    .welcome-step--current .welcome-step-marker { border-color: var(--color-accent); background: var(--color-accent-soft); color: var(--color-accent); }
    .welcome-step--waiting .welcome-step-marker { border-color: rgba(245, 158, 11, 0.55); background: rgba(245, 158, 11, 0.1); color: var(--color-warning); }
    .welcome-step--locked .welcome-step-marker { border-color: var(--color-border); color: var(--color-label); }
    .welcome-step-body { min-width: 0; padding-top: 3px; }
    .welcome-step-head { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 8px; }
    .welcome-step-title { font-size: 14.5px; font-weight: 600; color: var(--color-text); }
    .welcome-step--locked .welcome-step-title { color: var(--color-muted); }
    .welcome-step--done .welcome-step-title { color: var(--color-muted); }
    .welcome-step-actor {
      font-size: 11px; font-weight: 500; color: var(--color-label);
      padding: 1px 7px; border-radius: 999px; border: 1px solid var(--color-border);
    }
    .welcome-step-status { font-size: 11px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; }
    .welcome-step--current .welcome-step-status { color: var(--color-accent); }
    .welcome-step--waiting .welcome-step-status { color: var(--color-warning); }
    .welcome-step-detail { font-size: 13.5px; line-height: 1.5; color: var(--color-muted); margin-top: 3px; }
    .welcome-step--locked .welcome-step-detail { color: var(--color-label); }
    .welcome-step-action { display: inline-block; margin-top: 6px; font-size: 13.5px; font-weight: 600; color: var(--color-accent); text-decoration: none; }
    .welcome-step-action:hover { text-decoration: underline; }
    .welcome-step--done .welcome-step-action { font-weight: 500; color: var(--color-muted); }
    .welcome-wait > p { margin-bottom: 18px; }
    .welcome-wait-list { list-style: none; margin: 0; padding: 0; }
    .welcome-wait-item { padding: 16px 0; border-top: 1px solid var(--color-border); }
    .welcome-wait-item:last-child { padding-bottom: 0; }
    .welcome-wait-item h3 { font-size: 14.5px; font-weight: 600; color: var(--color-text); margin-bottom: 3px; }
    .welcome-wait-item > p { font-size: 13.5px; line-height: 1.5; color: var(--color-muted); }
    .welcome-wait-links { display: flex; flex-wrap: wrap; gap: 4px 18px; }
    .welcome-repos { list-style: none; margin: 12px 0 0; padding: 0; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
    .welcome-repo {
      display: flex; flex-direction: column; gap: 4px; height: 100%; padding: 12px 14px;
      border: 1px solid var(--color-border); border-radius: var(--radius-sm);
      background: var(--color-bg); text-decoration: none; transition: border-color 0.15s;
    }
    .welcome-repo:hover { border-color: var(--color-accent-border); }
    .welcome-repo-name { font-family: var(--font-mono); font-size: 13px; font-weight: 600; color: var(--color-accent); }
    .welcome-repo-stack { font-size: 11.5px; color: var(--color-label); }
    .welcome-repo-blurb { font-size: 12.5px; line-height: 1.45; color: var(--color-muted); }
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
      #about-you { scroll-margin-top: 72px; }
      .welcome-grid { grid-template-columns: minmax(0, 1fr); }
      .welcome-repos { grid-template-columns: minmax(0, 1fr); }
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

          ${renderOnboardingSteps(steps)}

          ${isPending && hasProfile ? renderWhileYouWait() : ""}

          <div class="welcome-card" id="about-you">
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

          ${isPending && !hasProfile ? renderWhileYouWait() : ""}
        </section>
      </div>
    </main>
  </div>
  ${flash ? renderPortalToast(flash) : ""}
  ${renderPortalShellScript()}
</body>
</html>`;
}
