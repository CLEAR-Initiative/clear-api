export function renderHomePage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CLEAR API</title>
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
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: var(--font); background: var(--color-bg); color: var(--color-text); line-height: 1.6; }
    a { color: var(--color-accent); text-decoration: none; }
    a:hover { text-decoration: underline; }

    /* Nav */
    .nav { display: flex; align-items: center; justify-content: space-between; padding: 0.75rem 2rem; border-bottom: 1px solid var(--color-border); background: var(--color-surface); }
    .nav-brand { font-weight: 700; font-size: 1rem; display: flex; align-items: center; gap: 0.5rem; color: var(--color-text); text-decoration: none; }
    .nav-brand span { color: var(--color-accent); }
    .nav-links { display: flex; align-items: center; gap: 1.5rem; }
    .nav-links a { font-size: 0.875rem; color: var(--color-muted); }
    .nav-links a:hover { color: var(--color-text); text-decoration: none; }

    /* Hero */
    .hero { text-align: center; padding: 5rem 2rem 4rem; max-width: 700px; margin: 0 auto; }
    .hero h1 { font-size: 2.5rem; font-weight: 800; margin-bottom: 1rem; letter-spacing: -0.02em; }
    .hero h1 em { font-style: normal; color: var(--color-accent); }
    .hero p { font-size: 1.125rem; color: var(--color-muted); margin-bottom: 2rem; max-width: 540px; margin-left: auto; margin-right: auto; }
    .hero-actions { display: flex; gap: 1rem; justify-content: center; flex-wrap: wrap; }

    /* Buttons */
    .btn { padding: 0.6rem 1.25rem; border-radius: var(--radius); border: none; font-weight: 500; cursor: pointer; font-size: 0.875rem; transition: all 0.15s; font-family: var(--font); text-decoration: none; display: inline-block; }
    .btn:hover { text-decoration: none; }
    .btn-primary { background: var(--color-accent); color: #fff; }
    .btn-primary:hover { background: var(--color-accent-hover); }
    .btn-outline { background: transparent; border: 1px solid var(--color-border); color: var(--color-text); }
    .btn-outline:hover { border-color: var(--color-accent); color: var(--color-accent); }

    /* Sections */
    .section { padding: 4rem 2rem; max-width: 860px; margin: 0 auto; }
    .section h2 { font-size: 1.5rem; margin-bottom: 0.5rem; }
    .section > p { color: var(--color-muted); margin-bottom: 2rem; }
    .section-divider { border: none; border-top: 1px solid var(--color-border); margin: 0; }

    /* Steps */
    .steps { margin-top: 1rem; }
    .step { display: flex; gap: 1.25rem; margin: 1.75rem 0; }
    .step-num { width: 2rem; height: 2rem; border-radius: 50%; background: var(--color-accent); display: flex; align-items: center; justify-content: center; font-weight: 700; flex-shrink: 0; font-size: 0.875rem; color: #fff; }
    .step-content h3 { margin: 0 0 0.25rem; color: var(--color-text); font-size: 1rem; }
    .step-content p { margin: 0.25rem 0; color: var(--color-muted); }

    /* Code blocks */
    pre { background: var(--color-code-bg); border: 1px solid var(--color-border); border-radius: var(--radius); padding: 1rem; overflow-x: auto; position: relative; margin: 0.75rem 0; }
    code { font-family: var(--font-mono); font-size: 0.85rem; color: #a5f3fc; }
    p code { background: var(--color-code-bg); padding: 0.15rem 0.4rem; border-radius: 4px; font-size: 0.8rem; }
    .copy-btn { position: absolute; top: 0.5rem; right: 0.5rem; padding: 0.25rem 0.6rem; background: var(--color-border); border: none; border-radius: 4px; color: var(--color-muted); cursor: pointer; font-size: 0.75rem; font-family: var(--font); }
    .copy-btn:hover { background: var(--color-accent); color: #fff; }

    /* App cards */
    .app-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 1rem; margin-top: 1.5rem; }
    .app-card { background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius); padding: 1.5rem; transition: border-color 0.15s; }
    .app-card:hover { border-color: var(--color-accent); }
    .app-card h3 { font-size: 1rem; margin-bottom: 0.5rem; }
    .app-card h3 a { color: var(--color-text); }
    .app-card h3 a:hover { color: var(--color-accent); }
    .app-card p { color: var(--color-muted); font-size: 0.875rem; margin: 0; }

    /* Footer */
    .footer { border-top: 1px solid var(--color-border); padding: 2rem; text-align: center; color: var(--color-muted); font-size: 0.8rem; }
    .footer-links { display: flex; justify-content: center; gap: 1.5rem; margin-bottom: 0.75rem; }
    .footer-links a { color: var(--color-muted); font-size: 0.8rem; }
    .footer-links a:hover { color: var(--color-text); }
  </style>
</head>
<body>
  <nav class="nav">
    <a class="nav-brand" href="/"><span>&#9670;</span> CLEAR API</a>
    <div class="nav-links">
      <a href="/portal">Developer Portal</a>
      <a href="/graphql">GraphQL Sandbox</a>
    </div>
  </nav>

  <section class="hero">
    <h1>Build on the <em>CLEAR API</em></h1>
    <p>Access environmental alert data, detections, and location intelligence through a flexible GraphQL API.</p>
    <div class="hero-actions">
      <a href="/portal" class="btn btn-primary">Get Started</a>
      <a href="/portal#reference" class="btn btn-outline">API Reference</a>
    </div>
  </section>

  <hr class="section-divider">

  <section class="section">
    <h2>Quick Start</h2>
    <p>Go from zero to your first API call in three steps.</p>

    <div class="steps">
      <div class="step">
        <div class="step-num">1</div>
        <div class="step-content">
          <h3>Create an Account</h3>
          <p>Sign up at the <a href="/portal">Developer Portal</a> to get access to the API.</p>
        </div>
      </div>
      <div class="step">
        <div class="step-num">2</div>
        <div class="step-content">
          <h3>Generate an API Key</h3>
          <p>Create a key in the <a href="/portal#api-keys">API Keys</a> tab. Save it immediately &mdash; it&rsquo;s only shown once.</p>
        </div>
      </div>
      <div class="step">
        <div class="step-num">3</div>
        <div class="step-content">
          <h3>Make Your First Query</h3>
          <p>Send a GraphQL request with your key as a Bearer token:</p>
          <pre><code>curl -X POST https://api.clearinitiative.io/graphql \\
  -H "Authorization: Bearer sk_live_..." \\
  -H "Content-Type: application/json" \\
  -d '{"query":"{ me { id email } }"}'</code><button class="copy-btn" onclick="copyCode(this)">Copy</button></pre>
        </div>
      </div>
    </div>
  </section>

  <hr class="section-divider">

  <section class="section">
    <h2>Built with CLEAR</h2>
    <p>Applications and services powered by the CLEAR API.</p>

    <div class="app-grid">
      <div class="app-card">
        <h3><a href="https://clearinitiative.io" target="_blank" rel="noopener">clearinitiative.io</a></h3>
        <p>The primary CLEAR platform for environmental monitoring and public alerts.</p>
      </div>
    </div>
  </section>

  <footer class="footer">
    <div class="footer-links">
      <a href="/portal">Developer Portal</a>
      <a href="/portal#reference">API Reference</a>
      <a href="/portal#authentication">Authentication</a>
    </div>
    <p>&copy; CLEAR Initiative</p>
  </footer>

  <script>
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
</body>
</html>`;
}
