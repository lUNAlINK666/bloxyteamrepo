"use strict";

// Единый сайтовый эндпоинт (Hobby-план Vercel: максимум 12 функций на деплой,
// поэтому логин/сессия/профиль/форум собраны в один файл).
//
// Маршрутизация по ?action=:
//   POST /api/site?action=login     {username,password,action:"login"|"register"}
//   GET  /api/site?action=me
//   POST /api/site?action=me        (logout)
//   GET  /api/site?action=profile&uid=..|&username=..
//   GET  /api/site?action=forum
//   POST /api/site?action=forum     {title,body}
//   GET  /api/site?action=thread&id=..
//   POST /api/site?action=thread&id=..  {body}
//   GET  /api/site?action=avatar&uid=..|&username=..   (отдаёт картинку)
//   POST /api/site?action=avatar        {dataUrl}      (загрузка аватара)
//
// Существующие эндпоинты чита (/api/sync, /api/bind, /api/skins, /api/unbind,
// /api/status, /api/register, /api/token, /api/free, /api/logo) НЕ затронуты.

const {
  loadUsers,
  saveUsers,
  normalizeUsername,
  nextUid,
  findUserByUid,
  hashPassword,
  verifyPassword,
  signSession,
  loadDoc,
  saveDoc,
  daysLeft,
  json,
  getUserRole,
  isAdmin,
  loadInvites,
  saveInvites,
  loadConfig,
  saveConfig,
} = require("../lib/store");
const {
  parseBody,
  getSession,
  authorFromSession,
  sessionCookie,
  clearSessionCookie,
} = require("../lib/http");

const MAX_TITLE = 120;
const MAX_BODY = 8000;
const MAX_AVATAR_BYTES = 512 * 1024;

// ---------------------------------------------------------------------------
// Аватарки. Храним отдельным документом avatar_<uid> в doc-storage
// (vls:avatar_<uid> в Redis / data/avatar_<uid>.json локально). Записи
// пользователей (vls:users) НЕ трогаем — чит/лоадер не затронуты.
// ---------------------------------------------------------------------------

function parseAvatarDataUrl(dataUrl) {
  if (typeof dataUrl !== "string") return null;
  const m = /^data:(image\/(?:png|jpe?g|webp|gif));base64,([A-Za-z0-9+/=]+)$/i.exec(dataUrl.trim());
  if (!m) return null;
  let contentType = m[1].toLowerCase();
  if (contentType === "image/jpg") contentType = "image/jpeg";
  let buffer;
  try {
    buffer = Buffer.from(m[2], "base64");
  } catch (e) {
    return null;
  }
  if (!buffer || !buffer.length || buffer.length > MAX_AVATAR_BYTES) return null;
  return { contentType, buffer };
}

async function handleAvatar(req, res) {
  const body = req.method === "POST" ? await parseBody(req) : null;

  if (req.method === "POST") {
    const session = getSession(req, body);
    if (!session) return json(res, 401, { ok: false, error: "unauthorized" });

    const author = await authorFromSession(session);
    if (!author || !author.uid) return json(res, 401, { ok: false, error: "unauthorized" });

    const parsed = parseAvatarDataUrl(String((body && body.dataUrl) || ""));
    if (!parsed) return json(res, 400, { ok: false, error: "invalid image" });

    const updatedAtMs = Date.now();
    await saveDoc("avatar_" + author.uid, {
      contentType: parsed.contentType,
      data: parsed.buffer.toString("base64"),
      updatedAtMs,
    });

    return json(res, 200, {
      ok: true,
      updatedAtMs,
      avatarUrl:
        "/api/site?action=avatar&uid=" + encodeURIComponent(author.uid) + "&v=" + updatedAtMs,
    });
  }

  if (req.method !== "GET") {
    return json(res, 405, { ok: false, error: "method not allowed" });
  }

  const query = req.query || {};
  let uid = query.uid ? String(query.uid) : "";
  if (!uid && query.username) {
    const users = await loadUsers();
    const un = normalizeUsername(query.username);
    if (un && users[un]) uid = String(users[un].uid || "");
  }
  if (!uid) return json(res, 404, { ok: false, error: "no avatar" });

  const doc = await loadDoc("avatar_" + uid, null);
  if (!doc || !doc.data) return json(res, 404, { ok: false, error: "no avatar" });

  const etag = '"av' + (doc.updatedAtMs || 0) + '"';
  const headers = {
    "Cache-Control": "public, no-cache",
    ETag: etag,
  };
  for (const key of Object.keys(headers)) res.setHeader(key, headers[key]);

  if (String(req.headers["if-none-match"] || "") === etag) {
    return res.status(304).end();
  }

  res.setHeader("Content-Type", doc.contentType || "image/png");
  return res.status(200).send(Buffer.from(doc.data, "base64"));
}

