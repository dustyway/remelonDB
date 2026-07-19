import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Q, type Database } from '@remelondb/core'
import { TodoModel } from 'example-todo-sync/schema'
import { getSyncStatus, runSync, subscribeSyncStatus } from './sync'
import { useQuery } from './useQuery'

export function App({ db }: { db: Database }) {
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

  return (
    <>
      <h1>todo-sync</h1>
      <p id="status" data-sync-status={syncStatus}>
        <span className="dot" /> {todos.length} todo
        {todos.length === 1 ? '' : 's'} · {syncStatus}
      </p>
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
            {todo.text}
          </li>
        ))}
      </ul>
    </>
  )
}
