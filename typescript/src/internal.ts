/** Each client's key, for its streams. Not exported from the package: the key stays out of every public field and signature. */
export const keyOf = new WeakMap<object, string>();
