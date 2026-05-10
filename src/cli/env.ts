// Tiny zero-dependency .env loader. We don't pull in `dotenv` because the
// CLI is supposed to be installable and run with `npx zeroarena …` and the
// dependency surface is already small.

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

export function loadEnv(path = resolve(process.cwd(), '.env')): void {
  if (!existsSync(path)) return;
  const text = readFileSync(path, 'utf8');
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

export interface ResolvedConfig {
  rpc: string;
  indexer: string;
  privateKey: string;
  addresses: {
    AgentCertificate: string;
    ZeroArenaINFT: string;
    ReencryptionOracle: string;
  };
  oraclePrivateKey?: string;
  keysDir?: string;
}

export function configFromEnv(): ResolvedConfig {
  const rpc = required('ZA_RPC', 'https://evmrpc-testnet.0g.ai');
  const indexer = required('ZA_INDEXER', 'https://indexer-storage-testnet-turbo.0g.ai');
  const privateKey = required('PRIVATE_KEY');

  const cfg: ResolvedConfig = {
    rpc,
    indexer,
    privateKey,
    addresses: {
      AgentCertificate: required('ZA_ADDR_CERT'),
      ZeroArenaINFT: required('ZA_ADDR_INFT'),
      ReencryptionOracle: required('ZA_ADDR_ORACLE'),
    },
  };
  if (process.env.ORACLE_PRIVATE_KEY) cfg.oraclePrivateKey = process.env.ORACLE_PRIVATE_KEY;
  if (process.env.ZA_KEYS_DIR) cfg.keysDir = process.env.ZA_KEYS_DIR;
  return cfg;
}

function required(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v && v.length > 0) return v;
  if (fallback !== undefined) return fallback;
  throw new Error(
    `${name} is required (set it in .env or your shell). See sdk/.env.example for the full list.`,
  );
}
