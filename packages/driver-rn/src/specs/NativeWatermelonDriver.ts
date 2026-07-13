/**
 * Codegen spec for the pure C++ TurboModule (docs/architecture-layers.md
 * §4): bridgeless-compatible by construction, no manual global.* installs.
 *
 * All methods are synchronous — SQLite runs in-process on the JS thread
 * (like upstream's JSI mode); the RnSqliteDriver wraps results in
 * Promises to satisfy the seam contract.
 *
 * UnsafeMixed is used where the value vocabulary (string | number |
 * boolean | null, nested in arrays) exceeds what codegen's type system
 * can express; the C++ side validates shapes.
 */
import { TurboModuleRegistry, type TurboModule } from 'react-native'
import type { UnsafeMixed } from 'react-native/Libraries/Types/CodegenTypes'

export interface Spec extends TurboModule {
  /** Opens (creating if needed) and returns PRAGMA user_version. */
  openDatabase(name: string): number
  close(name: string): void
  /** SELECT → array of column-name-keyed row objects. */
  query(name: string, sql: string, args: UnsafeMixed): UnsafeMixed
  execute(name: string, sql: string, args: UnsafeMixed): void
  /** [[sql, [args, ...]], ...] — one atomic transaction. */
  executeBatch(name: string, statements: UnsafeMixed): void
  setUserVersion(name: string, version: number): void
  destroy(name: string): void
}

export default TurboModuleRegistry.getEnforcing<Spec>('NativeWatermelonDriver')
