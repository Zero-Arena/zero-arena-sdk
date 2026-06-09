// HttpOracleClient — talks to a remote oracle service over JSON HTTP. The
// service (the `oracle` service in zero-arena-bacend) holds the private
// key; the SDK only ever sees signature bytes coming back.
//
// Wire format:
//   POST {url}/sign-transfer-proof
//   Content-Type: application/json
//   Body:    {chainId, inftAddress, tokenId, from, to, sealedKeyHash,
//             newMetadataHash, deadline}  — all bigints sent as strings
//   200 OK:  {signature: "0x..."}
//   4xx/5xx: {error: "..."}

import type { OracleClient, TransferProofRequest } from './OracleClient.js';

export interface HttpOracleClientConfig {
  /** Base URL of the oracle service. Trailing slash optional. */
  url: string;
  /** Optional auth or instrumentation headers. */
  headers?: Record<string, string>;
  /** Request timeout in milliseconds. Default 10_000. */
  timeoutMs?: number;
}

export class HttpOracleClient implements OracleClient {
  private readonly base: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;

  constructor(config: HttpOracleClientConfig) {
    if (!config.url) throw new Error('HttpOracleClient: url is required');
    this.base = config.url.replace(/\/$/, '');
    this.headers = { 'content-type': 'application/json', ...(config.headers ?? {}) };
    this.timeoutMs = config.timeoutMs ?? 10_000;
  }

  async signTransferProof(req: TransferProofRequest): Promise<string> {
    const body = JSON.stringify({
      chainId: req.chainId.toString(),
      inftAddress: req.inftAddress,
      tokenId: req.tokenId.toString(),
      from: req.from,
      to: req.to,
      sealedKeyHash: req.sealedKeyHash,
      newMetadataHash: req.newMetadataHash,
      nonce: req.nonce.toString(),
      deadline: req.deadline.toString(),
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${this.base}/sign-transfer-proof`, {
        method: 'POST',
        headers: this.headers,
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HttpOracleClient: ${res.status} ${res.statusText} — ${text.slice(0, 200)}`);
    }

    const json = (await res.json()) as { signature?: unknown };
    if (typeof json.signature !== 'string' || !json.signature.startsWith('0x')) {
      throw new Error(`HttpOracleClient: response missing 0x-prefixed 'signature' field`);
    }
    return json.signature;
  }
}
