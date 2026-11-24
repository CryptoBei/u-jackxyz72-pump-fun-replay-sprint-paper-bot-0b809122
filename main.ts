// pump-fun replay paper bot: early sniper with fast exits and a completion ride.
//
// The grader runs `node /bot/main.ts`. The strategy lives in strategy.ts and the
// protocol shim is the kit's sdk/ts/makefun-bot.ts, vendored byte for byte as
// vendor/makefun-bot.ts (the kit's own file, kept out of the authorship counts).
//
// One trade per coin: buy early, once the launch proves it is not an instant rug
// (real SOL built up, creator has not sold, a few distinct buyers in), then exit
// fast on a take-profit, a stop-loss, a trailing stop, a time limit, or a creator
// sell. A coin whose real SOL reserve grows near completion is ridden longer:
// the few coins that complete are where the big multiples live, and the dev
// window shows completers peaking near 14.7x their create price while the median
// coin never gets past 1.24x.
//
// Deterministic by construction: no clock, no environment reads, no randomness;
// iteration only over insertion-ordered maps fed by the batch stream.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