// ---------------------------------------------------------------------------
// Логин / регистрация / сессия
// ---------------------------------------------------------------------------

async function handleLogin(req, res) {
  if (req.method !== "POST") {
    return json(res, 405, { ok: false, error: "method not allowed" });
  }

  const body = await parseBody(req);
  const username = normalizeUsername(body.username);
  const password = String(body.password || "");
  const action = body.action === "register" ? "register" : "login";
  const inviteCode = String(body.invite || body.inviteCode || "").trim();

  if (!username) return json(res, 400, { ok: false, error: "invalid username" });
  if (password.length < 4 || password.length > 64) {
    return json(res, 400, { ok: false, error: "invalid password" });
  }

  const users = await loadUsers();
  const config = await loadConfig();
  let existing = users[username];

  if (action === "login") {
    if (!existing || !verifyPassword(password, existing.passwordHash)) {
      return json(res, 401, { ok: false, error: "bad credentials" });
    }
  } else if (!existing) {
    if (config.requireInvite) {
      if (!inviteCode) {
        return json(res, 403, { ok: false, error: "invite required" });
      }
      const invites = await loadInvites();
      const invite = invites.find((i) => i && i.code === inviteCode && !i.used);
      if (!invite) {
        return json(res, 403, { ok: false, error: "invalid invite" });
      }
      // mark invite used
      invite.used = true;
      invite.usedBy = username;
      invite.usedByUid = null; // will set after uid
      invite.usedAt = Date.now();
      await saveInvites(invites);
    }

    const uid = await nextUid(users);
    // mark invite usedByUid
    if (config.requireInvite && inviteCode) {
      try {
        const invites = await loadInvites();
        const invite = invites.find((i) => i && i.code === inviteCode);
        if (invite) {
          invite.usedByUid = uid;
          await saveInvites(invites);
        }
      } catch (e) {}
    }

    let role = "member";
    const uidNum = Number(uid);
    if (uidNum === 1) role = "coder";
    if (uidNum === 2) role = "owner";

    existing = {
      uid,
      username: body.username,
      passwordHash: hashPassword(password),
      expiresAtMs: 0,
      createdAtMs: Date.now(),
      role,
    };
    users[username] = existing;
    await saveUsers(users);
  } else {
    return json(res, 409, { ok: false, error: "username taken" });
  }

  const token = signSession({ sub: username, uid: existing.uid }, 30 * 86400000);
  res.setHeader("Set-Cookie", sessionCookie(token));

  return json(res, 200, {
    ok: true,
    action,
    token,
    username,
    uid: existing.uid,
    role: getUserRole(existing),
    expiresAtMs: existing.expiresAtMs || null,
    expiresAtIso: existing.expiresAtMs ? new Date(existing.expiresAtMs).toISOString() : null,
    active: !!existing.expiresAtMs && existing.expiresAtMs > Date.now(),
  });
}

