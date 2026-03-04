export interface PortalOptions {
  userEmail: string;
}

export function renderPortal({ userEmail }: PortalOptions): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Developer Portal</title>
  <style>
    :root {
      --color-bg: #0f1117;
      --color-surface: #1a1d27;
      --color-border: #2e3347;
      --color-accent: #6366f1;
      --color-accent-hover: #4f52d4;
      --color-text: #e2e8f0;
      --color-muted: #8892a4;
      --color-success: #22c55e;
      --color-danger: #ef4444;
      --color-warning: #f59e0b;
      --color-code-bg: #12141c;
      --radius: 8px;
      --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      --font-mono: "SF Mono", "Fira Code", Consolas, monospace;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: var(--font); background: var(--color-bg); color: var(--color-text); line-height: 1.6; }
    a { color: var(--color-accent); text-decoration: none; }
    a:hover { text-decoration: underline; }

    /* Nav */
    .nav { display: flex; align-items: center; justify-content: space-between; padding: 0.75rem 2rem; border-bottom: 1px solid var(--color-border); background: var(--color-surface); }
    .nav-brand { font-weight: 700; font-size: 1rem; display: flex; align-items: center; gap: 0.5rem; }
    .nav-brand span { color: var(--color-accent); }
    .nav-user { font-size: 0.8rem; color: var(--color-muted); display: flex; align-items: center; gap: 1rem; }
    .nav-user button { background: none; border: 1px solid var(--color-border); color: var(--color-muted); padding: 0.3rem 0.75rem; border-radius: var(--radius); cursor: pointer; font-size: 0.75rem; }
    .nav-user button:hover { border-color: var(--color-danger); color: var(--color-danger); }

    /* Tabs */
    .tabs { display: flex; gap: 0; border-bottom: 1px solid var(--color-border); padding: 0 2rem; background: var(--color-surface); }
    .tab-btn { padding: 0.75rem 1.25rem; border: none; background: none; color: var(--color-muted); cursor: pointer; border-bottom: 2px solid transparent; font-size: 0.875rem; font-weight: 500; transition: all 0.15s; font-family: var(--font); }
    .tab-btn:hover { color: var(--color-text); }
    .tab-btn.active { color: var(--color-accent); border-bottom-color: var(--color-accent); }

    /* Tab panels */
    .tab-panel { padding: 2.5rem 2rem; max-width: 860px; margin: 0 auto; display: none; }
    .tab-panel.active { display: block; }
    .tab-panel h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
    .tab-panel h2 { font-size: 1.15rem; margin: 2rem 0 0.75rem; color: var(--color-text); }
    .tab-panel h3 { font-size: 1rem; margin: 1.5rem 0 0.5rem; color: var(--color-muted); }
    .tab-panel p { color: var(--color-muted); margin-bottom: 0.75rem; }
    .tab-panel ul { padding-left: 1.5rem; color: var(--color-muted); }
    .tab-panel li { margin: 0.4rem 0; }
    .subtitle { font-size: 1rem; color: var(--color-muted); margin-bottom: 2rem; }

    /* Code blocks */
    pre { background: var(--color-code-bg); border: 1px solid var(--color-border); border-radius: var(--radius); padding: 1rem; overflow-x: auto; position: relative; margin: 0.75rem 0; }
    code { font-family: var(--font-mono); font-size: 0.85rem; color: #a5f3fc; }
    p code, li code { background: var(--color-code-bg); padding: 0.15rem 0.4rem; border-radius: 4px; font-size: 0.8rem; }

    /* Copy button */
    .copy-btn { position: absolute; top: 0.5rem; right: 0.5rem; padding: 0.25rem 0.6rem; background: var(--color-border); border: none; border-radius: 4px; color: var(--color-muted); cursor: pointer; font-size: 0.75rem; font-family: var(--font); }
    .copy-btn:hover { background: var(--color-accent); color: #fff; }

    /* Steps */
    .steps { margin-top: 1rem; }
    .step { display: flex; gap: 1.25rem; margin: 1.75rem 0; }
    .step-num { width: 2rem; height: 2rem; border-radius: 50%; background: var(--color-accent); display: flex; align-items: center; justify-content: center; font-weight: 700; flex-shrink: 0; font-size: 0.875rem; color: #fff; }
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

    /* Buttons */
    .btn { padding: 0.5rem 1rem; border-radius: var(--radius); border: none; font-weight: 500; cursor: pointer; font-size: 0.875rem; transition: all 0.15s; font-family: var(--font); }
    .btn-primary { background: var(--color-accent); color: #fff; }
    .btn-primary:hover { background: var(--color-accent-hover); }
    .btn-danger { background: transparent; border: 1px solid var(--color-danger); color: var(--color-danger); }
    .btn-danger:hover { background: var(--color-danger); color: #fff; }
    .btn-sm { padding: 0.3rem 0.6rem; font-size: 0.75rem; }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }

    /* Key reveal */
    .key-reveal { background: #14532d; border: 1px solid #16a34a; border-radius: var(--radius); padding: 1rem 1.25rem; margin: 1rem 0; display: none; }
    .key-reveal.visible { display: block; }
    .key-reveal-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.5rem; }
    .key-reveal-header strong { color: #4ade80; }
    .key-reveal p { font-size: 0.8rem; color: #86efac; margin: 0; }
    .key-reveal code { color: #4ade80; word-break: break-all; display: block; margin-top: 0.5rem; background: #0f2d1a; padding: 0.5rem 0.75rem; border-radius: 4px; }

    /* Create form */
    .create-form { margin: 1.5rem 0; padding: 1.25rem; background: var(--color-surface); border-radius: var(--radius); border: 1px solid var(--color-border); }
    .create-form h3 { margin: 0 0 1rem; color: var(--color-text); }
    .form-row { display: flex; gap: 0.75rem; align-items: flex-end; flex-wrap: wrap; }
    .form-group label { display: block; font-size: 0.8rem; color: var(--color-muted); margin-bottom: 0.25rem; }
    input[type="text"], input[type="date"] { padding: 0.5rem 0.75rem; border-radius: var(--radius); border: 1px solid var(--color-border); background: var(--color-code-bg); color: var(--color-text); font-size: 0.875rem; font-family: var(--font); }
    input:focus { outline: none; border-color: var(--color-accent); }

    /* Notices */
    .notice { padding: 0.75rem 1rem; border-radius: var(--radius); margin: 1rem 0; font-size: 0.875rem; }
    .notice-warning { background: #451a03; border: 1px solid var(--color-warning); color: #fde68a; }
    .notice-info { background: #0c1a3a; border: 1px solid #3b82f6; color: #93c5fd; }

    .error-text { color: var(--color-danger); font-size: 0.875rem; margin-top: 0.5rem; }
    .empty-state { color: var(--color-muted); padding: 2rem; text-align: center; }
  </style>
</head>
<body>
  <nav class="nav">
    <div class="nav-brand"><span>&#9670;</span> Developer Portal</div>
    <div class="nav-user">
      <span>${escapeHtml(userEmail)}</span>
      <button onclick="signOut()">Sign Out</button>
    </div>
  </nav>

  <div class="tabs">
    <button class="tab-btn active" data-tab="getting-started" onclick="showTab('getting-started')">Getting Started</button>
    <button class="tab-btn" data-tab="api-keys" onclick="showTab('api-keys')">API Keys</button>
    <button class="tab-btn" data-tab="authentication" onclick="showTab('authentication')">Authentication</button>
    <button class="tab-btn" data-tab="reference" onclick="showTab('reference')">API Reference</button>
  </div>

  <!-- Getting Started -->
  <div id="tab-getting-started" class="tab-panel active">
    <h1>Getting Started</h1>
    <p class="subtitle">Start making authenticated API calls in minutes.</p>

    <div class="steps">
      <div class="step">
        <div class="step-num">1</div>
        <div class="step-content">
          <h3>Create an API Key</h3>
          <p>Go to the <a href="#api-keys" onclick="showTab('api-keys')">API Keys</a> tab and click <strong>Create Key</strong>. Give it a descriptive name like <code>my-app-prod</code>.</p>
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
  </div>

  <!-- API Keys -->
  <div id="tab-api-keys" class="tab-panel">
    <h1>API Keys</h1>
    <p>Manage your personal API keys. Maximum 10 active keys per account.</p>

    <div id="new-key-reveal" class="key-reveal">
      <div class="key-reveal-header">
        <strong>New key created &mdash; save this now!</strong>
        <button class="btn btn-primary btn-sm" onclick="copyText(document.getElementById('new-key-value').textContent, this)">Copy</button>
      </div>
      <p>This key is shown once and cannot be retrieved again.</p>
      <code id="new-key-value"></code>
    </div>

    <div class="create-form">
      <h3>Create New Key</h3>
      <div class="form-row">
        <div class="form-group">
          <label for="key-name">Name (required)</label>
          <input type="text" id="key-name" placeholder="my-app-prod" style="width:220px">
        </div>
        <div class="form-group">
          <label for="key-expires">Expires (optional)</label>
          <input type="date" id="key-expires">
        </div>
        <button class="btn btn-primary" id="create-btn" onclick="createKey()">Create Key</button>
      </div>
      <div id="create-error" class="error-text"></div>
    </div>

    <table class="key-table">
      <thead>
        <tr>
          <th>Key</th>
          <th>Name</th>
          <th>Status</th>
          <th>Last Used</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody id="key-table-body">
        <tr><td colspan="5" class="empty-state">Loading...</td></tr>
      </tbody>
    </table>
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

  <script>
    // --- Tab routing ---
    function showTab(name) {
      document.querySelectorAll('.tab-panel').forEach(function(p) { p.classList.remove('active'); });
      document.querySelectorAll('.tab-btn').forEach(function(b) { b.classList.remove('active'); });
      var panel = document.getElementById('tab-' + name);
      var btn = document.querySelector('[data-tab="' + name + '"]');
      if (panel) panel.classList.add('active');
      if (btn) btn.classList.add('active');
      history.replaceState(null, '', '#' + name);
      if (name === 'api-keys') loadApiKeys();
    }

    // Init from hash
    var initialTab = location.hash.slice(1) || 'getting-started';
    if (document.getElementById('tab-' + initialTab)) {
      showTab(initialTab);
    }

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

    async function loadApiKeys() {
      if (keysLoaded) return;
      var tbody = document.getElementById('key-table-body');
      tbody.innerHTML = '<tr><td colspan="5" class="empty-state">Loading...</td></tr>';
      try {
        var data = await gql('query { myApiKeys { id name prefix expiresAt lastUsedAt revokedAt createdAt } }');
        keysLoaded = true;
        renderKeyTable(data.myApiKeys);
      } catch (e) {
        tbody.innerHTML = '<tr><td colspan="5" class="error-text">' + e.message + '</td></tr>';
      }
    }

    function renderKeyTable(keys) {
      var tbody = document.getElementById('key-table-body');
      if (!keys.length) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty-state">No API keys yet. Create one above.</td></tr>';
        return;
      }
      tbody.innerHTML = keys.map(function(k) {
        var now = new Date();
        var status = k.revokedAt ? 'revoked' : (k.expiresAt && new Date(k.expiresAt) < now) ? 'expired' : 'active';
        var lastUsed = k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleDateString() : 'Never';
        return '<tr>'
          + '<td><code>' + k.prefix + '...</code></td>'
          + '<td>' + escapeHtmlJs(k.name) + '</td>'
          + '<td><span class="badge badge-' + status + '">' + status + '</span></td>'
          + '<td>' + lastUsed + '</td>'
          + '<td>' + (status === 'active'
            ? '<button class="btn btn-danger btn-sm" onclick="revokeKey(' + k.id + ', \\'' + escapeHtmlJs(k.name).replace(/'/g, "\\\\'") + '\\')">Revoke</button>'
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
        document.getElementById('new-key-value').textContent = data.createApiKey.key;
        document.getElementById('new-key-reveal').classList.add('visible');
        nameInput.value = '';
        expiresInput.value = '';
        keysLoaded = false;
        loadApiKeys();
      } catch (e) {
        showCreateError(e.message);
      } finally {
        btn.disabled = false;
        btn.textContent = 'Create Key';
      }
    }

    async function revokeKey(id, name) {
      if (!confirm('Revoke key "' + name + '"? This cannot be undone.')) return;
      try {
        await gql('mutation RevokeApiKey($id: Int!) { revokeApiKey(id: $id) { id revokedAt } }', { id: id });
        keysLoaded = false;
        loadApiKeys();
      } catch (e) {
        alert('Failed to revoke: ' + e.message);
      }
    }

    function showCreateError(msg) {
      document.getElementById('create-error').textContent = msg;
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
        await fetch('/api/auth/sign-out', { method: 'POST', credentials: 'include' });
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
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f1117; color: #e2e8f0; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { background: #1a1d27; border: 1px solid #2e3347; border-radius: 8px; padding: 2rem; width: 380px; }
    .card h1 { font-size: 1.25rem; margin-bottom: 0.25rem; }
    .card p { font-size: 0.85rem; color: #8892a4; margin-bottom: 1.5rem; }
    label { display: block; font-size: 0.8rem; color: #8892a4; margin-bottom: 0.25rem; }
    input { width: 100%; padding: 0.5rem 0.75rem; border-radius: 6px; border: 1px solid #2e3347; background: #12141c; color: #e2e8f0; font-size: 0.875rem; margin-bottom: 1rem; font-family: inherit; }
    input:focus { outline: none; border-color: #6366f1; }
    button { width: 100%; padding: 0.6rem; background: #6366f1; color: #fff; border: none; border-radius: 6px; font-size: 0.875rem; cursor: pointer; font-family: inherit; font-weight: 500; }
    button:hover { background: #4f52d4; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .error { color: #ef4444; font-size: 0.8rem; margin-top: 0.75rem; min-height: 1.2em; }
    .toggle { text-align: center; font-size: 0.8rem; color: #8892a4; margin-top: 1.25rem; }
    .toggle a { color: #6366f1; text-decoration: none; }
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

const baseUrl = "https://your-api.example.com";
