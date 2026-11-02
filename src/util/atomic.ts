import { randomUUID } from "node:crypto";
import { chmod, open, rename, stat, unlink } from "node:fs/promises";
import { dirname, basename, join } from "node:path";

/**
 * Atomically replace `path` with `data`.
 *
 * Writes go to a sibling temp file which is fsynced and then `rename`d over
 * the destination. A crash mid-write therefore leaves the previous contents
 * intact instead of a truncated file, and a concurrent reader never observes a
 * half-written document. `rename` is atomic within a filesystem, and the temp
 * file shares the destination directory on purpose.
 *
 * File mode is preserved: the temp file inherits the destination's existing
 * permission bits before the rename, so atomically rewriting an executable
 * script does not silently drop its `+x`.
 */
export async function writeFileAtomic(
  path: string,
  data: string | Uint8Array,
  encoding: BufferEncoding = "utf8"
): Promise<void> {
  const dir = dirname(path);
  const tmp = join(dir, `.${basename(path)}.${randomUUID().slice(0, 8)}.tmp`);
  // Capture the destination mode up-front. If the file does not exist yet,
  // `stat` throws and we leave the default 0o666 & ~umask from `open`.
  const existingMode = await stat(path).then(
    (s) => s.mode & 0o777,
    () => null
  );
  const fh = await open(tmp, "w");
  try {
    await fh.writeFile(data, encoding);
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    if (existingMode !== null) await chmod(tmp, existingMode);
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

/**
 * Append a line to a JSONL file, tolerating a torn trailing line.
 *
 * If the previous writer died mid-line (no trailing newline), the append is
 * prefixed with `\n` so the new record starts on its own line instead of being
 * glued onto the corrupt fragment — which would make both records unparseable.
 */
export async function appendLineSafe(path: string, line: string): Promise<void> {
  const fh = await open(path, "a+");
  try {
    const stat = await fh.stat();
    let needsNewline = false;
    if (stat.size > 0) {
      const buf = Buffer.alloc(1);
      await fh.read(buf, 0, 1, stat.size - 1);
      needsNewline = buf[0] !== 0x0a;
    }
    await fh.write(`${needsNewline ? "\n" : ""}${line}\n`, stat.size, "utf8");
  } finally {
    await fh.close();
  }
}
