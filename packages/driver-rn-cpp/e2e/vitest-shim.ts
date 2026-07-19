/**
 * Minimal vitest replacement so the driver-conformance suite can run
 * inside the RN app (Metro aliases 'vitest' here). Implements only what
 * the suite uses: describe/it/it.each, before/after hooks, and the
 * expect matchers toBe/toEqual/toHaveLength/toBeNull/not/rejects.toThrow.
 */

type TestFn = () => void | Promise<void>

interface Suite {
  name: string
  suites: Suite[]
  tests: { name: string; fn: TestFn }[]
  beforeAll: TestFn[]
  afterAll: TestFn[]
  beforeEach: TestFn[]
  afterEach: TestFn[]
}

const root: Suite = makeSuite('')
let current: Suite = root

function makeSuite(name: string): Suite {
  return { name, suites: [], tests: [], beforeAll: [], afterAll: [], beforeEach: [], afterEach: [] }
}

export function describe(name: string, fn: () => void): void {
  const suite = makeSuite(name)
  current.suites.push(suite)
  const prev = current
  current = suite
  fn()
  current = prev
}

export function it(name: string, fn: TestFn): void {
  current.tests.push({ name, fn })
}

it.each = <T>(cases: readonly T[]) =>
  (title: string, fn: (item: T) => void | Promise<void>) => {
    for (const item of cases) {
      const name = title.replace(/\$(\w+)/g, (_, key) =>
        String((item as Record<string, unknown>)[key]))
      current.tests.push({ name, fn: () => fn(item) })
    }
  }

export function beforeAll(fn: TestFn): void { current.beforeAll.push(fn) }
export function afterAll(fn: TestFn): void { current.afterAll.push(fn) }
export function beforeEach(fn: TestFn): void { current.beforeEach.push(fn) }
export function afterEach(fn: TestFn): void { current.afterEach.push(fn) }

function isEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    return a.every((v, i) => isEqual(v, b[i]))
  }
  // vitest's toEqual ignores undefined-valued properties
  const ka = Object.keys(a as object).filter((k) => (a as any)[k] !== undefined)
  const kb = Object.keys(b as object).filter((k) => (b as any)[k] !== undefined)
  if (ka.length !== kb.length) return false
  return ka.every((k) => isEqual((a as any)[k], (b as any)[k]))
}

function show(v: unknown): string {
  try { return JSON.stringify(v) ?? String(v) } catch { return String(v) }
}

function fail(msg: string): never {
  throw new Error(msg)
}

export function expect(actual: unknown) {
  const matchers = (negate: boolean) => {
    const check = (pass: boolean, msg: string) => {
      if (pass === negate) fail(negate ? `not: ${msg}` : msg)
    }
    return {
      toBe: (e: unknown) => check(Object.is(actual, e), `expected ${show(actual)} toBe ${show(e)}`),
      toEqual: (e: unknown) => check(isEqual(actual, e), `expected ${show(actual)} toEqual ${show(e)}`),
      toBeNull: () => check(actual === null, `expected ${show(actual)} toBeNull`),
      toHaveLength: (n: number) =>
        check((actual as { length?: number })?.length === n,
          `expected length ${n}, got ${show((actual as { length?: number })?.length)}`),
      toThrow: (pattern?: RegExp | string) => {
        let threw: unknown = null
        let didThrow = false
        try { (actual as () => unknown)() } catch (e) { didThrow = true; threw = e }
        const matches = didThrow && (pattern == null ||
          (pattern instanceof RegExp ? pattern.test(String(threw)) : String(threw).includes(pattern)))
        check(Boolean(matches), didThrow
          ? `thrown ${show(String(threw))} does not match ${pattern}`
          : 'expected function to throw')
      },
    }
  }
  return {
    ...matchers(false),
    not: matchers(true),
    rejects: {
      toThrow: async (pattern?: RegExp | string) => {
        let threw: unknown = null
        let didThrow = false
        try { await (actual as Promise<unknown>) } catch (e) { didThrow = true; threw = e }
        if (!didThrow) fail('expected promise to reject')
        if (pattern != null) {
          const ok = pattern instanceof RegExp ? pattern.test(String(threw)) : String(threw).includes(pattern)
          if (!ok) fail(`rejection ${show(String(threw))} does not match ${pattern}`)
        }
      },
    },
  }
}

export interface RunReport {
  passed: number
  failed: { path: string; error: string }[]
}

export async function runRegisteredSuites(
  onProgress?: (done: number) => void,
): Promise<RunReport> {
  const report: RunReport = { passed: 0, failed: [] }
  let done = 0

  async function runSuite(suite: Suite, path: string[], inheritedEach: { before: TestFn[]; after: TestFn[] }): Promise<void> {
    const each = {
      before: [...inheritedEach.before, ...suite.beforeEach],
      after: [...suite.afterEach, ...inheritedEach.after],
    }
    for (const hook of suite.beforeAll) await hook()
    for (const test of suite.tests) {
      const testPath = [...path, test.name].join(' › ')
      try {
        for (const hook of each.before) await hook()
        await test.fn()
        for (const hook of each.after) await hook()
        report.passed++
      } catch (e) {
        try { for (const hook of each.after) await hook() } catch {}
        report.failed.push({ path: testPath, error: String(e) })
      }
      done++
      onProgress?.(done)
    }
    for (const child of suite.suites) {
      await runSuite(child, [...path, child.name], each)
    }
    for (const hook of suite.afterAll) await hook()
  }

  await runSuite(root, [], { before: [], after: [] })
  return report
}
