#!/usr/bin/env bash
# One server CONFIG, one set of probe runs. The config is part of the provenance: the same model
# on different --parallel / -ub flags behaves differently, so a run is only attributable if the
# flags are recorded AND checked against what the server reports.
#
#   ./run_model.sh                      # list the configs and the server command for each
#   ./run_model.sh d1-p4                # probe the config below (server must already be running)
#   WAIT=600 ./run_model.sh d1-p4       # wait up to Ns for the server to come up with that config
#
# Provenance is fixed for this matrix (Jetson Orin NX 16GB / JetPack 7.2.1 / llama.cpp @ 8c2134a87).
# The script refuses to record a run if the model, build, slot count or n_ubatch disagrees with what
# we claim, because the whole point of the matrix is that the numbers are attributable.
#
# We have no ssh key for jetson, so this script cannot restart the server itself: it prints the
# command to run there, then waits for the endpoint to match.
set -uo pipefail
cd "$(dirname "$0")"

REVISION=8c2134a8755d8a9792af513dab20282affe903e4
MACHINE="Jetson Orin NX 16GB, JetPack 7.2.1"
STACK="llama.cpp llama-server"
URL=${URL:-http://jetson:9931}
WAIT=${WAIT:-0}          # seconds to wait for the endpoint to match the config (0 = check once)
OUT_DIR=${OUT_DIR:-results}
EXTRA=${EXTRA:-}         # extra probe args, e.g. --allow-identity-mismatch for an offline rehearsal

usage() {
  cat <<'EOF'
usage: ./run_model.sh <config>          (WAIT=600 to wait for the server to come up)

The config is part of the provenance: model + --parallel + -b/-ub + -c. Each config prints the
llama-server command to start on jetson (we have no ssh key from this machine), checks that the
running endpoint matches, then records: core+concurrency, sharing (latency + slot counters),
ceiling, [merge on non-causal models], envelope.

  config                 model                     slots  -ub    what it decides
  d1-p2                  LiquidAI/d1-3B-GGUF        2      512    baseline (measured 2026-10-14)
  d1-p4                  LiquidAI/d1-3B-GGUF        4      512    state sharing: group size = n_parallel,
                                                                  so 4 questions ride ONE state read.
                                                                  -c 32768 = n_ctx_train, so 4 slots
                                                                  means 8192/slot (measured 2026-10-14)
  d1-p1                  LiquidAI/d1-3B-GGUF        1      512    negative control for d1-p4: same model,
                                                                  no sharing possible, so slot counters
                                                                  must show 0/N inheriting and latency
                                                                  must go linear with question count.
  d3flash-ub2048-p2      ggml-org/vllm-d3-flash     2      2048   does -ub 2048 remove the n_ubatch
                                                                  assert, and do N questions then share
                                                                  one ubatch?
  d3flash-ub2048-p1      ggml-org/vllm-d3-flash     1      2048   control: no merging -> no assert
  d3mini-ub2048-p2       ggml-org/vllm-d3-mini      2      2048   same, cheaper model

Causal models (d1) never hit the n_ubatch assert, so their ceiling case cannot report n_ubatch:
--expect-ubatch is only applied to the non-causal d3 configs. For those, the merge case runs two
equal-length questions at ~2k merged tokens - the shape that killed the process at -ub 512.

Env: URL, WAIT, OUT_DIR, EXTRA (extra probe args), CTX (override -c if the model will not load).
EOF
  exit 2
}

declare -A MODEL SLOTS Ubatch NOTES SERVER NONCAUSAL Ctx CtxSlot
case "${1:-}" in
  d1-p2)
    MODEL[d1-p2]="LiquidAI/d1-3B-GGUF:Q8_0";  SLOTS[d1-p2]=2; Ubatch[d1-p2]=""; NONCAUSAL[d1-p2]=0; Ctx[d1-p2]=32768; CtxSlot[d1-p2]=16384
    NOTES[d1-p2]="--parallel 2, -b 2048 -ub 512 (defaults), -c 32768 (16384/slot)"
    SERVER[d1-p2]='llama-server -hf LiquidAI/d1-3B-GGUF:Q8_0 --port 9931 --slots -c 32768 --parallel 2' ;;
  d1-p4)
    # -c 32768 is n_ctx_train for d1-3B, so it is the ceiling for -c; at --parallel 4 that is
    # 8192/slot, which still clears the widest case here (2239 tok/question, 1 question per slot at n=4).
    MODEL[d1-p4]="LiquidAI/d1-3B-GGUF:Q8_0";  SLOTS[d1-p4]=4; Ubatch[d1-p4]=""; NONCAUSAL[d1-p4]=0; Ctx[d1-p4]=32768; CtxSlot[d1-p4]=8192
    NOTES[d1-p4]="--parallel 4, -b 2048 -ub 512 (defaults), -c 32768 (8192/slot = n_ctx_train/4)"
    SERVER[d1-p4]='llama-server -hf LiquidAI/d1-3B-GGUF:Q8_0 --port 9931 --slots -c 32768 --parallel 4' ;;
  d1-p1)
    # Negative control for d1-p4: one slot, so no prefix sharing is possible and the sharing suite
    # must report 0/N tasks inheriting. -c 32768 stays, so the single slot gets the whole context.
    MODEL[d1-p1]="LiquidAI/d1-3B-GGUF:Q8_0";  SLOTS[d1-p1]=1; Ubatch[d1-p1]=""; NONCAUSAL[d1-p1]=0; Ctx[d1-p1]=32768; CtxSlot[d1-p1]=32768
    NOTES[d1-p1]="--parallel 1, -b 2048 -ub 512 (defaults), -c 32768 (32768/slot)"
    SERVER[d1-p1]='llama-server -hf LiquidAI/d1-3B-GGUF:Q8_0 --port 9931 --slots -c 32768 --parallel 1' ;;
  d3flash-ub2048-p2)
    MODEL[d3flash-ub2048-p2]="ggml-org/vllm-d3-flash-GGUF:Q8_0"; SLOTS[d3flash-ub2048-p2]=2; Ubatch[d3flash-ub2048-p2]=2048; NONCAUSAL[d3flash-ub2048-p2]=1; Ctx[d3flash-ub2048-p2]=32768; CtxSlot[d3flash-ub2048-p2]=16384
    NOTES[d3flash-ub2048-p2]="--parallel 2, -b 2048 -ub 2048, -c 32768 (16384/slot)"
    SERVER[d3flash-ub2048-p2]='llama-server -hf ggml-org/vllm-d3-flash-GGUF:Q8_0 --port 9931 --slots -c 32768 --parallel 2 -b 2048 -ub 2048' ;;
  d3flash-ub2048-p1)
    MODEL[d3flash-ub2048-p1]="ggml-org/vllm-d3-flash-GGUF:Q8_0"; SLOTS[d3flash-ub2048-p1]=1; Ubatch[d3flash-ub2048-p1]=2048; NONCAUSAL[d3flash-ub2048-p1]=1; Ctx[d3flash-ub2048-p1]=32768; CtxSlot[d3flash-ub2048-p1]=32768
    NOTES[d3flash-ub2048-p1]="--parallel 1, -b 2048 -ub 2048, -c 32768"
    SERVER[d3flash-ub2048-p1]='llama-server -hf ggml-org/vllm-d3-flash-GGUF:Q8_0 --port 9931 --slots -c 32768 --parallel 1 -b 2048 -ub 2048' ;;
  d3mini-ub2048-p2)
    MODEL[d3mini-ub2048-p2]="ggml-org/vllm-d3-mini-GGUF:Q8_0"; SLOTS[d3mini-ub2048-p2]=2; Ubatch[d3mini-ub2048-p2]=2048; NONCAUSAL[d3mini-ub2048-p2]=1; Ctx[d3mini-ub2048-p2]=32768; CtxSlot[d3mini-ub2048-p2]=16384
    NOTES[d3mini-ub2048-p2]="--parallel 2, -b 2048 -ub 2048, -c 32768 (16384/slot)"
    SERVER[d3mini-ub2048-p2]='llama-server -hf ggml-org/vllm-d3-mini-GGUF:Q8_0 --port 9931 --slots -c 32768 --parallel 2 -b 2048 -ub 2048' ;;
  *) usage ;;
