#!/usr/bin/env python3
"""Mock decision endpoint: it lets this package's client be tested with no network.

  python3 test/fake_endpoint.py --port 8099 [--crash-above 250] [--share-state]

Shapes follow the contract in docs/systemone-contract.md.

Behaviour modelled on llama.cpp b11606 + vllm-d3-flash:
  - input_tokens = n_questions * (state + question)   (no state sharing)
  - >=2 questions and per-question prompt > --crash-above tokens: the process dies
  - 1 question over the limit: clean HTTP 500 "physical batch size"
  - readings: deterministic pseudo-random from a hash of (state, question)
With --share-state it behaves like a can_share_prompt() model (state counted once).
"""
import argparse, hashlib, http.server, json, os, sys, time

STATE = {}


class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._send(200, {"status": "ok"})
        elif self.path == "/props":
            self._send(200, {"build_info": "bFAKE-000000000", "n_ctx": 32768,
                             "model_alias": STATE["model"], "model_path": "/fake/model.gguf"})
        elif self.path == "/v1/models":
            self._send(200, {"data": [{"id": STATE["model"]}]})
        elif self.path == "/slots":
            self._send(200, [{"id": 0, "n_ctx": 32768}, {"id": 1, "n_ctx": 32768}])
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        n = int(self.headers.get("content-length", 0))
        body = json.loads(self.rfile.read(n) or b"{}")
        if self.path != "/v1/systemone":
            self._send(404, {"error": "not found"})
            return
        if "state" not in body:
            self._send(400, {"error": {"code": 400, "message": "state must be provided"}})
            return
        qs = body.get("questions") or {}
        if not qs:
            self._send(400, {"error": {"code": 400, "message": "questions must be provided"}})
            return
        state_tok = len(json.dumps(body["state"])) // 4
        per_q = {}
        for k, q in qs.items():
            per_q[k] = state_tok + len(json.dumps(q)) // 4
        n = len(qs)
        total = sum(per_q.values()) if not STATE["share"] else state_tok + sum(
            len(json.dumps(q)) // 4 for q in qs.values())

        if n >= 2 and max(per_q.values()) > STATE["crash_above"]:
            # the real server dies here: close the socket without answering, then exit
            try:
                self.connection.close()
            except Exception:
                pass
            sys.stderr.write("fake endpoint: simulating the multi-seq crash, exiting\n")
            os._exit(1)
        if n == 1 and max(per_q.values()) > STATE["crash_above"] * 2:
            self._send(500, {"error": {"code": 500, "type": "server_error",
                                       "message": f"input ({max(per_q.values())} tokens) is too large to "
                                                  "process. increase the physical batch size (current batch size: 512)"}})
            return

        time.sleep(0.02 + 0.05 * n)  # pretend to be slow
        answers = {}
        for k, q in qs.items():
            h = int(hashlib.sha256((json.dumps(body["state"], sort_keys=True) + json.dumps(q, sort_keys=True))
                                   .encode()).hexdigest()[:6], 16) / 0xFFFFFF
            p = round(0.02 + 0.96 * h, 4)
            t = q.get("type", "noul")
            if t == "noul":
                answers[k] = {"type": "noul", "noul": p}
            elif t == "choice":
                labels = list((q.get("criteria") or {}).keys()) or ["a", "b"]
                probs = {l: round(p / len(labels) + i * 0.01, 4) for i, l in enumerate(labels)}
                answers[k] = {"type": "choice", "choice": labels[0], "probabilities": probs,
                              "confidence": round(0.5 + 0.4 * h, 4)}
            else:
                levels = q.get("criteria") or ["low", "high"]
                answers[k] = {"type": "score", "score": round(h * (len(levels) - 1), 4),
                              "legend": {str(i): l for i, l in enumerate(levels)},
                              "probabilities": {str(i): round(1 / len(levels), 4) for i in range(len(levels))},
                              "confidence": round(0.3 + 0.5 * h, 4)}
        self._send(200, {"model": STATE["model"], "answers": answers,
                         "usage": {"input_tokens": total, "output_tokens": 0}})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8099)
    ap.add_argument("--model", default="fake/decision-model:Q8_0")
    ap.add_argument("--crash-above", type=int, default=250)
    ap.add_argument("--share-state", action="store_true")
    a = ap.parse_args()
    STATE.update(model=a.model, crash_above=a.crash_above, share=a.share_state)
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", a.port), H)
    print(f"fake decision endpoint on http://127.0.0.1:{a.port} "
          f"(model={a.model} crash_above={a.crash_above} share_state={a.share_state})", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
