# Agent Instructions

> **Important**: Read `CLAUDE.md` for full project context, especially the **Database Architecture** section before making any database or Prisma changes.

This project uses **[Exponential](https://www.exponential.im)** for issue tracking (workspace `clear`, product `clear`). Full conventions — ticket types, statuses, triage mapping, feature/PRD flow — live in [`docs/agents/issue-tracker.md`](docs/agents/issue-tracker.md).

The `.beads/` directory is a leftover from the previous tracker (beads / `bd`). It is unmaintained — don't file or update work there.

## Quick Reference

Agents must call the CLI with their own service-account home (`<agent>` is `claude` or `codex`). Without the `HOME=` prefix the call authenticates as James's personal account and every write is misattributed to him.

```bash
HOME=~/.config/agent-homes/<agent> exponential auth whoami                                    # Verify identity before writing
HOME=~/.config/agent-homes/<agent> exponential tickets list --product clear --status READY_TO_PLAN  # Find available work
HOME=~/.config/agent-homes/<agent> exponential tickets get <ticket-cuid>                      # View ticket details
HOME=~/.config/agent-homes/<agent> exponential tickets update --id <ticket-cuid> --status IN_PROGRESS  # Claim work
HOME=~/.config/agent-homes/<agent> exponential tickets update --id <ticket-cuid> --status QA  # Hand off for review
```

`/start-ticket` and `/ship-ticket` bookend work on a ticket.

When mentioning a ticket in chat, commits, PR bodies, or docs, deep-link it: `https://www.exponential.im/w/clear/products/clear/tickets/<number>`, where `<number>` is the ticket's `number` field (not its cuid). Never link to the bare `.../tickets` list page.

## Landing the Plane (Session Completion)

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File tickets for remaining work** - Create Exponential tickets for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update ticket status** - Move finished work to `QA`, update in-progress tickets
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
