// Verified NZB payload cache module
// RAM cache disabled — all NZB payloads are stored only on disk (diskNzbCache).
// This module now provides no-op stubs so callers don't need to change.
// The disk cache in diskNzbCache.js is the single source of truth.

function getVerifiedNzbCacheEntry(/* downloadUrl */) {
  return null; // always fall through to diskNzbCache.getFromDisk()
}

function cacheVerifiedNzbPayload(/* downloadUrl, nzbPayload, metadata */) {
  // no-op — callers also write to diskNzbCache, which is the durable store
}

function clearVerifiedNzbCache(reason = 'manual') {
  // no-op — nothing in RAM to clear
  if (reason) {
    console.log('[CACHE] Verified NZB RAM cache disabled (disk-only mode)');
  }
}

function buildVerifiedNzbFileName(entry, fallbackTitle = null) {
  const preferred = entry?.metadata?.fileName || entry?.metadata?.title || fallbackTitle || 'verified-nzb';
  const sanitized = preferred
    .toString()
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
  return sanitized || 'verified-nzb';
}

function getVerifiedNzbCacheStats() {
  return {
    entries: 0,
    bytes: 0,
    maxBytes: 0,
    ttlMs: 0,
    mode: 'disk-only',
  };
}

// cleanupVerifiedNzbCache kept as no-op for any callers
function cleanupVerifiedNzbCache() {}

module.exports = {
  cleanupVerifiedNzbCache,
  getVerifiedNzbCacheEntry,
  cacheVerifiedNzbPayload,
  clearVerifiedNzbCache,
  buildVerifiedNzbFileName,
  getVerifiedNzbCacheStats,
};
