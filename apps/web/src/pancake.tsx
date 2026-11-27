// The CallZ launchpad on BNB Chain mainnet: an NFT pass mint that launches a token straight into a PancakeSwap
// pool. Three pages: the list of mints, the form that creates one, and a mint's own page.
//
// The contracts are contracts/src/callz: CallZPancakeFactory makes one CallZPancake per launch, and a launch pays
// the launch fee (a share of the raise, 10%) to CallZVault. Nothing here holds a key: the visitor's wallet signs
// every transaction, and the page reads the chain directly.
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  BaseError,
  createPublicClient,
  createWalletClient,
  custom,
  encodeFunctionData,
  formatEther,
  http,
  parseAbi,
  parseEther,
  parseEventLogs,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { bsc } from "viem/chains";
import deployment from "./callz-deployment.json";
import firstDeployment from "./pancake-deployment.json";
import flapFactoryDeployment from "./factory-deployment.json";
import { ago, amount, compact, short } from "./format";
import { SITES } from "./site";
import { connect, switchChain, useWallet } from "./wallet";

const SITE = SITES.bsc;
const FACTORY = deployment.factory.address as Address;
/** The factory CallZ launched with, before fees: its mints still list and still work. */
const FIRST_FACTORY = firstDeployment.address as Address;
/** CallZ's contracts in the order they are deployed: the router and the factory are built on the vault's address. */
const CONTRACTS = [
  { label: "the fee vault", ...deployment.vault },
  { label: "the trade router", ...deployment.router },
  { label: "the mint factory", ...deployment.factory },
] as const;
/**
 * CallZ's Launcher Factory for Flap Pool Launch. It is deployed through the deterministic CREATE2 deployer, so
 * it has the same code at the same address on BNB Chain as on BNB Chain Testnet. Flap enables a factory on BNB
 * Chain once it is there.
 */
const FLAP_FACTORY = flapFactoryDeployment.address as Address;
/** The limits CallZPancake enforces, so the form says no before the chain does. */
const MAX_CAP = parseEther("10");
const MAX_NFTS = 10_000n;
const MAX_MINT_PER_TX = 50n;

const factoryAbi = parseAbi([
  "struct CallZPancakeConfig { string name; string symbol; string meta; uint256 nftPrice; uint256 cap; uint256 saleDuration; uint16 poolShareBps; }",
  "function create(CallZPancakeConfig config, bytes32 salt) returns (address mint)",
  "function mintCount() view returns (uint256)",
  "function mints(uint256 index) view returns (address)",
  "function launchFeeBps() view returns (uint16)",
  "event CallZPancakeCreated(address indexed mint, address indexed creator, string name, string symbol, uint256 nftPrice, uint256 cap)",
]);
const mintAbi = parseAbi([
  "function tokenName() view returns (string)",
  "function tokenSymbol() view returns (string)",
  "function creator() view returns (address)",
  "function nftPrice() view returns (uint256)",
  "function cap() view returns (uint256)",
  "function raised() view returns (uint256)",
  "function minted() view returns (uint256)",
  "function maxNFTs() view returns (uint256)",
  "function saleDeadline() view returns (uint256)",
  "function poolShareBps() view returns (uint16)",
  "function launchFeeBps() view returns (uint16)",
  "function tokensPerNFT() view returns (uint256)",
  "function launched() view returns (bool)",
  "function refundAvailable() view returns (bool)",
  "function token() view returns (address)",
  "function pair() view returns (address)",
  "function balanceOf(address owner) view returns (uint256)",
  "function claimableOf(address account) view returns (uint256)",
  "function refundableOf(address account) view returns (uint256)",
  "function mint() payable",
  "function claim()",
  "function refund()",
]);

// VITE_BSC_RPC_URL points the pages at another endpoint: a private one, or a local fork in the tests.
const client = createPublicClient({ chain: bsc, transport: http(import.meta.env.VITE_BSC_RPC_URL ?? SITE.rpcUrl), batch: { multicall: true } });

export type PancakeRoute = { name: "launch" } | { name: "launch-create" } | { name: "mint"; address: string };

