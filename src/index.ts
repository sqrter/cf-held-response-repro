// Minimal reproduction (ZERO dependencies — plain fetch + setTimeout +
// promise chains only).
//
// A worker keeps a serialized async-sink queue across requests — every
// request AWAITS, at its start, the flush of the PREVIOUS request's queued
// records (a promise chain held in isolate state), queues its own records
// and kicks UNAWAITED background flushes, then holds its response for
// `?delay=` ms (default 2500).

let chain: Promise<unknown> = Promise.resolve();
let queue: unknown[] = [];

// The async sink. Stands in for any batched async work (a log/telemetry
// ingest POST, a database write, ...). Must be a genuinely async operation.
async function sink(events: unknown[]): Promise<void> {
  await fetch('https://example.com/', {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify(events),
  }).catch(() => undefined);
}

// Drain the queue through the shared, serialized promise chain. The caller
// decides whether to await the flush (disposal) or let it run in the
// background (fire-and-forget).
async function serializedFlush(): Promise<void> {
  const events = queue;
  queue = [];
  const prev = chain;
  const job = (async () => {
    await prev.catch(() => undefined);
    if (events.length > 0) {
      await sink(events);
    }
  })();
  chain = job.catch(() => undefined);
  await job;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runLifecycle(delay: number): Promise<void> {
  // Dispose the previous request's queued records — AWAITED. This is a
  // promise dependency on async work enqueued by earlier requests.
  await serializedFlush();
  // Emit this request's records and kick an UNAWAITED background flush
  // (in flight during the hold below).
  queue = [{msg: 'request'}];
  void serializedFlush();
  await sleep(delay);
  queue = [{msg: 'response'}];
  void serializedFlush();
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/command') {
      const raw = url.searchParams.get('delay');
      const delay = Math.min(30000, Math.max(0, parseInt(raw ?? '2500', 10) || 0));
      await runLifecycle(delay);
      return new Response(JSON.stringify({ok: true, delay, now: Date.now()}), {
        status: 200,
        headers: {'content-type': 'application/json', 'cache-control': 'no-store'},
      });
    }
    if (request.method === 'POST' && url.pathname === '/query') {
      // Instant request — same lifecycle, no hold. Included to
      // show only held responses trigger the cancellation. Needs more checks,
      // sometimes hungs too.
      await runLifecycle(0);
      return new Response(JSON.stringify({ok: true, now: Date.now()}), {
        status: 200,
        headers: {'content-type': 'application/json', 'cache-control': 'no-store'},
      });
    }
    return new Response('not found', {status: 404});
  },
};
