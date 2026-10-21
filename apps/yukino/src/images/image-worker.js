// @ts-check

import { readFile } from "node:fs/promises";
import { parentPort, workerData } from "node:worker_threads";

import decodeJpeg, { init as initJpeg } from "@jsquash/jpeg/decode.js";
import decodeWebp, { init as initWebp } from "@jsquash/webp/decode.js";
import { Jimp } from "jimp";

/** @type {import("./types.js").ImageWorkerData} */
const { request, maxDimension, maxBytes } = workerData;

/** @param {Buffer} bytes */
async function decode(bytes) {
  const image = new Jimp();
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    await initJpeg({
      wasmBinary: await readFile(
        new URL(
          import.meta.resolve("@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm"),
        ),
      ),
    });
    const bitmap = await decodeJpeg(Uint8Array.from(bytes).buffer);
    image.bitmap = {
      width: bitmap.width,
      height: bitmap.height,
      data: Buffer.from(
        bitmap.data.buffer,
        bitmap.data.byteOffset,
        bitmap.data.byteLength,
      ),
    };
    image.mime = "image/jpeg";
  } else if (
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    await initWebp({
      wasmBinary: await readFile(
        new URL(import.meta.resolve("@jsquash/webp/codec/dec/webp_dec.wasm")),
      ),
    });
    const bitmap = await decodeWebp(Uint8Array.from(bytes).buffer);
    image.bitmap = {
      width: bitmap.width,
      height: bitmap.height,
      data: Buffer.from(
        bitmap.data.buffer,
        bitmap.data.byteOffset,
        bitmap.data.byteLength,
      ),
    };
    image.mime = "image/webp";
  } else {
    const decoded = await Jimp.read(bytes);
    image.bitmap = decoded.bitmap;
    image.mime = decoded.mime;
  }
  return image;
}

/** @param {Pick<import("jimp").JimpInstance, "width" | "height" | "bitmap" | "mime">} image */
async function compress(image) {
  const scale = Math.min(
    1,
    maxDimension / image.width,
    maxDimension / image.height,
  );
  let width = Math.max(1, Math.round(image.width * scale));
  let height = Math.max(1, Math.round(image.height * scale));
  const preservePng = image.mime === "image/png" || image.mime === "image/gif";

  for (let attempt = 0; attempt < 3; attempt++) {
    // Resize replaces bitmap data, so sharing source bytes avoids a full-resolution copy.
    const resized = new Jimp({ ...image.bitmap });
    if (width !== resized.width || height !== resized.height) {
      resized.resize({ w: width, h: height });
    }
    if (preservePng) {
      const png = await resized.getBuffer("image/png", { deflateLevel: 9 });
      if (png.length <= maxBytes) {
        return result(png, "image/png", resized);
      }
    }
    for (const quality of [80, 60, 40, 20]) {
      const jpeg = await resized.getBuffer("image/jpeg", { quality });
      if (jpeg.length <= maxBytes) {
        return result(jpeg, "image/jpeg", resized);
      }
    }
    width = Math.max(1, Math.round(width / 2));
    height = Math.max(1, Math.round(height / 2));
  }
  throw new Error("Unable to compress image under the API limit.");
}

/**
 * @param {Buffer} bytes
 * @param {import("./types.js").ImageMediaType} mediaType
 * @param {{width: number, height: number}} image
 */
function result(bytes, mediaType, image) {
  return {
    data: bytes.toString("base64"),
    mediaType,
    byteLength: bytes.length,
    width: image.width,
    height: image.height,
    screenWidth: image.width,
    screenHeight: image.height,
  };
}

async function process() {
  const image = await decode(Buffer.from(request.bytes));
  const options = request.screenshot;
  if (!options) {
    return compress(image);
  }

  const screenWidth =
    options.screenWidth > 0 ? options.screenWidth : image.width;
  const screenHeight =
    options.screenHeight > 0 ? options.screenHeight : image.height;
  if (options.region) {
    const [left, top, right, bottom] = options.region;
    const scaleX = image.width / screenWidth;
    const scaleY = image.height / screenHeight;
    const x = Math.max(
      0,
      Math.min(
        image.width - 1,
        Math.round(Math.round(left * options.coordinateScaleX) * scaleX),
      ),
    );
    const y = Math.max(
      0,
      Math.min(
        image.height - 1,
        Math.round(Math.round(top * options.coordinateScaleY) * scaleY),
      ),
    );
    const endX = Math.max(
      x + 1,
      Math.min(
        image.width,
        Math.round(Math.round(right * options.coordinateScaleX) * scaleX),
      ),
    );
    const endY = Math.max(
      y + 1,
      Math.min(
        image.height,
        Math.round(Math.round(bottom * options.coordinateScaleY) * scaleY),
      ),
    );
    image.crop({ x, y, w: endX - x, h: endY - y });
  } else {
    const scale = Math.min(
      1,
      options.maxWidth / screenWidth,
      options.maxHeight / screenHeight,
    );
    const width = Math.max(1, Math.round(screenWidth * scale));
    const height = Math.max(1, Math.round(screenHeight * scale));
    if (width !== image.width || height !== image.height) {
      image.resize({ w: width, h: height });
    }
  }

  const png = await image.getBuffer("image/png", { deflateLevel: 9 });
  const output =
    png.length <= maxBytes
      ? result(png, "image/png", image)
      : await compress(image);
  return { ...output, screenWidth, screenHeight };
}

try {
  parentPort?.postMessage({ image: await process() });
} catch (error) {
  parentPort?.postMessage({
    error: error instanceof Error ? error.message : String(error),
  });
}