type Loaded<T> = { state: "loading" } | { state: "error" } | { state: "ready"; data: T };

/** Reads `load` now and again every `refreshMs`, keeping the last good answer through a failed refresh. */
function useChain<T>(load: () => Promise<T>, refreshMs: number): Loaded<T> & { reload(): void } {
  const [result, setResult] = useState<Loaded<T>>({ state: "loading" });
  const reload = useCallback(() => {
    load().then(
      (data) => setResult({ state: "ready", data }),
      () => setResult((previous) => (previous.state === "ready" ? previous : { state: "error" })),
    );
  }, [load]);
  useEffect(() => {
    setResult({ state: "loading" });
    reload();
    const timer = window.setInterval(reload, refreshMs);
    return () => window.clearInterval(timer);
  }, [reload, refreshMs]);
  return { ...result, reload };
}

/** What went wrong with a transaction, in words for the person who sent it. */
function explain(error: unknown): string {
  const code = (error as { code?: number })?.code ?? ((error as BaseError)?.walk?.() as { code?: number } | undefined)?.code;
  const text = error instanceof BaseError ? error.shortMessage : String((error as { message?: string })?.message ?? error);
  if (code === 4001 || /user (rejected|denied)|rejected the request/i.test(text)) return "You cancelled the request in your wallet. Nothing was sent.";
  if (/insufficient funds|exceeds (the )?balance/i.test(text)) return "Your balance does not cover this amount plus the network fee. Nothing was sent.";
  return `${text.replace(/\s+/g, " ").slice(0, 220)} Nothing was sent.`;
}

interface TxState {
  kind: "idle" | "working" | "done" | "error";
  text?: string;
  hash?: Hex;
}

/** BNB Chain's limit on one transaction's gas. */
const GAS_CAP = 16_777_216n;

interface Call {
  to: Address;
  data: Hex;
  value?: bigint;
}

/**
 * Simulates, signs and follows one transaction. A transaction the chain would reject is never sent.
 * Resolves with the receipt, or null when it did not go through.
 */
function useTransaction() {
  const [tx, setTx] = useState<TxState>({ kind: "idle" });
  const send = useCallback(async (label: string, call: Call, account: Address) => {
    setTx({ kind: "working", text: `${label}: checking on BNB Chain…` });
    try {
      const signer = createWalletClient({ chain: bsc, transport: custom(window.ethereum!) });
      await client.call({ account, ...call });
      // A quarter more gas than the estimate, within the chain's limit: what is not used is not paid for.
      const estimate = await client.estimateGas({ account, ...call });
      const gas = (estimate * 5n) / 4n > GAS_CAP ? GAS_CAP : (estimate * 5n) / 4n;
      setTx({ kind: "working", text: `${label}: confirm in your wallet…` });
      const hash = await signer.sendTransaction({ account, ...call, gas });
      setTx({ kind: "working", text: `${label}: waiting for confirmation…`, hash });
      const receipt = await client.waitForTransactionReceipt({ hash, timeout: 180_000 });
      if (receipt.status !== "success") {
        setTx({ kind: "error", text: `${label} reverted. Only the network fee was spent.`, hash });
        return null;
      }
      setTx({ kind: "done", text: `${label} confirmed.`, hash });
      return receipt;
    } catch (error) {
      setTx({ kind: "error", text: explain(error) });
      return null;
    }
  }, []);
  return { tx, send };
}

function TxNote({ tx }: { tx: TxState }) {
  if (tx.kind === "idle") return null;
  return (
    <p className={`trade-outcome trade-${tx.kind === "done" ? "done" : tx.kind === "error" ? "error" : "working"}`} role={tx.kind === "error" ? "alert" : "status"}>
      {tx.text} {tx.hash && <a href={`${SITE.explorer}/tx/${tx.hash}`} target="_blank" rel="noreferrer">View transaction ↗</a>}
    </p>
  );
}

