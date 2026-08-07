import { MemoryStore } from './store.js';

// Fixed-window request counters. Deliberately backed by an always-in-memory
// MemoryStore, never the durable FileStore: the counters are high-churn,
// losing them on a restart is harmless (a window's worth of extra requests),
// and keeping them out of the durable store is what keeps its
// fsync-per-mutation affordable. MemoryStore.increment keeps the original
// window's TTL rather than re-stamping it, so a window actually expires
// instead of rolling forever under sustained load.
export class RateLimiter {
  constructor(backing = new MemoryStore()) {
    this.backing = backing;
  }

  // Count this request against `bucket:key` and say whether it is still
  // within `limit` per `windowMs`.
  check(bucket, key, limit, windowMs) {
    return this.backing.increment(`rl:${bucket}:${key}`, windowMs) <= limit;
  }

  // Read-only: has `bucket:key` already reached `limit`? Used with record()
  // when the thing being limited is an outcome (a failed redemption) rather
  // than the request itself.
  atLimit(bucket, key, limit) {
    return Number(this.backing.get(`rl:${bucket}:${key}`) || 0) >= limit;
  }

  record(bucket, key, windowMs) {
    this.backing.increment(`rl:${bucket}:${key}`, windowMs);
  }
}

export const rateLimiter = new RateLimiter();
