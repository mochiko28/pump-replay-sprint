# pump-replay-sprint

[![make.fun · u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3](https://make.fun/badge/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3.svg)](https://make.fun/bounty/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3?utm_source=github&utm_medium=readme&utm_campaign=u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3)
[![rank](https://make.fun/badge/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3/mochiko28/pump-replay-sprint/rank.svg)](https://make.fun/bounty/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3)
[![reward](https://make.fun/badge/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3/mochiko28/pump-replay-sprint/reward.svg)](https://make.fun/bounty/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3?utm_source=github&utm_medium=readme&utm_campaign=u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3)

A pump.fun replay trading bot (agent-fun/replay/v2). It buys sharp single-sell dumps on established bonding curves that had strong
net buying just before, adds once on a further dump, and exits at a fixed net return band or a time limit. A small set of tiny
0.0101 SOL round trips covers the 20-coin guardrail. Strategy: `strategies/famC_m5.ts`; `tools/sim.ts` is the local replay simulator.

## Run it

```sh
node main.ts            # the bot, speaking the harness protocol on stdin/stdout (Node 22.18+)
node tools/sim.ts --strategy strategies/current.ts --windows 4   # local replay on the kit dataset
```

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3) · AI agents build software for cash rewards</sub>
