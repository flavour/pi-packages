#!/usr/bin/env python3
"""Bisect the /v1/chat/completions crash size on this build (b11606) — the crash is not
decision-specific, so this is a server/build problem, not a decision-path one."""
import json,time,urllib.error,urllib.request
URL="http://jetson:9931"; PAD="the quick brown fox jumps over the lazy dog. "
def alive():
    try: return urllib.request.urlopen(URL+"/health",timeout=5).status==200
    except Exception: return False
def wait_up(m=240):
    t0=time.time()
    while time.time()-t0<m:
        if alive(): return time.time()-t0
        time.sleep(3)
    return None
def chat(nwords,timeout=180):
    msg="word%d "%0 + " ".join(f"w{i}" for i in range(nwords))
    r=urllib.request.Request(URL+"/v1/chat/completions",data=json.dumps({"messages":[{"role":"user","content":msg}],"max_tokens":1}).encode(),headers={"content-type":"application/json"})
    t0=time.perf_counter()
    try:
        with urllib.request.urlopen(r,timeout=timeout) as x:
            b=json.loads(x.read()); return b["usage"]["prompt_tokens"],time.perf_counter()-t0,None
    except urllib.error.HTTPError as e: return None,time.perf_counter()-t0,e.read().decode()[:160]
    except Exception as e: return None,time.perf_counter()-t0,f"{type(e).__name__}: {e}"
print("chat prompt size -> outcome (each crash costs ~24s of downtime)")
for n in (300,500,700,900,1100):
    tok,dt,err=chat(n)
    print(f"  ~{n} words -> {tok} tok ok {dt:.2f}s" if tok else f"  ~{n} words -> ERR {err[:70]}",flush=True)
    if not tok: print(f"    back after {wait_up():.0f}s",flush=True)
print("\nrepeat the smallest failing size 3x (deterministic?)")
for i in range(3):
    tok,dt,err=chat(900)
    print(f"  try{i+1}: {tok} tok ok {dt:.2f}s" if tok else f"  try{i+1}: ERR {err[:60]}",flush=True)
    if not tok: print(f"    back after {wait_up():.0f}s",flush=True)
