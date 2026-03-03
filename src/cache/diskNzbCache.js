// Disk-backed NZB payload cache
// Stores verified NZB payloads on disk so they survive container restarts.
// Falls back to the in-memory nzbCache for hot reads.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_CACHE_DIR = path.join(process.cwd(), 'cache', 'nzb_payloads');
const INDEX_FILE = 'index.json';

let cacheDir = (process.env.NZB_CACHE_DIR || '').trim() || DEFAULT_CACHE_DIR;
let indexPath = path.join(cacheDir, INDEX_FILE);

// In-memory index: url → { hash, title, sizeBytes, fileName, createdAt, expiresAt }
let index = new Map();
let initialized = false;

const CACHE_TTL_MS = (() => {
  const raw = Number(process.env.VERIFIED_NZB_CACHE_TTL_MINUTES);
  if (Number.isFinite(raw) && raw >= 0) return raw * 60 * 1000;
    return 72 * 60 * 60 * 1000; // 72 hours
})();

const MAX_ENTRIES = 500;

// --- Helpers ---

function urlHash(url) {
  return crypto.createHash('sha256').update(url).digest('hex').slice(0, 32);
}

function payloadPath(hash) {
  return path.join(cacheDir, `${hash}.nzb`);
}

function ensureDir() {
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }
}

// --- Init / Load ---

function loadIndex() {
  try {
    const raw = fs.readFileSync(indexPath, 'utf8');
    const entries = JSON.parse(raw);
    if (Array.isArray(entries)) {
      index = new Map();
      const now = Date.now();
      for (const entry of entries) {
        if (entry.expiresAt && entry.expiresAt <= now) continue;
        if (!entry.url || !entry.hash) continue;
        index.set(entry.url, entry);
      }
    }
  } catch {
    index = new Map();
  }
}

function saveIndex() {
  try {
    ensureDir();
    const entries = Array.from(index.values());
    fs.writeFileSync(indexPath, JSON.stringify(entries, null, 2), 'utf8');
  } catch (err) {
    console.warn('[DISK-CACHE] Failed to save index:', err.message);
  }
}

function init() {
  if (initialized) return;
  ensureDir();
  loadIndex();
  cleanup();
  initialized = true;
}

// --- Cleanup ---

function cleanup() {
  const now = Date.now();
  let changed = false;
  for (const [url, entry] of index) {
    if (entry.expiresAt && entry.expiresAt <= now) {
      tryDeleteFile(entry.hash);
      index.delete(url);
      changed = true;
    }
  }
  // Enforce max entries (FIFO by createdAt)
  if (index.size > MAX_ENTRIES) {
    const sorted = Array.from(index.entries()).sort((a, b) => (a[1].createdAt || 0) - (b[1].createdAt || 0));
    while (sorted.length > MAX_ENTRIES) {
      const [url, entry] = sorted.shift();
      tryDeleteFile(entry.hash);
      index.delete(url);
      changed = true;
    }
  }
  if (changed) saveIndex();
}

function tryDeleteFile(hash) {
  try {
    const p = payloadPath(hash);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch { /* ignore */ }
}

// --- Public API ---

function cacheToDisk(downloadUrl, nzbPayload, metadata = {}) {
  if (!downloadUrl || typeof nzbPayload !== 'string' || nzbPayload.length === 0) return;
  init();
  const hash = urlHash(downloadUrl);
  const now = Date.now();
  const expiresAt = CACHE_TTL_MS > 0 ? now + CACHE_TTL_MS : null;
  try {
    ensureDir();
    fs.writeFileSync(payloadPath(hash), nzbPayload, 'utf8');
    index.set(downloadUrl, {
      url: downloadUrl,
      hash,
      title: metadata.title || null,
      sizeBytes: metadata.size || null,
      fileName: metadata.fileName || null,
      createdAt: now,
      expiresAt,
    });
    saveIndex();
  } catch (err) {
    console.warn('[DISK-CACHE] Failed to write NZB payload:', err.message);
  }
}

function getFromDisk(downloadUrl) {
  if (!downloadUrl) return null;
  init();
  const entry = index.get(downloadUrl);
  if (!entry) return null;
  if (entry.expiresAt && entry.expiresAt <= Date.now()) {
    tryDeleteFile(entry.hash);
    index.delete(downloadUrl);
    return null;
  }
  try {
    const p = payloadPath(entry.hash);
    if (!fs.existsSync(p)) {
      index.delete(downloadUrl);
      return null;
    }
    const payload = fs.readFileSync(p, 'utf8');
    const payloadBuffer = Buffer.from(payload, 'utf8');
    return {
      downloadUrl,
      payloadBuffer,
      size: payloadBuffer.length,
      metadata: {
        title: entry.title || null,
        sizeBytes: entry.sizeBytes || null,
        fileName: entry.fileName || null,
      },
      createdAt: entry.createdAt,
    };
  } catch (err) {
    console.warn('[DISK-CACHE] Failed to read NZB payload:', err.message);
    return null;
  }
}

function hasCachedPayload(downloadUrl) {
  if (!downloadUrl) return false;
  init();
  const entry = index.get(downloadUrl);
  if (!entry) return false;
  if (entry.expiresAt && entry.expiresAt <= Date.now()) return false;
  return fs.existsSync(payloadPath(entry.hash));
}

function clearDiskCache(reason = 'manual') {
  init();
  const count = index.size;
  for (const entry of index.values()) {
    tryDeleteFile(entry.hash);
  }
  index.clear();
  saveIndex();
  if (count > 0) {
    console.log('[DISK-CACHE] Cleared', { reason, entries: count });
  }
}

function getDiskCacheStats() {
  init();
  return {
    entries: index.size,
    cacheDir,
    maxEntries: MAX_ENTRIES,
    ttlMs: CACHE_TTL_MS,
  };
}

function reloadConfig() {
  const newDir = (process.env.NZB_CACHE_DIR || '').trim() || DEFAULT_CACHE_DIR;
  if (newDir !== cacheDir) {
    cacheDir = newDir;
    indexPath = path.join(cacheDir, INDEX_FILE);
    initialized = false;
  }
}

module.exports = {
  cacheToDisk,
  getFromDisk,
  hasCachedPayload,
  clearDiskCache,
  getDiskCacheStats,
  reloadConfig,
};
