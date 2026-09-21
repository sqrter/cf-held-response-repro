# cf-held-response-repro

Minimal reproduction for a Cloudflare Workers platform issue: a worker whose
requests perform **serialized cross-request async work** (each request awaits,
at its start, the flush of the previous request's queued records through a
shared promise chain held in isolate state) plus **unawaited background
subrequests** gets its requests **silently canceled** — the client receives no
response of any kind (no headers, no data, no stream reset), while
`wrangler tail` shows the canceled requests invoked the worker with
`outcome: "canceled"` even though the client stayed connected.

Zero runtime dependencies — plain `fetch` + `setTimeout` + promise chains.

## Run

```bash
npm install
npx wrangler deploy

for i in $(seq 1 12); do
  curl --http2 --max-time 12 -s -o /dev/null -w "cmd $i: %{http_code}\n" \
    -X POST "https://<name>.workers.dev/command?delay=2500"
done

# in another terminal — canceled requests show outcome "canceled":
npx wrangler tail
```

## Expected vs observed

Expected: every command responds `200`.
Observed (deterministic across fresh deploys, 2026-09-21):

- `cmd 1` → `200`.
- `cmd 2..12` → **no response at all** (curl `000` / timeout with 0 bytes),
  on fresh connections, whether requests are back-to-back or spaced seconds
  apart.
- The instant endpoint wedges identically — a held response is **not**
  required:

  ```bash
  curl -X POST "https://<name>.workers.dev/query"   # first: 200, then also hangs
  ```

- While wedged, routes that make **no subrequests** still respond
  (`GET /` → `not found`).
- The wedge persists until a **new deployment** replaces the isolate
  (redeploy → first request passes again, then everything hangs again).

## What triggers it (all three required)

1. **Cross-request promise chain with awaited disposal** — each request
   awaits, at its start, a flush of the previous request's queued records,
   serialized through a promise chain stored in isolate state.
2. **Unawaited background flushes during the request** — records are queued
   and flushed fire-and-forget while the handler runs.
3. **A held response ≥ ~2.5s** (`?delay=2500`).
   > **Note:** this ingredient may be redundant — in the current revision the
   > instant endpoint (`/query`, zero hold) wedges identically, so the hold is
   > demonstrably not required here. It _was_ a required ingredient in the
   > 2026-09-20 variant and I'm not sure why. It is kept listed because its
   > role is not fully understood.

## Real-world relevance

This pattern is what many logging/telemetry pipelines do per request (batch
records, flush asynchronously, dispose on the next cycle). It was originally
observed in production with a real logger + telemetry client; this repro
distills it to plain primitives so no third-party library is involved.
