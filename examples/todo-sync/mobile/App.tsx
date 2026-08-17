import { StatusBar } from 'expo-status-bar'
import { useEffect, useState, useSyncExternalStore } from 'react'
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
import { useDatabaseState, useMutation, useQuery } from '@remelondb/core/react'
import { TodoItem } from './components/TodoItem'
import { manager } from './src/db'
import {
  getSyncNote,
  getSyncStatus,
  runSync,
  subscribeSyncStatus,
} from './src/sync'
import { theme } from './theme'

export default function App() {
  const { status, error } = useDatabaseState(manager)
  useEffect(() => {
    void manager.init().catch(() => {}) // errors surface through the state
  }, [])
  return (
    <View style={styles.container}>
      {status === 'ready' ? (
        <Todos db={manager.database} />
      ) : status === 'error' ? (
        <Text>{String(error)}</Text>
      ) : (
        <Text>opening database…</Text>
      )}
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
  // Structural keying: no memo, the rebuilt query reuses the
  // subscription.
  const { data: todos } = useQuery(
    db.get(TodoModel).query(Q.sortBy('created_at', Q.desc)),
  )
  const [text, setText] = useState('')
  const syncStatus = useSyncExternalStore(subscribeSyncStatus, getSyncStatus)
  const syncNote = useSyncExternalStore(subscribeSyncStatus, getSyncNote)

  useEffect(() => {
    void runSync(db)
    const timer = setInterval(() => void runSync(db), 2000)
    return () => clearInterval(timer)
  }, [db])

  // Writes go through useMutation: press handlers call .mutate() and
  // stay floating-safe; a failure lands in .error instead of an
  // unhandled rejection.
  const addTodo = useMutation(async (value: string) => {
    await db.write(() => db.get(TodoModel).create({ text: value, done: false }))
    void runSync(db)
  })
  const toggleTodo = useMutation(async (todo: TodoModel) => {
    await db.write(() =>
      db.get(TodoModel).update(todo.id, { done: !todo.done }),
    )
    void runSync(db)
  })
  const removeTodo = useMutation(async (todo: TodoModel) => {
    await db.write(() => db.get(TodoModel).markAsDeleted(todo.id))
    void runSync(db)
  })
  const editTodo = useMutation(async (todo: TodoModel, newText: string) => {
    await db.write(() => db.get(TodoModel).update(todo.id, { text: newText }))
    void runSync(db)
  })

  const add = () => {
    const trimmed = text.trim()
    if (!trimmed) return
    setText('')
    addTodo.mutate(trimmed)
  }

  return (
    <>
      <Text style={styles.title}>todo-sync</Text>
      <Text style={styles.status}>
        <Text style={{ color: dotColors[syncStatus] }}>{'● '}</Text>
        {todos.length} todo{todos.length === 1 ? '' : 's'} · {syncStatus}
      </Text>
      {syncNote && <Text style={styles.note}>{syncNote}</Text>}
      <View style={styles.row}>
        <TextInput
          style={styles.input}
          value={text}
          onChangeText={setText}
          placeholder="What needs doing?"
          onSubmitEditing={add}
        />
        <Pressable
          style={styles.button}
          onPress={add}
          disabled={addTodo.isPending}
        >
          <Text style={styles.buttonText}>Add</Text>
        </Pressable>
      </View>
      <FlatList
        style={styles.list}
        data={todos}
        keyExtractor={(todo) => todo.id}
        renderItem={({ item }) => (
          <TodoItem
            todo={item}
            onToggle={() => toggleTodo.mutate(item)}
            onDelete={() => removeTodo.mutate(item)}
            onEdit={(newText) => editTodo.mutate(item, newText)}
          />
        )}
      />
    </>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingTop: 80,
    paddingHorizontal: 16,
    backgroundColor: theme.colorWhite,
  },
  title: { fontSize: 28, fontWeight: '600' },
  status: { color: theme.colorGrey, marginVertical: 8 },
  note: { color: theme.colorCerulean, marginBottom: 8, fontSize: 13 },
  row: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: theme.colorCerulean,
    borderRadius: 6,
    padding: 8,
  },
  button: {
    backgroundColor: theme.colorBlack,
    borderRadius: 6,
    paddingHorizontal: 16,
    justifyContent: 'center',
  },
  buttonText: {
    color: theme.colorWhite,
    fontWeight: 'bold',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  list: { flex: 1 },
})
