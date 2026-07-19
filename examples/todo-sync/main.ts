import { Database, Q } from '@remelondb/core'
import { WebSqliteDriver } from '@remelondb/driver-web'
import { schema, TodoModel } from './schema'

const status = document.querySelector('#status')!
const list = document.querySelector('#list')!

const db = await Database.open({
  driver: new WebSqliteDriver(),
  schema,
  modelClasses: [TodoModel],
  name: 'todo-sync.db',
})

db.get(TodoModel)
  .query(Q.sortBy('created_at', Q.desc))
  .observe((todos) => {
    status.textContent = `${todos.length} todo${todos.length === 1 ? '' : 's'}`
    list.replaceChildren(
      ...todos.map((todo) => {
        const item = document.createElement('li')
        item.textContent = todo.text
        item.classList.toggle('done', todo.done)
        return item
      }),
    )
  })
