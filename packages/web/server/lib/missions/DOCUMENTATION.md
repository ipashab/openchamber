# Missions

A mission is one goal prompt the user files and walks away from. The queue
paces them: as many run at a time as the queue config allows
(`config.maxConcurrent`, default 2), the rest wait as `queued`. Each mission
works in a lane of its own:

- **session** — a fresh OpenCode session is created and receives the prompt;
- **team** — a lead-only team is created (`createFromUi`), the prompt is the
  lead's first task; teammates are added later from the team page if the
  goal wants them.

## Statuses

`queued → running → completed | failed`, with `cancelled` reachable from
queued or running. Cancel stops the mission's claim on the queue, not the
session it started — a running turn keeps going where its own user can stop
it.

Completion is watched, not assumed. After dispatch the executor polls the
shared session-state probe (`getSessionState`): the turn its prompt started
goes busy, then idle — `idle` before any `busy` is waiting, not finishing.
The whole watch ends after `config.maxRunMs` (default 60 min): a turn that
never reported busy is failed, a turn still busy is released as completed, so
no session can hold the queue hostage.

## Queue config

The user's settings, both persisted in `missions.json` under `config` beside
the missions and restored on load (invalid stored values fall back to the
defaults):

- `maxConcurrent` — lanes, a whole number 1..16, default 2. A raised value
  admits queued missions on the same drain pass; a lowered one only stops
  admissions — running missions are not cancelled.
- `maxRunMs` — the watch window, whole minutes 1..1440 on the form
  (milliseconds on the wire and on disk), default 60. A change arms the
  watches started after it; running watches keep the window they were armed
  with — re-arming would forget the seen-busy phase of a turn finishing
  right now.

## State

`missions.json` beside `teams.json`, debounced atomic writes. Restarts
re-arm everything from the loaded statuses: queued missions resume
draining, a running mission keeps its watch. Timers are process state and
never persisted.

## Routes

All under `/api/openchamber/missions`, JSON per route. Errors carry
`statusCode` (400 validation, 404 unknown id, 500 transport) and answer
with `{ error }` in the routes' own words.

| Route | Meaning |
| --- | --- |
| `GET /` | The whole list, newest first, with the queue config |
| `POST /` | File a mission: `{ title, prompt, mode, directory, model?, agent? }` |
| `PUT /config` | Save queue settings: `{ maxConcurrent?, maxRunMs? }` — one field is enough |
| `POST /:id/cancel` | Drop a queued one or stop watching a running one |
| `POST /:id/retry` | Requeue a finished one as a fresh run of the same goal |
| `DELETE /:id` | Forget the record; a running session is unwatched, not stopped |

Every state move broadcasts `openchamber:mission-changed`
(`{ change, missionId }`); the panel refetches on the frame, like the team
panel does. A config save broadcasts `change: 'config'`.

## Not in v1

One team shared by several missions (missions as board tasks) — the
quick-add and the selection menu's Team task action already cover filing
work onto an existing team; a third path would split one meaning between
two tools.
