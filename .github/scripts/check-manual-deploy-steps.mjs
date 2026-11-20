// Fails a pull request whose "Manual deploy steps" section is missing or blank.
//
// A step the code needs but no code performs (insert a row, set a secret, run a
// script) used to live only in PR prose and got lost on the way to prod: the
// 2026-10-20 idmc and 2026-11-13 iom_dtm_flash_alerts incidents (clear #1524).
// The section must say "None", or list each step with its exact command, one
// checkbox per environment, and a ticket for the prod step.
//
// Run by .github/workflows/check.yml with the PR body in $PR_BODY. Tests:
//   node --test .github/scripts/check-manual-deploy-steps.test.mjs
// The same file lives in clear-api and clear-pipeline; keep them in step.

const HEADING = /^(#{2,6})[ \t]*manual deploy steps[ \t]*$/im;
const TICKET = /exponential\.im\/w\/[^/\s]+\/products\/[^/\s]+\/tickets\/\d+/i;
const CHECKBOX = (env) => new RegExp(`^\\s*[-*][ \\t]+\\[[ xX]\\][ \\t]+${env}\\b`, "im");

/** The section's text, HTML comments removed, or null when there is no heading. */
export function manualDeploySection(body) {
  const text = String(body ?? "").replace(/\r\n/g, "\n");
  const match = HEADING.exec(text);
  if (!match) return null;
  const level = match[1].length;
  const rest = text.slice(match.index + match[0].length);
  const next = new RegExp(`^#{1,${level}}[ \\t]+\\S`, "m").exec(rest);
  const section = next ? rest.slice(0, next.index) : rest;
  return section.replace(/<!--[\s\S]*?-->/g, "").trim();
}

/** Problems with the PR body's "Manual deploy steps" section; empty when it passes. */
export function checkManualDeploySteps(body) {
  const section = manualDeploySection(body);
  if (section === null) {
    return ['Add a "## Manual deploy steps" section to the PR description (see .github/pull_request_template.md).'];
  }
  if (section === "") {
    return ['"Manual deploy steps" is blank. Write "None", or list each step with its command and a dev and prod checkbox.'];
  }
  if (/^none\b/i.test(section)) return [];

  const errors = [];
  if (!section.includes("`")) {
    errors.push('Give each manual step as an exact command in backticks or a code block.');
  }
  if (!CHECKBOX("prod").test(section)) {
    errors.push('Add a "- [ ] prod" checkbox under each manual step (and "- [ ] dev" where it applies).');
  } else if (!TICKET.test(section)) {
    errors.push("Link the Exponential ticket that tracks the prod step (https://www.exponential.im/w/clear/products/clear/tickets/<number>).");
  }
  return errors;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const errors = checkManualDeploySteps(process.env.PR_BODY);
  for (const e of errors) console.log(`::error title=Manual deploy steps::${e}`);
  if (errors.length) process.exit(1);
  console.log("Manual deploy steps: OK");
}
