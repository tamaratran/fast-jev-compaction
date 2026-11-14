import { compactMessages, reductionRatio } from '../src/index.js';
import { demoTranscript } from './transcript.js';

const messages = demoTranscript();
const result = await compactMessages(messages, { preserveRecentMessages: 2, baseUrl: process.env.LAYA_URL });
console.log('id | tool | action | keep call | keep result');
for (const d of result.decisions) {
  console.log(`${d.id} | ${d.tool} | ${d.action} (${d.reason}) | ${d.keepCall.toFixed(2)} | ${d.keepResult.toFixed(2)}`);
}
console.log('');
console.log('stats:', JSON.stringify(result.stats));
console.log(`chars saved: ${(reductionRatio(result) * 100).toFixed(1)}%`);
console.log(`messages: ${result.stats.messagesBefore} → ${result.stats.messagesAfter}`);
console.log('');
for (const m of result.messages) {
  const tools = m.toolUses.map((t) => `${t.tool}(${JSON.stringify(t.input).slice(0, 50)})`).join(', ');
  const results = (m.toolResults ?? []).map((r) => r.text.split('\n')[0]?.slice(0, 70)).join(' | ');
  console.log(`${m.role.padEnd(9)} ${m.text.slice(0, 70) || tools || results}`);
}
