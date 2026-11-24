/** ci-memory's gateway port when its manifest names none. */
const DEFAULT_MEMORY_PORT = 8642;

/** The name a consumer app reaches ci-memory's gateway by, on the network linking the two. */
export const MEMORY_LINK_ALIAS = 'ci-memory';

/** The Memory URL a consumer app is given: ci-memory's gateway by {@link MEMORY_LINK_ALIAS}. */
export function memoryConsumerUrl(port: number | string = DEFAULT_MEMORY_PORT): string {
  return `http://${MEMORY_LINK_ALIAS}:${port}`;
}

/**
 * A stored brokered Memory URL as a consumer can use it now. Connections made before apps had
 * networks of their own stored `http://gateway:<port>`, which a consumer reached over the shared
 * network; it reaches the gateway as {@link MEMORY_LINK_ALIAS} now. The port is kept.
 */
export function consumerMemoryUrlFrom(stored: string): string {
  try {
    const url = new URL(stored);
    return memoryConsumerUrl(url.port || DEFAULT_MEMORY_PORT);
  } catch {
    return memoryConsumerUrl();
  }
}
