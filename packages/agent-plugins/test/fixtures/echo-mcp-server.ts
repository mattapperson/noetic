/** A stdio MCP server with one `echo` tool, spawned by the live client tests. */
import { Server } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

const server = new Server(
  {
    name: 'echo',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  },
);
server.setRequestHandler('tools/list', async () => ({
  tools: [
    {
      name: 'echo',
      description: 'Echo the text.',
      inputSchema: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
          },
        },
      },
    },
  ],
}));
server.setRequestHandler('tools/call', async (request) => ({
  content: [
    {
      type: 'text',
      text: `echo:${String(request.params.arguments?.text)}`,
    },
  ],
}));
await server.connect(new StdioServerTransport());
