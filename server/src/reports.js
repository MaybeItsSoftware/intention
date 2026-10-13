import { appendFileSync, renameSync, statSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';

// Where coach reports (POST /v1/report) are kept, apart from the ledger.
//
// They used to be rows in the durable FileStore with a 180-day TTL. That store
// re-serialises and fsyncs the entire ledger on every write, and /v1/report is
// unauthenticated by necessity, so each anonymous report cost a full rewrite
// of every balance and credit record — and a steady trickle of them, within
// the IP limit and across many IPs, grew the ledger without bound for half a
// year. A report is not money: it needs to be readable later, not atomic with
// anything. So reports get their own append-only file whose cost per write is
// the report alone, and whose size is capped.
//
// The coach_report log line app.js emits remains what is actually read day to
// day; this file is the copy that survives log retention.

// One report is at most ~10 KB after app.js's clamps, so this is a few hundred
// to a few thousand of them per generation.
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_RECORDS = 500;

// Size-bounded by rotation rather than by refusal: once the live file would
// pass maxBytes it is renamed to `<file>.1` (replacing the previous
// generation) and a fresh one started. Disk use is therefore at most twice
// maxBytes, and the newest reports — the ones most worth reading — are the
// ones always kept. Appends are not fsynced: losing the last few reports to a
// power cut is acceptable, and they are in the logs regardless.
export class FileReportStore {
  constructor(filePath, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
    this.filePath = filePath;
    this.maxBytes = maxBytes;
    mkdirSync(dirname(filePath), { recursive: true });
    try {
      this.bytes = statSync(filePath).size;
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      this.bytes = 0;
    }
  }

  add(record) {
    const line = `${JSON.stringify(record)}\n`;
    const size = Buffer.byteLength(line);
    if (this.bytes > 0 && this.bytes + size > this.maxBytes) {
      renameSync(this.filePath, `${this.filePath}.1`);
      this.bytes = 0;
    }
    appendFileSync(this.filePath, line);
    this.bytes += size;
  }
}

// Default when there is no state volume (tests, local dev): the most recent
// maxRecords reports in memory, oldest dropped first.
export class MemoryReportStore {
  constructor({ maxRecords = DEFAULT_MAX_RECORDS } = {}) {
    this.maxRecords = maxRecords;
    this.records = [];
  }

  add(record) {
    this.records.push(record);
    if (this.records.length > this.maxRecords) {
      this.records.splice(0, this.records.length - this.maxRecords);
    }
  }
}

export const reports = config.reportsFile ? new FileReportStore(config.reportsFile) : new MemoryReportStore();
