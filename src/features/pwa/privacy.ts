const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

// One exhaustive list of client storage keys that hold user-authored Community content or command intents.
// Sign-out and account change drop every entry. A membership refresh that shows lost access drops:
// - 'community' keys whose embedded account or Community is no longer current and active;
// - 'any-loss' keys (no Community in the key) once any Community access is lost;
// - never 'prior-obligation' keys: Handoff, evidence and dispute work may continue under the prior-obligation
//   exception and is re-authorized by the server on every retry.
export const protectedStorage = [
  { prefix: 'listing-draft-', onAccessLoss: 'community', scope: new RegExp(`^listing-draft-(${uuid})-(${uuid})-`, 'i') },
  { prefix: 'item-need-draft-', onAccessLoss: 'community', scope: new RegExp(`^item-need-draft-(${uuid})-(${uuid})-`, 'i') },
  { prefix: 'message-start-', onAccessLoss: 'community', scope: new RegExp(`^message-start-()(${uuid})-`, 'i') },
  { prefix: 'message-draft-', onAccessLoss: 'any-loss' },
  { prefix: 'handoff-command-', onAccessLoss: 'prior-obligation' },
  { prefix: 'handoff-upload-', onAccessLoss: 'prior-obligation' },
  { prefix: 'dispute-command-', onAccessLoss: 'prior-obligation' },
] as const;

type Store = Pick<Storage, 'length' | 'key' | 'removeItem'>;

function sweep(stores: Store[], drop: (key: string) => boolean) {
  for (const store of stores) {
    const keys: string[] = [];
    for (let index = 0; index < store.length; index++) { const key = store.key(index); if (key !== null) keys.push(key); }
    for (const key of keys) if (drop(key)) store.removeItem(key);
  }
}

function browserStores(): Store[] { return typeof window === 'undefined' ? [] : [window.sessionStorage, window.localStorage]; }

/** Sign-out and account change: drop every protected key for every account. */
export function clearProtectedClientStorage(stores: Store[] = browserStores()) {
  sweep(stores, key => protectedStorage.some(entry => key.startsWith(entry.prefix)));
}

/**
 * Membership refresh: keep drafts and intents while access stands; drop only what a confirmed refresh shows is no
 * longer authorized. `activeCommunityIds` must come from a successful read of the account's active memberships.
 * `lostAccess` is true when that read shows a Community the previous read had.
 */
export function clearRevokedProtectedStorage(userId: string, activeCommunityIds: ReadonlySet<string>, lostAccess: boolean, stores: Store[] = browserStores()) {
  const active = new Set([...activeCommunityIds].map(id => id.toLowerCase()));
  sweep(stores, key => {
    const entry = protectedStorage.find(candidate => key.startsWith(candidate.prefix));
    if (!entry) return false;
    if (entry.onAccessLoss === 'any-loss') return lostAccess;
    if (entry.onAccessLoss !== 'community') return false;
    const match = entry.scope.exec(key);
    if (!match) return lostAccess;
    const [, owner, community] = match;
    return (owner !== '' && owner.toLowerCase() !== userId.toLowerCase()) || !active.has(community.toLowerCase());
  });
}
