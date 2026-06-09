import fs from "node:fs/promises";

export type Mp4ValidationFailureCode =
  | "unsupported_container"
  | "missing_moov"
  | "missing_mdat"
  | "moov_after_mdat"
  | "missing_video_track"
  | "unreadable_duration"
  | "truncated";

export type Mp4ValidationResult =
  | { ok: true }
  | { ok: false; code: Mp4ValidationFailureCode };

type Atom = {
  type: string;
  start: number;
  headerSize: number;
  size: number;
  end: number;
};

const FTYP_NEAR_START_MAX_OFFSET = 4096;

async function hasFtypNearStart(fd: fs.FileHandle, fileSize: number): Promise<boolean> {
  const sampleSize = Math.min(fileSize, FTYP_NEAR_START_MAX_OFFSET + 16);
  if (sampleSize < 8) return false;
  const sample = await readExact(fd, 0, sampleSize);
  if (!sample) return false;
  const lastOffset = Math.max(4, sample.length - 4);
  for (let i = 4; i <= lastOffset; i++) {
    if (
      sample[i] === 0x66 &&
      sample[i + 1] === 0x74 &&
      sample[i + 2] === 0x79 &&
      sample[i + 3] === 0x70
    ) {
      return i - 4 <= FTYP_NEAR_START_MAX_OFFSET;
    }
  }
  return false;
}

async function readExact(
  fd: fs.FileHandle,
  position: number,
  length: number,
): Promise<Buffer | null> {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fd.read(buf, 0, length, position);
  if (bytesRead !== length) return null;
  return buf;
}

