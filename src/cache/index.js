// Central cache management module
const streamCache = require('./streamCache');
const nzbCache = require('./nzbCache');
const nzbdavCache = require('./nzbdavCache');
const diskNzbCache = require('./diskNzbCache');

function clearAllCaches(reason = 'manual') {
  streamCache.clearStreamResponseCache(reason);
  nzbCache.clearVerifiedNzbCache(reason);
  nzbdavCache.clearNzbdavStreamCache(reason);
  diskNzbCache.clearDiskCache(reason);
}

function getAllCacheStats() {
  return {
    stream: streamCache.getStreamCacheStats(),
    nzb: nzbCache.getVerifiedNzbCacheStats(),
    nzbdav: nzbdavCache.getNzbdavCacheStats(),
    disk: diskNzbCache.getDiskCacheStats(),
  };
}

module.exports = {
  // Stream cache
  ...streamCache,
  
  // NZB cache
  ...nzbCache,
  
  // NZBDav cache
  ...nzbdavCache,

  // Disk NZB cache
  ...diskNzbCache,
  
  // Combined operations
  clearAllCaches,
  getAllCacheStats,
};
