#!/usr/bin/env python3
"""Is the crash specific to the decision path, or does /v1/chat/completions do it too?
Also: do decision tasks from one request use both slots?"""
import json,time,urllib.error,urllib.request
import concurrent.futures as cf
URL="http://jetson:9931"; PAD="the quick brown fox jumps over the lazy dog. "
TOY="user asked to fix a failing test; agent proposes: npm test. "
def alive():
    try: return urllib.request.urlopen(URL+"/health",timeout=5).status==200
    except Exception: return False
def wait_up(m=240):
    t0=time.time()
    while time.time()-t0<m:
        if alive(): return time.time()-t0
        time.sleep(3)
    return None
def post(path,payload,timeout=180):
    r=urllib.request.Request(URL+path,data=json.dumps(payload).encode(),headers={"content-type":"application/json"})
    t0=time.perf_counter()
    try:
        with urllib.request.urlopen(r,timeout=timeout) as x: return json.loads(x.read()),time.perf_counter()-t0,None
    except urllib.error.HTTPError as e: return None,time.perf_counter()-t0,e.read().decode()[:160]
    except Exception as e: return None,time.perf_counter()-t0,f"{type(e).__name__}: {e}"
def qset(n): return {f"q{i}":{"type":"noul","instructions":f"is condition {i} satisfied?"} for i in range(n)}

print("chat completions at the sizes that crash /v1/systemone (3 x 600-token prompts)")
for i in range(3):
    b,dt,err=post("/v1/chat/completions",{"messages":[{"role":"user","content":(TOY+PAD*60)}],"max_tokens":1})
    print(f"  chat ~600 tok: {dt:.2f}s ok" if b else f"  chat ~600 tok: ERR {err[:90]}",flush=True)
    if not b:
        print(f"    back after {wait_up():.0f}s",flush=True)
print("chat completions, 1200 tokens")
b,dt,err=post("/v1/chat/completions",{"messages":[{"role":"user","content":(TOY+PAD*120)}],"max_tokens":1})
print(f"  {dt:.2f}s ok" if b else f"  ERR {err[:120]}",flush=True)
if not b: wait_up()

print("\nrepeat the decision crash 3x at a fixed over-boundary size (is it deterministic?)")
for i in range(3):
    b,dt,err=post("/v1/systemone",{"state":TOY+PAD*25,"questions":qset(4)})
    print(f"  4q x ~354 tok/q: {dt:.2f}s ok {b['usage']['input_tokens']}tok" if b else f"  4q x ~354 tok/q: ERR {err[:60]}",flush=True)
    if not b and "too large" not in (err or ""): print(f"    back after {wait_up():.0f}s",flush=True)
print("\nwell under the boundary, 5x (is the safe zone actually safe?)")
for i in range(5):
    b,dt,err=post("/v1/systemone",{"state":TOY+PAD*10,"questions":qset(4)})
    print(f"  4q x 204 tok/q: {dt:.2f}s ok {b['usage']['input_tokens']}tok" if b else f"  ERR {err[:60]}",flush=True)
    if not b: wait_up()
print("\nslots: 8 questions in one request vs 8 separate requests (does one request use both slots?)")
t0=time.perf_counter(); b,dt,err=post("/v1/systemone",{"state":TOY,"questions":qset(8)}); print(f"  1 req x 8q: wall {time.perf_counter()-t0:.2f}s",flush=True)
t0=time.perf_counter()
with cf.ThreadPoolExecutor(max_workers=8) as ex:
    fs=[ex.submit(post,"/v1/systemone",{"state":TOY,"questions":qset(1)}) for _ in range(8)]
    out=[f.result() for f in fs]
print(f"  8 req x 1q parallel: wall {time.perf_counter()-t0:.2f}s  per-req " + " ".join(f"{o[1]:.2f}" if o[0] else "ERR" for o in out),flush=True)
if not all(o[0] for o in out): wait_up()
