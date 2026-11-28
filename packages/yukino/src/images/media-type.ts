import { fileTypeFromBuffer, fileTypeFromFile } from "file-type";

import { ImageMediaTypeSchema, type ImageMediaType } from "@/images/types.js";

export function asImageMediaType(type: string): ImageMediaType {
  return ImageMediaTypeSchema.parse(type);
}

export async function sniffMediaType(
  buf: Uint8Array,
): Promise<ImageMediaType | null> {
  try {
    return (
      ImageMediaTypeSchema.safeParse((await fileTypeFromBuffer(buf))?.mime)
        .data ?? null
    );
  } catch {
    return null;
  }
}

export async function sniffFileMediaType(
  absPath: string,
  signal?: AbortSignal,
): Promise<ImageMediaType | null> {
  signal?.throwIfAborted();
  const type = await fileTypeFromFile(absPath);
  signal?.throwIfAborted();
  return ImageMediaTypeSchema.safeParse(type?.mime).data ?? null;
}
