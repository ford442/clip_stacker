/**
 * One typed RPC for every dedicated worker (#365).
 *
 * A protocol is a plain type map, shared by the client and the worker:
 *
 * ```ts
 * type AnalysisProtocol = {
 *   analyzeFrame: { req: { pcm: Float32Array }; res: { bands: Float32Array } }; // call
 *   reset: { notify: void };                                                    // main → worker
 *   progress: { event: { fraction: number } };                                  // worker → main
 * };
 * ```
 *
 * - **Calls** (`{ req; res }`) get a request id, a transfer list, an
 *   `AbortSignal`, a timeout, and settle exactly once: with the handler's
 *   value, its thrown error (message + name cross back), or a
 *   `WorkerCrashedError` when the worker dies or is terminated.
 * - **Notifications** (`{ notify }`, main → worker) and **events**
 *   (`{ event }`, worker → main) are the stream channel: fire-and-forget
 *   messages in post order, for protocols that are not one request / one
 *   answer (the export premix's `need-pcm` / `pcm-part`, the preview's
 *   `need-frames` / `frames-ready`). Their payloads are the protocol's own.
 *
 * The worker factory is a callback because Vite only bundles a worker whose
 * `new Worker(new URL('…', import.meta.url))` is literal; those literals all
 * live in `workerFactories.ts` (lint forbids `new Worker` elsewhere).
 */

// --------------------------------------------------------------------------
// Protocol type map
// --------------------------------------------------------------------------

type ProtocolEntry = { req: unknown; res: unknown } | { event: unknown } | { notify: unknown };

/** Name → call / notification / event. Declare protocols as `type` aliases (not interfaces). */
export type WorkerProtocol = Record<string, ProtocolEntry>;

export type CallName<P> = {
  [K in keyof P]: P[K] extends { req: unknown; res: unknown } ? K : never;
}[keyof P] &
  string;
export type EventName<P> = { [K in keyof P]: P[K] extends { event: unknown } ? K : never }[keyof P] & string;
export type NotifyName<P> = { [K in keyof P]: P[K] extends { notify: unknown } ? K : never }[keyof P] & string;

export type CallRequest<P, K extends keyof P> = P[K] extends { req: infer R } ? R : never;
export type CallResponse<P, K extends keyof P> = P[K] extends { res: infer R } ? R : never;
export type EventData<P, K extends keyof P> = P[K] extends { event: infer E } ? E : never;
export type NotifyData<P, K extends keyof P> = P[K] extends { notify: infer N } ? N : never;

/** A `void` payload may be omitted. */
type PayloadArgs<T, Rest extends unknown[]> = [T] extends [void] ? [payload?: T, ...Rest] : [payload: T, ...Rest];

// --------------------------------------------------------------------------
// Errors
// --------------------------------------------------------------------------

export type WorkerCrashReason = 'crashed' | 'terminated' | 'start-failed';

/**
 * Every call still pending when its worker dies (`error` / `messageerror`),
 * is terminated, or could not start rejects with this. Copy Debug labels it
 * with the worker's name (`debugReport.ts`).
 */
export class WorkerCrashedError extends Error {
  override readonly name = 'WorkerCrashedError';

  constructor(
    readonly workerName: string,
    readonly reason: WorkerCrashReason,
    readonly detail?: string,
  ) {
    super(
      reason === 'terminated'
        ? `${workerName} worker terminated`
        : reason === 'start-failed'
          ? `${workerName} worker could not start${detail ? `: ${detail}` : ''}`
          : `${workerName} worker failed: ${detail || 'worker error'}`,
    );
  }
}

/** A call that outlived its `timeoutMs`. The worker is told to cancel it. */
export class WorkerTimeoutError extends Error {
  override readonly name = 'WorkerTimeoutError';

  constructor(
    readonly workerName: string,
    readonly method: string,
    readonly timeoutMs: number,
  ) {
    super(`${workerName} worker: ${method} timed out after ${timeoutMs}ms`);
  }
}

