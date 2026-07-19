import { StatusBar } from 'expo-status-bar'
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import {
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { Q, type Database } from '@remelondb/core'
import { TodoModel } from 'example-todo-sync/schema'
import { openDb } from './src/db'
import { getSyncStatus, runSync, subscribeSyncStatus } from './src/sync'
import { useQuery } from './src/useQuery'

// Hermes has no top-level await, so the database opens behind a state
// gate instead of the web client's awaited module import.
export default function App() {
  const [db, setDb] = useState<Database | null>(null)
  useEffect(() => {
    void openDb().then(setDb)
  }, [])
  return (
    <View style={styles.container}>
      {db ? <Todos db={db} /> : <Text>opening database…</Text>}
      <StatusBar style="auto" />
    </View>
  )
}

const dotColors: Record<string, string> = {
  synced: '#2e7d32',
  offline: '#c62828',
  syncing: '#bbbbbb',
}

function Todos({ db }: { db: Database }) {
  const todos = useQuery(
    useMemo(
      () => db.get(TodoModel).query(Q.sortBy('created_at', Q.desc)),
      [db],
    ),
  )
  const [text, setText] = useState('')
  const syncStatus = useSyncExternalStore(subscribeSyncStatus, getSyncStatus)

  useEffect(() => {
    void runSync(db)
    const timer = setInterval(() => void runSync(db), 2000)
    return () => clearInterval(timer)
  }, [db])

  const add = async () => {
    const trimmed = text.trim()
    if (!trimmed) return
    setText('')
    await db.write(() =>
      db.get(TodoModel).create({ text: trimmed, done: false }),
    )
    void runSync(db)
  }

  const toggle = async (todo: TodoModel) => {
    await db.write(() =>
      db.get(TodoModel).update(todo.id, { done: !todo.done }),
    )
    void runSync(db)
  }

  return (
    <>
      <Text style={styles.title}>todo-sync</Text>
      <Text style={styles.status}>
        <Text style={{ color: dotColors[syncStatus] }}>{'● '}</Text>
        {todos.length} todo{todos.length === 1 ? '' : 's'} · {syncStatus}
      </Text>
      <View style={styles.row}>
        <TextInput
          style={styles.input}
          value={text}
          onChangeText={setText}
          placeholder="What needs doing?"
          onSubmitEditing={() => void add()}
        />
        <Pressable style={styles.button} onPress={() => void add()}>
          <Text style={styles.buttonText}>Add</Text>
        </Pressable>
      </View>
      <FlatList
        style={styles.list}
        data={todos}
        keyExtractor={(todo) => todo.id}
        renderItem={({ item }) => (
          <Pressable onPress={() => void toggle(item)}>
            <Text style={[styles.item, item.done && styles.done]}>
              {item.text}
            </Text>
          </Pressable>
        )}
      />
    </>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingTop: 80, paddingHorizontal: 24 },
  title: { fontSize: 28, fontWeight: '600' },
  status: { color: '#666', marginVertical: 8 },
  row: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 6,
    padding: 8,
  },
  button: {
    backgroundColor: '#eee',
    borderRadius: 6,
    paddingHorizontal: 16,
    justifyContent: 'center',
  },
  buttonText: { fontWeight: '600' },
  list: { flex: 1 },
  item: { paddingVertical: 6, fontSize: 16 },
  done: { textDecorationLine: 'line-through', color: '#999' },
})
