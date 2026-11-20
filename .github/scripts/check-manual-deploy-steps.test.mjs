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
