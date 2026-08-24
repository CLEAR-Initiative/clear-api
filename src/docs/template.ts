import type { SchemaData, SchemaField, SchemaType } from "./schema-introspect.js";
import {
  renderPortalShell,
  renderPortalShellStyles,
  renderPortalShellScript,
  type PortalShellOptions,
} from "../portal/shell.js";
import {
  buildTocTree,
  renderOnThisPage,
  renderOnThisPageScript,
  renderOnThisPageStyles,
} from "./on-this-page.js";

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderFieldRow(field: SchemaField): string {
  const args = field.args.length
    ? `<div class="field-args">${field.args
        .map(
          (a) =>
            `<span class="arg"><code>${escapeHtml(a.name)}: ${escapeHtml(a.type)}</code>${a.description ? ` — ${escapeHtml(a.description)}` : ""}</span>`,
        )
        .join("")}</div>`
    : "";
  return `<tr>
    <td><code>${escapeHtml(field.name)}</code></td>
    <td><code>${escapeHtml(field.type)}</code></td>
    <td>${field.description ? escapeHtml(field.description) : "—"}${args}</td>
  </tr>`;
}

function renderOperationSection(
  title: string,
  id: string,
  fields: SchemaField[],
  itemPrefix?: string,
): string {
  if (!fields.length) return "";

  // If itemPrefix is provided, render each field with its own anchor ID
  if (itemPrefix) {
    const rows = fields
      .map((field) => {
        const anchor = `${itemPrefix}-${field.name.toLowerCase()}`;
        const args = field.args.length
          ? `<div class="field-args">${field.args
              .map(
                (a) =>
                  `<span class="arg"><code>${escapeHtml(a.name)}: ${escapeHtml(a.type)}</code>${a.description ? ` — ${escapeHtml(a.description)}` : ""}</span>`,
              )
              .join("")}</div>`
          : "";
        return `<tr id="${anchor}">
    <td><code>${escapeHtml(field.name)}</code></td>
    <td><code>${escapeHtml(field.type)}</code></td>
    <td>${field.description ? escapeHtml(field.description) : "—"}${args}</td>
  </tr>`;
      })
      .join("");

    return `
    <h2 id="${id}">${escapeHtml(title)}</h2>
    <table class="ref-table">
      <thead><tr><th>Name</th><th>Returns</th><th>Description</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  }

  // Otherwise, render without individual anchors
  return `
    <h2 id="${id}">${escapeHtml(title)}</h2>
    <table class="ref-table">
      <thead><tr><th>Name</th><th>Returns</th><th>Description</th></tr></thead>
      <tbody>${fields.map(renderFieldRow).join("")}</tbody>
    </table>`;
}

function renderTypeSection(type: SchemaType): string {
  const anchor = `type-${type.name.toLowerCase()}`;
  let content = `<h3 id="${anchor}"><code>${escapeHtml(type.name)}</code> <span class="type-badge">${type.kind}</span></h3>`;
  if (type.description) {
    content += `<p>${escapeHtml(type.description)}</p>`;
  }

  if (type.kind === "enum") {
    content += `<table class="ref-table"><thead><tr><th>Value</th><th>Description</th></tr></thead><tbody>`;
    content += type.enumValues
      .map(
        (v) =>
          `<tr><td><code>${escapeHtml(v.name)}</code></td><td>${v.description ? escapeHtml(v.description) : "—"}</td></tr>`,
      )
      .join("");
    content += `</tbody></table>`;
  } else if (type.fields.length) {
    content += `<table class="ref-table"><thead><tr><th>Field</th><th>Type</th><th>Description</th></tr></thead><tbody>`;
    content += type.fields.map(renderFieldRow).join("");
    content += `</tbody></table>`;
  }

  return content;
}

/**
 * Render docs body content only (no chrome, no sidebars)
 * This HTML is prebuilt and cached, then wrapped per-request by composeDocsPage
 */
export function renderDocsBody(schema: SchemaData): string {
  return `
      <div id="section-guide">
        <h1 id="guide">Build Your First Integration</h1>
        <p class="subtitle">From zero knowledge to live humanitarian data in about ten minutes &mdash; the mental model, your first authenticated request, and two real queries.</p>

        <p>This is the front door. If you&rsquo;ve never touched the CLEAR API before, read this page top to bottom. By the end you&rsquo;ll understand how the data is shaped and you&rsquo;ll have pulled real records with your own API key. Everything else in these docs &mdash; the <a href="#queries">Queries</a>, <a href="#mutations">Mutations</a>, and <a href="#types">Types</a> reference &mdash; is there to look things up <em>after</em> you understand the shape of the system.</p>

        <h2 id="guide-model">1. The mental model</h2>
        <p>CLEAR is a five-tier graph. Source observations flow in at the bottom and are progressively grouped, classified, and escalated into human-readable advisories. Almost every query you write touches one of these five tiers:</p>

        <table class="feature-table">
          <thead><tr><th>Tier</th><th>What it represents</th></tr></thead>
          <tbody>
            <tr><td><a href="#type-location">Location</a></td><td>The administrative hierarchy &mdash; country &rarr; state &rarr; district &rarr; point. Everything else hangs off this tree.</td></tr>
            <tr><td><a href="#type-signal">Signal</a></td><td>A single source observation ingested from a source (Dataminr, ACLED, GDACS) or filed manually by a field officer. Upstream payloads are stored internally and are not returned on this type.</td></tr>
            <tr><td><a href="#type-event">Event</a></td><td>A cluster of related signals, classified by disaster type and bound to a district.</td></tr>
            <tr><td><a href="#type-alert">Alert</a></td><td>A published advisory raised from a severe event and delivered to subscribed users.</td></tr>
            <tr><td><a href="#type-crisis">Crisis</a></td><td>A user-curated aggregation of related events, enriched by an LLM with a summary, forward scenarios, and a needs analysis.</td></tr>
          </tbody>
        </table>

        <p>Two things to internalise. First, the tiers build <em>upward</em>: a <a href="#type-signal">Signal</a> links to the <a href="#type-event">Event</a> it belongs to, which links to any <a href="#type-alert">Alert</a> raised from it. Second, <em>everything is geolocated</em> &mdash; signals, events, and alerts all reference the <a href="#type-location">Location</a> hierarchy. That&rsquo;s why the &ldquo;by location&rdquo; queries are the most powerful way to slice the data.</p>

        <p>One staging area sits in front of tier 2. The <strong>ground staging tier</strong> holds staged Signals &mdash; messages ingested from ground sources such as WhatsApp groups (<a href="#type-groundmessage">GroundMessage</a>) &mdash; grouped into threads (<a href="#type-groundthread">GroundThread</a>). A thread is a cluster of staged Signals with a correction lifecycle; when a reviewer approves a thread for publication, it is promoted and becomes a <a href="#type-signal">Signal</a>. Nothing enters the signals graph from a ground source without passing that review gate.</p>

        <div class="notice notice-info">
          New to GraphQL? You send one <code>POST</code> request to <code>/graphql</code> with a query naming exactly the fields you want, and you get back exactly those fields &mdash; no over-fetching, no guessing at response shapes. The <a href="/graphql" target="_blank">GraphQL Sandbox</a> autocompletes every field as you type, which is the fastest way to explore.
        </div>

        <h2 id="guide-setup">2. Get set up</h2>
        <p>You need an account and an API key. Both live in the Developer Portal.</p>
        <div class="steps">
          <div class="step">
            <div class="step-num">1</div>
            <div class="step-content">
              <h4>Create an account</h4>
              <p>Sign up at the <a href="/portal">Developer Portal</a>. It takes about ten seconds.</p>
            </div>
          </div>
          <div class="step">
            <div class="step-num">2</div>
            <div class="step-content">
              <h4>Generate an API key</h4>
              <p>In the portal, open <a href="/portal#api-keys">API Keys</a> and create one. Copy it immediately &mdash; the full key is shown only once.</p>
            </div>
          </div>
        </div>
        <div class="notice notice-warning">
          Treat your key like a password. Keep it in an environment variable or secrets manager &mdash; never in client-side code or version control.
        </div>

        <h2 id="guide-first-request">3. Your first request</h2>
        <p>The <code>me</code> query is the simplest authenticated call: it returns the account your key belongs to. Run it first to confirm your key works before you touch real data. Replace <code>YOUR_API_KEY</code> with the key you just generated:</p>
        <pre><code>curl -X POST https://api.clearinitiative.io/graphql \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"query":"{ me { id email role } }"}'</code><button class="copy-btn" onclick="copyCode(this)">Copy</button></pre>
        <p>A successful response echoes your own user back:</p>
        <pre><code>{
  "data": {
    "me": {
      "id": "aBc123XyZ",
      "email": "you@example.com",
      "role": "viewer"
    }
  }
}</code><button class="copy-btn" onclick="copyCode(this)">Copy</button></pre>
        <p>If <code>me</code> comes back <code>null</code>, your key isn&rsquo;t being read &mdash; double-check the <code>Authorization</code> header and that the key hasn&rsquo;t been revoked in the portal.</p>

        <h2 id="guide-real-query">4. Pull real data</h2>
        <p>Now something useful. Locations are the backbone of the graph, so start there: this lists every country CLEAR tracks (hierarchy level <code>0</code>), with each one&rsquo;s id, name, and resident population.</p>
        <pre><code>curl -X POST https://api.clearinitiative.io/graphql \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"query":"{ locations(level: 0) { id name population } }"}'</code><button class="copy-btn" onclick="copyCode(this)">Copy</button></pre>
        <p>You&rsquo;ll get back an array of <a href="#type-location">Location</a> objects. Grab the <code>id</code> of a country that interests you &mdash; you&rsquo;ll feed it into the next query.</p>
        <div class="notice notice-info">
          <code>level</code> walks the hierarchy: <code>0</code> = country, <code>1</code> = state/province, <code>2</code> = city, and so on. Pass a country&rsquo;s <code>id</code> to <code>location(id: &hellip;)</code> and request <code>children</code> to drill down a level at a time.
        </div>

        <h2 id="guide-by-location">5. Slice by location</h2>
        <p>This is where it gets powerful. <code>eventsByLocation</code> returns every event whose origin, destination, or general location falls within a location <em>and all of its descendants</em> &mdash; so one country id gives you everything happening anywhere inside that country. Drop in the <code>id</code> from the previous step:</p>
        <pre><code>curl -X POST https://api.clearinitiative.io/graphql \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"query":"query($loc: String!) { eventsByLocation(locationId: $loc) { id title severity types generalLocation { name level } } }","variables":{"loc":"YOUR_LOCATION_ID"}}'</code><button class="copy-btn" onclick="copyCode(this)">Copy</button></pre>
        <p>Each <a href="#type-event">Event</a> comes back with a <code>severity</code> from 1 (low) to 5 (severe), its disaster-type <code>types</code> tags, and the place it&rsquo;s bound to. From any event you can follow the graph further &mdash; ask for its <code>signals</code> to see the source observations underneath (title, location, severity &mdash; not the upstream source payload), or its <code>alerts</code> to see what was escalated from it.</p>
        <div class="notice notice-info">
          The plain <code>events</code>, <code>signals</code>, and <code>alerts</code> lists are scoped to a team. If you&rsquo;re not an admin, pass a <code>teamId</code> for a team you belong to (find yours via the <code>myTeams</code> query). The <code>&hellip;ByLocation</code> queries shown here have no such requirement, which is why they&rsquo;re the easiest place to start.
        </div>

        <h2 id="guide-next">Where to go next</h2>
        <p>You now know the shape of the graph and how to authenticate, query, and slice by location. From here:</p>
        <ul>
          <li>Browse the full <a href="#queries">Queries</a> and <a href="#types">Types</a> reference below &mdash; it&rsquo;s auto-generated from the live schema, so it&rsquo;s always current.</li>
          <li>Open the <a href="/graphql" target="_blank">GraphQL Sandbox</a> to build queries interactively with field autocomplete.</li>
          <li>Read the <a href="#authentication">Authentication</a> section for the browser/cookie flow if you&rsquo;re building a web app rather than a server integration.</li>
          <li>Manage your keys anytime in the <a href="/portal">Developer Portal</a>.</li>
        </ul>
      </div>

      <div id="section-introduction" class="docs-section-block">
        <h1 id="introduction">Introduction</h1>
        <p class="subtitle">Welcome to the CLEAR API - your gateway to humanitarian intelligence.</p>

        <p>The CLEAR API gives you programmatic access to signals, events, alerts, data sources, and geographic location data through a single GraphQL endpoint. Whether you&rsquo;re building a monitoring dashboard, integrating alerts into your workflow, or analysing humanitarian patterns, this API has you covered.</p>

        <p>Everything here is accessible via GraphQL at <code>/graphql</code>. You send a query describing exactly the data you want, and you get back precisely that &mdash; nothing more, nothing less.</p>

        <h2 id="features">What You Can Do</h2>
        <table class="feature-table">
          <thead><tr><th>Feature</th><th>Description</th></tr></thead>
          <tbody>
            <tr><td><a href="#type-signal">Signals</a></td><td>Query verified source observations with location links and metadata. Upstream source payloads are not returned.</td></tr>
            <tr><td><a href="#type-event">Events</a></td><td>Browse grouped signals forming coherent narratives, with location, population, and type data.</td></tr>
            <tr><td><a href="#type-alert">Alerts</a></td><td>View events escalated for notification, delivered to subscribed users.</td></tr>
            <tr><td><a href="#type-datasource">Data Sources</a></td><td>Discover the external data feeds (ACLED, FEWS NET, social media monitors) that supply signals.</td></tr>
            <tr><td><a href="#type-location">Locations</a></td><td>Query a hierarchical geographic tree &mdash; countries, states, cities &mdash; with PostGIS geometry.</td></tr>
            <tr><td><a href="#type-disastertype">Disaster Types</a></td><td>Look up disaster classifications with GLIDE numbers.</td></tr>
            <tr><td><a href="#type-featureflag">Feature Flags</a></td><td>Check runtime feature toggles to adapt your application&rsquo;s behaviour.</td></tr>
            <tr><td><a href="#type-apikey">API Keys</a></td><td>Create and manage personal API keys for server-to-server authentication.</td></tr>
          </tbody>
        </table>
      </div>

      <div id="section-quickstart">
        <h2 id="quick-start">Quick Start</h2>
        <p>Go from zero to your first API response in three steps.</p>

        <div class="steps">
          <div class="step">
            <div class="step-num">1</div>
            <div class="step-content">
              <h4>Create an account</h4>
              <p>Head to the <a href="/portal">Developer Portal</a> and sign up. It takes about ten seconds.</p>
            </div>
          </div>
          <div class="step">
            <div class="step-num">2</div>
            <div class="step-content">
              <h4>Generate an API key</h4>
              <p>In the portal, go to <a href="/portal#api-keys">API Keys</a> and create one. Copy it immediately &mdash; you won&rsquo;t see it again.</p>
            </div>
          </div>
          <div class="step">
            <div class="step-num">3</div>
            <div class="step-content">
              <h4>Make your first query</h4>
              <p>Send a request with your key in the <code>Authorization</code> header:</p>
              <pre><code>curl -X POST https://api.clearinitiative.io/graphql \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"query":"{ me { id email } }"}'</code><button class="copy-btn" onclick="copyCode(this)">Copy</button></pre>
            </div>
          </div>
        </div>

        <p>Want to explore interactively? Open the <a href="/graphql" target="_blank">GraphQL Sandbox</a> to browse the full schema, autocomplete queries, and test requests in your browser.</p>
      </div>

      <div id="section-authentication">
        <h2 id="authentication">Authentication</h2>
        <p>Two ways to authenticate, depending on your use case.</p>

        <h3>API Keys (server-to-server)</h3>
        <p>Pass your key as a Bearer token in the <code>Authorization</code> header:</p>
        <pre><code>Authorization: Bearer sk_live_your_key_here</code><button class="copy-btn" onclick="copyCode(this)">Copy</button></pre>

        <div class="notice notice-warning">
          Never expose API keys in client-side code or version control. Store them in environment variables or a secrets manager.
        </div>

        <h3>Session Cookies (browser apps)</h3>
        <p>Sign in via the REST auth API. The session cookie is set automatically and sent with subsequent requests:</p>
        <pre><code>// Sign in
const res = await fetch('/api/auth/sign-in/email', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  credentials: 'include',
  body: JSON.stringify({ email: 'you@example.com', password: '...' }),
});

// Then query (cookie sent automatically)
const data = await fetch('/graphql', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  credentials: 'include',
  body: JSON.stringify({ query: '{ me { id email } }' }),
});</code><button class="copy-btn" onclick="copyCode(this)">Copy</button></pre>
      </div>

      <div id="section-reference">
        ${renderOperationSection("Queries", "queries", schema.queries)}
        ${renderOperationSection("Mutations", "mutations", schema.mutations, "mutation")}

        <h2 id="types">Types</h2>
        <p>All types in the schema, auto-generated from the running server.</p>
        ${schema.types.map(renderTypeSection).join("")}
      </div>
