import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import os from "node:os";
import path from "node:path";
import type { MaterializedProviderImage } from "./provider-image-output.js";

const PROVIDER_IMAGE_ATTACHMENT_DIR = "paseo-attachments";
const PROVIDER_IMAGE_ATTACHMENT_DIR_PREFIX = `${PROVIDER_IMAGE_ATTACHMENT_DIR}-`;
const PRIVATE_ATTACHMENT_DIR_MODE = 0o700;
const MATERIALIZED_IMAGE_FILE_MODE = 0o600;

let materializedImageAttachmentDir: string | null = null;
// Serialize materializations: one decoder and one file operation at a time, including
// concurrent history replay and live turns. A rejected operation must not poison the queue.
let pendingMaterialization: Promise<unknown> = Promise.resolve();

async function getMaterializedImageAttachmentDir(): Promise<string> {
  if (materializedImageAttachmentDir) {
    try {
      const stats = await fs.lstat(materializedImageAttachmentDir);
      if (stats.isDirectory()) {
        await fs.chmod(materializedImageAttachmentDir, PRIVATE_ATTACHMENT_DIR_MODE);
        return materializedImageAttachmentDir;
      }
    } catch {
      /* Temp storage may have been removed between turns. */
    }
  }
  materializedImageAttachmentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), PROVIDER_IMAGE_ATTACHMENT_DIR_PREFIX),
  );
  await fs.chmod(materializedImageAttachmentDir, PRIVATE_ATTACHMENT_DIR_MODE);
  return materializedImageAttachmentDir;
}

function getImageExtension(mimeType: string): string {
  switch (mimeType) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "image/bmp":
      return "bmp";
    case "image/tiff":
      return "tiff";
    default:
      return "bin";
  }
}

// 128 MiB admits the measured 64 MiB fixture with headroom while bounding disk
// and decoding per image. This is materialization admission, not a wire schema limit.
export const MAX_PROVIDER_IMAGE_BYTES = 128 * 1024 * 1024;
const BASE64_CHUNK_CHARACTERS = 256 * 1024; // Multiple of four; decode units stay aligned.

export function materializeProviderImage(image: {
  data: string;
  mimeType: string | null;
}): Promise<MaterializedProviderImage> {
  const result = pendingMaterialization.then(() => materializeImage(image));
  pendingMaterialization = result.catch(() => {});
  return result;
}

async function materializeImage(image: {
  data: string;
  mimeType: string | null;
}): Promise<MaterializedProviderImage> {
  const maxEncodedCharacters = Math.ceil(MAX_PROVIDER_IMAGE_BYTES / 3) * 4;
  // Check length before inspecting/copying the payload, including a bounded data URI header.
  if (image.data.length > maxEncodedCharacters + 256) {
    throw new Error(`Image attachment exceeds ${MAX_PROVIDER_IMAGE_BYTES} bytes`);
  }
  let data = image.data;
  let mimeType = image.mimeType ?? "image/png";
  if (data.startsWith("data:")) {
    const separator = data.indexOf(";base64,");
    if (separator >= 0 && separator < 256) {
      mimeType = data.slice(5, separator);
      data = data.slice(separator + 8);
    }
  }
  if (data.length > maxEncodedCharacters) {
    throw new Error(`Image attachment exceeds ${MAX_PROVIDER_IMAGE_BYTES} bytes`);
  }
  const hash = createHash("sha256");
  for await (const bytes of decodeImage(data)) hash.update(bytes);
  const dir = await getMaterializedImageAttachmentDir();
  const filePath = path.join(dir, `${hash.digest("hex")}.${getImageExtension(mimeType)}`);
  try {
    await fs.stat(filePath);
    return { path: filePath };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const staging = await fs.mkdtemp(path.join(dir, ".pending-"));
  const stagingPath = path.join(staging, "image");
  try {
    await fs.chmod(staging, PRIVATE_ATTACHMENT_DIR_MODE);
    const file = await fs.open(stagingPath, "wx", MATERIALIZED_IMAGE_FILE_MODE);
    try {
      await file.chmod(MATERIALIZED_IMAGE_FILE_MODE);
      // Decode again only for a new hash. This bounds retained memory to one chunk
      // and performs no writes at all for repeated content, including history replay.
      for await (const bytes of decodeImage(data)) await file.writeFile(bytes);
    } finally {
      await file.close();
    }
    await fs.rename(stagingPath, filePath);
    return { path: filePath };
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

async function* decodeImage(data: string): AsyncGenerator<Buffer> {
  let carry = "";
  let decodedBytes = 0;
  for (let offset = 0; offset < data.length; offset += BASE64_CHUNK_CHARACTERS) {
    // Buffer.from ignores non-base64 characters. Carry incomplete quartets so
    // line-wrapped payloads decode identically across chunk boundaries.
    const chunk =
      carry +
      data.slice(offset, offset + BASE64_CHUNK_CHARACTERS).replace(/[^A-Za-z0-9+/_=-]/g, "");
    const finalChunk = offset + BASE64_CHUNK_CHARACTERS >= data.length || chunk.includes("=");
    const end = finalChunk ? chunk.length : chunk.length - (chunk.length % 4);
    const bytes = Buffer.from(chunk.slice(0, end), "base64");
    carry = chunk.slice(end);
    decodedBytes += bytes.length;
    if (decodedBytes > MAX_PROVIDER_IMAGE_BYTES)
      throw new Error("Image attachment exceeds size limit");
    yield bytes;
    await setImmediate();
    if (finalChunk) break;
  }
}
