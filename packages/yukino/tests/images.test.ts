// These tests run the REAL jimp pipeline (no mocks): fixtures are generated
// with jimp itself and tests/test.png is a real screenshot (JPEG bytes behind
// a .png extension, which doubles as a magic-bytes-vs-extension fixture).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import encodeWebp, { init as initWebp } from "@jsquash/webp/encode.js";
import { Jimp, type JimpInstance } from "jimp";
import { beforeAll, describe, expect, it } from "vitest";

import {
  MAX_DIMENSION_PX,
  MAX_IMAGE_BYTES_PASSTHROUGH,
} from "@/images/constants.js";
import {
  isImagePath,
  getMediaType,
  sniffMediaType,
  ImageTooLargeError,
  loadImageAttachment,
  maybeResizeAndDownsampleImage,
  processScreenshot,
} from "@/images/index.js";
const TEST_PNG_PATH = join(dirname(fileURLToPath(import.meta.url)), "test.png");

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const GIF_MAGIC = Buffer.from("GIF89a", "ascii");
const WEBP_MAGIC = Buffer.concat([
  Buffer.from("RIFF", "ascii"),
  Buffer.alloc(4),
  Buffer.from("WEBP", "ascii"),
]);

// Random noise is nearly incompressible, which is the cheapest way to make
// real oversized fixtures. Generated once and shared across tests.
function noiseImage(width: number, height: number): JimpInstance {
  const image = new Jimp({ width, height, color: 0x808080ff });
  const data = image.bitmap.data;
  for (let i = 0; i < data.length; i += 4) {
    data[i] = (Math.random() * 256) | 0;
    data[i + 1] = (Math.random() * 256) | 0;
    data[i + 2] = (Math.random() * 256) | 0;
    data[i + 3] = 255;
  }
  return image;
}

// 1600x1600 noise PNG ≈ 8MB: over the 3.75MB passthrough target but under the
// 2000px dimension cap, so only re-encoding (not resizing) is required. Noise
// is incompressible, so the PNG attempt fails and the JPEG ladder wins.
let oversizedPng: Buffer;
// 3000x3000 noise JPEG (q100) ≈ 10MB: over both the size and dimension caps.
let oversizedJpeg: Buffer;
let oversizedWebp: Buffer;

beforeAll(async () => {
  [oversizedPng, oversizedJpeg] = await Promise.all([
    noiseImage(1600, 1600).getBuffer("image/png"),
    noiseImage(3000, 3000).getBuffer("image/jpeg", { quality: 100 }),
  ]);
  expect(oversizedPng.length).toBeGreaterThan(MAX_IMAGE_BYTES_PASSTHROUGH);
  expect(oversizedJpeg.length).toBeGreaterThan(MAX_IMAGE_BYTES_PASSTHROUGH);
  await initWebp({
    wasmBinary: readFileSync(
      new URL(import.meta.resolve("@jsquash/webp/codec/enc/webp_enc.wasm")),
    ),
  });
  const webpImage = await Jimp.read(oversizedPng);
  oversizedWebp = Buffer.from(
    await encodeWebp(
      {
        width: webpImage.width,
        height: webpImage.height,
        data: new Uint8ClampedArray(webpImage.bitmap.data),
        colorSpace: "srgb",
      },
      { lossless: 1 },
    ),
  );
  expect(oversizedWebp.length).toBeGreaterThan(MAX_IMAGE_BYTES_PASSTHROUGH);
}, 60_000);

describe("detect", () => {
  it("maps extensions to media types", () => {
    expect(getMediaType("a/b/shot.png")).toBe("image/png");
    expect(getMediaType("shot.JPG")).toBe("image/jpeg");
    expect(getMediaType("shot.jpeg")).toBe("image/jpeg");
    expect(getMediaType("anim.gif")).toBe("image/gif");
    expect(getMediaType("pic.webp")).toBe("image/webp");
    expect(getMediaType("doc.txt")).toBeNull();
    expect(isImagePath("x.png")).toBe(true);
    expect(isImagePath("x.ts")).toBe(false);
  });

  it("sniffs magic bytes", () => {
    expect(sniffMediaType(PNG_MAGIC)).toBe("image/png");
    expect(sniffMediaType(JPEG_MAGIC)).toBe("image/jpeg");
    expect(sniffMediaType(GIF_MAGIC)).toBe("image/gif");
    expect(sniffMediaType(WEBP_MAGIC)).toBe("image/webp");
    expect(sniffMediaType(Buffer.from("not an image at all"))).toBeNull();
    expect(sniffMediaType(Buffer.alloc(0))).toBeNull();
  });

  it("sniffs the real test image as JPEG despite its .png extension", () => {
    const buf = readFileSync(TEST_PNG_PATH);
    expect(getMediaType(TEST_PNG_PATH)).toBe("image/png");
    expect(sniffMediaType(buf)).toBe("image/jpeg");
  });
});

