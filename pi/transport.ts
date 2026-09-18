import { buildJevRequest, parseJevResponse } from '../src/request.js';
import type { JevAsker } from '../src/types.js';

/** Also bounds fetch implementations that ignore AbortSignal, including body reads. */
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('Jev request cancelled'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** One deadline and cancellation signal shared by every batch in a scoring pass. */
export function createJevTransport(
  apiKey: string,
  timeoutMs: number,
  parentSignal?: AbortSignal,
  fetcher: typeof fetch = fetch,
  model?: string,
): { asker: JevAsker; signal: AbortSignal; abort(): void; dispose(): void } {
  const controller = new AbortController();
  const abort = () => controller.abort(new Error('Jev request cancelled'));
  const timer = timeoutMs > 0
    ? setTimeout(() => controller.abort(new Error('Jev deadline exceeded')), timeoutMs)
    : undefined;
  parentSignal?.addEventListener('abort', abort, { once: true });
  if (parentSignal?.aborted) abort();

  return {
    signal: controller.signal,
    abort,
    dispose() {
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', abort);
      // Cancel sibling batches if another batch failed validation.
      abort();
    },
    asker: {
      async ask(state, questions) {
        controller.signal.throwIfAborted();
        if (!apiKey) throw new Error('TYPESAFE_API_KEY is not configured');
        const request = buildJevRequest({ apiKey, model }, state, questions);
        return abortable((async () => {
          const response = await fetcher(request.url, {
            method: request.method,
            headers: request.headers,
            body: request.body,
            signal: controller.signal,
          });
          // Never put server response bodies, transcript text, or credentials in notifications.
          if (!response.ok) throw new Error(`Jev request failed (${response.status})`);
          const result = parseJevResponse(response.status, true, await response.text());
          if (Array.isArray(result.answers)) throw new Error('Invalid Jev answers');
          for (const [id, question] of Object.entries(questions)) {
            const answer = result.answers[id];
            if (question.type === 'noul' && (
              !answer || !('noul' in answer) ||
              (answer.type !== undefined && answer.type !== 'noul') ||
              typeof answer.noul !== 'number' || !Number.isFinite(answer.noul) ||
              answer.noul < 0 || answer.noul > 1
            )) throw new Error(`Invalid Jev answer for ${id}`);
          }
          return result;
        })(), controller.signal);
      },
    },
  };
}
