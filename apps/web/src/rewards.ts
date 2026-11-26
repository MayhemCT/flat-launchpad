/**
 * The CallZ vault from the visitor's side: what a token's fees have collected, staking for the holder share,
 * recording a verified callout, and claiming.
 *
 * The vault (contracts/src/callz/CallZVault.sol) receives every CallZ fee in BNB and books it per token:
 * 35% streams to the token's stakers, 10% is shared between holders whose callouts were verified that round,
 * 30% is the callout reward pool of the round, and 25% is the platform's, sent to the team wallet as it arrives.
 * A round is one UTC day. Its 10% and 30% can be claimed during the 24 hours after it ends; what is not claimed
 * by then goes to the team wallet. One `claim` collects everything a token owes a wallet.
 *
 * Nothing here holds a key. Every transaction is simulated first, so one the chain would reject never reaches
 * the wallet, and is then signed by the visitor's own wallet.
 */
import { BaseError, ContractFunctionRevertedError, parseAbi, type Abi, type Address, type Hex } from "viem";
import { bsc } from "viem/chains";
import deployment from "./callz-deployment.json";
import { TradeError, client, explain, settle, wallet, withHeadroom } from "./trade";

export const VAULT = deployment.vault.address as Address;
/** The wallet that signs verified callouts at launch. The vault's guardian can replace it: `loadRewards` reads the one in force. */
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
  "struct Submission { address holder; address token; uint256 epoch; uint8 kind; bytes32 linkHash; bytes32 profileHash; uint256 nonce; uint256 deadline; }",
  "function attester() view returns (address)",
  "function teamWallet() view returns (address)",
  "function holdersBps() view returns (uint16)",
  "function unlockedBps() view returns (uint16)",
  "function calloutBps() view returns (uint16)",
  "function platformBps() view returns (uint16)",
  "function requiredLinks() view returns (uint8)",
  "function maxLinksPerEpoch() view returns (uint8)",
  "function minHoldPpm() view returns (uint32)",
  "function usedLink(bytes32 linkHash) view returns (bool)",
  "function staked(address token, address holder) view returns (uint256)",
  "function earned(address token, address holder) view returns (uint256)",
  "function holdingOf(address token, address holder) view returns (uint256)",
  "function streamOf(address token) view returns (uint256 totalStaked, uint256 rate, uint256 periodFinish, uint256 queued)",
  "function roundOf(address token, uint256 epoch) view returns (uint256 pot10, uint256 pool30, uint256 claimedPot, uint256 claimedPool, uint256 totalWeight, uint256 links, uint256 deadline, bool swept)",
  "function progress(address token, uint256 epoch, address holder) view returns (uint256 links, bool unlocked, uint256 weight, bool claimedUnlocked, bool claimedCallout, uint256 unlockedPayout, uint256 calloutPayout)",
  "function stake(address token, uint256 amount)",
  "function unstake(address token, uint256 amount)",
  "function claim(address token, uint256[] epochs) returns (uint256 total)",
  "function submitAttested(Submission s, string link, bytes signature)",
  "error ZeroAmount()",
  "error InsufficientStake()",
  "error WrongEpoch()",
  "error Expired()",
  "error InvalidKind()",
  "error LinkTooLong()",
  "error LinkMismatch()",
  "error LinkUsed()",
  "error BadSignature()",
  "error TooManyLinks()",
  "error BelowMinHold()",
  "error NothingToClaim()",
  "error BnbTransferFailed()",
]);
const tokenAbi = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

