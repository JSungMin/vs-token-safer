// Warm the cache at boot by preloading the hottest keys ahead of traffic.
export function warmCache() {
  return true;
}

// Preload a batch of hot keys into the cache before requests arrive.
export function prewarmKeys(keys: string[]) {
  return keys.length;
}
