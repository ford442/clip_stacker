import { useEffect, useState } from 'react';

/**
 * A file's own colour tags (from its container / codec config), read once
 * per `Blob` and cached. `undefined` while reading; null when untagged or
 * unreadable.
 */
const cache = new WeakMap<Blob, Promise<VideoColorSpaceInit | null>>();

function readTags(file: Blob): Promise<VideoColorSpaceInit | null> {
  let pending = cache.get(file);
  if (!pending) {
    pending = import('../export/container/demux')
      .then(({ readVideoColorSpace }) => readVideoColorSpace(file))
      .catch(() => null);
    cache.set(file, pending);
  }
  return pending;
}

export function useSourceColorSpace(file: Blob | null | undefined): VideoColorSpaceInit | null | undefined {
  const [state, setState] = useState<{ file: Blob | null | undefined; tags: VideoColorSpaceInit | null | undefined }>({
    file: undefined,
    tags: undefined,
  });
  useEffect(() => {
    if (!file || file.size === 0) return;
    let alive = true;
    void readTags(file).then((tags) => {
      if (alive) setState({ file, tags });
    });
    return () => {
      alive = false;
    };
  }, [file]);
  if (!file || file.size === 0) return null;
  return state.file === file ? state.tags : undefined;
}
