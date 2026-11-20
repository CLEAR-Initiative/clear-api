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

const HEADING = /^(#{2,6})[ \t]*manual deploy steps[ \t]*$/i;
const FENCE = /^[ \t]{0,3}(```|~~~)/;
const TICKET = /exponential\.im\/w\/[^/\s]+\/products\/[^/\s]+\/tickets\/\d+/i;
const CHECKBOX = (env) => new RegExp(`^\\s*[-*][ \\t]+\\[[ xX]\\][ \\t]+${env}\\b`, "im");
// "None", with or without a reason ("None.", "None needed", "None for this PR").
// A None that names an environment ("None for dev. For prod, …", "None, but prod
// needs the secret") describes a step, so it gets the full checks.
const NONE = /^none\b/i;
const NAMES_ENV = /\b(?:dev|prod|production|staging)\b/i;
const IS_CHECKBOX = /^\s*[-*][ \t]+\[[ xX]\]/;
// An unindented numbered item or a sub-heading starts a step.
const STEP_START = /^(?:\d+[.)][ \t]+\S|#{1,6}[ \t]+\S)/;

/** Lines of the text, each with whether it sits inside a fenced code block (fences
 * included) and whether it opens one. */
function linesWithFence(text) {
  let inFence = false;
  return text.split("\n").map((line) => {
    const fence = FENCE.test(line);
    const entry = { line, code: inFence || fence, opens: fence && !inFence };
    if (fence) inFence = !inFence;
    return entry;
  });
}

/** The section's text, HTML comments removed, or null when there is no heading.
 * Heading-like lines inside fenced code blocks (shell comments) never end it. */
export function manualDeploySection(body) {
  const text = String(body ?? "").replace(/\r\n/g, "\n").replace(/<!--[\s\S]*?-->/g, "");
  const lines = linesWithFence(text);
  const start = lines.findIndex((l) => !l.code && HEADING.test(l.line));
  if (start === -1) return null;
  const level = HEADING.exec(lines[start].line)[1].length;
  const next = new RegExp(`^#{1,${level}}[ \\t]+\\S`);
  const out = [];
  for (const l of lines.slice(start + 1)) {
    if (!l.code && next.test(l.line)) break;
    out.push(l.line);
  }
  return out.join("\n").trim();
}

/** The section split into steps. A step ends with its checkboxes, as in the PR
 * template (command, then « - [ ] dev / - [ ] prod: ticket »): the next unindented
 * line that is not a checkbox starts a new step. An unindented numbered item or a
 * sub-heading also starts one. Indented lines (notes under a numbered item, a
 * ticket link wrapped under its checkbox) stay in their step. A leading intro
 * line ending with a colon (« Run these after the merge: ») is not a step. */
export function manualDeploySteps(section) {
  const steps = [];
  let current = [];
  let seenBox = false;
  const flush = () => {
    if (current.some((x) => x.trim())) steps.push(current.join("\n").trim());
    current = [];
    seenBox = false;
  };
  for (const l of linesWithFence(section)) {
    const line = l.line;
    const unindented = /^\S/.test(line);
    const box = !l.code && IS_CHECKBOX.test(line);
    // A code block opening after the checkboxes starts the next step too.
    const starts = (!l.code || l.opens) && unindented && !box && (seenBox || STEP_START.test(line));
    if (starts && current.some((x) => x.trim())) flush();
    current.push(line);
    if (box) seenBox = true;
  }
  flush();
  // An intro ("Run these after the merge:") ends with a colon; any other leading
  // text is a step and is checked like the others.
  const isIntro = (step) =>
    !/^\d+[.)]/.test(step) && !step.includes("`") && !step.split("\n").some((x) => IS_CHECKBOX.test(x)) && /:\s*$/.test(step);
  if (steps.length > 1 && isIntro(steps[0])) steps.shift();
  return steps;
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
  if (NONE.test(section) && !NAMES_ENV.test(section)) return [];

  const errors = [];
  manualDeploySteps(section).forEach((step, i) => {
    const which = `Step ${i + 1} ("${step.split("\n")[0].slice(0, 60)}")`;
    if (!step.includes("`")) {
      const bare = !step.split("\n").some((x) => IS_CHECKBOX.test(x));
      errors.push(`${which}: give the exact command in backticks or a code block.${bare ? " (A note? Indent it under its step.)" : ""}`);
    }
    if (!CHECKBOX("prod").test(step)) {
      errors.push(`${which}: add a "- [ ] prod" checkbox (and "- [ ] dev" where it applies).`);
    } else if (!TICKET.test(step)) {
      errors.push(`${which}: link the Exponential ticket that tracks the prod step (https://www.exponential.im/w/clear/products/clear/tickets/<number>).`);
    }
  });
  return errors;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const errors = checkManualDeploySteps(process.env.PR_BODY);
  for (const e of errors) console.log(`::error title=Manual deploy steps::${e}`);
  if (errors.length) process.exit(1);
  console.log("Manual deploy steps: OK");
}
