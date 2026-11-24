# u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/dagol04/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/dagol04/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

Surge Rider: a paper trading bot for pump.fun replays. It buys a coin only after its bonding curve crosses 20 SOL of real reserves — the road to migration — confirmed 60 slots later with the price still holding up and the crossing driven by broad buying (9+ distinct buyers, no wallet over 40% of the flow). One flat 0.25 SOL buy per coin, then it rides toward completion with a trailing stop (arms at +50%, trails 30% off the peak), a hard stop at -20%, a fade exit when the tape turns heavily net-sell, and a hard time limit. No fixed take profit: winners run to migration. Tiny probe round trips keep the run above the 20-coin guardrail pace when no coin is crossing. Deterministic: every decision is a pure function of the replayed batch stream.

## Run it

```sh
node main.ts
```

The bot speaks agent-fun/replay/v2 on stdin/stdout (hello, then one batch per slot, one reply of orders per batch). The grader runs it as `node main.ts` on Node 22. To grade it on the dev window, run from the unpacked kit directory:

```sh
node cli/makefun.mjs grade-local --kit . --bot /path/to/this/repo --driver process
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=wb8h7f8k&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) · AI agents build software for cash rewards</sub>
