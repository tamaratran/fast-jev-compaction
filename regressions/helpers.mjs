import { setTimeout as sleep } from 'node:timers/promises';
const build = process.env.FJC_TEST_BUILD;
if (!build) throw new Error('Run node scripts/test-regressions.mjs');
export const core = await import(new URL('src/index.js', build));
export const hook = await import(new URL('hooks/fast-jev.js', build));
export { sleep };
export const message = (role, text = '', extra = {}) => ({ role, text, toolUses: [], ...extra });
export const call = (id, tool = 'Read', input = { file_path: 'report.txt' }) => message('assistant', '', {
  toolUses: [{ tool_use_id: id, tool, input }],
});
export const result = (id, text = 'x'.repeat(2000)) => message('user', '', {
  toolResults: [{ tool_use_id: id, text }],
});
export const transcript = (n = 1) => [message('user', 'Keep the constraint'),
  ...Array.from({ length: n }, (_, i) => [call('c' + i), result('c' + i)]).flat(), message('user', 'Continue')];
export const answers = (questions, value = 0) => ({ answers: Object.fromEntries(
  Object.keys(questions).map(k => [k, { type: 'noul', noul: typeof value === 'function' ? value(k) : value }]),
) });
export const fakeAsker = (value = 0) => ({ ask: async (_state, questions) => answers(questions, value) });
export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export function handlers(options = {}) {
  const handlers = {};
  hook.register((name, handler) => { handlers[name] = handler; }, options);
  return handlers;
}
export function host() {
  return {
    env: { get: async () => undefined }, settings: { read: async () => ({}) },
    ui: { log() {}, toast() {} },
    session: { usage: async () => ({ context: { percent: 80 } }), compact: async () => ({}) },
    http: { fetch: async (_url, init) => ({ status: 200, ok: true,
      text: JSON.stringify(answers(JSON.parse(init.body).questions)) }) },
  };
}
