import { useEffect, useState } from 'react'

// The entire React bridge: observe() is the reactivity, this hook only
// pipes emissions into state. Callers must memoize the query — a new
// object every render would resubscribe every render.
export function useQuery<R>(query: {
  observe(onChange: (records: R[]) => void): () => void
}): R[] {
  const [records, setRecords] = useState<R[]>([])
  useEffect(() => query.observe(setRecords), [query])
  return records
}
