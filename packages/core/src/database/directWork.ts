/**
 * How core-owned driver work that skips the WorkQueue — query fetches,
 * local storage, the sync helpers — tells its Database it is running,
 * so a close can drain it (docs/reference/database.md, "Closing").
 *
 * A module-private registry rather than a method, because the callers
 * live in other modules and a public `db._runDirect()` would ship in
 * the type declarations as something consumers could call. `@internal`
 * does not remove it from the emitted `.d.mts`.
 *
 * An owner with nothing registered runs its work straight through, so a
 * `LocalStorage` built by hand behaves exactly as one built by a
 * Database.
 */

type Runner = <T>(work: () => Promise<T>) => Promise<T>;

const runners = new WeakMap<object, Runner>();

/** Route this owner's direct work through `run`. Called by Database. */
export function setDirectRunner(owner: object, run: Runner): void {
  runners.set(owner, run);
}

/** Run direct driver work, accounted for if the owner registered a runner. */
export function runDirect<T>(
  owner: object,
  work: () => Promise<T>,
): Promise<T> {
  const run = runners.get(owner);
  return run ? run(work) : work();
}
