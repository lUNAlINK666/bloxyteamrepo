"use strict";

const path = require("path");
process.env.DATA_DIR = path.join(__dirname, "data-test");
require("fs").rmSync(process.env.DATA_DIR, { recursive: true, force: true });

const http = require("http");
const statusHandler = require("./api/status");
const registerHandler = require("./api/register");
const usersHandler = require("./api/users");
const freeHandler = require("./api/free");
const bindHandler = require("./api/bind");
const unbindHandler = require("./api/unbind");
const syncHandler = require("./api/sync");

const PORT = 4123;

function request(method, path, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      { host: "127.0.0.1", port: PORT, path, method, headers: { ...(headers || {}), ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}) } },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () =>
          resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(raw); } catch { return raw; } })() })
        );
      }
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  const server = http.createServer(async (req, res) => {
    const fakeRes = { status(c) { return { json(p) { res.writeHead(c, { "Content-Type": "application/json" }); res.end(JSON.stringify(p)); } }; } };
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const fakeReq = { method: req.method, headers: req.headers, query: Object.fromEntries(url.searchParams), body: undefined };
    if (req.method === "POST") {
      let raw = "";
      for await (const c of req) raw += c;
      try { fakeReq.body = JSON.parse(raw); } catch {}
    }
    try {
      if (url.pathname === "/api/status") await statusHandler(fakeReq, fakeRes);
      else if (url.pathname === "/api/register") await registerHandler(fakeReq, fakeRes);
      else if (url.pathname === "/api/users") await usersHandler(fakeReq, fakeRes);
      else if (url.pathname === "/api/free") await freeHandler(fakeReq, fakeRes);
      else if (url.pathname === "/api/bind") await bindHandler(fakeReq, fakeRes);
      else if (url.pathname === "/api/unbind") await unbindHandler(fakeReq, fakeRes);
      else if (url.pathname === "/api/sync") await syncHandler(fakeReq, fakeRes);
      else { res.writeHead(404); res.end(); }
    } catch (e) { res.writeHead(500); res.end(String(e)); }
  });

  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

  let pass = 0, fail = 0;
  const check = (name, cond, extra) => { if (cond) { pass++; console.log(`PASS  ${name}`); } else { fail++; console.log(`FAIL  ${name} ${extra || ""}`); } };

  // Регистрация: первый юзер получает uid "1"
  const r1 = await request("POST", "/api/register", { username: "alice", password: "pass1234" });
  check("register alice -> uid 1", r1.status === 200 && r1.json && r1.json.uid === "1", JSON.stringify(r1.json));

  // Второй -> uid 2
  const r2 = await request("POST", "/api/register", { username: "bob", password: "pass1234" });
  check("register bob -> uid 2", r2.status === 200 && r2.json && r2.json.uid === "2", JSON.stringify(r2.json));

  // Дубликат ника
  const r3 = await request("POST", "/api/register", { username: "alice", password: "pass1234" });
  check("duplicate username -> 409", r3.status === 409, `status=${r3.status}`);

  // Логин верный
  const r4 = await request("POST", "/api/register", { username: "alice", password: "pass1234", action: "login" });
  check("login alice ok, uid stays 1", r4.status === 200 && r4.json && r4.json.uid === "1", JSON.stringify(r4.json));

  // Логин неверный пароль
  const r5 = await request("POST", "/api/register", { username: "alice", password: "wrong", action: "login" });
  check("login wrong password -> 401", r5.status === 401, `status=${r5.status}`);

  // Проверка статуса по uid (как чит)
  const r6 = await request("GET", "/api/status?uid=2");
  check("status by uid 2 = bob", r6.status === 200 && r6.json && r6.json.username === "bob", JSON.stringify(r6.json));

  // Продление подписки по uid
  const r7 = await request("POST", "/api/free", { uid: "2", password: "pass1234", days: 30 });
  check("free extend by uid", r7.status === 200 && r7.json && r7.json.expiresAtIso === new Date(r7.json.expiresAtMs).toISOString(), JSON.stringify(r7.json));

  // Статус теперь активен
  const r8 = await request("GET", "/api/status?uid=2");
  check("status active after extend", r8.json && r8.json.active === true && r8.json.expiresAtIso === new Date(r8.json.expiresAtMs).toISOString(), JSON.stringify(r8.json));

  // Продление без пароля -> 401
  const r9 = await request("POST", "/api/free", { username: "bob", days: 30 });
  check("free without password -> 401", r9.status === 401, `status=${r9.status}`);

  // Статус несуществующего uid
  const r10 = await request("GET", "/api/status?uid=999");
  check("status unknown uid -> 404", r10.status === 404, `status=${r10.status}`);

  // --- Привязка steamid + синхронизация подписчиков ---

  const { signLicense } = require("./lib/blob");

  // Регистрируем и делаем активным третьего юзера для привязки
  const rc = await request("POST", "/api/register", { username: "carol", password: "pass1234" });
  check("register carol", rc.status === 200 && rc.json && rc.json.uid === "3", JSON.stringify(rc.json));

  const rf = await request("POST", "/api/free", { uid: "3", password: "pass1234", days: 30 });
  check("extend carol", rf.status === 200 && rf.json && rf.json.expiresAtMs > 0, JSON.stringify(rf.json));

  // Валидный блоб (подпись серверным ключом) -> привязка steamid
  const hmacOk = signLicense({ uid: 3, expiresAtMs: rf.json.expiresAtMs }).toString("hex");
  const rb1 = await request("POST", "/api/bind", { uid: "3", expiresAtMs: rf.json.expiresAtMs, hmac: hmacOk, steamid: "76561198000000001" });
  check("bind valid blob -> 200 with steamid", rb1.status === 200 && rb1.json && rb1.json.steamid === "76561198000000001", JSON.stringify(rb1.json));

  // Невалидный hmac -> 401
  const rb2 = await request("POST", "/api/bind", { uid: "3", expiresAtMs: rf.json.expiresAtMs, hmac: "0".repeat(64), steamid: "76561198000000002" });
  check("bind bad hmac -> 401", rb2.status === 401, `status=${rb2.status}`);

  // Неверный steamid -> 400
  const rb3 = await request("POST", "/api/bind", { uid: "3", expiresAtMs: rf.json.expiresAtMs, hmac: hmacOk, steamid: "123" });
  check("bind invalid steamid -> 400", rb3.status === 400, `status=${rb3.status}`);

  // На один uid (как в релизе) можно привязать несколько steamid
  const rb4 = await request("POST", "/api/bind", { uid: "3", expiresAtMs: rf.json.expiresAtMs, hmac: hmacOk, steamid: "76561198000000002" });
  check("second steamid under same uid ok", rb4.status === 200 && rb4.json && rb4.json.steamid === "76561198000000002", JSON.stringify(rb4.json));

  // /api/sync отдаёт чистый массив steamid
  const rs = await request("GET", "/api/sync");
  const syncList = rs.json && Array.isArray(rs.json) ? rs.json : [];
  check("sync is bare steamid array", rs.status === 200 && Array.isArray(rs.json) && syncList.every((id) => typeof id === "string" && /^\d{17}$/.test(id)), JSON.stringify(rs.json));
  check("sync lists both bound steamids", syncList.includes("76561198000000001") && syncList.includes("76561198000000002"), JSON.stringify(rs.json));

  // Снятие лизинга -> steamid уходит из списка
  const ru1 = await request("POST", "/api/unbind", { uid: "3", expiresAtMs: rf.json.expiresAtMs, hmac: hmacOk, steamid: "76561198000000001" });
  check("unbind valid -> removed", ru1.status === 200 && ru1.json && ru1.json.removed === true, JSON.stringify(ru1.json));

  const rs2 = await request("GET", "/api/sync");
  const syncList2 = rs2.json && Array.isArray(rs2.json) ? rs2.json : [];
  check("sync drops unbound steamid", !syncList2.includes("76561198000000001") && syncList2.includes("76561198000000002"), JSON.stringify(rs2.json));

  // Unbind с плохим hmac -> 401
  const ru2 = await request("POST", "/api/unbind", { uid: "3", expiresAtMs: rf.json.expiresAtMs, hmac: "0".repeat(64), steamid: "76561198000000002" });
  check("unbind bad hmac -> 401", ru2.status === 401, `status=${ru2.status}`);

  // GET на bind и POST на sync -> 405
  const rb5 = await request("GET", "/api/bind");
  check("bind GET -> 405", rb5.status === 405, `status=${rb5.status}`);
  const rs3 = await request("POST", "/api/sync", {});
  check("sync POST -> 405", rs3.status === 405, `status=${rs3.status}`);

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });