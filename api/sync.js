"use strict";

const { loadUsers, json } = require("../lib/store");

const STEAM_ID_BASE = BigInt("76561197960265728");

function validSteamId(value) {
  if (typeof value !== "string") return false;
  if (!/^\d{17}$/.test(value)) return false;
  return BigInt(value) >= STEAM_ID_BASE;
}

// Публичный список steamid активных подписчиков (только те, у кого жив
// лизинг присутствия - игра открыта). Читательский клиент (чит) опрашивает
// его фоново, чтобы показывать бейджи в скорборде. Отдаём чистый массив
// steamid без имён и uid: в релизе у всех один uid, а бейдж привязывается
// только к steamid. Крашнувшийся игрок пропадает из списка сам, когда его
// лизинг протухает.
module.exports = async function (req, res) {
  if (req.method !== "GET") {
    return json(res, 405, { ok: false, error: "method not allowed" });
  }

  const now = Date.now();
  const users = await loadUsers();

  const list = [];
  for (const [username, record] of Object.entries(users)) {
    if (!record.expiresAtMs || record.expiresAtMs <= now) continue;
    const sessions = record.sessions || {};
    for (const [steamid, lease] of Object.entries(sessions)) {
      if (!validSteamId(steamid)) continue;
      if (Number(lease || 0) <= now) continue;
      list.push(steamid);
    }
  }
  list.sort();

  return json(res, 200, list);
};