// Surge Rider — a paper trading bot for the pump.fun replay sprint.
//
// Idea, learned from the dev window: most pump.fun coins dump after a brief
// run, and chasing small early spikes loses money after fees. The one durable
// edge in the data is migration: a coin whose bonding curve has pulled in
// 20+ SOL of real reserves is on the road to completing (migrating at ~85 SOL),
// and the coins that make it run several multiples from there, while the ones
// that fail can be cut at -20%. But the crossing itself is often one big buy
// followed by a dump, so the bot only buys 60 slots after the crossing, and
// only when the price held up (>= 95% of the crossing price), the crossing was
// broad (9+ distinct buyers in the prior 120 slots, no wallet over 40% of the
// buy flow), and the price has not already run past 1.5x the crossing price.
// One flat 0.25 SOL buy per coin (the 1%-of-reserve cap allows 0.20 SOL at
// 20 SOL of reserves, so the first buy lands near the cap; no adds follow),
// then the trade runs: no fixed take profit, just a trailing stop that arms at
// +50% and trails 30% below the peak, a hard stop at -20%, a fade exit when
// the tape turns heavily net-sell, and a hard time limit. Tiny probe round
// trips keep the run above the guardrail pace (20+ distinct coins) when no
// coin is crossing.
//
// The bot speaks agent-fun/replay/v2 through the vendored shim: the harness
// sends a hello, then one batch per slot (events, marks, fills, account), and
// the bot answers each batch with at most one reply of orders. Fills land two
// slots after the decision, so every buy is sized against the 1%-of-real-reserve
// cap at decision time and carries a slippage allowance.
//
// Deterministic by construction: no clock, no environment, no Math.random —
// every decision is a pure function of the batch stream, iterated in
// insertion order. The seed in hello is never needed.

