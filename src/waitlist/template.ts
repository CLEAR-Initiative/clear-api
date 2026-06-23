/**
 * Public waitlist page. Served server-side as HTML by clear-api at /waitlist.
 *
 * The form action points at clear-mvp's `${FRONTEND_URL}/api/waitlist`
 * route handler — that's where the Exponential CRM call lives. clear-api
 * has no knowledge of the CRM. On submission the receiver should 303-
 * redirect the browser back to `<this page>?status=ok|exists|conflict|error`
 * so the user lands on a confirmation rendered here.
 *
 * Visual style mirrors `src/home/template.ts` so the brand is consistent.
 */

type WaitlistStatus = "ok" | "exists" | "conflict" | "error" | null;

interface RenderWaitlistOptions {
  formActionUrl: string;
  status: WaitlistStatus;
}

function statusBanner(status: WaitlistStatus): string {
  if (!status) return "";
  const map: Record<NonNullable<WaitlistStatus>, { color: string; title: string; body: string }> = {
    ok: {
      color: "var(--green)",
      title: "Application received",
      body:
        "Thanks for applying. An NRC admin will review your application and reach out by email once it's approved. Keep an eye on your inbox.",
    },
    exists: {
      color: "var(--yellow)",
      title: "You've already applied",
      body:
        "We've already received an application for this email. There's nothing more for you to do — we'll be in touch by email once it's reviewed.",
    },
    conflict: {
      color: "var(--yellow)",
      title: "Application received",
      body:
        "Thanks for applying. An NRC admin will review your application and reach out by email once it's approved.",
    },
    error: {
      color: "var(--red)",
      title: "Something went wrong",
      body:
        "We couldn't submit your application. Please try again in a moment. If this keeps happening, contact CLEAR support.",
    },
  };
  const { color, title, body } = map[status];
  return `<div class="banner" style="border-color: ${color};">
    <div class="banner-title" style="color: ${color};">${title}</div>
    <div class="banner-body">${body}</div>
  </div>`;
}

