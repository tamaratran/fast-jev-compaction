/**
 * A deterministic, offline decision backend.
 *
 * It is not a judge and its numbers mean nothing about quality; it exists so
 * `tsx bench/run.ts --transport stub` exercises the whole pipeline — state
 * fitting, batching, decisions, native-window rebuilding and the report — with
 * no key and no network, and so a regression in the plumbing is visible in CI.
 *
 * Rule: a result under 400 characters or an error stays, a long result goes,
 * every call stays. That is roughly the shape a real profile produces on the
 * hand cases, which makes the stub output easy to diff.
 */
import type { JevAsker, JevQuestions } from '../src/index.js';

const SHORT_RESULT = 400;

function resultProbability(instructions: string): number {
  const match = /\(([\w-]+), (\d+) chars\)/u.exec(instructions);
  if (!match) return 0.5;
  const chars = Number(match[2]);
  if (/^error,/iu.test(instructions.slice(instructions.indexOf('chars') + 5).trim())) return 0.85;
  return chars <= SHORT_RESULT ? 0.85 : 0.12;
}

export function stubAsker(): JevAsker {
  return {
    async ask(_state, questions: JevQuestions) {
      const answers: Record<string, { type: 'noul'; noul: number }> = {};
      for (const [name, question] of Object.entries(questions)) {
        const instructions = question.type === 'noul' ? question.instructions : '';
        answers[name] = {
          type: 'noul',
          noul: name.startsWith('result_') ? resultProbability(instructions) : 0.7,
        };
      }
      return { model: 'stub', answers };
    },
  };
}
