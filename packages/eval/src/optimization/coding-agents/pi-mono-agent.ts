import { spawn as spawnProcess } from 'node:child_process';

import type { ApplyResult, CodingAgent, OptimizationRecommendation } from '../../types/optimizer';

// Type helper for accessing event emitter methods on child process
interface ChildProcessWithEvents {
  stdout?: {
    on: (event: 'data', callback: (data: Buffer) => void) => void;
  };
  stderr?: {
    on: (event: 'data', callback: (data: Buffer) => void) => void;
  };
  stdin?: {
    write: (data: string) => void;
    end: () => void;
  };
  on: (event: string, callback: (arg: unknown) => void) => void;
}

// Helper to spawn child process with proper event emitter types
function spawnChildProcess(): ChildProcessWithEvents {
  // The spawned process has the event methods at runtime, but TypeScript's types don't reflect this
  const rawChild = spawnProcess(
    'pi',
    [
      '--mode',
      'rpc',
    ],
    {
      stdio: [
        'pipe',
        'pipe',
        'pipe',
      ],
    },
  );

  // Build the interface by creating a wrapper object
  return {
    get stdout() {
      return Reflect.get(rawChild, 'stdout');
    },
    get stderr() {
      return Reflect.get(rawChild, 'stderr');
    },
    get stdin() {
      return Reflect.get(rawChild, 'stdin');
    },
    on: (event: string, callback: (arg: unknown) => void) => {
      const onFn = Reflect.get(rawChild, 'on');
      Reflect.apply(onFn, rawChild, [
        event,
        callback,
      ]);
    },
  } satisfies ChildProcessWithEvents;
}

//#region Helper Functions

function parseRpcResponse(stdout: string): ApplyResult {
  const response: {
    result?: {
      success?: boolean;
      changedFiles?: string[];
    };
    error?: {
      message?: string;
    };
  } = JSON.parse(stdout);
  return {
    success: response.result?.success ?? false,
    changedFiles: response.result?.changedFiles ?? [],
    error: response.error?.message,
  };
}

function buildRpcRequest(recommendation: OptimizationRecommendation): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    method: 'apply',
    id: 1,
    params: {
      task: recommendation.description,
      files: recommendation.targetFiles,
      feedback: recommendation.gepaFeedback,
    },
  });
}

//#endregion

//#region Public API

export class PiMonoAgent implements CodingAgent {
  async apply(recommendation: OptimizationRecommendation): Promise<ApplyResult> {
    try {
      return await this.sendRpcRequest(recommendation);
    } catch (error) {
      return {
        success: false,
        changedFiles: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private sendRpcRequest(recommendation: OptimizationRecommendation): Promise<ApplyResult> {
    return new Promise((resolve, reject) => {
      const child = spawnChildProcess();

      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString();
      });
      child.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      child.stdin?.write(buildRpcRequest(recommendation));
      child.stdin?.end();

      child.on('close', (code: unknown) => {
        if (code !== 0) {
          reject(new Error(`pi-mono exited with code ${code}: ${stderr}`));
          return;
        }
        try {
          resolve(parseRpcResponse(stdout));
        } catch {
          reject(new Error(`Failed to parse pi-mono response: ${stdout}`));
        }
      });

      child.on('error', (err: unknown) => {
        const message =
          err && typeof err === 'object' && 'message' in err ? String(err.message) : String(err);
        reject(
          new Error(
            `Failed to spawn pi-mono: ${message}. Is @mariozechner/pi-coding-agent installed?`,
          ),
        );
      });
    });
  }
}

//#endregion
