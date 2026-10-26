"use strict";

const { verifySession, loadUsers, findUserByUid } = require("./store");

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

function readCookie(req, name) {
  const header = (req.headers && req.headers.cookie) || "";
  if (!header) return "";
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (key === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return "";
}

function bearer(req) {
  const auth = (req.headers && req.headers.authorization) || "";
  return auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
}

// Достаёт сессию из Authorization: Bearer <token> или из cookie ns_session.
function getSession(req, body) {
  const candidates = [];
  const b = bearer(req);
  if (b) candidates.push(b);
  const cookie = readCookie(req, "ns_session");
  if (cookie) candidates.push(cookie);
  if (body && typeof body.token === "string" && body.token) {
    candidates.push(body.token);
  }
  for (const token of candidates) {
    const session = verifySession(token);
    if (session) return session;
  }
  return null;
}

// Резолвит автора по сессии: возвращает { username, uid } из актуальной
// записи пользователя, а не из клиентских данных.
async function authorFromSession(session) {
  if (!session) return null;
  const users = await loadUsers();
  const account =
    (session.uid ? findUserByUid(users, String(session.uid)) : null) ||
    (session.sub && users[session.sub] ? { username: session.sub, record: users[session.sub] } : null);
  if (!account) return null;
  return { username: account.username, uid: account.record.uid || null };
}

function sessionCookie(token) {
  const maxAge = 30 * 86400;
  return `ns_session=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax; Secure`;
}

function clearSessionCookie() {
  return "ns_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure";
}

module.exports = { parseBody, getSession, readCookie, bearer, sessionCookie, clearSessionCookie, authorFromSession };