`;
}

/**
 * Compose full docs page: Portal Shell + body content + On This Page
 * Account is optional (null for anonymous visitors)
 */
export interface ComposeDocsPageOptions {
  bodyHtml: string;
  account: { email: string; role?: string | null } | null;
  types: SchemaType[];
  mutations: SchemaField[];
}

export function composeDocsPage(opts: ComposeDocsPageOptions): string {
  const { bodyHtml, account, types, mutations } = opts;
  
  const shellOpts: PortalShellOptions = {
    surface: "docs",
    account,
    activeHref: "/docs",
  };
  const shell = renderPortalShell(shellOpts);
  
  // Build structured On This Page tree with expand/collapse
  const tocTree = buildTocTree(types, mutations);
  const tocHtml = renderOnThisPage(tocTree);
  
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CLEAR API — Documentation</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <meta name="theme-color" content="#0a0a0b">
  ${renderPortalShellStyles()}
  <style>
    /* Docs-specific layout: Portal Shell | content | On This Page */
    ${renderOnThisPageStyles()}
    .docs-layout {
      display: flex;
      min-height: 100vh;
    }
    
    .docs-main {
      flex: 1;
      display: flex;
      gap: 2rem;
      padding-right: 2rem;
      min-width: 0;
      justify-content: center;
      max-width: 1400px;
      margin-right: auto;
    }
    
    /* Main content column - flex to fill available space */
    .docs-content {
      flex: 1;
      max-width: 780px;
      padding: 2.5rem 3rem;
      min-width: 0;
    }
    .docs-content h1 { font-size: 1.75rem; margin-bottom: 0.5rem; }
    /*
     * Equal inset: padding-top (== --docs-heading-inset) and margin-bottom.
     * TOC scroll uses block:start on this box so padding fills the top of the
     * viewport — previous section content stays scrolled out of view.
     */
    .docs-content h2 {
      font-size: 1.3rem;
      margin: 0 0 var(--docs-heading-inset, 2rem);
      padding-top: var(--docs-heading-inset, 2rem);
      border-top: 1px solid var(--color-border);
      scroll-margin-top: 0;
    }
    .docs-content h2:first-of-type { border-top: none; }
    .docs-content h3 {
      font-size: 1.05rem;
      margin: 0 0 var(--docs-heading-inset, 2rem);
      padding-top: var(--docs-heading-inset, 2rem);
      scroll-margin-top: 0;
    }
    .docs-content p { color: var(--color-muted); margin-bottom: 0.75rem; }
    .docs-content ul { padding-left: 1.5rem; color: var(--color-muted); margin-bottom: 0.75rem; }
    .docs-content li { margin: 0.3rem 0; }
    .docs-section-block { margin-top: 4rem; }
    .subtitle { font-size: 1rem; color: var(--color-muted); margin-bottom: 2rem; }
    
    /* Code */
    pre { background: var(--color-code-bg); border: 1px solid var(--color-border); border-radius: var(--radius); padding: 1rem; overflow-x: auto; position: relative; margin: 0.75rem 0; }
    code { font-family: var(--font-mono); font-size: 0.85rem; color: #cdd1d6; }
    p code, li code, td code { background: var(--color-code-bg); padding: 0.15rem 0.4rem; border-radius: 4px; font-size: 0.8rem; }
    .copy-btn { position: absolute; top: 0.5rem; right: 0.5rem; padding: 0.25rem 0.6rem; background: var(--color-border); border: none; border-radius: 4px; color: var(--color-muted); cursor: pointer; font-size: 0.75rem; font-family: var(--font); }
    .copy-btn:hover { background: var(--color-accent); color: var(--on-accent); }
    
    /* Reference tables */
    .ref-table { width: 100%; border-collapse: collapse; margin: 0.75rem 0 1.5rem; }
    .ref-table th { text-align: left; padding: 0.5rem 0.75rem; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--color-muted); border-bottom: 1px solid var(--color-border); }
    .ref-table td { padding: 0.6rem 0.75rem; border-bottom: 1px solid var(--color-border); font-size: 0.85rem; vertical-align: top; }
    .ref-table td:first-child { white-space: nowrap; }
    
    /* Field args */
    .field-args { margin-top: 0.35rem; }
    .field-args .arg { display: block; font-size: 0.78rem; color: var(--color-muted); padding-left: 0.5rem; border-left: 2px solid var(--color-border); margin-top: 0.2rem; }
    
    /* Type badge */
    .type-badge { font-size: 0.65rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; padding: 0.15rem 0.5rem; border-radius: 999px; vertical-align: middle; background: var(--color-border); color: var(--color-muted); }
    
    /* Feature table */
    .feature-table { width: 100%; border-collapse: collapse; margin: 1rem 0; }
    .feature-table th { text-align: left; padding: 0.6rem 1rem; font-size: 0.8rem; color: var(--color-muted); border-bottom: 1px solid var(--color-border); }
    .feature-table td { padding: 0.75rem 1rem; border-bottom: 1px solid var(--color-border); font-size: 0.875rem; }
    .feature-table td:first-child a { font-weight: 500; }
    
    /* Steps */
    .steps { margin-top: 1rem; }
    .step { display: flex; gap: 1.25rem; margin: 1.75rem 0; }
    .step-num { width: 2rem; height: 2rem; border-radius: 50%; background: var(--color-accent); display: flex; align-items: center; justify-content: center; font-weight: 700; flex-shrink: 0; font-size: 0.875rem; color: var(--on-accent); }
    .step-content h4 { margin: 0 0 0.25rem; color: var(--color-text); font-size: 0.95rem; }
    .step-content p { margin: 0.25rem 0; }
    
    /* Notice */
    .notice { padding: 0.75rem 1rem; border-radius: var(--radius); margin: 1rem 0; font-size: 0.875rem; }
    .notice-info { background: #11151c; border: 1px solid #2b3340; color: #aeb6c2; }
    .notice-warning { background: #451a03; border: 1px solid #f59e0b; color: #fde68a; }
    
    /* TOC link styles */
    .toc-heading {
      font-size: 0.7rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--color-muted);
      margin-bottom: 1rem;
    }
    .toc-link {
      display: block;
      font-size: 0.82rem;
      color: var(--color-muted);
      padding: 0.35rem 0;
      transition: color 0.15s;
      text-decoration: none;
    }
    .toc-link:hover {
      color: var(--color-text);
    }
    .toc-link.active {
      color: var(--color-accent);
      font-weight: 500;
    }
    /* Parent section stays highlighted while viewing its children */
    .toc-section.expanded .toc-parent {
      color: var(--color-accent);
    }
    /* Light orange for already-read items (above current) */
    .toc-link.read {
      color: rgba(255, 120, 43, 0.5);
    }
    .toc-link-type {
      font-size: 0.75rem;
      padding: 0.25rem 0 0.25rem 0.75rem;
    }
    
    /* Mobile: adjust main layout */
    @media (max-width: 1100px) {
      .docs-main {
        padding-right: 0;
      }
    }
    @media (max-width: 768px) {
      .docs-main {
        padding-right: 0;
      }
      .docs-content {
        padding: 1.5rem;
      }
    }
  </style>
</head>
<body>
  <div class="portal-shell docs-layout" id="portal-shell">
    ${shell}
    <div class="docs-main">
      <main class="docs-content">
        ${bodyHtml}
      </main>
      ${tocHtml}
    </div>
  </div>
  
  <script>
    // Copy to clipboard
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
  </script>
  <script>
    ${renderOnThisPageScript()}
  </script>
  ${renderPortalShellScript()}
</body>
</html>`;
}

