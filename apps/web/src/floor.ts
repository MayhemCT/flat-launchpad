/**
 * The Pool Launch Portal rejects a launch whose pool holds too little BNB for its share of the supply
 * (LaunchLiquidityTooLow). A mint whose cap is under that floor can never launch, so the page reads the
 * floor from the Portal before a creator commits to a cap, and checks every mint against it.
 *
 * Reads: https://docs.flap.sh/en/flap/v2/developers/pool-launch/build-an-indexer#graduation-preview-graduationfloorv2
 */
import { parseAbi, zeroAddress, type Address } from "viem";
import { FACTORY, PORTAL } from "./config";
import { publicClient } from "./host";

/** CallZLauncher.TOTAL_SUPPLY. */
const TOTAL_SUPPLY = 10n ** 27n;
/** LaunchKind.DIRECT_V2_POOL_TAX. */
const LAUNCH_KIND = 0;
const WAD = 10n ** 18n;

const floorAbi = parseAbi([
  "struct GraduationFloorParams { address quoteToken; uint256 quotePriceUsd; uint256 poolQuote; uint256 poolToken; uint256 totalSupply; address vaultFactory; }",
  "struct GraduationFloorResultV2 { bool meetsFloor; uint256 floorUsdWad; uint256 quoteUsdWad; uint16 multiplierBps; bool meetsCreateFloor; uint256 createFloorUsdWad; }",
  "function graduationFloorV2(GraduationFloorParams params) view returns (GraduationFloorResultV2)",
  "function graduationFloorV2ForLauncher(GraduationFloorParams params, address launcher) view returns (GraduationFloorResultV2)",
  "function launchQuoteConfig(uint8 kind, address quoteToken) view returns (bool enabled, uint256 quotePriceUsd)",
  "function launcherFactoryMultiplier(address factory) view returns (bool enabled, uint16 multiplierBps)",
]);

const launcherAbi = parseAbi(["function cap() view returns (uint256)", "function poolToken() view returns (uint256)"]);

/** USD (18 decimals) to wei of BNB at the Portal's price, rounded up so the result always clears the floor. */
function usdToWei(usdWad: bigint, priceUsdWad: bigint): bigint {
  return (usdWad * WAD + priceUsdWad - 1n) / priceUsdWad;
}

async function bnbPriceUsd(): Promise<bigint> {
  const [enabled, price] = await publicClient.readContract({
    address: PORTAL,
    abi: floorAbi,
    functionName: "launchQuoteConfig",
    args: [LAUNCH_KIND, zeroAddress],
  });
  if (!enabled || price === 0n) throw new Error("native quote is not enabled on the Portal");
  return price;
}

export interface FloorGuide {
  /** The Portal's BNB price, USD with 18 decimals. */
  priceUsdWad: bigint;
  /** This factory's floor multiplier in bps; 10000 means no reduction. */
  multiplierBps: number;
  rows: Array<{ poolShareBps: number; minRaiseWei: bigint }>;
}

/** The smallest cap that can launch, for each pool share, at the Portal's current price and this factory's multiplier. */
export async function readFloorGuide(poolSharesBps: readonly number[]): Promise<FloorGuide> {
  const [priceUsdWad, [enabled, bps]] = await Promise.all([
    bnbPriceUsd(),
    publicClient.readContract({ address: PORTAL, abi: floorAbi, functionName: "launcherFactoryMultiplier", args: [FACTORY] }),
  ]);
  // A factory Flap has not configured launches at the full floor.
  const multiplierBps = enabled ? bps : 10_000;

  const floors = await publicClient.multicall({
    allowFailure: false,
    contracts: poolSharesBps.map((share) => ({
      address: PORTAL,
      abi: floorAbi,
      functionName: "graduationFloorV2" as const,
      args: [
        {
          quoteToken: zeroAddress,
          quotePriceUsd: priceUsdWad,
          poolQuote: 1n,
          poolToken: (TOTAL_SUPPLY * BigInt(share)) / 10_000n,
          totalSupply: TOTAL_SUPPLY,
          vaultFactory: zeroAddress,
        },
      ] as const,
    })),
  });

  return {
    priceUsdWad,
    multiplierBps,
    rows: poolSharesBps.map((poolShareBps, index) => ({
      poolShareBps,
      // graduationFloorV2 knows nothing of the Launcher factory, so its multiplier is applied here.
      minRaiseWei: usdToWei((floors[index]!.createFloorUsdWad * BigInt(multiplierBps)) / 10_000n, priceUsdWad),
    })),
  };
}

export interface Launchability {
  /** Whether the Portal would accept this mint's launch at its cap. */
  canLaunch: boolean;
  capWei: bigint;
  floorWei: bigint;
}

/** Asks the Portal whether `launcher`, once its cap is raised, clears the creation floor. */
export async function readLaunchability(launcher: Address): Promise<Launchability> {
  const [priceUsdWad, [capWei, poolToken]] = await Promise.all([
    bnbPriceUsd(),
    publicClient.multicall({
      allowFailure: false,
      contracts: [
        { address: launcher, abi: launcherAbi, functionName: "cap" },
        { address: launcher, abi: launcherAbi, functionName: "poolToken" },
      ],
    }),
  ]);
  const result = await publicClient.readContract({
    address: PORTAL,
    abi: floorAbi,
    functionName: "graduationFloorV2ForLauncher",
    args: [
      {
        quoteToken: zeroAddress,
        quotePriceUsd: priceUsdWad,
        poolQuote: capWei,
        poolToken,
        totalSupply: TOTAL_SUPPLY,
        vaultFactory: zeroAddress,
      },
      launcher,
    ],
  });
  return { canLaunch: result.meetsCreateFloor, capWei, floorWei: usdToWei(result.createFloorUsdWad, priceUsdWad) };
}

/** BNB with four decimals, rounded up, so a displayed minimum is never below the real one. */
export function formatMinimum(wei: bigint): string {
  const unit = 10n ** 14n;
  const rounded = (wei + unit - 1n) / unit;
  return `${rounded / 10_000n}.${(rounded % 10_000n).toString().padStart(4, "0")}`;
}
