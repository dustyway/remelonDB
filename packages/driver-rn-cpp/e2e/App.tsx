/**
 * Runtime smoke test for @remelondb/driver-rn.
 * Each check logs `WMSMOKE: ...` so results are readable via
 * `adb logcat -s ReactNativeJS` without watching the screen.
 */
import React, { useEffect, useState } from 'react'
import { SafeAreaView, ScrollView, StatusBar, StyleSheet, Text } from 'react-native'
import {
  appSchema,
  column as c,
  table,
  Database,
  ModelFor,
  Q,
} from '@remelondb/core'
import { RnSqliteDriver } from '@remelondb/driver-rn'
import { registerDriverConformance } from '@remelondb/driver-conformance'
import { runRegisteredSuites } from './vitest-shim'

type Result = { name: string; ok: boolean; detail?: string }

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg)
}

async function runSeamTests(push: (r: Result) => void): Promise<void> {
  const step = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn()
      push({ name, ok: true })
    } catch (e) {
      push({ name, ok: false, detail: String(e) })
      throw e
    }
  }

  let d = new RnSqliteDriver()

  await step('open file db (JNI database path)', async () => {
    const { userVersion } = await d.open('smoke.db')
    assert(typeof userVersion === 'number', `userVersion: ${userVersion}`)
    await d.destroy()
    d = new RnSqliteDriver()
    await d.open('smoke.db')
  })

  await step('journal mode is WAL', async () => {
    const rows = await d.query('PRAGMA journal_mode', [])
    assert(rows[0]?.journal_mode === 'wal', JSON.stringify(rows))
  })

  await step('create table + batch insert', async () => {
    await d.execute('DROP TABLE IF EXISTS t', [])
    await d.execute(
      'CREATE TABLE t (id TEXT PRIMARY KEY, n REAL, s TEXT, b INT, z TEXT)',
      [],
    )
    await d.executeBatch([
      [
        'INSERT INTO t (id, n, s, b, z) VALUES (?, ?, ?, ?, ?)',
        [
          ['a', 1.5, 'héllo wörld 🍉', 1, null],
          ['b', -42, '', 0, null],
        ],
      ],
    ])
  })

  await step('typed roundtrip via query args', async () => {
    const rows = await d.query('SELECT * FROM t WHERE id = ?', ['a'])
    assert(rows.length === 1, `rows: ${rows.length}`)
    const r = rows[0]
    assert(r.n === 1.5, `n: ${r.n}`)
    assert(r.s === 'héllo wörld 🍉', `s: ${r.s}`)
    assert(r.b === 1, `b: ${r.b}`)
    assert(r.z === null, `z: ${String(r.z)}`)
  })

  await step('failing batch rolls back atomically', async () => {
    let threw = false
    try {
      await d.executeBatch([
        ['INSERT INTO t (id) VALUES (?)', [['c']]],
        ['INSERT INTO t (id) VALUES (?)', [['a']]], // PK collision
      ])
    } catch {
      threw = true
    }
    assert(threw, 'batch with PK collision did not throw')
    const rows = await d.query('SELECT COUNT(*) AS c FROM t', [])
    assert(rows[0].c === 2, `count after rollback: ${rows[0].c}`)
  })

  await step('bad SQL throws a catchable JS error', async () => {
    let msg = ''
    try {
      await d.query('SELECT FROM WHERE', [])
    } catch (e) {
      msg = String(e)
    }
    assert(msg.length > 0, 'no error thrown')
  })

  await step('user_version survives close/reopen', async () => {
    await d.setUserVersion(7)
    await d.close()
    d = new RnSqliteDriver()
    const { userVersion } = await d.open('smoke.db')
    assert(userVersion === 7, `userVersion after reopen: ${userVersion}`)
    const rows = await d.query('SELECT COUNT(*) AS c FROM t', [])
    assert(rows[0].c === 2, `rows after reopen: ${rows[0].c}`)
  })

  await step('destroy wipes the database', async () => {
    await d.destroy()
    d = new RnSqliteDriver()
    const { userVersion } = await d.open('smoke.db')
    assert(userVersion === 0, `userVersion after destroy: ${userVersion}`)
    const rows = await d.query(
      "SELECT COUNT(*) AS c FROM sqlite_master WHERE name = 't'",
      [],
    )
    assert(rows[0].c === 0, 'table t survived destroy')
    await d.destroy()
  })
}

