// Tests for build-sync-pr-body.mjs. Run: node --test .github/scripts/build-sync-pr-body.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  START,
  END,
  classifyPr,
  fetchPrs,
  mergeDangerSection,
  pendingProdBoxes,
  prNumbersFromMessages,
  preserveTicks,
  renderSyncBody,
  spliceBody,
} from "./build-sync-pr-body.mjs";

const STEPS_BODY = `## What
Adds the gx source.

## Manual deploy steps

Insert the source row before the pipeline ships:

\`\`\`bash
psql "$DATABASE_URL" -c "insert into data_sources (name) values ('iom_dtm_flash_alerts')"
\`\`\`
- [x] dev
- [ ] prod: https://www.exponential.im/w/clear/products/clear/tickets/1520
`;

test("prNumbersFromMessages reads merge and squash subjects", () => {
  assert.deepEqual(
    prNumbersFromMessages([
      "Merge pull request #149 from CLEAR-Initiative/feat/gx-source",
      "feat(gx): add the displacement source (#151)",
      "chore: no pr reference here",
    ]),
    [149, 151],
  );
});

test("prNumbersFromMessages dedupes and ignores references in the body", () => {
  assert.deepEqual(
    prNumbersFromMessages([
      "feat: a (#149)",
      "feat: a (#149)",
      "fix: b (#150)\n\nReverts the change from (#999) and closes #998",
    ]),
    [149, 150],
  );
});

test("mergeDangerSection stops at the next heading and drops comments", () => {
  const body = `## Merge Danger
<!-- a comment -->
Requires the source row in clear-api.

## Manual deploy steps
None
`;
  assert.equal(mergeDangerSection(body), "Requires the source row in clear-api.");
  assert.equal(mergeDangerSection("## What\nnothing here"), "");
});

test("classifyPr: None is recorded without steps", () => {
  const pr = classifyPr({ number: 1, title: "t", url: "u", body: "## Manual deploy steps\nNone\n" });
  assert.equal(pr.kind, "none");
  assert.deepEqual(pr.steps, []);
});

test("classifyPr: a step keeps its command and unticks the prod box", () => {
  const pr = classifyPr({ number: 149, title: "add source", url: "u", user: { login: "ines" }, body: STEPS_BODY });
  assert.equal(pr.kind, "steps");
  assert.equal(pr.author, "ines");
  assert.equal(pr.steps.length, 1);
  assert.match(pr.steps[0], /insert into data_sources/);
  // The feature PR had dev ticked; that is preserved as context.
  assert.match(pr.steps[0], /- \[x\] dev/);
  // The prod box must start unticked on the sync PR, even if the source ticked it.
  assert.match(pr.steps[0], /- \[ \] prod:/);
});

test("classifyPr: a prod box ticked on the feature PR is reset", () => {
  const body = STEPS_BODY.replace("- [ ] prod:", "- [x] prod:");
  const [step] = classifyPr({ number: 1, title: "t", url: "u", body }).steps;
  assert.match(step, /- \[ \] prod:/);
  assert.doesNotMatch(step, /- \[x\] prod:/);
});

test("classifyPr: no section falls back to Merge Danger, else missing", () => {
  const legacy = classifyPr({
    number: 2,
    title: "t",
    url: "u",
    body: "## Merge Danger\nNeeds the row inserted by hand.\n",
  });
  assert.equal(legacy.kind, "legacy");
  assert.match(legacy.danger, /inserted by hand/);

  assert.equal(classifyPr({ number: 3, title: "t", url: "u", body: "## What\njust a change" }).kind, "missing");
  assert.equal(classifyPr({ number: 4, title: "t", url: "u", body: "## Merge Danger\nNone\n" }).kind, "missing");
});

test("renderSyncBody lists every PR with a link and carries the steps", () => {
  const prs = [
    classifyPr({ number: 149, title: "add source", url: "https://gh/149", body: STEPS_BODY }),
    classifyPr({ number: 150, title: "tidy up", url: "https://gh/150", body: "## Manual deploy steps\nNone\n" }),
    classifyPr({ number: 151, title: "old one", url: "https://gh/151", body: "## Merge Danger\nCheck the cursor.\n" }),
  ];
  const body = renderSyncBody(prs, { base: "prod", head: "dev", sha: "abcdef1234" });

  assert.ok(body.startsWith(START) && body.endsWith(END));
  for (const n of [149, 150, 151]) assert.match(body, new RegExp(`\\[#${n}\\]\\(https://gh/${n}\\)`));
  assert.match(body, /\*\*3\*\* pull requests since the last sync, \*\*1\*\* with manual deploy steps/);
  assert.match(body, /Do not merge until every `prod` box below is ticked/);
  assert.match(body, /- \[ \] prod:/);
  assert.match(body, /> Check the cursor\./);
  assert.match(body, /at abcdef1/);
});

