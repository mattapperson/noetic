/**
 * The environment a stdio MCP server starts with, wherever it starts. The MCP
 * SDK's stdio client passes a server only a short list of this process's
 * variables (`getDefaultEnvironment()`), so a server noetic starts on an
 * agent's machine gets the same list from that machine, never the rest of
 * its environment. The list is the SDK's (sudo's defaults):
 * https://github.com/modelcontextprotocol/typescript-sdk/blob/main/src/client/stdio.ts
 */

const INHERITED =
  process.platform === 'win32'
    ? [
        'APPDATA',
        'HOMEDRIVE',
        'HOMEPATH',
        'LOCALAPPDATA',
        'PATH',
        'PROCESSOR_ARCHITECTURE',
        'SYSTEMDRIVE',
        'SYSTEMROOT',
        'TEMP',
        'USERNAME',
        'USERPROFILE',
        'PROGRAMFILES',
      ]
    : [
        'HOME',
        'LOGNAME',
        'PATH',
        'SHELL',
        'TERM',
        'USER',
      ];

/** This process's inherited variables, with `env` over them. */
export function serverEnv(
  env: Readonly<Record<string, string | undefined>> | undefined,
): Record<string, string | undefined> {
  const inherited: Record<string, string> = {};
  for (const name of INHERITED) {
    const value = process.env[name];
    // A shell function exported as a variable runs in every shell the server starts.
    if (value === undefined || value.startsWith('()')) {
      continue;
    }
    inherited[name] = value;
  }
  return {
    ...inherited,
    ...env,
  };
}
