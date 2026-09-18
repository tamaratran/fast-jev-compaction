import { describe, expect, it } from 'vitest';

import {
  codexRecordsToMessages,
  recordFromCodexHook,
  renderCodexContext,
  type CompactResult,
} from '../src/index.js';

describe('Codex hook records', () => {
  it('captures stable prompt and tool hook fields', () => {
    expect(recordFromCodexHook({
      hook_event_name: 'UserPromptSubmit',
      prompt: 'Fix the failing test.',
    })).toEqual({ kind: 'prompt', prompt: 'Fix the failing test.' });

    expect(recordFromCodexHook({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_use_id: 'call-1',
      tool_input: { command: 'npm test' },
      tool_response: { exit_code: 1, output: 'FAIL' },
    })).toEqual({
      kind: 'tool',
      toolName: 'Bash',
      toolUseId: 'call-1',
      input: { command: 'npm test' },
      response: JSON.stringify({ exit_code: 1, output: 'FAIL' }, null, 2),
      isError: true,
    });
  });

  it('maps captured tools to paired core messages', () => {
    const messages = codexRecordsToMessages([
      { kind: 'prompt', prompt: 'Investigate.' },
      {
        kind: 'tool',
        toolName: 'Read',
        toolUseId: 'call-1',
        input: { file_path: 'src/a.ts' },
        response: 'export const a = 1;',
        isError: false,
      },
    ]);
    expect(messages).toHaveLength(3);
    expect(messages[1]?.toolUses[0]).toMatchObject({
      tool_use_id: 'call-1',
      tool: 'Read',
    });
    expect(messages[2]?.toolResults?.[0]).toEqual({
      tool_use_id: 'call-1',
      text: 'export const a = 1;',
      isError: false,
    });
  });
});

describe('Codex restored context', () => {
  it('renders selected messages and omits oversized older blocks', () => {
    const messages = codexRecordsToMessages([
      { kind: 'prompt', prompt: 'x'.repeat(200) },
      {
        kind: 'tool',
        toolName: 'Read',
        toolUseId: 'call-1',
        input: { file_path: 'src/a.ts' },
        response: 'important result',
        isError: false,
      },
    ]);
    const result: CompactResult = {
      messages,
      decisions: [],
      stats: {
        messagesBefore: 3,
        messagesAfter: 3,
        charsBefore: 216,
        charsAfter: 216,
        calls: 1,
        kept: 1,
        resultsDropped: 0,
        callsDropped: 0,
        pinned: 0,
        stateTokens: 10,
        stateStage: 'full',
        requests: 1,
        ms: 1,
      },
    };
    const rendered = renderCodexContext(result, 120);
    expect(rendered).toContain('important result');
    expect(rendered).not.toContain('x'.repeat(200));
    expect(rendered).toContain('exceeded the Codex context limit');
  });
});
