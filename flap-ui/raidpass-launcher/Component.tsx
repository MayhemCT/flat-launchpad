import { useRef, useState, type CSSProperties, type ReactNode } from "react";

// RaidPass Launcher UI for the Flap Launcher runtime (launcher-config-preview/v1).
// LauncherConfig creates a RaidPass Launcher through the Portal; Launcher is the mint page:
// mint passes, then claim tokens after the launch or burn passes for a refund if the mint fails.
// Every transaction goes through the host wallet bridge. All contract data comes from the host snapshot.

type Messages = Record<string, string>;
type Identity = Readonly<{ chainId: number; factoryAddress: string }>;
type Wallet = Readonly<{
  account: string | null;
  chainId: number | null;
  pendingHash?: string | null;
  connect(): void;
  switchChain(): Promise<void>;
}>;
type Action = "mint" | "claim" | "refund";
type Submission = { status: "success" | "pending" | "reverted" | "unverified"; hash: string; launcherAddress?: string };
type AbiParameter = { name: string; type: string; components?: readonly AbiParameter[] };
type Host = Readonly<{
  wallet?: Wallet;
  quote?(): Promise<string | null>;
  encode?(parameters: readonly AbiParameter[], values: readonly unknown[]): string;
  findSalt?(): Promise<string>;
  submit?(input: { kind: "create"; configuration: string; valueWei: string }
    | { kind: "action"; action: Action; valueWei?: string }): Promise<Submission>;
  checkReceipt?(hash: string): Promise<Submission>;
  refresh?(): void;
  openLauncher?(address: string): void;
}>;
type ConfigProps = { context: Readonly<{ identity: Identity; locale: string }>; messages: Messages; host?: Host };
type Snapshot = Readonly<{
  raised?: string | null;
  targetRaise?: string | null;
  mintPrice?: string | null;
  maxPasses?: string | null;
  minted?: string | null;
  saleDeadline?: string | null;
  tokensPerPass?: string | null;
  launched?: boolean | null;
  refundAvailable?: boolean | null;
  token?: string | null;
  creator?: string | null;
  passes?: string | null;
  claimable?: string | null;
  refundable?: string | null;
}>;
type DetailProps = {
  context: Readonly<{ identity: Identity; locale: string; launcherAddress: string | null; snapshot: Snapshot | null }>;
  messages: Messages;
  host?: Host;
};

// The RaidPassLauncherFactory this UI was written for. It is deployed with CREATE2, so the address is the
// same on BNB Chain and BNB Chain Testnet.
const raidPassFactory = "0x1f28ba409797a1309e52f90b331934092d1b4abd";
// abi.encode(RaidPassConfig): one tuple, in the factory's field order.
const configParameters: readonly AbiParameter[] = [
  { name: "config", type: "tuple", components: [
    { name: "name", type: "string" },
    { name: "symbol", type: "string" },
    { name: "meta", type: "string" },
    { name: "salt", type: "bytes32" },
    { name: "nftPrice", type: "uint256" },
    { name: "cap", type: "uint256" },
    { name: "saleDuration", type: "uint256" },
    { name: "poolShareBps", type: "uint16" },
    { name: "buyTaxBps", type: "uint16" },
    { name: "sellTaxBps", type: "uint16" },
  ] },
];
// Limits enforced by RaidPassLauncher.initialize and mint.
const maxCap = 10n * 10n ** 18n;
const maxNfts = 10_000n;
const maxMintPerCall = 50n;
const minSaleSeconds = 600n;
const maxSaleSeconds = 2_592_000n;
// RaidPassLauncher.TOTAL_SUPPLY.
const totalSupply = 1_000_000_000n * 10n ** 18n;

const bg = "#0b0e11";
const panel = "#14181d";
const line = "#2a3038";
const ink = "#eaecef";
const dim = "#929aa5";
const gold = "#f0b90b";
const danger = "#f6465d";
const good = "#2ebd85";
const mono = 'ui-monospace, "SF Mono", "Cascadia Mono", Consolas, monospace';

