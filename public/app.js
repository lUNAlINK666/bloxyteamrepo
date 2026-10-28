/* HyperFox Chat — общий клиентский скрипт: сессия, шапка, хелперы. */
(function () {
  "use strict";

  const TOKEN_KEY = "hfc_token";
  const USER_KEY = "hfc_user";
  const THEME_KEY = "hfc_theme";

  // ---- Тема оформления: system | dark | light ---------------------------------
  function systemTheme() {
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }
  function themePref() {
    return localStorage.getItem(THEME_KEY) || "system";
  }
  function effectiveTheme() {
    const pref = themePref();
    return pref === "system" ? systemTheme() : pref;
  }
  function applyTheme() {
    const eff = effectiveTheme();
    document.documentElement.setAttribute("data-theme", eff);
    const icon = eff === "dark" ? "/favicon-white.png" : "/favicon-black.png";
    const fav = document.getElementById("favicon");
    if (fav) fav.href = icon;
    document.querySelectorAll(".nav-logo-icon").forEach((el) => {
      el.src = icon;
    });
    return eff;
  }
  function setThemePref(pref) {
    localStorage.setItem(THEME_KEY, pref);
    applyTheme();
  }

  const NS = {
    theme: {
      pref: themePref,
      effective: effectiveTheme,
      apply: applyTheme,
      set: setThemePref,
    },
    token() {
      return localStorage.getItem(TOKEN_KEY) || "";
    },
    savedUser() {
      try {
        return JSON.parse(localStorage.getItem(USER_KEY) || "null");
      } catch (e) {
        return null;
      }
    },
    setSession(data) {
      if (data && data.token) localStorage.setItem(TOKEN_KEY, data.token);
      if (data && data.username) {
        localStorage.setItem(
          USER_KEY,
          JSON.stringify({ username: data.username, uid: data.uid })
        );
      }
    },
    clearSession() {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
    },
    authHeaders(extra) {
      const headers = Object.assign({ "Content-Type": "application/json" }, extra || {});
      const token = NS.token();
      if (token) headers.Authorization = "Bearer " + token;
      return headers;
    },
    async api(path, options) {
      const opts = Object.assign({ credentials: "same-origin" }, options || {});
      if (opts.body && typeof opts.body !== "string") {
        opts.headers = NS.authHeaders(opts.headers);
        opts.body = JSON.stringify(opts.body);
      } else {
        opts.headers = NS.authHeaders(opts.headers);
      }
      const resp = await fetch(path, opts);
      let data = null;
      try {
        data = await resp.json();
      } catch (e) {
        data = null;
      }
      return { ok: resp.ok, status: resp.status, data };
    },
    async me() {
      const { data } = await NS.api("/api/site?action=me", { method: "GET" });
      if (data && data.authenticated) {
        if (data.token) localStorage.setItem(TOKEN_KEY, data.token);
        localStorage.setItem(
          USER_KEY,
          JSON.stringify({ username: data.username, uid: data.uid, canInvite: !!data.canInvite, canManage: !!data.canManage })
        );
        return data;
      }
      return null;
    },
    async logout() {
      NS.clearSession();
      try {
        await fetch("/api/site?action=me", { method: "POST", credentials: "same-origin" });
      } catch (e) {}
    },
    // Пускает дальше только авторизованных. Гостя отправляет на страницу входа.
    async requireAuth() {
      const me = await NS.me();
      if (!me) {
        const back = encodeURIComponent(location.pathname + location.search);
        location.replace("/profile?next=" + back);
        return null;
      }
      return me;
    },
    fmtDate(ms) {
      if (!ms) return "—";
      return new Date(Number(ms)).toLocaleString("ru-RU", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    },
    fmtAgo(ms) {
      if (!ms) return "—";
      const diff = Date.now() - Number(ms);
      const min = Math.floor(diff / 60000);
      if (min < 1) return "только что";
      if (min < 60) return min + " мин назад";
      const hours = Math.floor(min / 60);
      if (hours < 24) return hours + " ч назад";
      const days = Math.floor(hours / 24);
      if (days < 30) return days + " дн назад";
      return NS.fmtDate(ms);
    },
    escape(str) {
      return String(str == null ? "" : str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    },
    // Возвращает HTML ссылки на профиль (своя или чужая по uid).
    profileLink(username, uid, cls) {
      const target = uid ? "/u/" + encodeURIComponent(uid) : "/profile";
      return (
        '<a class="' +
        (cls || "ulink") +
        '" href="' +
        target +
        '">' +
        NS.escape(username) +
        "</a>"
      );
    },
    // URL картинки-аватара. bust=true — принудительно без кэша (после загрузки).
    avatarUrl(uid, bust) {
      if (!uid) return "";
      let url = "/api/site?action=avatar&uid=" + encodeURIComponent(uid);
      if (bust) url += "&t=" + Date.now();
      return url;
    },
    // Блок аватара: буква-заглушка + картинка поверх (при 404 картинка скрывается).
    avatarHTML(username, uid, cls) {
      const letter = NS.escape(String(username || "?").charAt(0).toUpperCase());
      const img = uid
        ? '<img class="avatar-img" alt="" src="' +
          NS.avatarUrl(uid) +
          '" onload="var l=this.parentNode.querySelector(\'.avatar-letter\');if(l){l.style.display=\'none\';}" onerror="var l=this.parentNode.querySelector(\'.avatar-letter\');if(l){l.style.display=\'flex\';}this.style.display=\'none\'" />'
        : "";
      return (
        '<div class="' +
        (cls || "avatar") +
        '" data-avatar="1"><span class="avatar-letter">' +
        letter +
        "</span>" +
        img +
        "</div>"
      );
    },
    // Принимает File, обрезает в квадрат 256×256 и отдаёт data-URL.
    async processAvatarFile(file) {
      if (!file || !/^image\//.test(file.type)) {
        throw new Error("not an image");
      }
      const url = URL.createObjectURL(file);
      const img = await new Promise((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error("cannot read image"));
        el.src = url;
      });
      const size = 256;
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");
      const scale = Math.max(size / img.width, size / img.height);
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      ctx.drawImage(img, Math.round((size - w) / 2), Math.round((size - h) / 2), w, h);
      URL.revokeObjectURL(url);
      let dataUrl = canvas.toDataURL("image/webp", 0.85);
      if (dataUrl.indexOf("data:image/webp") !== 0) {
        dataUrl = canvas.toDataURL("image/png");
      }
      return dataUrl;
    },
    // Загружает аватар (для текущего залогиненного пользователя).
    async setAvatar(file) {
      const dataUrl = await NS.processAvatarFile(file);
      return NS.api("/api/site?action=avatar", { method: "POST", body: { dataUrl } });
    },
    // Обновляет аватар в шапке (после смены). bust — сбросить кэш.
    refreshNavAvatar(bust) {
      const user = NS.savedUser();
      if (!user || !user.uid) return;
      const img = document.querySelector(".nav-avatar .avatar-img");
      if (!img) return;
      img.style.display = "";
      img.src = NS.avatarUrl(user.uid, bust);
    },
  };

  // Рендер шапки. active: 'home' | 'forum' | 'buy' | 'profile'.
  function renderNav(active) {
    const nav = document.querySelector("[data-nav]");
    if (!nav) return;
    const user = NS.savedUser();

    // Центр: только приватные разделы (у гостя пусто).
    const uidStr = String(user && user.uid || "");
    const isSpecial = uidStr === "1" || uidStr === "2";
    const canInvite = user && (isSpecial || user.canInvite === true);
    const canManage = user && (isSpecial || user.canManage === true);
    const links = user
      ? '<a href="/forum"' + (active === "forum" ? ' class="active"' : "") + ">Форум</a>" +
        (canInvite ? '<a href="/invites"' + (active === "invites" ? ' class="active"' : "") + ">Инвайты</a>" : "") +
        (canManage ? '<a href="/admin"' + (active === "admin" ? ' class="active"' : "") + ">Управление</a>" : "")
      : "";

    // Право: ник с выпадающим меню (Профиль/Выйти) или вход для гостя.
    const uidMatch = location.pathname.match(/^\/u\/([^/]+)/);
    const isOwnUid = !!(user && uidMatch && decodeURIComponent(uidMatch[1]) === String(user.uid));
    const profileActive = !!(user && (active === "profile" || isOwnUid));

    const right = user
      ? '<div class="nav-user-menu">' +
        '<a class="nav-user' +
        (profileActive ? " active" : "") +
        '" href="/u/' +
        encodeURIComponent(user.uid || "") +
        '">' +
        '<span class="nav-user-name">' +
        NS.escape(user.username) +
        "</span>" +
        NS.avatarHTML(user.username, user.uid, "nav-avatar") +
        "</a>" +
        '<div class="nav-dropdown">' +
        '<a href="/profile">Профиль</a>' +
        ((String(user.uid) === "1" || String(user.uid) === "2" || user.canInvite === true) ? '<a href="/invites">Инвайты</a>' : '') +
        ((String(user.uid) === "1" || String(user.uid) === "2" || user.canManage === true) ? '<a href="/admin">Управление</a>' : '') +
        '<a href="javascript:void(0)" data-settings>Настройки</a>' +
        '<a href="javascript:void(0)" data-logout>Выйти</a>' +
        "</div>" +
        "</div>"
      : '<a href="/profile"' +
        (active === "profile" ? ' class="active"' : "") +
        ">Войти</a>" +
        '<a href="/register" class="nav-cta">Регистрация</a>';

    const logoSrc = effectiveTheme() === "dark" ? "/favicon-white.png" : "/favicon-black.png";
    nav.innerHTML =
      '<div class="brand">' +
      '<img class="nav-logo-icon" alt="" src="' +
      logoSrc +
      '" />' +
      '<a class="logo' +
      (active === "home" ? " active" : "") +
      '" href="/">HyperFox Chat</a>' +
      "</div>" +
      '<div class="nav-links">' +
      links +
      "</div>" +
      '<div class="nav-right">' +
      right +
      "</div>";

    const logout = nav.querySelector("[data-logout]");
    if (logout) {
      logout.addEventListener("click", async () => {
        await NS.logout();
        location.href = "/";
      });
    }
    const settings = nav.querySelector("[data-settings]");
    if (settings) {
      settings.addEventListener("click", () => NS.openSettings());
    }
  }

  // ---- Настройки: модальное окно с вкладкой «Визуальное» ----------------------
  function ensureSettingsModal() {
    if (document.getElementById("ns-settings")) return;
    const el = document.createElement("div");
    el.id = "ns-settings";
    el.className = "modal-overlay";
    el.innerHTML =
      '<div class="modal" role="dialog" aria-modal="true">' +
      '<div class="modal-head"><h3>Настройки</h3>' +
      '<button class="modal-close" type="button" data-close>&times;</button></div>' +
      '<div class="modal-body">' +
      '<div class="tabs settings-tabs">' +
      '<button class="tab active" type="button" data-stab="visual">Визуальное</button>' +
      "</div>" +
      '<div class="setting-row">' +
      '<div class="label">Тема оформления</div>' +
      '<div class="seg" data-theme-seg>' +
      '<button type="button" data-theme-opt="system">Как в системе</button>' +
      '<button type="button" data-theme-opt="dark">Тёмная</button>' +
      '<button type="button" data-theme-opt="light">Светлая</button>' +
      "</div></div>" +
      "</div></div>";
    document.body.appendChild(el);

    const seg = el.querySelector("[data-theme-seg]");
    const syncSeg = () => {
      const pref = themePref();
      seg.querySelectorAll("[data-theme-opt]").forEach((b) =>
        b.classList.toggle("active", b.getAttribute("data-theme-opt") === pref)
      );
    };
    seg.querySelectorAll("[data-theme-opt]").forEach((b) => {
      b.addEventListener("click", () => {
        setThemePref(b.getAttribute("data-theme-opt"));
        syncSeg();
      });
    });
    const close = () => el.classList.remove("open");
    el.querySelector("[data-close]").addEventListener("click", close);
    el.addEventListener("click", (e) => {
      if (e.target === el) close();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") close();
    });
    el._open = () => {
      syncSeg();
      el.classList.add("open");
    };
  }

  NS.openSettings = function () {
    ensureSettingsModal();
    const el = document.getElementById("ns-settings");
    if (el && el._open) el._open();
  };

  // Системная тема изменилась — обновляем, если выбран режим «как в системе».
  if (window.matchMedia) {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      if (themePref() === "system") applyTheme();
    };
    if (mq.addEventListener) mq.addEventListener("change", onChange);
    else if (mq.addListener) mq.addListener(onChange);
  }

  // Применяем тему сразу (сначала — чтобы не мигало при загрузке страницы).
  applyTheme();

  NS.renderNav = renderNav;
  window.NS = NS;
})();
// Registration fixed - 1793086669
