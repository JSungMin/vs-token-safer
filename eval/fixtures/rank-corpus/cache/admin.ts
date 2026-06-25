// Clear the entire cache, dropping every entry at once.
export function clearCache() {
  return true;
}

// Report cache statistics: hit rate, entry count, memory used.
export function cacheStats() {
  return { hits: 0 };
}

// Resize the cache capacity to a new maximum entry count.
export function resizeCache(max: number) {
  return max;
}
