export function renderHomePage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CLEAR API — by NRC</title>
  <meta name="description" content="CLEAR API — the developer interface to the CLEAR humanitarian data commons. One GraphQL endpoint for verified crisis signals, events, alerts, and the geography they happen in. Built and operated by NRC.">
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <meta name="theme-color" content="#0a0a0b">
  <style>
    :root {
      --bg: #0a0a0b;
      --surface: #141417;
      --surface-2: #1b1b1f;
      --border: #26262b;
      --border-hover: #3a3a42;
      --accent: #f2612a;
      --accent-hover: #ff6a33;
      --on-accent: #0a0a0b;
      --text: #f5f5f6;
      --muted: #9a9ca3;
      --label: #75777e;
      --code-bg: #0e0e10;
      --green: #4ade80;
      --yellow: #fbbf24;
      --red: #f87171;
      --radius: 10px;
      --font: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Helvetica Neue", Inter, Arial, sans-serif;
      --mono: "SF Mono", "JetBrains Mono", "Fira Code", ui-monospace, Consolas, monospace;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    html { scroll-behavior: smooth; }
    body { font-family: var(--font); background: var(--bg); color: var(--text); line-height: 1.6; -webkit-font-smoothing: antialiased; }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .mono { font-family: var(--mono); }

    /* Eyebrow / pill labels */
    .eyebrow { font-family: var(--mono); font-size: 0.7rem; letter-spacing: 0.12em; text-transform: uppercase; color: var(--label); }
    .pill { display: inline-flex; align-items: center; gap: 0.5rem; font-family: var(--mono); font-size: 0.72rem; letter-spacing: 0.1em; text-transform: uppercase; color: var(--muted); border: 1px solid var(--border); border-radius: 999px; padding: 0.35rem 0.8rem; }
    .pill .dot { width: 0.5rem; height: 0.5rem; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 3px rgba(242,97,42,0.18); }

    /* Nav */
    .nav { display: flex; align-items: center; justify-content: space-between; padding: 1rem 2rem; border-bottom: 1px solid var(--border); position: sticky; top: 0; background: rgba(10,10,11,0.85); backdrop-filter: blur(8px); z-index: 100; }
    .nav-brand { font-weight: 800; font-size: 1.05rem; letter-spacing: -0.01em; color: var(--text); }
    .nav-brand .c { color: var(--accent); }
    .nav-brand .by { color: var(--label); font-weight: 500; font-size: 0.8rem; font-style: italic; margin-left: 0.4rem; }
    .nav-links { display: flex; align-items: center; gap: 1.75rem; }
    .nav-links a { font-size: 0.85rem; color: var(--muted); }
    .nav-links a:hover { color: var(--text); text-decoration: none; }
    .nav-cta { border: 1px solid var(--border); border-radius: 8px; padding: 0.45rem 0.9rem !important; color: var(--text) !important; }
    .nav-cta:hover { border-color: var(--accent); color: var(--accent) !important; }

    /* Layout */
    .wrap { max-width: 1140px; margin: 0 auto; padding: 0 2rem; }

    /* Hero */
    .hero { display: grid; grid-template-columns: 1.05fr 1fr; gap: 3.5rem; align-items: center; padding: 5.5rem 0 4rem; }
    .hero h1 { font-size: 3.25rem; font-weight: 800; line-height: 1.02; letter-spacing: -0.03em; margin: 1.25rem 0 1.5rem; }
    .hero h1 .accent { color: var(--accent); }
    .hero h1 .dim { color: var(--muted); }
    .hero .lead { font-size: 1.08rem; color: var(--muted); max-width: 36rem; margin-bottom: 2rem; }
    .hero .lead strong { color: var(--text); font-weight: 600; }
    .hero-actions { display: flex; gap: 0.85rem; flex-wrap: wrap; align-items: center; }
    .terminal-hint { font-family: var(--mono); font-size: 0.8rem; color: var(--label); margin-top: 1.5rem; }
    .terminal-hint .prompt { color: var(--accent); }

    /* Buttons */
    .btn { padding: 0.7rem 1.3rem; border-radius: 8px; font-weight: 600; cursor: pointer; font-size: 0.875rem; font-family: var(--font); text-decoration: none; display: inline-block; transition: all 0.15s; border: 1px solid transparent; }
    .btn:hover { text-decoration: none; }
    .btn-primary { background: var(--accent); color: var(--on-accent); }
    .btn-primary:hover { background: var(--accent-hover); }
    .btn-outline { background: transparent; border-color: var(--border); color: var(--text); }
    .btn-outline:hover { border-color: var(--accent); color: var(--accent); }

    /* Code panel (hero) */
    .panel { background: var(--code-bg); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; box-shadow: 0 24px 60px -20px rgba(0,0,0,0.6); }
    .panel-head { display: flex; align-items: center; justify-content: space-between; padding: 0.65rem 1rem; border-bottom: 1px solid var(--border); font-family: var(--mono); font-size: 0.72rem; letter-spacing: 0.06em; color: var(--muted); }
    .panel-head .live { color: var(--accent); }
    .panel pre { margin: 0; padding: 1.1rem 1.2rem; overflow-x: auto; }
    .panel code { font-family: var(--mono); font-size: 0.78rem; line-height: 1.7; color: #cdd1d6; white-space: pre; }
    .panel code .k { color: var(--accent); }
    .panel code .s { color: var(--green); }
    .panel code .n { color: var(--yellow); }
    .panel code .c { color: var(--label); }

    /* Section */
    .section { padding: 4.5rem 0; border-top: 1px solid var(--border); }
    .section-head { max-width: 40rem; margin-bottom: 2.5rem; }
    .section-head h2 { font-size: 2rem; font-weight: 800; letter-spacing: -0.02em; margin: 0.75rem 0 0.5rem; }
    .section-head h2 .dim { color: var(--muted); }
    .section-head p { color: var(--muted); font-size: 1rem; }

    /* Tiers */
    .tiers { display: grid; gap: 0; border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
    .tier { display: grid; grid-template-columns: 9rem 1fr; gap: 1.5rem; padding: 1.15rem 1.5rem; border-bottom: 1px solid var(--border); align-items: baseline; }
    .tier:last-child { border-bottom: none; }
    .tier:hover { background: var(--surface); }
    .tier .t-label { font-family: var(--mono); font-size: 0.78rem; letter-spacing: 0.08em; text-transform: uppercase; color: var(--accent); }
    .tier .t-desc { color: var(--muted); font-size: 0.92rem; }
    .tier .t-desc strong { color: var(--text); font-weight: 600; }
    .tiers-note { font-family: var(--mono); font-size: 0.74rem; letter-spacing: 0.04em; color: var(--label); margin-top: 1rem; }

    /* Doors */
    .doors { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem; }
    .door { display: block; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 1.5rem; transition: border-color 0.15s, transform 0.15s; }
    .door:hover { border-color: var(--accent); transform: translateY(-2px); text-decoration: none; }
    .door .d-num { font-family: var(--mono); font-size: 0.72rem; color: var(--accent); letter-spacing: 0.08em; }
    .door h3 { font-size: 1.05rem; margin: 0.6rem 0 0.4rem; color: var(--text); }
    .door p { color: var(--muted); font-size: 0.88rem; margin: 0; }
    .door .arrow { color: var(--accent); margin-top: 0.9rem; font-size: 0.85rem; display: inline-block; }

    /* Mission strip */
    .mission { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 2rem 2.25rem; display: flex; align-items: center; justify-content: space-between; gap: 2rem; flex-wrap: wrap; }
    .mission p { color: var(--muted); font-size: 0.98rem; max-width: 42rem; }
    .mission p strong { color: var(--text); }

    /* Footer */
    .footer { border-top: 1px solid var(--border); padding: 2.5rem 0; }
    .footer-row { display: flex; align-items: center; justify-content: space-between; gap: 1.5rem; flex-wrap: wrap; }
    .footer-brand { font-weight: 800; }
    .footer-brand .c { color: var(--accent); }
    .footer-brand .by { color: var(--label); font-weight: 500; font-style: italic; font-size: 0.8rem; margin-left: 0.4rem; }
    .footer-links { display: flex; gap: 1.5rem; flex-wrap: wrap; }
    .footer-links a { color: var(--muted); font-size: 0.85rem; }
    .footer-links a:hover { color: var(--text); }
    .footer-meta { font-family: var(--mono); font-size: 0.72rem; letter-spacing: 0.06em; color: var(--label); margin-top: 1.25rem; }

    /* Copy button */
    .copy-btn { background: var(--border); border: none; border-radius: 4px; color: var(--muted); cursor: pointer; font-size: 0.7rem; font-family: var(--mono); padding: 0.2rem 0.55rem; }
    .copy-btn:hover { background: var(--accent); color: var(--on-accent); }

    /* Responsive */
    @media (max-width: 900px) {
      .hero { grid-template-columns: 1fr; gap: 2.5rem; padding: 3.5rem 0 2.5rem; }
      .hero h1 { font-size: 2.5rem; }
      .doors { grid-template-columns: 1fr; }
      .nav-links a:not(.nav-cta) { display: none; }
    }
  </style>
</head>
<body>
  <nav class="nav">
    <a class="nav-brand" href="/"><span class="c">CLEAR</span> API<span class="by">by NRC</span></a>
    <div class="nav-links">
      <a href="/docs">Docs</a>
      <a href="/graphql">Sandbox</a>
      <a href="/portal">Portal</a>
      <a href="/portal" class="nav-cta">Get an API key</a>
    </div>
  </nav>

  <header class="wrap">
    <section class="hero">
      <div>
        <span class="pill"><span class="dot"></span> Alpha &middot; Live in Sudan</span>
        <h1>Build on the<br><span class="accent">humanitarian data commons.</span></h1>
        <p class="lead"><strong>CLEAR API</strong> is the developer interface to the CLEAR data commons &mdash; one GraphQL endpoint for verified crisis <strong>signals</strong>, <strong>events</strong>, <strong>alerts</strong>, and the geography they happen in. Built and operated by NRC.</p>
        <div class="hero-actions">
          <a href="/docs#guide" class="btn btn-primary">Read the Guide &rarr;</a>
          <a href="/graphql" class="btn btn-outline">Open the Sandbox</a>
        </div>
        <p class="terminal-hint"><span class="prompt">$</span> curl api.clearinitiative.io/graphql</p>
      </div>

      <div class="panel">
        <div class="panel-head"><span>POST&nbsp;&nbsp;/graphql</span><span class="live">200 OK &middot; 142ms</span></div>
        <pre><code><span class="c"># Verified events anywhere inside Sudan</span>
{
  <span class="k">eventsByLocation</span>(locationId: <span class="s">"sdn"</span>) {
    id
    title
    <span class="k">severity</span>
    types
    generalLocation { name }
  }
}

<span class="c"># &rarr; one record from the response</span>
{
  <span class="s">"id"</span>:       <span class="s">"evt_blnile_0614"</span>,
  <span class="s">"title"</span>:    <span class="s">"Displacement surge — Blue Nile"</span>,
  <span class="s">"severity"</span>: <span class="n">5</span>,
  <span class="s">"types"</span>:    [<span class="s">"displacement"</span>, <span class="s">"conflict"</span>],
  <span class="s">"generalLocation"</span>: { <span class="s">"name"</span>: <span class="s">"Blue Nile"</span> }
}</code></pre>
      </div>
    </section>
  </header>

  <main>
    <!-- Mental model -->
    <section class="section">
      <div class="wrap">
        <div class="section-head">
          <span class="eyebrow">01 &middot; The data</span>
          <h2>Five tiers. <span class="dim">One graph.</span></h2>
          <p>Raw observations flow in at the bottom and are grouped, classified, and escalated into briefings at the top. Almost every query you write touches one of these.</p>
        </div>

        <div class="tiers">
          <div class="tier"><div class="t-label">Location</div><div class="t-desc">The administrative hierarchy &mdash; <strong>country &rarr; state &rarr; district &rarr; point</strong>. Everything else hangs off this tree.</div></div>
          <div class="tier"><div class="t-label">Signal</div><div class="t-desc">A single <strong>raw observation</strong> from satellite, field reports, social, or conflict feeds &mdash; or filed manually.</div></div>
          <div class="tier"><div class="t-label">Event</div><div class="t-desc">A <strong>cluster of related signals</strong>, classified by disaster type and bound to a district.</div></div>
          <div class="tier"><div class="t-label">Alert</div><div class="t-desc">A <strong>severe event escalated</strong> for notification and delivered to subscribers.</div></div>
          <div class="tier"><div class="t-label">Crisis</div><div class="t-desc">Curated events <strong>enriched by an LLM</strong> into a summary, forward scenarios, and a needs analysis.</div></div>
        </div>
        <p class="tiers-note">Everything is geolocated &mdash; which is why the &hellip;ByLocation queries are the sharpest way to slice the data. <a href="/docs#guide">See the full walkthrough &rarr;</a></p>
      </div>
    </section>

    <!-- Three doors -->
    <section class="section">
      <div class="wrap">
        <div class="section-head">
          <span class="eyebrow">02 &middot; Start building</span>
          <h2>Three ways in.</h2>
          <p>From zero knowledge to a working integration in about ten minutes.</p>
        </div>

        <div class="doors">
          <a class="door" href="/docs#guide">
            <div class="d-num">01</div>
            <h3>Read the Guide</h3>
            <p>The mental model, your first authenticated request, and two real queries &mdash; end to end.</p>
            <span class="arrow">Build your first integration &rarr;</span>
          </a>
          <a class="door" href="/graphql">
            <div class="d-num">02</div>
            <h3>Open the Sandbox</h3>
            <p>Browse the full schema with autocomplete and run live GraphQL queries in your browser.</p>
            <span class="arrow">Explore the schema &rarr;</span>
          </a>
          <a class="door" href="/portal">
            <div class="d-num">03</div>
            <h3>Get an API Key</h3>
            <p>Create a key in the Developer Portal and authenticate with a Bearer token.</p>
            <span class="arrow">Open the portal &rarr;</span>
          </a>
        </div>
      </div>
    </section>

    <!-- Mission link back to parent -->
    <section class="section">
      <div class="wrap">
        <div class="mission">
          <p><strong>CLEAR API is part of the CLEAR Initiative</strong> &mdash; NRC&rsquo;s open infrastructure for crisis learning, early-warning, anticipation, and response. The mission, the backbone, and the pilot live on the main site.</p>
          <a href="https://clearinitiative.io" target="_blank" rel="noopener" class="btn btn-outline">Read the mission &rarr;</a>
        </div>
      </div>
    </section>
  </main>

  <footer class="footer">
    <div class="wrap">
      <div class="footer-row">
        <a class="footer-brand" href="/"><span class="c">CLEAR</span> API<span class="by">by NRC</span></a>
        <div class="footer-links">
          <a href="/docs">Docs</a>
          <a href="/docs#guide">Guide</a>
          <a href="/graphql">Sandbox</a>
          <a href="/portal">Portal</a>
          <a href="https://clearinitiative.io" target="_blank" rel="noopener">clearinitiative.io</a>
        </div>
      </div>
      <p class="footer-meta">Alpha &middot; Live in Sudan &middot; GraphQL &middot; github.com/CLEAR-Initiative &middot; MIT</p>
    </div>
  </footer>
</body>
</html>`;
}
