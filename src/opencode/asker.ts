/**
 * Askers for every transport. Inside OpenCode the provider route is preferred:
 * the host signs the call and the model is the one the Console connection
 * serves. An HTTP asker is kept for TypeSafe, a direct Console call and every
 * local `POST /v1/systemone` server (Laya, OpenJev, Vega through its shim).
 */
import { JevClient } from '../client.js';
import { parseJevResponse } from '../request.js';
import type { HttpTransport, JevTransport, ProviderTransport } from '../transports.js';
import type { JevAsker, JevQuestion, JevQuestions, JevResponse, JevState } from '../types.js';

/** One typed decision request, as OpenCode's `experimental.generate.decisions` takes it. */
export interface DecisionsInput {
  model: { providerID: string; id: string };
  input: ReadonlyArray<{ type: 'text'; text: string }>;
  questions: ReadonlyArray<Record<string, unknown>>;
}

export type DecisionsCall = (input: DecisionsInput) => Promise<unknown>;

/** Questions in the shape OpenCode's decision route expects. */
export function providerQuestions(
  questions: JevQuestions,
): ReadonlyArray<Record<string, unknown>> {
  return Object.entries(questions).map(([name, question]) => {
    const typed: JevQuestion = question;
    if (typed.type === 'noul') {
      const entry: Record<string, unknown> = {
        type: 'predicate',
        name,
        instructions: typed.instructions,
      };
      if (typed.criteria) entry.criteria = typed.criteria;
      return entry;
    }
    if (typed.type === 'choice') {
      return {
        type: 'choice',
        name,
        instructions: typed.instructions,
        choices: Object.entries(typed.criteria).map(([value, description]) => ({
          value,
          ...(description ? { description } : {}),
        })),
      };
    }
    return {
      type: 'score',
      name,
      instructions: typed.instructions,
      levels: typed.criteria.map((label) => ({ label })),
    };
  });
}

/** A `JevAsker` over the host's decision route. */
export function providerAsker(
  transport: ProviderTransport,
  call: DecisionsCall,
): JevAsker {
  return {
    async ask(state: JevState, questions: JevQuestions): Promise<JevResponse> {
      const raw = await call({
        model: { providerID: transport.providerID, id: transport.modelID },
        input: [{ type: 'text', text: JSON.stringify(state) }],
        questions: providerQuestions(questions),
      });
      return parseJevResponse(200, true, JSON.stringify(raw));
    },
  };
}

function isLocal(baseUrl: string): boolean {
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/u.test(baseUrl);
}

function envKey(env: Record<string, string | undefined>, names: readonly string[]) {
  for (const name of names) {
    const value = env[name];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

export interface AskerDeps {
  /** The host's decision route; required by the provider transport. */
  decisions?: DecisionsCall;
  /** Used for `x-opencode-session`, which the Go route requires. */
  sessionID?: string;
  /** Key already resolved from OpenCode's auth store, if any. */
  authKey?: string;
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
}

function resolveApiKey(transport: HttpTransport, deps: AskerDeps): string | undefined {
  const env = deps.env ?? process.env;
  if (transport.apiKey) return transport.apiKey;
  const fromEnv = envKey(env, [
    'FAST_JEV_API_KEY',
    'JEV_API_KEY',
    'OPENCODE_API_KEY',
    'TYPESAFE_API_KEY',
  ]);
  if (fromEnv) return fromEnv;
  if (transport.baseUrl.includes('typesafe.ai')) {
    return envKey(env, ['TYPESAFE_API_KEY']);
  }
  return deps.authKey;
}

/** A `JevAsker` over `POST /v1/systemone`, with or without a key. */
export function httpAsker(transport: HttpTransport, deps: AskerDeps = {}): JevAsker {
  const headers: Record<string, string> = { ...transport.headers };
  if (!headers['x-opencode-session'] && deps.sessionID && /\/inference\/go\//u.test(transport.baseUrl)) {
    headers['x-opencode-session'] = deps.sessionID;
  }
  return new JevClient({
    apiKey: resolveApiKey(transport, deps),
    baseUrl: transport.baseUrl,
    model: transport.model,
    headers,
    requireKey: !isLocal(transport.baseUrl),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
}

/** Picks the asker a transport needs; a provider transport without a route fails closed. */
export function createAsker(transport: JevTransport, deps: AskerDeps = {}): JevAsker {
  if (transport.kind === 'http') return httpAsker(transport, deps);
  if (!deps.decisions) {
    return {
      async ask(): Promise<never> {
        throw new Error(
          `provider transport ${transport.providerID}/${transport.modelID} needs OpenCode's decision route`,
        );
      },
    };
  }
  return providerAsker(transport, deps.decisions);
}
