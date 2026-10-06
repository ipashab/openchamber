# Team Mode

One team of agent sessions working in parallel in one directory: a Team Lead
session plus teammate sessions spawned as its children, coordinated through a
shared mailbox and a shared task board. Adapted from AionUi's Team Mode
behavioral contract; the prompts keep the parts that made it work (the lead
proposes staff before spawning, assignments wake their owner, standby means
ending the turn, dependent work dispatches sequentially).

## Shape

```
packages/web/server/lib/team/
├── tools.js      The openchamber_team tool: action list, lead-only set,
│                  bare-name resolution, and the flat parameter schema.
├── prompts.js    Lead briefing, teammate briefing (first prompt of the
│                  session), wake payload (unread mail + board).
└── service.js    Roster, mailbox, board, wake machinery, event
                  orchestration, persistence, watchdog.
```

A teammate is an ordinary OpenCode session created with `parentID` pointing at
the lead's session, in the lead session's directory. Because they are children,
the existing Subagents panel of the lead session already shows every member's
live status, running time and failures — no new UI. The sessions are the
user's; the coordination state is OpenChamber's own.

## The tool

The tool is a fifth entry in the managed agent-tool plugin (`runtime.js` in
`lib/agent-tool`), always shipped. Settings toggles do not gate it because it
is inert by construction: every action except `team.start` answers 404 for a
session outside a team. The callback route is the shared
`/api/openchamber/agent-tool`; `runtime.execute` branches on
`payload.tool === 'openchamber_team'` and dispatches to the team service,
which re-derives membership from the calling session on every call. Role
permissions (lead-only actions) are checked at execution time, per call — the
model sees the full action list either way.

Actions: `team.start`, `team.members`, `team.read_messages`,
`team.send_message`, `team.task_create`, `team.task_update`, `team.task_list`,
`team.list_assistants`, `team.describe_assistant`, `team.spawn_agent`,
`team.rename_agent`, `team.interrupt_agent`, `team.shutdown_agent`.

## Turn semantics (the part that keeps teams alive)

- **Waking** a member means one prompt: its unread mail plus the board state.
  A busy or starting member is never prompted directly — the wake stacks as
  `pendingWake` and dispatches on the member's idle event, so one request per
  member stays in flight.
- **Read means delivered and confirmed.** A message marks read only when the
  turn that received it ends successfully. A failed or aborted turn drops the
  delivery claim (`deliveredIds`) and the mail stays queued for redelivery on
  the next wake.
- **Assignments are mail.** `team.task_create` with an owner pushes a
  `task_assignment` message into the owner's mailbox and wakes it; the wake
  prompt carries the subject and the description. A `send_message` on top of
  an assignment is noise.
- **Idle notifications.** A teammate that finishes a turn with something for
  the lead (a report, a completed own task) drops an `idle_notification` into
  the lead's mailbox and wakes the lead to synthesize.
- **Shutdown is a handshake.** `team.shutdown_agent` delivers a formal request;
  the teammate replies with exactly `shutdown_approved` (retiring itself from
  the roster; its session stays readable for the user) or
  `shutdown_rejected: <reason>`.
- **Stalls fail loudly.** A busy member with no event for 300s (the provider's
  request window) is marked failed and the lead is woken — standby is ending
  the turn, never streaming waiting text.

## State and events

State (`teams.json` in OpenChamber's data dir): teams with roster, mailbox
(300-message cap per team, read mail drops first), and board (500-task cap,
deleted tasks drop first). Writes are debounced, atomic (tmp + rename), and
mode 0600. A restart reloads the roster and demotes persisted `busy` to
`idle` — the turn it described is gone. Deadline flags like `pendingWake`
never reach the disk.

The service reads the same translated event stream as every orchestrator
(`processPayload` from the `index.js` hub subscription): `session.status`
(busy/starting), `session.idle` (turn end, `aborted` distinguishes
cancellation), `session.error` (member failed, lead notified) and
`session.deleted` (member removed; deleting the lead session ends the team).
The per-event cost for unrelated sessions is one `Map` lookup in the session
index.

## The panel

`GET /api/openchamber/teams` (registered in `feature-routes-runtime` from
`team/routes.js`) serves `overview()`: roster with unread counts, the live
task board (deleted tasks excluded), and the last 100 mailbox entries with
content clipped to 400 characters. The work-status section
(`WorkStatusTeamSection` in the UI) shows it for any session that belongs to
a team — lead or teammate — and refreshes on every `openchamber:team-*`
frame, which `lib/openchamberEvents.ts` collapses into one `team-changed`
signal: the frames name the team but the refetch covers what moved. Sessions
outside any team render nothing, so the section costs a session nothing.

Team changes broadcast on the OpenChamber UI event stream as
`openchamber:team-created`, `-members`, `-mailbox`, `-task`, `-status` for
clients that want a scoreboard.

## Test seams

`snapshot()` renders state as the disk round-trip would; `flush()` drains the
debounced persist. `service.test.js` runs on fakes for the OpenCode client and
the shared session service.
