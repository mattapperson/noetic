import { spawn as spawnProcess } from 'node:child_process';

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
    const child = spawnProcess(
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

    const code = await new Promise<number | null>((resolve, reject) => {
      child.ref();
      child.exitCode !== null
        ? resolve(child.exitCode)
        : child.stdout?.once('end', () => resolve(child.exitCode));
      child.stderr?.once('error', (err: Error) =>
        reject(
          new Error(
            `Failed to spawn pi-mono: ${err.message}. Is @mariozechner/pi-coding-agent installed?`,
          ),
        ),
      );
    });

    if (code !== 0) {
      throw new Error(`pi-mono exited with code ${code}: ${stderr}`);
    }
    return parseRpcResponse(stdout);
  }
}

//#endregion
