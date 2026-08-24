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
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
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
      --font: 'Inter', ui-sans-serif, -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif;
      --mono: 'JetBrains Mono', "SF Mono", "Fira Code", ui-monospace, Consolas, monospace;
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
    .nav-signin { color: var(--text) !important; }

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
      .nav-links a:not(.nav-cta):not(.nav-signin) { display: none; }
    }
  </style>
</head>
<body>
  <nav class="nav">
    <a class="nav-brand" href="/"><span class="c">CLEAR</span> API<span class="by">by NRC</span></a>
    <div class="nav-links">
      <a href="/docs">Docs</a>
      <a href="/graphql" target="_blank" rel="noopener noreferrer">Sandbox</a>
      <a href="/portal">Portal</a>
      <a href="/portal/login" class="nav-signin">Sign in</a>
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
          <a href="/graphql" class="btn btn-outline" target="_blank" rel="noopener noreferrer">Open the Sandbox</a>
        </div>
        <p class="terminal-hint"><span class="prompt">$</span> curl https://api.clearinitiative.io/graphql</p>
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
    <!-- ============ THE CLEAR API · three-tier master/detail (ported from ClearApiSection) ============ -->
    <style>
    .apisec{
      --bg:#0a0a0a; --bg-2:#111111; --bg-3:#161616;
      --line:#212121; --line-2:#2c2c2c;
      --ink:#f4f4f3; --ink-2:#b8b8b6; --ink-3:#7a7a78; --ink-4:#4a4a48;
      --orange:#f2612a; --orange-2:#ff6a33;
      --orange-dim:rgba(242,97,42,.13); --orange-line:rgba(242,97,42,.4);
      border-top:1px solid var(--line); padding:104px 0 108px; background:var(--bg); color:var(--ink);
    }
    .apisec *{ box-sizing:border-box; }
    .apisec .wrap{ max-width:1180px; margin:0 auto; padding:0 40px; }
    .apisec .kicker{ font-family:'JetBrains Mono',monospace; font-size:14px; letter-spacing:.22em; text-transform:uppercase; color:var(--ink-3); margin:0; }
    .apisec .head{ font-weight:700; font-size:46px; line-height:1.02; letter-spacing:-.03em; margin:26px 0 0; color:var(--ink); }
    .apisec .head .mute{ color:var(--ink-3); }
    .apisec .lede{ color:var(--ink-2); font-size:19px; line-height:1.5; max-width:62ch; margin:22px 0 0; }
    .apisec .md{ display:grid; grid-template-columns:380px minmax(0,1fr); gap:24px; margin-top:50px; align-items:stretch; }
    .apisec .md-list{ background:var(--bg-2); border:1px solid var(--line); border-radius:16px; overflow:hidden; }
    .apisec .t-row{ display:flex; align-items:flex-start; gap:16px; width:100%; text-align:left; padding:22px; background:transparent; border:none; border-bottom:1px solid var(--line); cursor:pointer; font-family:inherit; position:relative; transition:background .14s; color:inherit; }
    .apisec .t-row:last-child{ border-bottom:none; }
    .apisec .t-row:hover{ background:var(--bg-3); }
    .apisec .t-row.active{ background:linear-gradient(100deg, var(--orange-dim), transparent 70%); }
    .apisec .t-row.active::before{ content:""; position:absolute; left:0; top:14px; bottom:14px; width:3px; background:var(--orange); border-radius:0 3px 3px 0; }
    .apisec .t-glyph{ flex:0 0 42px; width:42px; height:42px; border-radius:11px; background:var(--bg-3); border:1px solid var(--line-2); display:flex; align-items:center; justify-content:center; font-size:18px; color:var(--ink-2); transition:.14s; }
    .apisec .t-row.active .t-glyph{ background:var(--orange); border-color:var(--orange); color:#1a0a02; }
    .apisec .t-meta{ min-width:0; flex:1; }
    .apisec .t-ix{ font-family:'JetBrains Mono',monospace; font-size:11px; letter-spacing:.16em; text-transform:uppercase; color:var(--ink-3); }
    .apisec .t-row.active .t-ix{ color:var(--orange-2); }
    .apisec .t-name{ font-size:19px; font-weight:600; letter-spacing:-.01em; color:var(--ink); margin-top:5px; }
    .apisec .t-line{ font-size:13.5px; line-height:1.4; color:var(--ink-3); margin-top:6px; }
    .apisec .md-detail{ background:var(--bg-2); border:1px solid var(--line); border-radius:16px; padding:34px 38px 36px; display:flex; flex-direction:column; }
    .apisec .d-top{ display:flex; align-items:center; gap:16px; }
    .apisec .d-glyph{ flex:0 0 50px; width:50px; height:50px; border-radius:13px; background:var(--orange); display:flex; align-items:center; justify-content:center; font-size:21px; color:#1a0a02; }
    .apisec .d-ix{ font-family:'JetBrains Mono',monospace; font-size:12px; letter-spacing:.16em; text-transform:uppercase; color:var(--orange-2); }
    .apisec .d-name{ font-size:30px; font-weight:700; letter-spacing:-.02em; color:var(--ink); margin-top:3px; line-height:1; }
    .apisec .d-desc{ font-size:17px; line-height:1.55; color:var(--ink-2); margin:22px 0 0; }
    .apisec .d-sub{ font-family:'JetBrains Mono',monospace; font-size:11px; letter-spacing:.18em; text-transform:uppercase; color:var(--ink-3); margin:30px 0 14px; display:flex; align-items:center; gap:14px; }
    .apisec .d-sub .rule{ flex:1; height:1px; background:var(--line); }
    .apisec .d-incl{ display:flex; flex-direction:column; gap:0; border:1px solid var(--line); border-radius:11px; overflow:hidden; }
    .apisec .d-incl .ir{ display:grid; grid-template-columns:118px 1fr; gap:18px; padding:15px 18px; border-bottom:1px solid var(--line); align-items:baseline; }
    .apisec .d-incl .ir:last-child{ border-bottom:none; }
    .apisec .d-incl .ik{ font-family:'JetBrains Mono',monospace; font-size:12.5px; letter-spacing:.08em; color:var(--orange); }
    .apisec .d-incl .iv{ font-size:14.5px; line-height:1.45; color:var(--ink-2); }
    .apisec .d-graphic{ margin-top:24px; border:1px solid var(--line); border-radius:12px; background:radial-gradient(120% 140% at 50% -10%, #141414, #0d0d0d 70%); overflow:hidden; padding:8px; animation: apsecIn .46s cubic-bezier(.4,0,.2,1); }
    .apisec .d-graphic svg{ display:block; width:100%; height:auto; }
    @keyframes apsecIn{ from{opacity:0; transform:translateY(8px);} to{opacity:1; transform:none;} }
    .apisec .node-live{ transform-box:fill-box; transform-origin:center; animation: apsecPulse 2.6s ease-in-out infinite; }
    @keyframes apsecPulse{ 0%,100%{opacity:1;} 50%{opacity:.66;} }
    .apisec .ring-live{ transform-box:fill-box; transform-origin:center; animation: apsecRing 2.6s ease-in-out infinite; }
    @keyframes apsecRing{ 0%,100%{opacity:.5; transform:scale(1);} 50%{opacity:.15; transform:scale(1.12);} }
    .apisec .foot{ display:flex; align-items:center; gap:14px; margin-top:30px; font-family:'JetBrains Mono',monospace; font-size:13.5px; letter-spacing:.04em; color:var(--ink-3); flex-wrap:wrap; }
    .apisec .foot .pulse{ width:8px; height:8px; border-radius:50%; background:var(--orange); box-shadow:0 0 10px var(--orange); flex:0 0 8px; }
    .apisec .foot .ep{ color:var(--ink-2); }
    .apisec .foot a{ color:var(--orange); text-decoration:none; margin-left:auto; }
    .apisec .foot a:hover{ text-decoration:underline; }
    @media (max-width:880px){ .apisec .md{ grid-template-columns:1fr; } .apisec .head{ font-size:36px; } }
    @media (prefers-reduced-motion: reduce){ .apisec .d-graphic, .apisec .node-live, .apisec .ring-live{ animation:none; } }
    </style>
    <section class="apisec" aria-label="The CLEAR API">
      <div class="wrap">
        <p class="kicker">01 &middot; The CLEAR API</p>
        <h2 class="head">One endpoint. <span class="mute">Three tiers.</span></h2>
        <p class="lede">Detected signals become a connected commons, which sovereign AI reasons over &mdash; into briefings you can build on. Select a tier to see what it covers.</p>
        <div class="md">
          <div class="md-list" id="apisecList"></div>
          <div class="md-detail" id="apisecDetail"></div>
        </div>
        <div class="foot">
          <span class="pulse"></span>
          <span>One GraphQL endpoint touches every tier &middot; <span class="ep">POST https://api.clearinitiative.io/graphql</span></span>
          <a href="/docs#guide">Read the guide &rarr;</a>
        </div>
      </div>
    </section>
    <script>
    (function(){
      var TIERS = [
        {
          ix:"01 · Detection", glyph:"◈", name:"Detection",
          line:"Source observations captured and verified into events.",
          desc:"Crisis signals are captured, deduplicated and verified into structured records — what happened, where, and how severe. This is the bottom of the graph: the source material everything else is built from.",
          includes:[
            ["SIGNAL","A single source observation — from satellite, field reports, social, or conflict feeds, or filed manually."],
            ["EVENT","A cluster of related signals, classified by disaster type and bound to a district."]
          ],
          graphic:'<svg viewBox="0 0 460 200" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Source observations converging into one verified event">'+
            '<line x1="60" y1="40" x2="230" y2="100" stroke="#2c2c2c"/><line x1="54" y1="96" x2="230" y2="100" stroke="#2c2c2c"/><line x1="72" y1="158" x2="230" y2="100" stroke="#2c2c2c"/><line x1="150" y1="30" x2="230" y2="100" stroke="#2c2c2c"/><line x1="150" y1="170" x2="230" y2="100" stroke="#2c2c2c"/>'+
            '<line x1="230" y1="100" x2="398" y2="100" stroke="#f2612a" stroke-opacity=".5" stroke-dasharray="4 5"/>'+
            '<circle cx="60" cy="40" r="5" fill="#7fb0ff"/><circle cx="54" cy="96" r="5" fill="#7adfa0"/><circle cx="72" cy="158" r="5" fill="#b8b8b6"/><circle cx="150" cy="30" r="5" fill="#7adfa0"/><circle cx="150" cy="170" r="5" fill="#7fb0ff"/>'+
            '<text x="60" y="24" fill="#7a7a78" font-family="JetBrains Mono,monospace" font-size="9" letter-spacing="1.5">SIGNALS</text>'+
            '<rect class="node-live" x="212" y="82" width="36" height="36" rx="9" fill="#f2612a"/>'+
            '<text x="230" y="105" text-anchor="middle" fill="#1a0a02" font-family="Inter,sans-serif" font-size="15" font-weight="700">◈</text>'+
            '<rect x="360" y="82" width="78" height="36" rx="9" fill="#161616" stroke="#f2612a" stroke-opacity=".4"/>'+
            '<text x="399" y="104" text-anchor="middle" fill="#ff6a33" font-family="JetBrains Mono,monospace" font-size="11" letter-spacing="1">EVENT</text>'+
            '<text x="230" y="148" text-anchor="middle" fill="#7a7a78" font-family="JetBrains Mono,monospace" font-size="9" letter-spacing="1.5">VERIFIED</text>'+
          '</svg>'
        },
        {
          ix:"02 · Commons", glyph:"⬡", name:"Data Commons",
          line:"Everything linked into one queryable graph.",
          desc:"Events, signals, alerts and the geography they happen in are linked into a single queryable graph. Everything is geolocated — which is why the …ByLocation queries are the sharpest way to slice the data.",
          includes:[
            ["LOCATION","The administrative hierarchy — country → state → district → point. Everything else hangs off this tree."]
          ],
          graphic:'<svg viewBox="0 0 460 200" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Geography graph with one location path lit">'+
            '<line x1="70" y1="100" x2="180" y2="50" stroke="#2c2c2c"/><line x1="70" y1="100" x2="180" y2="150" stroke="#f2612a" stroke-opacity=".55"/>'+
            '<line x1="180" y1="50" x2="300" y2="34" stroke="#2c2c2c"/><line x1="180" y1="50" x2="300" y2="74" stroke="#2c2c2c"/>'+
            '<line x1="180" y1="150" x2="300" y2="126" stroke="#f2612a" stroke-opacity=".55"/><line x1="180" y1="150" x2="300" y2="166" stroke="#2c2c2c"/>'+
            '<line x1="300" y1="126" x2="406" y2="126" stroke="#f2612a" stroke-opacity=".55"/>'+
            '<circle cx="70" cy="100" r="7" fill="#161616" stroke="#7a7a78"/>'+
            '<circle cx="180" cy="50" r="5" fill="#4a4a48"/><circle cx="300" cy="34" r="4" fill="#4a4a48"/><circle cx="300" cy="74" r="4" fill="#4a4a48"/>'+
            '<circle class="node-live" cx="180" cy="150" r="6" fill="#f2612a"/><circle cx="300" cy="166" r="4" fill="#4a4a48"/>'+
            '<circle class="node-live" cx="300" cy="126" r="5" fill="#f2612a"/>'+
            '<circle class="ring-live" cx="406" cy="126" r="9" fill="none" stroke="#f2612a"/><circle cx="406" cy="126" r="4" fill="#f2612a"/>'+
            '<text x="58" y="104" text-anchor="end" fill="#7a7a78" font-family="JetBrains Mono,monospace" font-size="9" letter-spacing="1">COUNTRY</text>'+
            '<text x="180" y="34" text-anchor="middle" fill="#7a7a78" font-family="JetBrains Mono,monospace" font-size="9" letter-spacing="1">STATE</text>'+
            '<text x="300" y="196" text-anchor="middle" fill="#7a7a78" font-family="JetBrains Mono,monospace" font-size="9" letter-spacing="1">DISTRICT</text>'+
            '<text x="406" y="150" text-anchor="middle" fill="#ff6a33" font-family="JetBrains Mono,monospace" font-size="9" letter-spacing="1">POINT</text>'+
          '</svg>'
        },
        {
          ix:"03 · Intelligence", glyph:"✦", name:"Sovereign AI",
          line:"NRC-governed reasoning, into briefings.",
          desc:"NRC-operated models classify, group and escalate the commons into briefings — on infrastructure NRC governs. Nothing leaves the commons; the intelligence layer is sovereign.",
          includes:[
            ["ALERT","A severe event escalated for notification and delivered to subscribers."],
            ["CRISIS","Curated events enriched by an LLM into a summary, forward scenarios, and a needs analysis."]
          ],
          graphic:'<svg viewBox="0 0 460 200" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Events escalating through an NRC-governed model into one briefing">'+
            '<rect x="30" y="150" width="30" height="30" rx="7" fill="#161616" stroke="#2c2c2c"/><rect x="74" y="150" width="30" height="30" rx="7" fill="#161616" stroke="#2c2c2c"/><rect x="118" y="150" width="30" height="30" rx="7" fill="#161616" stroke="#2c2c2c"/><rect x="162" y="150" width="30" height="30" rx="7" fill="#161616" stroke="#2c2c2c"/>'+
            '<text x="30" y="142" fill="#7a7a78" font-family="JetBrains Mono,monospace" font-size="9" letter-spacing="1.5">EVENTS</text>'+
            '<rect x="24" y="80" width="412" height="40" rx="10" fill="#f2612a" fill-opacity=".07" stroke="#f2612a" stroke-opacity=".4" stroke-dasharray="5 5"/>'+
            '<text x="230" y="104" text-anchor="middle" fill="#ff6a33" font-family="JetBrains Mono,monospace" font-size="10" letter-spacing="2.5">NRC-GOVERNED MODEL</text>'+
            '<line x1="45" y1="150" x2="160" y2="120" stroke="#2c2c2c"/><line x1="89" y1="150" x2="185" y2="120" stroke="#2c2c2c"/><line x1="133" y1="150" x2="230" y2="120" stroke="#2c2c2c"/><line x1="177" y1="150" x2="275" y2="120" stroke="#2c2c2c"/>'+
            '<line x1="230" y1="80" x2="360" y2="50" stroke="#f2612a" stroke-opacity=".55"/>'+
            '<rect class="node-live" x="330" y="30" width="100" height="40" rx="10" fill="#f2612a"/>'+
            '<text x="380" y="55" text-anchor="middle" fill="#1a0a02" font-family="JetBrains Mono,monospace" font-size="11" letter-spacing="1" font-weight="600">BRIEFING</text>'+
          '</svg>'
        }
      ];

      var listEl = document.getElementById('apisecList');
      var detailEl = document.getElementById('apisecDetail');
      if (!listEl || !detailEl) return;

      function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

      function renderDetail(t){
        var incl = t.includes.map(function(r){
          return '<div class="ir"><div class="ik">'+esc(r[0])+'</div><div class="iv">'+esc(r[1])+'</div></div>';
        }).join('');
        detailEl.innerHTML =
          '<div class="d-top"><div class="d-glyph">'+t.glyph+'</div>'+
            '<div><div class="d-ix">'+esc(t.ix)+'</div><div class="d-name">'+esc(t.name)+'</div></div></div>'+
          '<div class="d-graphic"></div>'+
          '<p class="d-desc">'+esc(t.desc)+'</p>'+
          '<div class="d-sub">Includes<span class="rule"></span></div>'+
          '<div class="d-incl">'+incl+'</div>';
        var svgDoc = new DOMParser().parseFromString(t.graphic, 'image/svg+xml');
        detailEl.querySelector('.d-graphic').appendChild(document.importNode(svgDoc.documentElement, true));
      }

      TIERS.forEach(function(t, i){
        var b = document.createElement('button');
        b.className = 't-row' + (i===0 ? ' active' : '');
        b.type = 'button';
        b.innerHTML =
          '<div class="t-glyph">'+t.glyph+'</div>'+
          '<div class="t-meta"><div class="t-ix">'+esc(t.ix)+'</div>'+
            '<div class="t-name">'+esc(t.name)+'</div>'+
            '<div class="t-line">'+esc(t.line)+'</div></div>';
        b.addEventListener('click', function(){
          listEl.querySelectorAll('.t-row').forEach(function(r){ r.classList.remove('active'); });
          b.classList.add('active');
          renderDetail(t);
        });
        listEl.appendChild(b);
      });

      renderDetail(TIERS[0]);
    })();
    </script>
    <!-- ============ /THE CLEAR API SECTION ============ -->

    <!-- Mental model -->
    <section class="section">
      <div class="wrap">
        <div class="section-head">
          <span class="eyebrow">02 &middot; The data</span>
          <h2>Five tiers. <span class="dim">One graph.</span></h2>
          <p>Source observations flow in at the bottom and are grouped, classified, and escalated into briefings at the top. Almost every query you write touches one of these.</p>
        </div>

        <div class="tiers">
          <div class="tier"><div class="t-label">Location</div><div class="t-desc">The administrative hierarchy &mdash; <strong>country &rarr; state &rarr; district &rarr; point</strong>. Everything else hangs off this tree.</div></div>
          <div class="tier"><div class="t-label">Signal</div><div class="t-desc">A single <strong>source observation</strong> from satellite, field reports, social, or conflict feeds &mdash; or filed manually.</div></div>
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
          <span class="eyebrow">03 &middot; Start building</span>
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
          <a class="door" href="/graphql" target="_blank" rel="noopener noreferrer">
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
          <a href="/graphql" target="_blank" rel="noopener noreferrer">Sandbox</a>
          <a href="/portal">Portal</a>
          <a href="/portal/login">Sign in</a>
          <a href="https://github.com/CLEAR-Initiative" target="_blank" rel="noopener">GitHub</a>
          <a href="https://clearinitiative.io" target="_blank" rel="noopener">clearinitiative.io</a>
        </div>
      </div>
      <p class="footer-meta">Alpha &middot; Live in Sudan &middot; GraphQL &middot; <a href="https://github.com/CLEAR-Initiative" target="_blank" rel="noopener">github.com/CLEAR-Initiative</a> &middot; MIT</p>
    </div>
  </footer>
</body>
</html>`;
}
