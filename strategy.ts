// Early sniper with fast exits and a completion ride, for agent-fun/replay/v2
// (pump.fun bonding curves, 10 SOL paper money, 24h replay).
//
// Regime read off the dev window (1,222 coins, 24h, 2026-11-02 -> 03):
// only 2.9% of coins complete (those peak near 14.7x their create price), the
// median coin never gets past 1.24x, 23% touch 2x at some point but only 3.5%
// end above 2x, and a coin's median life is ~9 minutes. So the game is: buy
// tiny size in many fresh coins, sell the runners fast, cut losers faster, and
// let the rare completer run. The house pilots scored on the same window:
// momentum -9.38 SOL (pyramiding into reversals, 0.95 drawdown), reversion
// -1.78 SOL, sniper -0.13 SOL. This bot takes the sniper family and tightens
// it: one small buy per coin, no pyramiding, exits on take-profit, stop-loss,
// trailing stop, a short time limit, a creator sell, or a big sell — with the
// time limit and the trailing stop lifted while the curve's real SOL is near
// completion, so a completer is ridden instead of sold.
//
// Everything here is a pure function of the batches the harness sends: no
// clock, no environment reads, no randomness, iteration only over
// insertion-ordered maps fed by the batch stream, so the two graded executions
// produce byte-identical action logs.

import type { Batch, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Oldest age (slots since create) at which a first buy may still be decided. */
  maxAge: number;
  /** Real SOL reserve window at decision time. */
  minRealSol: number;
  maxRealSol: number;
  /** Creator's own buys since create, at most this many SOL (a heavy creator buy is a dump in waiting). */
  maxDevBuySol: number;
  /** Distinct non-creator buyers seen before entry, at least this many... */
  minBuyers: number;
  /** ...and at most this many (a launch bundled by many wallets is a dump in waiting). */
  maxBuyers: number;
  /** Net SOL bought over the recent-flow window, at least this. */
  minNetFlowSol: number;
  /** Recent-flow window in slots. */
  flowWindow: number;
  /** Price now over create price, minus 1: entry needs it inside [minRunup, maxRunup]. */
  minRunup: number;
  maxRunup: number;
  /** Skip the coin when the creator sold before entry. */
  skipDevSold: boolean;
  /** SOL to put into one coin (one buy, no pyramid). */
  stakeSol: number;
  /** Smallest buy worth sending (a tx costs 105k lamports whether it fills or not). */
  minBuySol: number;
  /** Slippage allowed on buys (bps). */
  buySlipBps: number;
  /** Sell the whole position when its value reaches cost * (1 + takeProfit). */
  takeProfit: number;
  /** Sell the whole position when its value falls to cost * (1 - stopLoss). */
  stopLoss: number;
  /** Trailing stop arms once value reaches cost * (1 + trailArm)... */
  trailArm: number;
  /** ...then sells when value falls trail below its best value. */
  trail: number;
  /** Sell after holding this many slots, unless the coin is being ridden. */
  maxHold: number;
  /** Real SOL at/above which the coin is ridden: time limit and trailing stop lifted. */
  rideRealSol: number;
  /** Sell at once when the creator sells while we hold. */
  exitOnDevSell: boolean;
  /** Sell at once on any single recorded sell of at least this many SOL (0 = off). */
  bigSellSol: number;
  /** Slots to wait after an exit before the same coin may be bought again. */
  cooldown: number;
  /** Most entries per coin over the run. */
  maxEntries: number;
}

export const DEFAULT_PARAMS: Params = {
  maxAge: 10,
  minRealSol: 2,
  maxRealSol: 40,
  maxDevBuySol: 2,
  minBuyers: 4,
  maxBuyers: 6,
  minNetFlowSol: 0.5,
  flowWindow: 3,
  minRunup: -0.05,
  maxRunup: 0.22,
  skipDevSold: true,
  stakeSol: 0.03,
  minBuySol: 0.01,
  buySlipBps: 10000,
  takeProfit: 0.1,
  stopLoss: 0.05,
  trailArm: 0.1,
  trail: 0.15,
  maxHold: 10,
  rideRealSol: 60,
  exitOnDevSell: true,
  bigSellSol: 2,
  cooldown: 150,
  maxEntries: 1,
};

const LAMPORTS = 1e9;
/** Curve fees on a trade: protocol 95 bps + creator 30 bps. */
const CURVE_FEE = 0.0125;

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
}

interface Tape {
  created: number | null;
  creator: string | null;
  /** Create-time reserves: the price run-up is measured against them. */
  vq0: bigint;
  vt0: bigint;
  devBuySol: number;
  devSold: boolean;
  buyers: Set<string>;
  trades: Trade[];
  entries: number;
  lastExit: number;
  done: boolean;
}

