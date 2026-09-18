/**
 * Manual end-to-end check: drives the extension through pi's real compaction
 * machinery (createAgentSession + session.compact) with one real Jev call.
 *
 * Not part of `npm test` or `npm run typecheck` — it needs the pi package
 * installed and a real API key:
 *
 *   npm install @earendil-works/pi-coding-agent
 *   TYPESAFE_API_KEY=... npx tsx pi/e2e.ts
 *
 * Exits non-zero on any failure.
 */

import {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const extensionPath = join(here, 'index.ts');

if (!process.env.TYPESAFE_API_KEY) {
	console.error('TYPESAFE_API_KEY not set');
	process.exit(1);
}

let failures = 0;
function check(name: string, condition: boolean, extra?: string): void {
	if (condition) {
		console.log(`  ok: ${name}`);
	} else {
		failures++;
		console.log(`  FAIL: ${name}${extra ? ` — ${String(extra).slice(0, 300)}` : ''}`);
	}
}

const agentDir = mkdtempSync(join(tmpdir(), 'fj-agentdir-'));
const cwd = mkdtempSync(join(tmpdir(), 'fj-cwd-'));

const fakeModel = {
	id: 'fake-model',
	name: 'Fake Model',
	api: 'openai-completions',
	provider: 'fake',
	baseUrl: 'http://localhost:1',
	reasoning: false,
	input: ['text'],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 4096,
};

const resourceLoader = new DefaultResourceLoader({
	cwd,
	agentDir,
	additionalExtensionPaths: [extensionPath],
});
await resourceLoader.reload();

const sessionManager = SessionManager.inMemory(cwd);
const settingsManager = SettingsManager.inMemory({
	compaction: { enabled: true, reserveTokens: 1024, keepRecentTokens: 100 },
});
const { session } = await createAgentSession({
	resourceLoader,
	sessionManager,
	settingsManager,
	model: fakeModel as never,
});

const ts = Date.now();
const USAGE = {
	input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const staleFile = 'stale legacy content line\n'.repeat(150);
const freshOutput = 'PASS a.test.ts\nPASS b.test.ts\n';

sessionManager.appendMessage({ role: 'user', content: 'Audit the login module and fix the failing test.', timestamp: ts });
sessionManager.appendMessage({
	role: 'assistant',
	content: [
		{ type: 'thinking', thinking: 'Reading the legacy login file first.' },
		{ type: 'text', text: 'Reading the file.' },
		{ type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'src/login/legacy.ts' } },
	],
	api: 't', provider: 't', model: 't', usage: USAGE, stopReason: 'toolUse', timestamp: ts,
});
sessionManager.appendMessage({ role: 'toolResult', toolCallId: 'c1', toolName: 'read', content: [{ type: 'text', text: staleFile }], isError: false, timestamp: ts });
sessionManager.appendMessage({
	role: 'assistant',
	content: [
		{ type: 'text', text: 'That file is unrelated. Running the auth tests.' },
		{ type: 'toolCall', id: 'c2', name: 'bash', arguments: { command: 'npm test -- auth' } },
	],
	api: 't', provider: 't', model: 't', usage: USAGE, stopReason: 'toolUse', timestamp: ts,
});
sessionManager.appendMessage({ role: 'toolResult', toolCallId: 'c2', toolName: 'bash', content: [{ type: 'text', text: freshOutput }], isError: false, timestamp: ts });
sessionManager.appendMessage({
	role: 'assistant',
	content: [{ type: 'text', text: 'Auth tests pass; the failure is in login edge cases.' }],
	api: 't', provider: 't', model: 't', usage: USAGE, stopReason: 'stop', timestamp: ts,
});
sessionManager.appendMessage({ role: 'user', content: 'Yes — focus on the edge cases now.', timestamp: ts });
sessionManager.appendMessage({
	role: 'assistant',
	content: [{ type: 'text', text: 'On it.' }],
	api: 't', provider: 't', model: 't', usage: USAGE, stopReason: 'stop', timestamp: ts,
});

const branchBefore = sessionManager.getBranch();
console.log(`branch before compaction: ${branchBefore.length} entries`);

const events: string[] = [];
session.subscribe((event: { type: string }) => {
	if (event.type === 'compaction_start' || event.type === 'compaction_end' || event.type === 'compaction_failed') {
		events.push(event.type);
	}
});

const result = await session.compact();

console.log('\n[compaction result]');
check('compaction events observed', events.includes('compaction_start') && events.includes('compaction_end'), events.join(','));
check('summary is ours', result.summary.includes('<fast-jev-compaction>'), result.summary.slice(0, 120));
const branchIds = new Set(branchBefore.map((e: { id: string }) => e.id));
check('firstKeptEntryId is a real branch entry', branchIds.has(result.firstKeptEntryId), result.firstKeptEntryId);
check(
	'details carry fastJev stats',
	(result.details as { fastJev?: { oldReduction?: number } } | undefined)?.fastJev?.oldReduction !== undefined,
	JSON.stringify(result.details).slice(0, 200),
);
check('usage carries Jev tokens', (result.usage?.input ?? 0) > 0, JSON.stringify(result.usage));

const compactionEntries = sessionManager.getBranch().filter((e) => e.type === 'compaction');
check('compaction entry appended', compactionEntries.length === 1);
check(
	'compaction entry marked from extension',
	(compactionEntries[0] as { fromHook?: boolean } | undefined)?.fromHook === true,
);

const contextMessages = sessionManager.buildSessionContext().messages as Array<{ role?: string; summary?: string }>;
console.log(`\n[context rebuild] ${contextMessages.length} messages`);
check(
	'first context message is the compaction summary',
	contextMessages[0]?.role === 'compactionSummary' && (contextMessages[0]?.summary ?? '').includes('<fast-jev-compaction>'),
	JSON.stringify(contextMessages[0]).slice(0, 160),
);
const summaryText = JSON.stringify(contextMessages[0]);
const keptText = JSON.stringify(contextMessages.slice(1));
check('summary keeps verbatim user prompt', summaryText.includes('Audit the login module and fix the failing test.'));
check('stale tool call pruned', !summaryText.includes('[Tool call read]'));
check('stale file content pruned', !summaryText.includes('stale legacy content line'));
check('kept messages carry the recent conversation', keptText.includes('focus on the edge cases now.') && keptText.includes('On it.'));

session.dispose();
console.log(`\n${failures === 0 ? 'ALL OK' : `${failures} FAILED`}`);
process.exit(failures > 0 ? 1 : 0);
