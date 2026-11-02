import { StringDecoder } from "node:string_decoder";
import type { Readable } from "node:stream";

/**
 * Collect a child process stream as UTF-8 text.
 *
 * Node delivers stdout/stderr as arbitrary Buffer chunks that routinely split a
 * multi-byte UTF-8 sequence (CJK, emoji) across two `data` events. Calling
 * `chunk.toString()` on a partial buffer emits U+FFFD for the split code point,
 * silently corrupting tool output, transcripts, and evaluator diagnostics.
 *
 * `StringDecoder` holds the incomplete trailing bytes until the next chunk (or
 * the final `end` flush) so the decoded text is byte-exact. `cap` bounds the
 * retained text: once reached, no further chunks are appended (decoding keeps
 * running only until the cap is hit, then handlers no-op).
 */
export interface TextSink {
  /** Text accumulated so far. */
  readonly text: string;
  /** True once the sink stopped accepting input because of the byte cap. */
  readonly capped: boolean;
  /** Flush any buffered partial code point (call on stream end/close). */
  flush(): string;
}

export function collectText(
  stream: Readable,
  opts: { cap?: number } = {}
): TextSink {
  const decoder = new StringDecoder("utf8");
  const cap = opts.cap ?? Infinity;
  let text = "";
  let bytes = 0;
  let capped = false;

  stream.on("data", (d: Buffer | string) => {
    if (capped) return;
    const buf = typeof d === "string" ? Buffer.from(d, "utf8") : d;
    // Stop appending once the cap is reached; keep a partial chunk only when
    // it fits entirely so we never emit a half-decoded code point.
    if (bytes + buf.length > cap) {
      const room = Math.max(0, cap - bytes);
      const part = buf.subarray(0, room);
      text += decoder.write(part);
      bytes += part.length;
      capped = true;
      return;
    }
    text += decoder.write(buf);
    bytes += buf.length;
  });

  return {
    get text() {
      return text;
    },
    get capped() {
      return capped;
    },
    flush() {
      const tail = decoder.end();
      if (tail && !capped) text += tail;
      return text;
    }
  };
}

/** Convenience: collect a whole stream and return the UTF-8 text. */
function collectStreamText(stream: Readable, cap?: number): Promise<string> {
  const sink = collectText(stream, { cap });
  return new Promise<string>((resolve, reject) => {
    stream.on("error", reject);
    stream.on("end", () => resolve(sink.flush()));
    stream.on("close", () => resolve(sink.flush()));
  });
}