test("renderSyncBody handles an empty sync", () => {
  const body = renderSyncBody([], { base: "prod", head: "dev" });
  assert.match(body, /Nothing to ship/);
  assert.deepEqual(pendingProdBoxes(body), []);
});

test("pendingProdBoxes counts only unticked prod boxes", () => {
  const body = ["- [ ] prod: ticket", "- [x] prod: done", "- [ ] dev", "- [ ] prod"].join("\n");
  assert.deepEqual(pendingProdBoxes(body), ["- [ ] prod: ticket", "- [ ] prod"]);
});

// Greptile P1 on clear-api #352: GitHub prefills the template, whose commented
// example holds an unticked prod box, so every sync failed on an invisible
// checkbox — even one with no manual steps.
test("pendingProdBoxes ignores boxes inside HTML comments", () => {
  const template = readFileSync(new URL("../pull_request_template.md", import.meta.url), "utf8");
  const body = spliceBody(template, renderSyncBody([], { base: "prod", head: "dev" }));
  assert.ok(/- \[ \] prod/.test(template), "the template really does carry a commented prod example");
  assert.deepEqual(pendingProdBoxes(body), [], "a sync with no manual steps is not blocked by it");
});

test("pendingProdBoxes still counts a visible box a human added outside the block", () => {
  const body = `- [ ] prod: something I noticed\n\n${renderSyncBody([], { base: "prod", head: "dev" })}`;
  assert.deepEqual(pendingProdBoxes(body), ["- [ ] prod: something I noticed"]);
});

/** Two steps on one PR, each with a bare `- [ ] prod` box — a shape the gate
 * accepts, since each names its ticket on its own line. */
const TWO_BARE_BOXES = `## Manual deploy steps

1. First
   \`cmd-a\`
   - [ ] prod
   ticket https://www.exponential.im/w/clear/products/clear/tickets/1
2. Second
   \`cmd-b\`
   - [ ] prod
   ticket https://www.exponential.im/w/clear/products/clear/tickets/2
`;

test("preserveTicks keeps a tick earned on the sync PR across a re-render", () => {
  const prs = [classifyPr({ number: 149, title: "t", url: "u", body: STEPS_BODY })];
  const first = renderSyncBody(prs, { base: "prod", head: "dev" });
  assert.deepEqual(pendingProdBoxes(first).length, 1);

  const ticked = first.replace("- [ ] prod:", "- [x] prod:");
  const merged = preserveTicks(ticked, renderSyncBody(prs, { base: "prod", head: "dev" }));
  assert.deepEqual(pendingProdBoxes(merged), []);
});

test("preserveTicks does not invent ticks for new steps", () => {
  const prs = [classifyPr({ number: 1, title: "t", url: "u", body: STEPS_BODY })];
  const next = renderSyncBody(prs, { base: "prod", head: "dev" });
  assert.equal(preserveTicks("- [x] prod: https://t/old", next), next);
  assert.equal(preserveTicks("", next), next);
});

// Greptile P1 on clear-api #352: keyed on the checkbox label alone, one tick
// re-ticked every identical box, so a sync could pass with prod work undone.
test("preserveTicks does not let one tick approve another step's identical box", () => {
  const prs = [classifyPr({ number: 7, title: "two steps", url: "u", body: TWO_BARE_BOXES })];
  const first = renderSyncBody(prs, { base: "prod", head: "dev" });
  assert.equal(pendingProdBoxes(first).length, 2, "both bare prod boxes start unticked");

  // Tick only the first one, as a human would in the GitHub UI.
  const ticked = first.replace("- [ ] prod", "- [x] prod");
  const merged = preserveTicks(ticked, renderSyncBody(prs, { base: "prod", head: "dev" }));
  assert.equal(pendingProdBoxes(merged).length, 1, "the second step is still outstanding");
});

test("preserveTicks drops a tick when the step's text changed", () => {
  const before = renderSyncBody([classifyPr({ number: 9, title: "t", url: "u", body: STEPS_BODY })], {});
  const ticked = before.replace("- [ ] prod:", "- [x] prod:");
  const changed = STEPS_BODY.replace("iom_dtm_flash_alerts", "something_else");
  const after = renderSyncBody([classifyPr({ number: 9, title: "t", url: "u", body: changed })], {});
  assert.equal(pendingProdBoxes(preserveTicks(ticked, after)).length, 1, "a rewritten step must be re-done");
});

