/**
 * A host for Flap Launcher UI packages (launcher-config-preview/v1).
 *
 * Flap's site runs a Launcher UI package inside its own host: the host reads the contract, owns the wallet and
 * sends every transaction, and the package only renders and asks. This file implements that same host contract
 * against the chain directly, so the exact package in flap-ui/raidpass-launcher runs here unchanged.
 *
 * Contract: https://github.com/flap-sh/flap-vault-component-template (branch test/pool-launch-developer-preview),
 * examples/launcher-runtime/README.md.
 */
import {
  BaseError,
  ContractFunctionRevertedError,
  UserRejectedRequestError,
  createPublicClient,
  decodeEventLog,
  encodeAbiParameters,
  http,
  isAddress,
  zeroAddress,
  type Abi,
  type AbiParameter,
  type Address,
  type Hex,
} from "viem";
import manifest from "@launcher-ui/manifest.json";
import { FACTORY, NETWORK, PORTAL, TOKEN_IMPLEMENTATION, portalAbi } from "./config";
import { findVanitySalt } from "./salt";
import { connect, getWallet, setPendingHash, switchChain, walletClient } from "./wallet";

export const publicClient = createPublicClient({ chain: NETWORK.chain, transport: http(NETWORK.rpcUrl) });

type ReadKind = "address" | "bool" | "uint256";
interface ReadDeclaration {
  functionName: string;
  returns: ReadKind;
  account?: boolean;
}
const reads = manifest.reads as Record<string, ReadDeclaration>;
const actions = manifest.transactions.actions as Record<string, "payable" | "nonpayable">;

export type Snapshot = Record<string, string | boolean | null>;
export interface Submission {
  status: "success" | "pending" | "reverted" | "unverified";
  hash: string;
  launcherAddress?: string;
}

function readAbi(read: ReadDeclaration): Abi {
  return [
    {
      type: "function",
      name: read.functionName,
      stateMutability: "view",
      inputs: read.account ? [{ name: "account", type: "address" }] : [],
      outputs: [{ name: "", type: read.returns }],
    },
  ];
}

/** Whether the Portal recorded `launcher` as created by this package's factory. */
export async function belongsToFactory(launcher: Address): Promise<boolean> {
  const record = await publicClient.readContract({
    address: PORTAL,
    abi: portalAbi,
    functionName: "getLauncher",
    args: [launcher],
  });
  return record.launcherFactory.toLowerCase() === FACTORY.toLowerCase();
}

/**
 * The values the manifest declares, in the shapes the host contract specifies: uint256 as a decimal string,
 * bool as a boolean, address as a lowercase string. A failing read or a zero address is null, and account
 * reads are null while no wallet is connected.
 */
export async function readSnapshot(launcher: Address, account: Address | null): Promise<Snapshot> {
  const entries = Object.entries(reads);
  const callable = entries.filter(([, read]) => !read.account || account !== null);
  const results = await publicClient.multicall({
    allowFailure: true,
    contracts: callable.map(([, read]) => ({
      address: launcher,
      abi: readAbi(read),
      functionName: read.functionName,
      args: read.account ? [account as Address] : [],
    })),
  });

  const snapshot: Snapshot = {};
  for (const [key] of entries) snapshot[key] = null;
  callable.forEach(([key, read], index) => {
    const result = results[index];
    if (!result || result.status !== "success") return;
    const value = result.result as unknown;
    if (read.returns === "uint256" && typeof value === "bigint") snapshot[key] = value.toString();
    else if (read.returns === "bool" && typeof value === "boolean") snapshot[key] = value;
    else if (read.returns === "address" && typeof value === "string" && value !== zeroAddress) {
      snapshot[key] = value.toLowerCase();
    }
  });
  return snapshot;
}

/** Maps a failure to the error codes Launcher UI packages translate. */
function hostError(cause: unknown, fallback: string): Error {
  if (cause instanceof Error && /^[a-zA-Z]+$/.test(cause.message)) return cause;
  if (cause instanceof BaseError) {
    if (cause.walk((error) => error instanceof UserRejectedRequestError)) return new Error("walletRejected");
    if (cause.walk((error) => error instanceof ContractFunctionRevertedError)) return new Error("simulationFailed");
  }
  return new Error(fallback);
}