/** The button a page needs before it can send anything: connect, then be on BNB Chain. Null when ready. */
function WalletGate(): ReactNode {
  const wallet = useWallet();
  if (!wallet.available) return <p className="trade-note">No browser wallet found. Install MetaMask, Rabby or another wallet to use the launchpad.</p>;
  if (!wallet.account) return <button type="button" className="button" onClick={connect}>Connect wallet</button>;
  if (wallet.chainId !== SITE.id) return <button type="button" className="button button-warn" onClick={() => void switchChain(SITE).catch(() => undefined)}>Switch to BNB Chain</button>;
  return null;
}

const RISK = "These contracts are new and have not been audited. Use only what you can afford to lose.";

interface MintSummary {
  address: Address;
  name: string;
  symbol: string;
  minted: bigint;
  maxNFTs: bigint;
  raised: bigint;
  cap: bigint;
  launched: boolean;
  saleDeadline: bigint;
}

/** Which of CallZ's contracts are not on BNB Chain yet, in the order they have to be deployed. */
async function missingContracts() {
  const codes = await Promise.all(CONTRACTS.map((contract) => client.getCode({ address: contract.address as Address })));
  return CONTRACTS.filter((_, index) => !codes[index] || codes[index] === "0x");
}

async function factoryMints(factory: Address): Promise<Address[]> {
  const count = await client.readContract({ address: factory, abi: factoryAbi, functionName: "mintCount" }).catch(() => 0n);
  const newest = Array.from({ length: Number(count > 60n ? 60n : count) }, (_, index) => count - 1n - BigInt(index));
  return Promise.all(newest.map((index) => client.readContract({ address: factory, abi: factoryAbi, functionName: "mints", args: [index] })));
}

async function readSummaries(): Promise<{ deployed: boolean; missing: Array<(typeof CONTRACTS)[number]>; flapFactoryDeployed: boolean; launchFeeBps: number; mints: MintSummary[] }> {
  const missing = await missingContracts();
  const deployed = missing.length === 0;
  // Mints of the current factory first, then the ones launched before fees.
  const [current, first, launchFeeBps, flapFactoryCode] = await Promise.all([
    deployed ? factoryMints(FACTORY) : [],
    factoryMints(FIRST_FACTORY),
    deployed ? client.readContract({ address: FACTORY, abi: factoryAbi, functionName: "launchFeeBps" }) : deployment.launchFeeBps,
    client.getCode({ address: FLAP_FACTORY }),
  ]);
  const flapFactoryDeployed = !!flapFactoryCode && flapFactoryCode !== "0x";
  const mints = await Promise.all(
    [...current, ...first].map(async (address) => {
      const at = { address, abi: mintAbi } as const;
      const [name, symbol, minted, maxNFTs, raised, cap, launched, saleDeadline] = await client.multicall({
        allowFailure: false,
        contracts: [
          { ...at, functionName: "tokenName" },
          { ...at, functionName: "tokenSymbol" },
          { ...at, functionName: "minted" },
          { ...at, functionName: "maxNFTs" },
          { ...at, functionName: "raised" },
          { ...at, functionName: "cap" },
          { ...at, functionName: "launched" },
          { ...at, functionName: "saleDeadline" },
        ],
      });
      return { address, name, symbol, minted, maxNFTs, raised, cap, launched, saleDeadline };
    }),
  );
  return { deployed, missing, flapFactoryDeployed, launchFeeBps, mints };
}

function statusOf(mint: { launched: boolean; saleDeadline: bigint }): { label: string; tone: "good" | "gold" | "muted" } {
  if (mint.launched) return { label: "Launched", tone: "good" };
  return BigInt(Math.floor(Date.now() / 1000)) > mint.saleDeadline ? { label: "Ended · refunds open", tone: "muted" } : { label: "Minting", tone: "gold" };
}

