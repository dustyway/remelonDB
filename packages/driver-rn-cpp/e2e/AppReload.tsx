/**
 * Reload-teardown test for @remelondb/driver-rn: the last device-side
 * open item. Run 1 opens a database, writes, and — with the connection
 * deliberately left open — triggers a dev reload. The reload tears down
 * the React instance and with it the TurboModule; the C++ side must
 * close the SQLite handle (no leaked WAL/journal locks, no crash). Run 2
 * (same JS bundle, fresh React instance) proves it: reopening succeeds,
 * the data is intact, and new writes go through.
 *
 * Swap this in for App.tsx in the harness app (index.js imports ./App):
 *   cp AppReload.tsx <harness>/App.tsx
 * Verdict renders on screen: RELOAD PASS / RELOAD FAIL. Each PASS run
 * ends with destroy(), so the cycle starts fresh every time.
 */
import React, { useEffect, useState } from 'react'
import { DevSettings, SafeAreaView, StatusBar, StyleSheet, Text } from 'react-native'
import { RnSqliteDriver } from '@remelondb/driver-rn'

type Result = { name: string; ok: boolean; detail?: string }

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg)
}

const DB = 'reload.db'

async function firstRun(d: RnSqliteDriver, push: (r: Result) => void): Promise<void> {
  await d.execute('CREATE TABLE t (id TEXT PRIMARY KEY, n INT)', [])
  await d.execute('INSERT INTO t (id, n) VALUES (?, ?)', ['before-reload', 1])
  const rows = await d.query('SELECT COUNT(*) AS c FROM t', [])
  assert(rows[0].c === 1, `pre-reload count: ${rows[0].c}`)
  await d.setUserVersion(1)
  push({ name: 'run 1: wrote a row, marked user_version=1', ok: true })
  // The point of the test: do NOT close — reload with the connection open.
  setTimeout(() => DevSettings.reload(), 800)
}

async function secondRun(d: RnSqliteDriver, push: (r: Result) => void): Promise<void> {
  const step = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn()
      push({ name, ok: true })
    } catch (e) {
      push({ name, ok: false, detail: String(e) })
      throw e
    }
  }

  // The open() that got us here succeeding at all means the previous
  // instance's teardown released the file; anything leaked shows below.
  push({ name: 'reopen after reload (previous connection left open)', ok: true })

  await step('data written before reload is intact', async () => {
    const rows = await d.query('SELECT id, n FROM t', [])
    assert(rows.length === 1, `rows: ${rows.length}`)
    assert(rows[0].id === 'before-reload', `id: ${rows[0].id}`)
  })

  await step('journal mode is still WAL', async () => {
    const rows = await d.query('PRAGMA journal_mode', [])
    assert(rows[0]?.journal_mode === 'wal', JSON.stringify(rows))
  })

  await step('writes work in the new instance (no lingering lock)', async () => {
    await d.execute('INSERT INTO t (id, n) VALUES (?, ?)', ['after-reload', 2])
    const rows = await d.query('SELECT COUNT(*) AS c FROM t', [])
    assert(rows[0].c === 2, `post-reload count: ${rows[0].c}`)
  })

  await step('cleanup: destroy for the next cycle', async () => {
    await d.destroy()
  })
}

export default function App(): React.JSX.Element {
  const [results, setResults] = useState<Result[]>([])
  const [verdict, setVerdict] = useState<'RUNNING' | 'RELOADING…' | 'RELOAD PASS' | 'RELOAD FAIL'>('RUNNING')

  useEffect(() => {
    const push = (r: Result) => {
      console.log(`WMRELOAD: ${r.ok ? 'ok' : 'FAIL'} - ${r.name}${r.detail ? ` :: ${r.detail}` : ''}`)
      setResults((prev) => [...prev, r])
    }
    ;(async () => {
      try {
        const d = new RnSqliteDriver()
        const { userVersion } = await d.open(DB)
        if (userVersion === 0) {
          await firstRun(d, push)
          setVerdict('RELOADING…')
        } else {
          assert(userVersion === 1, `userVersion after reload: ${userVersion}`)
          await secondRun(d, push)
          console.log('WMRELOAD: PASS')
          setVerdict('RELOAD PASS')
        }
      } catch (e) {
        push({ name: 'unexpected failure', ok: false, detail: String(e) })
        console.log('WMRELOAD: FAILED')
        setVerdict('RELOAD FAIL')
      }
    })()
  }, [])

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar barStyle="light-content" />
      <Text style={[styles.verdict, verdict === 'RELOAD PASS' ? styles.pass : verdict === 'RELOAD FAIL' ? styles.fail : null]}>
        {verdict}
      </Text>
      {results.map((r, i) => (
        <Text key={i} style={[styles.line, r.ok ? styles.pass : styles.fail]}>
          {r.ok ? '✓' : '✗'} {r.name}
          {r.detail ? `\n   ${r.detail}` : ''}
        </Text>
      ))}
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
