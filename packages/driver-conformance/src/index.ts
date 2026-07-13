/**
 * The executable driver contract (docs/reference/driver.md): every
 * SqliteDriver implementation runs this one suite — the driver method
 * obligations, the full query-semantics corpus, matcher/SQL agreement,
 * schema DDL and migrations, and the sanitization round-trip. One corpus,
 * every platform; passing it is what "conforming driver" means.
 *
 * Usage (in a driver package's vitest file):
 *
 *   registerDriverConformance({
 *     name: 'node (better-sqlite3)',
 *     createDriver: () => new NodeSqliteDriver(),
 *     persistence: { databaseName: () => `/tmp/db-${counter++}.db` },
 *   })
 */
import { describe } from 'vitest'
import type { SqliteDriver } from '@watermelon-rewrite/core'
import { contractSuite } from './contract'
import { queryCorpusSuite } from './queryCorpus'
import { matcherCorpusSuite } from './matcherCorpus'
import { schemaSuite } from './schemaSuite'
import { recordsSuite } from './recordsSuite'

export interface DriverConformanceOptions {
  /** Suite display name, e.g. "web (sqlite-wasm, memory)". */
  readonly name: string
  /** A fresh, unopened driver. Called once per test. */
  readonly createDriver: () => SqliteDriver | Promise<SqliteDriver>
  /** Name for throwaway databases (default ':memory:'). */
  readonly ephemeralName?: () => string
  /**
   * If the driver persists across open/close cycles, provide unique
   * database names so persistence semantics (user_version survival,
   * destroy) can be verified. `false` skips those tests.
   */
  readonly persistence?: { readonly databaseName: () => string } | false
}

export interface ResolvedOptions {
  readonly name: string
  readonly createDriver: () => SqliteDriver | Promise<SqliteDriver>
  readonly ephemeralName: () => string
  readonly persistence: { readonly databaseName: () => string } | false
}

export function registerDriverConformance(
  options: DriverConformanceOptions,
): void {
  const resolved: ResolvedOptions = {
    ephemeralName: () => ':memory:',
    persistence: false,
    ...options,
  }
  describe(`SqliteDriver conformance: ${resolved.name}`, () => {
    contractSuite(resolved)
    queryCorpusSuite(resolved)
    matcherCorpusSuite(resolved)
    schemaSuite(resolved)
    recordsSuite(resolved)
  })
}
