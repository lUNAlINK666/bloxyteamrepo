"use strict";

const { loadUsers, normalizeUsername, verifyPassword, json } = require("../lib/store");
const { buildBlob } = require("../lib/blob");

// Creates the license blob for the logged-in account so the loader can stitch
// it into the DLL. Requires valid credentials (same path as /api/register
// with action=login). The HMAC secret never leaves the server.
module.exports = async function (req, res) {
  if (req.method !== "POST") {
    return json(res, 405, { ok: false, error: "method not allowed" });
  }

  const body = req.body || {};
  const username = normalizeUsername(body.username);
  const password = String(body.password || "");

  if (!username || password.length < 4 || password.length > 64) {
    return json(res, 400, { ok: false, error: "invalid credentials" });
  }

  const users = await loadUsers();
  const existing = users[username];
  if (!existing || !verifyPassword(password, existing.passwordHash)) {
    return json(res, 401, { ok: false, error: "bad credentials" });
  }

  const uid = Number(existing.uid);
  const expiresAtMs = existing.expiresAtMs || 0;
  const active = !!expiresAtMs && expiresAtMs > Date.now();

  const secret = process.env.LICENSE_KEY || "dev-velocity-license-key";
  const blob = buildBlob({ uid, expiresAtMs, secret });

  return json(res, 200, {
    ok: true,
    username,
    uid: String(uid),
    expiresAtMs,
    expiresAtIso: expiresAtMs ? new Date(expiresAtMs).toISOString() : null,
    active,
    blobHex: blob.toString("hex"),
  });
};