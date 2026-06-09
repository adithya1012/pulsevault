import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import pulseVault, {
  createLocalStorage,
  createMp4Sniffer,
} from "../dist/app.js";

const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PREFIX = "/pulsevault";

function b64(str) {
  return Buffer.from(str, "utf8").toString("base64");
}

function atom(type, payload = Buffer.alloc(0)) {
  const size = 8 + payload.length;
  const header = Buffer.alloc(8);
  header.writeUInt32BE(size, 0);
  header.write(type, 4, 4, "ascii");
  return Buffer.concat([header, payload]);
}

function fullBox(type, version, flags, payload = Buffer.alloc(0)) {
  const prefix = Buffer.alloc(4);
  prefix[0] = version;
  prefix[1] = (flags >> 16) & 0xff;
  prefix[2] = (flags >> 8) & 0xff;
  prefix[3] = flags & 0xff;
  return atom(type, Buffer.concat([prefix, payload]));
}

function ftyp() {
  const payload = Buffer.alloc(16);
  payload.write("isom", 0, 4, "ascii");
  payload.writeUInt32BE(0x00000200, 4);
  payload.write("isom", 8, 4, "ascii");
  payload.write("mp42", 12, 4, "ascii");
  return atom("ftyp", payload);
}

function mvhd({ timescale = 1000, duration = 1000 } = {}) {
  const payload = Buffer.alloc(20);
  payload.writeUInt32BE(0, 0);
  payload.writeUInt32BE(0, 4);
  payload.writeUInt32BE(timescale, 8);
  payload.writeUInt32BE(duration, 12);
  return fullBox("mvhd", 0, 0, payload);
}

function mdhd({ timescale = 1000, duration = 1000 } = {}) {
  const payload = Buffer.alloc(20);
  payload.writeUInt32BE(0, 0);
  payload.writeUInt32BE(0, 4);
  payload.writeUInt32BE(timescale, 8);
  payload.writeUInt32BE(duration, 12);
  return fullBox("mdhd", 0, 0, payload);
}

function hdlr(handlerType = "vide") {
  const payload = Buffer.alloc(24);
  payload.writeUInt32BE(0, 0);
  payload.write(handlerType, 4, 4, "ascii");
  return fullBox("hdlr", 0, 0, payload);
}

function mdia({ handlerType = "vide", timescale = 1000, duration = 1000 } = {}) {
  return atom("mdia", Buffer.concat([
    mdhd({ timescale, duration }),
    hdlr(handlerType),
  ]));
}

function trak(opts = {}) {
  return atom("trak", Buffer.concat([mdia(opts)]));
}

function moov(opts = {}) {
  return atom("moov", Buffer.concat([
    mvhd({ timescale: opts.mvhdTimescale ?? 1000, duration: opts.mvhdDuration ?? 1000 }),
    trak({
      handlerType: opts.handlerType ?? "vide",
      timescale: opts.mdhdTimescale ?? 1000,
      duration: opts.mdhdDuration ?? 1000,
    }),
  ]));
}

function mdat(size = 64) {
  return atom("mdat", Buffer.alloc(size));
}

function validFastStartMp4() {
  return Buffer.concat([ftyp(), moov(), mdat(128)]);
}

function unsupportedContainerBytes() {
  return Buffer.concat([Buffer.from("GIF89a", "ascii"), Buffer.alloc(128, 0xff)]);
}

async function startApp() {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "pv-mp4-val-"));
  const storage = createLocalStorage({ workspaceDir });
  const app = Fastify({ logger: false });
  await app.register(pulseVault, {
    prefix: PREFIX,
    storage,
    maxUploadSize: 10 * 1024 * 1024,
    validatePayload: createMp4Sniffer(storage),
  });
  const baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });
  return {
    app,
    baseUrl,
    workspaceDir,
    teardown: async () => {
      await app.close();
      await fs.rm(workspaceDir, { recursive: true, force: true });
    },
  };
}

