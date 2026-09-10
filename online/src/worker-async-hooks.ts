import { AsyncLocalStorage } from "node:async_hooks";

// Worker requests can be canceled; resolving this constructor must not cache a request-bound import promise.
// https://github.com/better-auth/better-auth/issues/10315
export async function getAsyncLocalStorage(): Promise<typeof AsyncLocalStorage> {
  return AsyncLocalStorage;
}
