"use strict";

const { loadUsers, saveUsers, findUserByUid, json } = require("../lib/store");
const { verifyLicense } = require("../lib/blob");

const STEAM_ID_BASE = BigInt("76561197960265728");

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

function validSteamId(value) {
  if (typeof value !== "string") return false;
  if (!/^\d{17}$/.test(value)) return false;
  return BigInt(value) >= STEAM_ID_BASE;
}

// Снятие лизинга присутствия при чистом выходе из игры. Клиент шлёт тот же
// билет {uid, expiresAtMs, hmac}, что и в /api/bind, поэтому подписать
// чужой unbind нельзя. После краша игра не успевает вызвать этот эндпоинт -
// лизинг сам протухает на сервере за LEASE_MS из bind.js.
module.exports = async function (req, res) {
  if (req.method !== "POST") {
    return json(res, 405, { ok: false, error: "method not allowed" });
  }

  const body = await parseBody(req);

  const uid = Number(body.uid);
  const expiresAtMs = Number(body.expiresAtMs || 0);
  const hmac = String(body.hmac || "");
  const steamid = String(body.steamid || "");

  if (!Number.isInteger(uid) || uid <= 0) {
    return json(res, 400, { ok: false, error: "invalid uid" });
  }
  if (!validSteamId(steamid)) {
    return json(res, 400, { ok: false, error: "invalid steamid" });
  }
  if (!verifyLicense({ uid, expiresAtMs, hmac })) {
    return json(res, 401, { ok: false, error: "bad license blob" });
  }

  const users = await loadUsers();
  const account = findUserByUid(users, String(uid));
  if (!account) {
    return json(res, 404, { ok: false, error: "user not found" });
  }

  const sessions = account.record.sessions || {};
  if (!sessions[steamid]) {
    return json(res, 200, { ok: true, removed: false });
  }

  delete sessions[steamid];
  users[account.username] = account.record;
  await saveUsers(users);

  return json(res, 200, { ok: true, removed: true });
};