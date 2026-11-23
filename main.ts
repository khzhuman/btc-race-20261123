// Level Buyer — a BTC race bot for btc-race-24h-20261123-0511.
//
// Idea, in one sentence: wait for BTC to come down to a level it has
// actually traded at all day, buy everything there, take the money at
// +1.5%, then wait for the level (or a small dip below the last sale)
// to come back. If the level never shows up by bar 1260, just buy and
// hold to the end instead of sitting in cash.
//
// Levels (chosen from the live tape on 23 Nov 2026, ~14:30 WIB):
//   - Live BTC was $61,417 (CoinGecko). The dev window ran $58,669 to
//     $61,655 and spent most of its hours consolidating $60,600-60,800.
//   - Absolute trigger $60,000: a round level ~2.3% below the live
//     price, inside that consolidation band, crossed 53 times in the
//     dev window. Backtest on the dev bars: +$37.77 on $1,000.
//   - Take profit +1.5% above the fill price; a full round trip costs
//     ~26 bps, so each completed cycle nets ~+1.24%.
//   - Rebuy dip: 0.5% below the last sale price, so a choppy tape
//     keeps cycling even while it never revisits $60,000.
//   - No stop-loss, no leverage, no shorts (long only, per the rules).

import { runBars, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const TRIGGER_USD = 60000n; // absolute buy level, in whole USDC
const TAKE_PROFIT_NUM = 1015n; // sell at +1.5% over the fill price
const TAKE_PROFIT_DEN = 1000n;
const DIP_NUM = 995n; // rebuy 0.5% below the last sale price
const DIP_DEN = 1000n;
const FALLBACK_BAR = 1260; // buy-and-hold if the level never came
const MAX_SLIPPAGE_BPS = 100;

let entryPrice: bigint | null = null;
let lastSellPrice: bigint | null = null;
let triggerRaw: bigint | null = null;

await runBars({
  onBatch(state, batch) {
    // Learn the fill price of any buy that landed on this batch, so
    // the take-profit is measured from what we actually paid, not
    // from the close we decided on.
    for (const fill of batch.fills) {
      if (fill.symbol === SYMBOL && fill.side === 'buy' && fill.status === 'filled') {
        entryPrice = BigInt(fill.price);
      }
      if (fill.symbol === SYMBOL && fill.side === 'sell' && fill.status === 'filled') {
        lastSellPrice = BigInt(fill.price);
        entryPrice = null;
      }
    }

    if (state.warmingUp) return [];
    const close = state.close(SYMBOL);
    if (close === null) return [];

    if (triggerRaw === null) {
      const meta = state.symbols.get(SYMBOL);
      if (meta === undefined) return [];
      triggerRaw = TRIGGER_USD * 10n ** BigInt(meta.price_scale);
    }

    const held = state.positions.get(SYMBOL);
    const qty = held === undefined ? 0n : held.qty;

    if (qty > 0n) {
      // Long: sell everything once the tape pays +1.5% over our fill.
      if (entryPrice !== null && close >= (entryPrice * TAKE_PROFIT_NUM) / TAKE_PROFIT_DEN) {
        return [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies SellInput];
      }
      return [];
    }

    // Flat: buy all-in at the absolute level, on a dip below the last
    // sale, or at the fallback bar (buy-and-hold to the end).
    const atLevel = close <= triggerRaw;
    const onDip = lastSellPrice !== null && close <= (lastSellPrice * DIP_NUM) / DIP_DEN;
    const fallback = state.seq >= FALLBACK_BAR;
    if (!atLevel && !onDip && !fallback) return [];

    const spend = state.cash < state.weightRoom(SYMBOL) ? state.cash : state.weightRoom(SYMBOL);
    if (spend < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: spend, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies BuyInput];
  },
});
