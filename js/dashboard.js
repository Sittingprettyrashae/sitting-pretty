/* Sitting Pretty admin dashboard.
   Talks to window.SP from js/api.js:
   SP.request(path, opts), SP.login(email, password), SP.loginWithGoogle(),
   SP.requestCode(email, purpose), SP.verify(email, code), SP.setPassword(pw), SP.logout().
   Token lives in localStorage "sp_token" and is managed by the api client. */
(function () {
  "use strict";

  function $(id) { return document.getElementById(id); }

  // ---------------- state ----------------
  var state = {
    client: null,
    bookings: [],
    blockedDays: [],
    clients: [],
    filter: "all",
    view: "bookings",
    calYear: new Date().getFullYear(),
    calMonth: new Date().getMonth(),
    selectedDay: null,
    loginEmail: "",
    codePurpose: "login",
    outboxAvailable: false,
    outboxMessages: []
  };

  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var MONTHS_FULL = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  var DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

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
    $("logout-btn").hidden = true;
    $("login-view").hidden = false;
    setLoginError(errText || "");
    showPane("password");
  }
  // Only the owner account gets in; anyone else is signed back out.
  function admitOrRefuse(res) {
    if (res && res.client && res.client.is_admin) {
      state.client = res.client;
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
    loadAll();
  }

  // ---------------- data loading ----------------
  function loadAll() {
    api("/api/admin/bookings").then(function (res) {
      state.bookings = (res && res.bookings) || [];
      renderBookings();
      updateBadge();
      if (state.view === "calendar") { renderCalendar(); renderDayPanel(); }
    }).catch(function (err) {
      toast("Could not load bookings. " + errMsg(err));
    });

    api("/api/admin/blocked-days").then(function (res) {
      state.blockedDays = (res && res.days) || [];
      if (state.view === "calendar") { renderCalendar(); renderDayPanel(); }
    }).catch(function () { /* calendar still works without it */ });

    api("/api/admin/clients").then(function (res) {
      state.clients = (res && res.clients) || [];
      if (state.view === "clients") renderClients();
    }).catch(function () { /* loaded again when the tab opens */ });
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
    if (state.view === "calendar") { renderCalendar(); renderDayPanel(); }
    if (state.view === "clients") renderClients();
  }

  // ---------------- bookings view ----------------
  function needsAttention(b) { return b.status === "awaiting_deposit" || b.status === "request"; }
  function isActive(b) { return b.status === "awaiting_deposit" || b.status === "request" || b.status === "confirmed"; }

  function updateBadge() {
    var n = state.bookings.filter(needsAttention).length;
    var el = $("attention-badge");
    if (n > 0) {
      el.innerHTML = n + '<span class="sr-only"> need attention</span>';
      el.hidden = false;
    } else {
      el.hidden = true;
    }
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
    if (b.notes) html += '<p class="bcard-notes">' + escBr(b.notes) + "</p>";
    if (acts.length) {
      html += '<div class="bcard-actions">';
      if (acts.indexOf("confirm") > -1) html += '<button class="btn btn-solid btn-sm" type="button" data-action="confirm" data-id="' + id + '">Confirm</button>';
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
      if (dow === 0) {
        html += '<div class="cal-day cal-closed"><span class="cal-num">' + day + '</span><span class="cal-closed-label">closed</span><span class="sr-only">' + esc(fmtDateLong(dateStr)) + ", closed</span></div>";
        continue;
      }
      var cls = "cal-day";
      if (isBlocked) cls += " cal-blocked";
      if (dateStr === t) cls += " cal-today";
      if (dateStr === state.selectedDay) cls += " cal-selected";
      var label = fmtDateLong(dateStr) + ", " +
        (n === 0 ? "no bookings" : n + (n === 1 ? " booking" : " bookings")) +
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
      html += '<button type="button" class="' + cls + '" data-date="' + dateStr + '" aria-label="' + esc(label) + '"><span class="cal-num" aria-hidden="true">' + day + "</span>" + dots + "</button>";
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
  }

  // ---------------- broadcast view ----------------
  function renderSuggests() {
    var html = SUGGESTS.map(function (s, i) {
      return '<button class="suggest" type="button" data-suggest="' + i + '">' + esc(s.label) + "</button>";
    }).join("");
    $("suggest-chips").innerHTML = html;
  }

  function updatePreview() {
    var s = $("bc-subject").value;
    var m = $("bc-message").value;
    $("pv-email-subject").textContent = s.trim() ? s : "Your subject will show here.";
    $("pv-email-body").innerHTML = m.trim() ? escBr(m) : "Your message will show here.";
    $("pv-sms-body").innerHTML = m.trim() ? escBr(m) : "Your message will show here.";
    var countEl = $("pv-sms-count");
    if (m.trim()) {
      countEl.textContent = m.length + (m.length === 1 ? " character" : " characters");
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
    $("bc-send-yes").disabled = true;
    $("bc-send-no").disabled = true;
    $("bc-send-yes").textContent = "Sending";
    apiPost("/api/admin/broadcast", { subject: subject, message: message })
      .then(function (res) {
        var n = res && typeof res.sent === "number" ? res.sent : 0;
        var line = "Sent to " + n + (n === 1 ? " client." : " clients.");
        $("bc-result").textContent = line;
        $("bc-result").hidden = false;
        toast(line);
        if (state.outboxAvailable) refreshOutbox();
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

  // ---------------- tabs ----------------
  function switchView(v) {
    state.view = v;
    var tabs = document.querySelectorAll(".tab");
    tabs.forEach(function (t) {
      t.setAttribute("aria-pressed", String(t.getAttribute("data-view") === v));
    });
    ["bookings", "calendar", "clients", "broadcast"].forEach(function (name) {
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
    if (v === "bookings") { renderBookings(); updateBadge(); }
    if (v === "calendar") { renderCalendar(); renderDayPanel(); }
    if (v === "clients") {
      if (!state.clients.length) {
        api("/api/admin/clients").then(function (res) {
          state.clients = (res && res.clients) || [];
          renderClients();
        }).catch(function (err) { toast("Could not load clients. " + errMsg(err)); });
      }
      renderClients();
    }
  }

  // ---------------- wiring ----------------
  function wire() {
    // ---- login: password, Google, code fallback ----
    $("setpw-hint").textContent = window.SP.PASSWORD_HINT;

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
        $("code-sent-line").textContent = note || ("We sent a 6-digit code to " + email + ".");
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
      window.SP.login(email, pw).then(function (res) {
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
      sendCode($("login-email").value.trim(), "reset", "We emailed you a 6-digit code. Enter it and you can set a new password.");
    });

    $("code-instead-btn").addEventListener("click", function () {
      sendCode($("login-email").value.trim(), "login", null);
    });

    $("code-form").addEventListener("submit", function (ev) {
      ev.preventDefault();
      var code = $("login-code").value.trim();
      if (code.length !== 6) return setLoginError("Enter the 6-digit code we emailed you.");
      var btn = $("code-submit");
      btn.disabled = true;
      setLoginError("");
      window.SP.verify(state.loginEmail, code).then(function (res) {
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
    $("bc-send").addEventListener("click", function () {
      if (!$("bc-subject").value.trim() || !$("bc-message").value.trim()) {
        toast("Add a subject and a message first.");
        return;
      }
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
