const { spawn } = require('node:child_process');
const fs = require('node:fs');
const child = spawn(
  process.execPath,
  [
    '-e',
    "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
  ],
  {
    stdio: [
      'ignore',
      'inherit',
      'inherit',
    ],
  },
);
fs.writeFileSync(process.env.ACP_PID_FILE, String(child.pid));
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
