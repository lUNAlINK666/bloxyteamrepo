"use strict";

const { loadUsers, findUserByUid, normalizeUsername, daysLeft, json } = require("../lib/store");

module.exports = async function (req, res) {
  if (req.method !== "GET") {
    return json(res, 405, { ok: false, error: "method not allowed" });
  }

  const query = req.query || {};
  const users = await loadUsers();

  let account = null;

  if (query.uid) {
    account = findUserByUid(users, query.uid);
  } else if (query.username) {
    const username = normalizeUsername(query.username);
    if (username && users[username]) {
      account = { username, record: users[username] };
    }
  }

  if (!account) {
    return json(res, 404, { ok: false, error: "user not found" });
  }

  const left = daysLeft(account.record.expiresAtMs);
  return json(res, 200, {
    ok: true,
    username: account.username,
    uid: account.record.uid || null,
    active: left > 0,
    expiresAtMs: account.record.expiresAtMs || null,
    expiresAtIso: account.record.expiresAtMs ? new Date(account.record.expiresAtMs).toISOString() : null,
  });
};