/**
 * Child-process fixture: a stdio MCP server whose one tool, `env`, answers
 * with the environment the server was started with.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  {
    name: 'env',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  },
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'env',
      description: 'The environment this server started with.',
      inputSchema: {
        type: 'object',
      },
    },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, async () => ({
  content: [
    {
      type: 'text',
      text: JSON.stringify(process.env),
    },
  ],
}));
await server.connect(new StdioServerTransport());
