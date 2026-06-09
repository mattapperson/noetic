import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';

import type { ApplyResult, CodingAgent, OptimizationRecommendation } from '../../types/optimizer';

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

/**
 * Bun's ChildProcess types omit EventEmitter methods (.on, .once, etc.)
 * even though the runtime object IS an EventEmitter. This helper validates
 * the instance at runtime and returns it typed correctly for events.once().
 */
function asEmitter(obj: unknown): EventEmitter {
  if (!(obj instanceof EventEmitter)) {
    throw new Error('Expected an EventEmitter instance');
  }
  return obj;
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

  private async sendRpcRequest(recommendation: OptimizationRecommendation): Promise<ApplyResult> {
    const child = spawn(
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

    // once() resolves on 'close' with [code, signal], and rejects if
    // 'error' fires first (e.g. binary not found), matching the original
    // child.on('close')/child.on('error') behavior with proper Bun types.
    const closeArgs = await once(asEmitter(child), 'close');
    const code = typeof closeArgs[0] === 'number' ? closeArgs[0] : null;

    if (code !== 0) {
      throw new Error(`pi-mono exited with code ${code}: ${stderr}`);
    }
    try {
      return parseRpcResponse(stdout);
    } catch {
      throw new Error(`Failed to parse pi-mono response: ${stdout}`);
    }
  }
}

//#endregion
