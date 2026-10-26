"use strict";

const { loadUsers, saveUsers, findUserByUid, json } = require("../lib/store");
const { verifyLicense } = require("../lib/blob");

const STEAM_ID_BASE = BigInt("76561197960265728");
const LEASE_MS = 90 * 1000;

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

// Скин-конфиг игрока. Храним в КАНОНИЧНОМ flat-формате:
//   {
//     "<def_index>": {"p","w","s","t","c"},   // guns + knives + gloves (ключи верхнего уровня)
//     "agents": { "ct": <def_index>, "t": <def_index> }
//   }
// Плоский вид красок обязателен: старый клиент парсит только числовые ключи
// верхнего уровня и не знает про "paints". Новый клиент читает те же ключи
// плюс "agents". Принимаем ОБА входных формата (плоский и {paints, agents}).
function normalizeSkins(skins) {
  if (!skins || typeof skins !== "object" || Array.isArray(skins)) return null;

  const paints = {};
  const src =
    skins.paints && typeof skins.paints === "object" && !Array.isArray(skins.paints)
      ? skins.paints
      : skins;

  for (const key of Object.keys(src)) {
    if (!/^-?\d{1,6}$/.test(key)) continue;
    const s = src[key];
    if (!s || typeof s !== "object") continue;

    const p = Number(s.p);
    const w = Number(s.w);
    const seed = Number(s.s);
    const t = !!s.t;
    const c = Number(s.c);

    if (!Number.isInteger(p) || p < 0) continue;
    if (!Number.isFinite(w) || w < 0 || w > 1) continue;

    paints[key] = {
      p,
      w: Number.isFinite(w) ? w : 0.01,
      s: Number.isInteger(seed) ? seed : 0,
      t,
      c: Number.isInteger(c) ? c : 0,
    };
  }

  // Перчатки хранятся ОТДЕЛЬНОЙ секцией (как agents) и НИКОГДА не несут
  // статтрека - только паттерн и износ. Формат: gloves = { def: { p, w } }.
  // Если перчатка пришла внутри paints (старые клиенты/леги), сервер НЕ
  // добавляет ей статтрек: на сервере для перчаток поле t/c просто не
  // существует, и при выдаче мы никого не заставляем «дорисовать» статтрек.
  const gloveRaw =
    skins.gloves && typeof skins.gloves === "object" && !Array.isArray(skins.gloves)
      ? skins.gloves
      : {};
  const gloves = {};

  for (const key of Object.keys(gloveRaw)) {
    if (!/^-?\d{1,6}$/.test(key)) continue;
    const g = gloveRaw[key];
    if (!g || typeof g !== "object") continue;

    const gp = Number(g.p);
    const gw = Number(g.w);

    if (!Number.isInteger(gp) || gp < 0) continue;
    if (!Number.isFinite(gw) || gw < 0 || gw > 1) {
      gloves[key] = { p: gp, w: 0.01 };
      continue;
    }

    gloves[key] = { p: gp, w: gw };
  }

  const agentsRaw =
    skins.agents && typeof skins.agents === "object" && !Array.isArray(skins.agents)
      ? skins.agents
      : {};
  const ct = Number(agentsRaw.ct);
  const tdef = Number(agentsRaw.t);

  // Нож — как перчатки: ОТДЕЛЬНАЯ секция и НИКОГДА не несёт статтрека,
  // только паттерн и износ (def -> {p, w}). Старые клиенты flat-формата его
  // просто не знают, новый клиент читает секцию "knife" отдельно.
  const knifeRaw =
    skins.knife && typeof skins.knife === "object" && !Array.isArray(skins.knife)
      ? skins.knife
      : {};
  const knife = {};

  for (const key of Object.keys(knifeRaw)) {
    if (!/^-?\d{1,6}$/.test(key)) continue;
    const k = knifeRaw[key];
    if (!k || typeof k !== "object") continue;

    const kp = Number(k.p);
    const kw = Number(k.w);

    if (!Number.isInteger(kp) || kp < 0) continue;
    if (!Number.isFinite(kw) || kw < 0 || kw > 1) {
      knife[key] = { p: kp, w: 0.01 };
      continue;
    }

    knife[key] = { p: kp, w: kw };
  }

  return {
    ...paints,
    agents: {
      ct: Number.isInteger(ct) ? ct : 0,
      t: Number.isInteger(tdef) ? tdef : 0,
    },
    gloves,
    knife,
  };
}

// Сохраняет скин-конфиг аккаунта для конкретного steamid. Аутентификация
// лицензионным тикетом {uid, expiresAtMs, hmac} - как в /api/bind. Конфиг
// живёт в record.skins[steamid] и НЕ протухает вместе с лизингом пребывания.
module.exports = async function (req, res) {
  if (req.method === "GET") {
    const now = Date.now();
    const users = await loadUsers();
    const requested = String(req.query.steamids || "")
      .split(",")
      .map((s) => s.trim())
      .filter(validSteamId);

    const result = {};

    for (const [username, record] of Object.entries(users)) {
      if (!record.expiresAtMs || record.expiresAtMs <= now) continue;
      const sessions = record.sessions || {};
      const skins = record.skins || {};

      for (const steamid of Object.keys(sessions)) {
        if (!validSteamId(steamid)) continue;
        if (Number(sessions[steamid] || 0) <= now) continue;
        if (requested.length && !requested.includes(steamid)) continue;

        const cfg = skins[steamid];
        if (cfg && typeof cfg === "object" && Object.keys(cfg).length) {
          result[steamid] = cfg;
        }
      }
    }

    return json(res, 200, result);
  }

  if (req.method === "POST") {
    const body = await parseBody(req);

    const uid = Number(body.uid);
    const expiresAtMs = Number(body.expiresAtMs || 0);
    const hmac = String(body.hmac || "");
    const steamid = String(body.steamid || "");
    const skins = normalizeSkins(body.skins);

    if (!Number.isInteger(uid) || uid <= 0) {
      return json(res, 400, { ok: false, error: "invalid uid" });
    }
    if (!validSteamId(steamid)) {
      return json(res, 400, { ok: false, error: "invalid steamid" });
    }
    if (!verifyLicense({ uid, expiresAtMs, hmac })) {
      return json(res, 401, { ok: false, error: "bad license blob" });
    }
    if (!skins) {
      return json(res, 400, { ok: false, error: "invalid skins payload" });
    }

    const users = await loadUsers();
    const account = findUserByUid(users, String(uid));
    if (!account) {
      return json(res, 404, { ok: false, error: "user not found" });
    }

    const owner = (account.record.skins = account.record.skins || {});
    owner[steamid] = skins;
    users[account.username] = account.record;
    await saveUsers(users);

    return json(res, 200, { ok: true, steamid });
  }

  return json(res, 405, { ok: false, error: "method not allowed" });
};