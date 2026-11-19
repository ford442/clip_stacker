/**
 * Where render-cache files live: the origin private file system (OPFS) when
 * the browser offers writable OPFS files, otherwise memory (lost on reload).
 *
 * Paths are `/`-separated and relative to the cache root
 * (`render-cache/` in OPFS). OPFS's `createWritable` writes to a swap file
 * and commits on `close()`, so a crash mid-write never leaves a torn file
 * under the real name.
 *
 * #279 moves the working-media store onto OPFS too; this backend is the
 * render cache's own directory and does not depend on it.
 */

export interface CacheFileInfo {
  path: string;
  size: number;
  lastModified: number;
}

export interface CacheBackend {
  readonly kind: 'opfs' | 'memory';
  /** Whether files survive a reload. */
  readonly persistent: boolean;
  list(): Promise<CacheFileInfo[]>;
  /** The file's bytes, or null when it does not exist. */
  read(path: string): Promise<Uint8Array | null>;
  write(path: string, bytes: Uint8Array): Promise<void>;
  /** Removing a missing file is a no-op. */
  remove(path: string): Promise<void>;
  /** Remove every file. */
  clear(): Promise<void>;
}

export function createMemoryCacheBackend(now: () => number = Date.now): CacheBackend {
  const files = new Map<string, { bytes: Uint8Array; lastModified: number }>();
  return {
    kind: 'memory',
    persistent: false,
    async list() {
      return [...files].map(([path, file]) => ({ path, size: file.bytes.byteLength, lastModified: file.lastModified }));
    },
    async read(path) {
      return files.get(path)?.bytes.slice() ?? null;
    },
    async write(path, bytes) {
      files.set(path, { bytes: bytes.slice(), lastModified: now() });
    },
    async remove(path) {
      files.delete(path);
    },
    async clear() {
      files.clear();
    },
  };
}

// The slice of the File System Access API the backend uses, typed here
// because the DOM lib's async-iterable handle methods are not in this
// project's `lib`.
interface OpfsWritable {
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort?(): Promise<void>;
}

/** @public — structural type tests implement in memory. */
export interface OpfsFileHandle {
  readonly kind: 'file';
  getFile(): Promise<File>;
  createWritable?(): Promise<OpfsWritable>;
}

/** @public — structural type tests implement in memory. */
export interface OpfsDirectoryHandle {
  readonly kind: 'directory';
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<OpfsDirectoryHandle>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<OpfsFileHandle>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  entries(): AsyncIterable<[string, OpfsDirectoryHandle | OpfsFileHandle]>;
}

function isNotFound(err: unknown): boolean {
  return err instanceof DOMException
    ? err.name === 'NotFoundError' || err.name === 'TypeMismatchError'
    : (err as { name?: string } | null)?.name === 'NotFoundError';
}

function splitPath(path: string): { dirs: string[]; name: string } {
  const parts = path.split('/').filter(Boolean);
  const name = parts.pop();
  if (!name || parts.some((part) => part === '..' || part === '.')) throw new Error(`Bad cache path ${path}`);
  return { dirs: parts, name };
}

/** A cache backend over one OPFS directory (tests pass an in-memory handle). */
export function createOpfsCacheBackend(root: OpfsDirectoryHandle): CacheBackend {
  const dirFor = async (dirs: string[], create: boolean): Promise<OpfsDirectoryHandle | null> => {
    let dir = root;
    for (const name of dirs) {
      try {
        dir = await dir.getDirectoryHandle(name, { create });
      } catch (err) {
        if (!create && isNotFound(err)) return null;
        throw err;
      }
    }
    return dir;
  };

  const walk = async (dir: OpfsDirectoryHandle, prefix: string, out: CacheFileInfo[]) => {
    for await (const [name, handle] of dir.entries()) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (handle.kind === 'directory') {
        await walk(handle, path, out);
      } else {
        try {
          const file = await handle.getFile();
          out.push({ path, size: file.size, lastModified: file.lastModified });
        } catch (err) {
          if (!isNotFound(err)) throw err;
        }
      }
    }
  };

  return {
    kind: 'opfs',
    persistent: true,
    async list() {
      const out: CacheFileInfo[] = [];
      await walk(root, '', out);
      return out;
    },
    async read(path) {
      const { dirs, name } = splitPath(path);
      const dir = await dirFor(dirs, false);
      if (!dir) return null;
      try {
        const file = await (await dir.getFileHandle(name)).getFile();
        return new Uint8Array(await file.arrayBuffer());
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },
    async write(path, bytes) {
      const { dirs, name } = splitPath(path);
      const dir = await dirFor(dirs, true);
      const handle = await dir!.getFileHandle(name, { create: true });
      if (!handle.createWritable) throw new Error('OPFS writable files are not supported here');
      const writable = await handle.createWritable();
      try {
        await writable.write(bytes);
        await writable.close();
      } catch (err) {
        await writable.abort?.().catch(() => undefined);
        throw err;
      }
    },
    async remove(path) {
      const { dirs, name } = splitPath(path);
      const dir = await dirFor(dirs, false);
      if (!dir) return;
      try {
        await dir.removeEntry(name);
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
    },
    async clear() {
      const names: string[] = [];
      for await (const [name] of root.entries()) names.push(name);
      for (const name of names) {
        try {
          await root.removeEntry(name, { recursive: true });
        } catch (err) {
          if (!isNotFound(err)) throw err;
        }
      }
    },
  };
}

/** Name of the render cache's directory at the OPFS root. */
export const RENDER_CACHE_DIRECTORY = 'render-cache';

/**
 * The OPFS backend when this browser has writable OPFS files (probed by
 * writing and removing a file), else null.
 */
export async function openOpfsCacheBackend(): Promise<CacheBackend | null> {
  const storage = typeof navigator !== 'undefined' ? navigator.storage : undefined;
  if (!storage?.getDirectory) return null;
  try {
    const top = (await storage.getDirectory()) as unknown as OpfsDirectoryHandle;
    const root = await top.getDirectoryHandle(RENDER_CACHE_DIRECTORY, { create: true });
    const probe = await root.getFileHandle('.probe', { create: true });
    if (!probe.createWritable) return null;
    const backend = createOpfsCacheBackend(root);
    await backend.write('.probe', new Uint8Array([1]));
    await backend.remove('.probe');
    return backend;
  } catch {
    return null;
  }
}
