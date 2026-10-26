"use strict";

const { loadUsers, json } = require("../lib/store");

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

module.exports = async function (req, res) {
  if (req.method !== "GET") {
    return json(res, 405, { ok: false, error: "method not allowed" });
  }

  const header = req.headers["x-admin-token"] || "";
  const auth = req.headers.authorization || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";

  if (!ADMIN_TOKEN || (header !== ADMIN_TOKEN && bearer !== ADMIN_TOKEN)) {
    return json(res, 401, { ok: false, error: "unauthorized" });
  }

  const users = await loadUsers();
  const list = Object.entries(users).map(([username, record]) => ({
    username,
    uid: record.uid || null,
    expiresAtMs: record.expiresAtMs || null,
    active: !!record.expiresAtMs && record.expiresAtMs > Date.now(),
  }));

  list.sort((a, b) => (a.expiresAtMs > b.expiresAtMs ? -1 : 1));

  return json(res, 200, { ok: true, count: list.length, users: list });
};