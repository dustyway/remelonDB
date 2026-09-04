/**
 * Seeded chaos over the shared broker (remelonDB#5, v1): four simulated
 * tabs run randomized interleavings of open/insert/query/reopen plus
 * compute-worker kills. The invariants are ordering-independent:
 *
 *  1. every operation settles within a deadline (nothing hangs)
 *  2. no error surfaces beyond the designed set
 *  3. a fresh reader at the end sees exactly the acknowledged inserts
 *
 * Seeds are fixed for reproducibility; a failure names its seed. The
 * fast-check upgrade (generated sequences + shrinking) is the issue's
 * follow-up — this version trades shrinking for speed and determinism.
 */
import { describe, expect, it } from 'vitest';
import { WebSqliteDriver } from './WebSqliteDriver';

const OP_DEADLINE_MS = 25_000;
const OPS_PER_RUN = 24;
const TABS = 4;

/** mulberry32: tiny deterministic PRNG. */
const rng = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const DESIGNED_ERRORS = [
  /is not open/, // op raced a close on the same tab: designed surface
  /taken over/,
  /closed during initialization/,
];

const withDeadline = async <T>(what: string, work: Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout>;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`HANG: ${what} exceeded ${OP_DEADLINE_MS}ms`));
    }, OP_DEADLINE_MS);
  });
  try {
    return await Promise.race([work, guard]);
  } finally {
    clearTimeout(timer!);
  }
};

describe('shared broker chaos (seeded)', () => {
  for (const seed of [11, 47, 2026]) {
    it(`seed ${seed}: invariants hold across a random interleaving`, async () => {
      const random = rng(seed);
      const name = `chaos-${seed}-${Date.now()}.db`;
      const tabs: Array<{ driver: WebSqliteDriver; open: boolean }> = [];
      const acked: string[] = [];
      const journal: string[] = [];
      let inserts = 0;

      const newTab = async () => {
        const driver = new WebSqliteDriver({ shared: true });
        await withDeadline('open', driver.open(name));
        tabs.push({ driver, open: true });
      };
      await newTab();
      await withDeadline(
        'ddl',
        tabs[0]!.driver.execute(
          'create table if not exists t ("id" primary key)',
          [],
        ),
      );
      while (tabs.length < TABS) {
        await newTab();
      }

      const pick = () => tabs[Math.floor(random() * tabs.length)]!;
      for (let i = 0; i < OPS_PER_RUN; i++) {
        const roll = random();
        const tab = pick();
        const step = async () => {
          if (!tab.open && roll < 0.9) {
            await withDeadline('reopen', tab.driver.open(name));
            tab.open = true;
            return 'reopen';
          }
          if (roll < 0.45) {
            const id = `row-${seed}-${inserts++}`;
            await withDeadline(
              'insert',
              tab.driver.execute('insert into t values (?)', [id]),
            );
            acked.push(id);
            return `insert ${id}`;
          }
          if (roll < 0.75) {
            const rows = await withDeadline(
              'query',
              tab.driver.query('select count(*) as n from t', []),
            );
            expect(Number((rows[0] as { n: number }).n)).toBeGreaterThanOrEqual(
              0,
            );
            return 'query';
          }
          if (roll < 0.9) {
            await withDeadline('close', tab.driver.close());
            tab.open = false;
            return 'close';
          }
          const host = tabs.find((entry) => entry.driver.hostedComputeWorker);
          host?.driver.hostedComputeWorker?.terminate();
          return host ? 'kill host' : 'kill (no host)';
        };
        try {
          journal.push(await step());
        } catch (error) {
          const message = String(error);
          const designed = DESIGNED_ERRORS.some((rx) => rx.test(message));
          if (!designed) {
            throw new Error(
              `seed ${seed} op ${i} (${journal.slice(-4).join(' | ')}): ${message}`,
            );
          }
          journal.push(`designed error: ${message.slice(0, 60)}`);
        }
      }

      // invariant 3: a fresh reader sees exactly the acknowledged writes
      const reader = new WebSqliteDriver({ shared: true });
      await withDeadline('final open', reader.open(name));
      const rows = await withDeadline(
        'final count',
        reader.query('select "id" from t order by "id"', []),
      );
      expect(rows.map((row) => (row as { id: string }).id).sort()).toEqual(
        [...acked].sort(),
      );

      await reader.destroy().catch(() => {});
      for (const tab of tabs) {
        await tab.driver.close().catch(() => {});
        tab.driver.hostedComputeWorker?.terminate();
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }, 180_000);
  }
});
