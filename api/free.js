"use strict";

const { loadUsers, saveUsers, findUserByUid, verifyPassword, normalizeUsername, json } = require("../lib/store");

const FREE_DAYS = Number(process.env.FREE_DAYS || 30);

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

  let account = null;
  let passwordOk = false;
  const users = await loadUsers();

  if (body.uid) {
    account = findUserByUid(users, body.uid);
    if (account) {
      passwordOk = verifyPassword(body.password, account.record.passwordHash);
    }
  } else {
    const username = normalizeUsername(body.username);
    if (username && users[username]) {
      account = { username, record: users[username] };
      passwordOk = verifyPassword(body.password, account.record.passwordHash);
    }
  }

  if (!account) {
    return json(res, 404, { ok: false, error: "user not found" });
  }
  if (!passwordOk) {
    return json(res, 401, { ok: false, error: "bad credentials" });
  }

  let grantedDays = Number(body.days);
  if (!Number.isFinite(grantedDays) || grantedDays < 1 || grantedDays > 3650) {
    grantedDays = FREE_DAYS;
  }

  const now = Date.now();
  let startMs = now;
  if (account.record.expiresAtMs && account.record.expiresAtMs > now) {
    startMs = account.record.expiresAtMs;
  }

  const expiresAtMs = startMs + grantedDays * 86400000;
  account.record.expiresAtMs = expiresAtMs;
  users[account.username] = account.record;
  await saveUsers(users);

  return json(res, 200, {
    ok: true,
    username: account.username,
    uid: account.record.uid,
    grantedDays,
    expiresAtMs,
    expiresAtIso: new Date(expiresAtMs).toISOString(),
  });
};