# Release runbook

End-to-end sequence for cutting a Zero Arena release: deploy contracts, publish `@zero-arena/contracts`, publish `zeroarena`, smoke-test, tag.

> Prerequisites: Foundry, Node ≥ 20.6, npm access to the `zeroarena` name and the `@zero-arena` scope, a Galileo wallet funded via <https://faucet.0g.ai>.

## 1. Deploy contracts

```bash
cd contracts
cp .env.example .env       # fill DEPLOYER_*, ORACLE_SIGNER_ADDRESS
set -a && source .env && set +a

forge script script/DeployAll.s.sol:DeployAll \
  --rpc-url $GALILEO_RPC_URL \
  --private-key $DEPLOYER_PRIVATE_KEY \
  --broadcast \
  --legacy --with-gas-price 3000000000

git add deployments/galileo-testnet.json
git commit -m "deploy: galileo $(date +%Y-%m-%d)"
```

Galileo requires a tip > 2 gwei — `--legacy --with-gas-price 3000000000` is mandatory.

## 2. Verify on chainscan

The explorer's verifier sits at `/open/api`, type `custom`:

```bash
forge verify-contract \
  --chain-id 16602 --num-of-optimizations 200 \
  --compiler-version "v0.8.24+commit.e11b9ed9" \
  --verifier custom --verifier-url https://chainscan-galileo.0g.ai/open/api \
  --verifier-api-key PLACEHOLDER \
  <addr> src/<Path>.sol:<Contract>
# add --constructor-args $(cast abi-encode ...) for ReencryptionOracle + ZeroArenaINFT

# Status (avoid `forge verify-check` — GUID-mishandling bug):
curl -s "https://chainscan-galileo.0g.ai/open/api?module=contract&action=checkverifystatus&guid=<GUID>"
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
node -e "import('@zero-arena/contracts').then(m => console.log(m.addresses.galileo))"
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
- [ ] `deployments/galileo-testnet.json` matches on-chain state
- [ ] No `.env` files staged
- [ ] Trust-tier wording unchanged — v0.1 is **T2**, never "trustless"
