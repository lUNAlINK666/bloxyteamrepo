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

// Привязка steamid текущего игрока к аккаунту подписки.
//
// Клиент присылает поля из своего стitched блоба {uid, expiresAtMs, hmac}.
// Сервер пересчитывает HMAC ключом LICENSE_KEY (см. verifyLicense в lib/blob.js):
// это доказывает, что DLL подписана для данного аккаунта, без раскрытия ключа.
//
// Привязка НЕ постоянная: это короткий «лизинг присутствия». Игрок в списке
// /api/sync, пока его лизинг жив; клиент продлевает его ребандом каждые 30с,
// а при чистом выходе из игры снимает unbind-ом. Краш не успевает отправить
// unbind — тогда лизинг просто протухает на сервере за LEASE_MS.
//
// Стем айди хранятся множеством на аккаунт, потому что у релиза все клиенты
// могут иметь один и тот же uid.
const LEASE_MS = 90 * 1000;

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

  const sessions = (account.record.sessions = account.record.sessions || {});
  sessions[steamid] = Date.now() + LEASE_MS;
  users[account.username] = account.record;
  await saveUsers(users);

  return json(res, 200, {
    ok: true,
    username: account.username,
    uid: account.record.uid,
    steamid,
  });
};