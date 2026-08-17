import { useEffect, useState, useSyncExternalStore } from 'react'
import { Q, type Database } from '@remelondb/core'
import { useMutation, useQuery } from '@remelondb/core/react'
import { TodoModel } from 'example-todo-sync/schema'
import { getSyncNote, getSyncStatus, runSync, subscribeSyncStatus } from './sync'

export function App({ db }: { db: Database }) {
  const [search, setSearch] = useState('')
  const term = search.trim()
  // No memo needed: useQuery keys on the query's structure, so
  // rebuilding it every render reuses the same live subscription.
  // Typing in the search box genuinely changes that structure —
  // keepPreviousData keeps the last results rendered (dimmed via
  // isPreviousData) instead of blanking the list on each keystroke.
  const { data: todos, isPreviousData } = useQuery(
    db
      .get(TodoModel)
      .query(
        ...(term
          ? [Q.where('text', Q.like(`%${Q.escapeLike(term)}%`))]
          : []),
        Q.sortBy('created_at', Q.desc),
      ),
    { keepPreviousData: true },
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

  // Writes go through useMutation: handlers call .mutate() and stay
  // floating-safe by construction; a failure lands in .error instead
  // of an unhandled rejection.
  const addTodo = useMutation(async (value: string) => {
    await db.write(() => db.get(TodoModel).create({ text: value, done: false }))
    void runSync(db)
  })
  const toggleTodo = useMutation(async (todo: TodoModel) => {
    await db.write(() => db.get(TodoModel).update(todo.id, { done: !todo.done }))
    void runSync(db)
  })
  const removeTodo = useMutation(async (todo: TodoModel) => {
    await db.write(() => db.get(TodoModel).markAsDeleted(todo.id))
    void runSync(db)
  })
  const editTodo = useMutation(async (id: string, value: string) => {
    await db.write(() => db.get(TodoModel).update(id, { text: value }))
    void runSync(db)
  })

  const add = (event: React.FormEvent) => {
    event.preventDefault()
    const trimmed = text.trim()
    if (!trimmed) return
    setText('')
    addTodo.mutate(trimmed)
  }

  const commitEdit = (id: string, draft: string) => {
    setEditing(null)
    const trimmed = draft.trim()
    if (!trimmed) return
    editTodo.mutate(id, trimmed)
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
        <button type="submit" disabled={addTodo.isPending}>
          Add
        </button>
      </form>
      {addTodo.error != null && (
        <p id="add-error" role="alert">
          could not add: {String(addTodo.error)}
        </p>
      )}
      <input
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder="Search todos"
        aria-label="Search todos"
      />
      <ul className={isPreviousData ? 'stale' : ''}>
        {todos.map((todo) => (
          <li
            key={todo.id}
            className={todo.done ? 'done' : ''}
            onClick={() => toggleTodo.mutate(todo)}
          >
            {editing === todo.id ? (
              <input
                aria-label="Edit todo"
                defaultValue={todo.text}
                autoFocus
                onClick={(event) => event.stopPropagation()}
                onBlur={(event) => commitEdit(todo.id, event.currentTarget.value)}
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
                  removeTodo.mutate(todo)
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
