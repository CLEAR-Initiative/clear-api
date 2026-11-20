import { test } from "node:test";
import assert from "node:assert/strict";
import { checkManualDeploySteps, manualDeploySection } from "./check-manual-deploy-steps.mjs";

const TEMPLATE_COMMENT = "<!-- Required. Write None, or the steps. -->";

test("a missing section fails", () => {
  assert.equal(checkManualDeploySteps("## Why\n\nBecause.").length, 1);
  assert.equal(checkManualDeploySteps(undefined).length, 1);
});

test("a section left as the template comment fails", () => {
  const body = `## Why\n\nx\n\n## Manual deploy steps\n\n${TEMPLATE_COMMENT}\n\n## Merge Danger\n\nNone`;
  assert.match(checkManualDeploySteps(body)[0], /blank/);
});

test("None passes, with or without a reason", () => {
  assert.deepEqual(checkManualDeploySteps(`## Manual deploy steps\n${TEMPLATE_COMMENT}\nNone`), []);
  assert.deepEqual(checkManualDeploySteps("### Manual deploy steps\n\nNone. Docs only.\n"), []);
});

test("a step with a command, dev and prod boxes and a ticket passes", () => {
  const body = [
    "## Manual deploy steps",
    "",
    "Insert the source row:",
    "```sql",
    "INSERT INTO data_sources (name) VALUES ('x');",
    "```",
    "- [x] dev",
    "- [ ] prod — https://www.exponential.im/w/clear/products/clear/tickets/1520",
  ].join("\r\n");
  assert.deepEqual(checkManualDeploySteps(body), []);
});

test("a step without a prod checkbox, command or ticket fails", () => {
  const noBox = "## Manual deploy steps\n\nInsert the row by hand: `INSERT …`";
  assert.match(checkManualDeploySteps(noBox).join(), /prod/);
  const noTicket = "## Manual deploy steps\n\n`INSERT …`\n- [ ] dev\n- [ ] prod";
  assert.match(checkManualDeploySteps(noTicket).join(), /ticket/);
  const noCommand = "## Manual deploy steps\n\nInsert the row.\n- [ ] prod https://www.exponential.im/w/clear/products/clear/tickets/1";
  assert.match(checkManualDeploySteps(noCommand).join(), /command/);
});

test("the section ends at the next heading of the same level, not a sub-heading", () => {
  const body = "## Manual deploy steps\n\n### Row\n\n`x`\n- [ ] prod https://www.exponential.im/w/clear/products/clear/tickets/2\n\n## Merge Danger\n\nNone";
  assert.match(manualDeploySection(body), /Row/);
  assert.doesNotMatch(manualDeploySection(body), /Merge Danger/);
});

const TICKET_URL = "https://www.exponential.im/w/clear/products/clear/tickets/1520";

test("a shell comment inside a code block does not end the section", () => {
  const body = [
    "## Manual deploy steps",
    "",
    "Set the secret:",
    "```bash",
    "# Set the secret",
    "## and restart",
    "vault put x",
    "```",
    "- [ ] dev",
    `- [ ] prod ${TICKET_URL}`,
    "",
    "## Why",
    "x",
  ].join("\n");
  assert.deepEqual(checkManualDeploySteps(body), []);
  assert.doesNotMatch(manualDeploySection(body), /^x$/m);
});

test("None followed by a step for one environment is not a None", () => {
  const body = "## Manual deploy steps\n\nNone for dev. For prod, add the new source row.\n";
  assert.ok(checkManualDeploySteps(body).length > 0);
});

test("each step is checked, not only the first", () => {
  const body = [
    "## Manual deploy steps",
    "",
    "1. Insert the row: `INSERT …`",
    `   - [ ] prod ${TICKET_URL}`,
    "2. Also add the new secret in prod.",
  ].join("\n");
  const errors = checkManualDeploySteps(body);
  assert.ok(errors.length > 0);
  assert.ok(errors.every((e) => e.startsWith("Step 2")));
});

