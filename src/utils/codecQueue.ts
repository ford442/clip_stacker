/**
 * Backpressure and frame-ownership helpers shared by every WebCodecs loop
 * (video export, proxy encode, decoder ring buffer, AAC premix).
 */

/** Any WebCodecs codec with a work queue. */
export type QueuedCodec = VideoEncoder | VideoDecoder | AudioEncoder | AudioDecoder;

/**
 * Longest a codec may sit without draining below the limit before the wait
 * rejects. Generous — a software 4K encode can take a second per frame — so it
 * only catches a codec that has stopped making progress altogether.
 */
export const DEFAULT_QUEUE_TIMEOUT_MS = 30_000;

/** Re-check interval: covers browsers without `dequeue` and errors that fire no event. */
const QUEUE_POLL_MS = 50;

export interface WaitForQueueOptions {
  timeoutMs?: number;
}

function queueSize(codec: QueuedCodec): number {
  if ('encodeQueueSize' in codec) return codec.encodeQueueSize ?? 0;
  return codec.decodeQueueSize ?? 0;
}

function codecName(codec: QueuedCodec): string {
  return 'encodeQueueSize' in codec ? 'Encoder' : 'Decoder';
}

/**
 * Resolve once `codec`'s queue holds fewer than `limit` items.
 *
 * Rejects when the codec closes while waiting (a codec `error` callback always
 * closes it, and fires no `dequeue`), or when the queue does not drain within
 * `timeoutMs`. Either way the loop that awaited this stops instead of hanging
 * on a promise that will never settle.
 */
export function waitForQueueBelow(
  codec: QueuedCodec,
  limit: number,
  { timeoutMs = DEFAULT_QUEUE_TIMEOUT_MS }: WaitForQueueOptions = {},
): Promise<void> {
  const closedError = () =>
    new Error(`${codecName(codec)} closed while waiting for its queue to drain`);
  if (codec.state === 'closed') return Promise.reject(closedError());
  if (queueSize(codec) < limit) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const target = codec as unknown as Partial<EventTarget>;
    const deadline = Date.now() + timeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const settle = (error: Error | null) => {
      clearTimeout(timer);
      target.removeEventListener?.('dequeue', check);
      if (error) reject(error);
      else resolve();
    };

    function check(): void {
      if (codec.state === 'closed') {
        settle(closedError());
      } else if (queueSize(codec) < limit) {
        settle(null);
      } else if (Date.now() >= deadline) {
        settle(new Error(`${codecName(codec)} queue did not drain within ${timeoutMs} ms`));
      } else {
        clearTimeout(timer);
        timer = setTimeout(check, Math.min(QUEUE_POLL_MS, Math.max(0, deadline - Date.now())));
      }
    }

    target.addEventListener?.('dequeue', check);
    timer = setTimeout(check, QUEUE_POLL_MS);
  });
}

/**
 * Hand `frame` to the encoder and close it whatever happens. `encode()` throws
 * synchronously on a closed or errored encoder; without the `finally` each
 * such frame — GPU-backed on the export path — would leak.
 */
export function encodeAndClose(
  encoder: VideoEncoder,
  frame: VideoFrame,
  options?: VideoEncoderEncodeOptions,
): void {
  try {
    encoder.encode(frame, options);
  } finally {
    frame.close();
  }
}
