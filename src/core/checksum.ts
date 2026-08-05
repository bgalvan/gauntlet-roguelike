/**
 * Deterministic state hashing.
 *
 * Not test-only infrastructure: lockstep peers exchange a checksum every N
 * ticks to detect desync the moment it happens rather than three minutes
 * later when the wizard is visibly in a different room (§16.3, §16.7).
 *
 * Floats are hashed by their exact IEEE-754 bits, with no tolerance. That is
 * the point — "close enough" is precisely the drift that desyncs a party.
 */
export class Hasher {
  private h = 0x811c9dc5;
  private readonly view = new DataView(new ArrayBuffer(8));

  /** FNV-1a over one byte. */
  private byte(b: number): void {
    this.h ^= b & 0xff;
    this.h = Math.imul(this.h, 0x01000193);
  }

  int(value: number): this {
    this.view.setInt32(0, value | 0);
    for (let i = 0; i < 4; i++) this.byte(this.view.getUint8(i));
    return this;
  }

  bool(value: boolean): this {
    this.byte(value ? 1 : 0);
    return this;
  }

  /** Exact bit pattern — no rounding, no epsilon. */
  float(value: number): this {
    this.view.setFloat64(0, value);
    for (let i = 0; i < 8; i++) this.byte(this.view.getUint8(i));
    return this;
  }

  /** Eight lowercase hex digits. Short enough to send every tick. */
  get value(): string {
    return (this.h >>> 0).toString(16).padStart(8, '0');
  }
}
