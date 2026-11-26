import { getContractAddress, keccak256, toHex, type Address, type Hex } from "viem";

/** EIP-1167 minimal-proxy init code for `implementation`: what the Portal deploys for each token. */
export function cloneInitCode(implementation: Address): Hex {
  return `0x3d602d80600a3d3981f3363d3d373d3d3d363d73${implementation.slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3`;
}

/** The address the Portal's CREATE2 gives a token launched with `salt`. */
export function predictToken(portal: Address, implementation: Address, salt: Hex): Address {
  return getContractAddress({ from: portal, salt, bytecode: cloneInitCode(implementation), opcode: "CREATE2" });
}

/**
 * Finds a salt whose token address ends in 7777, as the Portal requires. About 65,000 tries on average;
 * yields to the event loop between batches so the page stays responsive.
 */
export async function findVanitySalt(
  portal: Address,
  implementation: Address,
  suffix = "7777",
): Promise<{ salt: Hex; token: Address }> {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  let salt = keccak256(toHex(seed));
  for (let tries = 1; ; tries++) {
    const token = predictToken(portal, implementation, salt);
    if (token.toLowerCase().endsWith(suffix)) return { salt, token };
    salt = keccak256(salt);
    if (tries % 2000 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
