/**
 * The CallZ vault from the visitor's side: what a token's fees have collected for its callers, recording a
 * verified callout, and claiming.
 *
 * The vault (contracts/src/callz/CallZVault.sol) receives every CallZ fee in BNB and books it per token:
 * 45% is the round's holder share, 30% its callout pool, and 25% is the platform's, sent to the team wallet as
 * it arrives. Nothing is staked: tokens stay in the holder's wallet, and the vault reads the wallet's balance
 * when their callout is recorded (the snapshot). A caller's weight in the holder share is that snapshot divided
 * by the market cap they called at, and they earn from the fees that arrive after their callout.
 *
 * A round is one UTC day. Its rewards can be claimed during the 24 hours after it ends; what is not claimed by
 * then goes to the team wallet. One `claim` collects everything a token owes a wallet.
 *
 * Nothing here holds a key. Every transaction is simulated first, so one the chain would reject never reaches
 * the wallet, and is then signed by the visitor's own wallet.
 */
import { BaseError, ContractFunctionRevertedError, parseAbi, type Abi, type Address, type Hex } from "viem";
import { bsc } from "viem/chains";
import deployment from "./callz-deployment.json";
import { TradeError, client, explain, settle, wallet, withHeadroom } from "./trade";

export const VAULT = deployment.vault.address as Address;
/** The wallet that signs verified callouts at launch. The vault's guardian can replace it. */
export const ATTESTER = deployment.team as Address;
export const EPOCH_SECONDS = 86_400;
/** How long a round's rewards stay claimable after it ends. */
export const CLAIM_WINDOW_SECONDS = 86_400;

/** The running round: one per UTC day. */
export function currentEpoch(now: number = Date.now() / 1000): number {
  return Math.floor(now / EPOCH_SECONDS);
}

/** When a round ends, in unix seconds. */
export function epochEnd(epoch: number): number {
  return (epoch + 1) * EPOCH_SECONDS;
}

export const vaultAbi = parseAbi([
  "struct Submission { address holder; address token; uint256 epoch; uint8 kind; bytes32 linkHash; bytes32 profileHash; uint256 mcap; uint256 held; uint256 nonce; uint256 deadline; }",
  "function attester() view returns (address)",
  "function teamWallet() view returns (address)",
  "function holdersBps() view returns (uint16)",
  "function calloutBps() view returns (uint16)",
  "function platformBps() view returns (uint16)",
  "function requiredLinks() view returns (uint8)",
  "function maxLinksPerEpoch() view returns (uint8)",
  "function minHoldPpm() view returns (uint32)",
  "function usedLink(bytes32 linkHash) view returns (bool)",
  "function holdingOf(address token, address holder) view returns (uint256)",
  "function roundOf(address token, uint256 epoch) view returns (uint256 holderShare, uint256 calloutPool, uint256 claimedHolderShare, uint256 claimedCalloutPool, uint256 totalWeight, uint256 links, uint256 deadline, bool swept)",
  "function progress(address token, uint256 epoch, address holder) view returns (uint256 links, bool inHolderShare, uint256 snapshot, bool claimedHolder, bool claimedCallout, uint256 holderPayout, uint256 calloutPayout)",
  "function claim(address token, uint256[] epochs) returns (uint256 total)",
  "function claimMany(address[] tokens, uint256[] epochs) returns (uint256 total)",
  "function submitAttested(Submission s, string link, bytes signature)",
  "error WrongEpoch()",
  "error Expired()",
  "error InvalidKind()",
  "error ZeroMarketCap()",
  "error LinkTooLong()",
  "error LinkMismatch()",
  "error LinkUsed()",
  "error BadSignature()",
  "error TooManyLinks()",
  "error BelowMinHold()",
  "error NothingToClaim()",
  "error BnbTransferFailed()",
  "error Insolvent()",
]);
const tokenAbi = parseAbi(["function balanceOf(address account) view returns (uint256)"]);

