/** Shared plumbing for the bench scripts. */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Message } from '../src/index.js';
import {
  OPENCODE_CONSOLE_URL,
  OPENCODE_GO_URL,
  type HttpTransport,
  type JevTransport,
  resolveTransport,
} from '../src/transports.js';
import type { BenchCase } from './types.js';

export function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : process.argv[index + 1];
  return value ?? fallback;
}

export function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

export function normalize(text: string): string {
  return text.replace(/\s+/gu, ' ').trim().toLowerCase();
}

export function percent(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

export function readCases(dir: string): BenchCase[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  const cases: BenchCase[] = [];
  for (const name of names.sort()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    } catch {
      continue;
    }
    const list = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of list) {
      const candidate = item as BenchCase;
      if (Array.isArray(candidate.messages) && candidate.messages.length > 0) {
        cases.push(candidate);
      }
    }
  }
  return cases;
}

/** Provider presets are reachable over HTTP only from outside OpenCode. */
export function toHttp(transport: JevTransport): HttpTransport {
  if (transport.kind === 'http') return transport;
  const extra =
    transport.contextWindow === undefined ? {} : { contextWindow: transport.contextWindow };
  if (transport.providerID === 'opencode') {
    return { kind: 'http', baseUrl: OPENCODE_CONSOLE_URL, model: transport.modelID, ...extra };
  }
  if (transport.providerID === 'opencode-go') {
    return { kind: 'http', baseUrl: OPENCODE_GO_URL, model: transport.modelID, ...extra };
  }
  throw new Error(
    `provider transport ${transport.providerID}/${transport.modelID} has no known HTTP route; pass --base`,
  );
}

export interface BenchTransport {
  http: HttpTransport;
  useStub: boolean;
  requested: string;
}

export function benchTransport(): BenchTransport {
  const requested = arg('transport', process.env.FAST_JEV_TRANSPORT ?? 'opencode-http-free');
  const useStub = requested === 'stub';
  if (useStub) {
    return {
      requested,
      useStub,
      http: { kind: 'http', baseUrl: 'http://stub.local/v1/systemone', model: 'stub' },
    };
  }
  const base = arg('base', '');
  const transport: JevTransport =
    base.length > 0
      ? {
          kind: 'http',
          baseUrl: base,
          model: arg('model', 'jev-latest'),
          ...(arg('context-window', '') ? { contextWindow: Number(arg('context-window', '0')) } : {}),
          ...(arg('calls-per-batch', '') ? { maxCallsPerBatch: Number(arg('calls-per-batch', '0')) } : {}),
        }
      : resolveTransport(requested, process.env);
  return { requested, useStub, http: toHttp(transport) };
}

/** Everything the window holds, for a probe search. */
export function windowText(messages: readonly Message[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    parts.push(message.text);
    for (const tool of message.toolUses) parts.push(JSON.stringify(tool.input));
    for (const result of message.toolResults ?? []) parts.push(result.text);
  }
  return normalize(parts.join('\n'));
}

/** A readable transcript, for the chat-model checks. */
export function renderWindow(messages: readonly Message[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    if (message.text.trim().length > 0) {
      lines.push(`[${message.role}]`, message.text, '');
    }
    for (const tool of message.toolUses) {
      lines.push(`[${message.role} tool call ${tool.tool_use_id} ${tool.tool}] ${JSON.stringify(tool.input)}`);
    }
    for (const result of message.toolResults ?? []) {
      lines.push(`[tool result ${result.tool_use_id}${result.isError ? ' error' : ''}]`, result.text, '');
    }
  }
  return lines.join('\n');
}
