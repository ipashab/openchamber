# OpenChamber Fork — Team Mode

This fork carries one coherent block of work on top of upstream
OpenChamber: **Team Mode as a first-class surface** — everything a team
is stays observable from the app, from the roster's identity to the
whole team's activity, and the user can staff and direct a running team
without going through the lead for what is their own decision. Around
that core, the fork answers three more needs the panel surfaced: a task
card that reports on its pull request, a decision in the chat that lands
on the board as a task, **Missions** — goal prompts filed into a paced
queue of sessions and teams of their own, and **Contacts** — saved
assistant personas each keeping one continuing chat.

Fork base: upstream `733fa61` (2026-10-07, upstream version `2.2.0`).
Everything after it is this fork's work; upstream merges cleanly
underneath. The fork keeps upstream's version and adds a prerelease
marker: `2.2.0-fork1`.

Owning docs that move with the code:

- `packages/web/server/lib/team/DOCUMENTATION.md` — the server contract:
  state, events, tool surface, every route the app itself uses.
- `packages/web/server/lib/missions/DOCUMENTATION.md` — the missions
  contract: statuses, the queue's pacing, every route.
- `packages/web/server/lib/assistants/DOCUMENTATION.md` — the contacts
  contract: persona shape, the one-chat rule, every route.
- `packages/ui/src/sync/DOCUMENTATION.md` — the sync side of the panel.

## The features, in the order they landed

### Team Mode core — `faa3ab9`, `480cdfa`

The work-status panel of a team session grows a kanban board: tasks
grouped by status or by teammate, read-only, state owned by the team's
agents. Teammate sessions nest under the lead in the sidebar tree. The
"New Team" action composes a roster — agent, model, brief, skills and
MCP allowances, exactly one lead — and the server spawns the sessions,
gates each member's tools with session permissions, and briefs everyone.
Team presets CRUD in settings (`team-presets.json`), built-ins read-only
but editable as copies.

### Board as a panel tab — `31841df`

The board moves out of the modal into a context-panel surface: a `team`
tab pinned to its session, rendered by one shared `TeamBoardView` (the
mobile and VS Code dialog wrap the same body).

### Sub-teams and live roster editing — `644f61d`

The roster editor reaches a *running* team: members are added through
the same spawn path the lead's tool uses and stopped with the same
approval handshake — the app cannot walk around the tool gating. Sub-team
leads take domain members' reports and pass one summary to the Team
Lead; the session tree nests the way the reporting chain does.

### Task details and portable presets — `4fe541e`, `30bd143`, `9e58674`

A card click opens the whole task — brief, owner, blockers — resolving
ids against the live board. Presets export and import as JSON (one or an
array per file, per-instance fields stripped, failures reported without
overwriting anything). A live team exports as a recipe in one click, both
from the lead's `team.export_preset` action and from the editor. Tool
lists in the editor state what an empty selection means and offer
select-all / clear-all.

### Identity colors — `a3a8b96`

Every member slot carries a stable hue from the theme's `syntax.*`
tokens, pinned per slot in localStorage: the roster chips, member
columns, domain leads, card owner lines and details dialogs all answer
"whose is this" at a glance, and rosters never recolor on membership
changes. Larger rosters wrap the palette instead of failing.

### The Chats face — `18d177f`

The team tab grows parallel read-only chat columns, one per member, in
roster order: identity hue and live status in each column header, unread
team mail beside the name, click-to-open full chat. The Board | Chats |
Activity choice is remembered per team. The panel injects the chat column
renderer to keep the module cycle (`ChatContainer` → work-status panel →
this view) open the other way; mobile and VS Code keep board and
activity.

### Ask the lead to staff — `5c96ebd`

The roster editor says, when the user does not know who to add: a link
opens the lead's chat with a prefilled draft ("Add a teammate suited
for: ...") — the user finishes and sends; the click itself sends nothing.

### The Activity face — `c79d405`

The mailbox and the task board merged into one newest-first feed:
message rows in identity colors, task rows with their latest state,
paging into retained history on an opaque `"<at>:<id>"` cursor, pages
merged by event id. The route pages through exactly what the team
retains; the mailbox cap is untouched.

### Quick-add a task — `eb13415`

An "Add task" action on the board face: the user files a task directly —
subject, optional brief, optional teammate as owner. Assignment rides
the lead's own semantics (mailbox entry + wake with details); the task
carries the `'user'` pseudo-id the panel renders as "You".

### A task card answers for its pull request — `43fcc51`

Both task tools take a `prUrl`, and the board keeps it: a PR chip on the
task card says where the work stands — draft or open, mergeable if
GitHub resolves it, CI green/failing/pending — straight from lazily
loaded GitHub state with a 60-second cache. The card is a button, so the
chip carries no link; the PR row in the task details is the link, and
the same row edits the URL inline.

### A selection can put a task on the team board — `8ca397c`

The chat's selection menu grows a **Team task** action in chats that
belong to a team: the first line of the selection becomes the task
subject, the rest rides as the brief, filed through the same quick-add
endpoint the panel uses. Which team a session belongs to is answered
once by the team section and published to a small membership store the
per-message menu reads — chats outside any team never see the action.

### `/compactnew` continues a long chat in a fresh one — `eb2fa71`

Compaction and the fresh start were two commands the user had to know
to combine — and `/fork` copied the pages the summary was meant to
replace. `/compactnew` does the pair in order: the session is compacted,
then forked from that final state, so the fresh chat starts from the
summary and the old one stays in the list as the archive.

### Missions: goals filed into a paced queue — `7695098`

A **Goals** page in the sidebar. A mission is a goal prompt plus a
mode — a fresh session that receives it, or a lead-led team whose
first task it is. The executor paces the file: two lanes at a time,
the rest queued in creation order, each turn observed and marked
completed when it goes idle after busy; the watch ends after an hour no
matter what, so no session wedges the queue. State survives restarts;
the list hears every state move as an event frame and refetches.

### Contacts: saved personas with one continuing chat — `2e95232c9`

An **Assistants as contacts** page beside Goals. A contact is a person:
name, description, the prompt that defines it, optionally a model and an
agent. One contact means one chat — the same thread continues while it
exists; when it was deleted, opening the contact starts a fresh session
seeded with the persona as its first message, so the model answers as the
saved role from the very first reply. CRUD over five routes under
`/api/openchamber/assistants`, the store beside the team and mission
files, every write an `openchamber:assistant-*` frame the open pages
refetch on.

## Distribution

`3fa5412` packages this fork as "OpenChamber Beta": own `productName`,
`appId` and corner-badge icon, so it installs beside stock OpenChamber
instead of over it. `oc-dev package --flavor beta` produces the DMG;
the icon is rendered from the stock PNG at build time and asset paths
are restored afterwards.

## Conventions this work follows

- Every user-facing string in all 13 locales, translated — no English
  placeholders in non-English dictionaries.
- Agent writes go through the team tools with their permission gating;
  app routes only do what the user themselves does (create a team, edit
  a roster, file a task).
- Theme tokens only — status colors for status, `syntax.*` for identity
  markers; no hardcoded palette.
- Focused tests per contract (route/service vitest in `team/`, isolated
  UI tests per component), `tsc` clean, `oxlint` clean on touched files.