/** Why the vault refuses something, in words for the person asking. */
const REFUSALS: Record<string, [title: string, text: string]> = {
  ZeroAmount: ["Nothing to move", "The amount is zero."],
  InsufficientStake: ["Not that much staked", "You have less staked than you are taking out."],
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

export type RewardStep = "approving" | "checking" | "confirm" | "pending";

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
export function recordCallout(account: Address, submission: Submission, link: string, signature: Hex, onStep?: (step: "checking" | "confirm" | "pending") => void): Promise<Hex> {
  return send(account, { address: VAULT, abi: vaultAbi, functionName: "submitAttested", args: [submission, link, signature] }, (step) => step !== "approving" && onStep?.(step));
}

// ─────────────────────────────────────────────────────────────────────────────
// The rewards of one token
// ─────────────────────────────────────────────────────────────────────────────

/** The round that ended last: the only one whose callout rewards can still be claimed. */
export interface FinishedRound {
  epoch: number;
  /** BNB the callout-unlocked holder share would pay this wallet now. */
  unlockedPayout: bigint;
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
  split: { holdersBps: number; unlockedBps: number; calloutBps: number; platformBps: number };
  rules: { requiredLinks: number; maxLinksPerEpoch: number; minHoldPpm: number };
  /** The running round of this token. */
  round: { pot10: bigint; pool30: bigint; links: number; totalWeight: bigint };
  /** The holder stream of this token: BNB per second reaching stakers, when it ends, and BNB waiting to join it. */
  stream: { totalStaked: bigint; rate: bigint; periodFinish: number; queued: bigint };
  /** The connected wallet. Null when none is connected. */
  mine: {
    wallet: bigint;
    staked: bigint;
    earned: bigint;
    allowance: bigint;
    /** Callouts counted for this wallet in the running round, and whether the 10% share is unlocked. */
    links: number;
    unlocked: boolean;
    /** What the round that just ended still owes this wallet. Null when it owes nothing. */
    finished: FinishedRound | null;
  } | null;
}

const EMPTY: Omit<Rewards, "epoch" | "epochEnds"> = {
  deployed: false,
  split: { holdersBps: 3500, unlockedBps: 1000, calloutBps: 3000, platformBps: 2500 },
  rules: { requiredLinks: 1, maxLinksPerEpoch: 3, minHoldPpm: 100 },
  round: { pot10: 0n, pool30: 0n, links: 0, totalWeight: 0n },
  stream: { totalStaked: 0n, rate: 0n, periodFinish: 0, queued: 0n },
  mine: null,
};

/** Everything the rewards panel of a token shows, in two requests. */
export async function loadRewards(token: Address, account: Address | null): Promise<Rewards> {
  const [code, block] = await Promise.all([client.getCode({ address: VAULT }), client.getBlock({ blockTag: "latest" })]);
  // The chain's clock decides the round, not the device's.
  const epoch = currentEpoch(Number(block.timestamp));
  if (!code || code === "0x") return { ...EMPTY, epoch, epochEnds: epochEnd(epoch) };

  const at = { address: VAULT, abi: vaultAbi } as const;
  const [holdersBps, unlockedBps, calloutBps, platformBps, requiredLinks, maxLinksPerEpoch, minHoldPpm, round, stream] = await client.multicall({
    allowFailure: false,
    contracts: [
      { ...at, functionName: "holdersBps" },
      { ...at, functionName: "unlockedBps" },
      { ...at, functionName: "calloutBps" },
      { ...at, functionName: "platformBps" },
      { ...at, functionName: "requiredLinks" },
      { ...at, functionName: "maxLinksPerEpoch" },
      { ...at, functionName: "minHoldPpm" },
      { ...at, functionName: "roundOf", args: [token, BigInt(epoch)] },
      { ...at, functionName: "streamOf", args: [token] },
    ],
  });

  let mine: Rewards["mine"] = null;
  if (account) {
    // Only the round that ended last can still be claimed: its window is the day that is running now.
    const last = epoch - 1;
    const [walletBalance, staked, earned, allowance, now, before] = await client.multicall({
      allowFailure: false,
      contracts: [
        { address: token, abi: tokenAbi, functionName: "balanceOf", args: [account] },
        { ...at, functionName: "staked", args: [token, account] },
        { ...at, functionName: "earned", args: [token, account] },
        { address: token, abi: tokenAbi, functionName: "allowance", args: [account, VAULT] },
        { ...at, functionName: "progress", args: [token, BigInt(epoch), account] },
        { ...at, functionName: "progress", args: [token, BigInt(last), account] },
      ],
    });
    const finished = before[5] > 0n || before[6] > 0n ? { epoch: last, unlockedPayout: before[5], calloutPayout: before[6], deadline: epochEnd(last) + CLAIM_WINDOW_SECONDS } : null;
    mine = { wallet: walletBalance, staked, earned, allowance, links: Number(now[0]), unlocked: now[1], finished };
  }

  return {
    deployed: true,
    epoch,
    epochEnds: epochEnd(epoch),
    split: { holdersBps, unlockedBps, calloutBps, platformBps },
    rules: { requiredLinks, maxLinksPerEpoch, minHoldPpm },
    round: { pot10: round[0], pool30: round[1], links: Number(round[5]), totalWeight: round[4] },
    stream: { totalStaked: stream[0], rate: stream[1], periodFinish: Number(stream[2]), queued: stream[3] },
    mine,
  };
}

/** Stakes `amount` of `token` in the vault. Approves the vault for exactly that amount when it is not already allowed. */
export async function stake(account: Address, token: Address, amount: bigint, onStep?: (step: RewardStep, hash?: Hex) => void): Promise<Hex> {
  try {
    const allowance = await client.readContract({ address: token, abi: tokenAbi, functionName: "allowance", args: [account, VAULT] });
    if (allowance < amount) {
      onStep?.("approving");
      const { request } = await client.simulateContract({ account, address: token, abi: tokenAbi, functionName: "approve", args: [VAULT, amount] });
      const approval = await wallet().writeContract(request);
      const receipt = await client.waitForTransactionReceipt({ hash: approval, timeout: 120_000 });
      if (receipt.status !== "success") throw new TradeError("REVERTED", "Approval reverted", "The token rejected the approval. Only the network fee was spent.", approval);
    }
  } catch (error) {
    throw explainVault(error, false);
  }
  return send(account, { address: VAULT, abi: vaultAbi, functionName: "stake", args: [token, amount] }, onStep);
}

export function unstake(account: Address, token: Address, amount: bigint, onStep?: (step: RewardStep, hash?: Hex) => void): Promise<Hex> {
  return send(account, { address: VAULT, abi: vaultAbi, functionName: "unstake", args: [token, amount] }, onStep);
}

/**
 * Collects everything `token` owes the wallet in one transaction: what its stake has earned, and the callout
 * rewards and holder share of the listed finished rounds.
 */
export function claim(account: Address, token: Address, epochs: number[], onStep?: (step: RewardStep, hash?: Hex) => void): Promise<Hex> {
  return send(account, { address: VAULT, abi: vaultAbi, functionName: "claim", args: [token, epochs.map(BigInt)] }, onStep);
}
