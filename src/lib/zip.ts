import { inflateRawSync } from 'node:zlib';

export interface ZipEntry {
  name: string;
  read: () => Buffer;
}

/**
 * Minimal, dependency-free ZIP reader (stored + deflate) for Instagram data exports.
 * Output size per entry is capped to protect against zip bombs.
 */
export function readZip(buf: Buffer, maxEntryBytes = 100 * 1024 * 1024): ZipEntry[] {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('קובץ ZIP לא תקין');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('מבנה ZIP לא תקין');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    entries.push({
      name,
      read: () => {
        if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`רשומת ZIP פגומה: ${name}`);
        const start = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
        const data = buf.subarray(start, start + compSize);
        if (size > maxEntryBytes) throw new Error(`הקובץ ${name} גדול מדי`);
        if (method === 0) return Buffer.from(data);
        if (method === 8) return inflateRawSync(data, { maxOutputLength: maxEntryBytes });
        throw new Error(`שיטת דחיסה לא נתמכת (${method}) בקובץ ${name}`);
      },
    });
  }
  return entries;
}