// Greptile P1 on clear-pipeline #226: the last step's anchor stayed in scope
// past END, so a box a human wrote below the block was ticked for them.
test("preserveTicks never ticks a box outside the generated block", () => {
  const prs = [classifyPr({ number: 7, title: "two steps", url: "u", body: TWO_BARE_BOXES })];
  const base = renderSyncBody(prs, { base: "prod", head: "dev" });
  const at = base.lastIndexOf("- [ ] prod");
  const previous = `${base.slice(0, at)}- [x] prod${base.slice(at + "- [ ] prod".length)}\n\n- [ ] prod`;
  const next = `${base}\n\n- [ ] prod`;

  const merged = preserveTicks(previous, next);
  assert.match(merged.slice(merged.indexOf(END)), /- \[ \] prod/, "the human's own box is left alone");
  assert.equal(pendingProdBoxes(merged).length, 2, "their box plus the step that was never ticked");
});

// Greptile P1 on clear-pipeline #226: with a step's anchor deleted, its boxes
// were filed under the previous anchor, so the next render ticked the step
// above instead of dropping the tick.
test("preserveTicks drops ticks for a step whose anchor was deleted", () => {
  const prs = [classifyPr({ number: 7, title: "two steps", url: "u", body: TWO_BARE_BOXES })];
  const base = renderSyncBody(prs, { base: "prod", head: "dev" });
  const anchors = base.split("\n").filter((l) => /^<!-- step /.test(l));
  const mangled = base.replace(`${anchors[1]}\n`, "");
  const at = mangled.lastIndexOf("- [ ] prod");
  const previous = `${mangled.slice(0, at)}- [x] prod${mangled.slice(at + "- [ ] prod".length)}`;

  const merged = preserveTicks(previous, renderSyncBody(prs, { base: "prod", head: "dev" }));
  assert.equal(pendingProdBoxes(merged).length, 2, "nothing is inherited; both steps still need doing");
});

test("preserveTicks survives a human also ticking the dev box", () => {
  const prs = [classifyPr({ number: 149, title: "t", url: "u", body: STEPS_BODY })];
  const previous = renderSyncBody(prs, {}).replace("- [ ] prod:", "- [x] prod:").replace("- [x] dev", "- [X] dev");
  assert.deepEqual(pendingProdBoxes(preserveTicks(previous, renderSyncBody(prs, {}))), []);
});

test("preserveTicks ignores ticks outside the generated block", () => {
  const prs = [classifyPr({ number: 1, title: "t", url: "u", body: STEPS_BODY })];
  const next = renderSyncBody(prs, {});
  const previous = `- [x] prod: https://www.exponential.im/w/clear/products/clear/tickets/1520\n\n${next}`;
  assert.equal(pendingProdBoxes(preserveTicks(previous, next)).length, 1);
});

test("spliceBody replaces the block and keeps surrounding prose", () => {
  const body = `Heads up, deploying after standup.\n\n${START}\nold\n${END}\n\nTrailing note.`;
  const out = spliceBody(body, `${START}\nnew\n${END}`);
  assert.match(out, /Heads up, deploying after standup\./);
  assert.match(out, /Trailing note\./);
  assert.match(out, /new/);
  assert.doesNotMatch(out, /old/);
});

test("spliceBody appends when there is no block, and handles an empty body", () => {
  assert.match(spliceBody("Some prose.", `${START}\nx\n${END}`), /Some prose\.\n\n<!-- sync-pr-body:start -->/);
  assert.equal(spliceBody("", `${START}\nx\n${END}`), `${START}\nx\n${END}\n`);
  assert.equal(spliceBody(undefined, `${START}\nx\n${END}`), `${START}\nx\n${END}\n`);
});

test("fetchPrs asks for each PR found in the compare range", () => {
  const calls = [];
  const run = (args) => {
    calls.push(args.join(" "));
    if (args[1].startsWith("repos/o/r/compare")) {
      return JSON.stringify({
        total_commits: 2,
        commits: [{ commit: { message: "feat: a (#149)" } }, { commit: { message: "fix: b (#150)" } }],
      });
    }
    const number = Number(args[1].split("/").pop());
    return JSON.stringify({ number, title: `pr ${number}`, url: `u${number}`, body: "## Manual deploy steps\nNone" });
  };
  const prs = fetchPrs("o/r", "prod", "dev", run);
  assert.deepEqual(
    prs.map((p) => p.number),
    [149, 150],
  );
  assert.equal(calls[0], "api repos/o/r/compare/prod...dev");
  assert.equal(prs.every((p) => p.kind === "none"), true);
});

test("fetchPrs fails loudly when the compare range is truncated", () => {
  const run = () => JSON.stringify({ total_commits: 400, commits: [{ commit: { message: "feat: a (#1)" } }] });
  assert.throws(() => fetchPrs("o/r", "prod", "dev", run), /has 400 commits but the compare API returned 1/);
});
