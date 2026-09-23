import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { JevAsker, JevQuestions, JevResponse, JevState } from './types.js';

export interface SemIfSubprocessOptions {
  pythonPath?: string;
  scriptPath?: string;
  semifDir?: string;
  model?: string;
  useMock?: boolean;
  device?: string;
  dtype?: string;
}

/**
 * Executes a local Python subprocess to perform SemIf decision evaluation
 * without requiring an external HTTP server to be pre-launched.
 */
export class SemIfSubprocessAsker implements JevAsker {
  private readonly pythonPath: string;
  private readonly scriptPath: string;
  private readonly semifDir?: string;
  private readonly model?: string;
  private readonly useMock: boolean;
  private readonly device?: string;
  private readonly dtype?: string;

  constructor(options: SemIfSubprocessOptions = {}) {
    this.pythonPath =
      options.pythonPath ??
      process.env.SEMIF_PYTHON_PATH ??
      process.env.PYTHON_PATH ??
      'python3';

    if (options.scriptPath) {
      this.scriptPath = options.scriptPath;
    } else {
      const dirname =
        typeof __dirname !== 'undefined'
          ? __dirname
          : path.dirname(fileURLToPath(import.meta.url));
      this.scriptPath = path.resolve(dirname, '../semif_addon/semif_bridge.py');
    }

    this.semifDir = options.semifDir ?? process.env.SEMIF_DIR;
    this.model = options.model;
    this.useMock = options.useMock ?? false;
    this.device = options.device;
    this.dtype = options.dtype;
  }

  async ask(state: JevState, questions: JevQuestions): Promise<JevResponse> {
    const payload = {
      state,
      questions,
      ...(this.model ? { model: this.model } : {}),
    };

    const args = [this.scriptPath];
    if (this.useMock) args.push('--mock');
    if (this.device) args.push('--device', this.device);
    if (this.dtype) args.push('--dtype', this.dtype);
    if (this.semifDir) args.push('--semif-dir', this.semifDir);

    return new Promise((resolve, reject) => {
      const child = spawn(this.pythonPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });

      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      child.on('error', (err) => {
        reject(
          new Error(`Failed to spawn SemIf python process (${this.pythonPath}): ${err.message}`),
        );
      });

      child.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`SemIf python bridge exited with code ${code}: ${stderr || stdout}`));
          return;
        }
        try {
          const parsed = JSON.parse(stdout);
          if (!parsed || typeof parsed !== 'object' || !('answers' in parsed)) {
            reject(new Error(`SemIf bridge output missing answers: ${stdout}`));
            return;
          }
          resolve(parsed as JevResponse);
        } catch (e) {
          reject(new Error(`Failed to parse SemIf bridge JSON output: ${stdout} (error: ${e})`));
        }
      });

      child.stdin.write(JSON.stringify(payload));
      child.stdin.end();
    });
  }
}