esac
L=${1}
if [ "${Ctx[$L]}" != "${CTX:-${Ctx[$L]}}" ]; then
  SERVER[$L]="${SERVER[$L]/-c ${Ctx[$L]}/-c ${CTX}}"
  NOTES[$L]="${NOTES[$L]/ -c ${Ctx[$L]}/ -c ${CTX}}"
fi

echo "== server to run on jetson (no ssh key from here):"
echo "   ${SERVER[$L]}"
echo "   model ${MODEL[$L]}, --parallel ${SLOTS[$L]}, -ub ${Ubatch[$L]}"
echo

common=(--url "$URL" --machine "$MACHINE" --stack "$STACK" --revision "$REVISION"
        --expect-model "${MODEL[$L]}" --expect-slots "${SLOTS[$L]}" --expect-ctx-slot "${CtxSlot[$L]}"
        --out-dir "$OUT_DIR" --notes "${NOTES[$L]}"
        ${EXTRA})
ubatch_check=()
if [ -n "${Ubatch[$L]}" ]; then ubatch_check=(--expect-ubatch "${Ubatch[$L]}"); fi

# The ceiling sweep has to cross n_ubatch before the server will name it (server-context.cpp:3556
# errors only when task n_tokens > n_ubatch), and the d1-p2 envelope stopped at the top of its ramp
# (639 tok/question), not at a real limit. So both ramps are extended for these runs; the pads values
# are recorded per row, so the runs stay comparable.
CEIL_PADS="20,30,40,44,46,50,60,80"
ENV_PADS="10,14,16,20,25,30,40,50,60,80,100,120,140,160,180,200,220"
if [ -n "${Ubatch[$L]}" ] && [ "${Ubatch[$L]}" -gt 512 ]; then
  CEIL_PADS="20,30,40,44,46,50,60,80,120,160,200,220,240"
