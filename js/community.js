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
  // A centered card that opens on every visit, as soon as the page loads.
  // It still never shows to a signed-in client (they are already on her
  // list) or to anyone who already submitted it, and it waits for the
  // reviews call to succeed so it can only appear where submitting works.
  const DONE_KEY = "sp_lead_done";
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
  };

  const pop = $("#leadPop");
  const scrim = $("#lpScrim");
  if (!pop) return void loadReviews();

  function eligible() {
    if (store.get(DONE_KEY)) return false;
    if (window.SP && SP.hasToken()) return false;
    return true;
  }

  function show() {
    if (!eligible()) return;
    const sheet = document.getElementById("sheet");
    if (sheet && sheet.open) {
      // Deep link straight into booking: wait for the sheet to close first.
      sheet.addEventListener("close", () => setTimeout(show, 900), { once: true });
      return;
    }
    pop.hidden = false;
    if (scrim) scrim.hidden = false;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      pop.classList.add("show");
      if (scrim) scrim.classList.add("show");
    }));
  }

  function hide() {
    pop.classList.remove("show");
    if (scrim) scrim.classList.remove("show");
    setTimeout(() => { pop.hidden = true; if (scrim) scrim.hidden = true; }, 380);
  }

  $("#lpClose").addEventListener("click", hide);
  if (scrim) scrim.addEventListener("click", hide);
  document.addEventListener("keydown", (e) => {
    const sheet = document.getElementById("sheet");
    if (sheet && sheet.open) return;
    if (e.key === "Escape" && !pop.hidden && pop.classList.contains("show")) hide();
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
    // A beat after load so the page paints first, then the popup takes center.
    loadReviews().then((apiOk) => { if (apiOk) setTimeout(show, 700); });
  }
  document.addEventListener("DOMContentLoaded", bootOnce);
  if (document.readyState !== "loading") bootOnce();
})();
