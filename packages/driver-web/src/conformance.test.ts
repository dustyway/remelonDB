import { registerDriverConformance } from '@watermelon-rewrite/driver-conformance'
import { createInProcessDriver } from './testing'

registerDriverConformance({
  name: 'web (sqlite-wasm, in-process, memory storage)',
  createDriver: () => createInProcessDriver(),
  // OPFS persistence needs a real browser worker — see README checklist
  persistence: false,
})
