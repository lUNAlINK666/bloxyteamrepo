"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const KEY = "vls:users";
const SEQ_KEY = "vls:seq";

let redisClient = null;

function redisEnabled() {
  return !!(
    process.env.HFC_REDIS_REDIS_URL ||
    process.env.HFC_REDIS_KV_URL ||
    process.env.HFC_REDIS_URL ||
    process.env.REDIS_URL ||
    process.env.KV_REST_API_URL ||
    process.env.HFC_REDIS_KV_REST_API_URL
  );
}

async function getRedis() {
  if (redisClient && redisClient.isReady) {
    return redisClient;
  }

  const { createClient } = require("redis");
  const redisUrl =
    process.env.HFC_REDIS_REDIS_URL ||
    process.env.HFC_REDIS_KV_URL ||
    process.env.HFC_REDIS_URL ||
    process.env.REDIS_URL;

  if (!redisUrl) {
    throw new Error(
      "Redis URL not found. Set HFC_REDIS_REDIS_URL, HFC_REDIS_KV_URL, HFC_REDIS_URL or REDIS_URL"
    );
  }

  redisClient = createClient({ url: redisUrl });

  redisClient.on("error", (err) => {
    console.error("[Redis Error]", err.message);
  });

  try {
    await redisClient.connect();
  } catch (err) {
    console.error("[Redis Connect Failed]", err.message);
    throw err;
  }

  return redisClient;
}

async function redisGet() {
  try {
    const client = await getRedis();
    const raw = await client.get(KEY);
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch (e) {
      return {};
    }
  } catch (err) {
    console.error("[redisGet failed, using fallback]", err.message);
    return fileRead();
  }
}

async function redisSet(data) {
  try {
    const client = await getRedis();
    await client.set(KEY, JSON.stringify(data));
  } catch (err) {
    console.error("[redisSet failed, using fallback]", err.message);
    return fileWrite(data);
  }
}

function fileDbPath() {
  const dir = process.env.DATA_DIR || path.join(__dirname, "..", "data");
  return path.join(dir, "db.json");
}

async function fileRead() {
  const dbPath = fileDbPath();
  try {
    const raw = fs.readFileSync(dbPath, "utf8");
    return JSON.parse(raw || "{}");
  } catch (e) {
    return {};
  }
}

async function fileWrite(data) {
  const dbPath = fileDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.writeFileSync(dbPath, JSON.stringify(data, null, 2), "utf8");
}

async function loadUsers() {
  if (redisEnabled()) {
    return redisGet();
  }
  return fileRead();
}

async function saveUsers(users) {
  if (redisEnabled()) {
    return redisSet(users);
  }
  return fileWrite(users);
}

function normalizeUsername(raw) {
  if (typeof raw !== "string") return null;
  const name = raw.trim();
  if (name.length < 3 || name.length > 32) return null;
  if (!/^[a-zA-Z0-9_.\-]+$/.test(name)) return null;
  return name;
}

async function nextUid(users) {
  if (redisEnabled()) {
    try {
      const client = await getRedis();
      const n = await client.incr(SEQ_KEY);
      return String(n);
    } catch (err) {
      console.error("[nextUid Redis failed, using fallback]", err.message);
    }
  }
  let max = 0;
  for (const name of Object.keys(users)) {
    const u = users[name];
    if (u && u.uid && /^\d+$/.test(u.uid)) {
      max = Math.max(max, parseInt(u.uid, 10));
    }
  }
  return String(max + 1);
}