test("two complete steps pass", () => {
  const body = [
    "## Manual deploy steps",
    "",
    "1. Insert the row: `INSERT …`",
    "   - [ ] dev",
    `   - [ ] prod ${TICKET_URL}`,
    "2. Set the secret: `vault put x`",
    `   - [ ] prod ${TICKET_URL}`,
  ].join("\n");
  assert.deepEqual(checkManualDeploySteps(body), []);
});

test("two steps in the template's own shape are checked one by one", () => {
  const body = [
    "## Manual deploy steps",
    "",
    "```sql",
    "INSERT INTO data_sources (name) VALUES ('x');",
    "```",
    "- [ ] dev",
    `- [ ] prod: ${TICKET_URL}`,
    "",
    "```bash",
    "vault put secret",
    "```",
  ].join("\n");
  const errors = checkManualDeploySteps(body);
  assert.ok(errors.length > 0);
  assert.ok(errors.every((e) => e.startsWith("Step 2")));
});

test("a note nested under a numbered step stays in that step", () => {
  const body = [
    "## Manual deploy steps",
    "",
    "1. Insert: `INSERT x`",
    "   - Run it after the deploy.",
    "   - [ ] dev",
    `   - [ ] prod ${TICKET_URL}`,
  ].join("\n");
  assert.deepEqual(checkManualDeploySteps(body), []);
});

test("an intro line before the steps is not a step", () => {
  const body = [
    "## Manual deploy steps",
    "",
    "Run these after the merge:",
    "",
    "1. Insert: `INSERT x`",
    `   - [ ] prod ${TICKET_URL}`,
    "2. Set the secret: `vault put y`",
    `   - [ ] prod ${TICKET_URL}`,
  ].join("\n");
  assert.deepEqual(checkManualDeploySteps(body), []);
});

test("a ticket link wrapped under its checkbox stays in the step", () => {
  const body = ["## Manual deploy steps", "", "`INSERT x`", "- [ ] prod", `  ${TICKET_URL}`].join("\n");
  assert.deepEqual(checkManualDeploySteps(body), []);
});

test("None with any reason passes, None for one environment does not", () => {
  for (const ok of ["None needed", "None required.", "None (docs only)", "None", "None. Docs only.", "None: CI only", "None for this PR."]) {
    assert.deepEqual(checkManualDeploySteps(`## Manual deploy steps\n\n${ok}\n`), [], ok);
  }
  for (const bad of ["None for dev. For prod, add the row.", "None in dev, but prod needs the secret.", "None on dev.", "None, but prod needs the secret."]) {
    assert.ok(checkManualDeploySteps(`## Manual deploy steps\n\n${bad}\n`).length > 0, bad);
  }
});

test("leading text that is not an intro is a step and is checked", () => {
  const body = [
    "## Manual deploy steps",
    "",
    "Rotate the API key in prod by hand.",
    "",
    "1. Insert: `INSERT x`",
    `   - [ ] prod ${TICKET_URL}`,
  ].join("\n");
  const errors = checkManualDeploySteps(body);
  assert.ok(errors.length > 0);
  assert.ok(errors.every((e) => e.startsWith("Step 1")));
});

test("an unindented note after the last step fails with a hint to indent it", () => {
  const body = ["## Manual deploy steps", "", "`INSERT x`", `- [ ] prod ${TICKET_URL}`, "Both steps are idempotent."].join("\n");
  const errors = checkManualDeploySteps(body);
  assert.ok(errors.some((e) => e.startsWith("Step 2") && /Indent it under its step/.test(e)));
});

test("a ~~~ line inside a ``` block is content, not the end of the block", () => {
  const body = [
    "## Manual deploy steps",
    "",
    "```bash",
    "cat > notes.md <<'MD'",
    "~~~",
    "## Not a heading",
    "~~~",
    "MD",
    "```",
    `- [ ] prod ${TICKET_URL}`,
    "",
    "## Why",
    "x",
  ].join("\n");
  assert.deepEqual(checkManualDeploySteps(body), []);
});

test("a None that names an environment gets one clear message", () => {
  for (const body of ["None. No prod impact.", "None: merges into dev only, nothing to run."]) {
    const errors = checkManualDeploySteps(`## Manual deploy steps\n\n${body}\n`);
    assert.equal(errors.length, 1, body);
    assert.match(errors[0], /Write just "None"/, body);
  }
});