function requireSigner(): { account: Address } {
  const wallet = getWallet();
  if (!wallet.available) throw new Error("walletUnavailable");
  if (!wallet.account) throw new Error("connectWallet");
  if (wallet.chainId !== NETWORK.chain.id) throw new Error("wrongChain");
  return { account: wallet.account };
}

async function settle(hash: Hex): Promise<Submission> {
  try {
    const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 2, timeout: 60_000 });
    setPendingHash(null);
    if (receipt.status !== "success") return { status: "reverted", hash };

    // A creation's receipt names the new Launcher in the Portal's event.
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== PORTAL.toLowerCase()) continue;
      try {
        const event = decodeEventLog({ abi: portalAbi, data: log.data, topics: log.topics });
        if (event.eventName === "FlapNewLauncherCreated" && event.args.launcherFactory.toLowerCase() === FACTORY.toLowerCase()) {
          return { status: "success", hash, launcherAddress: event.args.launcher.toLowerCase() };
        }
      } catch {
        // Another Portal event.
      }
    }
    return { status: "success", hash };
  } catch {
    // No receipt inside the wait: the transaction may still land.
    return { status: "pending", hash };
  }
}

export interface HostOptions {
  /** The Launcher the detail page shows; null on the creation page. */
  launcher: Address | null;
  refresh(): void;
  openLauncher(address: string): void;
}

/** The `host` object a Launcher UI package receives. */
export function createHost(options: HostOptions) {
  const wallet = getWallet();
  return {
    available: wallet.available,
    wallet: {
      account: wallet.account,
      chainId: wallet.chainId,
      pendingHash: wallet.pendingHash,
      connect,
      switchChain,
    },

    /** The creation fee: the Portal's salt-lock fee, in wei. */
    async quote(): Promise<string | null> {
      try {
        const fee = await publicClient.readContract({ address: PORTAL, abi: portalAbi, functionName: "SALT_LOCK_FEE" });
        return fee.toString();
      } catch {
        return null;
      }
    },

    encode(parameters: readonly AbiParameter[], values: readonly unknown[]): string {
      return encodeAbiParameters(parameters, values);
    },

    async findSalt(): Promise<string> {
      try {
        return (await findVanitySalt(PORTAL, TOKEN_IMPLEMENTATION)).salt;
      } catch {
        throw new Error("saltUnavailable");
      }
    },

    async submit(
      input:
        | { kind: "create"; configuration: string; valueWei: string }
        | { kind: "action"; action: string; valueWei?: string },
    ): Promise<Submission> {
      const { account } = requireSigner();
      const client = walletClient();
      if (!client) throw new Error("walletUnavailable");
      if (getWallet().pendingHash) throw new Error("walletBusy");

      let hash: Hex;
      try {
        if (input.kind === "create") {
          const value = BigInt(input.valueWei);
          const fee = await publicClient.readContract({ address: PORTAL, abi: portalAbi, functionName: "SALT_LOCK_FEE" });
          if (fee !== value) throw new Error("creationFeeChanged");
          const { request } = await publicClient.simulateContract({
            account,
            address: PORTAL,
            abi: portalAbi,
            functionName: "newLauncher",
            args: [FACTORY, input.configuration as Hex],
            value,
          });
          hash = await client.writeContract(request);
        } else {
          const mutability = actions[input.action];
          const launcher = options.launcher;
          if (!mutability || !launcher) throw new Error("invalidTransaction");
          if (!(await belongsToFactory(launcher))) throw new Error("factoryUnavailable");
          const value = mutability === "payable" && input.valueWei !== undefined ? BigInt(input.valueWei) : 0n;
          const abi: Abi = [{ type: "function", name: input.action, stateMutability: mutability, inputs: [], outputs: [] }];
          const { request } = await publicClient.simulateContract({
            account,
            address: launcher,
            abi,
            functionName: input.action,
            value,
          });
          hash = await client.writeContract(request);
        }
      } catch (cause) {
        throw hostError(cause, "invalidTransaction");
      }

      setPendingHash(hash);
      const submission = await settle(hash);
      if (submission.status === "success") options.refresh();
      return submission;
    },

    async checkReceipt(hash: string): Promise<Submission> {
      if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error("receiptUnavailable");
      return settle(hash as Hex);
    },

    refresh: options.refresh,
    openLauncher(address: string) {
      if (isAddress(address)) options.openLauncher(address.toLowerCase());
    },
  };
}
