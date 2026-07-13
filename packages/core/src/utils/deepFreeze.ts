export function deepFreeze<T>(object: T): T {
  if (typeof object !== 'object' || object === null || Object.isFrozen(object)) {
    return object
  }
  Object.freeze(object)
  for (const value of Object.values(object)) {
    deepFreeze(value)
  }
  return object
}
