// Builds the body of a `dev → prod` sync PR: every PR the sync ships, and the
// manual deploy steps those PRs declared, as a checklist that must be ticked
// before the sync merges.
//
// Why this exists: sync PRs were opened with an empty body bundling ~10 PRs, so
// the manual steps their authors had written down never reached the person
// merging. On 2026-11-13 clear-api #340 and clear-pipeline #204 merged a minute
// apart; between them they shipped clear-api #282 (the `iom_dtm_flash_alerts`
// row, seed-only) and clear-pipeline #149 (the code that looks it up), and prod
// ran for seven days without the row — a repeat of the 2026-10-20 idmc
// incident. See the 2026-11-13 postmortem, recommendation 4 (clear #1525).
//
// The steps themselves are parsed with the same module that gates every PR into
// dev (check-manual-deploy-steps.mjs, clear #1524), so this reads exactly the
// grammar the PR template asks authors for.
//
// Nothing here is repo-specific: the repo comes from GITHUB_REPOSITORY and the
// branches from BASE/HEAD_REF. The same file lives in clear-api and
// clear-pipeline, as check-manual-deploy-steps.mjs does; keep them in step.
//
// Run by .github/workflows/sync-pr-body.yml. Tests:
//   node --test .github/scripts/build-sync-pr-body.test.mjs
//
// Usage:
//   node .github/scripts/build-sync-pr-body.mjs render   # print the body
//   node .github/scripts/build-sync-pr-body.mjs check    # exit 1 while prod boxes are unticked
//
// Environment: GH_TOKEN (or GITHUB_TOKEN), GITHUB_REPOSITORY, and for `check`
// the current body in PR_BODY. BASE/HEAD default to prod/dev.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { manualDeploySection, manualDeploySteps } from "./check-manual-deploy-steps.mjs";

export const START = "<!-- sync-pr-body:start -->";
export const END = "<!-- sync-pr-body:end -->";

// An invisible anchor written before each step, so a tick can be matched to the
// step that earned it. `<pr>.<ordinal>` alone would move a tick to a different
// step if a PR's steps were reordered, so the step's own text is hashed in: when
// a step changes, its anchor changes and the tick is dropped rather than
// inherited. Markdown hides it; losing it (someone editing the block by hand)
// only costs a tick, which fails closed.
const stepAnchor = (number, ordinal, step) =>
  `<!-- step ${number}.${ordinal} ${createHash("sha1").update(step).digest("hex").slice(0, 8)} -->`;
const STEP_ANCHOR = /^<!--[ \t]*step[ \t]+([\w.]+[ \t]+[0-9a-f]{8})[ \t]*-->[ \t]*$/;

