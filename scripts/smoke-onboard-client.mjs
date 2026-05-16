// Smoke test for HttpOnboardClient against the production onboard service.
// Run from sdk/:
//
//   node scripts/smoke-onboard-client.mjs
//
// Requires ../zero-arena-bacend/.env to expose OPERATOR_PRIVATE_KEY (owner
// wallet for tokenId 5) and `railway` CLI logged in for the bearer.

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { Wallet } from 'ethers';
import { HttpOnboardClient } from '../dist/onboard/HttpOnboardClient.js';

const ONBOARD_URL = 'https://onboard-production-ed6c.up.railway.app';
const TOKEN_ID = 5n;
const GENESIS = '0x9576f8ec10ade0b4e4059f3f7a202278a7c00b6d1f7f2a58fcf852026408fe97';

// Owner key + bearer
const env = readFileSync('../zero-arena-bacend/.env', 'utf8');
const owner = new Wallet(env.match(/^OPERATOR_PRIVATE_KEY=(.+)$/m)[1]);
const bearer = execSync(
  `railway variable --service onboard --json | python3 -c "import sys,json; print(json.load(sys.stdin)['ONBOARD_AUTH_TOKEN'])"`,
  { encoding: 'utf8', cwd: '../zero-arena-bacend' },
).trim();

const client = new HttpOnboardClient({ url: ONBOARD_URL, authToken: bearer });

console.log('=== HEALTH ===');
console.log(await client.health());

console.log('\n=== STATUS (before) ===');
console.log(await client.status());

const agentSource = readFileSync('../examples/06-ema-crossover/agent.ts', 'utf8');

console.log('\n=== ONBOARD ===');
const onboard = await client.onboard(
  {
    tokenId: TOKEN_ID,
    agentSource,
    genesisHash: GENESIS,
    barsPerEpoch: 4,
  },
  owner,
);
console.log(onboard);

console.log('\n=== STATUS (after onboard) ===');
console.log(await client.status());

console.log('\n=== OFFBOARD ===');
const offboard = await client.offboard({ tokenId: TOKEN_ID }, owner);
console.log(offboard);

console.log('\n=== STATUS (after offboard) ===');
console.log(await client.status());