export function renderWaitlistPage(opts: RenderWaitlistOptions): string {
  const { formActionUrl, status } = opts;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CLEAR API — Apply for access</title>
  <meta name="description" content="Apply for CLEAR API access. NRC admins review every application before issuing developer credentials.">
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
      --green: #4ade80;
      --yellow: #fbbf24;
      --red: #f87171;
      --radius: 10px;
      --font: 'Inter', ui-sans-serif, -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif;
      --mono: 'JetBrains Mono', "SF Mono", "Fira Code", ui-monospace, Consolas, monospace;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: var(--font); background: var(--bg); color: var(--text); line-height: 1.55; -webkit-font-smoothing: antialiased; }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }

    .nav { display: flex; align-items: center; justify-content: space-between; padding: 1rem 2rem; border-bottom: 1px solid var(--border); }
    .nav-brand { font-weight: 800; font-size: 1.05rem; letter-spacing: -0.01em; color: var(--text); }
    .nav-brand .by { font-weight: 500; color: var(--muted); margin-left: 0.5rem; }

    .wrap { max-width: 640px; margin: 0 auto; padding: 3rem 2rem 5rem; }
    .eyebrow { font-family: var(--mono); font-size: 0.7rem; letter-spacing: 0.12em; text-transform: uppercase; color: var(--label); margin-bottom: 0.6rem; }
    h1 { font-size: 2rem; font-weight: 700; letter-spacing: -0.02em; margin-bottom: 0.6rem; }
    .lede { color: var(--muted); font-size: 1rem; margin-bottom: 2rem; }

    .banner { border: 1px solid var(--border); border-left-width: 3px; border-radius: var(--radius); padding: 1rem 1.1rem; margin-bottom: 1.5rem; background: var(--surface); }
    .banner-title { font-weight: 600; font-size: 0.95rem; margin-bottom: 0.2rem; }
    .banner-body { color: var(--muted); font-size: 0.9rem; }

    form { display: grid; gap: 1.1rem; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 1.5rem; }
    .field { display: grid; gap: 0.35rem; }
    label { font-family: var(--mono); font-size: 0.7rem; letter-spacing: 0.12em; text-transform: uppercase; color: var(--label); }
    .req { color: var(--accent); margin-left: 0.25rem; }
    input, textarea, select {
      font-family: var(--font);
      font-size: 0.95rem;
      color: var(--text);
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 0.7rem 0.85rem;
      width: 100%;
      transition: border-color 0.15s;
    }
    input:focus, textarea:focus, select:focus { outline: none; border-color: var(--accent); }
    textarea { resize: vertical; min-height: 110px; line-height: 1.5; }
    select { appearance: none; background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='%239a9ca3'><path d='M4.5 6l3.5 4 3.5-4z'/></svg>"); background-repeat: no-repeat; background-position: right 0.8rem center; padding-right: 2.2rem; }
    .help { font-size: 0.8rem; color: var(--muted); }

    button {
      font-family: var(--font);
      font-weight: 600;
      font-size: 0.95rem;
      color: var(--on-accent);
      background: var(--accent);
      border: none;
      border-radius: 6px;
      padding: 0.85rem 1.2rem;
      cursor: pointer;
      transition: background 0.15s;
    }
    button:hover { background: var(--accent-hover); }

    .footnote { margin-top: 1.5rem; font-size: 0.85rem; color: var(--muted); }
    .footnote a { color: var(--text); border-bottom: 1px solid var(--border); }

    @media (max-width: 540px) {
      .wrap { padding: 2rem 1.25rem 3rem; }
      h1 { font-size: 1.6rem; }
      form { padding: 1.25rem; }
    }
  </style>
</head>
<body>
  <nav class="nav">
    <div class="nav-brand">CLEAR API <span class="by">by NRC</span></div>
    <a href="/">Back to home</a>
  </nav>

  <main class="wrap">
    <div class="eyebrow">Request access</div>
    <h1>Apply for CLEAR API access</h1>
    <p class="lede">
      CLEAR access is reviewed by an NRC admin before credentials are issued.
      Tell us who you are and what you'd like to build with the data, and we'll
      get back to you by email.
    </p>

    ${statusBanner(status)}

    <form method="POST" action="${formActionUrl}">
      <div class="field">
        <label for="name">Full name <span class="req">*</span></label>
        <input id="name" name="name" type="text" required maxlength="200" autocomplete="name" />
      </div>

      <div class="field">
        <label for="email">Work email <span class="req">*</span></label>
        <input id="email" name="email" type="email" required maxlength="320" autocomplete="email" />
      </div>

      <div class="field">
        <label for="organisation">Organisation</label>
        <input id="organisation" name="organisation" type="text" maxlength="200" autocomplete="organization" />
        <div class="help">Company, NGO, or research group you're applying on behalf of.</div>
      </div>

      <div class="field">
        <label for="country">Country / region of operation</label>
        <input id="country" name="country" type="text" maxlength="120" autocomplete="country-name" />
      </div>

      <div class="field">
        <label for="useCase">Intended use case <span class="req">*</span></label>
        <textarea id="useCase" name="useCase" required maxlength="2000" placeholder="What would you like to build or analyse using CLEAR data?"></textarea>
      </div>

      <div class="field">
        <label for="volume">Expected query volume</label>
        <select id="volume" name="volume">
          <option value="">— select —</option>
          <option value="low">Low (under 1k requests / day)</option>
          <option value="medium">Medium (1k–10k requests / day)</option>
          <option value="high">High (10k+ requests / day)</option>
          <option value="unknown">Not sure yet</option>
        </select>
      </div>

      <button type="submit">Submit application</button>
    </form>

    <div class="footnote">
      Already approved? <a href="/auth/login">Sign in</a>.
      For platform questions, contact <a href="mailto:clear-support@nrc.no">CLEAR support</a>.
    </div>
  </main>
</body>
</html>`;
}
