// Writes apps/web/src/factory-deployment.json: the creation code, CREATE2 salt and resulting address of the
// CallZLauncherFactory (the Flap Pool Launch launcher factory), as the site's "Deploy" button needs them. The
// same address goes into the launch UI package (flap-ui/callz-launcher/manifest.json and Component.tsx), which
// only serves that factory. The values must stay equal to contracts/script/Deploy.s.sol.
//
// It also prints the CallZCurveFactory address, computed the same way from contracts/script/DeployCurve.s.sol.
//
// Run from the repo root after `forge build` in contracts/:  node scripts/flap-deployment.mjs
import fs from "node:fs";
import { concatHex, encodeAbiParameters, getContractAddress, keccak256, stringToHex } from "viem";

const DEPLOYER = "0x4e59b44847b379578588920cA78FbF26c0B4956C"; // the deterministic CREATE2 deployer
const BONDING_CURVE_PORTAL = "0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0"; // Flap's bonding curve Portal on BNB Chain

const root = new URL("..", import.meta.url);
const bytecode = (name) => JSON.parse(fs.readFileSync(new URL(`contracts/out/${name}.sol/${name}.json`, root), "utf8")).bytecode.object;

function contract(name, saltText, types, values) {
  const salt = keccak256(stringToHex(saltText));
  const initCode = concatHex([bytecode(name), encodeAbiParameters(types.map((type) => ({ type })), values)]);
  const address = getContractAddress({ opcode: "CREATE2", from: DEPLOYER, salt, bytecode: initCode });
  return { salt, address, initCode };
}

// The launcher factory has no constructor arguments: it reads the Portal and the Guardian from the chain registry.
const launcherFactory = contract("CallZLauncherFactory", "CallZLauncherFactory.v1", [], []);
const curveFactory = contract("CallZCurveFactory", "CallZCurveFactory.v1", ["address"], [BONDING_CURVE_PORTAL]);

fs.writeFileSync(new URL("apps/web/src/factory-deployment.json", root), `${JSON.stringify({ deployer: DEPLOYER, ...launcherFactory })}\n`);

// The launch UI package names the one factory it serves, in lower case, in two places.
function replaceIn(path, pattern) {
  const file = new URL(path, root);
  const text = fs.readFileSync(file, "utf8");
  if (!pattern.test(text)) throw new Error(`${path} has no factory address to update`);
  fs.writeFileSync(file, text.replace(pattern, `$1${launcherFactory.address.toLowerCase()}$2`));
}
replaceIn("flap-ui/callz-launcher/manifest.json", /("factoryAddress":\s*")0x[0-9a-fA-F]{40}(")/);
replaceIn("flap-ui/callz-launcher/Component.tsx", /(const callZFactory = ")0x[0-9a-fA-F]{40}(")/);

console.log("launcher factory", launcherFactory.address);
console.log("curve factory   ", curveFactory.address);
