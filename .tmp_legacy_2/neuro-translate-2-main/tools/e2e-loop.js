#!/usr/bin/env node
const { spawnSync } = require('child_process');

const MAX_RUNS = 3;
const cmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const args = ['playwright', 'test', '--project=ext-headed', '--grep-invert', 'REAL fimfiction|real-fimfiction'];

let finalStatus = 1;
let attempt = 0;

for (attempt = 1; attempt <= MAX_RUNS; attempt += 1) {
  // eslint-disable-next-line no-console
  console.log(`[e2e-loop] attempt ${attempt}/${MAX_RUNS}`);
  const result = spawnSync(cmd, args, {
    stdio: 'inherit',
    env: process.env,
    shell: false
  });

  if (result.error) {
    // eslint-disable-next-line no-console
    console.error(result.error && result.error.message ? result.error.message : String(result.error));
    finalStatus = 1;
  } else {
    finalStatus = typeof result.status === 'number' ? result.status : 1;
  }

  if (finalStatus === 0) {
    break;
  }
}

if (finalStatus === 0) {
  // eslint-disable-next-line no-console
  console.log(`[e2e-loop] success on attempt ${attempt}`);
} else {
  // eslint-disable-next-line no-console
  console.error(`[e2e-loop] failed after ${MAX_RUNS} attempts`);
}

process.exit(finalStatus);