/** Why the vault refuses something, in words for the person asking. */
const REFUSALS: Record<string, [title: string, text: string]> = {
  WrongEpoch: ["Approval expired", "This callout was approved for a round that has ended. It has to be approved again for the running round."],
  Expired: ["Approval expired", "This approval has passed its deadline. It has to be approved again."],
  LinkUsed: ["Already counted", "This link has already been counted. Each link counts once."],
  LinkMismatch: ["Link does not match", "The link is not the one that was approved."],
  BadSignature: ["Not approved", "The approval was not signed by the vault's reviewer, so it cannot be counted."],
  TooManyLinks: ["Round limit reached", "You have already counted the most callouts one holder can in a round. Try again next round."],
  BelowMinHold: ["Hold the token first", "Callouts count for holders. Your wallet holds less than the minimum of this token."],
  NothingToClaim: ["Nothing to claim", "There is nothing to claim here: it was already claimed, or the 24 hours to claim it have passed."],
  BnbTransferFailed: ["Payment refused", "Your wallet did not accept the BNB."],
};

function explainVault(error: unknown, sent: boolean, hash?: Hex): TradeError {
  if (error instanceof TradeError) return error;
  if (error instanceof BaseError) {
    const reverted = error.walk((cause) => cause instanceof ContractFunctionRevertedError);
    const name = reverted instanceof ContractFunctionRevertedError ? reverted.data?.errorName : undefined;
    const refusal = name ? REFUSALS[name] : undefined;
    if (refusal) return new TradeError("POOL_REJECTED", refusal[0], `${refusal[1]} Nothing was sent.`);
  }
  return explain(error, sent, hash);
}

export type RewardStep = "checking" | "confirm" | "pending";

interface Call {
  address: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
}

