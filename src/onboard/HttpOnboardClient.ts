// HttpOnboardClient — JSON HTTP client for zero-arena-be's `onboard`
// service. Holds the bearer token; delegates message signing to the
// caller's wallet so the SDK never sees the owner's private key.
//
// Wire format:
//   POST  {url}/onboard    body: {payload, signature, agentSource, ...}
//   POST  {url}/offboard   body: {payload, signature}
//   GET   {url}/status
//   GET   {url}/health
//
// All numeric values flow as decimal strings on the wire to preserve
// uint256 fidelity.

import {
  digestForOnboard,
  type MessageSigner,
  type OffboardParams,
  type OffboardResult,
  type OnboardClient,
  type OnboardHealth,
  type OnboardParams,
  type OnboardResult,
  type OnboardStatus,
  type SignedOnboardPayload,
} from './OnboardClient.js';
import { encryptAgentSource, type EncryptedAgentBundle } from './crypto.js';
import { keccak256, toUtf8Bytes } from 'ethers';

export interface HttpOnboardClientConfig {
  /** Base URL of the onboard service. Trailing slash optional. */
  url: string;
  /** Optional bearer token (set via ONBOARD_AUTH_TOKEN on the service). */
  authToken?: string;
  /** Extra headers — overrides Authorization if both set. */
  headers?: Record<string, string>;
  /** Request timeout in ms. Default 30_000 (covers spawn + on-chain checks). */
  timeoutMs?: number;
  /** Random-bytes provider for the nonce. Defaults to globalThis.crypto. */
  randomBytes?: (size: number) => Uint8Array;
  /** Clock source (unix seconds). Defaults to Date.now() / 1000. */
  now?: () => number;
  /** How far in the future the signed deadline sits, in seconds. Default 600. */
  deadlineWindowSec?: number;
  /**
   * Encrypt `agentSource` against the operator's secp256k1 pubkey before
   * POSTing. Defaults to `true`. The pubkey is fetched from `/health`
   * lazily on the first onboard() unless `operatorPubKey` is set below.
   */
  encrypt?: boolean;
  /**
   * Pin the operator's compressed secp256k1 pubkey (33-byte hex). When
   * unset, the client fetches it from `/health` on the first onboard().
   */
  operatorPubKey?: string;
}

const DEFAULTS = {
  timeoutMs: 30_000,
  deadlineWindowSec: 600,
};

function bytesToHex(bytes: Uint8Array): string {
  let hex = '0x';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

export class HttpOnboardClient implements OnboardClient {
  private readonly base: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly randomBytes: (size: number) => Uint8Array;
  private readonly nowSec: () => number;
  private readonly deadlineWindowSec: number;
  private readonly encrypt: boolean;
  private operatorPubKey: string | undefined;

  constructor(config: HttpOnboardClientConfig) {
    if (!config.url) throw new Error('HttpOnboardClient: url is required');
    this.base = config.url.replace(/\/$/, '');

    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (config.authToken) headers.authorization = `Bearer ${config.authToken}`;
    if (config.headers) Object.assign(headers, config.headers);
    this.headers = headers;

    this.timeoutMs = config.timeoutMs ?? DEFAULTS.timeoutMs;
    this.deadlineWindowSec = config.deadlineWindowSec ?? DEFAULTS.deadlineWindowSec;
    this.randomBytes =
      config.randomBytes ??
      ((size: number) => {
        const out = new Uint8Array(size);
        const g = (globalThis as { crypto?: { getRandomValues(arr: Uint8Array): Uint8Array } })
          .crypto;
        if (!g) throw new Error('HttpOnboardClient: no crypto.getRandomValues — pass config.randomBytes');
        g.getRandomValues(out);
        return out;
      });
    this.nowSec = config.now ?? ((): number => Math.floor(Date.now() / 1000));
    this.encrypt = config.encrypt ?? true;
    this.operatorPubKey = config.operatorPubKey;
  }

  // ─── Public API ────────────────────────────────────────────────────────

  async onboard(params: OnboardParams, signer: MessageSigner): Promise<OnboardResult> {
    if (params.tokenId <= 0n) throw new Error('onboard: tokenId must be positive');
    if (!params.agentSource || params.agentSource.length === 0) {
      throw new Error('onboard: agentSource is required (full TypeScript source)');
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(params.genesisHash)) {
      throw new Error('onboard: genesisHash must be a 0x-prefixed 32-byte hex');
    }

    // Bind the agent code + every run param into the signed payload (H4). The
    // hash covers the PLAINTEXT source; the server re-hashes after decrypt.
    const payload: SignedOnboardPayload = {
      action: 'onboard',
      tokenId: params.tokenId.toString(),
      nonce: bytesToHex(this.randomBytes(16)),
      deadline: String(this.nowSec() + this.deadlineWindowSec),
      agentHash: keccak256(toUtf8Bytes(params.agentSource)),
      genesisHash: params.genesisHash,
      symbol: (params.symbol ?? 'btcusdt').toLowerCase(),
      interval: params.interval ?? '15m',
      market: params.market ?? 'spot',
      barsPerEpoch: String(params.barsPerEpoch ?? 96),
      initialBalance: String(params.initialBalance ?? 10_000),
      leverage: String(params.leverage ?? 1),
      feeBps: String(params.feeBps ?? 10),
      slippageBps: String(params.slippageBps ?? 5),
    };
    const signature = await signer.signMessage(digestForOnboard(payload));

    let agentField: string | EncryptedAgentBundle = params.agentSource;
    if (this.encrypt) {
      if (!this.operatorPubKey) {
        const h = await this.health();
        if (!h.operatorPubKey) {
          throw new Error(
            'HttpOnboardClient: encrypt=true but server /health did not expose operatorPubKey — set encrypt=false or pin operatorPubKey',
          );
        }
        this.operatorPubKey = h.operatorPubKey;
      }
      agentField = encryptAgentSource(params.agentSource, this.operatorPubKey);
    }

    // Run params now live inside the signed payload, not as loose body fields.
    const body = { payload, signature, agentSource: agentField };
    return this.post<OnboardResult>('/onboard', body);
  }

  async offboard(params: OffboardParams, signer: MessageSigner): Promise<OffboardResult> {
    if (params.tokenId <= 0n) throw new Error('offboard: tokenId must be positive');

    const payload = this.buildPayload('offboard', params.tokenId);
    const signature = await signer.signMessage(digestForOnboard(payload));

    return this.post<OffboardResult>('/offboard', { payload, signature });
  }

  async status(): Promise<OnboardStatus> {
    return this.get<OnboardStatus>('/status');
  }

  async health(): Promise<OnboardHealth> {
    return this.get<OnboardHealth>('/health');
  }

  // ─── Internals ─────────────────────────────────────────────────────────

  private buildPayload(action: 'onboard' | 'offboard', tokenId: bigint): SignedOnboardPayload {
    return {
      action,
      tokenId: tokenId.toString(),
      nonce: bytesToHex(this.randomBytes(16)),
      deadline: String(this.nowSec() + this.deadlineWindowSec),
    };
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    return this.fetchJson<T>(path, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
    });
  }

  private async get<T>(path: string): Promise<T> {
    return this.fetchJson<T>(path, { method: 'GET', headers: this.headers });
  }

  private async fetchJson<T>(path: string, init: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `HttpOnboardClient: ${init.method ?? 'GET'} ${path} → ${res.status} ${res.statusText} — ${text.slice(0, 240)}`,
      );
    }
    return (await res.json()) as T;
  }
}
