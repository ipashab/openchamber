# OpenChamber Fork — Team Mode Release

**Base:** upstream `openchamber/openchamber` @ `733fa61` (2026-10-07)
**Fork tag:** `fork-team-mode-1`

This release turns **Team Mode into a first-class surface** — everything a
team is stays observable from the app — and ships one new product block on
top: **Missions**, goal prompts filed into a paced queue of sessions and
teams of their own. Plus three chat flow gifts.

---

## Team Mode core

**Roster, mailbox, and board from one panel.** A team session's work-status
panel grows a Team section: the roster with every member's live status and
identity colors, the shared task board, and the mailbox tail — one fetch,
refreshed by `openchamber:team-*` event frames.

**Sub-teams and live roster editing.** Four sub-team areas (analytics,
development, review, QA), one lead per domain, domain members report to
their lead instead of the Team Lead. The lead and the user can edit the
roster of a live team: add members, re-brief, remove.

**Task details and portable presets.** Every task opens a details dialog:
brief, owner, blocked-by chain, PR link. Team presets — built-in recipes
plus the user's own saved lineups — so the next team starts one click away.

**Identity colors.** Stable per-member colors from theme tokens — readable
in light and dark, consistent across roster, board, and activity.

**Ask the lead to staff.** "Ask the lead to staff a role" turns a plain
wish ("someone to review diffs in fr") into a delegated hiring request —
the lead answers with a named agent and brief, the user confirms or edits.

**Activity face.** A shared activity feed with the whole team's moves —
messages, task writes, PR changes — paged, with member colors.

**Quick-add a task.** An "Add task" action on the board face: subject,
optional brief, optional owner — the task carries `'user'` when the user
files it themselves.

**A task card answers for its pull request.** Both task tools take a
`prUrl`; the card shows a PR chip with draft/open state, mergeability and
CI verdict from lazily loaded GitHub state (60s cache). Details carry the
clickable link and inline editing.

**A selection can put a task on the board.** In a team chat, the selection
menu grows a **Team task** action: first line becomes the subject, the
rest rides as the brief — via the same quick-add endpoint.

## Chat flow

**`/compactnew`.** Compact the long chat and continue in a fresh one
seeded with the summary — the old chat stays in the list as the archive.

## Missions — goal prompts into a paced queue

A **Goals** page in the sidebar. File a goal prompt, pick a mode — a fresh
**session** that receives it, or a lead-led **team** whose first task it
is — and walk away.

- The executor paces the file: two lanes at a time, the rest queued.
- Each mission's turn is observed and marked completed when it goes idle
  after busy; the watch ends after an hour, so nothing wedges the queue.
- Retry, cancel, delete from the list; jump into the working session.
- State survives restarts; every state move is an event frame the page
  refetches on.

---

## Distribution

The beta flavor installs beside stock OpenChamber (own `productName`,
appId and icon) — `chamber-beta` from the DMG below.

## Conventions

All user-facing strings translated in the 13 locales the app ships.
Theme tokens only — no hardcoded palette. Server contracts documented in
`packages/web/server/lib/team/DOCUMENTATION.md` and
`packages/web/server/lib/missions/DOCUMENTATION.md`.