fi

# wait for the endpoint to come up with the expected model + slot count before recording anything.
# No --allow-identity-mismatch here on purpose: probe.py exits 2 until model/slots/build match, so
# the loop keeps waiting rather than recording a run under the wrong provenance.
deadline=$(( $(date +%s) + WAIT ))
while :; do
  if python3 probe.py "${common[@]}" --label "$L-probe-identity" --only identity --quiet; then
    break
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "!! endpoint does not match this config yet. start it, then re-run: $0 $L"
    exit 3
  fi
  echo "   waiting for the endpoint to match (${SLOTS[$L]} slots, ${MODEL[$L]})..."
  sleep 10
done
rm -f "$OUT_DIR"*"-${L}-probe-identity."*
python3 - "$L" "$OUT_DIR/index.jsonl" <<'PY'
import sys
lab = sys.argv[1] + "-probe-identity"
p = sys.argv[2]
lines = [l for l in open(p) if f'-{lab}.' not in l]
open(p, "w").writelines(lines)
PY

echo "== $L : clean run (core + concurrency)"
python3 probe.py "${common[@]}" --label "$L" --suite core,concurrency || exit $?

echo
echo "== $L : sharing (latency vs n + slot counters: does the state get read once?)"
python3 probe.py "${common[@]}" --label "$L-share" --only sharing,slot_counters --share-max-n 8 || exit $?

echo
echo "== $L : ceiling (reports n_ubatch on non-causal models only)"
python3 probe.py "${common[@]}" --label "$L-ceil" --only ceiling "${ubatch_check[@]}" \
        --ceiling-pads "$CEIL_PADS" || exit $?

if [ "${NONCAUSAL[$L]}" = 1 ]; then
  # Two equal-length questions merge into one slot batch (server_slot::can_batch_with). At -ub 512
  # this shape killed the process: the assert (llama-context.cpp:1898) fires when a ubatch holds
  # >1 sequence and n_ubatch < n_tokens_all. A batch never exceeds n_batch, so with -ub == -b it
  # cannot fire: this run should come back OK at ~2k merged tokens, 4x the old fatal size.
  echo
  echo "== $L : merge (2 equal-length questions, ~2k merged tokens; fatal at -ub 512)"
  python3 probe.py "${common[@]}" --label "$L-merge" --only merge --destructive --merge-total 900 || exit $?
fi

echo
echo "== $L : envelope (deliberately crosses the limit; expect reloads on non-causal models)"
python3 probe.py "${common[@]}" --label "$L-env" --only envelope --destructive --env-pads "$ENV_PADS" || exit $?

echo
echo "== $L : done. compare with:"
echo "   python3 report.py \"$OUT_DIR/*-$L*.json\" --out $OUT_DIR/$L-compare.md"
