# probe comparison

| metric | d1-p4<br>`b11627-8c2134a87` | d1-p4<br>`b11627-8c2134a87` | d1-p1<br>`b11627-8c2134a87` |
|---|---|---|---|
| model | LiquidAI/d1-3B-GGUF:Q8_0 | LiquidAI/d1-3B-GGUF:Q8_0 | LiquidAI/d1-3B-GGUF:Q8_0 |
| build_info | b11627-8c2134a87 | b11627-8c2134a87 | b11627-8c2134a87 |
| n_slots | 4 | 4 | 1 |
| n_ctx | 8192 | 8192 | 32768 |
| n_ctx_slot | 8192 | 8192 | 32768 |
| machine | Jetson Orin NX 16GB, JetPack 7.2.1 | Jetson Orin NX 16GB, JetPack 7.2.1 | Jetson Orin NX 16GB, JetPack 7.2.1 |
| stack | llama.cpp llama-server | llama.cpp llama-server | llama.cpp llama-server |
| revision | 8c2134a8755d8a9792af513dab20282affe903e4 | 8c2134a8755d8a9792af513dab20282affe903e4 | 8c2134a8755d8a9792af513dab20282affe903e4 |
| notes | --parallel 4, -b 2048 -ub 512 (defaults), -c 32768 (8192/slot); PARTIAL RUN: core+concurrency only - sharing/ceiling/envelope not recorded (killed when the -c provenance mismatch was caught) | --parallel 4, -b 2048 -ub 512 (defaults), -c 32768 (8192/slot = n_ctx_train/4) | --parallel 1, -b 2048 -ub 512 (defaults), -c 32768 (32768/slot) |
| provenance check | ok | ok | ok |
| crashes during run | 0 | 0 | 0 |
| tok/question (toy state) n=1 | 39.0 | 39.0 | 39.0 |
| tok/question (toy state) n=4 | 39.0 | 39.0 | 39.0 |
| tok/question (toy state) n=12 | 39.0 | 39.0 | 39.0 |
| n_ubatch reported by the server |  |  |  |
| latency n=1 | 0.1622 | 0.0833 | 0.0949 |
| latency n=4 | 0.279 | 0.2038 | 0.2871 |
| latency n=8 | 0.448 | 0.3937 | 0.5638 |
| latency n=12 | 0.6501 | 0.5902 | 0.8411 |
| marginal ms/question (1->2) | 75.2 | 73.5 | 53.5 |
| marginal ms/question (4->6) | 74.6 | 63.5 | 69.5 |
| realistic 1q latency | 0.1955 | 0.1827 | 0.1868 |
| realistic 1q tokens | 187 | 187 | 187 |
| realistic 2q latency | 0.3208 | 0.3145 | 0.359 |
| realistic 2q tokens | 377 | 377 | 377 |
| realistic 4q latency | 0.4877 | 0.4845 | 0.7005 |
| realistic 4q tokens | 727 | 727 | 727 |
| realistic 4q readings | {"blast_radius": 0.8895, "credential": 0.9793, "intent": 0.9154, "reversible": 0.9052} | {"blast_radius": 0.8895, "credential": 0.9793, "intent": 0.9148, "reversible": 0.9031} | {"blast_radius": 0.8882, "credential": 0.9788, "intent": 0.9185, "reversible": 0.9005} |
| multiseq max drift vs alone (x4) | 0.0047 | 0.0037 | 0.0 |
| multiseq max drift vs alone (x2) | 0.004 | 0.0059 | 0.0 |
| same question x8 spread | 0.0 | 0.0017 | 0.0 |
| 1 choice x4 options: latency / tok | 0.2605 / 221 | 0.2027 / 221 | 0.2062 / 221 |
| 4 noul: latency / tok | 0.5402 / 727 | 0.4952 / 727 | 0.7049 / 727 |
| determinism: distinct answer sets | 1 | 1 | 1 |
| envelope: largest ok tok/question (n=1) | 2239 |  | 2239 |
| envelope: largest ok tok/question (n=2) | 2239 |  | 2239 |
| envelope: largest ok tok/question (n=4) | 2239 |  | 2239 |
| envelope: largest ok TOTAL tokens (n=2) | 4478 |  | 4478 |
| envelope: largest ok TOTAL tokens (n=4) | 8956 |  | 8956 |
| real compute n=1: computed / reported tok | 656 / 656 |  | 655 / 655 |
| prefix reuse n=1 (inherited / reported) | 0 / 656 in 0/1 tasks |  | 0 / 655 in 0/1 tasks |
| real compute n=2: computed / reported tok | 872 / 1312 |  | 1310 / 1310 |
| prefix reuse n=2 (inherited / reported) | 440 / 1312 in 1/2 tasks |  | 0 / 1310 in 0/2 tasks |
| real compute n=4: computed / reported tok | 1304 / 2624 |  | 1967 / 2624 |
| prefix reuse n=4 (inherited / reported) | 1320 / 2624 in 3/4 tasks |  | 0 / 1967 in 0/3 tasks |
| real compute n=8: computed / reported tok | 3052 / 5240 |  | 3936 / 5248 |
| prefix reuse n=8 (inherited / reported) | 1756 / 4808 in 4/8 tasks |  | 0 / 3936 in 0/6 tasks |

