import { writeSync } from "node:fs";

import { WRITE_STALLED_ERROR } from "@/storage/constants.js";

export function writeAllSync(
  fd: number,
  bytes: Uint8Array,
  position?: number,
): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const count = writeSync(
      fd,
      bytes,
      offset,
      bytes.byteLength - offset,
      position === undefined ? null : position + offset,
    );
    if (count === 0) {
      throw new Error(WRITE_STALLED_ERROR);
    }
    offset += count;
  }
}