async function handleMe(req, res) {
  if (req.method === "POST") {
    res.setHeader("Set-Cookie", clearSessionCookie());
    return json(res, 200, { ok: true, loggedOut: true });
  }
  if (req.method !== "GET") {
    return json(res, 405, { ok: false, error: "method not allowed" });
  }

  const session = getSession(req);
  if (!session) return json(res, 200, { ok: true, authenticated: false });

  const users = await loadUsers();
  const account =
    (session.uid ? findUserByUid(users, String(session.uid)) : null) ||
    (users[session.sub] ? { username: session.sub, record: users[session.sub] } : null);

  if (!account) {
    res.setHeader("Set-Cookie", clearSessionCookie());
    return json(res, 200, { ok: true, authenticated: false });
  }

  const record = account.record;
  const expiresAtMs = record.expiresAtMs || 0;
  const uidNum = Number(record.uid);
  let role = record.role || getUserRole(record);
  if (uidNum === 1) role = "coder";
  if (uidNum === 2) role = "owner";
  if ((uidNum === 1 || uidNum === 2) && record.role !== role) {
    record.role = role;
    users[account.username] = record;
    try { await saveUsers(users); } catch (e) {}
  }
  const isSpecial = uidNum === 1 || uidNum === 2;
  return json(res, 200, {
    ok: true,
    authenticated: true,
    username: account.username,
    uid: record.uid || null,
    role,
    canManage: isSpecial ? true : record.canManage === true,
    canInvite: isSpecial ? true : record.canInvite === true,
    isAdmin: isSpecial || isAdmin(record),
    active: daysLeft(expiresAtMs) > 0,
    expiresAtMs: expiresAtMs || null,
    expiresAtIso: expiresAtMs ? new Date(expiresAtMs).toISOString() : null,
  });
}

// ---------------------------------------------------------------------------
// Публичный профиль
// ---------------------------------------------------------------------------

function forumStats(forum, username, uid) {
  const threads = Array.isArray(forum && forum.threads) ? forum.threads : [];
  let threadCount = 0;
  let postCount = 0;
  let lastAt = 0;
  for (const t of threads) {
    const isThreadAuthor = t.author === username || String(t.authorUid || "") === String(uid || "");
    if (isThreadAuthor) {
      threadCount += 1;
      lastAt = Math.max(lastAt, Number(t.createdAt || 0));
    }
    const posts = Array.isArray(t.posts) ? t.posts : [];
    for (const p of posts) {
      if (p.author === username || String(p.authorUid || "") === String(uid || "")) {
        postCount += 1;
        lastAt = Math.max(lastAt, Number(p.createdAt || 0));
      }
    }
  }
  return { threads: threadCount, posts: postCount, lastActivityMs: lastAt || null };
}

async function handleProfile(req, res) {
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
    if (username && users[username]) account = { username, record: users[username] };
  }

  if (!account) return json(res, 404, { ok: false, error: "user not found" });

  const record = account.record;
  const expiresAtMs = record.expiresAtMs || 0;
  const forum = await loadDoc("forum", { threads: [], seq: 0 });
  const uidNum = Number(record.uid);
  let role = record.role || getUserRole(record);
  if (uidNum === 1 && role !== "coder") role = "coder";
  if (uidNum === 2 && role !== "owner") role = "owner";

  return json(res, 200, {
    ok: true,
    username: account.username,
    uid: record.uid || null,
    role,
    isAdmin: uidNum === 1 || uidNum === 2 || isAdmin(record),
    active: daysLeft(expiresAtMs) > 0,
    expiresAtMs: expiresAtMs || null,
    expiresAtIso: expiresAtMs ? new Date(expiresAtMs).toISOString() : null,
    createdAtMs: record.createdAtMs || null,
    createdAtIso: record.createdAtMs ? new Date(record.createdAtMs).toISOString() : null,
    forum: forumStats(forum, account.username, record.uid),
  });
}

// ---------------------------------------------------------------------------
// Форум
// ---------------------------------------------------------------------------

function threadMeta(t) {
  const posts = Array.isArray(t.posts) ? t.posts : [];
  const last = posts.length ? posts[posts.length - 1] : null;
  return {
    id: t.id,
    title: t.title,
    author: t.author,
    authorUid: t.authorUid || null,
    createdAt: t.createdAt || null,
    replies: posts.length,
    lastAt: last ? last.createdAt : t.createdAt || null,
    lastAuthor: last ? last.author : t.author,
  };
}

function publicThread(t) {
  const posts = Array.isArray(t.posts) ? t.posts : [];
  return {
    id: t.id,
    title: t.title,
    author: t.author,
    authorUid: t.authorUid || null,
    createdAt: t.createdAt || null,
    replies: posts.length,
    posts: posts.map((p) => ({
      id: p.id,
      author: p.author,
      authorUid: p.authorUid || null,
      body: p.body,
      createdAt: p.createdAt || null,
    })),
  };
}

