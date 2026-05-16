# Release runbook

End-to-end sequence for cutting a Zero Arena release on 0G mainnet (chainId 16661): deploy contracts, publish `@zero-arena/contracts`, publish `zeroarena`, smoke-test, tag.

> Prerequisites: Foundry, Node ≥ 20.6, npm access to the `zeroarena` name and the `@zero-arena` scope, and a wallet funded with real 0G on mainnet.

## 1. Deploy contracts

```bash
cd contracts
cp .env.example .env       # fill DEPLOYER_*, ORACLE_SIGNER_ADDRESS, OPERATOR_ADDRESS
set -a && source .env && set +a

forge script script/DeployAll.s.sol:DeployAll \
  --rpc-url $MAINNET_RPC_URL \
  --private-key $DEPLOYER_PRIVATE_KEY \
  --broadcast

# read deployments/16661.json, set ZA_ADDR_INFT in .env, then:
forge script script/DeployPaperEngine.s.sol:DeployPaperEngine \
  --rpc-url $MAINNET_RPC_URL \
  --private-key $DEPLOYER_PRIVATE_KEY \
  --broadcast

git add deployments/16661.json deployments/16661-paper-engine.json
git commit -m "deploy: mainnet $(date +%Y-%m-%d)"
```

Full runbook with sanity / rollback notes: [`contracts/MAINNET-DEPLOY.md`](https://github.com/Zero-Arena/zero-arena-contracts/blob/main/MAINNET-DEPLOY.md).

## 2. Verify on chainscan

The explorer's verifier sits at `/open/api`, type `custom`:

```bash
forge verify-contract \
  --chain-id 16661 --num-of-optimizations 200 \
  --compiler-version "v0.8.24+commit.e11b9ed9" \
  --verifier custom \
  --verifier-url https://chainscan.0g.ai/open/api \
  --verifier-api-key PLACEHOLDER \
  <addr> src/<Path>.sol:<Contract>
# add --constructor-args $(cast abi-encode ...) for ReencryptionOracle + ZeroArenaINFT + LiveCertificate + Season

# Status (avoid `forge verify-check` — GUID-mishandling bug):
curl -s "https://chainscan.0g.ai/open/api?module=contract&action=checkverifystatus&guid=<GUID>"
```

Full per-contract commands live in [`contracts/README.md`](https://github.com/Zero-Arena/zero-arena-contracts#source-verification).

## 3. Publish `@zero-arena/contracts`

```bash
cd contracts
node scripts/build-abi.mjs
npm publish --access public
git tag contracts-v$(node -p "require('./package.json').version") && git push --tags
```

Sanity check (use the version you just published):

```bash
mkdir /tmp/check && cd /tmp/check && npm init -y >/dev/null
npm install @zero-arena/contracts@latest
node -e "import('@zero-arena/contracts').then(m => console.log(m.addresses.mainnet))"
```

## 4. Smoke-test the SDK against the live deployment

```bash
cd examples
cp .env.example .env       # fill PRIVATE_KEY only — addresses are pre-pinned
npm install
npm run 01:run             # backtest → certify → mint
```

Expect a printed `certId`, `tokenId`, and explorer link for each step.

## 5. Publish `zeroarena`

```bash
cd sdk
npm test && npm run build
npm publish --access public
git tag sdk-v$(node -p "require('./package.json').version") && git push --tags
```

Fresh-install check:

```bash
mkdir /tmp/sdk-check && cd /tmp/sdk-check && npm init -y >/dev/null
npm install zeroarena
node -e "import('zeroarena').then(m => console.log(Object.keys(m)))"
npx zeroarena --help
```

## Patch releases

- **Contract change** → bump `contracts/package.json`, redeploy, `build-abi`, `npm publish`. Bump `sdk`'s `@zero-arena/contracts` dep, bump `sdk/package.json`, `npm publish`.
- **SDK-only change** → bump `sdk/package.json`, `npm publish`. No contract redeploy.

## Pre-publish checklist

- [ ] `forge test` green
- [ ] `npm test` in `sdk/` green
- [ ] `npm run 01:backtest` in `examples/` green
- [ ] `deployments/16661.json` matches on-chain state
- [ ] `@zero-arena/contracts` `dist/addresses.json` has `mainnet` entry populated
- [ ] No `.env` files staged
- [ ] Trust-tier wording unchanged — v0.1 is **T2**, never "trustless"; mainnet preview caveat about the oracle stub is intact
