"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

const statusHandler = require("./api/status");
const registerHandler = require("./api/register");
const usersHandler = require("./api/users");
const tokenHandler = require("./api/token");
const bindHandler = require("./api/bind");
const syncHandler = require("./api/sync");
const skinsHandler = require("./api/skins");
const siteHandler = require("./api/site");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

// Роуты-rewrite: как в vercel.json. Отдают соответствующий .html из public/,
// но URL в браузере остаётся прежним (страница сама разбирает location.pathname).
const REWRITES = {
  "/": "/index.html",
  "/buy": "/buy.html",
  "/profile": "/profile.html",
  "/register": "/register.html",
  "/forum": "/forum.html",
};

const PAGE_PATTERNS = [
  { re: /^\/thread\/\d+\/?$/, file: "thread.html" },
  { re: /^\/u\/[^/]+\/?$/, file: "user.html" },
];

const PUBLIC_DIR = path.join(__dirname, "public");
const PORT = process.env.PORT || 3000;

function collectBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        resolve({});
      }
    });
  });
}

function serveStatic(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<h1>404 — не найдено</h1>");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-token, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const body = await collectBody(req);

  const wrap = (handler) => {
    const extraHeaders = {};
    const fakeRes = {
      setHeader(name, value) {
        extraHeaders[name] = value;
      },
      status(code) {
        return {
          json(payload) {
            res.writeHead(code, Object.assign({ "Content-Type": "application/json" }, extraHeaders));
            res.end(JSON.stringify(payload));
          },
          send(data) {
            const headers = Object.assign({}, extraHeaders);
            if (Buffer.isBuffer(data)) {
              if (!headers["Content-Type"]) headers["Content-Type"] = "application/octet-stream";
            } else if (!headers["Content-Type"]) {
              headers["Content-Type"] = "text/plain; charset=utf-8";
            }
            res.writeHead(code, headers);
            res.end(data);
          },
          end() {
            res.writeHead(code, extraHeaders);
            res.end();
          },
        };
      },
    };
    const fakeReq = {
      method: req.method,
      headers: req.headers,
      query: Object.fromEntries(url.searchParams),
      body,
    };
    return Promise.resolve(handler(fakeReq, fakeRes)).catch(() => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "internal error" }));
    });
  };

  const siteRoutes = { "/api/login": "login", "/api/me": "me", "/api/profile": "profile", "/api/forum": "forum", "/api/thread": "thread" };

  const api = url.pathname;
  if (api === "/api/status") return wrap(statusHandler);
  if (api === "/api/register") return wrap(registerHandler);
  if (api === "/api/token") return wrap(tokenHandler);
  if (api === "/api/users") return wrap(usersHandler);
  if (api === "/api/bind") return wrap(bindHandler);
  if (api === "/api/sync") return wrap(syncHandler);
  if (api === "/api/skins") return wrap(skinsHandler);
  if (api === "/api/site") return wrap(siteHandler);
  if (siteRoutes[api]) {
    url.searchParams.set("action", siteRoutes[api]);
    return wrap(siteHandler);
  }

  // Статика + rewrites (как на Vercel).
  let pathname = url.pathname;
  if (REWRITES[pathname]) {
    pathname = REWRITES[pathname];
  } else {
    for (const p of PAGE_PATTERNS) {
      if (p.re.test(pathname)) {
        pathname = "/" + p.file;
        break;
      }
    }
  }

  const safe = path.normalize(pathname).replace(/^([/\\])+/, "");
  if (safe.includes("..")) {
    res.writeHead(400);
    return res.end("bad request");
  }
  return serveStatic(res, path.join(PUBLIC_DIR, safe));
});

server.listen(PORT, () => {
  console.log(`velocity-server listening on http://localhost:${PORT}`);
  if (process.env.ADMIN_TOKEN) {
    console.log("ADMIN_TOKEN set (admin endpoints enabled)");
  } else {
    console.warn("ADMIN_TOKEN not set - /api/register and /api/users are disabled");
  }
});
