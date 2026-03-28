import type { SchemaData, SchemaField, SchemaType } from "./schema-introspect.js";

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

function renderOperationSection(title: string, id: string, fields: SchemaField[]): string {
  if (!fields.length) return "";
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

function renderSidebarTypeLinks(types: SchemaType[]): string {
  return types
    .map(
      (t) =>
        `<a href="#type-${t.name.toLowerCase()}" class="sidebar-link depth-2">${escapeHtml(t.name)}</a>`,
    )
    .join("");
}

export function renderDocsPage(schema: SchemaData): string {
  const _typesByKind = {
    scalar: schema.types.filter((t) => t.kind === "scalar"),
    enum: schema.types.filter((t) => t.kind === "enum"),
    input: schema.types.filter((t) => t.kind === "input"),
    object: schema.types.filter((t) => t.kind === "object"),
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CLEAR API — Documentation</title>
  <style>
    :root {
      --color-bg: #0f1117;
      --color-surface: #1a1d27;
      --color-border: #2e3347;
      --color-accent: #6366f1;
      --color-accent-hover: #4f52d4;
      --color-text: #e2e8f0;
      --color-muted: #8892a4;
      --color-code-bg: #12141c;
      --radius: 8px;
      --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      --font-mono: "SF Mono", "Fira Code", Consolas, monospace;
      --sidebar-width: 240px;
      --toc-width: 200px;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: var(--font); background: var(--color-bg); color: var(--color-text); line-height: 1.6; }
    a { color: var(--color-accent); text-decoration: none; }
    a:hover { text-decoration: underline; }

    /* Nav */
    .nav { display: flex; align-items: center; justify-content: space-between; padding: 0.75rem 2rem; border-bottom: 1px solid var(--color-border); background: var(--color-surface); position: sticky; top: 0; z-index: 100; }
    .nav-brand { font-weight: 700; font-size: 1rem; display: flex; align-items: center; gap: 0.5rem; color: var(--color-text); text-decoration: none; }
    .nav-brand span { color: var(--color-accent); }
    .nav-links { display: flex; align-items: center; gap: 1.5rem; }
    .nav-links a { font-size: 0.875rem; color: var(--color-muted); }
    .nav-links a:hover { color: var(--color-text); text-decoration: none; }

    /* Layout */
    .layout { display: flex; min-height: calc(100vh - 49px); }

    /* Left sidebar */
    .sidebar { width: var(--sidebar-width); flex-shrink: 0; border-right: 1px solid var(--color-border); background: var(--color-surface); padding: 1.5rem 0; position: sticky; top: 49px; height: calc(100vh - 49px); overflow-y: auto; }
    .sidebar-section { padding: 0 1.25rem; margin-bottom: 1.5rem; }
    .sidebar-heading { font-size: 0.7rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--color-muted); margin-bottom: 0.5rem; }
    .sidebar-link { display: block; font-size: 0.85rem; color: var(--color-muted); padding: 0.25rem 0; transition: color 0.1s; }
    .sidebar-link:hover { color: var(--color-text); text-decoration: none; }
    .sidebar-link.active { color: var(--color-accent); }
    .sidebar-link.depth-2 { padding-left: 0.75rem; font-size: 0.8rem; }

    /* Main content */
    .content { flex: 1; max-width: 780px; padding: 2.5rem 3rem; min-width: 0; }
    .content h1 { font-size: 1.75rem; margin-bottom: 0.5rem; }
    .content h2 { font-size: 1.3rem; margin: 2.5rem 0 0.75rem; padding-top: 1rem; border-top: 1px solid var(--color-border); }
    .content h2:first-of-type { border-top: none; padding-top: 0; }
    .content h3 { font-size: 1.05rem; margin: 2rem 0 0.5rem; }
    .content p { color: var(--color-muted); margin-bottom: 0.75rem; }
    .content ul { padding-left: 1.5rem; color: var(--color-muted); margin-bottom: 0.75rem; }
    .content li { margin: 0.3rem 0; }
    .subtitle { font-size: 1rem; color: var(--color-muted); margin-bottom: 2rem; }

    /* Right TOC */
    .toc { width: var(--toc-width); flex-shrink: 0; padding: 1.5rem 1rem; position: sticky; top: 49px; height: calc(100vh - 49px); overflow-y: auto; }
    .toc-heading { font-size: 0.7rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--color-muted); margin-bottom: 0.5rem; }
    .toc a { display: block; font-size: 0.78rem; color: var(--color-muted); padding: 0.2rem 0; }
    .toc a:hover { color: var(--color-text); text-decoration: none; }
    .toc a.active { color: var(--color-accent); }

    /* Code */
    pre { background: var(--color-code-bg); border: 1px solid var(--color-border); border-radius: var(--radius); padding: 1rem; overflow-x: auto; position: relative; margin: 0.75rem 0; }
    code { font-family: var(--font-mono); font-size: 0.85rem; color: #a5f3fc; }
    p code, li code, td code { background: var(--color-code-bg); padding: 0.15rem 0.4rem; border-radius: 4px; font-size: 0.8rem; }
    .copy-btn { position: absolute; top: 0.5rem; right: 0.5rem; padding: 0.25rem 0.6rem; background: var(--color-border); border: none; border-radius: 4px; color: var(--color-muted); cursor: pointer; font-size: 0.75rem; font-family: var(--font); }
    .copy-btn:hover { background: var(--color-accent); color: #fff; }

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
    .step-num { width: 2rem; height: 2rem; border-radius: 50%; background: var(--color-accent); display: flex; align-items: center; justify-content: center; font-weight: 700; flex-shrink: 0; font-size: 0.875rem; color: #fff; }
    .step-content h4 { margin: 0 0 0.25rem; color: var(--color-text); font-size: 0.95rem; }
    .step-content p { margin: 0.25rem 0; }

    /* Notice */
    .notice { padding: 0.75rem 1rem; border-radius: var(--radius); margin: 1rem 0; font-size: 0.875rem; }
    .notice-info { background: #0c1a3a; border: 1px solid #3b82f6; color: #93c5fd; }
    .notice-warning { background: #451a03; border: 1px solid #f59e0b; color: #fde68a; }

    /* Responsive */
    @media (max-width: 1100px) {
      .toc { display: none; }
    }
    @media (max-width: 800px) {
      .sidebar { display: none; }
      .content { padding: 1.5rem; }
    }
  </style>
</head>
<body>
  <nav class="nav">
    <a class="nav-brand" href="/"><span>&#9670;</span> CLEAR API</a>
    <div class="nav-links">
      <a href="/">Home</a>
      <a href="/portal">Developer Portal</a>
      <a href="/graphql">GraphQL Sandbox</a>
    </div>
  </nav>

  <div class="layout">
    <!-- Left sidebar -->
    <aside class="sidebar">
      <div class="sidebar-section">
        <div class="sidebar-heading">Get Started</div>
        <a href="#introduction" class="sidebar-link">Introduction</a>
        <a href="#quick-start" class="sidebar-link">Quick Start</a>
        <a href="#authentication" class="sidebar-link">Authentication</a>
      </div>
      <div class="sidebar-section">
        <div class="sidebar-heading">Features</div>
        <a href="#features" class="sidebar-link">Overview</a>
      </div>
      <div class="sidebar-section">
        <div class="sidebar-heading">API Reference</div>
        <a href="#queries" class="sidebar-link">Queries</a>
        <a href="#mutations" class="sidebar-link">Mutations</a>
        <a href="#types" class="sidebar-link">Types</a>
        ${renderSidebarTypeLinks(schema.types)}
      </div>
    </aside>

    <!-- Main content -->
    <main class="content">
      <div id="section-introduction">
        <p style="font-size:0.8rem;color:var(--color-muted);margin-bottom:0.25rem;">Docs &rsaquo; GET STARTED &rsaquo; <strong>Introduction</strong></p>
        <h1 id="introduction">Introduction</h1>
        <p class="subtitle">Welcome to the CLEAR API - your gateway to humanitarian intelligence.</p>

        <p>The CLEAR API gives you programmatic access to signals, events, alerts, data sources, and geographic location data through a single GraphQL endpoint. Whether you&rsquo;re building a monitoring dashboard, integrating alerts into your workflow, or analysing humanitarian patterns, this API has you covered.</p>

        <p>Everything here is accessible via GraphQL at <code>/graphql</code>. You send a query describing exactly the data you want, and you get back precisely that &mdash; nothing more, nothing less.</p>

        <h2 id="features">What You Can Do</h2>
        <table class="feature-table">
          <thead><tr><th>Feature</th><th>Description</th></tr></thead>
          <tbody>
            <tr><td><a href="#type-signal">Signals</a></td><td>Access raw data items collected from data sources, with location links and metadata.</td></tr>
            <tr><td><a href="#type-event">Events</a></td><td>Browse grouped signals forming coherent situations, with location, population, and type data.</td></tr>
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
        ${renderOperationSection("Mutations", "mutations", schema.mutations)}

        <h2 id="types">Types</h2>
        <p>All types in the schema, auto-generated from the running server.</p>
        ${schema.types.map(renderTypeSection).join("")}
      </div>
    </main>

    <!-- Right TOC -->
    <aside class="toc">
      <div class="toc-heading">On This Page</div>
      <a href="#introduction">Introduction</a>
      <a href="#features">What You Can Do</a>
      <a href="#quick-start">Quick Start</a>
      <a href="#authentication">Authentication</a>
      <a href="#queries">Queries</a>
      <a href="#mutations">Mutations</a>
      <a href="#types">Types</a>
    </aside>
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

    // Active sidebar link tracking
    var sidebarLinks = document.querySelectorAll('.sidebar-link');
    var headings = [];
    sidebarLinks.forEach(function(link) {
      var id = link.getAttribute('href');
      if (id && id.startsWith('#')) {
        var el = document.getElementById(id.slice(1));
        if (el) headings.push({ el: el, link: link });
      }
    });

    function updateActive() {
      var scrollY = window.scrollY + 80;
      var current = headings[0];
      for (var i = 0; i < headings.length; i++) {
        if (headings[i].el.offsetTop <= scrollY) current = headings[i];
      }
      sidebarLinks.forEach(function(l) { l.classList.remove('active'); });
      if (current) current.link.classList.add('active');
    }
    window.addEventListener('scroll', updateActive, { passive: true });
    updateActive();
  </script>
</body>
</html>`;
}
