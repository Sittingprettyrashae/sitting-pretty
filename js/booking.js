// Sitting Pretty — booking sheet + services accordion + my-bookings.
// API-first (server/server.mjs locally, Supabase in prod). If no API is
// reachable (plain static hosting), everything falls back to text-to-book.
(() => {
  const PHONE = "+18177048300";
  const smsFor = (n) => `sms:${PHONE}?body=${encodeURIComponent("Hi Ebony! I'd like to book: " + n)}`;
  const $ = (s, r) => (r || document).querySelector(s);
  const el = (html) => { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; };
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

  const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const parseDuration = (d) => {
    if (!d) return 60;
    let m = 0; const h = d.match(/(\d+)\s*hr/); const mm = d.match(/(\d+)\s*min/);
    if (h) m += parseInt(h[1], 10) * 60; if (mm) m += parseInt(mm[1], 10);
    return m || 60;
  };
  const parseDeposit = (price, note) => {
    const dep = (note || "").match(/\$(\d+)\s*deposit/i);
    if (dep) return parseInt(dep[1], 10) * 100;
    if (/paid in full|pay in full|full payment/i.test(note || "")) {
      const p = (price || "").match(/\d+/); if (p) return parseInt(p[0], 10) * 100;
    }
    return null;
  };
  const fmtTime = (t) => {
    const [H, M] = t.split(":").map(Number);
    const ap = H >= 12 ? "PM" : "AM"; const h12 = ((H + 11) % 12) + 1;
    return `${h12}:${String(M).padStart(2, "0")} ${ap}`;
  };
  const fmtDate = (iso) => {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  };
  const money = (cents) => "$" + (cents / 100).toFixed(cents % 100 ? 2 : 0);

  // The server computes availability in America/Chicago, so the date strip has
  // to start on Ebony's "today", not the visitor's device-local one.
  const chicagoToday = () => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit"
    }).formatToParts(new Date());
    const v = (t) => Number(parts.find(p => p.type === t).value);
    return Date.UTC(v("year"), v("month") - 1, v("day"));
  };

  let catalog = null;      // [{cat, items:[{service_id,name,price,duration_min,deposit_cents,note}]}]
  let demoMode = false;
  let offline = false;
  let me = null;           // {client, bookings} when logged in

  // ---------- catalog ----------
  function localCatalog() {
    if (typeof SERVICES === "undefined") return [];
    return SERVICES.map(g => ({
      cat: g.cat,
      items: g.items.map(([name, price, dur, note]) => ({
        service_id: slugify(g.cat + "--" + name),
        name, price, note,
        duration_min: parseDuration(dur),
        deposit_cents: parseDeposit(price, note),
        duration_label: dur,
      })),
    }));
  }

  async function loadCatalog() {
    try {
      const data = await SP.request("/api/services");
      catalog = data.categories.map(g => ({ ...g, items: g.items.map(i => ({ ...i, duration_label: i.duration_label || humanDur(i.duration_min) })) }));
    } catch (e) {
      offline = true;
      catalog = localCatalog();
    }
  }
  const humanDur = (m) => m >= 60 ? (`${Math.floor(m/60)} hr` + (m % 60 ? ` ${m%60} min` : "")) : `${m} min`;
  const findService = (id) => { for (const g of catalog) for (const i of g.items) if (i.service_id === id) return { ...i, cat: g.cat }; return null; };

  // ---------- accordion ----------
  function buildAccordion() {
    const acc = $("#servicesAcc");
    if (!acc || !catalog.length) return;
    catalog.forEach((group, gi) => {
      const item = el(`
        <div class="acc-item">
          <button class="acc-btn" aria-expanded="false" aria-controls="panel-${gi}">
            <span>${esc(group.cat)}</span>
            <span class="count">${group.items.length}</span>
            <svg class="chev" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 2v12M2 8h12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
          </button>
          <div class="acc-panel" id="panel-${gi}"><div class="acc-inner">
            ${group.items.map(i => `
              <div class="svc">
                <div><span class="nm">${esc(i.name)}</span><span class="meta">${esc([i.duration_label, i.note].filter(Boolean).join(" · "))}</span></div>
                <span class="dots"></span>
                <span class="pr">${esc(i.price)}</span>
                ${offline
                  ? `<a class="bk" href="${smsFor(i.name)}">Text to book</a>`
                  : `<button type="button" class="bk" data-book-svc="${i.service_id}">Book</button>`}
              </div>`).join("")}
          </div></div>
        </div>`);
      acc.appendChild(item);
    });
    acc.querySelectorAll(".acc-panel").forEach(panel => {
      panel.addEventListener("transitionend", e => {
        if (e.propertyName === "max-height" && panel.parentElement.classList.contains("open")) panel.style.maxHeight = "none";
      });
    });
    acc.addEventListener("click", e => {
      const bk = e.target.closest("[data-book-svc]");
      if (bk) { openBooking(bk.getAttribute("data-book-svc")); return; }
      const btn = e.target.closest(".acc-btn");
      if (!btn) return;
      const item = btn.parentElement;
      const panel = item.querySelector(".acc-panel");
      const wasOpen = item.classList.contains("open");
      acc.querySelectorAll(".acc-item.open").forEach(o => {
        const op = o.querySelector(".acc-panel");
        op.style.maxHeight = op.scrollHeight + "px";
        requestAnimationFrame(() => { op.style.maxHeight = "0px"; });
        o.classList.remove("open");
        o.querySelector(".acc-btn").setAttribute("aria-expanded", "false");
      });
      if (!wasOpen) {
        item.classList.add("open");
        panel.style.maxHeight = panel.scrollHeight + "px";
        btn.setAttribute("aria-expanded", "true");
      }
      setTimeout(() => {
        if (typeof ScrollTrigger !== "undefined") ScrollTrigger.refresh();
        if (!wasOpen) item.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
      }, 420);
    });
  }

  // ---------- sheet machine ----------
  const sheet = $("#sheet");
  const S = { mode: null, steps: [], idx: 0, service: null, date: null, time: null, notes: "", email: "", pendingProfile: false };

  // Bumped on every render and whenever the sheet closes so in-flight requests
  // can tell their step is gone and quietly drop their response.
  let opSeq = 0;
  const stale = (seq) => seq !== opSeq || !sheet.open;

  let sheetOpener = null;   // element to give focus back to on close
  let lastFocusKey = null;  // which step last received the heading focus

  function openSheet() {
    if (!sheet.open) {
      sheetOpener = document.activeElement;
      lastFocusKey = null;
      sheet.showModal();
    }
  }
  function closeSheet() { if (sheet.open) sheet.close(); }
  // Fires for every way the dialog closes, including Escape.
  sheet.addEventListener("close", () => {
    opSeq++;
    const t = sheetOpener; sheetOpener = null;
    if (t && typeof t.focus === "function" && document.contains(t)) t.focus();
  });
  sheet.addEventListener("click", e => { if (e.target === sheet) closeSheet(); });
  $("#sheetClose").addEventListener("click", closeSheet);
  $("#sheetBack").addEventListener("click", () => { if (S.idx > 0) { S.idx--; render(); } else closeSheet(); });

  // One delegated listener for everything rendered inside the sheet body.
  // Bound once at boot so re-renders can never stack or drop handlers.
  $("#sheetBody").addEventListener("click", e => {
    const pick = e.target.closest("[data-pick]");
    if (pick) {
      if (S.mode === "book" && S.steps[S.idx] === "service") {
        S.service = findService(pick.getAttribute("data-pick"));
        if (S.service) next();
      }
      return;
    }
    const cancelBtn = e.target.closest("[data-cancel]");
    if (cancelBtn) { onCancelBooking(cancelBtn); return; }
    const payBtn = e.target.closest("[data-payfix]");
    if (payBtn) { onFinishPaying(payBtn); return; }
  });

  function setSteps() {
    S.steps = [];
    if (S.mode === "book") {
      if (!S.service) S.steps.push("service");
      S.steps.push("when", "who", "review");
    } else if (S.mode === "mybookings") {
      if (!me) S.steps.push("who");
      S.steps.push("list");
    }
  }
  function openBooking(serviceId) {
    if (offline) { window.location.href = serviceId ? smsFor(findService(serviceId)?.name || "an appointment") : `sms:${PHONE}`; return; }
    S.mode = "book"; S.service = serviceId ? findService(serviceId) : null;
    S.date = null; S.time = null; S.notes = ""; S.idx = 0;
    setSteps(); openSheet(); render();
  }
  async function openMyBookings() {
    if (offline) { window.location.href = `sms:${PHONE}`; return; }
    S.mode = "mybookings"; S.idx = 0;
    if (SP.hasToken() && !me) { try { me = await SP.me(); } catch (e) {} }
    setSteps(); openSheet(); render();
  }

  const TITLES = { service: "Pick your style", when: "Pick your day & time", who: "Your info", review: "Confirm your booking", list: "My bookings", done: "" };

  function render(doneCfg) {
    opSeq++;
    const step = doneCfg ? "done" : S.steps[S.idx];
    const title = $("#sheetTitle");
    title.textContent = doneCfg ? (doneCfg.title || "All set") : TITLES[step];
    $("#sheetBack").style.visibility = (S.idx === 0 || doneCfg) ? "hidden" : "visible";
    const dots = $("#sheetDots");
    dots.innerHTML = (S.mode === "book" && !doneCfg) ? S.steps.map((_, i) => `<i class="${i <= S.idx ? "on" : ""}"></i>`).join("") : "";
    const body = $("#sheetBody"); const foot = $("#sheetFoot");
    body.innerHTML = ""; foot.innerHTML = "";
    ({ service: rService, when: rWhen, who: rWho, review: rReview, list: rList, done: rDone })[step](body, foot, doneCfg);
    body.scrollTop = 0;
    // The dialog is labelled by this heading; move focus to it whenever the
    // step changes so screen readers hear where they landed.
    const focusKey = step + ":" + S.idx + ":" + S.mode;
    if (sheet.open && focusKey !== lastFocusKey) title.focus();
    lastFocusKey = focusKey;
  }
  const next = () => { S.idx = Math.min(S.idx + 1, S.steps.length - 1); render(); };
  const msg = (foot, text, isErr) => {
    let m = foot.querySelector(".sheet-msg");
    if (!m) { m = el(`<p class="sheet-msg"></p>`); foot.appendChild(m); }
    m.textContent = text; m.classList.toggle("err", !!isErr);
  };

  // ----- step: service picker -----
  function rService(body) {
    body.appendChild(el(`<h4>What are we doing?</h4>`));
    catalog.forEach(g => {
      const d = el(`<details style="border-bottom:1px solid var(--line)"><summary style="cursor:pointer;font-weight:700;padding:.7rem 0">${esc(g.cat)}</summary></details>`);
      g.items.forEach(i => {
        d.appendChild(el(`
          <button type="button" class="svc" data-pick="${i.service_id}" style="width:100%;background:none;border:none;cursor:pointer;font-family:inherit;text-align:left">
            <div><span class="nm">${esc(i.name)}</span><span class="meta">${esc(i.duration_label || "")}</span></div>
            <span class="dots"></span><span class="pr">${esc(i.price)}</span>
          </button>`));
      });
      body.appendChild(d);
    });
    // clicks are handled by the delegated sheet-body listener (data-pick)
  }

  // ----- step: when -----
  function rWhen(body, foot) {
    const s = S.service;
    body.appendChild(el(`
      <div class="svc-summary"><div><b>${esc(s.name)}</b><span class="m">${esc([s.duration_label, s.cat].filter(Boolean).join(" · "))}</span></div><span class="p">${esc(s.price)}</span></div>`));
    body.appendChild(el(`<h4>Day</h4>`));
    const strip = el(`<div class="date-strip" role="listbox" aria-label="Choose a day"></div>`);
    const base = chicagoToday();
    for (let i = 0; i < 14; i++) {
      const d = new Date(base + i * 86400000);
      const iso = d.toISOString().slice(0, 10);
      const sunday = d.getUTCDay() === 0;
      const chip = el(`
        <button type="button" class="date-chip" data-date="${iso}" ${sunday ? "disabled" : ""}>
          <span class="dw">${sunday ? "Closed" : d.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" })}</span>
          <span class="dn">${d.getUTCDate()}</span>
          <span class="mo">${d.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" })}</span>
        </button>`);
      strip.appendChild(chip);
    }
    body.appendChild(strip);
    body.appendChild(el(`<h4>Time</h4>`));
    const times = el(`<div class="time-grid" aria-live="polite"></div>`);
    body.appendChild(times);
    const cont = el(`<button type="button" class="btn btn-solid" disabled>Continue</button>`);
    foot.appendChild(cont);

    async function loadDay(iso) {
      times.innerHTML = `<p class="time-empty">Checking Ebony's book...</p>`;
      S.time = null; cont.disabled = true;
      const seq = opSeq;
      try {
        const av = await SP.request(`/api/availability?service_id=${encodeURIComponent(s.service_id)}&date=${iso}`);
        if (stale(seq)) return;
        if (av.closed || av.blocked || !av.slots.length) {
          times.innerHTML = `<p class="time-empty">${av.closed ? "Closed this day." : av.blocked ? "Ebony is out this day." : "No openings left this day. Try another."}</p>`;
          return;
        }
        times.innerHTML = "";
        av.slots.forEach(t => times.appendChild(el(`<button type="button" class="time-chip" data-t="${t}">${fmtTime(t)}</button>`)));
      } catch (e) { if (!stale(seq)) times.innerHTML = `<p class="time-empty">Could not load times. ${esc(e.message)}</p>`; }
    }
    strip.addEventListener("click", e => {
      const c = e.target.closest(".date-chip"); if (!c || c.disabled) return;
      strip.querySelectorAll(".sel").forEach(x => x.classList.remove("sel"));
      c.classList.add("sel"); S.date = c.getAttribute("data-date"); loadDay(S.date);
    });
    times.addEventListener("click", e => {
      const c = e.target.closest(".time-chip"); if (!c) return;
      times.querySelectorAll(".sel").forEach(x => x.classList.remove("sel"));
      c.classList.add("sel"); S.time = c.getAttribute("data-t"); cont.disabled = false;
    });
    cont.addEventListener("click", () => { if (S.date && S.time) next(); });
    if (S.date) { const pre = strip.querySelector(`[data-date="${S.date}"]`); if (pre) { pre.classList.add("sel"); loadDay(S.date); } }
  }

  // ----- step: who (login / profile) -----
  function rWho(body, foot) {
    if (me && me.client) return rWhoKnown(body, foot);
    body.appendChild(el(`<h4>Log in to book</h4>
      `));
    body.appendChild(el(`<p style="color:var(--ink-dim);font-size:.92rem;margin-bottom:.9rem">No passwords. We email you a 6-digit code, and your bookings are saved for next time.</p>`));
    const emailF = el(`<div class="field"><label for="bkEmail">Email</label><input id="bkEmail" type="email" autocomplete="email" placeholder="you@example.com" value="${esc(S.email)}"></div>`);
    body.appendChild(emailF);
    const codeWrap = el(`<div style="display:none"><div class="field"><label for="bkCode">6-digit code</label><input id="bkCode" inputmode="numeric" pattern="[0-9]*" maxlength="6" placeholder="123456"></div></div>`);
    body.appendChild(codeWrap);
    const send = el(`<button type="button" class="btn btn-solid">Email me a code</button>`);
    foot.appendChild(send);
    let stage = "email";
    send.addEventListener("click", async () => {
      if (send.disabled) return;
      const email = $("#bkEmail", body).value.trim().toLowerCase();
      if (stage === "email") {
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return msg(foot, "That email doesn't look right.", true);
        send.disabled = true; msg(foot, "Sending your code...");
        const seq = opSeq;
        try {
          await SP.requestCode(email);
          if (stale(seq)) return;
          S.email = email; stage = "code";
          codeWrap.style.display = ""; $("#bkCode", body).focus();
          send.textContent = "Log in";
          msg(foot, demoMode ? "Demo mode: your code is in the demo outbox (bottom left)." : "Check your email for the code.");
          if (demoMode) { try {
            const ob = await SP.request("/api/_outbox");
            if (stale(seq)) return;
            const m = ob.messages.find(x => x.to === email && /code/i.test(x.subject || ""));
            const code = m && (m.body.match(/\b(\d{6})\b/) || [])[1];
            if (code) msg(foot, "Demo mode: your code is " + code);
          } catch (e) {} }
        } catch (e) { if (stale(seq)) return; msg(foot, e.message, true); }
        send.disabled = false;
      } else {
        const code = $("#bkCode", body).value.trim();
        if (code.length !== 6) return msg(foot, "Enter the 6-digit code.", true);
        send.disabled = true; msg(foot, "Checking...");
        const seq = opSeq;
        try {
          const data = await SP.verify(S.email, code);
          const fresh = await SP.me();
          if (stale(seq)) return;
          me = fresh;
          if (!data.client.name) { S.pendingProfile = true; }
          render();
        } catch (e) { if (stale(seq)) return; msg(foot, e.message, true); send.disabled = false; }
      }
    });
  }

  function rWhoKnown(body, foot) {
    const c = me.client;
    const needProfile = S.pendingProfile || !c.name;
    body.appendChild(el(`<h4>${needProfile ? "Almost there" : "Booking as"}</h4>`));
    if (needProfile) {
      body.appendChild(el(`<div class="field"><label for="bkName">Your name</label><input id="bkName" autocomplete="name" placeholder="First and last" value="${esc(c.name || "")}"></div>`));
      body.appendChild(el(`<div class="field"><label for="bkPhone">Cell number (for text updates)</label><input id="bkPhone" type="tel" autocomplete="tel" placeholder="(555) 555-5555" value="${esc(c.phone || "")}"></div>`));
    } else {
      body.appendChild(el(`
        <div class="svc-summary"><div><b>${esc(c.name)}</b><span class="m">${esc(c.email)}${c.phone ? " · " + esc(c.phone) : ""}</span></div>
        <button type="button" id="switchAcct" style="background:none;border:none;color:var(--rose);font-weight:700;font-size:.85rem;cursor:pointer;font-family:inherit">Not you?</button></div>`));
    }
    if (S.mode === "book") {
      body.appendChild(el(`<div class="field" style="margin-top:1rem"><label for="bkNotes">Anything Ebony should know? (optional)</label><textarea id="bkNotes" rows="2" placeholder="Hair length, inspo, questions...">${esc(S.notes)}</textarea></div>`));
    }
    const cont = el(`<button type="button" class="btn btn-solid">Continue</button>`);
    foot.appendChild(cont);
    const sw = $("#switchAcct", body);
    if (sw) sw.addEventListener("click", () => { SP.logout(); me = null; S.pendingProfile = false; render(); });
    cont.addEventListener("click", async () => {
      if (cont.disabled) return;
      if (needProfile) {
        const name = $("#bkName", body).value.trim();
        if (name.length < 2) return msg(foot, "Tell us your name so Ebony knows who's coming.", true);
        const phone = $("#bkPhone", body).value.trim();
        cont.disabled = true;
        const seq = opSeq;
        try {
          const updated = (await SP.updateMe({ name, phone })).client;
          if (stale(seq)) return;
          me = { ...me, client: updated }; S.pendingProfile = false;
        }
        catch (e) { if (stale(seq)) return; msg(foot, e.message, true); cont.disabled = false; return; }
      }
      if (S.mode === "book") { S.notes = ($("#bkNotes", body) || { value: "" }).value.trim(); next(); }
      else { setSteps(); S.idx = S.steps.length - 1; render(); }
    });
  }

  // ----- step: review -----
  function rReview(body, foot) {
    const s = S.service;
    const dep = s.deposit_cents;
    body.appendChild(el(`
      <div class="review-rows">
        <div class="rr"><b>Style</b><span class="v">${esc(s.name)}</span></div>
        <div class="rr"><b>When</b><span class="v">${esc(fmtDate(S.date))} at ${esc(fmtTime(S.time))}</span></div>
        <div class="rr"><b>Takes about</b><span class="v">${esc(s.duration_label || "")}</span></div>
        <div class="rr"><b>Price</b><span class="v">${esc(s.price)}</span></div>
        ${S.notes ? `<div class="rr"><b>Notes</b><span class="v">${esc(S.notes)}</span></div>` : ""}
      </div>`));
    body.appendChild(el(dep != null
      ? `<div class="deposit-line"><b>Deposit due now: ${money(dep)}.</b> Paid securely online; it comes off your balance on the day. The rest is due at your appointment.</div>`
      : `<div class="deposit-line"><b>A deposit still secures this appointment.</b> Ebony will text you to confirm your deposit amount before your time is locked in.</div>`));
    const book = el(`<button type="button" class="btn btn-solid">${dep != null ? "Pay deposit & book" : "Send booking request"}</button>`);
    foot.appendChild(book);
    book.addEventListener("click", async () => {
      if (book.disabled) return;
      book.disabled = true; msg(foot, "Saving your seat...");
      const seq = opSeq;
      try {
        const data = await SP.request("/api/bookings", { method: "POST", body: { service_id: s.service_id, date: S.date, time: S.time, notes: S.notes } });
        me = null; // refetch bookings next time either way
        if (stale(seq)) return; // sheet closed mid-save; the booking lives under My bookings
        if (data.checkout_url) { window.location.href = data.checkout_url; return; }
        render({ title: "Request sent", icon: "✓", head: "Ebony's got it!", copy: "She'll text you to confirm your deposit and your time. You can see this booking any time under My bookings." });
      } catch (e) { if (stale(seq)) return; msg(foot, e.message, true); book.disabled = false; }
    });
  }

  // ----- step: my bookings list -----
  function rList(body, foot) {
    const seq = opSeq;
    (async () => {
      let fresh;
      try { fresh = await SP.me(); } catch (e) {
        if (stale(seq)) return;
        body.appendChild(el(`<p class="time-empty">${esc(e.message)}</p>`)); return;
      }
      if (stale(seq)) return;
      me = fresh;
      const upcoming = me.bookings.filter(b => b.status !== "canceled" && b.status !== "completed");
      const past = me.bookings.filter(b => b.status === "canceled" || b.status === "completed");
      const CHIP = { awaiting_deposit: ["chip-awaiting", "Deposit due"], request: ["chip-request", "Waiting on Ebony"], confirmed: ["chip-confirmed", "Confirmed"], completed: ["chip-completed", "Done"], canceled: ["chip-canceled", "Canceled"] };
      const payBtnStyle = "min-height:40px;padding:.4rem 1.1rem;font-size:.85rem";
      const rowFor = (b) => {
        const [cls, label] = CHIP[b.status] || ["chip-request", b.status];
        const active = b.status === "awaiting_deposit" || b.status === "request" || b.status === "confirmed";
        const payAction = b.status !== "awaiting_deposit" ? ""
          : b.checkout_url
            ? `<a class="btn btn-solid" style="${payBtnStyle}" href="${esc(b.checkout_url)}">Pay deposit</a>`
            : `<button type="button" class="btn btn-solid" style="${payBtnStyle}" data-payfix="${esc(String(b.id))}">Finish paying</button>`;
        return el(`
          <div class="mybk-item">
            <div class="top"><span class="when">${esc(fmtDate(b.date))} · ${esc(fmtTime(b.time))}</span><span class="chip ${cls}">${label}</span></div>
            <div class="what">${esc(b.service_name)} · ${esc(b.price)}</div>
            <div class="actions">
              ${payAction}
              ${active ? `<button type="button" class="cancel-link" data-cancel="${esc(String(b.id))}">Cancel booking</button>` : ""}
            </div>
          </div>`);
      };
      body.innerHTML = "";
      body.appendChild(el(`<h4>Upcoming</h4>`));
      if (!upcoming.length) body.appendChild(el(`<p class="time-empty">Nothing booked yet. Let's fix that.</p>`));
      upcoming.forEach(b => body.appendChild(rowFor(b)));
      if (past.length) { body.appendChild(el(`<h4>Past</h4>`)); past.forEach(b => body.appendChild(rowFor(b))); }
      foot.innerHTML = "";
      const again = el(`<button type="button" class="btn btn-ghost">Book something new</button>`);
      foot.appendChild(again);
      again.addEventListener("click", () => { S.mode = "book"; S.service = null; S.date = null; S.time = null; S.idx = 0; setSteps(); render(); });
      // cancel + finish-paying clicks are handled by the delegated listener
    })();
  }

  // Cancel any booking, any number of times, via the delegated listener.
  async function onCancelBooking(btn) {
    if (btn.disabled) return;
    if (!confirm("Cancel this booking? Ebony will be notified.")) return;
    btn.disabled = true;
    const seq = opSeq;
    try {
      await SP.request(`/api/bookings/${encodeURIComponent(btn.getAttribute("data-cancel"))}/cancel`, { method: "POST" });
      me = null;
      if (stale(seq)) return;
      render(); // re-runs the list step with fresh data
    } catch (err) {
      if (stale(seq)) return;
      alert(err.message);
      btn.disabled = false;
    }
  }

  // Finish an unpaid deposit even when /api/me gave us no checkout_url:
  // re-fetch in case the server can mint a fresh session, else point the
  // client at their booking email or Ebony directly.
  async function onFinishPaying(btn) {
    if (btn.disabled) return;
    btn.disabled = true;
    const id = btn.getAttribute("data-payfix");
    const seq = opSeq;
    try {
      const fresh = await SP.me();
      if (stale(seq)) return;
      me = fresh;
      const b = (fresh.bookings || []).find(x => String(x.id) === String(id));
      if (b && b.checkout_url) { window.location.href = b.checkout_url; return; }
      msg($("#sheetFoot"), "Your payment link is in your booking email. Can't find it? Text Ebony at (817) 704-8300.", true);
      btn.disabled = false;
    } catch (e) {
      if (stale(seq)) return;
      msg($("#sheetFoot"), e.message, true);
      btn.disabled = false;
    }
  }

  // ----- step: done -----
  function rDone(body, foot, cfg) {
    body.appendChild(el(`
      <div class="done-wrap">
        <div class="mark">${cfg.icon || "✓"}</div>
        <h4>${esc(cfg.head)}</h4>
        <p>${esc(cfg.copy)}</p>
      </div>`));
    const ok = el(`<button type="button" class="btn btn-solid">Done</button>`);
    foot.appendChild(ok);
    ok.addEventListener("click", closeSheet);
  }

  // ----- returning from checkout: verify before celebrating -----
  async function verifyPaidReturn(bookingId) {
    S.mode = "book"; S.steps = ["review"]; S.idx = 0;
    openSheet();
    render({ title: "One moment", icon: "...", head: "Checking your payment", copy: "Give us a second while we confirm your deposit." });
    const seq = opSeq;
    let confirmed = false;
    if (SP.hasToken() && bookingId) {
      for (let attempt = 0; attempt < 3 && !confirmed; attempt++) {
        if (attempt) {
          await new Promise(r => setTimeout(r, 1500));
          if (stale(seq)) return;
        }
        try {
          const fresh = await SP.me();
          if (stale(seq)) return;
          me = fresh;
          const b = (fresh.bookings || []).find(x => String(x.id) === String(bookingId));
          confirmed = !!b && (b.status === "confirmed" || b.status === "completed");
        } catch (e) { break; }
      }
    }
    if (stale(seq)) return;
    if (confirmed) {
      render({ title: "You're booked", icon: "♥", head: "Your seat is saved!", copy: "Deposit received. Check your email for your confirmation, and Ebony will see you soon." });
    } else {
      render({ title: "Almost there", icon: "...", head: "We are confirming your payment", copy: "Your payment is still processing. Give it a minute, then check My bookings. If anything looks off, text Ebony at (817) 704-8300." });
    }
  }

  // ---------- boot ----------
  async function boot() {
    await loadCatalog();
    buildAccordion();
    // demo ribbon
    try { await SP.request("/api/_outbox"); demoMode = true; $("#demoRibbon").style.display = "block"; } catch (e) {}
    if (offline) { const b = $("#navMyBookings"); if (b) b.style.display = "none"; }
    document.querySelectorAll("[data-book]").forEach(b => b.addEventListener("click", () => openBooking(null)));
    $("#navMyBookings").addEventListener("click", openMyBookings);
    // returning from checkout
    const q = new URLSearchParams(window.location.search);
    if (q.get("paid") === "1") {
      const bookingId = q.get("booking") || "";
      history.replaceState(null, "", window.location.pathname);
      verifyPaidReturn(bookingId);
    }
  }
  document.addEventListener("DOMContentLoaded", boot);
})();
