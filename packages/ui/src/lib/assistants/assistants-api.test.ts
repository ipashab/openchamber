import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

import { runtimeFetch } from '@/lib/runtime-fetch';

import {
  assistantSchema,
  createAssistant,
  deleteAssistant,
  fetchAssistants,
  openAssistantChat,
  updateAssistant,
  type AssistantDraft,
} from './assistants-api';

const assistantFixture = {
  id: 'assistant_1',
  name: 'Reviewbot',
  description: 'Reviews diffs in plain French',
  prompt: 'You review code as a French-speaking senior engineer.',
  model: null,
  agent: null,
  directory: '/projects/app',
  lastSessionId: null,
  createdAt: 1760000000000,
  updatedAt: 1760000000000,
};

const draft: AssistantDraft = {
  name: 'Reviewbot',
  description: 'Reviews diffs in plain French',
  prompt: 'You review code as a French-speaking senior engineer.',
  directory: '/projects/app',
  model: '',
  agent: '',
};

type FetchLog = { url: string; init?: RequestInit };

const fetchAnswering = (responses: Record<string, { status?: number; body: unknown }>) => {
  const log: FetchLog[] = [];
  const fetchImpl: typeof runtimeFetch = async (rawInput, init) => {
    const path = String(rawInput);
    log.push({ url: path, init });
    const answer = responses[path];
    if (!answer) {
      return new Response(JSON.stringify({ error: 'unexpected route' }), { status: 404 });
    }
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200 });
  };
  return { fetchImpl, log };
};

// The request body the page sends, parsed by a schema at the boundary — a
// missing body fails the test loudly instead of comparing half-typed values.
const sentBodySchema = z
  .object({
    name: z.string(),
    description: z.string(),
    prompt: z.string(),
    model: z.string(),
    agent: z.string(),
    directory: z.string(),
  })
  .partial();

const readBody = (log: FetchLog): z.infer<typeof sentBodySchema> =>
  sentBodySchema.parse(JSON.parse(String(log.init?.body)));

describe('assistantSchema', () => {
  test('parses the contact the server sends and rejects the shapes it does not', () => {
    expect(assistantSchema.safeParse(assistantFixture).success).toBe(true);
    expect(assistantSchema.safeParse({ ...assistantFixture, directory: '' }).success).toBe(true);
    expect(assistantSchema.safeParse({ ...assistantFixture, name: 7 }).success).toBe(false);
    expect(assistantSchema.safeParse({ ...assistantFixture, lastSessionId: 3 }).success).toBe(false);
  });
});

describe('assistants-api', () => {
  test('fetches the address book exactly as the server sorted it', async () => {
    const second = { ...assistantFixture, id: 'assistant_2', name: 'Portsbot' };
    const { fetchImpl, log } = fetchAnswering({
      '/api/openchamber/assistants': { body: { assistants: [second, assistantFixture] } },
    });
    const assistants = await fetchAssistants(fetchImpl);
    expect(assistants.map((assistant) => assistant.id)).toEqual(['assistant_2', 'assistant_1']);
    expect(log[0]?.init?.method).toBeUndefined();
  });

  test('refuses a list the server did not shape as assistants', async () => {
    const { fetchImpl } = fetchAnswering({
      '/api/openchamber/assistants': { body: { contacts: [] } },
    });
    await expect(fetchAssistants(fetchImpl)).rejects.toThrow(/expected shape/);
  });

  test('carries a load failure instead of masking it as an empty book', async () => {
    const { fetchImpl } = fetchAnswering({
      '/api/openchamber/assistants': { status: 500, body: { error: 'state unreadable' } },
    });
    await expect(fetchAssistants(fetchImpl)).rejects.toThrow('state unreadable');
  });

  test('creates a contact with the whole draft', async () => {
    const { fetchImpl, log } = fetchAnswering({
      '/api/openchamber/assistants': { body: { assistant: assistantFixture } },
    });
    const assistant = await createAssistant(draft, fetchImpl);
    expect(assistant.id).toBe('assistant_1');
    expect(log[0]?.init?.method).toBe('POST');
    expect(readBody(log[0])).toEqual(draft);
  });

  test('reports every validation reason the server answered', async () => {
    const { fetchImpl } = fetchAnswering({
      '/api/openchamber/assistants': { status: 400, body: { error: 'name is required; prompt is required' } },
    });
    await expect(createAssistant(draft, fetchImpl)).rejects.toThrow(/name is required/);
  });

  test('patches only the carried fields', async () => {
    const { fetchImpl, log } = fetchAnswering({
      '/api/openchamber/assistants/assistant_1': { body: { assistant: { ...assistantFixture, name: 'Reviewbot 2' } } },
    });
    const assistant = await updateAssistant('assistant_1', { name: 'Reviewbot 2' }, fetchImpl);
    expect(assistant.name).toBe('Reviewbot 2');
    expect(log[0]?.init?.method).toBe('PUT');
    expect(readBody(log[0])).toEqual({ name: 'Reviewbot 2' });
  });

  test('deletes by encoded id and fails loudly on refusal', async () => {
    const { fetchImpl, log } = fetchAnswering({
      '/api/openchamber/assistants/assistant_1': { body: { deleted: true, assistantId: 'assistant_1' } },
    });
    await deleteAssistant('assistant_1', fetchImpl);
    expect(log[0]?.init?.method).toBe('DELETE');
    const refused = fetchAnswering({
      '/api/openchamber/assistants/assistant_1': { status: 404, body: { error: 'No such assistant' } },
    });
    await expect(deleteAssistant('assistant_1', refused.fetchImpl)).rejects.toThrow('No such assistant');
  });

  test('opens the chat and answers with the thread it continued or started', async () => {
    const { fetchImpl, log } = fetchAnswering({
      '/api/openchamber/assistants/assistant_1/chat': {
        body: { assistant: { ...assistantFixture, lastSessionId: 'ses_9' }, sessionId: 'ses_9', created: true },
      },
    });
    const chat = await openAssistantChat('assistant_1', '/projects/app', fetchImpl);
    expect(chat.sessionId).toBe('ses_9');
    expect(chat.created).toBe(true);
    expect(chat.assistant.lastSessionId).toBe('ses_9');
    expect(log[0]?.init?.method).toBe('POST');
    expect(readBody(log[0])).toEqual({ directory: '/projects/app' });
  });

  test('the chat route answers a broken payload with an error, not a half-typed contact', async () => {
    const { fetchImpl } = fetchAnswering({
      '/api/openchamber/assistants/assistant_1/chat': { body: { assistant: assistantFixture } },
    });
    await expect(openAssistantChat('assistant_1', '/projects/app', fetchImpl)).rejects.toThrow(/expected shape/);
  });
});
