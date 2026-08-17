// Inference pins for the packed core + driver-node declarations. These
// files typecheck against the TARBALLS' d.ts (what an npm consumer
// sees), not the workspace source — see scripts/check-packed-types.mjs.
import {
  appSchema,
  column as c,
  table,
  Database,
  ModelFor,
  Q,
} from '@remelondb/core'
import { NodeSqliteDriver } from '@remelondb/driver-node'

const tasks = table('tasks', {
  title: c.string(),
  position: c.number().indexed(),
  done: c.boolean(),
})
const schema = appSchema({ version: 1, tables: [tasks] })
class Task extends ModelFor(tasks) {}

// model fields carry their column types through the packed declarations
declare const task: Task
task.title satisfies string
task.position satisfies number
task.done satisfies boolean

// Database.open stays typed through dist
void (Database.open({
  driver: new NodeSqliteDriver(),
  schema,
  modelClasses: [Task],
  name: ':memory:',
}) satisfies Promise<Database>)

// query building and fetch keep the model type
declare const db: Database
const query = db.get(Task).query(Q.where('title', 'x'), Q.sortBy('position', Q.desc))
void (query.fetch() satisfies Promise<Task[]>)

export {}