async function handleForum(req, res) {
  if (req.method === "GET") {
    const forum = await loadDoc("forum", { threads: [], seq: 0 });
    const threads = (Array.isArray(forum.threads) ? forum.threads : [])
      .map(threadMeta)
      .sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
    return json(res, 200, { ok: true, count: threads.length, threads });
  }

  if (req.method === "POST") {
    const body = await parseBody(req);
    const session = getSession(req, body);
    if (!session) return json(res, 401, { ok: false, error: "unauthorized" });

    const title = String(body.title || "").trim();
    const text = String(body.body || "").trim();
    if (title.length < 3 || title.length > MAX_TITLE) {
      return json(res, 400, { ok: false, error: "invalid title" });
    }
    if (text.length < 1 || text.length > MAX_BODY) {
      return json(res, 400, { ok: false, error: "invalid body" });
    }

    const author = await authorFromSession(session);
    if (!author) return json(res, 401, { ok: false, error: "unauthorized" });

    const forum = await loadDoc("forum", { threads: [], seq: 0 });
    if (!Array.isArray(forum.threads)) forum.threads = [];
    const id = (Number(forum.seq) || 0) + 1;
    forum.seq = id;

    const now = Date.now();
    forum.threads.push({
      id,
      title,
      author: author.username,
      authorUid: author.uid,
      createdAt: now,
      posts: [
        { id: 1, author: author.username, authorUid: author.uid, body: text, createdAt: now },
      ],
    });

    await saveDoc("forum", forum);
    return json(res, 200, { ok: true, thread: threadMeta(forum.threads[forum.threads.length - 1]) });
  }

  return json(res, 405, { ok: false, error: "method not allowed" });
}

async function handleThread(req, res) {
  const query = req.query || {};
  const id = Number(query.id);
  if (!Number.isInteger(id) || id <= 0) {
    return json(res, 400, { ok: false, error: "invalid thread id" });
  }

  if (req.method === "GET") {
    const forum = await loadDoc("forum", { threads: [], seq: 0 });
    const thread = (Array.isArray(forum.threads) ? forum.threads : []).find((t) => Number(t.id) === id);
    if (!thread) return json(res, 404, { ok: false, error: "thread not found" });
    return json(res, 200, { ok: true, thread: publicThread(thread) });
  }

  if (req.method === "POST") {
    const body = await parseBody(req);
    const session = getSession(req, body);
    if (!session) return json(res, 401, { ok: false, error: "unauthorized" });

    const text = String(body.body || "").trim();
    if (text.length < 1 || text.length > MAX_BODY) {
      return json(res, 400, { ok: false, error: "invalid body" });
    }

    const author = await authorFromSession(session);
    if (!author) return json(res, 401, { ok: false, error: "unauthorized" });

    const forum = await loadDoc("forum", { threads: [], seq: 0 });
    const thread = (Array.isArray(forum.threads) ? forum.threads : []).find((t) => Number(t.id) === id);
    if (!thread) return json(res, 404, { ok: false, error: "thread not found" });

    if (!Array.isArray(thread.posts)) thread.posts = [];
    thread.posts.push({
      id: thread.posts.length + 1,
      author: author.username,
      authorUid: author.uid,
      body: text,
      createdAt: Date.now(),
    });

    await saveDoc("forum", forum);
    return json(res, 200, { ok: true, post: thread.posts[thread.posts.length - 1] });
  }

  return json(res, 405, { ok: false, error: "method not allowed" });
}

// ---------------------------------------------------------------------------
// Админка / инвайты / чат
// ---------------------------------------------------------------------------

async function requireAdmin(req, body) {
  const session = getSession(req, body);
  if (!session) return { ok: false, error: "unauthorized" };
  const author = await authorFromSession(session);
  if (!author) return { ok: false, error: "unauthorized" };
  const users = await loadUsers();
  const account =
    (author.uid ? findUserByUid(users, author.uid) : null) ||
    (users[author.username] ? { username: author.username, record: users[author.username] } : null);
  if (!account) return { ok: false, error: "unauthorized" };
  const record = account.record;
  const uidNum = Number(record.uid);
  const role = record.role || getUserRole(record);
  if (!(uidNum === 1 || uidNum === 2 || record.canManage === true || isAdmin(record))) {
    return { ok: false, error: "forbidden" };
  }
  return { ok: true, account, record, session, author };
}

