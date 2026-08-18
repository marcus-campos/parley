import { describe, expect, test } from "bun:test";
import { createDecoder, encodeFrame } from "../../src/protocol/codec";

describe("encodeFrame", () => {
  test("emits exactly one newline-terminated line", () => {
    expect(encodeFrame({ v: 1, op: "who" })).toBe('{"v":1,"op":"who"}\n');
  });
});

describe("createDecoder", () => {
  test("decodes several frames arriving in one chunk", () => {
    const d = createDecoder();
    const out = d.push('{"a":1}\n{"b":2}\n');
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ ok: true, frame: { a: 1 } });
    expect(out[1]).toEqual({ ok: true, frame: { b: 2 } });
  });

  test("survives a chunk split in the middle of a line", () => {
    const d = createDecoder();
    expect(d.push('{"op":"jo')).toHaveLength(0);
    expect(d.pending()).toBeGreaterThan(0);
    const out = d.push('in","name":"FIN"}\n');
    expect(out).toEqual([{ ok: true, frame: { op: "join", name: "FIN" } }]);
    expect(d.pending()).toBe(0);
  });

  test("split across many chunks, byte by byte", () => {
    const d = createDecoder();
    const line = encodeFrame({ v: 1, op: "say", text: "olá" });
    const frames = [...line].flatMap((ch) => d.push(ch));
    expect(frames).toEqual([{ ok: true, frame: { v: 1, op: "say", text: "olá" } }]);
  });

  test("blank and whitespace-only lines are skipped", () => {
    const d = createDecoder();
    expect(d.push('\n  \n{"a":1}\n')).toEqual([{ ok: true, frame: { a: 1 } }]);
  });

  test("invalid json is reported without killing the stream", () => {
    const d = createDecoder();
    const out = d.push('not json\n{"a":1}\n');
    expect(out[0]).toMatchObject({ ok: false, error: "invalid json" });
    expect(out[1]).toEqual({ ok: true, frame: { a: 1 } });
  });

  test("a non-object frame is rejected", () => {
    const d = createDecoder();
    expect(d.push("[1,2]\n")[0]).toMatchObject({ ok: false, error: "frame is not an object" });
    expect(d.push("42\n")[0]).toMatchObject({ ok: false, error: "frame is not an object" });
  });

  test("an oversized line is dropped instead of growing the heap", () => {
    const d = createDecoder(64);
    const out = d.push(`{"pad":"${"x".repeat(500)}"}\n`);
    expect(out[0]).toMatchObject({ ok: false, error: "line exceeds maximum size" });
  });

  test("a peer that never sends a newline is cut off", () => {
    const d = createDecoder(64);
    const out = d.push("x".repeat(500));
    expect(out[0]).toMatchObject({ ok: false, error: "line exceeds maximum size" });
    expect(d.pending()).toBe(0);
  });
});
