#!/usr/bin/env node
const { spawnSync } = require('child_process');

const cmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const args = [
  'playwright',
  'test',
  'tests/e2e/ui-popup.spec.js',
  'tests/e2e/ui-debug.spec.js',
  '--project=ext-headed'
];

const env = {
  ...process.env,
  BROWSER_FLAVOR: 'edge-stable'
};

// eslint-disable-next-line no-console
console.log('[e2e-edge] running ext-headed with BROWSER_FLAVOR=edge-stable');
const result = spawnSync(cmd, args, {
  stdio: 'inherit',
  env,
  shell: false
});

if (result.error) {
  // eslint-disable-next-line no-console
  console.error(result.error && result.error.message ? result.error.message : String(result.error));
  process.exit(1);
}

process.exit(typeof result.status === 'number' ? result.status : 1);
