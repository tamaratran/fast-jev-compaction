import { compactMessagesViaOpenRouter, reductionRatio, type Message } from '../src/index.js';

// Real Jev, reached through OpenRouter's decisions endpoint instead of TypeSafe.
let n = 0;
function call(tool: string, input: Record<string, unknown>, output: string, isError = false): Message[] {
  const tool_use_id = `toolu_${++n}`;
  return [
    { role: 'assistant', text: '', toolUses: [{ tool_use_id, tool, input, text: output, isError }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id, text: output, isError }] },
  ];
}
const user = (text: string): Message => ({ role: 'user', text, toolUses: [] });
const assistant = (text: string): Message => ({ role: 'assistant', text, toolUses: [] });

const parserTs = `export function parse(tokens: Token[]): Node {\n${'  // …\n'.repeat(120)}}\n`;
const legacyTs = `// legacy parser, do not touch\n${'export const legacy = true;\n'.repeat(80)}`;

const messages: Message[] = [
  user('Fix the failing parser test in the checkout service. Do not touch legacy/. Keep the public parser API backward compatible.'),
  assistant('I will inspect the test and the parser implementation first.'),
  ...call('Glob', { pattern: 'src/**/*.ts' }, 'src/parser.ts\nsrc/parser.test.ts\nsrc/legacy/parser.ts'),
  ...call('Read', { file_path: 'src/legacy/parser.ts' }, legacyTs),
  assistant('The legacy parser is unrelated; looking at the public one.'),
  ...call('Read', { file_path: 'src/parser.ts' }, parserTs),
  ...call('Bash', { command: 'npx vitest run src/parser.test.ts' },
    'FAIL src/parser.test.ts\n  parser > accepts a trailing comma\n    Expected: true\n    Received: false\n    at src/parser.test.ts:42:11', true),
  assistant('The parser rejects a comma before the closing brace because the token loop stops too early. Adding one transition without changing the exported API.'),
  ...call('Edit', {
      file_path: 'src/parser.ts',
      old_string: 'if (token === COMMA) advance();',
      new_string: 'if (token === COMMA) {\n  if (next === CLOSE_BRACE) continue;\n  advance();\n}',
    }, 'The file src/parser.ts has been updated.'),
  ...call('Bash', { command: 'npx vitest run src/parser.test.ts' }, 'PASS src/parser.test.ts\n  ✓ accepts a trailing comma (4 ms)'),
  assistant('The focused test passes. Running the full suite next.'),
  ...call('Bash', { command: 'npm test' }, 'PASS src/parser.test.ts\nPASS src/checkout.test.ts\nTest Suites: 2 passed, 2 total'),
  assistant('Everything passes. The change is isolated to the parser and the public API is unchanged.'),
  user('Great. Next, add a changelog entry for this fix.'),
];

const result = await compactMessagesViaOpenRouter(messages, {
  apiKey: process.env.OPENROUTER_API_KEY,
  preserveRecentMessages: 2,
});

console.log('id | tool | action | keep call | keep result');
for (const d of result.decisions) {
  console.log(`${d.id} | ${d.tool} | ${d.action} (${d.reason}) | ${d.keepCall.toFixed(2)} | ${d.keepResult.toFixed(2)}`);
}
console.log('\nstats:', JSON.stringify(result.stats));
console.log(`chars saved: ${(reductionRatio(result) * 100).toFixed(1)}%`);
console.log(`messages: ${result.stats.messagesBefore} → ${result.stats.messagesAfter}`);
