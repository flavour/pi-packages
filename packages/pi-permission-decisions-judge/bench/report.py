#!/usr/bin/env python3
"""Diff probe.py runs side by side (Markdown on stdout, or --out file).

  python3 report.py results/*-d3-flash-b11606.json results/*-d3-mini.json
  python3 report.py --out results/compare.md results/*.json
"""
import argparse, glob, json, os, sys


def load(paths):
    runs = []
    for p in paths:
        for g in sorted(glob.glob(p)):
            with open(g) as f:
                d = json.load(f)
            by_case = {}
            for r in d["records"]:
                by_case.setdefault(r["case"], []).append(r)
            runs.append((d["meta"], by_case))
    # a label like "d3-mini-ceil" is an extra probe of the "d3-mini" run -> one column per model
    merged = []
    for meta, by_case in sorted(runs, key=lambda x: len(x[0]["label"])):
        base = next((t for t in merged if meta["label"].startswith(t[0]["label"] + "-")), None)
        if base is None:
            merged.append((meta, by_case))
            continue
        for case, rows in by_case.items():
            base[1].setdefault(case, []).extend(rows)
        base[0]["crashes"] = (base[0].get("crashes") or []) + (meta.get("crashes") or [])
        base[0].setdefault("extra_labels", []).append(meta["label"])
    return merged


def pick(rows, pred):
    for r in rows or []:
        if pred(r):
            return r
    return {}


def pickmax(rows, pred, key):
    """Best (largest key) matching row - for cases probed more than once, e.g. an envelope ramp
    re-run with a wider --env-pads: the widest surviving size is the one that matters."""
    cands = [r for r in (rows or []) if pred(r)]
    return max(cands, key=lambda r: r.get(key) or 0) if cands else {}


