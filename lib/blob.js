"use strict";

const crypto = require("crypto");

// 64-byte license blob stitched into the DLL by the loader.
//
//   offset  size  field
//   0       8     magic "VLT_BLOB" (ASCII)
//   8       4     version (u32 LE, must be 1)
//   12      4     uid (u32 LE)
//   16      8     expiresAtMs (i64 LE, ms since epoch)
//   24      32    hmac-sha256(uid_le(4) || expires_le(8), LICENSE_KEY)
//   56      8     reserved (zeroes)
//
// The loader never sees LICENSE_KEY: it only copies the blob the server
// returns. The cheat re-derives the HMAC in memory to prove the DLL was
// stitched for a real account.

const BLOB_MAGIC = "VLT_BLOB";
const BLOB_SIZE = 64;

function licenseSecret() {
  return process.env.LICENSE_KEY || "dev-velocity-license-key";
}

// uid_le(4) || expires_le(8) - ровно те байты, что подписываются в блобе.
function licenseData(uid, expiresAtMs) {
  const data = Buffer.alloc(12);
  data.writeUInt32LE(Number(uid) >>> 0, 0);
  data.writeBigInt64LE(BigInt(expiresAtMs || 0), 4);
  return data;
}

function signLicense({ uid, expiresAtMs, secret }) {
  return crypto
    .createHmac("sha256", secret || licenseSecret())
    .update(licenseData(uid, expiresAtMs))
    .digest();
}

// Проверка "билета" {uid, expiresAtMs, hmac}: сервер пересчитывает HMAC тем же
// ключом, которым подписаны блобы. Клиент присылает эти поля из своего блоба,
// чтобы доказать владение аккаунтом, не имея LICENSE_KEY.
function verifyLicense({ uid, expiresAtMs, hmac, secret }) {
  if (!hmac || typeof hmac !== "string") return false;
  if (!Number.isInteger(Number(uid)) || Number(uid) <= 0) return false;
  const provided = Buffer.from(String(hmac).toLowerCase(), "hex");
  const expected = signLicense({ uid, expiresAtMs, secret: secret || licenseSecret() });
  return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
}

function buildBlob({ uid, expiresAtMs, secret }) {
  const buf = Buffer.alloc(BLOB_SIZE, 0);
  buf.write(BLOB_MAGIC, 0, "ascii");
  buf.writeUInt32LE(1, 8);
  buf.writeUInt32LE(Number(uid) >>> 0, 12);
  buf.writeBigInt64LE(BigInt(expiresAtMs || 0), 16);

  const hmac = signLicense({ uid, expiresAtMs, secret: secret || licenseSecret() });
  hmac.copy(buf, 24);

  return buf;
}

function parseBlob(buf) {
  if (!buf || buf.length !== BLOB_SIZE) return null;
  if (buf.subarray(0, 8).toString("ascii") !== BLOB_MAGIC) return null;
  const version = buf.readUInt32LE(8);
  const uid = buf.readUInt32LE(12);
  const expiresAtMs = Number(buf.readBigInt64LE(16));
  return { version, uid, expiresAtMs, hmac: buf.subarray(24, 56).toString("hex") };
}

module.exports = { BLOB_MAGIC, BLOB_SIZE, buildBlob, parseBlob, signLicense, verifyLicense };