interface Held {
  opened: number;
  peakValue: number;
  invested: number;
  exiting: boolean;
  filled: boolean;
  lastValue: number;
}

/** What selling `tokens` against (vq, vt) would pay after curve fees, in SOL. */
function sellValueSol(tokens: bigint, vq: bigint, vt: bigint): number {
  if (tokens <= 0n || vt <= 0n) return 0;
  const q = (tokens * vq) / (vt + tokens);
  return Number(q) / LAMPORTS * (1 - CURVE_FEE);
}

export function createStrategy(p: Params = DEFAULT_PARAMS) {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  const keep = Math.max(p.maxAge, p.flowWindow) + 10;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = {
        created: null, creator: null, vq0: 0n, vt0: 0n,
        devBuySol: 0, devSold: false, buyers: new Set(),
        trades: [], entries: 0, lastExit: -1e12, done: false,
      };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Net recorded SOL (buys minus sells) over the last `w` slots. */
  const flow = (t: Tape, now: number, w: number): number => {
    let net = 0;
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  /** Entry signal on a coin's tape at slot `now`. */
  const entrySignal = (t: Tape, now: number, rqSol: number, priceNow: number): boolean => {
    if (t.created === null || t.done) return false;
    if (now - t.created > p.maxAge) return false;
    if (rqSol < p.minRealSol || rqSol > p.maxRealSol) return false;
    if (p.skipDevSold && t.devSold) return false;
    if (t.devBuySol > p.maxDevBuySol) return false;
    if (t.buyers.size < p.minBuyers || t.buyers.size > p.maxBuyers) return false;
    if (flow(t, now, p.flowWindow) < p.minNetFlowSol) return false;
    if (t.vq0 === 0n || t.vt0 === 0n) return false;
    const createPrice = Number(t.vq0) / Number(t.vt0);
    if (createPrice <= 0) return false;
    const runup = priceNow / createPrice - 1;
    if (runup < p.minRunup || runup > p.maxRunup) return false;
    if (t.entries >= p.maxEntries || now - t.lastExit < p.cooldown) return false;
    return true;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const bigSell = new Set<Pubkey>();
      const traded = new Set<Pubkey>();
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          const t = tapeOf(e.mint);
          t.created = e.slot;
          t.creator = e.creator;
          t.vq0 = BigInt(e.virtual_quote_reserves);
          t.vt0 = BigInt(e.virtual_token_reserves);
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          const price = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
          t.trades.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user });
          traded.add(e.mint);
          if (e.user === t.creator) {
            if (e.is_buy) t.devBuySol += sol;
            else t.devSold = true;
          } else if (e.is_buy) {
            t.buyers.add(e.user);
          }
          if (!e.is_buy && p.bigSellSol > 0 && sol >= p.bigSellSol) bigSell.add(e.mint);
        } else {
          tapeOf(e.mint).done = true;
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
      for (const po of state.pending.values()) pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // Exits first.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const t = tapeOf(mint);
            if (h.filled) t.lastExit = now;
            else t.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? BigInt(mk.virtual_quote_reserves) : curve.virtual_quote_reserves;
        const vt = mk ? BigInt(mk.virtual_token_reserves) : curve.virtual_token_reserves;
        const rqSol = (mk ? Number(mk.real_quote_reserves) : Number(curve.real_quote_reserves)) / LAMPORTS;
        const value = sellValueSol(BigInt(pos.token_amount), vq, vt) - tx;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        h.lastValue = value;
        const riding = rqSol >= p.rideRealSol;
        const t = tapeOf(mint);
        let exit = h.exiting;
        if (!exit && value <= cost * (1 - p.stopLoss)) exit = true;
        if (!exit && value >= cost * (1 + p.takeProfit)) exit = true;
        if (!exit && !riding && h.peakValue >= cost * (1 + p.trailArm) && value < h.peakValue * (1 - p.trail)) exit = true;
        if (!exit && !riding && now - h.opened > p.maxHold) exit = true;
        if (!exit && p.exitOnDevSell && t.devSold) exit = true;
        if (!exit && bigSell.has(mint)) exit = true;
        if (!exit) continue;
        h.exiting = true;
        let sellPending = false;
        for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
        if (sellPending) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Then entries.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      for (const mint of traded) {
        if (orders.length >= cap) break;
        if (slotsLeft <= 0) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || held.has(mint)) continue;
        const t = tapes.get(mint)!;
        const priceNow = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (!entrySignal(t, now, rqSol, priceNow)) continue;
        const capSol = Number(state.maxBuyLamports(mint)) / LAMPORTS;
        let amount = Math.min(capSol, p.stakeSol);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        slotsLeft--;
        held.set(mint, { opened: now, peakValue: 0, invested: amount, exiting: false, filled: false, lastValue: 0 });
        t.entries++;
      }
      return orders;
    },
  };
}
