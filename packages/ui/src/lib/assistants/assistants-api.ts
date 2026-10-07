// The host's contact routes, `/api/openchamber/assistants`, as the contacts
// page calls them. Every answer is parsed here, once, into the types the page
// renders; a shape the server did not send fails the fetch rather than
// putting half-typed cards on the list. The contract is the assistants
// section of `packages/web/server/lib/assistants/` (service and routes
// docblocks).

import { z } from 'zod';

import { runtimeFetch } from '@/lib/runtime-fetch';

const ASSISTANTS_ROUTE = '/api/openchamber/assistants';

const jsonHeaders = { 'content-type': 'application/json', accept: 'application/json' };

export const assistantSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  // The persona prompt is kept in full: the details show exactly what the
  // contact's chat opens with.
  prompt: z.string(),
  model: z.string().nullable(),
  agent: z.string().nullable(),
  directory: z.string(),
  // The contact's continuing thread; null until its first chat opens.
  lastSessionId: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Assistant = z.infer<typeof assistantSchema>;

export type AssistantDraft = {
  name: string;
  description: string;
  prompt: string;
  directory: string;
  model: string;
  agent: string;
};

type AssistantChat = {
  assistant: Assistant;
  sessionId: string;
  created: boolean;
};

const readRouteError = async (response: Response, fallback: string): Promise<string> => {
  // Best-effort: the server explains its failures in `error`; anything the
  // parse does not recognize falls back to the status code.
  const body = await response.json().catch(() => null);
  const parsed = z.object({ error: z.string().trim().min(1) }).safeParse(body);
  return parsed.success ? parsed.data.error : `${fallback}: ${response.status}`;
};

/** The whole address book, newest first — same order the server sends. */
export const fetchAssistants = async (fetchImpl: typeof runtimeFetch = runtimeFetch): Promise<Assistant[]> => {
  const response = await fetchImpl(ASSISTANTS_ROUTE, { headers: { accept: 'application/json' } });
  if (!response.ok) {
    throw new Error(await readRouteError(response, 'Contacts request failed'));
  }
  const body = await response.json().catch(() => null);
  const parsed = z.object({ assistants: z.array(assistantSchema) }).safeParse(body);
  if (!parsed.success) {
    throw new Error('Contacts response did not match the expected shape');
  }
  return parsed.data.assistants;
};

const assistantRoute = (assistantId: string) => `${ASSISTANTS_ROUTE}/${encodeURIComponent(assistantId)}`;

const readAssistant = async (response: Response, fallback: string): Promise<Assistant> => {
  if (!response.ok) {
    throw new Error(await readRouteError(response, fallback));
  }
  const body = await response.json().catch(() => null);
  const parsed = z.object({ assistant: assistantSchema }).safeParse(body);
  if (!parsed.success) {
    throw new Error('Contact response did not match the expected shape');
  }
  return parsed.data.assistant;
};

/** Save a new persona; the answer is the contact card the list will show. */
export const createAssistant = async (
  draft: AssistantDraft,
  fetchImpl: typeof runtimeFetch = runtimeFetch,
): Promise<Assistant> => {
  const response = await fetchImpl(ASSISTANTS_ROUTE, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(draft),
  });
  return readAssistant(response, 'Contact creation failed');
};

/** Patch any carried field; the chat already started keeps its old opening. */
export const updateAssistant = async (
  assistantId: string,
  patch: Partial<AssistantDraft>,
  fetchImpl: typeof runtimeFetch = runtimeFetch,
): Promise<Assistant> => {
  const response = await fetchImpl(assistantRoute(assistantId), {
    method: 'PUT',
    headers: jsonHeaders,
    body: JSON.stringify(patch),
  });
  return readAssistant(response, 'Contact update failed');
};

/** Forget the persona; the chat it started survives as an ordinary session. */
export const deleteAssistant = async (
  assistantId: string,
  fetchImpl: typeof runtimeFetch = runtimeFetch,
): Promise<void> => {
  const response = await fetchImpl(assistantRoute(assistantId), { method: 'DELETE' });
  if (!response.ok) {
    throw new Error(await readRouteError(response, 'Contact delete failed'));
  }
};

/**
 * Open the contact's chat: continue its thread while it exists, start a fresh
 * one seeded with the persona prompt when it does not.
 */
export const openAssistantChat = async (
  assistantId: string,
  directory: string,
  fetchImpl: typeof runtimeFetch = runtimeFetch,
): Promise<AssistantChat> => {
  const response = await fetchImpl(`${assistantRoute(assistantId)}/chat`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ directory }),
  });
  if (!response.ok) {
    throw new Error(await readRouteError(response, 'Contact chat failed'));
  }
  const body = await response.json().catch(() => null);
  const parsed = z
    .object({ assistant: assistantSchema, sessionId: z.string(), created: z.boolean() })
    .safeParse(body);
  if (!parsed.success) {
    throw new Error('Contact chat response did not match the expected shape');
  }
  return parsed.data;
};
