import { createRoot } from 'react-dom/client'
import { App } from './App'
import { openDb } from './db'

const root = createRoot(document.getElementById('root')!)
try {
  root.render(<App db={await openDb()} />)
} catch (error) {
  // the usual cause: another tab holds the OPFS database — the driver's
  // message names the takeover option
  root.render(<p>{String(error)}</p>)
}
