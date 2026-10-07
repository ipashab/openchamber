# Assistants as contacts

Saved personas the user chats with like people: each contact has a name, a
one-line description and the persona prompt that opens its chat.

## State

`assistants.json` beside `teams.json` and `missions.json`, debounced 500 ms,
capped at 50 contacts. A contact carries `lastSessionId` — its continuing
thread — and the `directory` it works in.

## Lifecycle

- `POST /api/openchamber/assistants` — save a persona
  (`name`, `prompt`, `directory`, optional `description`, `model`, `agent`).
- `PUT /api/openchamber/assistants/:assistantId` — patch any carried field.
  The chat already started keeps its old opening; a fresh thread speaks the
  new prompt.
- `DELETE /api/openchamber/assistants/:assistantId` — forget the contact.
  The chat it started is an ordinary session and survives.
- `POST /api/openchamber/assistants/:assistantId/chat` — open the contact:
  continue `lastSessionId` while the session still exists (a plain session
  read is the probe), otherwise create a session titled with the contact's
  name and dispatch the persona as its opening message. The request's
  `directory` overrides the saved one when a thread starts fresh.

Every list reads one `GET /api/openchamber/assistants`; changes arrive as
`openchamber:assistant-changed` frames (`change`: `created`, `updated`,
`deleted`, `thread-started`, `thread-reused`).

## Out of scope (v1)

Unread markers, proactive pushes, cross-contact references, per-contact
memory controls. The chat is an ordinary OpenCode session; everything the
normal chat does, a contact's thread does too.
