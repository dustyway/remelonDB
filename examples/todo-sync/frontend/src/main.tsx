import { createRoot } from 'react-dom/client'
import { App } from './App'
import { openDb } from './db'

const db = await openDb()
createRoot(document.getElementById('root')!).render(<App db={db} />)
