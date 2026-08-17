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

type WriteAction =
  | { type: 'add'; text: string }
  | { type: 'toggle'; todo: TodoModel }
  | { type: 'remove'; todo: TodoModel }
  | { type: 'edit'; id: string; text: string }

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

  // One mutation owns every write, so the hook's ownership rule — the
  // latest invocation owns `error` — is exactly the banner's rule: a
  // newer success clears an older failure. Separate per-action hooks
  // would each hold a stale error until their own next call.
  const write = useMutation(async (action: WriteAction) => {
    await db.write(async () => {
      switch (action.type) {
        case 'add':
          await db.get(TodoModel).create({ text: action.text, done: false })
          break
        case 'toggle':
          await db
            .get(TodoModel)
            .update(action.todo.id, { done: !action.todo.done })
          break
        case 'remove':
          await db.get(TodoModel).markAsDeleted(action.todo.id)
          break
        case 'edit':
          await db.get(TodoModel).update(action.id, { text: action.text })
          break
      }
    })
    void runSync(db)
  })

  // mutateAsync where the caller needs the outcome: the draft is only
  // cleared after the write commits, so a failure keeps the text.
  const add = async () => {
    const trimmed = text.trim()
    if (!trimmed) return
    try {
      await write.mutateAsync({ type: 'add', text: trimmed })
      setText('')
    } catch {
      // the failure is already in write.error
    }
  }

  return (
    <>
      <Text style={styles.title}>todo-sync</Text>
      <Text style={styles.status}>
        <Text style={{ color: dotColors[syncStatus] }}>{'● '}</Text>
        {todos.length} todo{todos.length === 1 ? '' : 's'} · {syncStatus}
      </Text>
      {syncNote && <Text style={styles.note}>{syncNote}</Text>}
      {write.error != null && (
        <Text style={styles.error}>write failed: {String(write.error)}</Text>
      )}
      <View style={styles.row}>
        <TextInput
          style={styles.input}
          value={text}
          onChangeText={setText}
          placeholder="What needs doing?"
          onSubmitEditing={() => void add()}
        />
        <Pressable
          style={styles.button}
          onPress={() => void add()}
          disabled={write.isPending}
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
            onToggle={() => write.mutate({ type: 'toggle', todo: item })}
            onDelete={() => write.mutate({ type: 'remove', todo: item })}
            onEdit={(newText) =>
              write.mutate({ type: 'edit', id: item.id, text: newText })
            }
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
  error: { color: '#c62828', marginBottom: 8, fontSize: 13 },
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