function findUserByUid(users, uid) {
  const key = String(uid == null ? "" : uid).trim();
  if (!key) {
    return null;
  }
  for (const name of Object.keys(users)) {
    if (String(users[name].uid || "") === key) {
      return { username: name, record: users[name] };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Generic document storage (форум, сессии и прочее).
//
// Не затрагивает vls:users (аккаунты/подписки/скины) — это отдельные ключи,
// чтобы ничего в существующем API не поменялось. В Redis пишем под своим
// ключом, локально — в отдельный JSON-файл рядом с db.json.
// ---------------------------------------------------------------------------

function docKey(name) {
  return `vls:${name}`;
}

function docFilePath(name) {
  const dir = process.env.DATA_DIR || path.join(__dirname, "..", "data");
  return path.join(dir, `${name}.json`);
}

async function redisGetKey(key) {
  try {
    const client = await getRedis();
    const raw = await client.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  } catch (err) {
    console.error("[redisGetKey failed]", key, err.message);
    throw err;
  }
}

async function redisSetKey(key, data) {
  try {
    const client = await getRedis();
    await client.set(key, JSON.stringify(data));
  } catch (err) {
    console.error("[redisSetKey failed]", key, err.message);
    throw err;
  }
}

async function loadDoc(name, fallback) {
  const def = fallback === undefined ? {} : fallback;
  if (redisEnabled()) {
    try {
      const data = await redisGetKey(docKey(name));
      return data == null ? def : data;
    } catch (err) {
      console.error("[loadDoc Redis failed, using file fallback]", name, err.message);
    }
  }
  try {
    const raw = fs.readFileSync(docFilePath(name), "utf8");
    const parsed = JSON.parse(raw || "null");
    return parsed == null ? def : parsed;
  } catch (e) {
    return def;
  }
}

async function saveDoc(name, data) {
  if (redisEnabled()) {
    try {
      return await redisSetKey(docKey(name), data);
    } catch (err) {
      console.error("[saveDoc Redis failed, using file fallback]", name, err.message);
    }
  }
  const file = docFilePath(name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

// ---------------------------------------------------------------------------
// Подписанные сессионные токены (stateless, переживают перезахолодку функций).
//
// token = base64url(payloadJSON).base64url(hmacSHA256(payload, SECRET))
// payload = { sub: username, uid, iat, exp }
// ---------------------------------------------------------------------------

function sessionSecret() {
  return process.env.SESSION_KEY || process.env.LICENSE_KEY || "dev-velocity-session-key";
}

function b64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function b64urlDecode(str) {
  const pad = str.length % 4 === 0 ? "" : "=".repeat(4 - (str.length % 4));
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/") + pad;
  return Buffer.from(b64, "base64");
}

function signSession(payload, ttlMs) {
  const now = Date.now();
  const body = {
    sub: String(payload.sub),
    uid: String(payload.uid == null ? "" : payload.uid),
    iat: now,
    exp: now + (Number(ttlMs) > 0 ? Number(ttlMs) : 30 * 86400000),
  };
  const data = b64url(JSON.stringify(body));
  const sig = b64url(crypto.createHmac("sha256", sessionSecret()).update(data).digest());
  return `${data}.${sig}`;
}

function verifySession(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [data, sig] = parts;
  const expected = b64url(crypto.createHmac("sha256", sessionSecret()).update(data).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let body;
  try {
    body = JSON.parse(b64urlDecode(data).toString("utf8"));
  } catch (e) {
    return null;
  }
  if (!body || typeof body !== "object") return null;
  if (!body.exp || Number(body.exp) <= Date.now()) return null;
  return body;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password), salt, 32).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || typeof stored !== "string") {
    return false;
  }
  const parts = stored.split(":");
  if (parts.length !== 2) {
    return false;
  }
  const [salt, hash] = parts;
  const candidate = crypto.scryptSync(String(password), salt, 32).toString("hex");
  const a = Buffer.from(candidate, "hex");
  const b = Buffer.from(hash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function daysLeft(expiresAtMs) {
  const diff = Number(expiresAtMs || 0) - Date.now();
  return Math.ceil(diff / 86400000);
}

function json(res, code, payload) {
  res.status(code).json(payload);
}

module.exports = {
  loadUsers,
  saveUsers,
  normalizeUsername,
  nextUid,
  findUserByUid,
  hashPassword,
  verifyPassword,
  daysLeft,
  json,
  loadDoc,
  saveDoc,
  signSession,
  verifySession,
};