async function requireInvitePerm(req, body) {
  const session = getSession(req, body);
  if (!session) return { ok: false, error: "unauthorized" };
  const author = await authorFromSession(session);
  if (!author) return { ok: false, error: "unauthorized" };
  const users = await loadUsers();
  const account =
    (author.uid ? findUserByUid(users, author.uid) : null) ||
    (users[author.username] ? { username: author.username, record: users[author.username] } : null);
  if (!account) return { ok: false, error: "unauthorized" };
  const record = account.record;
  const uidNum = Number(record.uid);
  const role = record.role || getUserRole(record);
  if (!(uidNum === 1 || uidNum === 2 || record.canInvite === true)) {
    return { ok: false, error: "forbidden" };
  }
  return { ok: true, account, record, session, author };
}

async function handleAdmin(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return json(res, 405, { ok: false, error: "method not allowed" });
  }
  const body = req.method === "POST" ? await parseBody(req) : null;
  const adm = await requireAdmin(req, body);
  if (!adm.ok) return json(res, adm.error === "forbidden" ? 403 : 401, { ok: false, error: adm.error });

  const users = await loadUsers();
  const invites = await loadInvites();
  const config = await loadConfig();

  if (req.method === "GET") {
    const list = Object.entries(users).map(([username, record]) => {
      const uidNum = Number(record.uid);
      let role = record.role || getUserRole(record);
      if (uidNum === 1) role = "coder";
      if (uidNum === 2) role = "owner";
      const isSpecial = uidNum === 1 || uidNum === 2;
      const canManage = isSpecial || record.canManage === true || isAdmin(record);
      const canInvite = isSpecial || record.canInvite === true || isAdmin(record);
      return {
        username,
        uid: record.uid || null,
        role,
        isAdmin: uidNum === 1 || uidNum === 2 || isAdmin(record),
        canManage,
        canInvite,
        createdAtMs: record.createdAtMs || null,
      };
    });
    list.sort((a, b) => Number(a.uid || 0) - Number(b.uid || 0));
    return json(res, 200, {
      ok: true,
      config,
      invites: invites.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)),
      users: list,
      me: { username: adm.account.username, uid: adm.record.uid, role: adm.record.role },
    });
  }

  // POST
  const action = String(body.action || "");
  if (action === "createInvite") {
    const code = Math.random().toString(36).slice(2, 10).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase();
    const invite = {
      code,
      createdAt: Date.now(),
      createdBy: adm.account.username,
      createdByUid: adm.record.uid,
      used: false,
    };
    invites.push(invite);
    await saveInvites(invites);
    return json(res, 200, { ok: true, invite });
  }
  if (action === "toggleInvite") {
    config.requireInvite = !!body.requireInvite;
    await saveConfig(config);
    return json(res, 200, { ok: true, config });
  }
  if (action === "setRole") {
    const targetUid = String(body.uid || "");
    const newRole = String(body.role || "member");
    const account = findUserByUid(users, targetUid);
    if (!account) return json(res, 404, { ok: false, error: "user not found" });
    const tuid = Number(account.record.uid);
    if (tuid === 1 || tuid === 2) return json(res, 403, { ok: false, error: "cannot change special users" });
    if (adm.record.uid === "1" && newRole === "owner") account.record.role = "owner";
    else if (adm.record.uid === "1") account.record.role = newRole;
    else if (adm.record.uid === "2" && newRole !== "owner") account.record.role = newRole;
    else return json(res, 403, { ok: false, error: "forbidden" });
    users[account.username] = account.record;
    await saveUsers(users);
    return json(res, 200, { ok: true });
  }
  if (action === "setPerm") {
    const targetUid = String(body.uid || "");
    const perm = String(body.perm || "");
    const val = !!body.value;
    const account = findUserByUid(users, targetUid);
    if (!account) return json(res, 404, { ok: false, error: "user not found" });
    const tuid = Number(account.record.uid);
    if (tuid === 1 || tuid === 2) return json(res, 403, { ok: false, error: "cannot change special users" });
    if (!(adm.record.uid === "1" || adm.record.uid === "2" || getUserRole(adm.record) === "owner" || getUserRole(adm.record) === "coder")) {
      return json(res, 403, { ok: false, error: "forbidden" });
    }
    if (perm === "invite") {
      account.record.canInvite = val;
    }
    if (perm === "manage") {
      account.record.canManage = val;
    }
    users[account.username] = account.record;
    await saveUsers(users);
    return json(res, 200, { ok: true });
  }
  if (action === "revokeInvite") {
    const code = String(body.code || "");
    const idx = invites.findIndex((i) => i && i.code === code);
    if (idx >= 0) {
      invites.splice(idx, 1);
      await saveInvites(invites);
    }
    return json(res, 200, { ok: true });
  }
  if (action === "deleteUser") {
    const targetUid = String(body.uid || "");
    const account = findUserByUid(users, targetUid);
    if (!account) return json(res, 404, { ok: false, error: "user not found" });
    const tuid = Number(account.record.uid);
    if (tuid === 1 || tuid === 2) return json(res, 403, { ok: false, error: "cannot delete special users" });
    if (adm.record.uid !== "1" && adm.record.uid !== "2" && getUserRole(adm.record) !== "owner" && getUserRole(adm.record) !== "coder") {
      return json(res, 403, { ok: false, error: "forbidden" });
    }
    delete users[account.username];
    await saveUsers(users);
    try { await saveDoc("avatar_" + targetUid, null); } catch (e) {}
    return json(res, 200, { ok: true });
  }

  return json(res, 400, { ok: false, error: "unknown action" });
}

