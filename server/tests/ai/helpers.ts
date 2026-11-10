import Database from 'better-sqlite3';
import { runMigrations } from '../../src/db/migrations.js';
import type { AnthropicLike, BatchLike, BatchResultEntryLike, ClientParams, MessageLike, MessageStreamLike } from '../../src/ai/client.js';

/** getDb() is mocked in each test file to return this database. */
export function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  (globalThis as { __testDb?: Database.Database }).__testDb = db;
  return db;
}

export function testDb(): Database.Database {
  return (globalThis as unknown as { __testDb: Database.Database }).__testDb;
}

export const VALID_ANALYSIS = { summary: 'A tool that does useful things', tags: ['Dev Tools', 'CLI'], platforms: ['cli'] };

export function textMessage(text: string, usage: Record<string, number> = {}) {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, ...usage },
  };
}

export class HttpError extends Error {
  constructor(public status: number, message: string, public headers: Record<string, string> = {}) {
    super(message);
  }
}

export interface FakeClient extends AnthropicLike {
  calls: {
    create: ClientParams[];
    stream: ClientParams[];
    countTokens: ClientParams[];
    batchCreate: ClientParams[];
    batchRetrieve: string[];
    batchResults: string[];
    batchCancel: string[];
    modelsRetrieve: string[];
  };
  impl: {
    create: (params: ClientParams, options?: ClientParams) => Promise<MessageLike> | MessageLike;
    countTokens: (params: ClientParams) => Promise<{ input_tokens: number }> | { input_tokens: number };
    batchCreate: (params: ClientParams) => Promise<BatchLike> | BatchLike;
    batchRetrieve: (id: string) => Promise<BatchLike> | BatchLike;
    batchResults: (id: string) => AsyncIterable<BatchResultEntryLike> | Promise<AsyncIterable<BatchResultEntryLike>>;
    modelsRetrieve: (id: string) => Promise<{ id?: string }> | { id?: string };
    stream: (params: ClientParams) => MessageStreamLike;
  };
}

export function makeFakeClient(): FakeClient {
  const calls: FakeClient['calls'] = {
    create: [], stream: [], countTokens: [], batchCreate: [], batchRetrieve: [], batchResults: [], batchCancel: [], modelsRetrieve: [],
  };
  const impl: FakeClient['impl'] = {
    create: () => textMessage(JSON.stringify(VALID_ANALYSIS)),
    countTokens: () => ({ input_tokens: 900 }),
    batchCreate: () => ({ id: 'batch_1', processing_status: 'in_progress' }),
    batchRetrieve: (id) => ({ id, processing_status: 'in_progress' }),
    batchResults: async function* () {
      /* empty */
    },
    modelsRetrieve: (id) => ({ id }),
    stream: () => {
      throw new Error('stream not configured');
    },
  };
  const client: FakeClient = {
    calls,
    impl,
    messages: {
      create: async (params: ClientParams, options?: ClientParams) => {
        calls.create.push(params);
        return impl.create(params, options);
      },
      stream: (params: ClientParams) => {
        calls.stream.push(params);
        return impl.stream(params);
      },
      countTokens: async (params: ClientParams) => {
        calls.countTokens.push(params);
        return impl.countTokens(params);
      },
      batches: {
        create: async (params: ClientParams) => {
          calls.batchCreate.push(params);
          return impl.batchCreate(params);
        },
        retrieve: async (id: string) => {
          calls.batchRetrieve.push(id);
          return impl.batchRetrieve(id);
        },
        results: async (id: string) => {
          calls.batchResults.push(id);
          return impl.batchResults(id);
        },
        cancel: async (id: string) => {
          calls.batchCancel.push(id);
          return { id };
        },
      },
    },
    models: {
      retrieve: async (id: string) => {
        calls.modelsRetrieve.push(id);
        return impl.modelsRetrieve(id);
      },
    },
  };
  return client;
}

export function insertRepos(db: Database.Database, n: number, startId = 1): number[] {
  const ins = db.prepare(
    'INSERT INTO repositories (id, name, full_name, html_url, owner_login, stargazers_count, description) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    const id = startId + i;
    ins.run(id, `r${id}`, `own/r${id}`, `https://github.com/own/r${id}`, 'own', 10, 'desc');
    ids.push(id);
  }
  return ids;
}

export async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Env keys the AI code reads; tests reset them. */
export function resetAiEnv(): void {
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY_FILE', 'CLAUDE_MODEL_BULK', 'CLAUDE_MODEL_CHAT', 'AI_SPEND_CONFIRM_USD']) {
    delete process.env[k];
  }
}