def cell(v):
    if v is None:
        return ""
    if isinstance(v, (dict, list)):
        return json.dumps(v, sort_keys=True)
    return str(v)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("runs", nargs="+")
    ap.add_argument("--out")
    a = ap.parse_args()
    runs = load(a.runs)
    if not runs:
        print("no runs matched")
        sys.exit(1)

    names = [f"{m['label']}<br>`{m['identity'].get('build_info') or '?'}`" for m, _ in runs]
    lines = ["# probe comparison", "", "| metric | " + " | ".join(names) + " |",
             "|" + "---|" * (len(runs) + 1)]

    def row(label, fn):
        lines.append(f"| {label} | " + " | ".join(cell(fn(cs)) for _, cs in runs) + " |")

    for key in ("model", "build_info", "n_slots", "n_ctx", "n_ctx_slot"):
        lines.append(f"| {key} | " + " | ".join(cell(m["identity"].get(key)) for m, _ in runs) + " |")
    for key, label in (("machine", "machine"), ("stack", "stack"), ("revision", "revision"), ("notes", "notes")):
        lines.append(f"| {label} | " + " | ".join(cell(m.get(key)) for m, _ in runs) + " |")
    lines.append("| provenance check | " + " | ".join(
        "ok" if (m.get("identity_check") or {}).get("model_ok") and (m.get("identity_check") or {}).get("revision_ok")
        and (m.get("identity_check") or {}).get("slots_ok") is not False
        and (m.get("identity_check") or {}).get("ctx_slot_ok") is not False
        and (m.get("identity_check") or {}).get("ubatch_ok") is not False
        else "MISMATCH" for m, _ in runs) + " |")
    lines.append("| crashes during run | " + " | ".join(str(len(m.get("crashes") or [])) for m, _ in runs) + " |")

    for n in (1, 4, 12):
        row(f"tok/question (toy state) n={n}", lambda cs, n=n:
            pick(cs.get("token_accounting"), lambda r, n=n: r["params"].get("n") == n).get("tokens_per_question"))
    row("n_ubatch reported by the server", lambda cs:
        (pick(cs.get("ceiling"), lambda r: r.get("params", {}).get("reported") == "n_ubatch") or {}).get("input_tokens"))
    for n in (1, 4, 8, 12):
        row(f"latency n={n}", lambda cs, n=n:
            pick(cs.get("latency_vs_n"), lambda r, n=n: r["params"].get("n") == n).get("median"))
    row("marginal ms/question (1->2)", lambda cs:
        pick(cs.get("latency_vs_n_marginal"), lambda r: r["params"].get("from") == 1 and r["params"].get("to") == 2).get("ms_per_question"))
    row("marginal ms/question (4->6)", lambda cs:
        pick(cs.get("latency_vs_n_marginal"), lambda r: r["params"].get("from") == 4 and r["params"].get("to") == 6).get("ms_per_question"))
    for n in (1, 2, 4):
        row(f"realistic {n}q latency", lambda cs, n=n:
            pick(cs.get("realistic"), lambda r, n=n: r["params"].get("questions") == n).get("median"))
        row(f"realistic {n}q tokens", lambda cs, n=n:
            pick(cs.get("realistic"), lambda r, n=n: r["params"].get("questions") == n).get("input_tokens"))
    row("realistic 4q readings", lambda cs:
        pick(cs.get("realistic"), lambda r: r["params"].get("questions") == 4).get("answers"))
    row("multiseq max drift vs alone (x4)", lambda cs:
        pick(cs.get("multiseq_drift"), lambda r: r["params"].get("vs") == "batched x4").get("max_delta"))
    row("multiseq max drift vs alone (x2)", lambda cs:
        pick(cs.get("multiseq_drift"), lambda r: r["params"].get("vs") == "batched x2").get("max_delta"))
    row("same question x8 spread", lambda cs:
        pick(cs.get("multiseq_same_question"), lambda r: r["params"].get("n") == 8).get("spread"))
    row("1 choice x4 options: latency / tok", lambda cs:
        f"{pick(cs.get('encoding_equivalence'), lambda r: 'options' in str(r['params'])).get('median')} / "
        f"{pick(cs.get('encoding_equivalence'), lambda r: 'options' in str(r['params'])).get('input_tokens')}")
    row("4 noul: latency / tok", lambda cs:
        f"{pick(cs.get('encoding_equivalence'), lambda r: 'noul' in str(r['params'])).get('median')} / "
        f"{pick(cs.get('encoding_equivalence'), lambda r: 'noul' in str(r['params'])).get('input_tokens')}")
    row("determinism: distinct answer sets", lambda cs: pick(cs.get("determinism"), lambda r: True).get("distinct"))
    for n in (1, 2, 4):
        row(f"envelope: largest ok tok/question (n={n})", lambda cs, n=n:
            pickmax(cs.get("envelope_max_ok"), lambda r, n=n: r["params"].get("n") == n,
                    "tokens_per_question").get("tokens_per_question"))
    for n in (2, 4):
        row(f"envelope: largest ok TOTAL tokens (n={n})", lambda cs, n=n:
            (lambda r: (r.get("tokens_per_question") or 0) * n if r.get("tokens_per_question") else None)(
                pickmax(cs.get("envelope_max_ok"), lambda r, n=n: r["params"].get("n") == n,
                        "tokens_per_question")))

    for n in (1, 2, 4, 8):
        row(f"real compute n={n}: computed / reported tok", lambda cs, n=n:
            (lambda r: f"{r.get('computed_tokens')} / {r.get('reported_input_tokens')}"
             if r and r.get("computed_tokens") is not None else None)(
                pick(cs.get("slot_counters_summary"), lambda r, n=n: r["params"].get("n") == n)))
        row(f"prefix reuse n={n} (inherited / reported)", lambda cs, n=n:
            (lambda r: f"{r.get('inherited_tokens')} / {r.get('prompt_tokens')} in "
                       f"{r.get('n_inheriting')}/{r.get('n_slot_tasks')} tasks"
             if r and r.get("inherited_tokens") is not None else None)(
                pick(cs.get("slot_counters_summary"), lambda r, n=n: r["params"].get("n") == n)))

    lines += ["", "## state sharing: can N questions ride one forward pass? (cold cache)", "",
              "factor = latency(n=4) / latency(n=1) at that state size: ~4.0 = every question re-reads "
              "the state (not Jev-like), ~1.0 = the state is read once and the questions ride that "
              "pass (Jev-like).", "",
              "| run | state tokens | L1 s | L2 s | L4 s | L8 s | factor L4/L1 | ms/extra q (1->4) | verdict |",
              "|---|---|---|---|---|---|---|---|---|"]
    for meta, cs in runs:
        for pads in (0, 15, 40, 80):
            lat = {}
            for n in (1, 2, 4, 8):
                r = pick(cs.get("sharing"), lambda x, pads=pads, n=n:
                         x["params"].get("pads") == pads and x["params"].get("n") == n
                         and x["params"].get("cache") == "cold")
                lat[n] = r.get("median")
            f = pick(cs.get("sharing_factor"), lambda x, pads=pads:
                     x["params"].get("pads") == pads and x["params"].get("cache") == "cold")
            mg = pick(cs.get("sharing_marginal"), lambda x, pads=pads:
                      x["params"].get("pads") == pads and x["params"].get("cache") == "cold"
                      and x["params"].get("from") == 1 and x["params"].get("to") == 4)
            if not any(lat.values()) and not f:
                continue
            # runs recorded before sharing_factor existed: derive it from the latencies
            ratio = f.get("latency_ratio") or (round(lat[4] / lat[1], 2) if lat.get(1) and lat.get(4) else None)
            verdict = f.get("verdict") or (
                "no sharing (state re-read per question)" if ratio and ratio > 3.2 else
                "partial (batched pass or partial sharing)" if ratio and ratio > 1.6 else
                "shared prefix / one pass" if ratio else None)
            est = f.get("params", {}).get("state_tokens_est") or \
                pick(cs.get("sharing"), lambda x, pads=pads: x["params"].get("pads") == pads).get(
                    "state_tokens_est")
            mg = mg.get("ms_per_extra_question") or (
                round((lat[4] - lat[1]) / 3 * 1000, 1) if lat.get(1) and lat.get(4) else None)
            lines.append("| " + " | ".join([
                meta["label"],
                cell(est),
                cell(lat[1]), cell(lat[2]), cell(lat[4]), cell(lat[8]),
                cell(ratio), cell(mg),
                cell(verdict)]) + " |")

    lines += ["", "## calibration readings", "", "| call | " + " | ".join(names) + " |",
              "|" + "---|" * (len(runs) + 1)]
    calls = []
    for _, cs in runs:
        for r in cs.get("calibration", []):
            if r.get("params", {}).get("call") not in calls:
                calls.append(r.get("params", {}).get("call") or "(error)")
    for c in calls:
        cells = []
        for _, cs in runs:
            r = pick(cs.get("calibration"), lambda x, c=c: x.get("params", {}).get("call") == c)
            v = r.get("reading")
            if v is None:
                v = r.get("band") or r.get("errors")
            cells.append(cell(v))
        lines.append(f"| {c} | " + " | ".join(cells) + " |")

    lines += ["", "## conversation window in state.context (4 questions)", "",
              "| turns | " + " | ".join(names) + " |", "|" + "---|" * (len(runs) + 1)]
    for t in (0, 2, 4, 8):
        cells = []
        for _, cs in runs:
            r = pick(cs.get("conversation_window"), lambda x, t=t: x["params"].get("turns") == t)
            if not r:
                cells.append("")
                continue
            extra = r.get("input_tokens") or (r.get("error") or "")[:60]
            cells.append(f"{r.get('kind')} {extra}")
        lines.append(f"| {t} | " + " | ".join(cells) + " |")

    text = "\n".join(lines) + "\n"
    if a.out:
        with open(a.out, "w") as f:
            f.write(text)
        print(f"wrote {a.out}")
    else:
        print(text)


if __name__ == "__main__":
    main()