async function tusCreate(baseUrl, { videoid, filename, size }) {
  const metadata = [
    `videoid ${b64(videoid)}`,
    `filename ${b64(filename)}`,
  ].join(",");
  return fetch(`${baseUrl}${PREFIX}/upload`, {
    method: "POST",
    headers: {
      "Tus-Resumable": "1.0.0",
      "Upload-Length": String(size),
      "Upload-Metadata": metadata,
    },
  });
}

async function tusPatch(url, offset, body) {
  return fetch(url, {
    method: "PATCH",
    headers: {
      "Tus-Resumable": "1.0.0",
      "Upload-Offset": String(offset),
      "Content-Type": "application/offset+octet-stream",
    },
    body,
  });
}

async function parseErrorBody(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    assert.fail(`expected JSON error body, got: ${text}`);
  }
}

async function assertRejectedUpload(bytes, expectedReasonSubstring) {
  const ctx = await startApp();
  try {
    const create = await tusCreate(ctx.baseUrl, {
      videoid: ID,
      filename: "clip.mp4",
      size: bytes.length,
    });
    assert.equal(create.status, 201);
    const location = create.headers.get("location");
    assert.ok(location);

    const patch = await tusPatch(location, 0, bytes);
    assert.equal(patch.status, 422);

    const payload = await parseErrorBody(patch);
    assert.equal(payload.error, "invalid_video_upload");
    assert.match(payload.reason, new RegExp(expectedReasonSubstring));

    const sidecarPath = path.join(ctx.workspaceDir, ".pulsevault", `${ID}.json`);
    const sidecar = await fs.stat(sidecarPath).catch(() => null);
    assert.equal(sidecar, null);

    const filePath = path.join(ctx.workspaceDir, "video", `${ID}.mp4`);
    const file = await fs.stat(filePath).catch(() => null);
    assert.equal(file, null);

    const get = await fetch(`${ctx.baseUrl}${PREFIX}/${ID}`);
    assert.equal(get.status, 404);
  } finally {
    await ctx.teardown();
  }
}

test("accepts valid fast-start MP4 and stores bytes as-is", async () => {
  const ctx = await startApp();
  try {
    const body = validFastStartMp4();
    const create = await tusCreate(ctx.baseUrl, {
      videoid: ID,
      filename: "clip.mp4",
      size: body.length,
    });
    assert.equal(create.status, 201);
    const location = create.headers.get("location");
    assert.ok(location);

    const patch = await tusPatch(location, 0, body);
    assert.equal(patch.status, 204);

    const get = await fetch(`${ctx.baseUrl}${PREFIX}/${ID}`);
    assert.equal(get.status, 200);
    const served = Buffer.from(await get.arrayBuffer());
    assert.equal(Buffer.compare(served, body), 0);
  } finally {
    await ctx.teardown();
  }
});

test("rejects MP4 with moov after mdat", async () => {
  await assertRejectedUpload(
    Buffer.concat([ftyp(), mdat(64), moov()]),
    "moov atom must appear before mdat",
  );
});

test("rejects MP4 missing moov", async () => {
  await assertRejectedUpload(Buffer.concat([ftyp(), mdat(64)]), "Missing moov atom");
});

test("rejects MP4 missing mdat", async () => {
  await assertRejectedUpload(Buffer.concat([ftyp(), moov()]), "Missing mdat atom");
});

test("rejects MP4 with no video track", async () => {
  await assertRejectedUpload(
    Buffer.concat([ftyp(), moov({ handlerType: "soun" }), mdat(64)]),
    "No video track metadata",
  );
});

test("rejects MP4 with unreadable duration metadata", async () => {
  await assertRejectedUpload(
    Buffer.concat([
      ftyp(),
      moov({ mvhdTimescale: 0, mvhdDuration: 0, mdhdTimescale: 0, mdhdDuration: 0 }),
      mdat(64),
    ]),
    "Duration metadata",
  );
});

test("rejects truncated MP4", async () => {
  const bytes = validFastStartMp4();
  await assertRejectedUpload(bytes.subarray(0, bytes.length - 5), "truncated");
});

test("rejects unsupported container", async () => {
  await assertRejectedUpload(unsupportedContainerBytes(), "Unsupported container");
});