const shell: CSSProperties = {
  color: ink, background: bg, border: `1px solid ${line}`, borderRadius: 16, overflow: "hidden",
  fontFamily: 'system-ui, -apple-system, "Segoe UI", "PingFang SC", "Apple SD Gothic Neo", sans-serif',
  lineHeight: 1.5, colorScheme: "dark", accentColor: gold,
};
const inset = "clamp(16px, 4vw, 28px)";
const body: CSSProperties = { padding: inset, display: "grid", gap: 20 };
const card: CSSProperties = {
  background: panel, border: `1px solid ${line}`, borderRadius: 12, padding: "clamp(14px, 3vw, 20px)", display: "grid", gap: 14,
};
const grid: CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 170px), 1fr))", gap: 14 };
const field: CSSProperties = {
  appearance: "none", boxSizing: "border-box", minWidth: 0, width: "100%", minHeight: 44, border: `1px solid ${line}`,
  borderRadius: 8, padding: "9px 12px", color: ink, background: bg, font: "inherit", fontSize: 16, outlineOffset: 2,
};
const caption: CSSProperties = { margin: 0, color: dim, fontSize: 12, letterSpacing: "0.06em", textTransform: "uppercase" };
const figure: CSSProperties = { margin: "2px 0 0", fontFamily: mono, fontVariantNumeric: "tabular-nums", overflowWrap: "anywhere" };
const small: CSSProperties = { margin: 0, color: dim, fontSize: 13 };

const addressPattern = /^0x(?!0{40}$)[a-f0-9]{40}$/i;
const hashPattern = /^0x[a-f0-9]{64}$/i;
const unsigned = /^(0|[1-9][0-9]{0,77})$/;
const baseUnit = 10n ** 18n;

function button(disabled = false, secondary = false): CSSProperties {
  return {
    minHeight: 44, borderRadius: 8, padding: "8px 18px", border: secondary ? `1px solid ${line}` : 0,
    background: secondary ? "transparent" : gold, color: secondary ? ink : "#181a20", font: "inherit", fontSize: 15,
    fontWeight: 700, opacity: disabled ? 0.45 : 1, cursor: disabled ? "default" : "pointer",
  };
}

function units(input: string | null | undefined) {
  return typeof input === "string" && unsigned.test(input) ? BigInt(input) : null;
}

