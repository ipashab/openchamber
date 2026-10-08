# OpenChamber fork release notes

**Base:** upstream `openchamber/openchamber` @ `733fa61` (2026-10-07), which is
upstream `2.2.0`. The fork pins that base and numbers its own patches with
the `forkN` marker. Each release's notes below carry only that release's
changes; `fork1` was the fork's first release, so its section is the whole
set that shipped then.

---

## `2.2.0-fork3` — a finished task carries its result

**The board answers "what did it conclude?" without opening the chat.**
`team.task_update` takes `result`: the owner's final answer, attached in
the same call that marks its own task completed. The teammate briefing and
the tool description say to write the conclusion the user should read,
not a log.

- The result lives on the task, capped at 8000 chars at the parse
  boundary; `teams.json` persists it with the rest of the board.
- Reopening the task drops the stale answer — the board never shows a
  result the task's current status contradicts; a fresh completion
  attaches a fresh one. An empty `result` clears it.
- The details dialog shows a **Result** section on a completed task —
  the text, or an honest line when the owner finished without one; the
  card tooltip carries the answer before the click.
- Tasks completed before this release show the no-result line: their
  answers were never stored.

Assets for this release: `OpenChamber-beta-2.2.0-fork3-mac-arm64.dmg` (and
the zip) — macOS, Apple silicon.

---

## `2.2.0-fork2` — missions queue settings

**The Goals page grows a queue settings card.** How many goals run at
once (1–16, default two) and the watch window in minutes (1–1440, default
one hour). The values live beside the queue in `missions.json` and
survive restarts; a stored value outside the bounds falls back to the
default instead of refusing to boot.

- Raising the limit starts queued goals on the same pass; lowering it
  only stops admissions — running goals are not cancelled.
- A new window arms the watches started after the change; running
  watches keep theirs, so a turn finishing right now is not judged by a
  window it never had.

Assets for this release: `OpenChamber-beta-2.2.0-fork2-mac-arm64.dmg` (and
the zip) — macOS, Apple silicon.

---

## `2.2.0-fork1` — the fork's first release: team operations

The fork turns **Team Mode into a first-class surface** — everything a
team is stays observable from the app — and ships three more product
blocks on top: **Missions**, goal prompts filed into a paced queue of
sessions and teams of their own; **Contacts**, saved assistant personas
each keeping one continuing chat; and three chat flow gifts.

### Team Mode core

**Roster, mailbox, and board from one panel.** A team session's
work-status panel grows a Team section: the roster with every member's
live status and identity colors, the shared task board, and the mailbox
tail — one fetch, refreshed by `openchamber:team-*` event frames.

**Sub-teams and live roster editing.** Four sub-team areas (analytics,
development, review, QA), one lead per domain, domain members report to
their lead instead of the Team Lead. The lead and the user can edit the
roster of a live team: add members, re-brief, remove.

**Task details and portable presets.** Every task opens a details
dialog: brief, owner, blocked-by chain, PR link. Team presets — built-in
recipes plus the user's own saved lineups — so the next team starts one
click away.

**Identity colors.** Stable per-member colors from theme tokens —
readable in light and dark, consistent across roster, board, and
activity.

**Ask the lead to staff.** "Ask the lead to staff a role" turns a plain
wish ("someone to review diffs in fr") into a delegated hiring request —
the lead answers with a named agent and brief, the user confirms or
edits.

**Activity face.** A shared activity feed with the whole team's moves —
messages, task writes, PR changes — paged, with member colors.

**Quick-add a task.** An "Add task" action on the board face: subject,
optional brief, optional owner — the task carries `'user'` when the user
files it themselves.

**A task card answers for its pull request.** Both task tools take a
`prUrl`; the card shows a PR chip with draft/open state, mergeability and
CI verdict from lazily loaded GitHub state (60s cache). Details carry the
clickable link and inline editing.

**A selection can put a task on the board.** In a team chat, the
selection menu grows a **Team task** action: first line becomes the
subject, the rest rides as the brief — via the same quick-add endpoint.

### Missions — goal prompts into a paced queue

A **Goals** page in the sidebar. File a goal prompt, pick a mode — a
fresh **session** that receives it, or a lead-led **team** whose first
task it is — and walk away.

- The executor paces the file: two lanes at a time, the rest queued.
- Each mission's turn is observed and marked completed when it goes
  idle after busy; the watch ends after an hour, so nothing wedges the
  queue.
- Retry, cancel, delete from the list; jump into the working session.
- State survives restarts; every state move is an event frame the page
  refetches on.

### Contacts — saved personas, one continuing chat each

A **Contacts** page beside Goals. Save an assistant as a person: name,
description, the prompt that defines it, optionally a model and an agent.
Each contact keeps one chat and it stays one: open the contact and the
same thread continues; if the thread was deleted, the contact starts a
fresh one seeded with its persona. The persona rides as the first
message, so the model answers as the saved role from the very first
reply.

- Five routes under `/api/openchamber/assistants`; the store lives
  beside the team and mission files.
- Every write broadcasts an `openchamber:assistant-*` frame; open pages
  refetch on it.
- Address-book cards with identity colors, inline create/edit form.

### Chat flow

**`/compactnew`.** Compact the long chat and continue in a fresh one
seeded with the summary — the old chat stays in the list as the archive.

Assets for this release: `OpenChamber-beta-2.2.0-fork1-mac-arm64.dmg` (and
the zip) — macOS, Apple silicon.

---

## Distribution notes

The app is ad-hoc signed and not notarized: on first launch macOS may
refuse it, so right-click → Open once, or run
`xattr -dr com.apple.quarantine "/Applications/OpenChamber Beta.app"`
after dragging it to Applications.

The beta flavor installs beside stock OpenChamber (own `productName`,
appId and icon), so both can live on one machine.

## Conventions

All user-facing strings translated in the 13 locales the app ships.
Theme tokens only — no hardcoded palette. Server contracts documented in
`packages/web/server/lib/team/DOCUMENTATION.md`,
`packages/web/server/lib/missions/DOCUMENTATION.md` and
`packages/web/server/lib/assistants/DOCUMENTATION.md`.
