import { useEffect, useState, useSyncExternalStore } from 'react'
import { Q, type Database } from '@remelondb/core'
import { useQuery } from '@remelondb/core/react'
import { TodoModel } from 'example-todo-sync/schema'
import { getSyncNote, getSyncStatus, runSync, subscribeSyncStatus } from './sync'

export function App({ db }: { db: Database }) {
  // No memo needed: useQuery keys on the query's structure, so
  // rebuilding it every render reuses the same live subscription.
  const { data: todos } = useQuery(
    db.get(TodoModel).query(Q.sortBy('created_at', Q.desc)),
  )
  const [text, setText] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const syncStatus = useSyncExternalStore(subscribeSyncStatus, getSyncStatus)
  const syncNote = useSyncExternalStore(subscribeSyncStatus, getSyncNote)

  useEffect(() => {
    void runSync(db)
    const timer = setInterval(() => void runSync(db), 2000)
    return () => clearInterval(timer)
  }, [db])

  const add = async (event: React.FormEvent) => {
    event.preventDefault()
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

  const remove = async (todo: TodoModel) => {
    await db.write(() => db.get(TodoModel).markAsDeleted(todo.id))
    void runSync(db)
  }

  const commitEdit = async (id: string, draft: string) => {
    setEditing(null)
    const trimmed = draft.trim()
    if (!trimmed) return
    await db.write(() => db.get(TodoModel).update(id, { text: trimmed }))
    void runSync(db)
  }

  return (
    <>
      <h1>todo-sync</h1>
      <p id="status" data-sync-status={syncStatus}>
        <span className="dot" /> {todos.length} todo
        {todos.length === 1 ? '' : 's'} · {syncStatus}
      </p>
      {syncNote && <p id="note">{syncNote}</p>}
      <form onSubmit={add}>
        <input
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="What needs doing?"
          aria-label="New todo"
        />
        <button type="submit">Add</button>
      </form>
      <ul>
        {todos.map((todo) => (
          <li
            key={todo.id}
            className={todo.done ? 'done' : ''}
            onClick={() => void toggle(todo)}
          >
            {editing === todo.id ? (
              <input
                aria-label="Edit todo"
                defaultValue={todo.text}
                autoFocus
                onClick={(event) => event.stopPropagation()}
                onBlur={(event) => void commitEdit(todo.id, event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur()
                  if (event.key === 'Escape') setEditing(null)
                }}
              />
            ) : (
              <span>{todo.text}</span>
            )}
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation()
                setEditing(todo.id)
              }}
            >
              Edit
            </button>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation()
                if (
                  window.confirm(
                    `Are you sure you want to delete ${todo.text}? It will be gone for good`,
                  )
                ) {
                  void remove(todo)
                }
              }}
            >
              Delete
            </button>
          </li>
        ))}
      </ul>
    </>
  )
}