export interface WorkerCrashRecord {
  worker: string;
  reason: WorkerCrashReason;
  message: string;
  timestamp: number;
}

const CRASH_LOG_LIMIT = 10;
const crashLog: WorkerCrashRecord[] = [];

/** Recent worker crashes and start failures in this realm, oldest first (Copy Debug). */
export function getWorkerCrashLog(): readonly WorkerCrashRecord[] {
  return crashLog;
}

function recordCrash(error: WorkerCrashedError): void {
  if (error.reason === 'terminated') return;
  crashLog.push({ worker: error.workerName, reason: error.reason, message: error.message, timestamp: Date.now() });
  if (crashLog.length > CRASH_LOG_LIMIT) crashLog.splice(0, crashLog.length - CRASH_LOG_LIMIT);
}

/** Test-only. */
export function __clearWorkerCrashLogForTests(): void {
  crashLog.length = 0;
}

interface SerializedError {
  message: string;
  name: string;
}

function serializeError(err: unknown): SerializedError {
  if (err instanceof Error) return { message: err.message, name: err.name };
  if (typeof DOMException !== 'undefined' && err instanceof DOMException) return { message: err.message, name: err.name };
  return { message: String(err), name: 'Error' };
}

function deserializeError(err: SerializedError): Error {
  if (err.name === 'AbortError' && typeof DOMException !== 'undefined') return new DOMException(err.message, 'AbortError');
  const error = new Error(err.message);
  error.name = err.name;
  return error;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason instanceof Error || (typeof DOMException !== 'undefined' && signal.reason instanceof DOMException)
    ? signal.reason
    : new DOMException('Aborted', 'AbortError');
}

// --------------------------------------------------------------------------
// Wire format (internal)
// --------------------------------------------------------------------------

type MainToWorker =
  | { rpc: 'call'; id: number; method: string; payload: unknown }
  | { rpc: 'cancel'; id: number }
  | { rpc: 'notify'; name: string; payload: unknown };

type WorkerToMain =
  | { rpc: 'result'; id: number; payload: unknown }
  | { rpc: 'error'; id: number; error: SerializedError }
  | { rpc: 'event'; name: string; payload: unknown };

function isEnvelope(data: unknown): data is { rpc: string } {
  return typeof data === 'object' && data !== null && typeof (data as { rpc?: unknown }).rpc === 'string';
}

// --------------------------------------------------------------------------
// Main-thread client
// --------------------------------------------------------------------------

/** What the client needs of a `Worker` (tests pass an in-process stand-in). */
export interface WorkerLike {
  postMessage(message: unknown, transfer: Transferable[]): void;
  onmessage: ((ev: MessageEvent) => void) | null;
  onerror: ((ev: ErrorEvent) => void) | null;
  onmessageerror?: ((ev: MessageEvent) => void) | null;
  terminate(): void;
}

export interface WorkerClientOptions {
  /** Shown in errors and Copy Debug ("audio render worker failed: …"). */
  name: string;
  /**
   * `'never'` (default): a crash ends the client; later calls reject with
   * the crash error. `'on-crash'`: the next call spawns a fresh worker.
   */
  restart?: 'never' | 'on-crash';
  /** Default per-call timeout; none when omitted. */
  timeoutMs?: number;
  /** The worker died (not called for `terminate()`); pending calls are already rejected. */
  onCrash?: (error: WorkerCrashedError) => void;
}

export interface CallOptions {
  transfer?: Transferable[] | undefined;
  /** Abort rejects the call with the signal's reason and tells the worker (its `ctx.signal`). */
  signal?: AbortSignal | undefined;
  /** Overrides the client's `timeoutMs`; 0 = none. */
  timeoutMs?: number | undefined;
}

export interface NotifyOptions {
  transfer?: Transferable[] | undefined;
}

