/**
 * The OPFS SyncAccessHandle pool remained owned after the bounded retry.
 * `diagnostic` preserves the browser's final acquisition error.
 * @category Driver
 */
export class OpfsPoolHeldError extends Error {
  readonly code = 'OPFS_POOL_HELD' as const;

  constructor(readonly diagnostic: string) {
    super(
      'The OPFS storage pool is held by another browser context. Close ' +
        'other tabs using this site; in Firefox, quit and reopen the browser ' +
        `if a page worker died. Browser diagnostic: ${diagnostic}`,
    );
    this.name = 'OpfsPoolHeldError';
  }
}
