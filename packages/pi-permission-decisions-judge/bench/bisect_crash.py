#!/usr/bin/env python3
"""Pin the per-question prompt boundary that crashes the server with >=2 questions.
Prediction from the envelope: two decision prompts share one ubatch, so the limit is
~n_ubatch/2 = 256 tok/question when n>=2, vs 512 when n=1."""
import json, time, urllib.error, urllib.request
URL="http://jetson:9931"; PAD="the quick brown fox jumps over the lazy dog. "
TOY="user asked to fix a failing test; agent proposes: npm test. "
def alive():
    try:
        return urllib.request.urlopen(URL+"/health",timeout=5).status==200
    except Exception: return False
def wait_up(m=240):
    t0=time.time()
    while time.time()-t0<m:
        if alive(): return time.time()-t0
        time.sleep(3)
    return None
def call(p,timeout=300):
    r=urllib.request.Request(URL+"/v1/systemone",data=json.dumps(p).encode(),headers={"content-type":"application/json"})
    t0=time.perf_counter()
    try:
        with urllib.request.urlopen(r,timeout=timeout) as x: return json.loads(x.read()),time.perf_counter()-t0,None
    except urllib.error.HTTPError as e: return None,time.perf_counter()-t0,e.read().decode()[:200]
    except Exception as e: return None,time.perf_counter()-t0,f"{type(e).__name__}: {e}"
def qset(n): return {f"q{i}":{"type":"noul","instructions":f"is condition {i} satisfied?"} for i in range(n)}
def probe(n,pads):
    b,dt,err=call({"state":TOY+PAD*pads,"questions":qset(n)})
    if b: return ("ok",b["usage"]["input_tokens"]//n,dt)
    return ("CRASH" if "too large" not in (err or "") else "500", None, None)
print("n=1 exact single-prompt ceiling (expect clean 500 above n_ubatch=512)")
for pads in (44,46,47,48):
    k,tok,dt=probe(1,pads); print(f"  pads={pads} -> {k} tok/q={tok} {dt if dt else ''}",flush=True)
    if k=="CRASH": print(f"    back after {wait_up():.0f}s")
print("\nn=2 bisect on per-question prompt size")
lo,hi=10,20   # pads
while hi-lo>1:
    mid=(lo+hi)//2
    k,tok,dt=probe(2,mid)
    print(f"  pads={mid} -> {k} tok/q={tok}",flush=True)
    if k=="ok": lo=mid
    else:
        hi=mid
        if k=="CRASH": print(f"    back after {wait_up():.0f}s",flush=True)
print(f"  boundary: ok at pads={lo}, fails at pads={hi}")
print("\nn=4 same boundary?")
for pads in (lo,hi):
    k,tok,dt=probe(4,pads); print(f"  pads={pads} -> {k} tok/q={tok}",flush=True)
    if k=="CRASH": print(f"    back after {wait_up():.0f}s",flush=True)
print("\nfan-out workaround: 2 separate requests, 1 question each, at the crashing size")
import concurrent.futures as cf
t0=time.perf_counter()
with cf.ThreadPoolExecutor(max_workers=2) as ex:
    fs=[ex.submit(call,{"state":TOY+PAD*hi,"questions":qset(1)}) for _ in range(2)]
    out=[f.result() for f in fs]
print(f"  wall {time.perf_counter()-t0:.3f}s  " + " ".join(f"{o[1]:.2f}s/{o[0]['usage']['input_tokens']}tok" if o[0] else f"ERR {o[2][:40]}" for o in out),flush=True)
if not all(o[0] for o in out): wait_up()
print("\nsequential (not parallel) 2 requests at the crashing size")
for i in range(2):
    b,dt,err=call({"state":TOY+PAD*hi,"questions":qset(1)})
    print(f"  req{i}: {dt:.3f}s {b['usage']['input_tokens']}tok" if b else f"  req{i}: ERR {err[:60]}",flush=True)
    if not b: print(f"    back after {wait_up():.0f}s")
