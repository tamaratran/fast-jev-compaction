import type { On, SessionMessage } from 'claude-code';
import { expect, mock, test } from 'claude-code/testing';

function transcript(): SessionMessage[] {
  const messages: SessionMessage[] = [{ role: 'user', text: 'Continue the task.', toolUses: [] }];
  for (let i = 0; i < 5; i += 1) {
    messages.push({
      role: 'assistant', text: '',
      toolUses: [{ tool_use_id: `call-${i}`, tool: 'Read', input: { file_path: 'x.ts' } }],
    }, {
      role: 'user', text: '', toolUses: [],
      toolResults: [{ tool_use_id: `call-${i}`, text: 'x'.repeat(2000), isError: false }],
    });
  }
  return messages;
}

function host(on: On) {
  const clock = mock.clock(on);
  mock.env(on, { TYPESAFE_API_KEY: 'test-key' });
  on('ui.log', () => ({ value: undefined }));
  on('ui.toast', () => ({ value: undefined }));
  const state = { stall: true, fetches: 0, summaries: 0 };
  on('http.fetch', async (_$, event) => {
    state.fetches += 1;
    if (state.stall) await clock.sleep(60_000);
    const { questions } = JSON.parse(event.init?.body ?? '{}');
    return { value: {
      status: 200, ok: true, headers: {},
      text: JSON.stringify({ answers: Object.fromEntries(
        Object.keys(questions).map((key) => [key, { type: 'noul', noul: 0 }]),
      ) }),
    } };
  });
  on('session.compact', () => {
    state.summaries += 1;
    return { messages: [{ role: 'user', text: 'built-in summary', toolUses: [] }] };
  });
  return { state, clock };
}

test('deadline skips plugin compaction; late responses cannot install it', async ($, on) => {
  const { state, clock } = host(on);
  const messages = transcript();
  let settled = false;
  const pending = $.session.compact({ trigger: 'plugin', messages }).then((result) => {
    settled = true;
    return result;
  });
  await clock.settle();
  expect(state.fetches).toBe(1);
  await clock.advance(14_999);
  expect(settled).toBe(false);
  await clock.advance(1);
  const result = await pending;
  expect(state.summaries).toBe(0);
  expect(result.skip).toBe('fast-jev-compaction: Jev compaction timed out after 15000ms; conversation left unchanged');

  state.stall = false;
  const retried = await $.session.compact({ trigger: 'plugin', messages });
  expect(state.fetches).toBe(2);
  expect(state.summaries).toBe(0);
  expect(retried.skip).toBeUndefined();
  expect(retried.messages?.length).toBeLessThan(messages.length);
  expect(retried.messages?.[0]?.text).toBe('Continue the task.');
  await clock.advance(60_000);
  expect(state.summaries).toBe(0);
  expect(result.messages).toBeUndefined();
});

for (const trigger of ['manual', 'auto'] as const) {
  test(`deadline retains ${trigger} compaction fallback`, async ($, on) => {
    const { state, clock } = host(on);
    const pending = $.session.compact({ trigger, messages: transcript() });
    await clock.settle();
    await clock.advance(15_000);
    const result = await pending;
    expect(state.fetches).toBe(1);
    expect(state.summaries).toBe(1);
    expect(result.messages?.[0]?.text).toBe('built-in summary');
    await clock.advance(60_000);
    expect(state.summaries).toBe(1);
  });
}
