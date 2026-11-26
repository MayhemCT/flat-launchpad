import { readFileSync } from "node:fs";
import { decodeAbiParameters, keccak256, parseAbiParameters, toHex, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { findVanitySalt, predictToken } from "../src/salt";

const PORTAL: Address = "0x000042108465206185A077Edc3F3fd2b49060000";
const TOKEN_IMPLEMENTATION: Address = "0x7777c57ff7dc441c1715b2e36fa581c48B782222";

// Real Portal logs from BNB Chain, captured by scripts/capture-fixture.ts.
const fixture = JSON.parse(
  readFileSync(new URL("../../../packages/protocol/test/fixtures/bsc-portal-logs.json", import.meta.url), "utf8"),
) as { logs: Array<{ topics: Hex[]; data: Hex }> };

const SALT_LOCKED = keccak256(toHex("FlapSaltLocked(address,bytes32,address,uint8,uint256)"));
const locks = fixture.logs
  .filter((log) => log.topics[0] === SALT_LOCKED)
  .map((log) => {
    const [, salt, tokenAddress, launchKind] = decodeAbiParameters(
      parseAbiParameters("address locker, bytes32 salt, address tokenAddress, uint8 launchKind, uint256 ts"),
      log.data,
    );
    return { salt, tokenAddress, launchKind };
  });

describe("token address prediction", () => {
  it("matches every address the live Portal reserved for a salt", () => {
    expect(locks.length).toBeGreaterThan(10);
    for (const lock of locks) {
      expect(predictToken(PORTAL, TOKEN_IMPLEMENTATION, lock.salt).toLowerCase()).toBe(lock.tokenAddress.toLowerCase());
    }
  });

  it("finds a salt whose token address ends in 7777", async () => {
    const { salt, token } = await findVanitySalt(PORTAL, TOKEN_IMPLEMENTATION);
    expect(token.toLowerCase().endsWith("7777")).toBe(true);
    expect(predictToken(PORTAL, TOKEN_IMPLEMENTATION, salt)).toBe(token);
  }, 120_000);
});
