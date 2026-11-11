/**
 * Hard deadline for a unit of async work. Injected or mocked transports may
 * ignore AbortSignal, so the deadline is enforced by racing, never by the
 * signal alone (a never-settling fetch would otherwise hang the caller).
 * @template T
 * @param {() => Promise<T>} work
 * @param {number} ms
 * @param {string} label
 * @returns {Promise<T>}
 */
export async function withDeadline(work, ms, label) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let handle;
  const deadline = new Promise((_, reject) => {
    handle = setTimeout(() => reject(new Error(`${label} estourou o tempo (${ms} ms)`)), ms);
  });
  try {
    return await Promise.race([work(), deadline]);
  } finally {
    clearTimeout(handle);
  }
}
