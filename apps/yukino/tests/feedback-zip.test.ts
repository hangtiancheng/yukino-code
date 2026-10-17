import { inflateRawSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { crc32, createZipArchive } from "@/feedback/zip.js";

interface ParsedEntry {
  name: string;
  data: Buffer;
}

/** Minimal reader for archives produced by createZipArchive (deflate, no zip64). */
function parseZip(buf: Buffer): ParsedEntry[] {
  // Locate the end-of-central-directory record.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  expect(eocd).toBeGreaterThanOrEqual(0);
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const entries: ParsedEntry[] = [];
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(offset)).toBe(0x02014b50);
    const checksum = buf.readUInt32LE(offset + 16);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString();

    expect(buf.readUInt32LE(localOffset)).toBe(0x04034b50);
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const compressedSize = buf.readUInt32LE(localOffset + 18);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const compressed = buf.subarray(dataStart, dataStart + compressedSize);
    const data = Buffer.from(inflateRawSync(compressed));
    expect(crc32(data)).toBe(checksum);
    entries.push({ name, data });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

describe("crc32", () => {
  it("matches the reference value for '123456789'", () => {
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
  });

  it("is 0 for empty input", () => {
    expect(crc32(Buffer.alloc(0))).toBe(0);
  });
});

describe("createZipArchive", () => {
  it("round-trips text entries with nested names", () => {
    const archive = createZipArchive([
      { name: "report.json", data: '{"a":1}\n' },
      { name: "file-history/snapshots.json", data: "[]\n" },
      { name: "unicode-☑.txt", data: "故障现场 restore\n" },
    ]);
    const entries = parseZip(archive);
    expect(entries.map((e) => e.name)).toEqual([
      "report.json",
      "file-history/snapshots.json",
      "unicode-☑.txt",
    ]);
    expect(entries[0].data.toString()).toBe('{"a":1}\n');
    expect(entries[2].data.toString()).toBe("故障现场 restore\n");
  });

  it("round-trips an empty archive", () => {
    const entries = parseZip(createZipArchive([]));
    expect(entries).toEqual([]);
  });
});
