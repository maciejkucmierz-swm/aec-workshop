let lifecycleTail: Promise<void> = Promise.resolve();

/** Native audio changes share one queue across RNAA and stock Expo. Never queue network waits. */
export function serializeAudioLifecycle<T>(operation: () => T | Promise<T>): Promise<T> {
  const result = lifecycleTail.then(operation, operation);
  lifecycleTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}
