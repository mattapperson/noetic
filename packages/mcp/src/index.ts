/**
 * `@noetic-tools/mcp` — Model Context Protocol for Noetic.
 *
 * The runtime-neutral entry: the MCP server that serves a tool host. The
 * loopback HTTP transport lives at `@noetic-tools/mcp/node`.
 */

export { agentCallIdOf, createToolServer } from './server';
