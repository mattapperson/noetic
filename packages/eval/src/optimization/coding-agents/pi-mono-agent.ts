import { spawn } from 'node:child_process';

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

  private sendRpcRequest(recommendation: OptimizationRecommendation): Promise<ApplyResult> {
    return new Promise((resolve, reject) => {
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

      child.on('close', (code) => {
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

      child.on('error', (err) => {
        reject(
          new Error(
            `Failed to spawn pi-mono: ${err.message}. Is @mariozechner/pi-coding-agent installed?`,
          ),
        );
      });
    });
  }
}

//#endregion
