// Writes apps/web/src/callz-deployment.json (and the vault address into apps/web/wrangler.jsonc): the creation code, CREATE2 salt and resulting address of CallZ's three
// mainnet contracts (fee vault, trade router, mint factory), as the site's "Deploy" buttons and its trade and
// rewards code need them. The values must stay equal to contracts/script/DeployCallZPancake.s.sol; the fork test
// `test_15` checks the script against the same formula.
//
// Run from the repo root after `forge build` in contracts/:  node scripts/callz-deployment.mjs
import fs from "node:fs";
import { concatHex, encodeAbiParameters, getContractAddress, keccak256, stringToHex } from "viem";

const DEPLOYER = "0x4e59b44847b379578588920cA78FbF26c0B4956C"; // the deterministic CREATE2 deployer
const TEAM = "0x2FcB91295c790d15d5f21eD9D95C6a89E0683C58";
const PANCAKE_V2_FACTORY = "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73";
const PANCAKE_V2_ROUTER = "0x10ED43C718714eb63d5aA57B78B54704E256024E";
const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const TRADE_FEE_BPS = 200;
const LAUNCH_FEE_BPS = 1000;

const root = new URL("..", import.meta.url);
const bytecode = (name) => JSON.parse(fs.readFileSync(new URL(`contracts/out/${name}.sol/${name}.json`, root), "utf8")).bytecode.object;

function contract(name, saltText, types, values) {
  const salt = keccak256(stringToHex(saltText));
  const initCode = concatHex([bytecode(name), encodeAbiParameters(types.map((type) => ({ type })), values)]);
  const address = getContractAddress({ opcode: "CREATE2", from: DEPLOYER, salt, bytecode: initCode });
  return { salt, address, initCode };
}

const vault = contract("CallZVault", "CallZVault.v1", ["address", "address", "address"], [TEAM, TEAM, TEAM]);
const router = contract("CallZRouter", "CallZRouter.v1", ["address", "address", "address", "address", "uint16"], [PANCAKE_V2_ROUTER, WBNB, vault.address, TEAM, TRADE_FEE_BPS]);
const factory = contract("CallZPancakeFactory", "CallZPancakeFactory.v2", ["address", "address", "address", "address", "uint16"], [PANCAKE_V2_FACTORY, WBNB, vault.address, TEAM, LAUNCH_FEE_BPS]);

const out = { deployer: DEPLOYER, team: TEAM, tradeFeeBps: TRADE_FEE_BPS, launchFeeBps: LAUNCH_FEE_BPS, vault, router, factory };
fs.writeFileSync(new URL("apps/web/src/callz-deployment.json", root), `${JSON.stringify(out)}\n`);

// The API checks callout approvals against the same vault address.
const wrangler = new URL("apps/web/wrangler.jsonc", root);
const config = fs.readFileSync(wrangler, "utf8");
const pattern = /("CALLZ_VAULT":\s*")0x[0-9a-fA-F]{40}(")/;
if (!pattern.test(config)) throw new Error("apps/web/wrangler.jsonc has no CALLZ_VAULT variable to update");
fs.writeFileSync(wrangler, config.replace(pattern, `$1${vault.address}$2`));

console.log("vault  ", vault.address);
console.log("router ", router.address);
console.log("factory", factory.address);
