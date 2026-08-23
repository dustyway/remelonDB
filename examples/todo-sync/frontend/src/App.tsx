import { useEffect, useState, useSyncExternalStore } from 'react';
import { Q, type Database, type SyncController } from '@remelondb/core';
import { useMutation, useQuery, useSyncState } from '@remelondb/core/react';
import { TodoModel } from 'example-todo-sync/schema';
import {
  getSyncNote,
  attach,
  notifyLocalWrite,
  subscribeSyncNote,
  toDemoStatus,
} from './sync';

// The status line, gated so useSyncState always has a controller; the
// first render (before the attach effect) shows the same 'syncing' the
// demo always started with.
function SyncBadge(props: {
  controller: SyncController | null;
  count: number;
}) {
  if (!props.controller)
    return <SyncBadgeBody status="syncing" count={props.count} />;
  return <ActiveSyncBadge controller={props.controller} count={props.count} />;
}

function ActiveSyncBadge(props: { controller: SyncController; count: number }) {
  const state = useSyncState(props.controller);
  return <SyncBadgeBody status={toDemoStatus(state)} count={props.count} />;
}

function SyncBadgeBody(props: { status: string; count: number }) {
  return (
    <p id="status" data-sync-status={props.status}>
      <span className="dot" /> {props.count} todo
      {props.count === 1 ? '' : 's'} · {props.status}
    </p>
  );
}

type WriteAction =
  | { type: 'add'; text: string }
  | { type: 'toggle'; todo: TodoModel }
  | { type: 'remove'; todo: TodoModel }
  | { type: 'edit'; id: string; text: string };

export function App({ db }: { db: Database }) {
  const [search, setSearch] = useState('');
  const term = search.trim();
  // No memo needed: useQuery keys on the query's structure, so
  // rebuilding it every render reuses the same live subscription.
  // Typing in the search box genuinely changes that structure —
  // keepPreviousData keeps the last results rendered (dimmed via
  // isPreviousData) instead of blanking the list on each keystroke.
  const { data: todos, isPreviousData } = useQuery(
    db
      .get(TodoModel)
      .query(
        ...(term ? [Q.where('text', Q.like(`%${Q.escapeLike(term)}%`))] : []),
        Q.sortBy('created_at', Q.desc),
      ),
    { keepPreviousData: true },
  );
  const [text, setText] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const syncNote = useSyncExternalStore(subscribeSyncNote, getSyncNote);
  const [controller, setController] = useState<SyncController | null>(null);

  // The controller owns when syncs happen (initial, 2s interval, after
  // writes, on regaining network); this effect only ties its lifetime
  // to the database's.
  useEffect(() => {
    const sync = attach(db, (fire) => {
      const onOnline = () => fire();
      window.addEventListener('online', onOnline);
      return () => window.removeEventListener('online', onOnline);
    });
    setController(sync.controller);
    return sync.detach;
  }, [db]);

  // One mutation owns every write, so the hook's ownership rule — the
  // latest invocation owns `error` — is exactly the banner's rule: a
  // newer success clears an older failure. Separate per-action hooks
  // would each hold a stale error until their own next call.
  const write = useMutation(async (action: WriteAction) => {
    await db.write(async () => {
      switch (action.type) {
        case 'add':
          await db.get(TodoModel).create({ text: action.text, done: false });
          break;
        case 'toggle':
          await db
            .get(TodoModel)
            .update(action.todo.id, { done: !action.todo.done });
          break;
        case 'remove':
          await db.get(TodoModel).markAsDeleted(action.todo.id);
          break;
        case 'edit':
          await db.get(TodoModel).update(action.id, { text: action.text });
          break;
      }
    });
    notifyLocalWrite();
  });

  // mutateAsync where the caller needs the outcome: the draft is only
  // cleared after the write commits, so a failure keeps the text.
  const add = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = text.trim();
    if (!trimmed) return;
    try {
      await write.mutateAsync({ type: 'add', text: trimmed });
      setText('');
    } catch {
      // the failure is already in write.error
    }
  };

  const commitEdit = (id: string, draft: string) => {
    setEditing(null);
    const trimmed = draft.trim();
    if (!trimmed) return;
    write.mutate({ type: 'edit', id, text: trimmed });
  };

  return (
    <>
      <h1>todo-sync</h1>
      <SyncBadge controller={controller} count={todos.length} />
      {syncNote && <p id="note">{syncNote}</p>}
      <form onSubmit={(event) => void add(event)}>
        <input
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="What needs doing?"
          aria-label="New todo"
        />
        <button type="submit" disabled={write.isPending}>
          Add
        </button>
      </form>
      {write.error != null && (
        <p id="write-error" role="alert">
          write failed: {String(write.error)}
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
            onClick={() => write.mutate({ type: 'toggle', todo })}
          >
            {editing === todo.id ? (
              <input
                aria-label="Edit todo"
                defaultValue={todo.text}
                autoFocus
                onClick={(event) => event.stopPropagation()}
                onBlur={(event) =>
                  commitEdit(todo.id, event.currentTarget.value)
                }
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur();
                  if (event.key === 'Escape') setEditing(null);
                }}
              />
            ) : (
              <span>{todo.text}</span>
            )}
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                setEditing(todo.id);
              }}
            >
              Edit
            </button>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                if (
                  window.confirm(
                    `Are you sure you want to delete ${todo.text}? It will be gone for good`,
                  )
                ) {
                  write.mutate({ type: 'remove', todo });
                }
              }}
            >
              Delete
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
