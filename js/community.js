// Sitting Pretty — the public reviews wall and the waitlist popup.
// Loads after js/booking.js. Nothing here touches the booking sheet's state;
// the "Share your experience" button is wired inside booking.js because the
// review form lives in the sheet machine.
(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ---------- reviews wall ----------
  // Approved reviews only; the API enforces that, this just paints them.
  // No reviews yet is a normal, honest state: the aggregate line above the
  // grid is real (her StyleSeat rating) and the empty note invites the first.
  // Resolves true when the API answered, so the popup only ever arms on a
  // site where submitting it can succeed.
  async function loadReviews() {
    const grid = $("#reviewsGrid");
    const empty = $("#reviewsEmpty");
    if (!grid) return false;
    let data;
    try {
      data = await SP.request("/api/reviews");
    } catch (e) {
      // No API at all (plain static hosting, or the endpoint does not exist):
      // keep the section to the real aggregate line and hide the invitation
      // that could not be fulfilled. A transient server blip (5xx) leaves the
      // button alone; the review sheet reports its own errors clearly.
      if (e && (e.status === 0 || e.status === 404)) {
        const lr = $("#leaveReview");
        if (lr) lr.hidden = true;
        return false;
      }
      return true;
    }
    const reviews = (data && data.reviews) || [];
    if (!reviews.length) { empty.hidden = false; return true; }
    grid.classList.toggle("few", reviews.length < 3);
    const stars = (n) => "★★★★★".slice(0, Math.max(1, Math.min(5, n)));
    grid.innerHTML = reviews.map(r => `
      <figure class="rev-card">
        <span class="stars" aria-label="${Math.max(1, Math.min(5, r.rating))} out of 5 stars">${stars(r.rating)}</span>
        <blockquote>${esc(r.body)}</blockquote>
        <figcaption class="who"><b>${esc(r.name)}</b>${r.service ? " · " + esc(r.service) : ""}${r.source === "styleseat" ? ' <span class="via">via StyleSeat</span>' : ""}</figcaption>
      </figure>`).join("");
    grid.hidden = false;
    return true;
  }

  // ---------- waitlist popup ----------
  // One quiet card, once. Never for signed-in clients (they are already on
  // her list), never twice after a signup, and a dismissal snoozes it for a
  // week. It also stays out of the way while the booking sheet is open:
  // someone mid-booking is doing the more valuable thing.
  const DONE_KEY = "sp_lead_done";
  const SNOOZE_KEY = "sp_lead_snooze";
  const SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
  };

  const pop = $("#leadPop");
  if (!pop) return void loadReviews();
  let shown = false;
  let armed = false;

  function eligible() {
    if (shown || store.get(DONE_KEY)) return false;
    const snooze = Number(store.get(SNOOZE_KEY) || 0);
    if (snooze && Date.now() - snooze < SNOOZE_MS) return false;
    if (window.SP && SP.hasToken()) return false;
    return true;
  }

  function show() {
    if (!eligible() || inQuietZone) return;
    const sheet = document.getElementById("sheet");
    if (sheet && sheet.open) {
      // Wait for the sheet to close, then a beat, then try again.
      sheet.addEventListener("close", () => setTimeout(show, 1600), { once: true });
      return;
    }
    shown = true;
    pop.hidden = false;
    requestAnimationFrame(() => requestAnimationFrame(() => pop.classList.add("show")));
  }

  function dismiss() {
    store.set(SNOOZE_KEY, String(Date.now()));
    hide();
  }
  function hide() {
    pop.classList.remove("show");
    setTimeout(() => { pop.hidden = true; }, 420);
  }

  // Quiet zones: sections whose own call to action the popup must never sit on
  // top of. Watched by element, not by scroll percentage, because the page
  // length changes as reviews are added and a percentage silently drifts onto
  // whatever moved there.
  const QUIET = ["#reviews", ".cta"];
  let inQuietZone = false;
  (function watchQuietZones() {
    if (typeof IntersectionObserver !== "function") return;
    const io = new IntersectionObserver((entries) => {
      entries.forEach(e => { e.target.__vis = e.isIntersecting; });
      inQuietZone = QUIET.some(sel => {
        const el = document.querySelector(sel);
        return el && el.__vis;
      });
      // Already open and a quiet zone just scrolled in: step aside. hide(),
      // not dismiss(), because scrolling past is not a no.
      if (inQuietZone && !pop.hidden && pop.classList.contains("show") &&
          !pop.contains(document.activeElement)) hide();
    }, { threshold: 0.12 });
    QUIET.forEach(sel => { const el = document.querySelector(sel); if (el) io.observe(el); });
  })();

  function arm() {
    if (armed || !eligible()) return;
    armed = true;
    const t = setTimeout(show, 14000);
    const onScroll = () => {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      const at = max > 0 ? window.scrollY / max : 0;
      if (at > 0.35 && !inQuietZone) {
        clearTimeout(t);
        window.removeEventListener("scroll", onScroll);
        show();
      }
    };
    window.addEventListener("scroll", onScroll, { passive: true });
  }

  $("#lpClose").addEventListener("click", dismiss);
  document.addEventListener("keydown", (e) => {
    // The booking sheet opens OVER the popup; Escape there closes the sheet,
    // and must not silently snooze a signup the visitor was mid-typing.
    const sheet = document.getElementById("sheet");
    if (sheet && sheet.open) return;
    if (e.key === "Escape" && !pop.hidden && pop.classList.contains("show")) dismiss();
  });

  $("#lpForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const go = $("#lpGo");
    if (go.disabled) return;
    const say = (text, isErr) => {
      const m = $("#lpMsg");
      m.textContent = text; m.hidden = !text;
      m.classList.toggle("err", !!isErr);
    };
    const name = $("#lpName").value.trim();
    const email = $("#lpEmail").value.trim().toLowerCase();
    const phone = $("#lpPhone").value.trim();
    if (name.length < 2) return say("Tell us your name so Ebony knows who you are.", true);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return say("That email does not look right. Check it and try again.", true);
    const phoneDigits = phone.replace(/\D/g, "");
    if (phone && (phoneDigits.length < 10 || phoneDigits.length > 15)) {
      return say("That phone number does not look right. Check it, or leave it blank.", true);
    }
    go.disabled = true; say("Adding you...");
    try {
      await SP.request("/api/leads", {
        method: "POST",
        body: { name, email, phone, source: "popup", company: $("#lpCompany").value },
      });
      store.set(DONE_KEY, "1");
      $("#lpBody").innerHTML = `
        <div class="lp-done">
          <div class="mark">♥</div>
          <h3>You're on the list${name ? ", " + esc(name.split(/\s+/)[0]) : ""}!</h3>
          <p class="lp-sub">Ebony will reach out when something opens up. Want a seat sooner? The book is right here.</p>
          <button type="button" class="btn btn-solid" data-book style="width:100%;margin-top:.9rem">Book now</button>
        </div>`;
      const bookBtn = pop.querySelector("[data-book]");
      if (bookBtn) bookBtn.addEventListener("click", () => {
        hide();
        const mainBook = document.querySelector("nav .book-pill");
        if (mainBook) mainBook.click();
      });
      setTimeout(() => { if (!pop.hidden && !pop.matches(":hover") && !pop.contains(document.activeElement)) hide(); }, 8000);
    } catch (err) {
      say(err.message, true);
      go.disabled = false;
    }
  });

  let booted = false;
  function bootOnce() {
    if (booted) return;
    booted = true;
    loadReviews().then((apiOk) => { if (apiOk) arm(); });
  }
  document.addEventListener("DOMContentLoaded", bootOnce);
  if (document.readyState !== "loading") bootOnce();
})();
