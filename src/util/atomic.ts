import { randomUUID } from "node:crypto";
import { chmod, open, rename, stat, unlink } from "node:fs/promises";
import { dirname, basename, join } from "node:path";

export async function writeFileAtomic(
  path: string,
  data: string | Uint8Array,
  encoding: BufferEncoding = "utf8"
): Promise<void> {
  const dir = dirname(path);
  const tmp = join(dir, `.${basename(path)}.${randomUUID().slice(0, 8)}.tmp`);

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
