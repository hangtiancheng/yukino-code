import { z } from "zod";

export type ImageMediaType =
  "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export interface ScreenshotOptions {
  screenWidth: number;
  screenHeight: number;
  maxWidth: number;
  maxHeight: number;
  region?: number[];
  coordinateScaleX: number;
  coordinateScaleY: number;
}

export interface ImageProcessingRequest {
  bytes: Uint8Array;
  screenshot?: ScreenshotOptions;
}

export interface ImageWorkerData {
  request: ImageProcessingRequest;
  maxDimension: number;
  maxBytes: number;
}

export const ProcessedImageSchema = z.object({
  data: z.string(),
  mediaType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
  byteLength: z.number().int().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  screenWidth: z.number().positive(),
  screenHeight: z.number().positive(),
});

export type ProcessedImage = z.infer<typeof ProcessedImageSchema>;

export const ImageWorkerResponseSchema = z.union([
  z.object({ image: ProcessedImageSchema }),
  z.object({ error: z.string() }),
]);
