// Onboard client surface. The contract: an owner can submit / revoke a
// paper-daemon delegation against a remote operator service (e.g.
// zero-arena-be's `onboard` endpoint deployed at
// https://onboard-production-ed6c.up.railway.app).
//
// Implementations must validate input and translate to the operator's
// wire format. The default HTTP implementation is in HttpOnboardClient.

export interface OnboardParams {
  /** iNFT token id to delegate. */
  tokenId: bigint;
  /** Full agent module source code (TypeScript), default-exporting an Agent subclass. */
  agentSource: string;
  /** Static cert runHash for this iNFT (must match AgentCertificate.get(certId).runHash). */
  genesisHash: `0x${string}`;
  /** Binance kline stream symbol, lowercase. Default `btcusdt`. */
  symbol?: string;
  /** Kline interval — e.g. `15m`, `1h`. Default `15m`. */
  interval?: string;
  /** `spot` or `perp`. Default `spot`. */
  market?: 'spot' | 'perp';
  /** Bars per `EpochCommitted`. Default 96 (24h at 15m). */
  barsPerEpoch?: number;
  /** Starting balance for the engine. Default 10_000. */
  initialBalance?: number;
  /** Leverage for perp. Default 1. */
  leverage?: number;
  /** Taker fee in basis points. Default 10. */
  feeBps?: number;
  /** Slippage in basis points. Default 5. */
  slippageBps?: number;
}

export interface OffboardParams {
  /** iNFT token id whose delegated daemon should be stopped. */
  tokenId: bigint;
}

export interface OnboardResult {
  status: string;
  tokenId: string;
  operator: string;
  pid: number;
  startedAt: string;
}

export interface OffboardResult {
  status: string;
  tokenId: string;
}

export interface OnboardHealth {
  status: 'ok' | 'error';
  operator: string;
  active: number;
  authRequired: boolean;
}

export interface OnboardStatus {
  operator: string;
  daemons: Array<{ tokenId: string; pid: number; startedAt: string }>;
}

/** Minimal duck-typed signer. Compatible with ethers.Wallet, viem WalletClient, etc. */
export interface MessageSigner {
  /** Address of the signing account. Used by the operator to recover signatures. */
  getAddress(): Promise<string> | string;
  /** EIP-191 personal_sign over the given UTF-8 message. */
  signMessage(message: string): Promise<string>;
}

export type OnboardAction = 'onboard' | 'offboard';

export interface SignedOnboardPayload {
  action: OnboardAction;
  tokenId: string;
  nonce: string;
  deadline: string;
}

/** Build the deterministic JSON the owner signs. Must match the operator's
 * `digestFor()` byte-for-byte — keep both implementations in lockstep. */
export function digestForOnboard(payload: SignedOnboardPayload): string {
  return JSON.stringify(
    {
      action: payload.action,
      deadline: payload.deadline,
      nonce: payload.nonce,
      tokenId: payload.tokenId,
    },
    null,
    0,
  );
}

export interface OnboardClient {
  onboard(params: OnboardParams, signer: MessageSigner): Promise<OnboardResult>;
  offboard(params: OffboardParams, signer: MessageSigner): Promise<OffboardResult>;
  status(): Promise<OnboardStatus>;
  health(): Promise<OnboardHealth>;
}
