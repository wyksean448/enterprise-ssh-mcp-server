export type WireEncoding = "utf8" | "base64";
export type OutputStreamName = "stdout" | "stderr";

export interface CapturedOutput {
  text: string;
  bytesReceived: number;
  bytesCaptured: number;
  truncated: boolean;
}

export class ByteCollector {
  private readonly limitBytes: number;
  private readonly chunks: Buffer[] = [];
  private capturedBytes = 0;
  private receivedBytes = 0;
  private outputWasTruncated = false;

  public constructor(limitBytes: number) {
    this.limitBytes = limitBytes;
  }

  public append(chunk: Buffer | string): void {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.receivedBytes += buffer.length;

    if (buffer.length === 0 || this.capturedBytes >= this.limitBytes) {
      this.outputWasTruncated = this.outputWasTruncated || buffer.length > 0;
      return;
    }

    const remainingBytes = this.limitBytes - this.capturedBytes;
    const captured = buffer.length > remainingBytes ? buffer.subarray(0, remainingBytes) : buffer;
    this.chunks.push(captured);
    this.capturedBytes += captured.length;
    this.outputWasTruncated = this.outputWasTruncated || captured.length < buffer.length;
  }

  public snapshot(encoding: WireEncoding): CapturedOutput {
    const buffer = Buffer.concat(this.chunks, this.capturedBytes);
    return {
      text: encoding === "base64" ? buffer.toString("base64") : buffer.toString("utf8"),
      bytesReceived: this.receivedBytes,
      bytesCaptured: this.capturedBytes,
      truncated: this.outputWasTruncated,
    };
  }
}

interface ShellChunk {
  stream: OutputStreamName;
  data: Buffer;
  receivedAt: string;
}

export interface ShellReadChunk {
  stream: OutputStreamName;
  data: string;
  bytes: number;
  receivedAt: string;
}

export interface ShellReadResult {
  chunks: ShellReadChunk[];
  returnedBytes: number;
  remainingBytes: number;
  droppedBytes: number;
}

export class ShellRingBuffer {
  private readonly limitBytes: number;
  private chunks: ShellChunk[] = [];
  private storedBytes = 0;
  private droppedBytes = 0;

  public constructor(limitBytes: number) {
    this.limitBytes = limitBytes;
  }

  public append(stream: OutputStreamName, data: Buffer | string): void {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buffer.length === 0) {
      return;
    }

    this.chunks.push({
      stream,
      data: buffer,
      receivedAt: new Date().toISOString(),
    });
    this.storedBytes += buffer.length;
    this.trimToLimit();
  }

  public read(maxBytes: number, encoding: WireEncoding, drain: boolean): ShellReadResult {
    const chunks: ShellReadChunk[] = [];
    let returnedBytes = 0;
    let remainingToRead = maxBytes;

    for (const chunk of this.chunks) {
      if (remainingToRead <= 0) {
        break;
      }

      const bytesToTake = Math.min(chunk.data.length, remainingToRead);
      const data = chunk.data.subarray(0, bytesToTake);
      chunks.push({
        stream: chunk.stream,
        data: encoding === "base64" ? data.toString("base64") : data.toString("utf8"),
        bytes: bytesToTake,
        receivedAt: chunk.receivedAt,
      });
      returnedBytes += bytesToTake;
      remainingToRead -= bytesToTake;
    }

    if (drain && returnedBytes > 0) {
      this.consume(returnedBytes);
    }

    return {
      chunks,
      returnedBytes,
      remainingBytes: this.storedBytes,
      droppedBytes: this.droppedBytes,
    };
  }

  public size(): number {
    return this.storedBytes;
  }

  private trimToLimit(): void {
    while (this.storedBytes > this.limitBytes && this.chunks.length > 0) {
      const excessBytes = this.storedBytes - this.limitBytes;
      const first = this.chunks[0];
      if (first === undefined) {
        return;
      }

      if (first.data.length <= excessBytes) {
        this.chunks.shift();
        this.storedBytes -= first.data.length;
        this.droppedBytes += first.data.length;
        continue;
      }

      first.data = first.data.subarray(excessBytes);
      this.storedBytes -= excessBytes;
      this.droppedBytes += excessBytes;
    }
  }

  private consume(bytesToConsume: number): void {
    let remaining = bytesToConsume;
    while (remaining > 0 && this.chunks.length > 0) {
      const first = this.chunks[0];
      if (first === undefined) {
        return;
      }

      if (first.data.length <= remaining) {
        this.chunks.shift();
        this.storedBytes -= first.data.length;
        remaining -= first.data.length;
        continue;
      }

      first.data = first.data.subarray(remaining);
      this.storedBytes -= remaining;
      remaining = 0;
    }
  }
}
