/**
 * A ring of reusable `MAP_READ` staging buffers with pipelined `mapAsync`.
 *
 * `readback` records the copy and submits synchronously (in the caller's
 * task — the source may be overwritten by the next frame), then resolves
 * once the slot is mapped and `consume` has copied out of it. Up to `depth`
 * readbacks can be in flight, so the GPU keeps composing the next frames
 * while earlier ones map. Buffers are allocated once per size; a steady
 * export allocates nothing per frame.
 */

export const DEFAULT_READBACK_DEPTH = 3;

interface Slot {
  buffer: GPUBuffer | null;
  size: number;
  busy: Promise<void> | null;
}

export class ReadbackRingFullError extends Error {
  constructor(depth: number) {
    super(`All ${depth} readback slots are in flight; await one before capturing another frame`);
    this.name = 'ReadbackRingFullError';
  }
}

export class ReadbackRing {
  private readonly slots: Slot[];
  private next = 0;
  private destroyed = false;

  constructor(
    private readonly device: GPUDevice,
    readonly depth: number = DEFAULT_READBACK_DEPTH,
  ) {
    this.slots = Array.from({ length: depth }, () => ({ buffer: null, size: 0, busy: null }));
  }

  /** Readbacks submitted and not yet consumed. */
  get inFlight(): number {
    return this.slots.filter((slot) => slot.busy !== null).length;
  }

  get hasFreeSlot(): boolean {
    return this.slots.some((slot) => slot.busy === null);
  }

  /**
   * Copy `byteLength` bytes of `source` (recorded by `record` into a fresh
   * encoder, before the copy) into a free slot and map it. `consume` gets the
   * mapped bytes and must copy what it keeps — the range is unmapped after.
   * Throws {@link ReadbackRingFullError} when every slot is in flight.
   */
  readback<T>(
    record: (encoder: GPUCommandEncoder) => GPUBuffer,
    byteLength: number,
    consume: (bytes: ArrayBuffer) => T,
  ): Promise<T> {
    if (this.destroyed) return Promise.reject(new Error('Readback ring destroyed'));
    const slot = this.takeSlot();
    if (!slot) throw new ReadbackRingFullError(this.depth);
    const size = Math.ceil(byteLength / 4) * 4;
    if (!slot.buffer || slot.size !== size) {
      slot.buffer?.destroy();
      slot.buffer = this.device.createBuffer({
        size,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      slot.size = size;
    }
    const staging = slot.buffer;
    const encoder = this.device.createCommandEncoder();
    const source = record(encoder);
    encoder.copyBufferToBuffer(source, 0, staging, 0, size);
    this.device.queue.submit([encoder.finish()]);

    let release!: () => void;
    slot.busy = new Promise<void>((resolve) => {
      release = resolve;
    });
    const done = (async () => {
      try {
        await staging.mapAsync(GPUMapMode.READ, 0, size);
        try {
          return consume(staging.getMappedRange(0, size));
        } finally {
          staging.unmap();
        }
      } finally {
        slot.busy = null;
        release();
      }
    })();
    return done;
  }

  /** Resolves once at least one slot is free. */
  async waitForSlot(): Promise<void> {
    while (!this.hasFreeSlot) {
      await Promise.race(this.slots.map((slot) => slot.busy).filter(Boolean));
    }
  }

  private takeSlot(): Slot | null {
    for (let i = 0; i < this.depth; i++) {
      const index = (this.next + i) % this.depth;
      const slot = this.slots[index]!;
      if (slot.busy === null) {
        this.next = (index + 1) % this.depth;
        return slot;
      }
    }
    return null;
  }

  destroy(): void {
    this.destroyed = true;
    for (const slot of this.slots) {
      // A slot still mapping is destroyed by its own pending map rejecting.
      slot.buffer?.destroy();
      slot.buffer = null;
    }
  }
}
