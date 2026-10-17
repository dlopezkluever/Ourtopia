export function clearProtectedClientStorage(includeRecovery = true) {
  for (const store of [sessionStorage, localStorage]) {
    for (const key of Object.keys(store)) {
      if (/^(listing-draft-|message-draft-|message-start-)/.test(key) || (includeRecovery && key.startsWith('handoff-'))) store.removeItem(key);
    }
  }
}
