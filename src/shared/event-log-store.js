import { EVENT_CATEGORY, LOG_LEVEL } from "./constants.js";
import { openDatabase, requestToPromise, transactionDone } from "./idb.js";
import { nowIso } from "./utils.js";
import { redactSecrets } from "./redact.js";

const DB_NAME = "neuro_translate_db";
const DB_VERSION = 1;
const STORE_NAME = "event_logs";

export class EventLogStore {
  constructor({
    maxRecords = 8000,
    maxAgeMs = 1000 * 60 * 60 * 24 * 7,
    maxBytes = 3_000_000
  } = {}) {
    this.maxRecords = maxRecords;
    this.maxAgeMs = maxAgeMs;
    this.maxBytes = maxBytes;
    this.dbPromise = null;
  }

  async db() {
    if (!this.dbPromise) {
      this.dbPromise = openDatabase({
        dbName: DB_NAME,
        version: DB_VERSION,
        upgrade: (db) => {
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            const store = db.createObjectStore(STORE_NAME, { keyPath: "id", autoIncrement: true });
            store.createIndex("by_ts", "ts");
            store.createIndex("by_category", "category");
            store.createIndex("by_level", "level");
            store.createIndex("by_pageSessionId", "pageSessionId");
          }
        }
      });
    }
    return this.dbPromise;
  }

  normalizeEvent(event) {
    const normalized = {
      ts: event.ts || nowIso(),
      level: event.level || LOG_LEVEL.INFO,
      category: event.category || EVENT_CATEGORY.UI_ACTION,
      name: event.name || "event",
      pageSessionId: event.pageSessionId || null,
      tabId: event.tabId ?? null,
      batchId: event.batchId || null,
      blockId: event.blockId || null,
      data: redactSecrets(event.data || {}),
      error: redactSecrets(event.error || null)
    };
    return normalized;
  }

  async append(event) {
    const db = await this.db();
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).add(this.normalizeEvent(event));
    await transactionDone(tx);
  }

  async appendMany(events) {
    if (!events.length) {
      return;
    }
    const db = await this.db();
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    for (const event of events) {
      store.add(this.normalizeEvent(event));
    }
    await transactionDone(tx);
  }

  async query({
    level,
    category,
    pageSessionId,
    onlyErrors = false,
    limit = 500,
    offset = 0,
    sort = "desc"
  } = {}) {
    const db = await this.db();
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const rows = await requestToPromise(store.getAll());
    await transactionDone(tx);

    const filtered = rows.filter((row) => {
      if (level && row.level !== level) {
        return false;
      }
      if (category && row.category !== category) {
        return false;
      }
      if (pageSessionId && row.pageSessionId !== pageSessionId) {
        return false;
      }
      if (onlyErrors && row.level !== LOG_LEVEL.ERROR) {
        return false;
      }
      return true;
    });

    filtered.sort((a, b) => (sort === "asc" ? String(a.ts).localeCompare(String(b.ts)) : String(b.ts).localeCompare(String(a.ts))));

    return {
      total: filtered.length,
      items: filtered.slice(offset, offset + limit)
    };
  }

  async clear() {
    const db = await this.db();
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).clear();
    await transactionDone(tx);
  }

  async exportJson(filters = {}) {
    const data = await this.query({ ...filters, limit: Number.MAX_SAFE_INTEGER, offset: 0, sort: "asc" });
    return JSON.stringify(data.items, null, 2);
  }

  async gc() {
    const db = await this.db();
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const allRows = await requestToPromise(store.getAll());
    await transactionDone(tx);

    const now = Date.now();
    const expiredThreshold = now - this.maxAgeMs;
    const toDeleteByAge = allRows.filter((row) => Date.parse(row.ts) < expiredThreshold).map((row) => row.id);

    let overLimitDeleteIds = [];
    if (allRows.length - toDeleteByAge.length > this.maxRecords) {
      const sortedAsc = allRows
        .filter((row) => !toDeleteByAge.includes(row.id))
        .sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
      const over = sortedAsc.length - this.maxRecords;
      overLimitDeleteIds = sortedAsc.slice(0, over).map((row) => row.id);
    }

    const keepRowsByAgeAndCount = allRows
      .filter((row) => !toDeleteByAge.includes(row.id) && !overLimitDeleteIds.includes(row.id))
      .sort((a, b) => String(a.ts).localeCompare(String(b.ts)));

    let estimatedBytes = keepRowsByAgeAndCount.reduce((sum, row) => sum + estimateEventBytes(row), 0);
    const overBytesDeleteIds = [];
    if (estimatedBytes > this.maxBytes) {
      for (const row of keepRowsByAgeAndCount) {
        if (estimatedBytes <= this.maxBytes) {
          break;
        }
        overBytesDeleteIds.push(row.id);
        estimatedBytes -= estimateEventBytes(row);
      }
    }

    const deleteIds = [...toDeleteByAge, ...overLimitDeleteIds, ...overBytesDeleteIds];
    if (!deleteIds.length) {
      return { removed: 0 };
    }

    const writeTx = db.transaction(STORE_NAME, "readwrite");
    const writeStore = writeTx.objectStore(STORE_NAME);
    for (const id of deleteIds) {
      writeStore.delete(id);
    }
    await transactionDone(writeTx);

    return {
      removed: deleteIds.length,
      removedByAge: toDeleteByAge.length,
      removedByMaxRecords: overLimitDeleteIds.length,
      removedByMaxBytes: overBytesDeleteIds.length
    };
  }
}

function estimateEventBytes(row) {
  try {
    return JSON.stringify(row).length * 2;
  } catch {
    return 1024;
  }
}