// "Merge pull request #149 from CLEAR-Initiative/feat/x" (merge commit) and
// "feat(gx): add the source (#149)" (squash merge, the default here).
const MERGE_SUBJECT = /^Merge pull request #(\d+) from /;
const SQUASH_SUBJECT = /\(#(\d+)\)\s*$/;

const CHECKBOX_LINE = /^(\s*[-*][ \t]+)\[([ xX])\]([ \t]+.*)$/;
const PROD_BOX = /^\s*[-*][ \t]+\[[ xX]\][ \t]+prod\b/i;

// PRs merged before the "Manual deploy steps" section was required (#218) only
// ever wrote the step under this heading, so a sync that reaches back past it
// still has somewhere to look.
const MERGE_DANGER = /^(#{2,6})[ \t]*merge danger[ \t]*$/i;
const NONE = /^none\b/i;

/** PR numbers referenced by commit subjects, in the order they appear, deduped.
 * Only the first line of each message is read: a squash body quoting "(#12)"
 * from a child commit is not a PR this sync ships. */
export function prNumbersFromMessages(messages) {
  const seen = new Set();
  for (const message of messages) {
    const subject = String(message ?? "").split("\n")[0];
    const match = MERGE_SUBJECT.exec(subject) ?? SQUASH_SUBJECT.exec(subject);
    if (match) seen.add(Number(match[1]));
  }
  return [...seen];
}

/** The body text under the first `## Merge Danger` heading, or "". Mirrors
 * manualDeploySection's shape; used only for PRs with no steps section. */
export function mergeDangerSection(body) {
  const text = String(body ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/<!--[\s\S]*?-->/g, "");
  const lines = text.split("\n");
  const start = lines.findIndex((line) => MERGE_DANGER.test(line));
  if (start === -1) return "";
  const level = MERGE_DANGER.exec(lines[start])[1].length;
  const next = new RegExp(`^#{1,${level}}[ \\t]+\\S`);
  const out = [];
  for (const line of lines.slice(start + 1)) {
    if (next.test(line)) break;
    out.push(line);
  }
  return out.join("\n").trim();
}

/** Force every `prod` checkbox in a step to unticked. A tick carried over from
 * the feature PR means "done on dev's clone of this step", never "done on prod":
 * the sync PR is where the prod tick is earned. */
function resetProdBoxes(step) {
  return step
    .split("\n")
    .map((line) => (PROD_BOX.test(line) ? line.replace(/\[[xX]\]/, "[ ]") : line))
    .join("\n");
}

/** What one PR contributes to the sync: `none`, `steps`, `legacy` (no section,
 * but a Merge Danger note worth reading) or `missing`. */
export function classifyPr(pr) {
  const base = {
    number: pr.number,
    title: pr.title ?? "",
    url: pr.url ?? "",
    author: pr.author?.login ?? pr.user?.login ?? "",
  };
  const section = manualDeploySection(pr.body);
  if (section === null || section === "") {
    const danger = mergeDangerSection(pr.body);
    const informative = danger && !NONE.test(danger);
    return { ...base, kind: informative ? "legacy" : "missing", steps: [], danger: informative ? danger : "" };
  }
  if (NONE.test(section) && !/\b(?:dev|prod|production|staging)\b/i.test(section)) {
    return { ...base, kind: "none", steps: [], danger: "" };
  }
  return { ...base, kind: "steps", steps: manualDeploySteps(section).map(resetProdBoxes), danger: "" };
}

/** The generated body, wrapped in the markers so a human can add prose around
 * it and a re-run replaces only this block. */
export function renderSyncBody(prs, { base = "prod", head = "dev", sha = "" } = {}) {
  const withSteps = prs.filter((pr) => pr.kind === "steps");
  const legacy = prs.filter((pr) => pr.kind === "legacy");
  const label = (pr) => `[#${pr.number}](${pr.url}) — ${pr.title}${pr.author ? ` (@${pr.author})` : ""}`;

  const out = [START, `## Shipping \`${head}\` → \`${base}\``, ""];

  if (prs.length === 0) {
    out.push(`No pull requests found in \`${base}..${head}\`. Nothing to ship.`, "", END);
    return out.join("\n");
  }

  out.push(
    `**${prs.length}** pull request${prs.length === 1 ? "" : "s"} since the last sync, ` +
      `**${withSteps.length}** with manual deploy steps.`,
    "",
  );

  if (withSteps.length > 0) {
    out.push(
      "## Manual deploy steps",
      "",
      "**Do not merge until every `prod` box below is ticked.** Each step is copied",
      "from the PR that declared it; tick a box only once you have run it against",
      "prod. Re-running the generator keeps the boxes you have already ticked.",
      "",
    );
    for (const pr of withSteps) {
      out.push(`### ${label(pr)}`, "");
      out.push(...pr.steps.flatMap((step, i) => [stepAnchor(pr.number, i + 1, step), step, ""]));
    }
  } else {
    out.push("## Manual deploy steps", "", "None declared by the PRs in this sync.", "");
  }

  if (legacy.length > 0) {
    out.push(
      "## Read these by hand",
      "",
      'These predate the required "Manual deploy steps" section (clear #1524), so',
      "their Merge Danger notes are reproduced instead. Check whether any of them",
      "needs a step on prod.",
      "",
    );
    for (const pr of legacy) {
      out.push(`### ${label(pr)}`, "", "> " + pr.danger.split("\n").join("\n> "), "");
    }
  }

  out.push("## Pull requests in this sync", "", "In merge order, which is the order they reach prod.", "");
  const note = {
    steps: "manual deploy steps",
    none: "None",
    legacy: "no section — Merge Danger reproduced above",
    missing: "no section (predates clear #1524)",
  };
  for (const pr of prs) out.push(`- ${label(pr)} — ${note[pr.kind]}`);
  out.push("", `<sub>Generated from \`${base}..${head}\`${sha ? ` at ${sha.slice(0, 7)}` : ""}.</sub>`, END);
  return out.join("\n");
}

/** The generated block's contents, or "" when the body has none. Ticks outside
 * it are none of our business — in particular the PR template's commented-out
 * example, which a sync PR keeps above the block. */
function generatedBlock(body) {
  const text = String(body ?? "");
  const start = text.indexOf(START);
  const end = text.indexOf(END);
  return start === -1 || end === -1 || end < start ? "" : text.slice(start + START.length, end);
}

/** Ticked checkbox labels from a previous body, grouped by the step anchor they
 * sit under, so a tick can only come back to the step that earned it. */
function tickedByStep(previous) {
  const out = new Map();
  let anchor = "";
  for (const line of generatedBlock(previous).split("\n")) {
    const mark = STEP_ANCHOR.exec(line);
    if (mark) {
      anchor = mark[1];
      continue;
    }
    const box = CHECKBOX_LINE.exec(line);
    if (!box || box[2] === " ") continue;
    if (!out.has(anchor)) out.set(anchor, new Set());
    out.get(anchor).add(box[3].trim());
  }
  return out;
}

/** `next` with every checkbox re-ticked that was ticked on the same step in
 * `previous`. Without this, the workflow's own re-run on `synchronize` would
 * silently clear the prod ticks someone had earned.
 *
 * Matching is per step, not per label. Two steps may legitimately carry the same
 * checkbox text: the gate accepts a bare `- [ ] prod` when the ticket is named
 * elsewhere in the step, so several steps can read exactly `- [ ] prod`. Keying
 * on the label alone let one tick approve all of them, and the sync then passed
 * with prod work undone — the failure this script exists to prevent. */
export function preserveTicks(previous, next) {
  const ticked = tickedByStep(previous);
  if (ticked.size === 0) return next;
  let anchor = "";
  return next
    .split("\n")
    .map((line) => {
      const mark = STEP_ANCHOR.exec(line);
      if (mark) {
        anchor = mark[1];
        return line;
      }
      const box = CHECKBOX_LINE.exec(line);
      if (!box || box[2] !== " " || !ticked.get(anchor)?.has(box[3].trim())) return line;
      return `${box[1]}[x]${box[3]}`;
    })
    .join("\n");
}

/** Replace the generated block in `body`, or append it when there is none, so
 * prose a human added outside the markers survives. */
export function spliceBody(body, generated) {
  const text = String(body ?? "");
  const start = text.indexOf(START);
  const end = text.indexOf(END);
  if (start === -1 || end === -1 || end < start) {
    return text.trim() ? `${text.trim()}\n\n${generated}\n` : `${generated}\n`;
  }
  return `${text.slice(0, start)}${generated}${text.slice(end + END.length)}`;
}

/** Unticked `prod` checkboxes in the body — the sync's remaining work.
 *
 * HTML comments are dropped first. GitHub prefills a new PR with
 * .github/pull_request_template.md, whose commented-out example contains
 * `- [ ] prod: …/tickets/<number>`; spliceBody keeps that prose above the
 * generated block, so counting it would block every sync — including one with
 * no manual steps at all — on a checkbox nobody can see or tick. Boxes a human
 * wrote outside the block still count: those are visible and real. */
export function pendingProdBoxes(body) {
  return String(body ?? "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .split("\n")
    .filter((line) => PROD_BOX.test(line) && /\[[ ]\]/.test(line))
    .map((line) => line.trim());
}

// ─── GitHub access ──────────────────────────────────────────────────────────

// A sync bundles ~10 PRs, so a render makes ~11 API calls and a single network
// blip would otherwise abort the whole body. Retry, then fail: a body that
// silently omits a PR is the exact failure this script exists to prevent, so
// there is no partial-success path.
function gh(args, attempts = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      if (attempt >= attempts) throw error;
      console.error(`gh ${args[1]} failed (attempt ${attempt}/${attempts}), retrying: ${error.message.split("\n")[0]}`);
      execFileSync("sleep", [String(attempt * 2)]);
    }
  }
}

/** The PRs in `base..head`, in commit order. `--paginate` is deliberately not
 * used: it concatenates one JSON object per page, which `JSON.parse` cannot
 * read. One page carries the compare API's maximum of 250 commits and reports
 * `total_commits`, so the guard below catches the case instead. A sync that
 * large is itself the problem this ticket exists to prevent. */
export function fetchPrs(repo, base, head, run = gh) {
  const compare = JSON.parse(run(["api", `repos/${repo}/compare/${base}...${head}`]));
  if (compare.total_commits > compare.commits.length) {
    throw new Error(
      `${base}..${head} has ${compare.total_commits} commits but the compare API returned ` +
        `${compare.commits.length}. Sync more often, or page through the commits by hand.`,
    );
  }
  const numbers = prNumbersFromMessages(compare.commits.map((c) => c.commit.message));
  return numbers.map((number) =>
    classifyPr(
      JSON.parse(run(["api", `repos/${repo}/pulls/${number}`, "--jq", "{number,title,url:.html_url,body,user}"])),
    ),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const mode = process.argv[2] ?? "render";
  const repo = process.env.GITHUB_REPOSITORY;
  const base = process.env.BASE || "prod";
  const head = process.env.HEAD_REF || "dev";

  if (mode === "check") {
    const pending = pendingProdBoxes(process.env.PR_BODY);
    if (pending.length === 0) {
      console.log("Manual deploy steps: every prod box is ticked.");
    } else {
      console.log(
        `::error title=Prod steps pending::${pending.length} prod step(s) still unticked. ` +
          "Run each against prod, tick its box, then merge.",
      );
      for (const box of pending) console.log(`  ${box}`);
      process.exit(1);
    }
  } else if (mode === "render") {
    if (!repo) throw new Error("GITHUB_REPOSITORY is required");
    const prs = fetchPrs(repo, base, head);
    const generated = renderSyncBody(prs, { base, head, sha: process.env.GITHUB_SHA ?? "" });
    process.stdout.write(preserveTicks(process.env.PR_BODY, spliceBody(process.env.PR_BODY, generated)));
  } else {
    throw new Error(`unknown mode "${mode}" (expected "render" or "check")`);
  }
}
