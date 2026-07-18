import { z } from 'zod'
import { appSchema, ModelFor, type InferRecord } from '@remelondb/core'
import { syncSchemas, zodTable } from '@remelondb/zod'

// One Zod object is the single source of truth. Everything below —
// the client table, the record types, the model class, and the sync
// wire validators used by both the browser and the server — derives
// from it. Change a field here and every layer follows or fails to
// compile.
export const Todo = z.object({
  text: z.string().min(1),
  done: z.boolean(),
  created_at: z.number().int(),
})

export const todos = zodTable('todos', Todo, { indexed: ['created_at'] })
export const schema = appSchema({ version: 1, tables: [todos] })

// Typed accessors come from the table definition; nothing to declare.
export class TodoModel extends ModelFor(todos) {}

// Wire validators for pull/push, shared by client and server.
export const wire = syncSchemas({ todos: Todo })

export type TodoRecord = InferRecord<typeof todos>
