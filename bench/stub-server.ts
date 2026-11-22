/**
 * The offline stub behind `--transport stub`, served over HTTP so the plugin
 * itself can be exercised in OpenCode without a key:
 *
 *   tsx bench/stub-server.ts        # 127.0.0.1:8787/v1/systemone
 *   # plugin options: { "baseUrl": "http://127.0.0.1:8787/v1/systemone", "model": "stub" }
 */
import { createServer } from 'node:http';
import type { JevQuestions, JevState } from '../src/index.js';
import { stubAsker } from './stub.js';

const port = Number(process.env.PORT ?? 8787);
const asker = stubAsker();

const server = createServer((request, response) => {
  if (request.method !== 'POST' || !request.url?.endsWith('/systemone')) {
    response.writeHead(404).end('not found');
    return;
  }
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.on('end', () => {
    void (async () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          state: JevState;
          questions: JevQuestions;
        };
        const answer = await asker.ask(body.state, body.questions);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(answer));
      } catch (error) {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
    })();
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`stub jev on http://127.0.0.1:${port}/v1/systemone`);
});
