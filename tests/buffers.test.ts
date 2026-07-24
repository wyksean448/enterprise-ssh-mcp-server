import { describe, expect, it } from "vitest";

import { ByteCollector, ShellRingBuffer } from "../src/buffers.js";

describe("ByteCollector", () => {
  it("captures bounded output and marks truncation", () => {
    const collector = new ByteCollector(5);

    collector.append("hello");
    collector.append(" world");

    expect(collector.snapshot("utf8")).toEqual({
      text: "hello",
      bytesReceived: 11,
      bytesCaptured: 5,
      truncated: true,
    });
  });

  it("returns base64 when requested", () => {
    const collector = new ByteCollector(3);

    collector.append(Buffer.from([0, 1, 2]));

    expect(collector.snapshot("base64").text).toBe("AAEC");
  });
});

describe("ShellRingBuffer", () => {
  it("keeps the newest bytes when the ring buffer is full", () => {
    const buffer = new ShellRingBuffer(5);

    buffer.append("stdout", "hello");
    buffer.append("stdout", " world");

    const read = buffer.read(100, "utf8", false);
    expect(read.chunks.map((chunk) => chunk.data).join("")).toBe("world");
    expect(read.droppedBytes).toBe(6);
  });

  it("drains only the returned bytes", () => {
    const buffer = new ShellRingBuffer(10);

    buffer.append("stdout", "abcdef");

    const first = buffer.read(2, "utf8", true);
    const second = buffer.read(10, "utf8", true);

    expect(first.chunks.map((chunk) => chunk.data).join("")).toBe("ab");
    expect(second.chunks.map((chunk) => chunk.data).join("")).toBe("cdef");
    expect(second.remainingBytes).toBe(0);
  });
});
