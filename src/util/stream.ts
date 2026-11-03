import { StringDecoder } from "node:string_decoder";
import type { Readable } from "node:stream";

export interface TextSink {
  readonly text: string;

  readonly capped: boolean;

  flush(): string;
}

export function collectText(stream: Readable, opts: { cap?: number } = {}): TextSink {
  const decoder = new StringDecoder("utf8");
  const cap = opts.cap ?? Infinity;
  let text = "";
  let bytes = 0;
  let capped = false;

  stream.on("data", (d: Buffer | string) => {
    if (capped) return;
    const buf = typeof d === "string" ? Buffer.from(d, "utf8") : d;

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

function collectStreamText(stream: Readable, cap?: number): Promise<string> {
  const sink = collectText(stream, { cap });
  return new Promise<string>((resolve, reject) => {
    stream.on("error", reject);
    stream.on("end", () => resolve(sink.flush()));
    stream.on("close", () => resolve(sink.flush()));
  });
}
