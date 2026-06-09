import fs from "node:fs/promises";
import type { FastifyRequest } from "fastify";
import type { LocalStorage } from "../storage/local.js";
import {
  validateFastStartMp4,
  type Mp4ValidationFailureCode,
} from "./mp4Validate.js";

/**
 * Optional plugin-level hook: after TUS writes the final byte but before the
 * upload is marked ready (or the consumer's `onUploadComplete` runs),
 * validate the payload bytes. Throw to reject — the plugin translates the
 * throw into a 422 response, calls `storage.remove?.(videoid)` to free the
 * disk, and never flips the sidecar to `"ready"`.
 *
 * The `localPath` field is populated for adapters that expose
 * `getLocalPath` (the built-in local adapter does). For adapters whose
 * bytes don't live on local disk (S3, etc.), `localPath` is `null` and the
 * validator has to fetch bytes through whatever API the adapter provides.
 */
export type PulseVaultValidatePayload = (
  request: FastifyRequest,
  ctx: {
    videoid: string;
    size: number;
    uploadId: string;
    /** Absolute local path to the finalized bytes, or `null` if unavailable. */
    localPath: string | null;
  },
) => void | Promise<void>;

export type InvalidVideoUploadBody = {
  error: "invalid_video_upload";
  reason: string;
};

function invalidVideoUploadReason(code: Mp4ValidationFailureCode): string {
  switch (code) {
    case "unsupported_container":
      return "Unsupported container. Upload must be a valid MP4/ISO-BMFF file with an ftyp atom near the beginning.";
    case "missing_moov":
      return "MP4 is invalid. Missing moov atom.";
    case "missing_mdat":
      return "MP4 is invalid. Missing mdat atom.";
    case "moov_after_mdat":
      return "MP4 is not fast-start optimized. The moov atom must appear before mdat.";
    case "missing_video_track":
      return "MP4 is invalid. No video track metadata was found.";
    case "unreadable_duration":
      return "MP4 is invalid. Duration metadata is missing or unreadable.";
    case "truncated":
      return "MP4 appears truncated or structurally incomplete.";
    default:
      return "Uploaded bytes are not a valid MP4.";
  }
}

function invalidVideoUploadBody(code: Mp4ValidationFailureCode): InvalidVideoUploadBody {
  return {
    error: "invalid_video_upload",
    reason: invalidVideoUploadReason(code),
  };
}

/**
 * Check whether a file's first bytes match the ISO base media file format
 * (`ftyp` box at offset 4), which covers MP4, MOV, M4V, 3GP, and related
 * containers. This is the same check tools like `file(1)` and ffprobe use
 * to identify MP4-family videos.
 *
 * Not a full MP4 parse — just a ~12-byte sniff. Enough to reject uploads
 * that are obviously not video (PDFs, HTML, random bytes) before the
 * server ever serves them back as `video/mp4`.
 */
export async function sniffMp4(filePath: string): Promise<boolean> {
  let fd: fs.FileHandle;
  try {
    fd = await fs.open(filePath, "r");
  } catch {
    return false;
  }
  try {
    const buf = Buffer.alloc(12);
    const { bytesRead } = await fd.read(buf, 0, 12, 0);
    if (bytesRead < 12) return false;
    // Bytes 4..7 must spell "ftyp" (ASCII 0x66 0x74 0x79 0x70). The first
    // four bytes are the box size and the remaining four after "ftyp" are
    // the brand (e.g. "isom", "mp42", "qt  ") — brand validation is left
    // to downstream tools.
    return (
      buf[4] === 0x66 &&
      buf[5] === 0x74 &&
      buf[6] === 0x79 &&
      buf[7] === 0x70
    );
  } finally {
    await fd.close();
  }
}

/**
 * Build a `validatePayload` hook that enforces every uploaded file is a
 * streamable fast-start MP4. Validation checks include top-level MP4 atom
 * structure (`ftyp`, `moov`, `mdat`), `moov` before `mdat`, at least one
 * video track, readable duration metadata, and truncation safeguards.
 *
 * Only works with `LocalStorage` (or any adapter that exposes `getLocalPath`).
 *
 * Usage:
 * ```ts
 * const storage = createLocalStorage({ workspaceDir: "./data" });
 * await app.register(pulseVault, {
 *   storage,
 *   validatePayload: createMp4Sniffer(storage),
 *   // ...
 * });
 * ```
 */
export function createMp4Sniffer(
  storage: LocalStorage,
): PulseVaultValidatePayload {
  return async (_request, { videoid }) => {
    const localPath = await storage.getLocalPath(videoid);
    if (!localPath) {
      throw Object.assign(
        new Error(
          `Cannot validate upload ${videoid}: no local path available`,
        ),
        { statusCode: 500 },
      );
    }
    const result = await validateFastStartMp4(localPath);
    if (!result.ok) {
      const body = invalidVideoUploadBody(result.code);
      throw Object.assign(
        new Error(body.reason),
        { statusCode: 422, pulseVaultError: body },
      );
    }
  };
}
