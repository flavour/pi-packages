# The `/v1/systemone` interface

What `src/systemone.ts` sends and what it accepts back.
This is the interface document: calls, shapes, failure kinds, question types.

## The one call we make

`POST /v1/systemone` — one request carries every question for one `ask`.

```jsonc
{
  "model": "…",                     // advisory: the model that answered comes back in the response
  "state": { "value": "…", "context": "…" },
  "questions": {                    // keyed by question key, not an array
    "authorized": {
      "type": "noul",
      "instructions": "…",          // note the plural
      "criteria": { "true": "…", "false": "…" }
    }
    // …one entry per question
  }
}
```

- `state` is one object for the whole request, never per question, and never a bare string.
  `value` is what the question is about; `context` is background. `src/state.ts` owns the shape and the budget ladder.
- `criteria.true` / `criteria.false` are required: they dominate the reading, and the pair is versioned with the instruction (`QUESTIONS_TEXT_VERSION`).
- `temperature` is not sent; a reading is only comparable with the profile it was taken under.

## The response we accept

```jsonc
{
  "model": "…",                     // recorded with the verdict; the request never asserts it
  "answers": {                      // keyed by the same question keys
    "authorized": { "type": "noul", "noul": 0.97 }
  },
  "usage": { "input_tokens": 0, "output_tokens": 0 }
}
```

- Every expected key must be present in `answers`; a missing key is a failure, not a zero.
- The shipped question set is all `noul`, so a non-`noul` answer object, a missing `noul`, or a non-finite one is a failure.
  The reading is clamped into `0..1`.
- `model` and `usage` are optional on the response and logged when present.
  `usage.input_tokens` is accounting, not a compute budget and not a signal about what the server computed.

## Failure kinds

`src/systemone.ts` has exactly four (`EndpointFailureKind`), and `src/judge.ts` turns each into a `defer`:

| Kind          | Raised when                                                                                                    |
| ------------- | -------------------------------------------------------------------------------------------------------------- |
| `unreachable` | connection refused or reset, DNS, TLS                                                                          |
| `timeout`     | `AbortSignal.timeout(timeoutMs)` fired                                                                         |
| `http`        | any non-2xx, status plus a truncated body in the detail                                                        |
| `parse`       | body not JSON, `answers` missing or not an object, an answer missing its key, wrong `type`, non-finite reading |

No failure kind is retried, and none produces an `allow`.

## Question types the endpoint offers

`noul` — yes/no with explicit `true`/`false` criteria; the shipped set is four of these, three scored and one veto.
`choice` — one instruction, N options; the answer carries a chosen label and probabilities.
`score` — severity expectation over numbered levels.

`choice` and `score` are accepted by the endpoint and answered by the offline mock, but nothing in `src/` asks them yet, and no threshold exists for them (SPEC §6.3 candidates, §17-3).

## What the client must defend against

Requirements, stated where they belong: identity from the response (§6.1), a size check before sending with a ceiling that is never a baked-in constant (§13), transport failures as breaker events (§9), one request per `ask` with no fan-out (§13), and thresholds owned by the exact instruction and criteria text (§6.3).