/** Simulates, then sends with gas to spare, then follows the transaction to a definite outcome. */
async function send(account: Address, call: Call, onStep?: (step: RewardStep, hash?: Hex) => void): Promise<Hex> {
  let hash: Hex | undefined;
  try {
    const signer = wallet();
    onStep?.("checking");
    await client.simulateContract({ account, ...call });
    const gas = await client.estimateContractGas({ account, ...call });
    onStep?.("confirm");
    hash = await signer.writeContract({ account, chain: bsc, ...call, gas: withHeadroom(gas) });
    onStep?.("pending", hash);
    return await settle(hash);
  } catch (error) {
    throw explainVault(error, hash !== undefined, hash);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Callouts
// ─────────────────────────────────────────────────────────────────────────────

/** A verified callout, as the reviewer signs it and the vault checks it. */
export interface Submission {
  holder: Address;
  token: Address;
  epoch: bigint;
  /** 0 X, 1 pump.fun, 2 fomo.family, 3 callz.fun. */
  kind: number;
  linkHash: Hex;
  profileHash: Hex;
  /** The token's market cap in whole US dollars when the callout was posted. */
  mcap: bigint;
  /** What the holder's wallet held of the token when the callout was posted, in the token's base units. */
  held: bigint;
  nonce: bigint;
  deadline: bigint;
}

/** The EIP-712 typed data of a submission: pass it to the wallet's `signTypedData`. Keep in step with CallZVault.sol and apps/worker/src/callouts.ts. */
export function submissionTypedData(message: Submission) {
  return {
    domain: { name: "CallZ Vault", version: "1", chainId: bsc.id, verifyingContract: VAULT },
    types: {
      Submission: [
        { name: "holder", type: "address" },
        { name: "token", type: "address" },
        { name: "epoch", type: "uint256" },
        { name: "kind", type: "uint8" },
        { name: "linkHash", type: "bytes32" },
        { name: "profileHash", type: "bytes32" },
        { name: "mcap", type: "uint256" },
        { name: "held", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Submission",
    message,
  } as const;
}

/** Which of these links the vault has already counted. All false while the vault is not deployed. */
export async function recordedLinks(linkHashes: Hex[]): Promise<boolean[]> {
  if (linkHashes.length === 0) return [];
  const results = await client.multicall({
    allowFailure: true,
    contracts: linkHashes.map((hash) => ({ address: VAULT, abi: vaultAbi, functionName: "usedLink" as const, args: [hash] as const })),
  });
  return results.map((result) => result.status === "success" && result.result === true);
}

/** Records an approved callout in the vault, from the holder's wallet. Resolves with the transaction hash once it has confirmed. */
export function recordCallout(account: Address, submission: Submission, link: string, signature: Hex, onStep?: (step: RewardStep) => void): Promise<Hex> {
  return send(account, { address: VAULT, abi: vaultAbi, functionName: "submitAttested", args: [submission, link, signature] }, onStep);
}

// ─────────────────────────────────────────────────────────────────────────────
// The rewards of one token
// ─────────────────────────────────────────────────────────────────────────────

/** The round that ended last: the only one whose rewards can still be claimed. */
export interface FinishedRound {
  epoch: number;
  /** BNB the holder share would pay this wallet now. */
  holderPayout: bigint;
  /** BNB the callout pool would pay this wallet now. */
  calloutPayout: bigint;
  /** Unix seconds the claim closes: 24 hours after the round ended. After that the rewards go to the team wallet. */
  deadline: number;
}

export interface Rewards {
  /** False while the vault is not on BNB Chain yet. Everything else is then zero. */
  deployed: boolean;
  epoch: number;
  /** Unix seconds the running round ends. */
  epochEnds: number;
  split: { holdersBps: number; calloutBps: number; platformBps: number };
  rules: { requiredLinks: number; maxLinksPerEpoch: number; minHoldPpm: number };
  /** The running round of this token. */
  round: { holderShare: bigint; calloutPool: bigint; links: number };
  /** The connected wallet. Null when none is connected. */
  mine: {
    /** Tokens in the wallet now. */
    holding: bigint;
    /** Callouts counted for this wallet in the running round. */
    links: number;
    /** Tokens the vault recorded for this wallet when its callout was counted this round. Null before that. */
    snapshot: bigint | null;
    /** What the round that just ended still owes this wallet. Null when it owes nothing. */
    finished: FinishedRound | null;
  } | null;
}

const EMPTY: Omit<Rewards, "epoch" | "epochEnds"> = {
  deployed: false,
  split: { holdersBps: 4500, calloutBps: 3000, platformBps: 2500 },
  rules: { requiredLinks: 1, maxLinksPerEpoch: 3, minHoldPpm: 100 },
  round: { holderShare: 0n, calloutPool: 0n, links: 0 },
  mine: null,
};

/** Everything the rewards panel of a token shows, in two requests. */
export async function loadRewards(token: Address, account: Address | null): Promise<Rewards> {
  const [code, block] = await Promise.all([client.getCode({ address: VAULT }), client.getBlock({ blockTag: "latest" })]);
  // The chain's clock decides the round, not the device's.
  const epoch = currentEpoch(Number(block.timestamp));
  if (!code || code === "0x") return { ...EMPTY, epoch, epochEnds: epochEnd(epoch) };

  const at = { address: VAULT, abi: vaultAbi } as const;
  const holder = account ?? "0x0000000000000000000000000000000000000000";
  // Only the round that ended last can still be claimed: its window is the day that is running now.
  const last = epoch - 1;
  const [holdersBps, calloutBps, platformBps, requiredLinks, maxLinksPerEpoch, minHoldPpm, round, holding, now, before] = await client.multicall({
    allowFailure: false,
    contracts: [
      { ...at, functionName: "holdersBps" },
      { ...at, functionName: "calloutBps" },
      { ...at, functionName: "platformBps" },
      { ...at, functionName: "requiredLinks" },
      { ...at, functionName: "maxLinksPerEpoch" },
      { ...at, functionName: "minHoldPpm" },
      { ...at, functionName: "roundOf", args: [token, BigInt(epoch)] },
      { address: token, abi: tokenAbi, functionName: "balanceOf", args: [holder] },
      { ...at, functionName: "progress", args: [token, BigInt(epoch), holder] },
      { ...at, functionName: "progress", args: [token, BigInt(last), holder] },
    ],
  });

  const finished = before[5] > 0n || before[6] > 0n ? { epoch: last, holderPayout: before[5], calloutPayout: before[6], deadline: epochEnd(last) + CLAIM_WINDOW_SECONDS } : null;
  return {
    deployed: true,
    epoch,
    epochEnds: epochEnd(epoch),
    split: { holdersBps, calloutBps, platformBps },
    rules: { requiredLinks, maxLinksPerEpoch, minHoldPpm },
    round: { holderShare: round[0], calloutPool: round[1], links: Number(round[5]) },
    mine: account ? { holding, links: Number(now[0]), snapshot: now[1] ? now[2] : null, finished } : null,
  };
}

/** Collects everything `token` owes the wallet for the listed finished rounds, in one transaction. */
export function claim(account: Address, token: Address, epochs: number[], onStep?: (step: RewardStep, hash?: Hex) => void): Promise<Hex> {
  return send(account, { address: VAULT, abi: vaultAbi, functionName: "claim", args: [token, epochs.map(BigInt)] }, onStep);
}

// ─────────────────────────────────────────────────────────────────────────────
// A wallet's rewards across tokens: the wallet menu
// ─────────────────────────────────────────────────────────────────────────────

export interface WalletReward {
  token: Address;
  symbol: string;
  /** BNB this token owes the wallet for the round that just ended. */
  amount: bigint;
}

export interface WalletRewards {
  /** The round the amounts are for, and when its claim closes (unix seconds). */
  epoch: number;
  deadline: number;
  rewards: WalletReward[];
  total: bigint;
}

const symbolAbi = parseAbi(["function symbol() view returns (string)"]);

/**
 * What the vault owes `account` right now, across the tokens it has verified callouts on (the API knows which).
 * Only the round that just ended can be claimed. Empty while the vault is not deployed.
 */
export async function loadWalletRewards(account: Address): Promise<WalletRewards> {
  const [code, block, listed] = await Promise.all([
    client.getCode({ address: VAULT }),
    client.getBlock({ blockTag: "latest" }),
    fetch(`/api/callouts/bsc/author/${account.toLowerCase()}`)
      .then((response) => (response.ok ? (response.json() as Promise<{ tokens?: unknown }>) : { tokens: [] }))
      .catch(() => ({ tokens: [] })),
  ]);
  const epoch = currentEpoch(Number(block.timestamp)) - 1;
  const empty: WalletRewards = { epoch, deadline: epochEnd(epoch) + CLAIM_WINDOW_SECONDS, rewards: [], total: 0n };
  const tokens = (Array.isArray(listed.tokens) ? listed.tokens : []).filter((token): token is Address => typeof token === "string" && /^0x[0-9a-fA-F]{40}$/.test(token)).slice(0, 50);
  if (!code || code === "0x" || tokens.length === 0) return empty;

  const [progress, symbols] = await Promise.all([
    client.multicall({ allowFailure: true, contracts: tokens.map((token) => ({ address: VAULT, abi: vaultAbi, functionName: "progress" as const, args: [token, BigInt(epoch), account] as const })) }),
    client.multicall({ allowFailure: true, contracts: tokens.map((token) => ({ address: token, abi: symbolAbi, functionName: "symbol" as const })) }),
  ]);
  const rewards = tokens.flatMap((token, index): WalletReward[] => {
    const result = progress[index];
    if (result?.status !== "success") return [];
    const owed = result.result[5] + result.result[6];
    const symbol = symbols[index]?.status === "success" ? String(symbols[index]!.result) : `${token.slice(0, 6)}…`;
    return owed > 0n ? [{ token, symbol, amount: owed }] : [];
  });
  return { ...empty, rewards, total: rewards.reduce((sum, reward) => sum + reward.amount, 0n) };
}

/** Collects the rewards of the round that just ended on every listed token, in one transaction. */
export function claimMany(account: Address, tokens: Address[], epoch: number, onStep?: (step: RewardStep, hash?: Hex) => void): Promise<Hex> {
  return send(account, { address: VAULT, abi: vaultAbi, functionName: "claimMany", args: [tokens, [BigInt(epoch)]] }, onStep);
}