## state sharing: can N questions ride one forward pass? (cold cache)

factor = latency(n=4) / latency(n=1) at that state size: ~4.0 = every question re-reads the state (not Jev-like), ~1.0 = the state is read once and the questions ride that pass (Jev-like).

| run | state tokens | L1 s | L2 s | L4 s | L8 s | factor L4/L1 | ms/extra q (1->4) | verdict |
|---|---|---|---|---|---|---|---|---|
| d1-p4 | 15 | 0.0841 | 0.1764 | 0.2228 | 0.435 | 2.65 | 46.2 | tail-dominated state: not informative |
| d1-p4 | 183 | 0.2024 | 0.2832 | 0.3209 | 0.6299 | 1.59 | 39.5 | partial (batched pass or partial sharing) |
| d1-p4 | 465 | 0.3865 | 0.4787 | 0.5199 | 1.0356 | 1.35 | 44.5 | partial (batched pass or partial sharing) |
| d1-p4 | 915 | 0.6931 | 0.7846 | 0.8271 | 1.634 | 1.19 | 44.7 | partial (batched pass or partial sharing) |
| d1-p1 | 15 | 0.0884 | 0.1619 | 0.3113 | 0.6097 | 3.52 | 74.3 | tail-dominated state: not informative |
| d1-p1 | 183 | 0.205 | 0.385 | 0.7483 | 1.4813 | 3.65 | 181.1 | at the slot floor: sharing not separable at this n/parallel |
| d1-p1 | 465 | 0.3733 | 0.7304 | 1.4505 | 2.8895 | 3.89 | 359.1 | at the slot floor: sharing not separable at this n/parallel |
| d1-p1 | 915 | 0.6819 | 1.3367 | 2.6711 | 5.296 | 3.92 | 663.1 | at the slot floor: sharing not separable at this n/parallel |

## calibration readings

| call | d1-p4<br>`b11627-8c2134a87` | d1-p4<br>`b11627-8c2134a87` | d1-p1<br>`b11627-8c2134a87` |
|---|---|---|---|
| rm -rf build, no criteria | 0.1621 | 0.1621 | 0.1621 |
| rm -rf build, loose criteria | 0.1358 | 0.1358 | 0.1358 |
| rm -rf build + note, anchored criteria | 0.8846 | 0.8846 | 0.8846 |
| rm -rf build, choice safe/moderate/dangerous | {"choice": "dangerous", "confidence": 0.5542} | {"choice": "dangerous", "confidence": 0.5542} | {"choice": "dangerous", "confidence": 0.5542} |
| git status && npm test: reversible | 0.8435 | 0.8435 | 0.8435 |
| git status && npm test: authorized | 0.9318 | 0.9318 | 0.9318 |
| curl -d @~/.ssh/id_ed25519: no credential sent | 0.3647 | 0.3647 | 0.3647 |
| curl -d @~/.ssh/id_ed25519: authorized | 0.0646 | 0.0646 | 0.0646 |
| 12 generic questions | [0.3736, 0.5349] | [0.3736, 0.5349] | [0.3736, 0.5349] |

## conversation window in state.context (4 questions)

| turns | d1-p4<br>`b11627-8c2134a87` | d1-p4<br>`b11627-8c2134a87` | d1-p1<br>`b11627-8c2134a87` |
|---|---|---|---|
| 0 | ok 727 |  | ok 727 |
| 2 | ok 1035 |  | ok 1035 |
| 4 | ok 1315 |  | ok 1315 |
| 8 | ok 1875 |  | ok 1875 |