const tasks = table('tasks', {
  name: c.string(),
  position: c.number().indexed(),
  is_done: c.boolean(),
})

class SmokeTask extends ModelFor(tasks) {}

async function runCoreTest(push: (r: Result) => void): Promise<void> {
  const schema = appSchema({ version: 1, tables: [tasks] })

  try {
    const cleaner = new RnSqliteDriver()
    await cleaner.open('smoke-core.db')
    await cleaner.destroy()

    const db = await Database.open({
      driver: new RnSqliteDriver(),
      schema,
      modelClasses: [SmokeTask],
      name: 'smoke-core.db',
    })
    const task = await db.write(() =>
      db.get(SmokeTask).create({ name: 'on device', position: 1 }),
    )
    await db.write(() => task.update(() => { task.is_done = true }))
    const done = await db
      .get(SmokeTask)
      .query(Q.where('is_done', true))
      .fetch()
    assert(done.length === 1, `done tasks: ${done.length}`)
    assert(done[0].name === 'on device', `name: ${done[0].name}`)
    push({ name: 'core Database end-to-end', ok: true })
  } catch (e) {
    push({ name: 'core Database end-to-end', ok: false, detail: String(e) })
    throw e
  }
}

async function runConformance(push: (r: Result) => void): Promise<void> {
  let counter = 0
  registerDriverConformance({
    name: 'react-native (C++ TurboModule)',
    createDriver: () => new RnSqliteDriver(),
    persistence: { databaseName: () => `conf-${counter++}.db` },
  })
  const report = await runRegisteredSuites((done) => {
    if (done % 50 === 0) console.log(`WMCONF: ...${done} tests run`)
  })
  for (const f of report.failed) {
    console.log(`WMCONF: FAIL ${f.path} :: ${f.error}`)
  }
  console.log(`WMCONF: ${report.passed} passed, ${report.failed.length} failed`)
  push({
    name: `conformance: ${report.passed} passed, ${report.failed.length} failed`,
    ok: report.failed.length === 0,
    detail: report.failed.length ? report.failed[0].path : undefined,
  })
  if (report.failed.length > 0) {
    throw new Error('conformance failures')
  }
}

export default function App(): React.JSX.Element {
  const [results, setResults] = useState<Result[]>([])
  const [verdict, setVerdict] = useState<'RUNNING' | 'PASS' | 'FAIL'>('RUNNING')

  useEffect(() => {
    const push = (r: Result) => {
      console.log(`WMSMOKE: ${r.ok ? 'ok' : 'FAIL'} - ${r.name}${r.detail ? ` :: ${r.detail}` : ''}`)
      setResults((prev) => [...prev, r])
    }
    ;(async () => {
      try {
        await runSeamTests(push)
        await runCoreTest(push)
        await runConformance(push)
        console.log('WMSMOKE: ALL PASS')
        setVerdict('PASS')
      } catch {
        console.log('WMSMOKE: FAILED')
        setVerdict('FAIL')
      }
    })()
  }, [])

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar barStyle="light-content" />
      <Text style={[styles.verdict, verdict === 'PASS' ? styles.pass : verdict === 'FAIL' ? styles.fail : null]}>
        {verdict}
      </Text>
      <ScrollView>
        {results.map((r, i) => (
          <Text key={i} style={[styles.line, r.ok ? styles.pass : styles.fail]}>
            {r.ok ? '✓' : '✗'} {r.name}
            {r.detail ? `\n   ${r.detail}` : ''}
          </Text>
        ))}
      </ScrollView>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0c1322', padding: 16 },
  verdict: { fontSize: 28, fontWeight: '800', color: '#93a1bd', marginBottom: 12 },
  line: { fontFamily: 'monospace', fontSize: 14, marginBottom: 6, color: '#eef2f9' },
  pass: { color: '#4bd07f' },
  fail: { color: '#ff6f64' },
})
