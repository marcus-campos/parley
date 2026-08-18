/**
 * NDJSON framing. One line, one object, both directions. The server also emits
 * unsolicited frames (inbox push, territory events) on the same connection, so
 * the decoder must never assume a request/response lockstep.
 */

export type DecodedLine =
  | { ok: true; frame: Record<string, unknown> }
  | { ok: false; raw: string; error: string };

export interface Decoder {
  push(chunk: string): DecodedLine[];
  /** Bytes currently buffered — an incomplete line waiting for its newline. */
  pending(): number;
}

export const DEFAULT_MAX_LINE_BYTES = 4 * 1024 * 1024;

export function encodeFrame(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

export function createDecoder(maxLineBytes: number = DEFAULT_MAX_LINE_BYTES): Decoder {
  let buffer = "";
  return {
    pending: () => Buffer.byteLength(buffer, "utf8"),
    push(chunk: string): DecodedLine[] {
      buffer += chunk;
      const out: DecodedLine[] = [];
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const raw = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        const trimmed = raw.trim();
        if (trimmed === "") continue;
        if (Buffer.byteLength(trimmed, "utf8") > maxLineBytes) {
          out.push({ ok: false, raw: "", error: "line exceeds maximum size" });
          continue;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          out.push({ ok: false, raw: trimmed, error: "invalid json" });
          continue;
        }
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          out.push({ ok: false, raw: trimmed, error: "frame is not an object" });
          continue;
        }
        out.push({ ok: true, frame: parsed as Record<string, unknown> });
      }
      // A peer that never sends a newline must not grow our heap without bound.
      if (Buffer.byteLength(buffer, "utf8") > maxLineBytes) {
        buffer = "";
        out.push({ ok: false, raw: "", error: "line exceeds maximum size" });
      }
      return out;
    },
  };
}