export interface WorkerClient<P extends WorkerProtocol> {
  /** Spawn the worker now. False when it cannot run (factory threw, crashed, terminated). */
  start(): boolean;
  /** False once the client can no longer run a worker. */
  readonly available: boolean;
  /** Why the client is unavailable (null while it can still run). */
  readonly failure: WorkerCrashedError | null;
  call<K extends CallName<P>>(
    method: K,
    ...args: PayloadArgs<CallRequest<P, K>, [options?: CallOptions]>
  ): Promise<CallResponse<P, K>>;
  /** Fire-and-forget main → worker message; dropped when the worker cannot run. */
  notify<K extends NotifyName<P>>(name: K, ...args: PayloadArgs<NotifyData<P, K>, [options?: NotifyOptions]>): void;
  /** Subscribe to a worker → main event. Returns unsubscribe. */
  on<K extends EventName<P>>(name: K, listener: (data: EventData<P, K>) => void): () => void;
  /** Kill the worker and reject every pending call with `WorkerCrashedError` (`'terminated'`). Final. */
  terminate(): void;
}

/** Bivariant callback type, so typed listeners / handlers fit one untyped table. */
type Loose<A extends unknown[], R> = { bivarianceHack(...args: A): R }['bivarianceHack'];

interface PendingCall {
  resolve: Loose<[value: unknown], void>;
  reject: (err: unknown) => void;
  cleanup: () => void;
}

export function createWorkerClient<P extends WorkerProtocol>(
  factory: () => WorkerLike,
  options: WorkerClientOptions,
): WorkerClient<P> {
  const { name } = options;
  let worker: WorkerLike | null = null;
  let failure: WorkerCrashedError | null = null;
  let nextId = 1;
  const pending = new Map<number, PendingCall>();
  const listeners = new Map<string, Set<Loose<[data: unknown], void>>>();

  const rejectAll = (error: WorkerCrashedError) => {
    const calls = [...pending.values()];
    pending.clear();
    for (const call of calls) {
      call.cleanup();
      call.reject(error);
    }
  };

  const detach = (w: WorkerLike) => {
    w.onmessage = null;
    w.onerror = null;
    if ('onmessageerror' in w) w.onmessageerror = null;
    try {
      w.terminate();
    } catch {
      // Already gone.
    }
  };

  const crash = (w: WorkerLike, detail: string) => {
    if (worker !== w) return;
    worker = null;
    detach(w);
    const error = new WorkerCrashedError(name, 'crashed', detail);
    recordCrash(error);
    if (options.restart !== 'on-crash') failure = error;
    rejectAll(error);
    options.onCrash?.(error);
  };

  const receive = (data: unknown) => {
    if (!isEnvelope(data)) return;
    const msg = data as WorkerToMain;
    switch (msg.rpc) {
      case 'result':
      case 'error': {
        const call = pending.get(msg.id);
        if (!call) return;
        pending.delete(msg.id);
        call.cleanup();
        if (msg.rpc === 'result') call.resolve(msg.payload);
        else call.reject(deserializeError(msg.error));
        return;
      }
      case 'event': {
        const set = listeners.get(msg.name);
        if (!set) return;
        for (const listener of [...set]) {
          try {
            listener(msg.payload);
          } catch (err) {
            console.error(`[${name} worker] ${msg.name} listener failed`, err);
          }
        }
        return;
      }
    }
  };

  const ensureWorker = (): WorkerLike | null => {
    if (worker) return worker;
    if (failure) return null;
    let w: WorkerLike;
    try {
      w = factory();
    } catch (err) {
      failure = new WorkerCrashedError(name, 'start-failed', serializeError(err).message);
      recordCrash(failure);
      return null;
    }
    w.onmessage = (ev) => receive(ev.data);
    w.onerror = (ev) => crash(w, ev?.message || 'worker error');
    w.onmessageerror = () => crash(w, 'a message could not be deserialized');
    worker = w;
    return w;
  };

  const post = (w: WorkerLike, message: MainToWorker, transfer: Transferable[]) => {
    w.postMessage(message, transfer);
  };

  const client: WorkerClient<P> = {
    start: () => ensureWorker() !== null,
    get available() {
      return failure === null;
    },
    get failure() {
      return failure;
    },

    call(method, ...args) {
      const [payload, callOptions] = args;
      const signal = callOptions?.signal;
      if (signal?.aborted) return Promise.reject(abortReason(signal));
      const w = ensureWorker();
      if (!w) return Promise.reject(failure);
      const id = nextId++;
      return new Promise((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        const onAbort = () => {
          if (!pending.delete(id)) return;
          cleanup();
          cancel();
          reject(signal ? abortReason(signal) : new DOMException('Aborted', 'AbortError'));
        };
        const cleanup = () => {
          if (timer !== null) clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
        };
        const cancel = () => {
          if (worker !== w) return;
          try {
            post(w, { rpc: 'cancel', id }, []);
          } catch {
            // The worker is gone; nothing to cancel.
          }
        };
        pending.set(id, { resolve: (value) => resolve(value as CallResponse<P, typeof method>), reject, cleanup });
        const timeoutMs = callOptions?.timeoutMs ?? options.timeoutMs ?? 0;
        if (timeoutMs > 0) {
          timer = setTimeout(() => {
            if (!pending.delete(id)) return;
            cleanup();
            cancel();
            reject(new WorkerTimeoutError(name, method, timeoutMs));
          }, timeoutMs);
        }
        signal?.addEventListener('abort', onAbort, { once: true });
        try {
          post(w, { rpc: 'call', id, method, payload }, callOptions?.transfer ?? []);
        } catch (err) {
          pending.delete(id);
          cleanup();
          reject(err);
        }
      });
    },

    notify(notifyName, ...args) {
      const [payload, notifyOptions] = args;
      const w = ensureWorker();
      if (!w) return;
      post(w, { rpc: 'notify', name: notifyName, payload }, notifyOptions?.transfer ?? []);
    },

    on(eventName, listener) {
      let set = listeners.get(eventName);
      if (!set) {
        set = new Set();
        listeners.set(eventName, set);
      }
      const entry: Loose<[data: unknown], void> = listener;
      set.add(entry);
      return () => {
        set.delete(entry);
      };
    },

    terminate() {
      // A crash or start failure stays the reason later calls are refused.
      const error = failure ?? new WorkerCrashedError(name, 'terminated');
      failure = error;
      const w = worker;
      worker = null;
      if (w) detach(w);
      rejectAll(error);
    },
  };
  return client;
}

