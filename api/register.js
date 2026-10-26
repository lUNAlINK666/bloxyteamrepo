"use strict";

const { loadUsers, saveUsers, normalizeUsername, nextUid, hashPassword, verifyPassword, json } = require("../lib/store");

function parseBody(req) {
  return new Promise((resolve) => {
    if (req.body && typeof req.body === "object") {
      return resolve(req.body);
    }
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch (e) {
        resolve({});
      }
    });
  });
}

module.exports = async function (req, res) {
  if (req.method !== "POST") {
    return json(res, 405, { ok: false, error: "method not allowed" });
  }

  const body = await parseBody(req);
  const username = normalizeUsername(body.username);
  const password = String(body.password || "");
  const action = body.action === "login" ? "login" : "register";

  if (!username) {
    return json(res, 400, { ok: false, error: "invalid username" });
  }
  if (password.length < 4 || password.length > 64) {
    return json(res, 400, { ok: false, error: "invalid password" });
  }

  const users = await loadUsers();
  const existing = users[username];

  if (action === "login") {
    if (!existing || !verifyPassword(password, existing.passwordHash)) {
      return json(res, 401, { ok: false, error: "bad credentials" });
    }
    return json(res, 200, {
      ok: true,
      action,
      username,
      uid: existing.uid,
      expiresAtMs: existing.expiresAtMs || null,
      expiresAtIso: existing.expiresAtMs ? new Date(existing.expiresAtMs).toISOString() : null,
      active: !!existing.expiresAtMs && existing.expiresAtMs > Date.now(),
    });
  }

  if (existing) {
    return json(res, 409, { ok: false, error: "username taken" });
  }

  const uid = await nextUid(users);
  const record = {
    uid,
    username: body.username,
    passwordHash: hashPassword(password),
    expiresAtMs: 0,
  };
  users[username] = record;
  await saveUsers(users);

  return json(res, 200, {
    ok: true,
    action,
    username,
    uid,
    expiresAtMs: null,
    expiresAtIso: null,
    active: false,
  });
};