const GENERAL_CHAT_KEY = "vls:general_chat";

async function handleChat(req, res) {
  if (req.method === "GET") {
    const chat = await loadDoc(GENERAL_CHAT_KEY, { messages: [], seq: 0 });
    if (!Array.isArray(chat.messages)) chat.messages = [];
    // return last 50
    const messages = chat.messages.slice(-50);
    return json(res, 200, { ok: true, messages });
  }
  if (req.method === "POST") {
    const body = await parseBody(req);
    const session = getSession(req, body);
    if (!session) return json(res, 401, { ok: false, error: "unauthorized" });
    const author = await authorFromSession(session);
    if (!author) return json(res, 401, { ok: false, error: "unauthorized" });
    const text = String(body.text || body.body || "").trim();
    if (text.length < 1 || text.length > 2000) {
      return json(res, 400, { ok: false, error: "invalid text" });
    }
    const users = await loadUsers();
    const account =
      (author.uid ? findUserByUid(users, author.uid) : null) ||
      (users[author.username] ? { username: author.username, record: users[author.username] } : null);
    const record = account ? account.record : {};
    const uidNum = Number(record.uid || author.uid);
    let role = record.role || getUserRole(record);
    if (uidNum === 1 && role !== "coder") role = "coder";
    if (uidNum === 2 && role !== "owner") role = "owner";
    const chat = await loadDoc(GENERAL_CHAT_KEY, { messages: [], seq: 0 });
    if (!Array.isArray(chat.messages)) chat.messages = [];
    if (typeof chat.seq !== "number") chat.seq = chat.messages.length;
    const id = chat.seq + 1;
    chat.seq = id;
    chat.messages.push({
      id,
      author: author.username,
      authorUid: author.uid,
      role,
      text,
      createdAt: Date.now(),
    });
    if (chat.messages.length > 500) {
      chat.messages = chat.messages.slice(chat.messages.length - 500);
    }
    await saveDoc(GENERAL_CHAT_KEY, chat);
    return json(res, 200, { ok: true });
  }
  return json(res, 405, { ok: false, error: "method not allowed" });
}

async function handleBuy(req, res) {
  return json(res, 410, { ok: false, error: "disabled" });
}

// ---------------------------------------------------------------------------

module.exports = async function (req, res) {
  const action = (req.query && req.query.action) || "";
  switch (action) {
    case "login":
      return handleLogin(req, res);
    case "me":
      return handleMe(req, res);
    case "profile":
      return handleProfile(req, res);
    case "forum":
      return handleForum(req, res);
    case "thread":
      return handleThread(req, res);
    case "buy":
      return handleBuy(req, res);
    case "avatar":
      return handleAvatar(req, res);
    case "admin":
      return handleAdmin(req, res);
    case "chat":
      return handleChat(req, res);
    default:
      return json(res, 404, { ok: false, error: "unknown action" });
  }
};
