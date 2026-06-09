// Minimal ABI fragments — only the methods + events the SDK actually calls.
// Keeping the ABI surface small means a contract redeploy that adds an admin
// helper does NOT trigger an SDK release. The full ABIs ship in the
// @zero-arena/contracts package for consumers that need them.

export const AGENT_CERTIFICATE_ABI = [
  // submit(...)
  'function submit(bytes32 runHash, bytes32 storageRootHash, bytes32 datasetHash, bytes32 attestationHash, int128 totalReturnBps, uint128 sharpeX1000, uint16 maxDrawdownBps, uint16 winRateBps, uint8 trustTier, uint8 market) external returns (uint256 certId)',
  'function get(uint256 certId) external view returns (tuple(bytes32 runHash, bytes32 storageRootHash, bytes32 datasetHash, bytes32 attestationHash, int128 totalReturnBps, uint128 sharpeX1000, address owner, uint48 createdAt, uint16 maxDrawdownBps, uint16 winRateBps, uint8 trustTier, uint8 market) cert)',
  'function nextCertId() external view returns (uint256)',
  'event CertificateSubmitted(uint256 indexed certId, address indexed owner, bytes32 indexed runHash, bytes32 storageRootHash, uint8 trustTier, uint8 market)',
] as const;

export const ZERO_ARENA_INFT_ABI = [
  'function mint(uint256 certificateId, bytes32 metadataHash, bytes32 storageRoot) external returns (uint256 tokenId)',
  'function transfer(address from, address to, uint256 tokenId, bytes sealedKey, bytes proof) external',
  'function clone(address to, uint256 tokenId, bytes sealedKey, bytes proof) external returns (uint256 newTokenId)',
  'function authorizeUsage(uint256 tokenId, address executor, bytes permissions) external',
  'function ownerOf(uint256 tokenId) external view returns (address)',
  'function metadataHashes(uint256 tokenId) external view returns (bytes32)',
  'function storageRoots(uint256 tokenId) external view returns (bytes32)',
  'function certificateOf(uint256 tokenId) external view returns (uint256)',
  'function transferNonce(uint256 tokenId) external view returns (uint256)',
  'function nextTokenId() external view returns (uint256)',
  'function oracle() external view returns (address)',
  'event AgentMinted(uint256 indexed tokenId, address indexed owner, uint256 indexed certificateId, bytes32 metadataHash, bytes32 storageRoot)',
  'event MetadataUpdated(uint256 indexed tokenId, bytes32 newMetadataHash)',
  'event SealedKeyDelivered(uint256 indexed tokenId, address indexed to, bytes sealedKey)',
] as const;

export const REENCRYPTION_ORACLE_ABI = [
  'function signer() external view returns (address)',
  'function verifyTransfer(address inft, uint256 tokenId, address from, address to, bytes32 sealedKeyHash, bytes32 newMetadataHash, uint256 nonce, uint256 deadline, bytes signature) external view returns (bool)',
] as const;

/** Tier byte the contract expects. */
export function trustTierToByte(tier: 'T1' | 'T2' | 'T3'): number {
  return tier === 'T1' ? 1 : tier === 'T2' ? 2 : 3;
}

/** Market byte the contract expects. */
export function marketToByte(market: 'spot' | 'perp'): number {
  return market === 'spot' ? 0 : 1;
}

/** Inverse of `marketToByte`. */
export function marketFromByte(byte: number): 'spot' | 'perp' {
  return byte === 0 ? 'spot' : 'perp';
}