// --------------------------------------------------------------------------
// Worker side
// --------------------------------------------------------------------------

/** What `exposeWorker` needs of the worker's global scope (tests pass an in-process one). */
export interface WorkerScopeLike {
  postMessage(message: unknown, transfer: Transferable[]): void;
  onmessage: ((ev: MessageEvent) => void) | null;
}

/** The dedicated worker's own scope; null on the main thread (and under happy-dom). */
export function dedicatedWorkerScope(): WorkerScopeLike | null {
  if (typeof document !== 'undefined' || typeof self === 'undefined') return null;
  const scope = self as DedicatedWorkerGlobalScope;
  return typeof scope.postMessage === 'function' ? scope : null;
}

const TRANSFER_REPLY = Symbol('workerRpc.transferReply');

/** A handler's value plus the buffers to transfer with it (see `withTransfer`). */
export interface TransferReply<T> {
  readonly value: T;
  readonly transfer: Transferable[];
  readonly [TRANSFER_REPLY]: true;
}

/** Return `{ value, transfer }` from a handler: `value` is posted with `transfer` moved, not copied. */
export function withTransfer<T>(value: T, transfer: Transferable[]): TransferReply<T> {
  return { value, transfer, [TRANSFER_REPLY]: true };
}

function isTransferReply(value: unknown): value is TransferReply<unknown> {
  return typeof value === 'object' && value !== null && TRANSFER_REPLY in value;
}

export interface CallContext {
  /** Aborted when main aborts the call or it times out. */
  readonly signal: AbortSignal;
}

