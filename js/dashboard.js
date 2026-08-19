/* Sitting Pretty admin dashboard.
   Talks to window.SP from js/api.js:
   SP.request(path, opts), SP.login(email, password), SP.loginWithGoogle(),
   SP.requestCode(email, purpose), SP.verify(email, code), SP.setPassword(pw), SP.logout().
   Token lives in localStorage "sp_token" and is managed by the api client. */
(function () {
  "use strict";

  function $(id) { return document.getElementById(id); }

  // Google is only usable once it is configured on her Supabase project. Until
  // then, hide both buttons and the divider so nobody taps into a JSON error.
  //
  // Live, Google means One Tap: SP renders Google's own button into
  // #google-slot and sign-in happens in a small window over this page, with a
  // prompt that names sittingprettyrashae.com rather than the Supabase project
  // URL. The demo has no client id, so it keeps #google-btn and the old
  // full-page redirect. Everything below is markup wiring -- the sign-in
  // handling itself is shared, in wire().
  function hideGoogle() {
    var slot = $("google-slot"); if (slot) slot.hidden = true;
    var g = $("google-btn"); if (g) g.hidden = true;
    var line = document.querySelector("#login-view .or-line"); if (line) line.hidden = true;
    var sub = $("login-sub");
    if (sub) sub.textContent = "Sign in with your email and password. You stay signed in on this phone, so this is a one-time step.";
  }

  // Called once the login card is actually on screen. Google sizes its button
  // in pixels measured from the container, and a card that is still hidden
  // measures zero, so mounting on DOMContentLoaded produced a stub-width button
  // in a full-width card.
  var googleMounted = false;
  function mountGoogle() {
    if (googleMounted) return;
    if (!window.SP || !window.SP.google || !window.SP.google.configured()) return hideGoogle();
    var sub = $("login-sub");
    if (sub) sub.textContent = "Sign in with Google or your password. You stay signed in on this phone, so this is a one-time step.";
    if (!window.SP.google.inPage()) { googleMounted = true; $("google-btn").hidden = false; return; }
    var slot = $("google-slot");
    if (!slot) return hideGoogle();
    googleMounted = true;
    slot.hidden = false;
    window.SP.google.mount(slot, {
      onSuccess: function () {
        setLoginError("");
        resolveClient(null).then(admitOrRefuse).catch(function (err) {
          safeLogout();
          showLogin(errMsg(err));
        });
      },
      onError: function (err) { setLoginError(errMsg(err)); },
    }).catch(function () {
      // Google's script never arrived. Say nothing and show the email form: a
      // dead button she taps twice is worse than no button at all.
      googleMounted = false;
      hideGoogle();
    });
  }

  // True only on the page load that arrived from the sign-in email.
  var freshFromEmailLink = !!(window.SP && window.SP.returnedFromRedirect && window.SP.returnedFromRedirect());

  // ---------------- state ----------------
  var state = {
    client: null,
    bookings: [],
    blockedDays: [],
    slotAlertDays: {},   // day -> pending notify-me count
    clients: [],
    filter: "all",
    view: "home",
    calYear: new Date().getFullYear(),
    calMonth: new Date().getMonth(),
    selectedDay: null,
    loginEmail: "",
    codePurpose: "login",
    outboxAvailable: false,
    outboxMessages: [],
    // Her hours are data, not code: saved copy plus the copy she is editing.
    hours: null,
    hoursDraft: null,
    hoursLoaded: false,
    hoursSaving: false,
    // Flyer picked for the next broadcast: {dataUrl, name, bytes}.
    flyer: null,
    // Waitlist from the site popup + reviews awaiting her word.
    leads: [],
    reviews: [],
    // Her live menu (the services table), loaded when the Menu tab opens.
    services: []
  };

  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var MONTHS_FULL = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  var DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var DAYS_FULL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  // What her week looks like today, and what a brand new record starts as.
  var DEFAULT_HOURS = [
    { weekday: 0, closed: true, open: null, close: null },
    { weekday: 1, closed: false, open: "09:00", close: "20:00" },
    { weekday: 2, closed: false, open: "09:00", close: "20:00" },
    { weekday: 3, closed: false, open: "09:00", close: "20:00" },
    { weekday: 4, closed: false, open: "09:00", close: "20:00" },
    { weekday: 5, closed: false, open: "09:00", close: "20:00" },
    { weekday: 6, closed: false, open: "09:00", close: "18:00" }
  ];

  // A closed day still remembers times, so turning it back on is one tap.
  var FALLBACK_OPEN = "09:00";
  var FALLBACK_CLOSE = "18:00";

  var MAX_FLYER_BYTES = 5 * 1024 * 1024;      // the server's limit
  var FLYER_TARGET_BYTES = 4.6 * 1024 * 1024; // stay clear of it
  var FLYER_TYPES = ["image/jpeg", "image/png", "image/webp"];
  // Longest edge and quality, tried in order until the picture fits.
  var FLYER_STEPS = [[1600, 0.85], [1280, 0.78], [1000, 0.7], [800, 0.62]];

  var STATUS_META = {
    awaiting_deposit: { label: "Deposit due", chip: "chip-awaiting" },
    request: { label: "Request", chip: "chip-request" },
    confirmed: { label: "Confirmed", chip: "chip-confirmed" },
    completed: { label: "Completed", chip: "chip-completed" },
    canceled: { label: "Canceled", chip: "chip-canceled" }
  };

  var SUGGESTS = [
    {
      label: "Out sick",
      subject: "I need to move some appointments",
      message: "Hey love, I am feeling under the weather and may need to move some appointments. If yours is affected I will reach out to you directly to find a new time. Thank you for understanding."
    },
    {
      label: "Holiday hours",
      subject: "Holiday schedule update",
      message: "Hey love, my hours will be a little different around the holiday. If your appointment needs to move I will contact you directly. Want a seat before the holiday? Book early, spots go fast."
    },
    {
      label: "Openings this week",
      subject: "A few chairs open this week",
      message: "Hey love, a few openings came up this week. Book on the site or text me at (817) 704-8300 and I will get you in the chair."
    }
  ];

  // ---------------- helpers ----------------
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function escBr(s) { return esc(s).replace(/\n/g, "<br>"); }
  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  function ymd(d) { return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()); }
  function todayStr() { return ymd(new Date()); }
  function parseYmd(s) {
    var p = String(s).split("-");
    return new Date(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10));
  }
  function fmtDate(s) {
    var d = parseYmd(s);
    if (isNaN(d.getTime())) return String(s);
    return DAYS[d.getDay()] + ", " + MONTHS[d.getMonth()] + " " + d.getDate();
  }
  function fmtDateLong(s) {
    var d = parseYmd(s);
    if (isNaN(d.getTime())) return String(s);
    return DAYS[d.getDay()] + ", " + MONTHS_FULL[d.getMonth()] + " " + d.getDate() + ", " + d.getFullYear();
  }
  function fmtTime(t) {
    if (!t) return "";
    var p = String(t).split(":");
    var h = parseInt(p[0], 10);
    if (isNaN(h)) return String(t);
    var m = p[1] || "00";
    var ap = h >= 12 ? "PM" : "AM";
    var h12 = h % 12;
    if (h12 === 0) h12 = 12;
    return h12 + ":" + m + " " + ap;
  }
  function fmtPrice(p) {
    if (p == null || p === "") return "";
    if (typeof p === "number") return "$" + p;
    var s = String(p);
    return s.charAt(0) === "$" ? s : "$" + s;
  }
  function fmtDeposit(cents) {
    var d = Number(cents) / 100;
    if (isNaN(d)) return "";
    return "$" + (d % 1 === 0 ? d : d.toFixed(2));
  }
  function fmtTs(ts) {
    if (ts == null) return "";
    var d = new Date(ts);
    if (isNaN(d.getTime())) return "";
    try {
      return d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    } catch (e) {
      return d.toDateString();
    }
  }
  function telHref(phone) {
    var digits = String(phone == null ? "" : phone).replace(/[^0-9+]/g, "");
    return digits ? "tel:" + digits : "";
  }
  function errMsg(err) {
    if (err && err.message) return String(err.message);
    return "Something went wrong. Try again.";
  }
  function byDateTimeAsc(a, b) {
    var ka = (a.date || "") + " " + (a.time || "");
    var kb = (b.date || "") + " " + (b.time || "");
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  }
  function byDateTimeDesc(a, b) { return byDateTimeAsc(b, a); }

  // ---------------- api wrappers (interface from js/api.js) ----------------
  function api(path, opts) { return window.SP.request(path, opts); }
  function apiPost(path, body) {
    return window.SP.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body == null ? undefined : JSON.stringify(body)
    });
  }
  function apiPut(path, body) {
    return window.SP.request(path, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: body == null ? undefined : JSON.stringify(body)
    });
  }
  function apiDelete(path) { return window.SP.request(path, { method: "DELETE" }); }

  // ---------------- toast ----------------
  var toastTimer = null;
  function toast(msg) {
    var el = $("toast");
    el.textContent = msg;
    el.classList.add("show");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove("show"); }, 2600);
  }

  // ---------------- auth ----------------
  function getToken() {
    try { return localStorage.getItem("sp_token"); } catch (e) { return null; }
  }
  function safeLogout() {
    try {
      var r = window.SP.logout();
      if (r && typeof r.catch === "function") r.catch(function () {});
    } catch (e) { /* noop */ }
    try { localStorage.removeItem("sp_token"); } catch (e) { /* noop */ }
  }
  function setLoginError(msg) {
    var el = $("login-error");
    if (msg) { el.textContent = msg; el.hidden = false; }
    else { el.textContent = ""; el.hidden = true; }
  }
  // Login card has three panes: password (default), code fallback, and the
  // optional "set a password" step after a code sign in.
  function showPane(name) {
    $("pane-password").hidden = name !== "password";
    $("code-form").hidden = name !== "code";
    $("setpw-form").hidden = name !== "setpw";
  }
  function showLogin(errText) {
    $("splash").hidden = true;
    $("app-view").hidden = true;
    document.body.classList.remove("in-app");
    $("logout-btn").hidden = true;
    $("login-view").hidden = false;
    setLoginError(errText || "");
    showPane("password");
    mountGoogle();
  }
  // The demo's own /api/auth/* endpoints answer with {token, client}. Supabase
  // Auth answers with a session and nothing else, so on her live site the
  // client has to be fetched. Without this, every sign-in on the real site
  // looked at an undefined client and refused her from her own dashboard.
  function resolveClient(res) {
    if (res && res.client) return Promise.resolve(res);
    return api("/api/me");
  }

  // Only the owner account gets in; anyone else is signed back out.
  function admitOrRefuse(res) {
    if (res && res.client && res.client.is_admin) {
      state.client = res.client;
      // A magic-link arrival never passed through the code pane, so nobody
      // ever offered a password -- and without one, every future sign-in
      // costs another email. Invite (never require) exactly once, on the
      // arrival itself; "Not now" goes straight in.
      if (freshFromEmailLink && !res.client.has_password) {
        freshFromEmailLink = false;
        $("splash").hidden = true;
        $("app-view").hidden = true;
        $("login-view").hidden = false;
        setLoginError("");
        $("new-password").value = "";
        showPane("setpw");
        $("new-password").focus();
        return true;
      }
      enterApp();
      return true;
    }
    safeLogout();
    showLogin("That account does not have dashboard access. Sign in with the owner email.");
    return false;
  }
  function enterApp() {
    $("splash").hidden = true;
    $("login-view").hidden = true;
    $("app-view").hidden = false;
    $("logout-btn").hidden = false;
    document.body.classList.add("in-app");
    // Greet her by the name on her own account; a first name is plenty.
    var first = (state.client && state.client.name || "").trim().split(/\s+/)[0];
    $("hello-line").textContent = first ? "Hey, " + first + "." : "Hey, you.";
    switchView(state.view || "home");
    loadAll();
  }

  // ---------------- data loading ----------------
  function loadAll() {
    api("/api/admin/bookings").then(function (res) {
      state.bookings = (res && res.bookings) || [];
      renderBookings();
      updateBadge();
      if (state.view === "home") renderHome();
      if (state.view === "calendar") { renderCalendar(); renderDayPanel(); }
    }).catch(function (err) {
      toast("Could not load bookings. " + errMsg(err));
    });

    api("/api/admin/blocked-days").then(function (res) {
      state.blockedDays = (res && res.days) || [];
      if (state.view === "calendar") { renderCalendar(); renderDayPanel(); }
    }).catch(function () { /* calendar still works without it */ });

    // How many people tapped "notify me" on a taken time, per day. Painted
    // as a small badge on the calendar: a day people are waiting on is a day
    // that argues for opening more hours.
    api("/api/admin/slot-alerts").then(function (res) {
      var map = {};
      ((res && res.days) || []).forEach(function (d) { map[d.day] = d.count; });
      state.slotAlertDays = map;
      if (state.view === "home") renderHome();
      if (state.view === "calendar") { renderCalendar(); renderDayPanel(); }
    }).catch(function () { /* calendar still works without it */ });

    api("/api/admin/clients").then(function (res) {
      state.clients = (res && res.clients) || [];
      if (state.view === "clients") renderClients();
    }).catch(function () { /* loaded again when the tab opens */ });

    api("/api/admin/leads").then(function (res) {
      state.leads = (res && res.leads) || [];
      updateLeadsUi();
      if (state.view === "clients") renderLeads();
    }).catch(function () { /* loaded again when the tab opens */ });

    api("/api/admin/reviews").then(function (res) {
      state.reviews = (res && res.reviews) || [];
      updateReviewsBadge();
      if (state.view === "reviews") renderReviews();
      if (state.view === "home") renderHome();
    }).catch(function () { /* loaded again when the tab opens */ });

    // The calendar needs her closed days, so hours load with everything else.
    loadHours();
  }

  function refreshBookings() {
    return api("/api/admin/bookings").then(function (res) {
      state.bookings = (res && res.bookings) || [];
      renderAll();
    }).catch(function () { /* keep local copy */ });
  }

  function renderAll() {
    renderBookings();
    updateBadge();
    if (state.view === "home") renderHome();
    if (state.view === "calendar") { renderCalendar(); renderDayPanel(); }
    if (state.view === "clients") renderClients();
  }

  // ---------------- home (overview) ----------------
  // Every number on this screen is computed from her real book, in front of
  // her eyes -- nothing estimated, nothing invented. "Booked value" reads the
  // price column ("$150", "$50+"): the leading number is what it counts, and
  // a "+" price counts its floor.
  function priceNum(p) {
    var m = /\$?\s*(\d+(?:\.\d+)?)/.exec(String(p || ""));
    return m ? Number(m[1]) : 0;
  }
  function weekDates() {
    // Monday-start week around today, as YYYY-MM-DD strings.
    var t = new Date(); t.setHours(12, 0, 0, 0);
    var dow = (t.getDay() + 6) % 7; // Mon=0
    var days = [];
    for (var i = 0; i < 7; i++) {
      var d = new Date(t); d.setDate(t.getDate() - dow + i);
      days.push(ymd(d));
    }
    return days;
  }
  function money0(n) { return "$" + Math.round(n).toLocaleString("en-US"); }

  function renderHome() {
    var t = todayStr();
    var week = weekDates();
    var in7 = [];
    (function () {
      var d = new Date(); d.setHours(12, 0, 0, 0);
      for (var i = 0; i < 7; i++) { in7.push(ymd(d)); d.setDate(d.getDate() + 1); }
    })();

    var bs = state.bookings;
    var todays = bs.filter(function (b) { return b.date === t && isActive(b); });
    // "Coming up" starts TOMORROW: today's count sits in the card beside it,
    // and one appointment showing in both reads as two.
    var upcoming = bs.filter(function (b) { return b.date !== t && in7.indexOf(b.date) !== -1 && isActive(b); });
    var pending = bs.filter(function (b) { return needsAttention(b); });
    var weekBooked = 0;
    var perDay = {};
    week.forEach(function (d) { perDay[d] = 0; });
    bs.forEach(function (b) {
      if (week.indexOf(b.date) === -1) return;
      if (b.status !== "confirmed" && b.status !== "completed") return;
      var v = priceNum(b.price);
      perDay[b.date] += v; weekBooked += v;
    });
    var newClients = 0;
    (function () {
      var weekSet = {};
      week.forEach(function (d) { weekSet[d] = true; });
      state.clients.forEach(function (c) {
        if (c.created_at && weekSet[String(c.created_at).slice(0, 10)]) newClients++;
      });
    })();
    var waiting = 0;
    Object.keys(state.slotAlertDays || {}).forEach(function (d) { waiting += state.slotAlertDays[d]; });

    var IC_CAL = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><rect x="4" y="5" width="16" height="16" rx="2.5"/><path d="M8 3v4M16 3v4M4 10h16"/></svg>';
    var IC_CLK = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg>';
    var IC_DLR = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 6.5v11M15 8.8c-.5-1-1.6-1.5-3-1.5-1.7 0-3 .8-3 2.2 0 2.9 6 1.6 6 4.6 0 1.4-1.3 2.2-3 2.2-1.4 0-2.5-.5-3-1.5"/></svg>';
    var IC_PPL = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="9" cy="8.5" r="3.4"/><path d="M3.5 20c.6-3.4 2.8-5 5.5-5s4.9 1.6 5.5 5"/><circle cx="17" cy="9.5" r="2.6"/><path d="M15.8 15.2c2.5.1 4.2 1.6 4.7 4.6"/></svg>';
    var IC_BEL = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 10a6 6 0 0 1 12 0c0 4 1.5 5.5 1.5 5.5h-15S6 14 6 10Z"/><path d="M10 19a2.2 2.2 0 0 0 4 0"/></svg>';
    var IC_HRG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 3h10M7 21h10M8 3c0 7 8 7 8 11.5V21M16 3c0 7-8 7-8 11.5V21"/></svg>';

    function stat(icon, n, label, detail, go) {
      return '<div class="stat' + (go ? ' tappable" role="button" tabindex="0" data-go="' + go + '"' : '"') + '>' +
        '<span class="ic">' + icon + "</span>" +
        '<div class="n">' + n + "</div>" +
        '<div class="l">' + label + "</div>" +
        (detail ? '<div class="d">' + detail + "</div>" : "") +
        "</div>";
    }
    $("stat-grid").innerHTML =
      stat(IC_CAL, todays.length, "Today's appointments", esc(fmtDateLong(t).split(",")[0]), "calendar") +
      stat(IC_CLK, upcoming.length, "Coming up, next 7 days", "requests included", "bookings") +
      // "On the books", never "revenue": these are listed prices of confirmed
      // and completed appointments, not cash collected, and a "$50+" price
      // counts its floor.
      stat(IC_DLR, money0(weekBooked), "On the books this week", "listed prices, not cash collected", null) +
      stat(IC_PPL, newClients, "New clients this week", "", "clients") +
      stat(IC_BEL, pending.length, "Not locked in yet", pending.length ? "requests and unpaid deposits" : "", "bookings") +
      stat(IC_HRG, waiting, "Waiting for an opening", waiting ? "tap to see which days" : "", "calendar");

    // today's agenda
    var ag = todays.slice().sort(byDateTimeAsc).map(function (b) {
      return "<li><span class=\"at\">" + esc(fmtTime(b.time)) + "</span>" +
        "<span><span class=\"who\">" + esc(b.client_name || b.client_email || "Client") + "</span>" +
        " <span class=\"what\">" + esc(b.service_name || "") + "</span></span></li>";
    }).join("");
    $("home-agenda").innerHTML = ag;
    $("home-agenda-empty").hidden = !!ag;

    // week bars scale to the best day; a flat zero week draws flat stubs
    var max = 1;
    week.forEach(function (d) { if (perDay[d] > max) max = perDay[d]; });
    var DL = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    // Buttons, not divs: the number behind a bar has to be reachable by a
    // thumb and a screen reader, not only a mouse hover.
    $("week-bars").innerHTML = week.map(function (d, i) {
      var h = Math.round((perDay[d] / max) * 100);
      return '<button type="button" class="wb" data-day-label="' + esc(DL[i] + ": " + money0(perDay[d])) + '" aria-label="' + esc(DL[i] + ", " + money0(perDay[d]) + " on the books") + '">' +
        '<div class="bar' + (d === t ? " today" : "") + '" style="height:' + Math.max(3, h) + '%"></div>' +
        '<span class="dl" aria-hidden="true">' + DL[i] + "</span></button>";
    }).join("");
    var totalLine = "On the books this week: <b>" + money0(weekBooked) + "</b>";
    $("week-total").innerHTML = totalLine;
    $("week-bars").onclick = function (e) {
      var b = e.target.closest(".wb");
      $("week-total").innerHTML = b
        ? esc(b.getAttribute("data-day-label")) + " &middot; week " + money0(weekBooked)
        : totalLine;
    };

    // recent reviews (approved, newest first, top 3)
    var recent = state.reviews
      .filter(function (r) { return r.status === "approved"; })
      .slice()
      .sort(function (a, b2) { return String(b2.ts).localeCompare(String(a.ts)); })
      .slice(0, 3);
    $("home-reviews").innerHTML = recent.map(function (r) {
      var n = Math.max(1, Math.min(5, Number(r.rating) || 5));
      var stars = "★★★★★".slice(0, n);
      return '<div class="mini-review"><div class="rname">' + esc(r.name || "") +
        ' <span class="stars" aria-hidden="true">' + stars + "</span>" +
        '<span class="sr-only">rated ' + n + " out of 5</span></div>" +
        (r.body ? '<p class="rbody">' + esc(r.body) + "</p>" : "") + "</div>";
    }).join("");
    $("home-reviews-empty").hidden = recent.length > 0;
  }

  // ---------------- bookings view ----------------
  function needsAttention(b) { return b.status === "awaiting_deposit" || b.status === "request"; }
  function isActive(b) { return b.status === "awaiting_deposit" || b.status === "request" || b.status === "confirmed"; }

  // Badges live in three places now (sidebar, phone bar, More sheet), so
  // they are classes, not ids: every copy updates or the phone one lies.
  function paintBadges(cls, n, srText) {
    document.querySelectorAll("." + cls).forEach(function (el) {
      if (n > 0) {
        el.innerHTML = n + '<span class="sr-only"> ' + srText + "</span>";
        el.hidden = false;
      } else {
        el.hidden = true;
      }
    });
  }
  function updateBadge() {
    paintBadges("attention-badge", state.bookings.filter(needsAttention).length, "need attention");
  }

  function groupBookings(list) {
    var t = todayStr();
    var g = { today: [], upcoming: [], past: [] };
    list.forEach(function (b) {
      if (b.status === "canceled") g.past.push(b);
      else if (b.date === t) g.today.push(b);
      else if (b.date > t) g.upcoming.push(b);
      else g.past.push(b);
    });
    g.today.sort(byDateTimeAsc);
    g.upcoming.sort(byDateTimeAsc);
    g.past.sort(byDateTimeDesc);
    return g;
  }

  function applyFilter(list) {
    if (state.filter === "attention") return list.filter(needsAttention);
    if (state.filter === "confirmed") return list.filter(function (b) { return b.status === "confirmed"; });
    return list;
  }

  function actionsFor(b) {
    var acts = [];
    if (b.status === "request" || b.status === "awaiting_deposit") acts.push("confirm");
    if (isActive(b) && !b.paid_in_full) acts.push("markpaid");
    if (b.status === "confirmed" && b.date <= todayStr()) acts.push("complete");
    if (isActive(b)) acts.push("cancel");
    return acts;
  }

  function bookingCard(b) {
    var meta = STATUS_META[b.status] || { label: String(b.status || ""), chip: "chip-request" };
    var acts = actionsFor(b);
    var tel = telHref(b.client_phone);
    var id = esc(String(b.id));
    var html = '<li class="bcard' + (b.status === "canceled" ? " bcard-muted" : "") + '">';
    html += '<div class="bcard-top"><div class="bcard-when"><strong>' + esc(fmtTime(b.time)) + "</strong><span>" + esc(fmtDate(b.date)) + "</span></div>";
    html += '<span class="chip ' + meta.chip + '">' + esc(meta.label) + "</span></div>";
    html += '<div class="bcard-client">' + esc(b.client_name || b.client_email || "Client");
    if (tel) html += ' &middot; <a class="bcard-tel" href="' + esc(tel) + '">' + esc(b.client_phone) + "</a>";
    html += "</div>";
    html += '<div class="bcard-service"><span>' + esc(b.service_name || b.service_id || "") + '</span><span class="bcard-price">' + esc(fmtPrice(b.price));
    if (b.deposit_cents) html += '<em class="bcard-dep">' + esc(fmtDeposit(b.deposit_cents)) + " deposit</em>";
    html += "</span></div>";
    // Where this one stands on money, so she knows what to collect in the chair.
    if (b.status !== "canceled") {
      if (b.paid_in_full) {
        html += '<div class="bcard-money bcard-money-paid">Paid in full' + (b.paid_in_person ? " (in person)" : "") + "</div>";
      } else if (b.status === "confirmed" && b.balance_cents) {
        html += '<div class="bcard-money">Deposit paid. ' + esc(fmtDeposit(b.balance_cents)) + " due at the appointment</div>";
      } else if (b.status === "confirmed") {
        html += '<div class="bcard-money">Deposit paid. Balance settled in person</div>';
      }
    }
    if (b.notes) html += '<p class="bcard-notes">' + escBr(b.notes) + "</p>";
    if (acts.length) {
      html += '<div class="bcard-actions">';
      if (acts.indexOf("confirm") > -1) html += '<button class="btn btn-solid btn-sm" type="button" data-action="confirm" data-id="' + id + '">Confirm</button>';
      if (acts.indexOf("markpaid") > -1) html += '<button class="btn btn-ghost btn-sm" type="button" data-action="markpaid" data-id="' + id + '">Paid in person</button>';
      if (acts.indexOf("complete") > -1) html += '<button class="btn btn-ghost btn-sm" type="button" data-action="complete" data-id="' + id + '">Mark completed</button>';
      if (acts.indexOf("cancel") > -1) html += '<button class="btn btn-danger btn-sm" type="button" data-action="cancel" data-id="' + id + '">Cancel</button>';
      html += "</div>";
    }
    html += "</li>";
    return html;
  }

  function groupSection(title, list, emptyText) {
    var filtered = applyFilter(list);
    var html = '<section class="bgroup"><h2 class="script-eyebrow">' + esc(title) + ' <span class="gcount">' + filtered.length + "</span></h2>";
    if (!filtered.length) {
      html += '<p class="empty">' + esc(state.filter === "all" ? emptyText : "None with this filter.") + "</p>";
    } else {
      html += '<ul class="blist">' + filtered.map(bookingCard).join("") + "</ul>";
    }
    html += "</section>";
    return html;
  }

  function renderBookings() {
    var groups = groupBookings(state.bookings);
    $("bookings-list").innerHTML =
      groupSection("Today", groups.today, "No appointments today.") +
      groupSection("Upcoming", groups.upcoming, "Nothing on the books yet.") +
      groupSection("Past and canceled", groups.past, "Nothing here yet.");
  }

  function findBooking(id) {
    for (var i = 0; i < state.bookings.length; i++) {
      if (String(state.bookings[i].id) === String(id)) return state.bookings[i];
    }
    return null;
  }

  function replaceBooking(updated) {
    for (var i = 0; i < state.bookings.length; i++) {
      if (String(state.bookings[i].id) === String(updated.id)) {
        state.bookings[i] = updated;
        return;
      }
    }
    state.bookings.push(updated);
  }

  // She collected the rest in the chair: cash, Zelle, card, however she took it.
  function markPaidInPerson(btn, booking, amountCents) {
    btn.disabled = true;
    var body = amountCents ? { amount_cents: amountCents } : {};
    apiPost("/api/admin/bookings/" + encodeURIComponent(String(booking.id)) + "/mark-paid", body)
      .then(function (res) {
        if (res && res.booking) replaceBooking(res.booking);
        toast("Marked paid in full.");
        renderAll();
      })
      .catch(function (err) {
        btn.disabled = false;
        toast(errMsg(err));
      });
  }

  function setStatus(btn, booking, status, okMsg) {
    btn.disabled = true;
    apiPost("/api/admin/bookings/" + encodeURIComponent(String(booking.id)) + "/status", { status: status })
      .then(function (res) {
        if (res && res.booking) replaceBooking(res.booking);
        else booking.status = status;
        toast(okMsg);
        renderAll();
      })
      .catch(function (err) {
        btn.disabled = false;
        toast(errMsg(err));
      });
  }

  function onBookingAction(ev) {
    var btn = ev.target.closest ? ev.target.closest("button[data-action]") : null;
    if (!btn) return;
    var b = findBooking(btn.getAttribute("data-id"));
    if (!b) return;
    var action = btn.getAttribute("data-action");
    if (action === "confirm") {
      setStatus(btn, b, "confirmed", "Booking confirmed.");
    } else if (action === "markpaid") {
      // Her variable-price services have no number to settle, so ask for it.
      if (b.balance_cents) {
        if (!window.confirm("Mark " + (b.client_name || "this client") + " as paid in full? " +
            fmtDeposit(b.balance_cents) + " will be recorded as collected in person.")) return;
        markPaidInPerson(btn, b, 0);
      } else {
        var entered = window.prompt("How much did you collect for " + (b.service_name || "this appointment") + "? Enter dollars, for example 150", "");
        if (entered === null) return;
        var dollars = parseFloat(String(entered).replace(/[^0-9.]/g, ""));
        if (!(dollars > 0)) { toast("Enter the amount you collected."); return; }
        markPaidInPerson(btn, b, Math.round(dollars * 100));
      }
    } else if (action === "complete") {
      setStatus(btn, b, "completed", "Marked completed.");
    } else if (action === "cancel") {
      var who = b.client_name || "this client";
      var ok = window.confirm("Cancel " + who + "'s " + (b.service_name || "appointment") + " on " + fmtDate(b.date) + "? They will be sent a cancellation notice.");
      if (!ok) return;
      setStatus(btn, b, "canceled", "Canceled. The client has been notified.");
    }
  }

  // ---------------- calendar view ----------------
  function blockedMap() {
    var map = {};
    state.blockedDays.forEach(function (d) {
      if (d && d.date) map[d.date] = { reason: d.reason || "" };
    });
    return map;
  }

  function activeCountsByDate() {
    var map = {};
    state.bookings.forEach(function (b) {
      if (b.status === "canceled") return;
      map[b.date] = (map[b.date] || 0) + 1;
    });
    return map;
  }

  function renderCalendar() {
    var y = state.calYear, m = state.calMonth;
    $("cal-title").textContent = MONTHS_FULL[m] + " " + y;
    var firstDow = new Date(y, m, 1).getDay();
    var daysInMonth = new Date(y, m + 1, 0).getDate();
    var counts = activeCountsByDate();
    var blocked = blockedMap();
    var t = todayStr();
    var html = "";
    var i;
    for (i = 0; i < firstDow; i++) html += '<div class="cal-empty" aria-hidden="true"></div>';
    for (var day = 1; day <= daysInMonth; day++) {
      var dateStr = y + "-" + pad2(m + 1) + "-" + pad2(day);
      var dow = new Date(y, m, day).getDay();
      var n = counts[dateStr] || 0;
      var isBlocked = !!blocked[dateStr];
      // Closed days come from her hours record, so changing them changes this.
      // A closed day with appointments still on it must stay openable: those
      // were promised to a client before she closed the day, and hiding them
      // is how she would miss someone who is still expecting her.
      if (closedWeekday(dow) && !n) {
        html += '<div class="cal-day cal-closed"><span class="cal-num">' + day + '</span><span class="cal-closed-label">closed</span><span class="sr-only">' + esc(fmtDateLong(dateStr)) + ", closed</span></div>";
        continue;
      }
      var closedWithWork = closedWeekday(dow);
      var cls = "cal-day";
      if (isBlocked) cls += " cal-blocked";
      if (closedWithWork) cls += " cal-closed-kept";
      if (dateStr === t) cls += " cal-today";
      if (dateStr === state.selectedDay) cls += " cal-selected";
      var waiting = state.slotAlertDays[dateStr] || 0;
      var label = fmtDateLong(dateStr) + ", " +
        (n === 0 ? "no bookings" : n + (n === 1 ? " booking" : " bookings")) +
        (waiting ? ", " + waiting + " waiting for an opening" : "") +
        (closedWithWork ? ", day closed but still booked" : "") +
        (isBlocked ? ", blocked" : "");
      var dots = "";
      if (n > 0 && n <= 3) {
        dots = '<span class="cal-dots" aria-hidden="true">';
        for (i = 0; i < n; i++) dots += "<i></i>";
        dots += "</span>";
      } else if (n > 3) {
        dots = '<span class="cal-more" aria-hidden="true">' + n + "</span>";
      } else {
        dots = '<span class="cal-dots" aria-hidden="true"></span>';
      }
      var wait = waiting ? '<span class="cal-wait" aria-hidden="true">' + waiting + " waiting</span>" : "";
      html += '<button type="button" class="' + cls + '" data-date="' + dateStr + '" aria-label="' + esc(label) + '"><span class="cal-num" aria-hidden="true">' + day + "</span>" + dots + wait + "</button>";
    }
    $("cal-grid").innerHTML = html;
  }

  function renderDayPanel() {
    var panel = $("day-panel");
    var ds = state.selectedDay;
    if (!ds) { panel.hidden = true; return; }
    var blocked = blockedMap()[ds];
    var dayBookings = state.bookings.filter(function (b) { return b.date === ds; }).sort(byDateTimeAsc);
    var activeCount = dayBookings.filter(isActive).length;
    var html = "<h3>" + esc(fmtDateLong(ds)) + "</h3>";
    if (blocked) {
      html += '<p class="day-blocked-note">Blocked' + (blocked.reason ? ": " + esc(blocked.reason) : "") + "</p>";
    }
    if (!dayBookings.length) {
      html += '<p class="empty">No bookings this day.</p>';
    } else {
      html += '<ul class="day-list">';
      dayBookings.forEach(function (b) {
        var meta = STATUS_META[b.status] || { label: String(b.status || ""), chip: "chip-request" };
        html += '<li><span class="day-time">' + esc(fmtTime(b.time)) + '</span><span class="day-who">' +
          esc(b.client_name || b.client_email || "Client") + " &middot; " + esc(b.service_name || "") +
          '</span><span class="chip ' + meta.chip + '">' + esc(meta.label) + "</span></li>";
      });
      html += "</ul>";
    }
    html += '<div class="day-actions">';
    if (blocked) {
      html += '<button class="btn btn-ghost btn-sm" type="button" data-block="off">Unblock this day</button>';
    } else {
      html += '<button class="btn btn-danger btn-sm" type="button" data-block="on">Block this day</button>';
      if (activeCount > 0) {
        html += '<p class="day-hint">Blocking stops new bookings. Existing appointments stay unless you cancel them.</p>';
      }
    }
    html += "</div>";
    panel.innerHTML = html;
    panel.hidden = false;
  }

  function toggleBlock(dateStr) {
    var isBlocked = !!blockedMap()[dateStr];
    if (isBlocked) {
      apiDelete("/api/admin/blocked-days/" + encodeURIComponent(dateStr))
        .then(function (res) {
          state.blockedDays = (res && res.days) || [];
          toast("Unblocked " + fmtDate(dateStr) + ".");
          renderCalendar();
          renderDayPanel();
        })
        .catch(function (err) { toast(errMsg(err)); });
    } else {
      var reason = window.prompt("Reason for blocking this day (optional):", "");
      if (reason === null) return;
      var body = { date: dateStr };
      if (reason.trim()) body.reason = reason.trim();
      apiPost("/api/admin/blocked-days", body)
        .then(function (res) {
          state.blockedDays = (res && res.days) || [];
          toast("Blocked " + fmtDate(dateStr) + ". No one can book it.");
          renderCalendar();
          renderDayPanel();
        })
        .catch(function (err) { toast(errMsg(err)); });
    }
  }

  // ---------------- hours view ----------------
  // The record is the single source of truth (API.md "Hours"). The dashboard
  // edits a draft copy so nothing changes for her clients until she taps Save.
  function hhmm(v, fallback) {
    var s = String(v == null ? "" : v);
    return /^\d{2}:\d{2}/.test(s) ? s.slice(0, 5) : fallback;
  }

  function normalizeHours(days) {
    var out = [];
    for (var wd = 0; wd < 7; wd++) {
      var found = null;
      if (days && days.length) {
        for (var i = 0; i < days.length; i++) {
          if (days[i] && Number(days[i].weekday) === wd) { found = days[i]; break; }
        }
      }
      var base = found || DEFAULT_HOURS[wd];
      var dflt = DEFAULT_HOURS[wd];
      out.push({
        weekday: wd,
        closed: !!base.closed,
        // Closed days keep times in the box so turning one on is one tap.
        open: hhmm(base.open, hhmm(dflt.open, FALLBACK_OPEN)),
        close: hhmm(base.close, hhmm(dflt.close, FALLBACK_CLOSE))
      });
    }
    return out;
  }

  // Times on a closed day do not count, so they never make Save look enabled.
  function hoursKey(days) {
    return (days || []).map(function (d) {
      return d.weekday + (d.closed ? ":closed" : ":" + d.open + "-" + d.close);
    }).join("|");
  }

  function hoursChanged() {
    if (!state.hoursDraft || !state.hours) return false;
    return hoursKey(state.hoursDraft) !== hoursKey(state.hours);
  }

  function draftDay(wd) {
    var days = state.hoursDraft || [];
    for (var i = 0; i < days.length; i++) {
      if (days[i].weekday === Number(wd)) return days[i];
    }
    return null;
  }

  function closedWeekday(dow) {
    var days = state.hours;
    if (!days) return dow === 0;
    for (var i = 0; i < days.length; i++) {
      if (days[i].weekday === dow) return !!days[i].closed;
    }
    return false;
  }

  function setHoursError(msg) {
    var el = $("hours-error");
    if (msg) { el.textContent = msg; el.hidden = false; }
    else { el.textContent = ""; el.hidden = true; }
  }

  function clearHoursNotices() {
    setHoursError("");
    $("hours-saved").hidden = true;
    $("hours-affected").hidden = true;
    $("hours-affected").innerHTML = "";
  }

  function updateHoursButtons() {
    var changed = hoursChanged();
    // hoursLoaded false means we are showing placeholder hours, not hers.
    // Saving then would write a week she never set over her real one.
    var ready = state.hoursLoaded !== false;
    $("hours-save").disabled = state.hoursSaving || !changed || !ready;
    $("hours-cancel").disabled = state.hoursSaving || !changed;
  }

  function savedDay(wd) {
    var days = state.hours || [];
    for (var i = 0; i < days.length; i++) {
      if (days[i].weekday === Number(wd)) return days[i];
    }
    return null;
  }

  // A row counts as edited once its times differ from what is saved. That is
  // what brings the "use these times everywhere" shortcut into view.
  function rowEdited(d) {
    var saved = savedDay(d.weekday);
    if (!saved || d.closed || saved.closed) return false;
    return saved.open !== d.open || saved.close !== d.close;
  }

  function hoursRow(d) {
    var wd = d.weekday;
    var open = !d.closed;
    var html = '<div class="hrow' + (open ? "" : " hrow-off") + (rowEdited(d) ? " hrow-edited" : "") + '" data-row="' + wd + '">';
    html += '<div class="hrow-top"><span class="hrow-day">' + DAYS_FULL[wd] + "</span>";
    html += '<button class="hswitch" type="button" data-toggle="' + wd + '" aria-pressed="' + (open ? "true" : "false") + '">';
    html += '<span class="sr-only">' + DAYS_FULL[wd] + " </span>";
    html += '<span class="hswitch-text">' + (open ? "Open" : "Closed") + "</span>";
    html += '<span class="hswitch-track" aria-hidden="true"><span class="hswitch-thumb"></span></span>';
    html += "</button></div>";
    html += '<div class="hrow-times">';
    html += '<span class="htime"><label class="field-label" for="hopen-' + wd + '">Start</label>' +
      '<input id="hopen-' + wd + '" class="field field-time" type="time" step="1800" value="' + esc(d.open) +
      '" data-time="open" data-weekday="' + wd + '"></span>';
    html += '<span class="htime"><label class="field-label" for="hclose-' + wd + '">Finish</label>' +
      '<input id="hclose-' + wd + '" class="field field-time" type="time" step="1800" value="' + esc(d.close) +
      '" data-time="close" data-weekday="' + wd + '"></span>';
    html += "</div>";
    html += '<button class="hcopy" type="button" data-copy="' + wd + '">Use these times on my other open days</button>';
    html += "</div>";
    return html;
  }

  function renderHours() {
    if (!state.hoursDraft) state.hoursDraft = normalizeHours(state.hours);
    $("hours-rows").innerHTML = state.hoursDraft.map(hoursRow).join("");
    updateHoursButtons();
  }

  // Toggling updates that one row in place, so her finger stays where it was.
  function toggleHoursDay(wd) {
    var d = draftDay(wd);
    if (!d) return;
    d.closed = !d.closed;
    if (!d.closed) {
      d.open = hhmm(d.open, FALLBACK_OPEN);
      d.close = hhmm(d.close, FALLBACK_CLOSE);
    }
    var row = document.querySelector('.hrow[data-row="' + wd + '"]');
    if (row) {
      var btn = row.querySelector(".hswitch");
      var text = row.querySelector(".hswitch-text");
      if (d.closed) row.classList.add("hrow-off");
      else row.classList.remove("hrow-off");
      if (btn) btn.setAttribute("aria-pressed", d.closed ? "false" : "true");
      if (text) text.textContent = d.closed ? "Closed" : "Open";
      var oi = row.querySelector('input[data-time="open"]');
      var ci = row.querySelector('input[data-time="close"]');
      if (oi) oi.value = d.open;
      if (ci) ci.value = d.close;
    }
    clearHoursNotices();
    updateHoursButtons();
  }

  function copyHoursFrom(wd) {
    var src = draftDay(wd);
    if (!src || src.closed) return;
    var n = 0;
    state.hoursDraft.forEach(function (d) {
      if (d.weekday === src.weekday || d.closed) return;
      d.open = src.open;
      d.close = src.close;
      n++;
    });
    clearHoursNotices();
    renderHours();
    var back = document.querySelector('.hcopy[data-copy="' + wd + '"]');
    if (back) back.focus();
    if (n) toast("Copied your " + DAYS_FULL[wd] + " times to your other open days.");
    else toast("Turn another day on first, then you can copy these times to it.");
  }

  function hoursProblem() {
    var days = state.hoursDraft || [];
    var open = 0;
    for (var k = 0; k < days.length; k++) if (!days[k].closed) open++;
    if (!open) {
      return "That closes every day of the week, so nobody could book you at all. " +
        "Leave at least one day open, or use Block this day on your calendar for time off.";
    }
    for (var i = 0; i < days.length; i++) {
      var d = days[i];
      if (d.closed) continue;
      var name = DAYS_FULL[d.weekday];
      if (!/^\d{2}:\d{2}$/.test(d.open) || !/^\d{2}:\d{2}$/.test(d.close)) {
        return name + " needs a start time and a finish time.";
      }
      var om = d.open.slice(3), cm = d.close.slice(3);
      if ((om !== "00" && om !== "30") || (cm !== "00" && cm !== "30")) {
        return "Times need to land on the hour or the half hour, like 9:00 or 9:30. Check " + name + ".";
      }
      if (d.open >= d.close) {
        return "On " + name + " your finish time needs to be later than your start time.";
      }
    }
    return null;
  }

  function firstName(s) {
    var v = String(s == null ? "" : s).trim();
    if (!v) return "";
    return v.split(/\s+/)[0];
  }
  function smsHref(phone) {
    var digits = String(phone == null ? "" : phone).replace(/[^0-9+]/g, "");
    return digits ? "sms:" + digits : "";
  }

  // Appointments that now sit outside her hours. They are NOT canceled, and
  // the copy has to say so plainly: only she can move a client's time.
  function renderAffected(list) {
    var box = $("hours-affected");
    if (!list || !list.length) {
      box.innerHTML = "";
      box.hidden = true;
      return;
    }
    var n = list.length;
    var html = '<div class="affected-box"><h3>' + n +
      (n === 1 ? " appointment is" : " appointments are") + " already booked outside your new hours</h3>";
    html += '<p class="affected-note">Nothing was canceled. These appointments are still on the books, at the same time as before. These are still on your books. Text the client if you need to work something out.</p>';
    html += '<ul class="affected-list">';
    list.forEach(function (b) {
      var who = b.client_name || b.client_email || "Client";
      html += '<li><span class="affected-who"><strong>' + esc(who) + "</strong>";
      html += "<span>" + esc(b.service_name || b.service_id || "Appointment") + "</span>";
      html += "<span>" + esc(fmtDate(b.date) + " at " + fmtTime(b.time)) + "</span></span>";
      var sms = smsHref(b.client_phone);
      if (sms) {
        var fn = firstName(b.client_name);
        html += '<a class="btn btn-ghost btn-sm" href="' + esc(sms) + '">Text' + (fn ? " " + esc(fn) : "") + "</a>";
      }
      html += "</li>";
    });
    html += "</ul></div>";
    box.innerHTML = html;
    box.hidden = false;
  }

  function saveHours() {
    if (state.hoursSaving) return;
    var problem = hoursProblem();
    if (problem) { setHoursError(problem); return; }
    clearHoursNotices();
    var payload = state.hoursDraft.map(function (d) {
      return d.closed
        ? { weekday: d.weekday, closed: true }
        : { weekday: d.weekday, closed: false, open: d.open, close: d.close };
    });
    var btn = $("hours-save");
    state.hoursSaving = true;
    btn.textContent = "Saving";
    updateHoursButtons();
    apiPut("/api/admin/hours", { days: payload })
      .then(function (res) {
        state.hoursSaving = false;
        btn.textContent = "Save hours";
        state.hours = normalizeHours((res && res.days) || payload);
        state.hoursDraft = normalizeHours(state.hours);
        state.hoursLoaded = true;
        renderHours();
        $("hours-saved").textContent = "Saved. Your site and your booking times follow these hours now.";
        $("hours-saved").hidden = false;
        toast("Hours saved.");
        renderAffected((res && res.affected) || []);
        renderCalendar();
      })
      .catch(function (err) {
        state.hoursSaving = false;
        btn.textContent = "Save hours";
        updateHoursButtons();
        setHoursError(errMsg(err));
      });
  }

  function cancelHours() {
    state.hoursDraft = normalizeHours(state.hours);
    clearHoursNotices();
    renderHours();
    toast("Back to your saved hours.");
  }

  function loadHours() {
    return api("/api/admin/hours").then(function (res) {
      var fresh = normalizeHours(res && res.days);
      var keepDraft = state.hoursLoaded && hoursChanged();
      state.hours = fresh;
      state.hoursLoaded = true;
      if (!keepDraft) state.hoursDraft = normalizeHours(fresh);
      renderHours();
      renderCalendar();
    }).catch(function () {
      // Never pass the built-in defaults off as her saved hours. Saving is a
      // whole-week write, so if she edited one day on top of a fabricated week
      // she would overwrite her real schedule with hours she never set. Show
      // the defaults only as a clearly-labelled placeholder, and refuse to
      // save until we have actually read her hours back.
      state.hoursLoaded = false;
      if (!state.hours) {
        state.hoursDraft = normalizeHours(null);
        renderHours();
      }
      setHoursError(
        "We could not load your saved hours just now, so this is only a placeholder. " +
        "Saving is turned off until they load. Check your connection and tap Retry."
      );
    });
  }

  // ---------------- clients view ----------------
  function renderClients() {
    var q = $("client-search").value.trim().toLowerCase();
    var filtered = state.clients.filter(function (c) {
      if (!q) return true;
      var hay = ((c.name || "") + " " + (c.email || "") + " " + (c.phone || "")).toLowerCase();
      return hay.indexOf(q) > -1;
    });
    var countEl = $("clients-count");
    countEl.textContent = String(state.clients.length);
    countEl.hidden = state.clients.length === 0;
    var html = filtered.map(function (c) {
      var tel = telHref(c.phone);
      var count = typeof c.bookings_count === "number" ? c.bookings_count : 0;
      var last = c.last_booking && /^\d{4}-\d{2}-\d{2}/.test(String(c.last_booking))
        ? fmtDate(String(c.last_booking).slice(0, 10))
        : (c.last_booking ? String(c.last_booking) : "");
      var row = '<li class="client-row"><div>';
      row += '<span class="client-name">' + esc(c.name || c.email || "Client") + "</span>";
      row += '<p class="client-meta">' + esc(c.email || "");
      if (tel) row += (c.email ? " &middot; " : "") + '<a href="' + esc(tel) + '">' + esc(c.phone) + "</a>";
      row += "</p></div>";
      row += '<p class="client-stats"><strong>' + count + (count === 1 ? " booking" : " bookings") + "</strong>";
      row += last ? "Last visit " + esc(last) : "No visits yet";
      row += "</p></li>";
      return row;
    }).join("");
    $("clients-list").innerHTML = html;
    $("clients-empty").hidden = filtered.length > 0 || state.clients.length === 0;
    renderLeads();
  }

  // ---------------- menu editor ----------------
  function depositDollars(cents) {
    return cents == null ? "" : String(Math.round(cents / 100));
  }

  function renderMenu() {
    var list = $("menu-list");
    var countEl = $("menu-count");
    var visible = state.services.filter(function (r) { return r.active; });
    countEl.textContent = String(visible.length);
    countEl.hidden = visible.length === 0;
    $("menu-empty").hidden = state.services.length > 0;
    if (!state.services.length) { list.innerHTML = ""; return; }

    // Category dropdown for the add form. Keep whatever she had chosen
    // across re-renders, and end with a "New category" choice that reveals a
    // free-text box, so adding a brand-new section is still one form.
    var cats = [];
    state.services.forEach(function (r) { if (cats.indexOf(r.cat) === -1) cats.push(r.cat); });
    var sel = $("ma-cat");
    var had = sel.value;
    sel.innerHTML = cats.map(function (c) {
      return '<option value="' + esc(c) + '">' + esc(c) + "</option>";
    }).join("") + '<option value="__new__">+ New category…</option>';
    if (had && (cats.indexOf(had) !== -1 || had === "__new__")) sel.value = had;

    var rowHtml = function (r) {
      var row = '<div class="menu-row' + (r.active ? '' : ' is-hidden') + '" data-svc="' + esc(r.service_id) + '">';
      row += '<div class="mr-namecell"><span class="mr-name">' + esc(r.name) + "</span>";
      if (r.note) row += '<span class="mr-note">' + esc(r.note) + "</span>";
      row += "</div>";
      row += '<input class="field mr-price" value="' + esc(r.price) + '" aria-label="Price for ' + esc(r.name) + '">';
      row += '<input class="field mr-dur" type="number" min="15" max="720" step="15" value="' + esc(String(r.duration_min)) + '" aria-label="Minutes for ' + esc(r.name) + '">';
      row += '<input class="field mr-dep" type="number" min="1" step="1" value="' + esc(depositDollars(r.deposit_cents)) + '" placeholder="none" aria-label="Deposit dollars for ' + esc(r.name) + '">';
      row += '<button class="btn btn-solid btn-sm mr-save" type="button" disabled>Save</button>';
      row += r.active
        ? '<button class="btn btn-ghost btn-sm mr-toggle" type="button" data-active="false">Remove</button>'
        : '<button class="btn btn-solid btn-sm mr-toggle" type="button" data-active="true">Bring it back</button>';
      row += "</div>";
      return row;
    };

    var html = "";
    cats.forEach(function (cat) {
      var rows = state.services.filter(function (r) { return r.cat === cat; });
      var live = rows.filter(function (r) { return r.active; });
      var hidden = rows.filter(function (r) { return !r.active; });
      html += '<div class="menu-cat"><h3>' + esc(cat) + '<span class="gcount">' + live.length + "</span></h3>";
      html += live.map(rowHtml).join("");
      if (hidden.length) {
        html += '<details class="menu-hiddens"><summary>' + hidden.length +
          (hidden.length === 1 ? " removed style" : " removed styles") + "</summary>";
        html += hidden.map(rowHtml).join("");
        html += "</details>";
      }
      html += "</div>";
    });
    list.innerHTML = html;
  }

  function findServiceRowEl(target) { return target.closest(".menu-row"); }

  function saveServiceRow(rowEl, btn) {
    var id = rowEl.getAttribute("data-svc");
    var dep = rowEl.querySelector(".mr-dep").value.trim();
    var body = {
      price: rowEl.querySelector(".mr-price").value.trim(),
      duration_min: Number(rowEl.querySelector(".mr-dur").value),
      deposit_cents: dep === "" ? null : Math.round(Number(dep) * 100)
    };
    btn.disabled = true;
    window.SP.request("/api/admin/services/" + encodeURIComponent(id), { method: "PUT", body: body })
      .then(function (res) {
        var updated = res && res.service;
        state.services = state.services.map(function (r) {
          return r.service_id === id && updated ? updated : r;
        });
        renderMenu();
        toast("Saved. Your site shows the new details now.");
      })
      .catch(function (err) {
        btn.disabled = false;
        toast(errMsg(err));
      });
  }

  function toggleService(rowEl, btn) {
    var id = rowEl.getAttribute("data-svc");
    var active = btn.getAttribute("data-active") === "true";
    btn.disabled = true;
    apiPost("/api/admin/services/" + encodeURIComponent(id) + "/active", { active: active })
      .then(function (res) {
        var updated = res && res.service;
        state.services = state.services.map(function (r) {
          return r.service_id === id && updated ? updated : r;
        });
        renderMenu();
        toast(active ? "Back on your menu." : "Removed. Clients can no longer book it.");
      })
      .catch(function (err) {
        btn.disabled = false;
        toast(errMsg(err));
      });
  }

  function addMenuStyle() {
    var say = function (text, ok) {
      var el = $("ma-msg");
      el.textContent = text; el.hidden = !text;
    };
    var dep = $("ma-dep").value.trim();
    var catSel = $("ma-cat").value;
    var cat = catSel === "__new__" ? $("ma-cat-new").value.trim() : catSel.trim();
    if (!cat) { say("Name the new category first."); return; }
    var body = {
      cat: cat,
      name: $("ma-name").value.trim(),
      price: $("ma-price").value.trim(),
      duration_min: Number($("ma-dur").value),
      deposit_cents: dep === "" ? null : Math.round(Number(dep) * 100)
    };
    apiPost("/api/admin/services", body)
      .then(function (res) {
        if (res && res.service) state.services.push(res.service);
        // De-dup in case it was a revived hidden row rather than a new one.
        var seen = {};
        state.services = state.services.filter(function (r) {
          if (seen[r.service_id]) return false;
          seen[r.service_id] = true; return true;
        }).map(function (r) {
          return res && res.service && r.service_id === res.service.service_id ? res.service : r;
        });
        renderMenu();
        ["ma-name", "ma-price", "ma-dur", "ma-dep"].forEach(function (id) { $(id).value = ""; });
        say("");
        toast("Added. It is live on your site.");
      })
      .catch(function (err) { say(errMsg(err)); });
  }

  // ---------------- waitlist (leads) ----------------
  function updateLeadsUi() {
    var n = state.leads.length;
    var countEl = $("leads-count");
    countEl.textContent = String(n);
    countEl.hidden = n === 0;
    var label = $("bc-include-leads-label");
    if (label) {
      label.textContent = n > 0
        ? "Also send this to your waitlist (" + n + (n === 1 ? " person)" : " people)")
        : "Also send this to your waitlist";
    }
    // The checkbox is never disabled: the count is a courtesy, and if the
    // waitlist failed to load here the server still knows the real list. Her
    // tick always travels with the send.
  }

  function renderLeads() {
    updateLeadsUi();
    var html = state.leads.map(function (l) {
      var tel = telHref(l.phone);
      var when = l.ts ? fmtTs(l.ts) : "";
      var row = '<li class="client-row"><div>';
      row += '<span class="client-name">' + esc(l.name || l.email || "Lead") + "</span>";
      row += '<p class="client-meta">' + esc(l.email || "");
      if (tel) row += (l.email ? " &middot; " : "") + '<a href="' + esc(tel) + '">' + esc(l.phone) + "</a>";
      row += "</p></div>";
      row += '<div class="client-stats"><strong>Waitlist</strong>' + (when ? "Joined " + esc(when) : "");
      row += '<button class="btn btn-ghost btn-sm" type="button" data-lead-remove="' + esc(l.id) + '" style="display:block;margin-top:.4rem;margin-left:auto">Remove</button>';
      row += "</div></li>";
      return row;
    }).join("");
    $("leads-list").innerHTML = html;
    $("leads-empty").hidden = state.leads.length > 0;
  }

  // Someone asked off the list (the broadcast footer invites exactly that).
  function removeLead(btn, id) {
    btn.disabled = true;
    apiDelete("/api/admin/leads/" + encodeURIComponent(id))
      .then(function (res) {
        state.leads = (res && res.leads) || state.leads.filter(function (l) { return l.id !== id; });
        renderLeads();
        toast("Removed. They will not get your broadcasts.");
      })
      .catch(function (err) {
        btn.disabled = false;
        toast(errMsg(err));
      });
  }

  // ---------------- reviews view ----------------
  function updateReviewsBadge() {
    var n = state.reviews.filter(function (r) { return r.status === "pending"; }).length;
    paintBadges("reviews-badge", n, "reviews waiting for approval");
  }

  var REVIEW_STATUS_META = {
    pending: { label: "Waiting on you", chip: "chip-awaiting" },
    approved: { label: "On your site", chip: "chip-confirmed" },
    hidden: { label: "Hidden", chip: "chip-canceled" }
  };

  function renderReviews() {
    var countEl = $("reviews-count");
    countEl.textContent = String(state.reviews.length);
    countEl.hidden = state.reviews.length === 0;
    var stars = function (n) { return "★★★★★".slice(0, Math.max(1, Math.min(5, Number(n) || 1))); };
    var html = state.reviews.map(function (r) {
      var meta = REVIEW_STATUS_META[r.status] || REVIEW_STATUS_META.pending;
      var row = '<li class="review-row"><div class="rv-top">';
      row += '<span class="rv-stars" aria-label="' + esc(String(r.rating)) + ' out of 5 stars">' + stars(r.rating) + "</span>";
      row += '<span class="chip ' + meta.chip + '">' + meta.label + "</span></div>";
      row += '<p class="rv-body">' + escBr(r.body) + "</p>";
      row += '<p class="rv-who"><b>' + esc(r.name) + "</b>" + (r.service ? " &middot; " + esc(r.service) : "") + (r.ts ? " &middot; " + esc(fmtTs(r.ts)) : "") + (r.source === "styleseat" ? ' &middot; <strong>from StyleSeat</strong>' : "") + "</p>";
      row += '<div class="rv-actions">';
      if (r.status !== "approved") row += '<button class="btn btn-solid btn-sm" type="button" data-review="' + esc(r.id) + '" data-set="approved">Put it on the site</button>';
      if (r.status !== "hidden") row += '<button class="btn btn-ghost btn-sm" type="button" data-review="' + esc(r.id) + '" data-set="hidden">' + (r.status === "approved" ? "Take it down" : "Hide it") + "</button>";
      row += "</div></li>";
      return row;
    }).join("");
    $("reviews-list").innerHTML = html;
    $("reviews-empty").hidden = state.reviews.length > 0;
  }

  function setReviewStatus(btn, id, status) {
    btn.disabled = true;
    apiPost("/api/admin/reviews/" + encodeURIComponent(id) + "/status", { status: status })
      .then(function (res) {
        var updated = res && res.review;
        state.reviews = state.reviews.map(function (r) { return r.id === id && updated ? updated : r; });
        updateReviewsBadge();
        renderReviews();
        toast(status === "approved" ? "It's on your site." : "Hidden. Your site will not show it.");
      })
      .catch(function (err) {
        btn.disabled = false;
        toast(errMsg(err));
      });
  }

  // ---------------- broadcast view ----------------
  function renderSuggests() {
    var html = SUGGESTS.map(function (s, i) {
      return '<button class="suggest" type="button" data-suggest="' + i + '">' + esc(s.label) + "</button>";
    }).join("");
    $("suggest-chips").innerHTML = html;
  }

  // ---- flyer: a picture that rides along with the message ----
  function fmtBytes(n) {
    var v = Number(n) || 0;
    if (v < 1024) return v + " bytes";
    if (v < 1024 * 1024) return Math.round(v / 1024) + " KB";
    return (v / (1024 * 1024)).toFixed(1) + " MB";
  }

  function dataUrlBytes(dataUrl) {
    var s = String(dataUrl || "");
    var i = s.indexOf(",");
    if (i < 0) return 0;
    var b64 = s.slice(i + 1);
    var pad = 0;
    if (b64.charAt(b64.length - 1) === "=") pad++;
    if (b64.charAt(b64.length - 2) === "=") pad++;
    return Math.max(0, Math.floor(b64.length * 3 / 4) - pad);
  }

  function setFlyerError(msg) {
    var el = $("bc-flyer-error");
    if (msg) { el.textContent = msg; el.hidden = false; }
    else { el.textContent = ""; el.hidden = true; }
  }

  // Phone photos are far too big to email, so the picture is redrawn smaller
  // right here on her phone before it ever leaves it.
  function shrinkToDataUrl(img) {
    var w = img.naturalWidth || img.width;
    var h = img.naturalHeight || img.height;
    if (!w || !h) return null;
    for (var i = 0; i < FLYER_STEPS.length; i++) {
      var maxEdge = FLYER_STEPS[i][0];
      var quality = FLYER_STEPS[i][1];
      var scale = Math.min(1, maxEdge / Math.max(w, h));
      var cw = Math.max(1, Math.round(w * scale));
      var ch = Math.max(1, Math.round(h * scale));
      var canvas = document.createElement("canvas");
      canvas.width = cw;
      canvas.height = ch;
      var ctx = canvas.getContext ? canvas.getContext("2d") : null;
      if (!ctx) return null;
      // See-through corners in a PNG would turn black as a JPEG, so paint white.
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, cw, ch);
      ctx.drawImage(img, 0, 0, cw, ch);
      var url;
      try { url = canvas.toDataURL("image/jpeg", quality); } catch (e) { return null; }
      if (dataUrlBytes(url) <= FLYER_TARGET_BYTES && dataUrlBytes(url) <= MAX_FLYER_BYTES) return url;
    }
    return null;
  }

  function setFlyer(f) {
    state.flyer = f;
    $("bc-flyer-thumb").src = f.dataUrl;
    $("bc-flyer-name").textContent = f.name;
    $("bc-flyer-size").textContent = "Ready to send, about " + fmtBytes(f.bytes) + ".";
    $("bc-flyer-preview").hidden = false;
    $("bc-file-label").textContent = "Choose a different flyer";
    $("bc-result").hidden = true;
    updatePreview();
  }

  function clearFlyer() {
    state.flyer = null;
    $("bc-flyer-preview").hidden = true;
    $("bc-flyer-thumb").removeAttribute("src");
    $("bc-file-label").textContent = "Add a flyer";
    $("bc-image").value = "";
    setFlyerError("");
    updatePreview();
  }

  function handleFlyerFile(file) {
    if (!file) return;
    setFlyerError("");
    if (FLYER_TYPES.indexOf(file.type) === -1) {
      $("bc-image").value = "";
      setFlyerError("That file is not a picture I can send. Use a JPG, PNG, or WEBP.");
      return;
    }
    $("bc-flyer-busy").hidden = false;
    state.flyerBusy = true;
    var fail = function (msg) {
      state.flyerBusy = false;
      $("bc-flyer-busy").hidden = true;
      $("bc-image").value = "";
      setFlyerError(msg);
    };
    var reader = new FileReader();
    reader.onerror = function () { fail("I could not open that picture. Try another one."); };
    reader.onload = function () {
      var img = new Image();
      img.onload = function () {
        state.flyerBusy = false;
        $("bc-flyer-busy").hidden = true;
        var url = shrinkToDataUrl(img);
        if (!url) { fail("That picture is too big to send. Try a smaller one."); return; }
        setFlyer({ dataUrl: url, name: file.name || "Your flyer", bytes: dataUrlBytes(url) });
      };
      img.onerror = function () { fail("I could not open that picture. Try another one."); };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  }

  function updatePreview() {
    var s = $("bc-subject").value;
    var m = $("bc-message").value;
    var hasFlyer = !!state.flyer;
    $("pv-email-subject").textContent = s.trim() ? s : "Your subject will show here.";

    // Email: the flyer sits above the words, the way the client sees it.
    var emailFlyer = $("pv-email-flyer");
    if (hasFlyer) {
      emailFlyer.src = state.flyer.dataUrl;
      emailFlyer.hidden = false;
    } else {
      emailFlyer.hidden = true;
      emailFlyer.removeAttribute("src");
    }

    var emailBody = $("pv-email-body");
    if (m.trim()) { emailBody.innerHTML = escBr(m); emailBody.hidden = false; }
    else if (hasFlyer) { emailBody.hidden = true; }
    else { emailBody.textContent = "Your message will show here."; emailBody.hidden = false; }

    // Text messages cannot carry a picture, so a link to it goes along instead.
    var smsBody = $("pv-sms-body");
    if (m.trim()) { smsBody.innerHTML = escBr(m); smsBody.hidden = false; }
    else if (hasFlyer) { smsBody.hidden = true; }
    else { smsBody.textContent = "Your message will show here."; smsBody.hidden = false; }
    $("pv-sms-flyer").hidden = !hasFlyer;

    var countEl = $("pv-sms-count");
    if (m.trim()) {
      countEl.textContent = m.length + (m.length === 1 ? " character" : " characters") +
        (hasFlyer ? ", plus the flyer link" : "");
      countEl.hidden = false;
    } else if (hasFlyer) {
      countEl.textContent = "Just the flyer link";
      countEl.hidden = false;
    } else {
      countEl.hidden = true;
    }
  }

  function resetSendUI() {
    $("bc-confirm").hidden = true;
    $("bc-send").hidden = false;
    $("bc-send-yes").disabled = false;
    $("bc-send-no").disabled = false;
    $("bc-send-yes").textContent = "Yes, send it";
  }

  function sendBroadcast() {
    var subject = $("bc-subject").value.trim();
    var message = $("bc-message").value.trim();
    var flyer = state.flyer;
    var body = { subject: subject, message: message };
    if (flyer) body.image = flyer.dataUrl;
    if ($("bc-include-leads").checked) body.include_leads = true;
    $("bc-send-yes").disabled = true;
    $("bc-send-no").disabled = true;
    $("bc-send-yes").textContent = "Sending";
    apiPost("/api/admin/broadcast", body)
      .then(function (res) {
        var n = res && typeof res.sent === "number" ? res.sent : 0;
        var line = "Sent to " + n + (n === 1 ? " person." : " people.") +
          (body.include_leads ? " Your waitlist got it too." : "") +
          (flyer ? " Your flyer went with it." : "");
        $("bc-result").textContent = line;
        $("bc-result").hidden = false;
        toast(line);
        if (state.outboxAvailable) refreshOutbox();
        // Clear the composer. Leaving it loaded made it far too easy to tap
        // send twice and blast every client the same message again.
        $("bc-subject").value = "";
        $("bc-message").value = "";
        clearFlyer();
        updatePreview();
        resetSendUI();
      })
      .catch(function (err) {
        toast(errMsg(err));
        resetSendUI();
      });
  }

  // ---------------- outbox drawer ----------------
  function renderOutbox() {
    var list = $("outbox-list");
    if (!state.outboxMessages.length) {
      list.innerHTML = '<li class="ob-empty">Nothing sent yet. Messages the system sends will show up here.</li>';
      return;
    }
    list.innerHTML = state.outboxMessages.map(function (msg) {
      var chan = msg.channel === "sms" ? "sms" : "email";
      var html = '<li class="ob-item"><div class="ob-head">';
      html += '<span class="ob-chan ob-chan-' + chan + '">' + chan + "</span>";
      html += '<span class="ob-to">to ' + esc(msg.to || "") + "</span>";
      var ts = fmtTs(msg.ts);
      if (ts) html += '<span class="ob-ts">' + esc(ts) + "</span>";
      html += "</div>";
      if (msg.subject) html += '<p class="ob-subject">' + esc(msg.subject) + "</p>";
      html += '<p class="ob-body">' + escBr(msg.body == null ? "" : msg.body) + "</p></li>";
      return html;
    }).join("");
  }

  function setDemoHint(on) {
    var hint = $("demo-login-hint");
    if (hint) hint.hidden = !on;
  }

  function refreshOutbox() {
    return api("/api/_outbox").then(function (res) {
      state.outboxAvailable = true;
      state.outboxMessages = (res && res.messages) || [];
      $("outbox-fab").hidden = false;
      setDemoHint(true);
      renderOutbox();
    }).catch(function () {
      state.outboxAvailable = false;
      $("outbox-fab").hidden = true;
      setDemoHint(false);
    });
  }

  function openOutbox() {
    refreshOutbox();
    renderOutbox();
    $("outbox-scrim").hidden = false;
    $("outbox-drawer").hidden = false;
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        $("outbox-drawer").classList.add("open");
        $("outbox-scrim").classList.add("open");
      });
    });
    $("outbox-close").focus();
  }

  function closeOutbox() {
    $("outbox-drawer").classList.remove("open");
    $("outbox-scrim").classList.remove("open");
    setTimeout(function () {
      $("outbox-drawer").hidden = true;
      $("outbox-scrim").hidden = true;
    }, 260);
    $("outbox-fab").focus();
  }

  // ---------------- navigation ----------------
  // One list of views, three ways in: the sidebar (desktop), the bottom bar
  // (phone, first-class few), and the More sheet (phone, the rest).
  // Filled in by wire(); switchView runs before wiring only for the initial
  // render, when no sheet can be open.
  var closeMore = function () {};
  var openMore = function () {};
  function switchView(v) {
    if (v === "more") { openMore(); return; }
    closeMore();
    state.view = v;
    var OVERFLOW = ["clients", "menu", "reviews", "broadcast", "hours"];
    document.querySelectorAll(".tab, .bn-item").forEach(function (t) {
      var mine = t.getAttribute("data-view");
      // On the phone bar, views that live behind More light up More itself,
      // so the bar always shows where she is.
      var on = mine === v ||
        (mine === "more" && t.classList.contains("bn-item") && OVERFLOW.indexOf(v) !== -1);
      t.setAttribute("aria-pressed", String(on));
    });
    ["home", "bookings", "calendar", "hours", "menu", "clients", "reviews", "broadcast"].forEach(function (name) {
      var el = $("view-" + name);
      if (name === v) {
        if (el.hidden) {
          el.hidden = false;
          el.classList.remove("view-in");
          void el.offsetWidth;
          el.classList.add("view-in");
        }
      } else {
        el.hidden = true;
      }
    });
    if (v === "home") renderHome();
    if (v === "bookings") { renderBookings(); updateBadge(); }
    if (v === "calendar") { renderCalendar(); renderDayPanel(); }
    if (v === "hours") {
      renderHours();
      if (!state.hoursLoaded) loadHours();
    }
    if (v === "menu") {
      api("/api/admin/services").then(function (res) {
        state.services = (res && res.services) || [];
        renderMenu();
      }).catch(function (err) { toast("Could not load your menu. " + errMsg(err)); });
      renderMenu();
    }
    if (v === "clients") {
      if (!state.clients.length) {
        api("/api/admin/clients").then(function (res) {
          state.clients = (res && res.clients) || [];
          renderClients();
        }).catch(function (err) { toast("Could not load clients. " + errMsg(err)); });
      }
      if (!state.leads.length) {
        api("/api/admin/leads").then(function (res) {
          state.leads = (res && res.leads) || [];
          renderLeads();
        }).catch(function () { /* the block just stays empty */ });
      }
      renderClients();
    }
    if (v === "reviews") {
      api("/api/admin/reviews").then(function (res) {
        state.reviews = (res && res.reviews) || [];
        updateReviewsBadge();
        renderReviews();
      }).catch(function (err) { toast("Could not load reviews. " + errMsg(err)); });
      renderReviews();
    }
  }

  // ---------------- wiring ----------------
  function wire() {
    // ---- login: password, Google, code fallback ----
    $("setpw-hint").textContent = window.SP.PASSWORD_HINT;

    // ---- sheet/dialog plumbing, shared by More and Add Booking ----
    // Open: remember where focus was, move it in, lock the page scroll, and
    // put one entry on the history stack so the phone's back gesture closes
    // the sheet instead of leaving the dashboard. Close: undo all of it.
    var openSheet = null; // { modal, scrim, restoreFocus }
    function sheetOpen(modalId, scrimId, focusSel) {
      sheetClose(true);
      var modal = $(modalId), scrim = $(scrimId);
      modal.hidden = false; scrim.hidden = false;
      document.body.style.overflow = "hidden";
      openSheet = { modal: modal, scrim: scrim, restoreFocus: document.activeElement };
      var f = focusSel ? modal.querySelector(focusSel) : null;
      (f || modal.querySelector("button, [href], input, select, textarea") || modal).focus();
      try { history.pushState({ spSheet: true }, ""); } catch (e) {}
    }
    function sheetClose(skipHistory) {
      if (!openSheet) return;
      openSheet.modal.hidden = true;
      openSheet.scrim.hidden = true;
      document.body.style.overflow = "";
      var back = openSheet.restoreFocus;
      openSheet = null;
      if (!skipHistory && history.state && history.state.spSheet) {
        try { history.back(); } catch (e) {}
      }
      // After the history pop settles, or the browser steals focus back.
      if (back && back.focus) setTimeout(function () { back.focus(); }, 0);
    }
    window.addEventListener("popstate", function () { sheetClose(true); });
    document.addEventListener("keydown", function (e) {
      if (!openSheet) return;
      if (e.key === "Escape") { e.preventDefault(); sheetClose(); return; }
      if (e.key !== "Tab") return;
      // Keep Tab inside the open sheet: cheap trap, both directions.
      var els = openSheet.modal.querySelectorAll("button, [href], input:not([hidden]), select, textarea");
      if (!els.length) return;
      var first = els[0], last = els[els.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });

    // ---- shell navigation: sidebar, bottom bar, More sheet, data-go ----
    document.querySelectorAll(".bn-item").forEach(function (t) {
      t.addEventListener("click", function () { t.focus(); switchView(t.getAttribute("data-view")); });
    });
    openMore = function () { sheetOpen("more-sheet", "more-scrim"); };
    closeMore = function () { sheetClose(); };
    $("more-close").addEventListener("click", closeMore);
    $("more-scrim").addEventListener("click", closeMore);
    $("more-sheet").addEventListener("click", function (e) {
      var b = e.target.closest("[data-view]");
      if (b) switchView(b.getAttribute("data-view"));
    });
    // Anything with data-go is a shortcut into a view (stat cards, "View all").
    document.addEventListener("click", function (e) {
      var g = e.target.closest("[data-go]");
      if (g) switchView(g.getAttribute("data-go"));
    });
    document.addEventListener("keydown", function (e) {
      if (e.key !== "Enter" && e.key !== " ") return;
      var g = e.target.closest && e.target.closest(".stat[data-go]");
      if (g) { e.preventDefault(); switchView(g.getAttribute("data-go")); }
    });
    $("qa-site").addEventListener("click", function () { window.open("index.html", "_blank"); });

    // ---- add booking: walk-ins and phone calls, straight onto her book ----
    function abOpen() {
      sheetOpen("ab-modal", "ab-scrim", "#ab-service");
      $("ab-error").hidden = true;
      // The modal can sit open (or the tab sleep) across midnight; a date in
      // the past would sail through the picker and 409 at the server.
      var t = todayStr();
      $("ab-date").min = t;
      if (!$("ab-date").value || $("ab-date").value < t) { $("ab-date").value = t; }
      abFillServices();
    }
    function abClose() { sheetClose(); }
    ["ab-open-top", "ab-open-fab", "qa-add"].forEach(function (id) {
      // Focus the trigger first: a tap (and a JS click) never focuses a
      // button, so "restore focus on close" would land on <body>.
      $(id).addEventListener("click", function () { this.focus(); abOpen(); });
    });
    $("ab-close").addEventListener("click", abClose);
    $("ab-scrim").addEventListener("click", abClose);

    // The style list is her live menu, grouped the way her site shows it.
    // Loaded lazily the first time the modal opens, reused after.
    function abFillServices() {
      var sel = $("ab-service");
      var fill = function () {
        var had = sel.value;
        var byCat = {};
        state.services.forEach(function (r) {
          if (!r.active) return;
          (byCat[r.cat] = byCat[r.cat] || []).push(r);
        });
        sel.innerHTML = '<option value="">Pick a style</option>' + Object.keys(byCat).map(function (c) {
          return '<optgroup label="' + esc(c) + '">' + byCat[c].map(function (r) {
            return '<option value="' + esc(r.service_id) + '">' + esc(r.name) + " · " + esc(r.price) + "</option>";
          }).join("") + "</optgroup>";
        }).join("");
        if (had) sel.value = had;
        abLoadTimes();
      };
      if (state.services.length) return fill();
      api("/api/admin/services").then(function (res) {
        state.services = (res && res.services) || [];
        fill();
      }).catch(function (err) { abSay(errMsg(err)); });
    }

    function abSay(text) {
      var el = $("ab-error");
      el.textContent = text || "";
      el.hidden = !text;
    }

    // Times come from the same availability engine her clients book against,
    // so she can never be offered a slot that would double-book her chair.
    var abSeq = 0;
    function abLoadTimes() {
      var svc = $("ab-service").value;
      var date = $("ab-date").value;
      var sel = $("ab-time");
      if (!svc || !date) {
        sel.disabled = true;
        sel.innerHTML = '<option value="">' + (svc ? "Pick a day" : "Pick a style first") + "</option>";
        return;
      }
      var seq = ++abSeq;
      sel.disabled = true;
      sel.innerHTML = '<option value="">Checking your book…</option>';
      api("/api/availability?service_id=" + encodeURIComponent(svc) + "&date=" + encodeURIComponent(date))
        .then(function (av) {
          if (seq !== abSeq) return;
          if (av.closed || av.blocked || !av.slots.length) {
            var why = av.closed ? "You are closed that day." : av.blocked ? "You blocked that day." : "No open times left that day.";
            sel.innerHTML = '<option value="">' + why.replace(/\.$/, "") + "</option>";
            abSay(why + " Pick another day.");
            return;
          }
          abSay("");
          var had = sel.value;
          sel.innerHTML = '<option value="">Pick a time</option>' + av.slots.map(function (t) {
            return '<option value="' + esc(t) + '">' + esc(fmtTime(t)) + "</option>";
          }).join("");
          if (had && av.slots.indexOf(had) !== -1) sel.value = had;
          sel.disabled = false;
        })
        .catch(function (err) {
          if (seq !== abSeq) return;
          sel.innerHTML = '<option value="">Could not load times</option>';
          abSay(errMsg(err));
        });
    }
    $("ab-service").addEventListener("change", abLoadTimes);
    $("ab-date").addEventListener("change", abLoadTimes);

    $("ab-form").addEventListener("submit", function (ev) {
      ev.preventDefault();
      var email = $("ab-email").value.trim().toLowerCase();
      var svc = $("ab-service").value;
      var date = $("ab-date").value;
      var time = $("ab-time").value;
      if (!svc) return abSay("Pick a style.");
      if (!date) return abSay("Pick a day.");
      if (!time) return abSay("Pick a time.");
      if (!window.SP.emailLooksOk(email)) return abSay("Enter the client's email address.");
      var btn = $("ab-submit");
      btn.disabled = true;
      abSay("");
      apiPost("/api/admin/bookings", {
        email: email,
        name: $("ab-name").value.trim(),
        phone: $("ab-phone").value.trim(),
        service_id: svc,
        date: date,
        time: time,
        notes: $("ab-notes").value.trim(),
      }).then(function (res) {
        btn.disabled = false;
        if (res && res.booking) replaceBooking(res.booking);
        abClose();
        ["ab-email", "ab-name", "ab-phone", "ab-notes", "ab-time"].forEach(function (id) { $(id).value = ""; });
        toast("On the book. " + (res && res.booking ? fmtDateLong(res.booking.date) + " at " + fmtTime(res.booking.time) : ""));
        refreshBookings();
      }).catch(function (err) {
        btn.disabled = false;
        abSay(errMsg(err));
        // The slot may have just been taken; show her what is still open.
        if (err && err.status === 409) abLoadTimes();
      });
    });

    // "+ New category…" swaps in a text box; picking a real one hides it.
    $("ma-cat").addEventListener("change", function () {
      var fresh = this.value === "__new__";
      $("ma-cat-new").hidden = !fresh;
      if (fresh) $("ma-cat-new").focus();
    });

    document.querySelectorAll(".pw-toggle").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var input = $(btn.getAttribute("data-pw"));
        if (!input) return;
        var show = input.type === "password";
        input.type = show ? "text" : "password";
        btn.textContent = show ? "Hide" : "Show";
        btn.setAttribute("aria-pressed", show ? "true" : "false");
        btn.setAttribute("aria-label", show ? "Hide password" : "Show password");
        input.focus();
      });
    });

    // Demo only: the live site renders Google's own button into #google-slot.
    $("google-btn").addEventListener("click", function () {
      setLoginError("");
      window.SP.loginWithGoogle();
    });

    // Send a code and swap to the code pane. purpose: "login" | "reset".
    function sendCode(email, purpose, note) {
      if (!window.SP.emailLooksOk(email)) {
        setLoginError("That email does not look right. Check it and try again.");
        return;
      }
      setLoginError("");
      state.loginEmail = email;
      state.codePurpose = purpose;
      window.SP.requestCode(email, purpose).then(function () {
        showPane("code");
        // Live, the free-tier email carries a sign-in LINK (the code cannot be
        // shown in it until custom SMTP exists); the demo emails a real code.
        // Say what actually arrives.
        var onLive = !!(window.SP_CONFIG && window.SP_CONFIG.supabaseUrl);
        $("code-sent-line").textContent = note || (onLive
          ? "Check " + email + " and tap the sign-in link inside. It brings you right back here."
          : "We sent a 6-digit code to " + email + ".");
        $("login-code").value = "";
        $("login-code").focus();
        refreshOutbox();
      }).catch(function (err) {
        setLoginError(errMsg(err));
      });
    }

    $("password-form").addEventListener("submit", function (ev) {
      ev.preventDefault();
      var email = $("login-email").value.trim();
      var pw = $("login-password").value;
      if (!window.SP.emailLooksOk(email)) return setLoginError("That email does not look right. Check it and try again.");
      if (!pw) return setLoginError("Enter your password, or use the code option below.");
      var btn = $("password-submit");
      btn.disabled = true;
      setLoginError("");
      window.SP.login(email, pw).then(resolveClient).then(function (res) {
        btn.disabled = false;
        state.loginEmail = email;
        admitOrRefuse(res);
      }).catch(function (err) {
        btn.disabled = false;
        if (err && err.needsPasswordSetup) {
          sendCode(email, "reset", "This account was made before we had passwords, so we emailed you a code this once. After that you can set one.");
          return;
        }
        setLoginError(errMsg(err));
      });
    });

    $("forgot-btn").addEventListener("click", function () {
      sendCode($("login-email").value.trim(), "reset", (!!(window.SP_CONFIG && window.SP_CONFIG.supabaseUrl))
        ? "Check your email and tap the sign-in link. Once you are back here, you can set a new password."
        : "We emailed you a 6-digit code. Enter it and you can set a new password.");
    });

    $("code-instead-btn").addEventListener("click", function () {
      sendCode($("login-email").value.trim(), "login", null);
    });

    $("code-form").addEventListener("submit", function (ev) {
      ev.preventDefault();
      var code = $("login-code").value.trim();
      if (!/^[0-9]{6,8}$/.test(code)) return setLoginError("Enter the code from your email, or just tap the link in it.");
      var btn = $("code-submit");
      btn.disabled = true;
      setLoginError("");
      window.SP.verify(state.loginEmail, code).then(resolveClient).then(function (res) {
        btn.disabled = false;
        var client = res && res.client;
        if (!client || !client.is_admin) {
          safeLogout();
          showLogin("That account does not have dashboard access. Sign in with the owner email.");
          return;
        }
        state.client = client;
        // Invite, never require: a password makes the next visit one tap.
        if (state.codePurpose === "reset" || !client.has_password) {
          $("new-password").value = "";
          showPane("setpw");
          $("new-password").focus();
          return;
        }
        enterApp();
      }).catch(function (err) {
        btn.disabled = false;
        setLoginError(errMsg(err));
      });
    });

    $("change-email-btn").addEventListener("click", function () {
      setLoginError("");
      showPane("password");
      $("login-email").focus();
    });

    $("setpw-form").addEventListener("submit", function (ev) {
      ev.preventDefault();
      var pw = $("new-password").value;
      var bad = window.SP.passwordProblem(pw);
      if (bad) return setLoginError(bad);
      var btn = $("setpw-submit");
      btn.disabled = true;
      setLoginError("");
      window.SP.setPassword(pw).then(function (res) {
        btn.disabled = false;
        if (res && res.client) state.client = res.client;
        enterApp();
      }).catch(function (err) {
        btn.disabled = false;
        setLoginError(errMsg(err));
      });
    });

    $("setpw-skip").addEventListener("click", function () {
      setLoginError("");
      enterApp();
    });

    $("logout-btn").addEventListener("click", function () {
      safeLogout();
      state.client = null;
      showLogin();
    });

    // tabs and filters
    document.querySelectorAll(".tab").forEach(function (t) {
      t.addEventListener("click", function () { switchView(t.getAttribute("data-view")); });
    });
    document.querySelectorAll(".pill").forEach(function (p) {
      p.addEventListener("click", function () {
        state.filter = p.getAttribute("data-filter");
        document.querySelectorAll(".pill").forEach(function (q) {
          q.setAttribute("aria-pressed", String(q === p));
        });
        renderBookings();
      });
    });

    // bookings actions
    $("bookings-list").addEventListener("click", onBookingAction);

    // calendar
    $("cal-prev").addEventListener("click", function () {
      state.calMonth--;
      if (state.calMonth < 0) { state.calMonth = 11; state.calYear--; }
      renderCalendar();
    });
    $("cal-next").addEventListener("click", function () {
      state.calMonth++;
      if (state.calMonth > 11) { state.calMonth = 0; state.calYear++; }
      renderCalendar();
    });
    $("cal-grid").addEventListener("click", function (ev) {
      var btn = ev.target.closest ? ev.target.closest("button[data-date]") : null;
      if (!btn) return;
      state.selectedDay = btn.getAttribute("data-date");
      renderCalendar();
      renderDayPanel();
    });
    $("day-panel").addEventListener("click", function (ev) {
      var btn = ev.target.closest ? ev.target.closest("button[data-block]") : null;
      if (!btn || !state.selectedDay) return;
      toggleBlock(state.selectedDay);
    });

    // hours and days
    renderHours();
    $("hours-rows").addEventListener("click", function (ev) {
      var t = ev.target.closest ? ev.target.closest("button[data-toggle], button[data-copy]") : null;
      if (!t) return;
      if (t.hasAttribute("data-toggle")) toggleHoursDay(t.getAttribute("data-toggle"));
      else copyHoursFrom(t.getAttribute("data-copy"));
    });
    function onHoursTime(ev) {
      var input = ev.target;
      if (!input || !input.getAttribute || !input.getAttribute("data-time")) return;
      var d = draftDay(input.getAttribute("data-weekday"));
      if (!d) return;
      d[input.getAttribute("data-time")] = input.value;
      var row = document.querySelector('.hrow[data-row="' + d.weekday + '"]');
      if (row) {
        if (rowEdited(d)) row.classList.add("hrow-edited");
        else row.classList.remove("hrow-edited");
      }
      clearHoursNotices();
      updateHoursButtons();
    }
    $("hours-rows").addEventListener("input", onHoursTime);
    $("hours-rows").addEventListener("change", onHoursTime);
    $("hours-save").addEventListener("click", saveHours);
    $("hours-cancel").addEventListener("click", cancelHours);

    // clients
    $("client-search").addEventListener("input", renderClients);

    // broadcast
    renderSuggests();
    $("suggest-chips").addEventListener("click", function (ev) {
      var btn = ev.target.closest ? ev.target.closest("button[data-suggest]") : null;
      if (!btn) return;
      var s = SUGGESTS[parseInt(btn.getAttribute("data-suggest"), 10)];
      if (!s) return;
      $("bc-subject").value = s.subject;
      $("bc-message").value = s.message;
      $("bc-result").hidden = true;
      updatePreview();
      $("bc-message").focus();
    });
    $("bc-subject").addEventListener("input", updatePreview);
    $("bc-message").addEventListener("input", updatePreview);
    $("bc-image").addEventListener("change", function (ev) {
      var files = ev.target.files;
      handleFlyerFile(files && files[0]);
    });
    $("bc-flyer-remove").addEventListener("click", function () {
      clearFlyer();
      $("bc-image").focus();
      toast("Flyer removed.");
    });
    $("bc-send").addEventListener("click", function () {
      var subject = $("bc-subject").value.trim();
      var message = $("bc-message").value.trim();
      if (state.flyerBusy) {
        toast("Your flyer is still loading. Give it a second, then send.");
        return;
      }
      if (!subject) {
        toast("Add a subject so your clients know what it is about.");
        $("bc-subject").focus();
        return;
      }
      // A flyer on its own is a real message, so words are not required.
      if (!message && !state.flyer) {
        toast("Write a message or add a flyer first.");
        $("bc-message").focus();
        return;
      }
      var audience = $("bc-include-leads").checked
        ? "every client plus your waitlist"
        : "every client";
      $("bc-confirm-line").textContent = state.flyer
        ? "This goes to " + audience + ", with your flyer."
        : "This goes to " + audience + ".";
      $("bc-result").hidden = true;
      $("bc-send").hidden = true;
      $("bc-confirm").hidden = false;
      $("bc-send-yes").focus();
    });
    $("bc-send-no").addEventListener("click", function () {
      resetSendUI();
      $("bc-send").focus();
    });
    $("bc-send-yes").addEventListener("click", sendBroadcast);

    // Approve / hide reviews, delegated so re-renders never lose the handler.
    $("reviews-list").addEventListener("click", function (e) {
      var btn = e.target.closest("[data-review]");
      if (!btn || btn.disabled) return;
      setReviewStatus(btn, btn.getAttribute("data-review"), btn.getAttribute("data-set"));
    });

    // Remove a lead from the waitlist, delegated for the same reason.
    $("leads-list").addEventListener("click", function (e) {
      var btn = e.target.closest("[data-lead-remove]");
      if (!btn || btn.disabled) return;
      removeLead(btn, btn.getAttribute("data-lead-remove"));
    });

    // Menu editor: save / remove / restore, and the save button lights up
    // the moment any field in its row changes.
    $("menu-list").addEventListener("input", function (e) {
      var rowEl = findServiceRowEl(e.target);
      if (rowEl) rowEl.querySelector(".mr-save").disabled = false;
    });
    $("menu-list").addEventListener("click", function (e) {
      var save = e.target.closest(".mr-save");
      if (save && !save.disabled) return saveServiceRow(findServiceRowEl(save), save);
      var tog = e.target.closest(".mr-toggle");
      if (tog && !tog.disabled) return toggleService(findServiceRowEl(tog), tog);
    });
    $("menu-add").addEventListener("submit", function (e) {
      e.preventDefault();
      addMenuStyle();
    });

    // outbox drawer. It claims role=dialog aria-modal=true, so keep keyboard
    // focus inside it while it is open and close on Escape.
    $("outbox-fab").addEventListener("click", openOutbox);
    $("outbox-close").addEventListener("click", closeOutbox);
    $("outbox-scrim").addEventListener("click", closeOutbox);
    document.addEventListener("keydown", function (ev) {
      var drawer = $("outbox-drawer");
      if (drawer.hidden) return;
      if (ev.key === "Escape") { ev.preventDefault(); closeOutbox(); return; }
      if (ev.key !== "Tab") return;
      var focusables = drawer.querySelectorAll(
        "button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])"
      );
      if (!focusables.length) return;
      var first = focusables[0];
      var last = focusables[focusables.length - 1];
      var active = document.activeElement;
      if (!drawer.contains(active)) {
        ev.preventDefault();
        first.focus();
      } else if (ev.shiftKey && active === first) {
        ev.preventDefault();
        last.focus();
      } else if (!ev.shiftKey && active === last) {
        ev.preventDefault();
        first.focus();
      }
    });
  }

  // ---------------- boot ----------------
  function init() {
    if (!window.SP || typeof window.SP.request !== "function") {
      var splash = $("splash");
      splash.hidden = false;
      splash.innerHTML = "<p>The connection to the booking system failed to load. Refresh the page to try again.</p>";
      return;
    }
    wire();
    refreshOutbox();
    if (!getToken()) {
      showLogin();
      return;
    }
    // The session is long lived, so a return visit on her phone lands straight
    // in the dashboard with no sign-in step at all.
    api("/api/me").then(function (res) {
      admitOrRefuse(res);
    }).catch(function () {
      showLogin();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
