/**
 * Child-process fixture: a host that starts the stdio-tree fixture through
 * `stdioAcpTransport`, prints its two pids, and exits without closing it.
 *
 * argv: whenHostExits ('keep' | 'stop').
 */

import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { stdioAcpTransport } from '../../src/stdio';

const tree = fileURLToPath(new URL('./stdio-tree.ts', import.meta.url));
const transport = await stdioAcpTransport({
  agentId: 'tree',
  command: process.execPath,
  args: [
    tree,
    'stubborn',
  ],
})({
  cwd: tmpdir(),
  whenHostExits: process.argv[2] === 'stop' ? 'stop' : 'keep',
});
const reader = transport.readable.getReader();
let output = '';
while (output.trim().split('\n').length < 2) {
  const chunk = await reader.read();
  if (chunk.done) {
    break;
  }
  output += new TextDecoder().decode(chunk.value);
}
process.stdout.write(`${JSON.stringify(output.trim().split('\n').map(Number))}\n`);
process.exit(0);