describe("loadImageAttachment (real file)", () => {
  it("loads tests/test.png with magic bytes winning over the extension", async () => {
    const buf = readFileSync(TEST_PNG_PATH);
    const attachment = await loadImageAttachment(TEST_PNG_PATH);
    // ~123KB is under the passthrough target: the payload must be untouched.
    expect(attachment.mediaType).toBe("image/jpeg");
    expect(attachment.data).toBe(buf.toString("base64"));
    expect(attachment.byteLength).toBe(buf.length);
    expect(attachment.sourcePath).toBe(TEST_PNG_PATH);
  });
});

describe("maybeResizeAndDownsampleImage (real jimp)", () => {
  it("passes small images through byte-identical without re-encoding", async () => {
    const buf = readFileSync(TEST_PNG_PATH);
    const result = await maybeResizeAndDownsampleImage(buf, "image/jpeg");
    expect(result.data).toBe(buf.toString("base64"));
    expect(result.mediaType).toBe("image/jpeg");
    expect(result.byteLength).toBe(buf.length);
  });

  it("rejects empty buffers", async () => {
    await expect(
      maybeResizeAndDownsampleImage(Buffer.alloc(0), "image/png"),
    ).rejects.toThrow(ImageTooLargeError);
  });

  it("compresses an oversized PNG via the JPEG ladder, keeping dimensions", async () => {
    const result = await maybeResizeAndDownsampleImage(
      oversizedPng,
      "image/png",
    );
    expect(result.mediaType).toBe("image/jpeg");
    expect(result.byteLength).toBeLessThanOrEqual(MAX_IMAGE_BYTES_PASSTHROUGH);
    // Noise cannot be compressed as PNG, so the ladder falls through to JPEG.
    // 1600px is already under the cap and must not be rescaled.
    const image = await Jimp.read(Buffer.from(result.data, "base64"));
    expect(image.mime).toBe("image/jpeg");
    expect(image.width).toBe(1600);
    expect(image.height).toBe(1600);
  }, 50_000);

  it("compresses an oversized JPEG via the quality ladder and caps dimensions at 2000px", async () => {
    const result = await maybeResizeAndDownsampleImage(
      oversizedJpeg,
      "image/jpeg",
    );
    expect(result.mediaType).toBe("image/jpeg");
    expect(result.byteLength).toBeLessThanOrEqual(MAX_IMAGE_BYTES_PASSTHROUGH);
    const image = await Jimp.read(Buffer.from(result.data, "base64"));
    expect(image.mime).toBe("image/jpeg");
    expect(image.width).toBe(MAX_DIMENSION_PX);
    expect(image.height).toBe(MAX_DIMENSION_PX);
  }, 50_000);

  it("round-trips the compressed payload as valid base64 binary", async () => {
    const result = await maybeResizeAndDownsampleImage(
      oversizedJpeg,
      "image/jpeg",
    );
    const decoded = Buffer.from(result.data, "base64");
    expect(decoded.length).toBe(result.byteLength);
    expect(sniffMediaType(decoded)).toBe("image/jpeg");
  }, 30_000);

  it("compresses an oversized WebP into a decodable image", async () => {
    const result = await maybeResizeAndDownsampleImage(
      oversizedWebp,
      "image/webp",
    );
    expect(result.byteLength).toBeLessThanOrEqual(MAX_IMAGE_BYTES_PASSTHROUGH);
    const image = await Jimp.read(Buffer.from(result.data, "base64"));
    expect(image.width).toBe(1600);
    expect(image.height).toBe(1600);
    expect(image.mime).toBe(result.mediaType);
  });

  it("compresses a 48MP JPEG beyond jpeg-js's default decode memory budget", async () => {
    const jpeg = readFileSync(new URL("./fixtures/48mp.jpg", import.meta.url));
    const input = Buffer.concat([
      jpeg,
      Buffer.alloc(MAX_IMAGE_BYTES_PASSTHROUGH),
    ]);
    const result = await maybeResizeAndDownsampleImage(input, "image/jpeg");
    expect(result.byteLength).toBeLessThanOrEqual(MAX_IMAGE_BYTES_PASSTHROUGH);
    const image = await Jimp.read(Buffer.from(result.data, "base64"));
    expect(image.width).toBe(2000);
    expect(image.height).toBe(1500);
  });

  it("keeps the event loop responsive during image processing", async () => {
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    try {
      await maybeResizeAndDownsampleImage(oversizedPng, "image/png");
      expect(ticks).toBeGreaterThan(2);
    } finally {
      clearInterval(timer);
    }
  });

  it("cancels a running worker and processes the next image", async () => {
    const controller = new AbortController();
    const reason = new Error("cancel image processing");
    const processing = maybeResizeAndDownsampleImage(
      oversizedPng,
      "image/png",
      controller.signal,
    );
    const assertion = expect(processing).rejects.toBe(reason);
    await delay(30);
    controller.abort(reason);
    await assertion;
    const result = await maybeResizeAndDownsampleImage(
      oversizedJpeg,
      "image/jpeg",
    );
    expect(result.byteLength).toBeLessThanOrEqual(MAX_IMAGE_BYTES_PASSTHROUGH);
  });

  it("cancels a queued image without waiting for the active image", async () => {
    let finished = false;
    const active = maybeResizeAndDownsampleImage(
      oversizedPng,
      "image/png",
    ).then(() => {
      finished = true;
    });
    const controller = new AbortController();
    const reason = new Error("cancel queued image");
    const queued = maybeResizeAndDownsampleImage(
      oversizedPng,
      "image/png",
      controller.signal,
    );
    controller.abort(reason);
    await expect(queued).rejects.toBe(reason);
    expect(finished).toBe(false);
    await active;
  });

  it("throws ImageTooLargeError when jimp fails on an oversized corrupt buffer", async () => {
    // PNG magic followed by garbage: sniffable as an image, but jimp cannot
    // decode it. Over the passthrough target there is no valid fallback —
    // passing it through would exceed the 5MB base64 API limit (regression
    // test for the raw-vs-base64 fallback bug).
    const corrupt = Buffer.concat([
      PNG_MAGIC,
      Buffer.alloc(Math.floor(MAX_IMAGE_BYTES_PASSTHROUGH) + 1024, 0xab),
    ]);
    await expect(
      maybeResizeAndDownsampleImage(corrupt, "image/png"),
    ).rejects.toThrow(ImageTooLargeError);
    await expect(
      maybeResizeAndDownsampleImage(corrupt, "image/png"),
    ).rejects.toThrow(/compression failed/);
  });

  it("still passes a small corrupt buffer through (jimp never consulted)", async () => {
    const corrupt = Buffer.concat([PNG_MAGIC, Buffer.alloc(1024, 0xab)]);
    const result = await maybeResizeAndDownsampleImage(corrupt, "image/png");
    expect(result.data).toBe(corrupt.toString("base64"));
  });
});

describe("screenshot processing", () => {
  it("normalizes Retina pixels and crops using the displayed coordinate space", async () => {
    const png = await new Jimp({
      width: 2000,
      height: 1000,
      color: 0x0a141eff,
    }).getBuffer("image/png");
    const options = {
      screenWidth: 1000,
      screenHeight: 500,
      maxWidth: 1366,
      maxHeight: 768,
      coordinateScaleX: 1,
      coordinateScaleY: 1,
    };
    const screenshot = await processScreenshot(png, options);
    expect(screenshot).toMatchObject({
      width: 1000,
      height: 500,
      screenWidth: 1000,
      screenHeight: 500,
    });
    const cropped = await processScreenshot(png, {
      ...options,
      region: [100, 50, 200, 100],
    });
    const image = await Jimp.read(Buffer.from(cropped.data, "base64"));
    expect(image.width).toBe(200);
    expect(image.height).toBe(100);
    expect(image.getPixelColor(0, 0)).toBe(0x0a141eff);
  });
});