async function readAtomAt(
  fd: fs.FileHandle,
  fileSize: number,
  start: number,
  endLimit: number,
): Promise<Atom | null> {
  if (start + 8 > endLimit || start + 8 > fileSize) return null;

  const base = await readExact(fd, start, 8);
  if (!base) return null;

  const size32 = base.readUInt32BE(0);
  const type = base.subarray(4, 8).toString("ascii");

  let headerSize = 8;
  let size = size32;

  if (size32 === 1) {
    if (start + 16 > endLimit || start + 16 > fileSize) return null;
    const ext = await readExact(fd, start + 8, 8);
    if (!ext) return null;
    const big = ext.readBigUInt64BE(0);
    if (big < 16n || big > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    size = Number(big);
    headerSize = 16;
  } else if (size32 === 0) {
    size = endLimit - start;
  }

  if (size < headerSize) return null;

  const end = start + size;
  if (end > endLimit || end > fileSize) return null;

  return { type, start, headerSize, size, end };
}

async function readChildAtoms(
  fd: fs.FileHandle,
  fileSize: number,
  parent: Atom,
): Promise<Atom[] | null> {
  const children: Atom[] = [];
  let cursor = parent.start + parent.headerSize;
  while (cursor < parent.end) {
    const atom = await readAtomAt(fd, fileSize, cursor, parent.end);
    if (!atom) return null;
    children.push(atom);
    if (atom.end <= cursor) return null;
    cursor = atom.end;
  }
  return cursor === parent.end ? children : null;
}

function hasReadableDuration(version: number, timescale: number, duration: bigint): boolean {
  return (version === 0 || version === 1) && timescale > 0 && duration > 0n;
}

async function parseMvhdDuration(
  fd: fs.FileHandle,
  atom: Atom,
): Promise<boolean | null> {
  const payloadSize = atom.size - atom.headerSize;
  const minV0 = 20;
  const minV1 = 32;
  if (payloadSize < minV0) return null;

  const needed = payloadSize >= minV1 ? minV1 : minV0;
  const payload = await readExact(fd, atom.start + atom.headerSize, needed);
  if (!payload) return null;

  const version = payload[0];
  if (version === 0) {
    const timescale = payload.readUInt32BE(12);
    const duration = BigInt(payload.readUInt32BE(16));
    return hasReadableDuration(version, timescale, duration);
  }
  if (version === 1) {
    if (payload.length < minV1) return null;
    const timescale = payload.readUInt32BE(20);
    const duration = payload.readBigUInt64BE(24);
    return hasReadableDuration(version, timescale, duration);
  }
  return false;
}

async function parseMdhdDuration(
  fd: fs.FileHandle,
  atom: Atom,
): Promise<boolean | null> {
  const payloadSize = atom.size - atom.headerSize;
  const minV0 = 20;
  const minV1 = 32;
  if (payloadSize < minV0) return null;

  const needed = payloadSize >= minV1 ? minV1 : minV0;
  const payload = await readExact(fd, atom.start + atom.headerSize, needed);
  if (!payload) return null;

  const version = payload[0];
  if (version === 0) {
    const timescale = payload.readUInt32BE(12);
    const duration = BigInt(payload.readUInt32BE(16));
    return hasReadableDuration(version, timescale, duration);
  }
  if (version === 1) {
    if (payload.length < minV1) return null;
    const timescale = payload.readUInt32BE(20);
    const duration = payload.readBigUInt64BE(24);
    return hasReadableDuration(version, timescale, duration);
  }
  return false;
}

async function parseHdlrIsVideo(
  fd: fs.FileHandle,
  atom: Atom,
): Promise<boolean | null> {
  const payloadSize = atom.size - atom.headerSize;
  if (payloadSize < 12) return null;
  const payload = await readExact(fd, atom.start + atom.headerSize, 12);
  if (!payload) return null;
  const handler = payload.subarray(8, 12).toString("ascii");
  return handler === "vide";
}

async function inspectMoov(
  fd: fs.FileHandle,
  fileSize: number,
  moov: Atom,
): Promise<{ truncated: boolean; hasVideoTrack: boolean; hasDuration: boolean }> {
  const moovChildren = await readChildAtoms(fd, fileSize, moov);
  if (!moovChildren) {
    return { truncated: true, hasVideoTrack: false, hasDuration: false };
  }

  let hasDuration = false;
  let hasVideoTrack = false;

  for (const child of moovChildren) {
    if (child.type === "mvhd") {
      const readable = await parseMvhdDuration(fd, child);
      if (readable === null) {
        return { truncated: true, hasVideoTrack: false, hasDuration: false };
      }
      if (readable) hasDuration = true;
      continue;
    }

    if (child.type !== "trak") continue;

    const trakChildren = await readChildAtoms(fd, fileSize, child);
    if (!trakChildren) {
      return { truncated: true, hasVideoTrack: false, hasDuration: false };
    }

    const mdia = trakChildren.find((entry) => entry.type === "mdia");
    if (!mdia) continue;

    const mdiaChildren = await readChildAtoms(fd, fileSize, mdia);
    if (!mdiaChildren) {
      return { truncated: true, hasVideoTrack: false, hasDuration: false };
    }

    const hdlr = mdiaChildren.find((entry) => entry.type === "hdlr");
    if (hdlr) {
      const isVideo = await parseHdlrIsVideo(fd, hdlr);
      if (isVideo === null) {
        return { truncated: true, hasVideoTrack: false, hasDuration: false };
      }
      if (isVideo) hasVideoTrack = true;
    }

    const mdhd = mdiaChildren.find((entry) => entry.type === "mdhd");
    if (mdhd) {
      const readable = await parseMdhdDuration(fd, mdhd);
      if (readable === null) {
        return { truncated: true, hasVideoTrack: false, hasDuration: false };
      }
      if (readable) hasDuration = true;
    }
  }

  return { truncated: false, hasVideoTrack, hasDuration };
}

export async function validateFastStartMp4(
  filePath: string,
): Promise<Mp4ValidationResult> {
  let fd: fs.FileHandle;
  try {
    fd = await fs.open(filePath, "r");
  } catch {
    return { ok: false, code: "truncated" };
  }

  try {
    const stat = await fd.stat();
    const fileSize = stat.size;
    if (fileSize < 8) {
      return { ok: false, code: "truncated" };
    }

    const atoms: Atom[] = [];
    let cursor = 0;
    while (cursor < fileSize) {
      const atom = await readAtomAt(fd, fileSize, cursor, fileSize);
      if (!atom) {
        if (atoms.length === 0) {
          const hasFtyp = await hasFtypNearStart(fd, fileSize);
          return { ok: false, code: hasFtyp ? "truncated" : "unsupported_container" };
        }
        return { ok: false, code: "truncated" };
      }
      atoms.push(atom);
      if (atom.end <= cursor) {
        return { ok: false, code: "truncated" };
      }
      cursor = atom.end;
    }

    const ftyp = atoms.find((atom) => atom.type === "ftyp");
    if (!ftyp || ftyp.start > FTYP_NEAR_START_MAX_OFFSET) {
      return { ok: false, code: "unsupported_container" };
    }

    const moov = atoms.find((atom) => atom.type === "moov");
    if (!moov) return { ok: false, code: "missing_moov" };

    const mdat = atoms.find((atom) => atom.type === "mdat");
    if (!mdat) return { ok: false, code: "missing_mdat" };

    if (moov.start > mdat.start) {
      return { ok: false, code: "moov_after_mdat" };
    }

    const details = await inspectMoov(fd, fileSize, moov);
    if (details.truncated) return { ok: false, code: "truncated" };
    if (!details.hasVideoTrack) return { ok: false, code: "missing_video_track" };
    if (!details.hasDuration) return { ok: false, code: "unreadable_duration" };

    return { ok: true };
  } finally {
    await fd.close();
  }
}
