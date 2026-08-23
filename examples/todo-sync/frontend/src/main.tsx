import { createRoot } from 'react-dom/client';
import { useDatabaseState } from '@remelondb/core/react';
import { App } from './App';
import { manager } from './db';

function Root() {
  const { status, error } = useDatabaseState(manager);
  if (status === 'ready') return <App db={manager.database} />;
  if (status === 'error' || status === 'taken-over')
    return (
      <p>
        {String(error)}{' '}
        <button onClick={() => void manager.init().catch(() => {})}>
          Retry
        </button>
      </p>
    );
  return <p>Opening database…</p>;
}

void manager.init().catch(() => {}); // errors surface through the state
createRoot(document.getElementById('root')!).render(<Root />);
