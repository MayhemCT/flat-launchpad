// Writes apps/web/src/room-deployment.json and apps/worker/src/room-factory.json: the creation code, CREATE2 salt
// and resulting address of CallZRoomFactory, the factory of CallZ's rooms on BNB Chain, as the site's "Deploy"
// button and the API need them.
//
// The room contracts are built on their own, into contracts/out-rooms, so the build output of the contracts that
// are already deployed is never disturbed. Run from the repo root:
//   (cd contracts && FOUNDRY_OUT=out-rooms FOUNDRY_CACHE_PATH=cache-rooms forge build --skip test --skip script)
//   node scripts/room-deployment.mjs
import fs from "node:fs";
import { concatHex, encodeAbiParameters, getContractAddress, keccak256, stringToHex } from "viem";

const DEPLOYER = "0x4e59b44847b379578588920cA78FbF26c0B4956C"; // the deterministic CREATE2 deployer
const PANCAKE_V2_FACTORY = "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73";
const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";

const root = new URL("..", import.meta.url);
// The vault, the team wallet and the launch fee are the ones the deployed mint factory uses.
const callz = JSON.parse(fs.readFileSync(new URL("apps/web/src/callz-deployment.json", root), "utf8"));
const bytecode = JSON.parse(fs.readFileSync(new URL("contracts/out-rooms/CallZRoomFactory.sol/CallZRoomFactory.json", root), "utf8")).bytecode.object;

const salt = keccak256(stringToHex("CallZRoomFactory.v1"));
const initCode = concatHex([
  bytecode,
  encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "uint16" }],
    [PANCAKE_V2_FACTORY, WBNB, callz.vault.address, callz.team, callz.launchFeeBps],
  ),
]);
const address = getContractAddress({ opcode: "CREATE2", from: DEPLOYER, salt, bytecode: initCode });

fs.writeFileSync(new URL("apps/web/src/room-deployment.json", root), `${JSON.stringify({ deployer: DEPLOYER, vault: callz.vault.address, guardian: callz.team, launchFeeBps: callz.launchFeeBps, factory: { salt, address, initCode } })}\n`);
fs.writeFileSync(new URL("apps/worker/src/room-factory.json", root), `${JSON.stringify({ address })}\n`);
console.log("room factory", address, `(${(initCode.length - 2) / 2} bytes of creation code)`);