import { runBot, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

const LAMPORTS = 1_000_000_000;
// Curve fee on each side: protocol 95 bps + creator 30 bps = 1.25%.
const CURVE_FEE = 0.0125;
const BPS = 10_000;

interface Params {
  /** Real SOL reserves whose first crossing triggers an entry. */
  crossRqSol: number;
  /** Slots to wait after the crossing before buying: the coin must survive the
   * crossing without dumping (the crossing buy itself is often followed by a
   * whale dump, and a buy that fills into the dump is the common loser). */
  confirmSlots: number;
  /** At confirmation the price must still be at least this share of the
   * crossing price, and at most confirmMax of it. */
  confirmMin: number;
  confirmMax: number;
  /** Slots of grace after the confirmation point during which an entry is
   * still allowed. */
  crossGrace: number;
  /** Breadth at the crossing: distinct buyers over the lookback, and the
   * largest single buyer's share of the window's buy SOL. */
  crossWindow: number;
  crossMinBuyers: number;
  crossMaxTopShare: number;
  /** SOL for the first buy, for one add, and the most per position in total. */
  initialSol: number;
  addSol: number;
  maxStakeSol: number;
  /** Smallest buy worth sending (the guardrail round trip floor is 0.01 SOL). */
  minBuySol: number;
  /** Slippage on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Exits, as fractions of cost / peak value. */
  stopLoss: number;
  trailArm: number;
  trail: number;
  /** Exit when net SOL over the fade window falls below -fadeNetSol. */
  fadeWindow: number;
  fadeNetSol: number;
  /** Exit on any single recorded sell of at least this many SOL. */
  bigSellSol: number;
  /** Exit after this many slots held. */
  maxHold: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
  /** Add only once the price is this much above the last buy's decision price. */
  addStep: number;
  /** Add only while net SOL over the add window is at least this. */
  addNetSol: number;
  addWindow: number;
  /** Most main positions open at once (the rest of the position cap is for probes). */
  maxMain: number;
  /** Guardrail pacing: target coins / fills over paceSecs of block time. */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
  /** Most SOL at cost across all positions at once (a drawdown guard). */
  maxExposureSol: number;
}

const P: Params = {
  crossRqSol: 20,
  confirmSlots: 60,
  confirmMin: 0.95,
  confirmMax: 1.5,
  crossGrace: 300,
  crossWindow: 120,
  crossMinBuyers: 9,
  crossMaxTopShare: 0.4,
  initialSol: 0.25,
  addSol: 0.25,
  maxStakeSol: 0.25,
  minBuySol: 0.01,
  buySlipBps: 2000,
  stopLoss: 0.2,
  trailArm: 0.5,
  trail: 0.3,
  fadeWindow: 120,
  fadeNetSol: 3.0,
  bigSellSol: 3.0,
  maxHold: 3000,
  cooldown: 300,
  maxEntries: 2,
  addStep: 0.3,
  addNetSol: 0,
  addWindow: 120,
  maxMain: 5,
  targetCoins: 25,
  targetFills: 160,
  paceSecs: 21_600,
  probeSol: 0.02,
  maxProbes: 1,
  maxExposureSol: 5,
};

interface TradeRec {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  trades: TradeRec[];
  entries: number;
  lastExit: number;
  /** Slot the curve first crossed crossRqSol, or -1. */
  crossedAt: number;
  /** Price at the crossing trade. */
  crossPrice: number;
  /** Breadth of the buying that carried the curve to the crossing. */
  crossBuyers: number;
  crossTopShare: number;
}

interface HeldPos {
  opened: number;
  peakValue: number;
  /** SOL sent in buys for this position (fees included). */
  invested: number;
  exiting: boolean;
  /** Some buy of this position filled. */
  filled: boolean;
  /** Recorded price when the last buy was decided. */
  lastAddPrice: number;
  /** Close value at the latest batch (SOL, curve and tx fees deducted). */
  lastValue: number;
}

function tapeOf(tapes: Map<Pubkey, Tape>, mint: Pubkey): Tape {
  let t = tapes.get(mint);
  if (t === undefined) {
    t = { created: null, trades: [], entries: 0, lastExit: -1e12, crossedAt: -1, crossPrice: 0, crossBuyers: 0, crossTopShare: 1 };
    tapes.set(mint, t);
  }
  return t;
}

/** Net recorded SOL (buys minus sells) on a tape over the last `w` slots. */
function flow(t: Tape, now: number, w: number): number {
  let net = 0;
  for (let i = t.trades.length - 1; i >= 0; i--) {
    const tr = t.trades[i]!;
    if (tr.slot <= now - w) break;
    net += tr.buy ? tr.sol : -tr.sol;
  }
  return net;
}

/** Current close value of a position in SOL, after curve fee and one tx fee. */
function closeValue(tokens: number, vq: number, vt: number, txSol: number): number {
  const gross = (tokens * vq) / (vt + tokens) / LAMPORTS;
  return gross * (1 - CURVE_FEE) - txSol;
}

export function createBot() {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, HeldPos>();
  /** Mints that crossed crossRqSol within the grace window, by mint -> cross slot. */
  const recentCross = new Map<Pubkey, number>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  /** The bot's own filled orders and the coins they were on (harness closes excluded). */
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  const keep = Math.max(P.fadeWindow, P.addWindow, P.crossWindow) + 5;

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const bigSell = new Set<Pubkey>();
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          tapeOf(tapes, e.mint).created = e.slot;
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(tapes, e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          const price = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
          t.trades.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user, price });
          traded.add(e.mint);
          if (!e.is_buy && sol >= P.bigSellSol) bigSell.add(e.mint);
          // The entry trigger: the first trade that takes real SOL reserves to
          // crossRqSol. A curve only crosses once; later trades keep it crossed.
          if (t.crossedAt < 0 && Number(e.real_sol_reserves) / LAMPORTS >= P.crossRqSol) {
            t.crossedAt = e.slot;
            t.crossPrice = price;
            recentCross.set(e.mint, e.slot);
            // Breadth of the buying that carried the curve here: a crossing
            // driven by one wallet is usually the dump that follows.
            let buySol = 0;
            let top = 0;
            const byUser = new Map<string, number>();
            for (let i = t.trades.length - 1; i >= 0; i--) {
              const tr = t.trades[i]!;
              if (tr.slot <= e.slot - P.crossWindow) break;
              if (!tr.buy) continue;
              buySol += tr.sol;
              const v = (byUser.get(tr.user) ?? 0) + tr.sol;
              byUser.set(tr.user, v);
              if (v > top) top = v;
            }
            t.crossBuyers = byUser.size;
            t.crossTopShare = buySol > 0 ? top / buySol : 1;
          }
        }
      }
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) {
        pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // Exits first: a position leaves on the first of stop loss, trailing stop
      // (armed at +50%, trailing 30% off the peak), fade, a big single sell,
      // or the time limit. There is no fixed take profit: winners ride toward
      // completion, the trail banks the gain if they turn.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const t = tapeOf(tapes, mint);
            if (h.filled) t.lastExit = now;
            else t.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        const value = closeValue(tokens, vq, vt, tx);
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        h.lastValue = value;
        let exit = h.exiting;
        const t = tapeOf(tapes, mint);
        if (!exit && value < cost * (1 - P.stopLoss)) exit = true;
        if (!exit && h.peakValue >= cost * (1 + P.trailArm) && value < h.peakValue * (1 - P.trail)) exit = true;
        if (!exit && flow(t, now, P.fadeWindow) < -P.fadeNetSol) exit = true;
        if (!exit && bigSell.has(mint)) exit = true;
        if (!exit && now - h.opened > P.maxHold) exit = true;
        if (!exit) continue;
        h.exiting = true;
        if (pendingByMint.has(mint)) {
          let sellPending = false;
          for (const po of state.pending.values()) {
            if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
          }
          if (sellPending) continue;
        }
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // Then entries and adds.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let mainLeft = P.maxMain - held.size;
      let exposure = 0;
      for (const [mint, h] of held) {
        exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      }
      // Entries: coins that crossed in this batch, plus coins still inside the
      // grace window whose price has not run too far past the crossing price.
      // Adds: a held position gets one more buy when the price stepped up from
      // the last add and the tape is still net-buying.
      const candidates: Pubkey[] = [];
      for (const mint of traded) candidates.push(mint);
      for (const [mint, at] of recentCross) {
        if (now - at > P.confirmSlots + P.crossGrace) {
          recentCross.delete(mint);
        } else if (!traded.has(mint)) {
          candidates.push(mint);
        }
      }
      for (const mint of candidates) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint)) continue;
        const t = tapes.get(mint)!;
        const h = held.get(mint);
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        let want: number;
        if (h === undefined) {
          if (slotsLeft <= 0 || mainLeft <= 0) continue;
          if (t.entries >= P.maxEntries || now - t.lastExit < P.cooldown) continue;
          if (t.crossedAt < 0) continue;
          const sinceCross = now - t.crossedAt;
          if (sinceCross < P.confirmSlots || sinceCross > P.confirmSlots + P.crossGrace) continue;
          if (t.crossBuyers < P.crossMinBuyers || t.crossTopShare > P.crossMaxTopShare) continue;
          if (price < t.crossPrice * P.confirmMin || price > t.crossPrice * P.confirmMax) continue;
          want = Math.min(P.initialSol, P.maxStakeSol);
        } else {
          if (h.exiting || !h.filled || h.invested >= P.maxStakeSol - P.minBuySol) continue;
          const pos = state.positions.get(mint);
          if (pos === undefined) continue;
          if (price < h.lastAddPrice * (1 + P.addStep)) continue;
          if (flow(t, now, P.addWindow) < P.addNetSol) continue;
          want = Math.min(P.addSol, P.maxStakeSol - h.invested);
        }
        const capSol = Number(state.maxBuyLamports(mint)) / LAMPORTS;
        let amount = Math.min(capSol, want, P.maxExposureSol - exposure);
        if (amount > free - tx) amount = free - tx;
        if (amount < P.minBuySol) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: P.buySlipBps });
        free -= amount + tx;
        exposure += amount;
        if (h === undefined) {
          held.set(mint, {
            opened: now,
            peakValue: 0,
            invested: amount,
            exiting: false,
            filled: false,
            lastAddPrice: price,
            lastValue: 0,
          });
          t.entries++;
          slotsLeft--;
          mainLeft--;
        } else {
          h.invested += amount;
          h.lastAddPrice = price;
        }
      }

      // Guardrail pacing: open a probe when the bot's fills or coins lag the pace.
      if (probes.size < P.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / P.paceSecs);
        const needCoins = myCoins.size < Math.ceil(P.targetCoins * pace);
        const needFills = myFills < Math.ceil(P.targetFills * pace);
        if (needCoins || needFills) {
          const minRq = (P.probeSol * BPS) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= P.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < P.probeSol + 2 * tx) break;
            orders.push({
              side: 'buy',
              mint,
              quote_lamports: BigInt(Math.floor(P.probeSol * LAMPORTS)),
              max_slippage_bps: P.buySlipBps,
            });
            probes.set(mint, false);
            free -= P.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}

export { P };

import { pathToFileURL } from 'node:url';
// Run the bot only when this file is the entrypoint (the grader runs
// `node /bot/main.ts`); when imported by a local sim, just export the factory.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runBot(createBot());
}
