// In-flight spend holds, so a positive balance cannot be spent more than once
// at a time.
//
// The balance check in chatEndpoint reads, then awaits the LLM call, then
// deducts. Without a hold, every request that arrives during that await sees
// the same untouched balance and passes: one £1 top-up admits as many
// concurrent calls as the client cares to open, all billed to the provider key.
//
// Node is single-threaded, so a check-and-reserve performed with no await
// between the two is atomic with respect to other requests -- the event loop
// cannot interleave them. That is the same reasoning store.js already relies on
// for purchase idempotency. It holds only while the store's get/set stay
// synchronous; a store that forces callers to await would reopen the race.
//
// Deliberately in-process and never persisted: a hold represents a call this
// process is currently making, so a crash must forget it. Persisting them would
// mean a process killed mid-call permanently burned a user's credit.
export class Reservations {
  constructor() {
    this.bySubject = new Map();
  }

  heldMicros(subject) {
    return this.bySubject.get(subject)?.heldMicros || 0;
  }

  inFlight(subject) {
    return this.bySubject.get(subject)?.count || 0;
  }

  acquire(subject, micros) {
    const entry = this.bySubject.get(subject) || { heldMicros: 0, count: 0 };
    entry.heldMicros += micros;
    entry.count += 1;
    this.bySubject.set(subject, entry);
  }

  release(subject, micros) {
    const entry = this.bySubject.get(subject);
    if (!entry) return;
    entry.heldMicros = Math.max(0, entry.heldMicros - micros);
    entry.count = Math.max(0, entry.count - 1);
    if (entry.count === 0) this.bySubject.delete(subject);
  }
}

export const reservations = new Reservations();