function LaunchHome() {
  const wallet = useWallet();
  const list = useChain(readSummaries, 20_000);
  const { tx, send } = useTransaction();
  const { tx: flapTx, send: sendFlap } = useTransaction();
  const gate = WalletGate();
  const feeText = `${(list.state === "ready" ? list.data.launchFeeBps : deployment.launchFeeBps) / 100}%`;

  const deployFlapFactory = async () => {
    if (!wallet.account) return;
    // The same transaction the testnet launch page sends: the salt and the creation code, to the CREATE2 deployer.
    await sendFlap(
      "Deploying the Flap Pool Launch factory",
      { to: flapFactoryDeployment.deployer as Address, data: `${flapFactoryDeployment.salt}${flapFactoryDeployment.initCode.slice(2)}` as Hex },
      wallet.account,
    );
    list.reload();
  };

  const deploy = async () => {
    if (!wallet.account) return;
    // One transaction each through the deterministic CREATE2 deployer: every contract lands at the same address
    // whoever sends it, with the team wallet as guardian. Whatever is already deployed is skipped.
    for (const contract of await missingContracts()) {
      const receipt = await send(`Deploying ${contract.label}`, { to: deployment.deployer as Address, data: `${contract.salt}${contract.initCode.slice(2)}` as Hex }, wallet.account);
      if (!receipt) break;
    }
    list.reload();
  };

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Launch</h1>
        <p className="lede">
          Sell NFT passes at a flat price. The mint that reaches the cap creates the token and puts the raise, less the launch fee, with the
          pool's share of the supply, into a PancakeSwap pool. The pool's LP tokens are burned, and every pass claims an equal share of the rest.
        </p>
      </div>
      <ol className="steps">
        <li><strong>Mint a pass.</strong> Each pass is an NFT bought at the same BNB price, until the raise reaches its cap.</li>
        <li><strong>The cap launches it.</strong> The final mint creates the token and its PancakeSwap pool in the same transaction. {feeText} of the raise goes to the CallZ vault, where it rewards the people who call the token out.</li>
        <li><strong>Claim, or get your BNB back.</strong> Each pass claims its tokens after launch. If the cap is not reached in time, burn the pass for a full refund.</li>
      </ol>
      <p className="note note-warn" data-testid="launch-risk">{RISK}</p>

      {list.state === "loading" && <p className="note" role="status">Reading CallZ mints from BNB Chain…</p>}
      {list.state === "error" && <p className="note" role="alert">BNB Chain could not be reached. Reload to try again.</p>}
      {list.state === "ready" && !list.data.deployed && (
        <section className="note" data-testid="pancake-not-deployed">
          <h2>CallZ's fee contracts are not all on BNB Chain yet</h2>
          <p>
            Still to deploy: {list.data.missing.map((contract) => contract.label).join(", ")}. Each is one transaction from any wallet, paid in BNB
            network fees only, and lands at a fixed address (the factory at <code>{FACTORY}</code>). Whoever deploys them gets no special
            rights: the team wallet <code>{short(deployment.team)}</code> is their guardian either way. Until they are deployed, trades on
            CallZ go straight to PancakeSwap with no CallZ fee.
          </p>
          <div className="actions">{gate ?? <button type="button" className="button" disabled={tx.kind === "working"} onClick={() => void deploy()}>Deploy {list.data.missing.length} contract{list.data.missing.length === 1 ? "" : "s"}</button>}</div>
          <TxNote tx={tx} />
        </section>
      )}
      {list.state === "ready" && !list.data.flapFactoryDeployed && (
        <section className="note" data-testid="flap-factory-not-deployed">
          <h2>The Flap Pool Launch factory is not on BNB Chain yet</h2>
          <p>
            CallZ's Launcher Factory for Flap Pool Launch has the same code at the same address, <code>{FLAP_FACTORY}</code>, on BNB
            Chain as on BNB Chain Testnet. It is one transaction from any wallet, paid in BNB network fees only, and whoever sends it
            gets no rights over it. Deploying it launches nothing: Pool Launch on BNB Chain accepts a factory only once Flap has
            enabled it.
          </p>
          <div className="actions">{gate ?? <button type="button" className="button" disabled={flapTx.kind === "working"} onClick={() => void deployFlapFactory()}>Deploy the Flap factory</button>}</div>
          <TxNote tx={flapTx} />
        </section>
      )}
      {list.state === "ready" && (list.data.deployed || list.data.mints.length > 0) && (
        <section>
          <div className="section-head">
            <h2>CallZ mints <span className="dim">{list.data.mints.length}</span></h2>
            {list.data.deployed && <a className="button" href="#/launch/create">Create a mint</a>}
          </div>
          {list.data.mints.length === 0 ? (
            <p className="note" data-testid="pancake-empty">No mints yet. Create the first one.</p>
          ) : (
            <ul className="cards" data-testid="pancake-mints">
              {list.data.mints.map((mint) => {
                const status = statusOf(mint);
                return (
                  <li key={mint.address}>
                    <a className="card" href={`#/mint/${mint.address.toLowerCase()}`}>
                      <span className="card-head">
                        <strong>{mint.name} <span className="dim">{mint.symbol}</span></strong>
                        <span className={`tag tag-${status.tone}`}>{status.label}</span>
                      </span>
                      <span className="card-line">{mint.minted.toString()} / {mint.maxNFTs.toString()} passes · {amount(mint.raised, 4)} / {amount(mint.cap, 4)} BNB</span>
                    </a>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}
    </>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="stat-label">{label}</span>
      {children}
      {hint && <span className="dim field-hint">{hint}</span>}
    </label>
  );
}

function CreatePage() {
  const wallet = useWallet();
  const { tx, send } = useTransaction();
  const gate = WalletGate();
  const [form, setForm] = useState({ name: "", symbol: "", price: "0.01", cap: "1", hours: "24", poolShare: "50" });
  // The launch fee a mint created now will carry, read from the factory. It is fixed into the mint at creation.
  const [feeBps, setFeeBps] = useState<number>(deployment.launchFeeBps);
  useEffect(() => {
    let current = true;
    client.readContract({ address: FACTORY, abi: factoryAbi, functionName: "launchFeeBps" }).then((value) => current && setFeeBps(value), () => undefined);
    return () => {
      current = false;
    };
  }, []);
  const set = (key: keyof typeof form) => (event: { target: { value: string } }) => setForm((previous) => ({ ...previous, [key]: event.target.value }));

  const parsed = useMemo(() => {
    const problems: string[] = [];
    const bytes = (text: string) => new TextEncoder().encode(text).length;
    const name = form.name.trim();
    const symbol = form.symbol.trim();
    if (!name || bytes(name) > 64) problems.push("Name: 1 to 64 bytes.");
    if (!symbol || bytes(symbol) > 32) problems.push("Symbol: 1 to 32 bytes.");
    let price = 0n;
    let cap = 0n;
    try {
      price = parseEther(form.price.trim() || "0");
      cap = parseEther(form.cap.trim() || "0");
    } catch {
      problems.push("Price and cap must be BNB amounts.");
    }
    if (price <= 0n) problems.push("Price per pass must be above zero.");
    if (cap <= 0n || cap > MAX_CAP) problems.push("Cap: above zero, at most 10 BNB.");
    if (price > 0n && cap > 0n && cap % price !== 0n) problems.push("Cap must be an exact multiple of the price.");
    const passes = price > 0n ? cap / price : 0n;
    if (passes > MAX_NFTS) problems.push("At most 10,000 passes: raise the price or lower the cap.");
    const hours = Number(form.hours);
    const duration = Number.isFinite(hours) ? Math.round(hours * 3600) : 0;
    if (duration < 600 || duration > 30 * 86_400) problems.push("Sale length: 10 minutes to 30 days.");
    const share = Number(form.poolShare);
    if (!Number.isInteger(share) || share < 10 || share > 90) problems.push("Pool share: a whole number from 10 to 90.");
    return { name, symbol, price, cap, passes, duration, poolShareBps: share * 100, problems };
  }, [form]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!wallet.account || parsed.problems.length > 0) return;
    const salt = toHex(crypto.getRandomValues(new Uint8Array(32)));
    const config = { name: parsed.name, symbol: parsed.symbol, meta: "", nftPrice: parsed.price, cap: parsed.cap, saleDuration: BigInt(parsed.duration), poolShareBps: parsed.poolShareBps };
    const receipt = await send("Creating the mint", { to: FACTORY, data: encodeFunctionData({ abi: factoryAbi, functionName: "create", args: [config, salt] }) }, wallet.account);
    if (!receipt) return;
    const created = parseEventLogs({ abi: factoryAbi, eventName: "CallZPancakeCreated", logs: receipt.logs })[0];
    if (created) window.location.hash = `#/mint/${created.args.mint.toLowerCase()}`;
  };

  const perPass = parsed.passes > 0n ? (1_000_000_000n * BigInt(10_000 - parsed.poolShareBps)) / 10_000n / parsed.passes : 0n;
  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Create a mint</h1>
        <p className="lede">On BNB Chain. The token and its PancakeSwap pool are created by the mint that reaches the cap. The launch fee is taken from the raise only if the mint launches: a refund returns the full price. Nothing here can be changed after you create it.</p>
      </div>
      <form className="form" onSubmit={(event) => void submit(event)} data-testid="pancake-create">
        <Field label="Token name"><input name="name" value={form.name} onChange={set("name")} maxLength={64} autoComplete="off" required /></Field>
        <Field label="Token symbol"><input name="symbol" value={form.symbol} onChange={set("symbol")} maxLength={32} autoComplete="off" required /></Field>
        <Field label="Price per pass (BNB)"><input name="price" inputMode="decimal" value={form.price} onChange={set("price")} autoComplete="off" /></Field>
        <Field label="Cap (BNB)" hint="The raise that launches the token. At most 10 BNB, and an exact multiple of the price."><input name="cap" inputMode="decimal" value={form.cap} onChange={set("cap")} autoComplete="off" /></Field>
        <Field label="Sale length (hours)" hint="If the cap is not reached by then, every pass can be burned for a full refund."><input name="hours" inputMode="decimal" value={form.hours} onChange={set("hours")} autoComplete="off" /></Field>
        <Field label="Supply into the pool (%)" hint="The rest of the 1,000,000,000 supply is split equally between the passes."><input name="poolShare" inputMode="numeric" value={form.poolShare} onChange={set("poolShare")} autoComplete="off" /></Field>

        <dl className="trade-quote form-wide" data-testid="pancake-summary">
          <div><dt>Passes</dt><dd className="num">{parsed.passes.toString()}</dd></div>
          <div><dt>Tokens per pass</dt><dd className="num">{perPass.toLocaleString("en")}</dd></div>
          <div><dt>Launch fee, to the CallZ vault</dt><dd className="num">{feeBps / 100}% of the raise · {formatEther((parsed.cap * BigInt(feeBps)) / 10_000n)} BNB</dd></div>
          <div><dt>Into the pool at launch</dt><dd className="num">{formatEther(parsed.cap - (parsed.cap * BigInt(feeBps)) / 10_000n)} BNB + {parsed.poolShareBps / 100}% of supply</dd></div>
        </dl>
        {parsed.problems.length > 0 && <ul className="form-problems form-wide">{parsed.problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>}
        <p className="note note-warn form-wide">{RISK}</p>
        <div className="actions form-wide">
          {gate ?? <button type="submit" className="button" disabled={parsed.problems.length > 0 || tx.kind === "working"}>Create the mint</button>}
          <a className="button button-quiet" href="#/launch">Back</a>
        </div>
        <div className="form-wide"><TxNote tx={tx} /></div>
      </form>
    </>
  );
}

interface MintState {
  name: string;
  symbol: string;
  creator: Address;
  nftPrice: bigint;
  cap: bigint;
  raised: bigint;
  /** Share of the raise paid to the CallZ vault at launch, in bps. Zero on mints made before fees. */
  launchFeeBps: number;
  minted: bigint;
  maxNFTs: bigint;
  saleDeadline: bigint;
  poolShareBps: number;
  tokensPerNFT: bigint;
  launched: boolean;
  refundAvailable: boolean;
  token: Address;
  pair: Address;
  passes: bigint;
  claimable: bigint;
  refundable: bigint;
}

function MintPage({ address }: { address: string }) {
  const mint = address as Address;
  const wallet = useWallet();
  const account = wallet.account;
  const { tx, send } = useTransaction();
  const gate = WalletGate();
  const [quantity, setQuantity] = useState("1");

  const load = useCallback(async (): Promise<MintState | null> => {
    const code = await client.getCode({ address: mint });
    if (!code || code === "0x") return null;
    const at = { address: mint, abi: mintAbi } as const;
    const [name, symbol, creator, nftPrice, cap, raised, minted, maxNFTs, saleDeadline, poolShareBps, tokensPerNFT, launched, refundAvailable, token, pair] = await client.multicall({
      allowFailure: false,
      contracts: [
        { ...at, functionName: "tokenName" },
        { ...at, functionName: "tokenSymbol" },
        { ...at, functionName: "creator" },
        { ...at, functionName: "nftPrice" },
        { ...at, functionName: "cap" },
        { ...at, functionName: "raised" },
        { ...at, functionName: "minted" },
        { ...at, functionName: "maxNFTs" },
        { ...at, functionName: "saleDeadline" },
        { ...at, functionName: "poolShareBps" },
        { ...at, functionName: "tokensPerNFT" },
        { ...at, functionName: "launched" },
        { ...at, functionName: "refundAvailable" },
        { ...at, functionName: "token" },
        { ...at, functionName: "pair" },
      ],
    });
    const [passes, claimable, refundable] = account
      ? await client.multicall({
          allowFailure: false,
          contracts: [
            { ...at, functionName: "balanceOf", args: [account] },
            { ...at, functionName: "claimableOf", args: [account] },
            { ...at, functionName: "refundableOf", args: [account] },
          ],
        })
      : [0n, 0n, 0n];
    // Mints made before fees do not have this function: they carry no fee.
    const launchFeeBps = await client.readContract({ ...at, functionName: "launchFeeBps" }).catch(() => 0);
    return { name, symbol, creator, nftPrice, cap, raised, launchFeeBps, minted, maxNFTs, saleDeadline, poolShareBps, tokensPerNFT, launched, refundAvailable, token, pair, passes, claimable, refundable };
  }, [mint, account]);
  const state = useChain(load, 10_000);

  if (state.state === "loading") return <p className="note" role="status">Reading the mint from BNB Chain…</p>;
  if (state.state === "error") return <p className="note" role="alert">BNB Chain could not be reached. Reload to try again.</p>;
  const data = state.data;
  if (!data) return <p className="note" role="alert" data-testid="unknown-mint"><code>{short(mint)}</code> is not a CallZ mint on BNB Chain. <a href="#/launch">Back to the launchpad.</a></p>;

  const status = statusOf(data);
  const left = data.maxNFTs - data.minted;
  const most = left < MAX_MINT_PER_TX ? left : MAX_MINT_PER_TX;
  const count = /^\d+$/.test(quantity) ? BigInt(quantity) : 0n;
  const cost = count * data.nftPrice;
  const open = !data.launched && !data.refundAvailable && left > 0n;
  const progress = data.cap > 0n ? Number((data.raised * 100n) / data.cap) : 0;
  const act = async (label: string, functionName: "mint" | "claim" | "refund", value?: bigint) => {
    if (!account) return;
    const receipt = await send(label, { to: mint, data: encodeFunctionData({ abi: mintAbi, functionName }), ...(value !== undefined ? { value } : {}) }, account);
    if (receipt) state.reload();
  };

  return (
    <>
      <div className="page-head">
        <div className="scope-head">
          <h1 className="page-title">{data.name} <span className="dim">{data.symbol}</span></h1>
          <span className={`tag tag-${status.tone}`} data-testid="mint-status">{status.label}</span>
        </div>
        <p className="lede">
          A CallZ pass mint on BNB Chain, created by <code>{short(data.creator)}</code>.{" "}
          {data.launched ? "It reached its cap and launched." : `The mint closes ${ago(Number(data.saleDeadline)).replace(" ago", "") === "0s" ? "now" : new Date(Number(data.saleDeadline) * 1000).toLocaleString()}.`}
        </p>
      </div>

      <dl className="stats" data-testid="mint-stats">
        <div><dt>Price per pass</dt><dd className="num">{amount(data.nftPrice, 5)} BNB</dd></div>
        <div><dt>Passes minted</dt><dd className="num">{data.minted.toString()} / {data.maxNFTs.toString()}</dd></div>
        <div><dt>Raised</dt><dd className="num">{amount(data.raised, 4)} / {amount(data.cap, 4)} BNB</dd></div>
        <div><dt>Supply into the pool</dt><dd className="num">{data.poolShareBps / 100}%</dd></div>
        <div><dt>Launch fee</dt><dd className="num">{data.launchFeeBps === 0 ? "None" : `${data.launchFeeBps / 100}% of the raise`}</dd></div>
        <div><dt>Tokens per pass</dt><dd className="num">{compact(data.tokensPerNFT.toString())}</dd></div>
      </dl>
      <div className="scope-progress mint-progress" style={{ ["--tone" as string]: "var(--gold)" }}>
        <span className="scope-bar"><span style={{ width: `${Math.min(100, progress)}%` }} /></span>
        <span className="num">{progress}%</span>
      </div>

      <section className="trade-panel mint-panel" data-testid="mint-panel">
        {open && (
          <>
            <h2>Mint passes</h2>
            <label className="trade-amount">
              <span className="stat-label">How many (up to {most.toString()})</span>
              <span className="trade-input">
                <input name="quantity" inputMode="numeric" value={quantity} onChange={(event) => setQuantity(event.target.value.replace(/\D/g, ""))} />
                <span className="num">{formatEther(cost)} BNB</span>
              </span>
            </label>
            {gate ?? <button type="button" className="button trade-go" disabled={count === 0n || count > most || tx.kind === "working"} onClick={() => void act("Minting", "mint", cost)}>Mint {count > 0n ? count.toString() : ""} {count === 1n ? "pass" : "passes"}</button>}
            <p className="trade-foot dim">The mint that reaches the cap launches the token in the same transaction. If you send more than the passes left cost, the extra comes straight back.</p>
          </>
        )}
        {data.launched && (
          <>
            <h2>Launched</h2>
            <p className="trade-note">The token is live in its PancakeSwap pool, and the pool's LP tokens are burned.</p>
            <div className="actions">
              <a className="button" href={`#/token/${data.token.toLowerCase()}`}>Chart and trading →</a>
              <a className="button button-quiet" href={`${SITE.explorer}/address/${data.pair}`} target="_blank" rel="noreferrer">Pool on BscScan ↗</a>
            </div>
            {account && data.passes > 0n && (
              <p className="trade-note">You hold {data.passes.toString()} {data.passes === 1n ? "pass" : "passes"}. Still to claim: <strong className="num">{compact(data.claimable.toString())} {data.symbol}</strong>.</p>
            )}
            {account && data.claimable > 0n && (gate ?? <button type="button" className="button trade-go" disabled={tx.kind === "working"} onClick={() => void act("Claiming", "claim")}>Claim tokens</button>)}
          </>
        )}
        {!data.launched && data.refundAvailable && (
          <>
            <h2>Refunds are open</h2>
            <p className="trade-note">This mint did not reach its cap in time. Burning a pass returns its full price.</p>
            {account && data.refundable > 0n
              ? (gate ?? <button type="button" className="button trade-go" disabled={tx.kind === "working"} onClick={() => void act("Refunding", "refund")}>Burn my passes for {amount(data.refundable, 5)} BNB</button>)
              : <p className="trade-note dim">{account ? "This wallet holds no passes here." : "Connect the wallet that holds the passes."}</p>}
            {!account && gate}
          </>
        )}
        <TxNote tx={tx} />
        <p className="trade-foot dim">{RISK} {data.launchFeeBps === 0 ? "This mint takes no launch fee: the whole raise goes into the pool." : `At launch, ${data.launchFeeBps / 100}% of the raise goes to the CallZ vault, where it rewards the people who call the token out, and the rest goes into the pool. A refund returns the full price.`} Contract <a href={`${SITE.explorer}/address/${mint}`} target="_blank" rel="noreferrer">{short(mint)} ↗</a></p>
      </section>
    </>
  );
}

export default function PancakeSection({ route }: { route: PancakeRoute }) {
  if (route.name === "launch-create") return <CreatePage />;
  if (route.name === "mint") return <MintPage key={route.address} address={route.address} />;
  return <LaunchHome />;
}