function grouped(whole: bigint) {
  return whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function decimal(amount: bigint, decimals = 6) {
  const fraction = (amount % baseUnit).toString().padStart(18, "0").slice(0, decimals).replace(/0+$/, "");
  return `${grouped(amount / baseUnit)}${fraction ? "." + fraction : ""}`;
}

function parseAmount(input: string) {
  const match = /^(0|[1-9][0-9]{0,6})(?:\.([0-9]{1,18}))?$/.exec(input.trim());
  return match ? BigInt(match[1]) * baseUnit + BigInt((match[2] ?? "").padEnd(18, "0")) : null;
}

function parseCount(input: string, max: bigint) {
  if (!/^[1-9][0-9]{0,7}$/.test(input.trim())) return null;
  const count = BigInt(input.trim());
  return count <= max ? count : null;
}

function isHash(input: unknown): input is string {
  return typeof input === "string" && hashPattern.test(input);
}

function supported(identity: Identity) {
  return (identity.chainId === 97 || identity.chainId === 56) && identity.factoryAddress.toLowerCase() === raidPassFactory;
}

function symbolFor(identity: Identity) {
  return identity.chainId === 97 ? "tBNB" : "BNB";
}

function errorText(cause: unknown, m: Messages, fallback: string) {
  if (!(cause instanceof Error)) return fallback;
  const known: Record<string, string> = {
    walletUnavailable: m.walletUnavailable, connectWallet: m.connectWallet, wrongChain: m.switchChain,
    walletRejected: m.walletRejected, walletBusy: m.walletBusy, simulationFailed: m.simulationFailed,
    creationFeeChanged: m.feeChanged, factoryUnavailable: m.factoryUnavailable, invalidTransaction: m.submitError,
    saltUnavailable: m.saltUnavailable, receiptUnavailable: m.receiptError,
  };
  return Object.hasOwn(known, cause.message) ? known[cause.message] : fallback;
}

function shownReceipt(receipt: Submission | null, pendingHash: string | null | undefined) {
  if (isHash(pendingHash) && receipt?.hash !== pendingHash) return { status: "pending", hash: pendingHash } as const;
  return receipt;
}

function needsRecheck(receipt: Submission | null) {
  return receipt?.status === "pending" || receipt?.status === "unverified";
}

function Header({ title, intro, network }: { title: string; intro: string; network: string }) {
  return (
    <header style={{
      padding: inset, borderBlockEnd: `1px solid ${line}`, display: "flex", gap: 16,
      justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap",
    }}>
      <div style={{ flex: "1 1 240px", minWidth: 0 }}>
        <p style={{ ...caption, color: gold }}>CallZ</p>
        <h2 style={{ margin: "4px 0 0", fontSize: "clamp(22px, 5vw, 32px)", lineHeight: 1.15, letterSpacing: "-0.02em" }}>{title}</h2>
        <p style={{ ...small, marginBlockStart: 8, maxWidth: 560 }}>{intro}</p>
      </div>
      <span style={{ padding: "4px 10px", border: `1px solid ${line}`, borderRadius: 20, fontSize: 12, color: dim, whiteSpace: "nowrap" }}>
        {network}
      </span>
    </header>
  );
}

function Field({ name, hint, children }: { name: string; hint?: string; children: ReactNode }) {
  return (
    <label style={{ display: "grid", gap: 6, minWidth: 0, alignContent: "start" }}>
      <span style={{ fontSize: 14, fontWeight: 600 }}>{name}</span>
      {children}
      {hint && <span style={small}>{hint}</span>}
    </label>
  );
}

function Datum({ name, children }: { name: string; children: ReactNode }) {
  return <div style={{ minWidth: 0 }}><dt style={caption}>{name}</dt><dd style={figure}>{children}</dd></div>;
}

function ReceiptLine({ receipt, m }: { receipt: Submission | null; m: Messages }) {
  if (!receipt) return null;
  const names = { success: m.success, pending: m.pending, reverted: m.reverted, unverified: m.unverified };
  const color = receipt.status === "success" ? good : receipt.status === "reverted" ? danger : dim;
  return (
    <div role="status" style={{ display: "grid", gap: 2 }}>
      <span style={{ fontSize: 13, fontWeight: 700, color }}>{names[receipt.status]}</span>
      {isHash(receipt.hash) && <span style={{ ...figure, fontSize: 12, color: dim }}>{receipt.hash}</span>}
    </div>
  );
}

const emptyForm = { name: "", symbol: "", meta: "", price: "", cap: "", hours: "24", poolShare: "50", buyTax: "3", sellTax: "5" };
type Form = typeof emptyForm;

// A percentage with up to two decimals, as basis points, or null when it is outside [min, max] bps.
function percentBps(input: string, min: number, max: number) {
  const match = /^(0|[1-9][0-9]?)(?:\.([0-9]{1,2}))?$/.exec(input.trim());
  if (!match) return null;
  const bps = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return bps >= min && bps <= max ? bps : null;
}

// The cap is at most 10 BNB and a whole number of NFTs.
function capError(price: bigint | null, cap: bigint | null) {
  if (price === null || price === 0n || cap === null || cap === 0n) return "incomplete";
  if (cap > maxCap) return "tooHigh";
  if (cap % price !== 0n) return "notMultiple";
  if (cap / price > maxNfts) return "tooMany";
  return null;
}

// UTF-8 length: the contract caps the name at 64 bytes, the symbol at 32 and the metadata CID at 128.
function byteLength(input: string) {
  let bytes = 0;
  for (const character of input) {
    const code = character.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

function readForm(form: Form) {
  const name = form.name.trim();
  const symbol = form.symbol.trim();
  if (byteLength(name) > 64 || byteLength(symbol) > 32 || byteLength(form.meta.trim()) > 128) return null;
  const price = parseAmount(form.price);
  const cap = parseAmount(form.cap);
  const poolShareBps = percentBps(form.poolShare, 1000, 9000);
  const buyTaxBps = percentBps(form.buyTax, 0, 1000);
  const sellTaxBps = percentBps(form.sellTax, 0, 1000);
  const hours = /^(0|[1-9][0-9]{0,3})(?:\.([0-9]{1,2}))?$/.test(form.hours.trim()) ? Number(form.hours) : null;
  const seconds = hours === null ? null : BigInt(Math.round(hours * 3600));
  if (!name || !symbol || price === null || cap === null || capError(price, cap) !== null
    || poolShareBps === null || buyTaxBps === null || sellTaxBps === null
    || seconds === null || seconds < minSaleSeconds || seconds > maxSaleSeconds) return null;
  const nfts = cap / price;
  const holderPool = totalSupply - totalSupply * BigInt(poolShareBps) / 10_000n;
  return {
    name, symbol, meta: form.meta.trim(), price, cap, nfts, seconds, poolShareBps, buyTaxBps, sellTaxBps,
    perNft: holderPool / nfts,
  };
}

type Draft = NonNullable<ReturnType<typeof readForm>>;

export function LauncherConfig({ context, messages: m, host }: ConfigProps) {
  const [form, setForm] = useState<Form>(emptyForm);
  const [review, setReview] = useState<{ draft: Draft; fee: string | null } | null>(null);
  const [prepared, setPrepared] = useState<{ configuration: string; account: string; valueWei: string } | null>(null);
  const [result, setResult] = useState<{ account: string; receipt: Submission } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);

  const unit = symbolFor(context.identity);
  const draft = readForm(form);
  const account = host?.wallet?.account;
  const wrongChain = host?.wallet?.chainId !== context.identity.chainId;
  const canTransact = supported(context.identity) && !!host?.wallet && !!host?.quote && !!host?.findSalt
    && !!host?.encode && !!host?.submit;
  const receipt = shownReceipt(
    result?.account === account?.toLowerCase() ? result?.receipt ?? null : null, host?.wallet?.pendingHash,
  );
  const waiting = needsRecheck(receipt);
  const finished = receipt?.status === "success";
  const created = finished && typeof receipt?.launcherAddress === "string" && addressPattern.test(receipt.launcherAddress)
    ? receipt.launcherAddress : null;
  const sameWallet = !!account && prepared?.account === account.toLowerCase();

  function update(key: keyof Form, next: string) {
    setForm(current => ({ ...current, [key]: next }));
    setReview(null);
    setPrepared(null);
    setError(null);
  }

  async function run(task: () => Promise<void>, fallback: string) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      await task();
    } catch (cause) {
      setError(errorText(cause, m, fallback));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  const showReview = () => run(async () => {
    if (!draft) return;
    const fee = canTransact ? await host?.quote?.() : null;
    const valid = fee != null && unsigned.test(fee);
    if (canTransact && !valid) setError(m.feeUnavailable);
    setReview({ draft, fee: valid ? fee : null });
  }, m.feeUnavailable);

  const prepare = () => run(async () => {
    if (!canTransact || !review || finished || waiting) return;
    if (!account) { host?.wallet?.connect(); return; }
    if (wrongChain) { await host?.wallet?.switchChain(); return; }
    const fee = await host?.quote?.();
    if (fee == null || !unsigned.test(fee)) { setError(m.feeUnavailable); return; }
    if (fee !== review.fee) { setReview({ ...review, fee }); setError(m.feeChanged); return; }
    const salt = await host?.findSalt?.();
    if (!isHash(salt)) { setError(m.saltUnavailable); return; }
    const d = review.draft;
    const configuration = host?.encode?.(configParameters, [{
      name: d.name, symbol: d.symbol, meta: d.meta, salt, nftPrice: d.price, cap: d.cap, saleDuration: d.seconds,
      poolShareBps: d.poolShareBps, buyTaxBps: d.buyTaxBps, sellTaxBps: d.sellTaxBps,
    }]);
    if (!configuration) { setError(m.prepareError); return; }
    setPrepared({ configuration, account: account.toLowerCase(), valueWei: fee });
  }, m.prepareError);

  const confirm = () => run(async () => {
    if (!canTransact || !prepared || !account || !sameWallet || wrongChain || finished || waiting) return;
    const sent = prepared;
    setPrepared(null);
    setResult(null);
    const submission = await host?.submit?.({ kind: "create", configuration: sent.configuration, valueWei: sent.valueWei });
    if (submission) setResult({ account: account.toLowerCase(), receipt: submission });
  }, m.submitError);

  const recheck = () => run(async () => {
    if (!account || !receipt || !isHash(receipt.hash)) return;
    const submission = await host?.checkReceipt?.(receipt.hash);
    if (submission) setResult({ account: account.toLowerCase(), receipt: submission });
  }, m.receiptError);

  const shown = review?.draft ?? draft;
  const primary = !account ? m.connectWallet : wrongChain ? m.switchChain : sameWallet ? m.confirmCreation : m.prepareCreation;
  const reviewDisabled = busy || (!draft && !review);
  const capIssue = form.price !== "" && form.cap !== "" ? capError(parseAmount(form.price), parseAmount(form.cap)) : null;
  const capHint = capIssue === "tooHigh" ? m.capTooHigh : capIssue === "notMultiple" ? m.capNotMultiple
    : capIssue === "tooMany" ? m.capTooMany : m.capHint;

  return (
    <section style={shell} aria-label={m.createTitle}>
      <Header title={m.createTitle} intro={m.createIntro} network={unit === "tBNB" ? m.testnet : m.mainnet} />
      <div style={{ ...body, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 280px), 1fr))", alignItems: "start" }}>
        <fieldset disabled={busy || waiting || finished} style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 16, minWidth: 0 }}>
          <div style={grid}>
            <Field name={m.tokenName}>
              <input name="name" value={form.name} maxLength={64} autoComplete="off" required style={field}
                onChange={event => update("name", event.target.value)} />
            </Field>
            <Field name={m.tokenSymbol}>
              <input name="symbol" value={form.symbol} maxLength={16} autoComplete="off" required style={field}
                onChange={event => update("symbol", event.target.value)} />
            </Field>
          </div>
          <Field name={m.metadata} hint={m.metadataHint}>
            <input name="meta" value={form.meta} maxLength={128} autoComplete="off" style={field}
              onChange={event => update("meta", event.target.value)} />
          </Field>
          <div style={grid}>
            <Field name={`${m.mintPrice} (${unit})`}>
              <input name="price" value={form.price} inputMode="decimal" maxLength={26} required style={field}
                aria-invalid={form.price !== "" && !parseAmount(form.price)} onChange={event => update("price", event.target.value)} />
            </Field>
            <Field name={`${m.cap} (${unit})`} hint={capHint}>
              <input name="cap" value={form.cap} inputMode="decimal" maxLength={26} required style={field}
                aria-invalid={capIssue !== null && capIssue !== "incomplete"} onChange={event => update("cap", event.target.value)} />
            </Field>
            <Field name={m.mintWindow} hint={m.mintWindowHint}>
              <input name="hours" value={form.hours} inputMode="decimal" maxLength={7} required style={field}
                onChange={event => update("hours", event.target.value)} />
            </Field>
          </div>
          <div style={grid}>
            <Field name={m.poolShareInput} hint={m.poolShareHint}>
              <input name="poolShare" value={form.poolShare} inputMode="decimal" maxLength={5} required style={field}
                aria-invalid={percentBps(form.poolShare, 1000, 9000) === null} onChange={event => update("poolShare", event.target.value)} />
            </Field>
            <Field name={m.buyTax} hint={m.taxHint}>
              <input name="buyTax" value={form.buyTax} inputMode="decimal" maxLength={5} required style={field}
                aria-invalid={percentBps(form.buyTax, 0, 1000) === null} onChange={event => update("buyTax", event.target.value)} />
            </Field>
            <Field name={m.sellTax} hint={m.taxHint}>
              <input name="sellTax" value={form.sellTax} inputMode="decimal" maxLength={5} required style={field}
                aria-invalid={percentBps(form.sellTax, 0, 1000) === null} onChange={event => update("sellTax", event.target.value)} />
            </Field>
          </div>
          <p style={small}>{m.floorNote}</p>
        </fieldset>

        <aside style={card}>
          <h3 style={{ margin: 0, fontSize: 16 }}>{review ? m.reviewTitle : m.summary}</h3>
          <dl style={{ margin: 0, display: "grid", gap: 12 }}>
            <Datum name={m.token}>{shown ? `${shown.name} (${shown.symbol})` : m.unknown}</Datum>
            <Datum name={m.targetRaise}>{shown ? `${decimal(shown.cap)} ${unit}` : m.unknown}</Datum>
            <Datum name={m.nftCount}>{shown ? shown.nfts.toString() : m.unknown}</Datum>
            <Datum name={m.poolShare}>{shown ? `${shown.poolShareBps / 100}%` : m.unknown}</Datum>
            <Datum name={m.perPass}>{shown ? `${decimal(shown.perNft, 2)} ${shown.symbol}` : m.unknown}</Datum>
            <Datum name={m.tax}>{shown ? `${shown.buyTaxBps / 100}% / ${shown.sellTaxBps / 100}%` : m.unknown}</Datum>
            {review && canTransact && (
              <Datum name={m.creationFee}>{review.fee === null ? m.unknown : `${decimal(BigInt(review.fee))} ${unit}`}</Datum>
            )}
          </dl>
          <p role="status" style={{ ...small, color: ink, fontWeight: 600 }}>
            {review ? (canTransact ? (sameWallet ? m.confirmReady : m.prepareHelp) : m.reviewOnly) : draft ? m.draftReady : m.draftIncomplete}
          </p>
          {error && <p role="alert" style={{ ...small, color: danger }}>{error}</p>}
          <ReceiptLine receipt={receipt} m={m} />
          {created && (
            <>
              <dl style={{ margin: 0 }}><Datum name={m.launcher}>{created}</Datum></dl>
              {host?.openLauncher && (
                <button type="button" style={button()} onClick={() => host?.openLauncher?.(created)}>{m.openLauncher}</button>
              )}
            </>
          )}
          {waiting && host?.checkReceipt && (
            <button type="button" disabled={busy} style={button(busy)} onClick={() => void recheck()}>{m.checkReceipt}</button>
          )}
          {!waiting && !finished && (
            <div style={{ display: "grid", gap: 8 }}>
              {review && canTransact && (
                <button type="button" disabled={busy} style={button(busy)}
                  onClick={() => void (sameWallet && !wrongChain ? confirm() : prepare())}>
                  {busy ? m.working : primary}
                </button>
              )}
              <button type="button" disabled={reviewDisabled} style={button(reviewDisabled, !!review)}
                onClick={review ? () => { setReview(null); setPrepared(null); setError(null); } : () => void showReview()}>
                {review ? m.edit : busy ? m.working : m.reviewCreation}
              </button>
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}

export function Launcher({ context, messages: m, host }: DetailProps) {
  const [quantity, setQuantity] = useState("1");
  const [review, setReview] = useState<{ action: Action; account: string; valueWei?: string } | null>(null);
  const [result, setResult] = useState<{ account: string; action: Action; receipt: Submission } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);

  const { launcherAddress, snapshot, identity } = context;
  const unit = symbolFor(identity);
  const raised = units(snapshot?.raised);
  const target = units(snapshot?.targetRaise);
  const price = units(snapshot?.mintPrice);
  const maxPasses = units(snapshot?.maxPasses);
  const minted = units(snapshot?.minted);
  const deadline = units(snapshot?.saleDeadline);
  const perPass = units(snapshot?.tokensPerPass);
  const held = units(snapshot?.passes);
  const claimable = units(snapshot?.claimable);
  const refundable = units(snapshot?.refundable);
  const launched = snapshot?.launched === true;
  const refunding = snapshot?.refundAvailable === true;
  const token = snapshot?.token && addressPattern.test(snapshot.token) ? snapshot.token : null;

  const now = BigInt(Math.floor(Date.now() / 1000));
  const remaining = minted !== null && maxPasses !== null && maxPasses >= minted ? maxPasses - minted : null;
  const open = !launched && !refunding && deadline !== null && now < deadline && remaining !== null && remaining > 0n;
  const secondsLeft = open && deadline !== null ? deadline - now : null;
  const percent = minted !== null && maxPasses !== null && maxPasses > 0n ? Number(minted * 10_000n / maxPasses) / 100 : null;
  const status = launched ? m.statusLaunched : refunding ? m.statusRefunding : open ? m.statusOpen
    : snapshot ? m.statusClosed : m.unknown;
  const statusColor = launched ? good : refunding ? danger : open ? gold : dim;

  const maxNow = remaining === null ? 0n : remaining < maxMintPerCall ? remaining : maxMintPerCall;
  const count = maxNow > 0n ? parseCount(quantity, maxNow) : null;
  const cost = count !== null && price !== null ? count * price : null;

  const canTransact = supported(identity) && !!host?.wallet && !!host?.submit;
  const account = host?.wallet?.account?.toLowerCase();
  const wrongChain = host?.wallet?.chainId !== identity.chainId;
  const current = result?.account === account ? result : null;
  const receipt = shownReceipt(current?.receipt ?? null, host?.wallet?.pendingHash);
  const waiting = needsRecheck(receipt);
  const ready: Record<Action, boolean> = {
    mint: open && cost !== null && cost > 0n,
    claim: launched && claimable !== null && claimable > 0n,
    refund: refunding && refundable !== null && refundable > 0n,
  };
  const names: Record<Action, string> = { mint: m.mint, claim: m.claim, refund: m.refund };
  const offered = (["mint", "claim", "refund"] as const).filter(action => ready[action] || (action === "mint" && open));

  async function run(task: () => Promise<void>, fallback: string) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      await task();
    } catch (cause) {
      setError(errorText(cause, m, fallback));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  function settle(submission: Submission, action: Action, sender: string) {
    setResult({ account: sender, action, receipt: submission });
    if (submission.status === "success") host?.refresh?.();
  }

  function start(action: Action) {
    if (!canTransact || !account || wrongChain || !ready[action] || waiting || lock.current) return;
    setError(null);
    setReview({ action, account, ...(action === "mint" && cost !== null ? { valueWei: cost.toString() } : {}) });
  }

  const confirm = () => run(async () => {
    if (!review || !canTransact || wrongChain || account !== review.account || !ready[review.action] || waiting) return;
    if (review.action === "mint" && review.valueWei !== cost?.toString()) { setReview(null); return; }
    const { action, valueWei, account: sender } = review;
    setReview(null);
    setResult(null);
    const submission = await host?.submit?.({ kind: "action", action, ...(valueWei === undefined ? {} : { valueWei }) });
    if (submission) settle(submission, action, sender);
  }, m.submitError);

  const recheck = () => run(async () => {
    if (!account || !receipt || !isHash(receipt.hash)) return;
    const submission = await host?.checkReceipt?.(receipt.hash);
    if (submission) settle(submission, current?.action ?? "mint", account);
  }, m.receiptError);

  const switchChain = () => run(async () => { await host?.wallet?.switchChain(); }, m.walletUnavailable);

  const timeLeft = secondsLeft === null ? null
    : secondsLeft >= 86_400n ? `${secondsLeft / 86_400n}${m.days} ${(secondsLeft % 86_400n) / 3_600n}${m.hours}`
    : `${secondsLeft / 3_600n}${m.hours} ${(secondsLeft % 3_600n) / 60n}${m.minutes}`;

  return (
    <section style={shell} aria-label={m.detailTitle}>
      <Header title={m.detailTitle} intro={m.detailIntro} network={unit === "tBNB" ? m.testnet : m.mainnet} />
      <div style={body}>
        {!launcherAddress ? <p role="status" style={small}>{m.noLauncher}</p> : (
          <>
            <div style={card}>
              <div style={{ display: "flex", gap: 12, justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap" }}>
                <div>
                  <p style={caption}>{m.passesMinted}</p>
                  <p style={{ ...figure, fontSize: "clamp(26px, 7vw, 40px)", lineHeight: 1.1, fontWeight: 700 }}>
                    {minted === null || maxPasses === null ? m.unknown : `${minted} / ${maxPasses}`}
                  </p>
                </div>
                <span style={{
                  borderRadius: 16, padding: "4px 12px", border: `1px solid ${statusColor}`, color: statusColor, fontSize: 13, fontWeight: 700,
                }}>{status}</span>
              </div>
              {percent !== null && (
                <div role="progressbar" aria-label={m.passesMinted} aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}
                  style={{ height: 8, background: line, borderRadius: 8, overflow: "hidden" }}>
                  <div style={{ background: launched ? good : gold, width: `${percent}%`, height: "100%" }} />
                </div>
              )}
              <dl style={{ ...grid, margin: 0 }}>
                <Datum name={m.raised}>{raised === null ? m.unknown : `${decimal(raised)} ${unit}`}</Datum>
                <Datum name={m.targetRaise}>{target === null ? m.unknown : `${decimal(target)} ${unit}`}</Datum>
                <Datum name={m.mintPrice}>{price === null ? m.unknown : `${decimal(price)} ${unit}`}</Datum>
                <Datum name={m.perPass}>{perPass === null ? m.unknown : decimal(perPass, 2)}</Datum>
                {timeLeft && <Datum name={m.timeLeft}>{timeLeft}</Datum>}
                {launched && token && <Datum name={m.tokenAddress}>{token}</Datum>}
              </dl>
              {!snapshot && <p role="status" style={small}>{m.noData}</p>}
            </div>

            <p style={small}>{launched ? m.afterLaunch : refunding ? m.afterFailure : m.howItWorks}</p>

            {canTransact && (
              <section style={card} aria-label={m.yourPosition}>
                <h3 style={{ margin: 0, fontSize: 16 }}>{m.yourPosition}</h3>
                {!account ? (
                  <button type="button" style={button()} onClick={() => host?.wallet?.connect()}>{m.connectWallet}</button>
                ) : wrongChain ? (
                  <button type="button" disabled={busy} style={button(busy)} onClick={() => void switchChain()}>{m.switchChain}</button>
                ) : (
                  <>
                    <dl style={{ ...grid, margin: 0 }}>
                      <Datum name={m.yourPasses}>{held === null ? m.unknown : held.toString()}</Datum>
                      {launched && <Datum name={m.claimable}>{claimable === null ? m.unknown : decimal(claimable, 2)}</Datum>}
                      {refunding && <Datum name={m.refundable}>{refundable === null ? m.unknown : `${decimal(refundable)} ${unit}`}</Datum>}
                    </dl>
                    {open && (
                      <div style={{ ...grid, alignItems: "end" }}>
                        <Field name={m.quantity} hint={`${m.maxPerMint} ${maxNow}`}>
                          <input name="quantity" value={quantity} inputMode="numeric" maxLength={3} style={field}
                            aria-invalid={count === null} disabled={busy || waiting}
                            onChange={event => { setQuantity(event.target.value); setReview(null); setError(null); }} />
                        </Field>
                        <div>
                          <p style={caption}>{m.cost}</p>
                          <p style={figure}>{cost === null ? m.unknown : `${decimal(cost)} ${unit}`}</p>
                        </div>
                      </div>
                    )}
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      {offered.map(action => {
                        const disabled = busy || waiting || !ready[action];
                        return (
                          <button key={action} type="button" disabled={disabled} style={button(disabled, action !== "mint")}
                            onClick={() => start(action)}>{names[action]}</button>
                        );
                      })}
                    </div>
                    {review && (
                      <div style={{ borderBlockStart: `1px solid ${line}`, paddingBlockStart: 14, display: "grid", gap: 10 }}>
                        <p style={{ margin: 0, fontWeight: 600 }}>{m.reviewAction}: {names[review.action]}</p>
                        {review.valueWei && <p style={small}>{m.youSend} {decimal(BigInt(review.valueWei))} {unit}</p>}
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          <button type="button" disabled={busy} style={button(busy)} onClick={() => void confirm()}>
                            {busy ? m.working : m.confirm}
                          </button>
                          <button type="button" disabled={busy} style={button(busy, true)} onClick={() => setReview(null)}>{m.cancel}</button>
                        </div>
                      </div>
                    )}
                  </>
                )}
                {error && <p role="alert" style={{ ...small, color: danger }}>{error}</p>}
                <ReceiptLine receipt={receipt} m={m} />
                {waiting && host?.checkReceipt && (
                  <button type="button" disabled={busy} style={button(busy, true)} onClick={() => void recheck()}>{m.checkReceipt}</button>
                )}
              </section>
            )}
          </>
        )}
      </div>
    </section>
  );
}
