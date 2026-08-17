// Inference pins for the packed react bindings. The select pins exist
// because this exact inference regressed once at the overload level:
// `(rows) => ...` must stay contextually typed with and without
// keepPreviousData, from the packed d.ts.
import { Q, type Database, column as c, table, ModelFor } from '@remelondb/core'
import {
  useMutation,
  useQuery,
  useQueryCountResult,
} from '@remelondb/core/react'

const decks = table('decks', { title: c.string(), position: c.number() })
class Deck extends ModelFor(decks) {}

declare const db: Database

export function Fixture() {
  const query = db.get(Deck).query(Q.where('title', 'x'))

  // select infers the row array without annotation
  const selected = useQuery(query, { select: (rows) => rows[0]?.title })
  selected.data satisfies string | undefined

  // both options together must keep contextual typing
  const both = useQuery(query, {
    keepPreviousData: true,
    select: (rows) => rows.length,
  })
  both.data satisfies number
  both.isPreviousData satisfies boolean

  const plain = useQuery(query)
  plain.data satisfies Deck[]
  plain.isPreviousData satisfies boolean

  const count = useQueryCountResult(query)
  count.data satisfies number

  const mutation = useMutation(async (id: string) => id.length)
  mutation.mutate('id')
  void (mutation.mutateAsync('id') satisfies Promise<number>)
  mutation.error satisfies unknown
  mutation.isPending satisfies boolean

  return null
}
