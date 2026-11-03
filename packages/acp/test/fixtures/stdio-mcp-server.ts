/**
 * Child-process fixture: answers MCP `tools/list` over newline-delimited
 * JSON-RPC on stdio, naming the machine's working directory in its one tool,
 * as a server that reads the agent's workspace would.
 */

import { createInterface } from 'node:readline';

const lines = createInterface({
  input: process.stdin,
});
lines.on('line', (line) => {
  const message = JSON.parse(line);
  process.stdout.write(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        tools: [
          {
            name: 'read_workspace',
            description: `Reads ${process.cwd()}`,
            inputSchema: {
              type: 'object',
            },
          },
        ],
      },
    })}\n`,
  );
});