type MaybePromise<T> = T | Promise<T>;

/** The worker's handler table: one entry per call and per notification of `P`. */
export type WorkerHandlers<P> = {
  [K in CallName<P>]: (
    req: CallRequest<P, K>,
    ctx: CallContext,
  ) => MaybePromise<CallResponse<P, K> | TransferReply<CallResponse<P, K>>>;
} & {
  [K in NotifyName<P>]: (data: NotifyData<P, K>) => void | Promise<void>;
};

export interface WorkerPort<P> {
  /** Post a worker → main event. */
  emit<K extends EventName<P>>(name: K, ...args: PayloadArgs<EventData<P, K>, [transfer?: Transferable[]]>): void;
}

export interface ExposeWorkerOptions {
  /** Defaults to the dedicated worker scope. */
  scope?: WorkerScopeLike;
}

function lookupHandler(table: object, key: string): Loose<[payload: unknown, ctx: CallContext], unknown> | null {
  if (key in Object.prototype) return null;
  const fn: unknown = Reflect.get(table, key);
  return typeof fn === 'function' ? (payload, ctx) => fn.call(table, payload, ctx) : null;
}

/**
 * Serve `P` from this worker. `handlers` may be a function of the port, so
 * handlers can `emit` events. Returns the port, or null outside a worker
 * (so a worker module imported by a test does nothing).
 */
export function exposeWorker<P extends WorkerProtocol>(
  handlers: WorkerHandlers<P> | ((port: WorkerPort<P>) => WorkerHandlers<P>),
  exposeOptions: ExposeWorkerOptions = {},
): WorkerPort<P> | null {
  const scope = exposeOptions.scope ?? dedicatedWorkerScope();
  if (!scope) return null;
  const post = (message: WorkerToMain, transfer: Transferable[] = []) => scope.postMessage(message, transfer);
  const port: WorkerPort<P> = {
    emit(name, ...args) {
      const [payload, transfer] = args;
      post({ rpc: 'event', name, payload }, transfer ?? []);
    },
  };
  const table: object = typeof handlers === 'function' ? handlers(port) : handlers;
  const active = new Map<number, AbortController>();

  const runCall = async (id: number, method: string, payload: unknown) => {
    const controller = new AbortController();
    active.set(id, controller);
    try {
      const handler = lookupHandler(table, method);
      if (!handler) throw new Error(`unknown worker call: ${method}`);
      const result = await handler(payload, { signal: controller.signal });
      if (isTransferReply(result)) post({ rpc: 'result', id, payload: result.value }, result.transfer);
      else post({ rpc: 'result', id, payload: result });
    } catch (err) {
      try {
        post({ rpc: 'error', id, error: serializeError(err) });
      } catch (postErr) {
        console.error('[workerRpc] cannot post an error back', postErr);
      }
    } finally {
      active.delete(id);
    }
  };

  const runNotify = (notifyName: string, payload: unknown) => {
    const handler = lookupHandler(table, notifyName);
    if (!handler) {
      console.warn(`[workerRpc] unknown notification: ${notifyName}`);
      return;
    }
    try {
      const result = handler(payload, { signal: new AbortController().signal });
      if (result instanceof Promise) {
        result.catch((err: unknown) => console.error(`[workerRpc] ${notifyName} failed`, err));
      }
    } catch (err) {
      console.error(`[workerRpc] ${notifyName} failed`, err);
    }
  };

  scope.onmessage = (ev) => {
    const data: unknown = ev.data;
    if (!isEnvelope(data)) return;
    const msg = data as MainToWorker;
    switch (msg.rpc) {
      case 'call':
        void runCall(msg.id, msg.method, msg.payload);
        return;
      case 'cancel':
        active.get(msg.id)?.abort(new DOMException('Cancelled', 'AbortError'));
        return;
      case 'notify':
        runNotify(msg.name, msg.payload);
        return;
    }
  };
  return port;
}
