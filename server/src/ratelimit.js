import { MemoryStore } from './store.js';

// Fixed-window request counters. Deliberately backed by an always-in-memory
// MemoryStore, never the durable FileStore: the counters are high-churn,
// losing them on a restart is harmless (a window's worth of extra requests),
// and keeping them out of the durable store is what keeps its
// fsync-per-mutation affordable. MemoryStore.increment keeps the original
// window's TTL rather than re-stamping it, so a window actually expires
// instead of rolling forever under sustained load.
// Every counted request is one step towards the next sweep. Sized so the
// sweep's cost is amortised to nothing (one O(n) pass per SWEEP_EVERY
// increments) while the Map never holds much more than a sweep interval's
// worth of dead keys.
const SWEEP_EVERY = 1000;

export class RateLimiter {
  constructor(backing = new MemoryStore()) {
    this.backing = backing;
    this.sinceSweep = 0;
  }

  // Count this request against `bucket:key` and say whether it is still
  // within `limit` per `windowMs`.
  check(bucket, key, limit, windowMs) {
    this.tick();
    return this.backing.increment(`rl:${bucket}:${key}`, windowMs) <= limit;
  }

  // Read-only: has `bucket:key` already reached `limit`? Used with record()
  // when the thing being limited is an outcome (a failed redemption) rather
  // than the request itself.
  atLimit(bucket, key, limit) {
    return Number(this.backing.get(`rl:${bucket}:${key}`) || 0) >= limit;
  }

  record(bucket, key, windowMs) {
    this.tick();
    this.backing.increment(`rl:${bucket}:${key}`, windowMs);
  }

  // Expired counters are only evicted when someone reads the same key again,
  // and a rate-limit key is per-IP: an address that hits once and never comes
  // back leaves its entry behind for the life of the process. On a public
  // endpoint that is unbounded growth, so sweep on a counter rather than
  // waiting to be asked. Amortised, not timed — a timer would have to be
  // unref'd and would still fire in every test that imports this module.
  tick() {
    if (++this.sinceSweep < SWEEP_EVERY) return 0;
    this.sinceSweep = 0;
    return this.backing.sweep ? this.backing.sweep() : 0;
  }
}

export const rateLimiter = new RateLimiter();
