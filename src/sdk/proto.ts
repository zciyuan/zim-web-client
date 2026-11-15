// Minimal protobuf wire codec for the ZIM client.
//
// Covers the frozen subset used by internal/protocol/*.proto: varint,
// length-delimited and map entries. int64 is carried as bigint/string so
// snowflake ids survive; a JS number would round them above 2^53.

export const WIRE_VARINT = 0;
export const WIRE_FIXED64 = 1;
export const WIRE_BYTES = 2;
export const WIRE_FIXED32 = 5;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const toBigInt = (value: number | bigint | string | null | undefined): bigint => {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw new Error(`not an integer: ${value}`);
    return BigInt(value);
  }
  if (typeof value === 'string' && value.trim() !== '') return BigInt(value);
  return 0n;
};

/** Writer builds one protobuf message body. */
export class Writer {
  private buf = new Uint8Array(64);
  private len = 0;

  private grow(extra: number): void {
    if (this.len + extra <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + extra) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  private byte(value: number): void {
    this.grow(1);
    this.buf[this.len++] = value & 0xff;
  }

  private varint(value: number | bigint | string): void {
    let big = BigInt.asUintN(64, toBigInt(value));
    while (big > 0x7fn) {
      this.byte(Number(big & 0x7fn) | 0x80);
      big >>= 7n;
    }
    this.byte(Number(big));
  }

  private tag(field: number, wire: number): void {
    this.varint((BigInt(field) << 3n) | BigInt(wire));
  }

  /** uint32/int32/enum field; 0 is omitted. */
  int32(field: number, value: number | undefined | null): this {
    if (!value) return this;
    this.tag(field, WIRE_VARINT);
    this.varint(value);
    return this;
  }

  /** int64 field; accepts bigint, number or decimal string. */
  int64(field: number, value: number | bigint | string | null | undefined): this {
    const big = toBigInt(value ?? 0);
    if (big === 0n) return this;
    this.tag(field, WIRE_VARINT);
    this.varint(big);
    return this;
  }

  bool(field: number, value: boolean | undefined): this {
    if (!value) return this;
    this.tag(field, WIRE_VARINT);
    this.varint(1);
    return this;
  }

  string(field: number, value: string | undefined | null): this {
    if (value === undefined || value === null || value === '') return this;
    return this.bytes(field, textEncoder.encode(String(value)));
  }

  bytes(field: number, value: Uint8Array | undefined | null): this {
    if (!value || value.length === 0) return this;
    this.tag(field, WIRE_BYTES);
    this.varint(value.length);
    this.grow(value.length);
    this.buf.set(value, this.len);
    this.len += value.length;
    return this;
  }

  message(field: number, writer: Writer | Uint8Array): this {
    return this.bytes(field, writer instanceof Writer ? writer.finish() : writer);
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

/** Reader walks one protobuf message body. */
export class Reader {
  private pos = 0;

  constructor(private readonly buf: Uint8Array) {}

  get done(): boolean {
    return this.pos >= this.buf.length;
  }

  private varint(): bigint {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      if (this.pos >= this.buf.length) throw new Error('truncated varint');
      const byte = this.buf[this.pos++];
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7n;
      if (shift > 70n) throw new Error('varint too long');
    }
    return result;
  }

  private length(): number {
    const size = Number(this.varint());
    if (size < 0 || this.pos + size > this.buf.length) throw new Error('truncated field');
    return size;
  }

  /** Returns [field, wire] or null at the end of the message. */
  next(): [number, number] | null {
    if (this.done) return null;
    const key = this.varint();
    return [Number(key >> 3n), Number(key & 7n)];
  }

  int32(): number {
    return Number(BigInt.asIntN(64, this.varint()));
  }

  int64(): string {
    return BigInt.asIntN(64, this.varint()).toString();
  }

  bool(): boolean {
    return this.varint() !== 0n;
  }

  string(): string {
    return textDecoder.decode(this.bytes());
  }

  bytes(): Uint8Array {
    const size = this.length();
    const out = this.buf.subarray(this.pos, this.pos + size);
    this.pos += size;
    return out;
  }

  skip(wire: number): void {
    switch (wire) {
      case WIRE_VARINT:
        this.varint();
        return;
      case WIRE_FIXED64:
        this.pos += 8;
        return;
      case WIRE_BYTES:
        this.bytes();
        return;
      case WIRE_FIXED32:
        this.pos += 4;
        return;
      default:
        throw new Error(`unsupported wire type ${wire}`);
    }
  }
}

export type FieldVisitor = (reader: Reader, field: number, wire: number) => void;

/** Walks the message and hands every field to the visitor. */
export const decodeFields = (bytes: Uint8Array, visit: FieldVisitor): void => {
  const reader = new Reader(bytes);
  let current = reader.next();
  while (current) {
    visit(reader, current[0], current[1]);
    current = reader.next();
  }
};
