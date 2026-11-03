/* Gaz's Radio Stations – browser version
 * Stations come from Radio Browser (https://www.radio-browser.info), free and keyless.
 * Sound is played by the browser itself. The Raspberry Pi version will swap the
 * `player` object below for one that sends commands to MPD instead.
 */
(() => {
  "use strict";

  // ---- Settings ------------------------------------------------------------

  const GENRES = {
    Rock:  ["rock", "classic rock", "hard rock", "alternative rock", "blues rock", "rock'n'roll"],
    Blues: ["blues", "blues rock", "delta blues", "chicago blues", "rhythm and blues"],
    Jazz:  ["jazz", "smooth jazz", "jazz fusion", "bebop", "swing", "acid jazz"],
    Soul:  ["soul", "northern soul", "neo soul", "classic soul", "motown"],
    Funk:  ["funk", "funky", "jazz-funk", "p-funk", "disco funk"],
    Indie: ["indie", "indie rock", "indie pop", "indie folk", "alternative"],
  };
  const FAVOURITES = "Favourites";
  const PER_TAG = 80;      // stations fetched per tag
  const PAGE_SIZE = 40;    // stations shown before "Show more"
  const FALLBACK_SERVERS = [
    "https://de1.api.radio-browser.info",
    "https://de2.api.radio-browser.info",
    "https://fi1.api.radio-browser.info",
  ];

  // ---- Small helpers -------------------------------------------------------

  const $ = (id) => document.getElementById(id);
  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem("gazradio." + key); return v == null ? fallback : JSON.parse(v); }
      catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem("gazradio." + key, JSON.stringify(value)); } catch { /* private mode */ }
    },
  };
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const initials = (name) => (name || "?").replace(/[^\p{L}\p{N} ]/gu, "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "♪";

  // ---- Radio Browser API ---------------------------------------------------

  const api = {
    servers: null,
    async init() {
      if (this.servers) return;
      try {
        const res = await fetch("https://all.api.radio-browser.info/json/servers");
        const list = await res.json();
        const names = [...new Set(list.map((s) => s.name))].map((n) => "https://" + n);
        this.servers = names.length ? shuffle(names) : shuffle([...FALLBACK_SERVERS]);
      } catch {
        this.servers = shuffle([...FALLBACK_SERVERS]);
      }
    },
    async get(path, params = {}) {
      await this.init();
      const qs = new URLSearchParams(params).toString();
      let lastErr;
      for (const base of this.servers) {
        try {
          const res = await fetch(`${base}/json/${path}${qs ? "?" + qs : ""}`);
          if (!res.ok) throw new Error("HTTP " + res.status);
          // Keep using the server that worked.
          this.servers = [base, ...this.servers.filter((s) => s !== base)];
          return await res.json();
        } catch (e) { lastErr = e; }
      }
      throw lastErr;
    },
    search(params) {
      return this.get("stations/search", {
        hidebroken: "true", is_https: "true", order: "clickcount", reverse: "true", ...params,
      });
    },
    countClick(uuid) { this.get("url/" + encodeURIComponent(uuid)).catch(() => {}); },
  };

  // Only keep stations the browser can actually play from an https page.
  const playable = (s) =>
    s && s.url_resolved && s.url_resolved.startsWith("https://") && s.lastcheckok === 1 && s.hls !== 1;

  // Radio Browser uses long official names ("The United Kingdom Of Great Britain...").
  let regionNames = null;
  try { regionNames = new Intl.DisplayNames(["en-GB"], { type: "region" }); } catch { /* old browser */ }
  const countryName = (s) => {
    if (regionNames && s.countrycode && /^[A-Za-z]{2}$/.test(s.countrycode)) {
      try { return regionNames.of(s.countrycode.toUpperCase()); } catch { /* fall through */ }
    }
    return s.country || "";
  };

  const slim = (s) => ({
    stationuuid: s.stationuuid, name: (s.name || "").trim(), url_resolved: s.url_resolved,
    favicon: s.favicon, homepage: s.homepage, country: countryName(s), countrycode: s.countrycode,
    tags: s.tags, codec: s.codec, bitrate: s.bitrate, votes: s.votes, clickcount: s.clickcount,
    lastcheckok: s.lastcheckok, hls: s.hls,
  });

  const cache = {};
  async function loadGenre(genre) {
    if (cache[genre]) return cache[genre];
    const results = await Promise.allSettled(
      GENRES[genre].map((tag) => api.search({ tag, tagExact: "true", limit: PER_TAG }))
    );
    if (results.every((r) => r.status === "rejected")) throw new Error("Could not reach the station directory");
    const byId = new Map();
    for (const r of results) {
      if (r.status !== "fulfilled") continue;
      for (const s of r.value) if (playable(s) && !byId.has(s.stationuuid)) byId.set(s.stationuuid, slim(s));
    }
    // Drop exact duplicate streams listed under different names.
    const seenUrls = new Set();
    const list = [...byId.values()].filter((s) => (seenUrls.has(s.url_resolved) ? false : seenUrls.add(s.url_resolved)));
    cache[genre] = list;
    return list;
  }

  // ---- Favourites ----------------------------------------------------------

  let favourites = store.get("favourites", []);
  const isFav = (s) => favourites.some((f) => f.stationuuid === s.stationuuid);
  function toggleFav(s) {
    favourites = isFav(s) ? favourites.filter((f) => f.stationuuid !== s.stationuuid) : [...favourites, slim(s)];
    store.set("favourites", favourites);
    syncFavButtons();
  }

  // Keep every star (list rows and the player bar) showing the same thing.
  function syncFavButtons() {
    document.querySelectorAll(".fav-btn[data-id]").forEach((b) => {
      const on = favourites.some((f) => f.stationuuid === b.dataset.id);
      const name = b.dataset.name || "this station";
      b.setAttribute("aria-pressed", String(on));
      b.setAttribute("aria-label", on ? `Remove ${name} from favourites` : `Add ${name} to favourites`);
      b.title = on ? "Remove from favourites" : "Add to favourites";
    });
  }

  // ---- Player (browser audio) ----------------------------------------------

  const audio = new Audio();
  audio.preload = "none";

  const player = {
    current: null,
    play(station) {
      this.current = station;
      audio.src = station.url_resolved;
      audio.volume = Number($("volume").value);
      ui.playerState("Connecting…");
      audio.play().catch((e) => { if (e.name !== "AbortError") { ui.playerState("Couldn't play this station. Try another.", "error"); ui.playButton(false); } });
      api.countClick(station.stationuuid);
      setMediaSession(station);
      nowPlaying.start(station);
    },
    stop() {
      audio.pause();
      audio.removeAttribute("src");
      audio.load(); // stops the download of a live stream
      nowPlaying.stop();
      ui.playerState("Stopped");
    },
    resume() { if (this.current) this.play(this.current); },
    get playing() { return !!audio.src && !audio.paused; },
  };

  audio.addEventListener("playing", () => {
    showLive();
    document.querySelectorAll(".station").forEach((n) => n.classList.toggle("playing", !!player.current && n.dataset.id === player.current.stationuuid));
  });
  audio.addEventListener("waiting", () => ui.playerState("Buffering…"));
  audio.addEventListener("error", () => { if (audio.getAttribute("src")) { nowPlaying.stop(); ui.playerState("This station isn't responding. Try another.", "error"); ui.playButton(false); } });
  audio.addEventListener("play", () => ui.playButton(true));
  audio.addEventListener("pause", () => ui.playButton(false));
  audio.addEventListener("emptied", () => ui.playButton(false));

  function setMediaSession(s) {
    if (!("mediaSession" in navigator)) return;
    const artwork = s.favicon && s.favicon.startsWith("https://") ? [{ src: s.favicon }] : [{ src: "images/icon-192.png", sizes: "192x192" }];
    const song = nowPlaying.song;
    navigator.mediaSession.metadata = song
      ? new MediaMetadata({ title: song, artist: s.name, album: "Gaz's Radio Stations", artwork })
      : new MediaMetadata({ title: s.name, artist: s.country || "Internet radio", album: "Gaz's Radio Stations", artwork });
    navigator.mediaSession.setActionHandler("play", () => player.resume());
    navigator.mediaSession.setActionHandler("pause", () => player.stop());
    navigator.mediaSession.setActionHandler("stop", () => player.stop());
  }

  // ---- Now playing (song title) --------------------------------------------
  // Browsers drop the song information carried inside a stream, so instead we ask
  // the station's own server. Icecast servers publish /status-json.xsl and normally
  // allow browsers to read it; some Shoutcast servers allow /stats?json=1. Stations
  // that allow neither simply show "Live".

  const SONG_REFRESH_MS = 20000;
  const songSource = {}; // per server: "icecast" | "shoutcast" | "none"

  async function fetchJson(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    try {
      const res = await fetch(url, { signal: ctrl.signal, cache: "no-store", credentials: "omit" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await res.json();
    } finally { clearTimeout(timer); }
  }

  function tidySong(text, station) {
    if (typeof text !== "string") return "";
    const t = text.replace(/\s+/g, " ").trim().replace(/^[-–\s]+|[-–\s]+$/g, "");
    if (!t || t.length < 3) return "";
    const lower = t.toLowerCase();
    if (["unknown", "untitled", "n/a", "-", "live", "advert", "advertisement"].includes(lower)) return "";
    if (lower === (station.name || "").trim().toLowerCase()) return "";
    return t.length > 140 ? t.slice(0, 140) + "…" : t;
  }

  const songReaders = {
    async icecast(url, station) {
      const data = await fetchJson(url.origin + "/status-json.xsl");
      let sources = data && data.icestats && data.icestats.source;
      if (!sources) return "";
      if (!Array.isArray(sources)) sources = [sources];
      const path = url.pathname.replace(/\/$/, "");
      const pathOf = (s) => { try { return new URL(s.listenurl).pathname.replace(/\/$/, ""); } catch { return ""; } };
      const src = sources.find((s) => pathOf(s) === path) || (sources.length === 1 ? sources[0] : null);
      if (!src) return "";
      const title = src.artist && src.title && !String(src.title).includes(src.artist) ? `${src.artist} – ${src.title}` : src.title || src.yp_currently_playing;
      return tidySong(String(title || ""), station);
    },
    async shoutcast(url, station) {
      const data = await fetchJson(url.origin + "/stats?sid=1&json=1");
      return tidySong(data && data.songtitle, station);
    },
  };

  const nowPlaying = {
    song: "",
    station: null,
    timer: null,
    run: 0,
    start(station) {
      this.stop();
      this.station = station;
      const run = ++this.run;
      const tick = async () => {
        if (run !== this.run) return;
        if (document.hidden) { this.timer = setTimeout(tick, SONG_REFRESH_MS); return; }
        const found = await this.lookup(station);
        if (run !== this.run) return;
        if (found === null) return; // this station doesn't share song titles; stop asking
        if (found !== this.song) {
          this.song = found;
          if (player.playing) showLive();
          setMediaSession(station);
        }
        this.timer = setTimeout(tick, SONG_REFRESH_MS);
      };
      tick();
    },
    stop() {
      this.run++;
      clearTimeout(this.timer);
      this.song = "";
      this.station = null;
    },
    // Returns the song text ("" if none right now), or null if the server can't tell us.
    async lookup(station) {
      let url;
      try { url = new URL(station.url_resolved); } catch { return null; }
      const known = songSource[url.origin];
      if (known === "none") return null;
      const order = known ? [known] : ["icecast", "shoutcast"];
      for (const kind of order) {
        try {
          const song = await songReaders[kind](url, station);
          songSource[url.origin] = kind;
          return song;
        } catch { /* not readable this way */ }
      }
      if (!known) songSource[url.origin] = "none";
      return known ? "" : null; // a server that worked before may just be slow
    },
  };

  function showLive() {
    ui.playerState(nowPlaying.song ? "♪ " + nowPlaying.song : "Live", "live");
  }

  // ---- Page state and rendering --------------------------------------------

  const state = {
    genre: store.get("genre", "Rock"),
    list: [],
    shown: PAGE_SIZE,
    query: "",
    country: "",
    sort: "popular",
    worldSearch: null, // results of a search across all stations
  };
  if (state.genre !== FAVOURITES && !GENRES[state.genre]) state.genre = "Rock";

  const ui = {
    status(text) { $("status").textContent = text; },
    playerState(text, kind = "") {
      const n = $("playerState");
      n.textContent = text;
      n.title = text;
      n.className = "now-state" + (kind ? " " + kind : "");
    },
    playButton(isPlaying) {
      const b = $("playBtn");
      b.classList.toggle("stopped", !isPlaying);
      b.setAttribute("aria-label", isPlaying ? "Stop" : "Play");
    },
  };

  function renderGenres() {
    const nav = $("genres");
    nav.replaceChildren();
    for (const g of [...Object.keys(GENRES), FAVOURITES]) {
      const b = el("button", "genre" + (g === FAVOURITES ? " fav" : ""), g === FAVOURITES ? "★ Favourites" : g);
      b.type = "button";
      b.setAttribute("aria-pressed", String(g === state.genre && !state.worldSearch));
      b.addEventListener("click", () => selectGenre(g));
      nav.append(b);
    }
  }

  function logoFor(s) {
    const box = el("div", "logo", initials(s.name));
    if (s.favicon && s.favicon.startsWith("https://")) {
      const img = new Image();
      img.alt = "";
      img.loading = "lazy";
      img.referrerPolicy = "no-referrer";
      img.onload = () => { if (img.naturalWidth > 8) box.replaceChildren(img); };
      img.src = s.favicon;
    }
    return box;
  }

  function stationRow(s) {
    const li = el("li", "station");
    li.dataset.id = s.stationuuid;
    if (player.current && player.current.stationuuid === s.stationuuid && player.playing) li.classList.add("playing");
    li.tabIndex = 0;
    li.setAttribute("role", "button");
    li.setAttribute("aria-label", "Play " + s.name);

    const info = el("div", "info");
    info.append(el("div", "name", s.name || "Unnamed station"));
    const meta = el("div", "meta");
    const tags = [...new Set((s.tags || "").split(",").map((t) => t.trim().toLowerCase()).filter(Boolean))].slice(0, 3).join(", ");
    const quality = [s.codec, s.bitrate ? s.bitrate + " kbps" : ""].filter(Boolean).join(" ");
    meta.append(document.createTextNode([s.country, tags].filter(Boolean).join(" · ")));
    if (quality) { meta.append(document.createTextNode(" · ")); meta.append(el("span", "q", quality)); }
    info.append(meta);

    const fav = el("button", "fav-btn");
    fav.type = "button";
    fav.dataset.id = s.stationuuid;
    fav.dataset.name = s.name;
    fav.setAttribute("aria-pressed", String(isFav(s)));
    fav.setAttribute("aria-label", (isFav(s) ? "Remove " : "Add ") + s.name + (isFav(s) ? " from" : " to") + " favourites");
    fav.innerHTML = '<svg viewBox="0 0 24 24"><path d="m12 3 2.7 5.6 6.1.8-4.5 4.2 1.1 6.1L12 16.8 6.6 19.7l1.1-6.1L3.2 9.4l6.1-.8z"/></svg>';
    fav.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleFav(s);
      if (state.genre === FAVOURITES && !state.worldSearch) { state.list = favourites; render(); }
    });

    const start = () => {
      document.querySelectorAll(".station.playing").forEach((n) => n.classList.remove("playing"));
      li.classList.add("playing");
      showPlayer(s);
      player.play(s);
    };
    li.addEventListener("click", start);
    li.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); start(); } });

    li.append(logoFor(s), info, fav);
    return li;
  }

  function filtered() {
    const source = state.worldSearch || state.list;
    const q = state.query.toLowerCase();
    let out = source.filter((s) =>
      (!state.country || s.country === state.country) &&
      (state.worldSearch || !q || s.name.toLowerCase().includes(q) || (s.tags || "").toLowerCase().includes(q))
    );
    const by = {
      popular: (a, b) => (b.clickcount || 0) - (a.clickcount || 0),
      votes: (a, b) => (b.votes || 0) - (a.votes || 0),
      name: (a, b) => a.name.localeCompare(b.name),
    }[state.sort];
    return out.sort(by);
  }

  function renderCountries() {
    const source = state.worldSearch || state.list;
    const counts = {};
    for (const s of source) if (s.country) counts[s.country] = (counts[s.country] || 0) + 1;
    const sel = $("country");
    const keep = state.country;
    sel.replaceChildren(new Option("All countries", ""));
    Object.keys(counts).sort((a, b) => a.localeCompare(b)).forEach((c) => sel.append(new Option(`${c} (${counts[c]})`, c)));
    if (keep && counts[keep]) sel.value = keep; else { state.country = ""; sel.value = ""; }
  }

  function render() {
    renderGenres();
    const items = filtered();
    const ul = $("stations");
    ul.replaceChildren(...items.slice(0, state.shown).map(stationRow));

    const label = state.worldSearch ? `matching “${state.query}”` : state.genre === FAVOURITES ? "in your favourites" : state.genre.toLowerCase();
    if (items.length) ui.status(`${items.length} station${items.length === 1 ? "" : "s"} ${state.worldSearch ? label : "· " + label}${state.country ? " · " + state.country : ""}`);
    else if (state.genre === FAVOURITES && !state.worldSearch && !state.query) ui.status("No favourites yet. Tap the star next to a station to save it here.");
    else ui.status("No stations found.");

    const more = $("more");
    more.replaceChildren();
    if (items.length > state.shown) {
      const b = el("button", "btn", `Show more (${items.length - state.shown} left)`);
      b.type = "button";
      b.addEventListener("click", () => { state.shown += PAGE_SIZE; render(); });
      more.append(b);
    }
    if (state.query && !state.worldSearch) {
      const b = el("button", "btn", `Search all stations for “${state.query}”`);
      b.type = "button";
      b.style.marginTop = "8px";
      b.addEventListener("click", searchEverywhere);
      more.append(el("div"), b);
    }
    if (state.worldSearch) {
      const b = el("button", "btn", "Back to " + (state.genre === FAVOURITES ? "favourites" : state.genre));
      b.type = "button";
      b.addEventListener("click", () => { state.worldSearch = null; state.query = ""; $("search").value = ""; state.shown = PAGE_SIZE; renderCountries(); render(); });
      more.append(b);
    }
  }

  async function selectGenre(g) {
    state.genre = g;
    state.worldSearch = null;
    state.query = "";
    $("search").value = "";
    state.shown = PAGE_SIZE;
    store.set("genre", g);
    if (g === FAVOURITES) { state.list = favourites; renderCountries(); render(); return; }

    state.list = [];
    $("stations").replaceChildren();
    $("more").replaceChildren();
    renderGenres();
    ui.status("Finding " + g.toLowerCase() + " stations…");
    try {
      const list = await loadGenre(g);
      if (state.genre !== g) return; // user moved on
      state.list = list;
      renderCountries();
      render();
    } catch {
      if (state.genre !== g) return;
      ui.status("Couldn't reach the station directory. Check your connection and try again.");
      const b = el("button", "btn", "Try again");
      b.type = "button";
      b.addEventListener("click", () => selectGenre(g));
      $("more").replaceChildren(b);
    }
  }

  async function searchEverywhere() {
    const q = state.query.trim();
    if (!q) return;
    ui.status(`Searching all stations for “${q}”…`);
    try {
      const res = await api.search({ name: q, limit: 200 });
      state.worldSearch = res.filter(playable).map(slim);
      state.shown = PAGE_SIZE;
      renderCountries();
      render();
    } catch {
      ui.status("Couldn't reach the station directory. Check your connection and try again.");
    }
  }

  function showPlayer(s) {
    $("player").hidden = false;
    $("playerName").textContent = s.name;
    $("playerLogo").replaceWith(Object.assign(logoFor(s), { id: "playerLogo" }));
    const fav = $("playerFav");
    if (fav) { fav.dataset.id = s.stationuuid; fav.dataset.name = s.name; }
    syncFavButtons();
  }

  $("playerFav")?.addEventListener("click", () => {
    if (!player.current) return;
    toggleFav(player.current);
    if (state.genre === FAVOURITES && !state.worldSearch) { state.list = favourites; renderCountries(); render(); }
  });

  // ---- Wire up controls ----------------------------------------------------

  let typing;
  $("search").addEventListener("input", (e) => {
    clearTimeout(typing);
    typing = setTimeout(() => {
      state.query = e.target.value.trim();
      if (state.worldSearch && !state.query) state.worldSearch = null;
      state.shown = PAGE_SIZE;
      if (!state.worldSearch) render();
    }, 150);
  });
  $("search").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { state.query = e.target.value.trim(); if (state.query) searchEverywhere(); }
  });
  $("country").addEventListener("change", (e) => { state.country = e.target.value; state.shown = PAGE_SIZE; render(); });
  $("sort").addEventListener("change", (e) => { state.sort = e.target.value; render(); });

  const vol = $("volume");
  vol.value = store.get("volume", 0.8);
  vol.addEventListener("input", () => { audio.volume = Number(vol.value); store.set("volume", Number(vol.value)); });

  $("playBtn").addEventListener("click", () => {
    if (player.playing) {
      player.stop();
      document.querySelectorAll(".station.playing").forEach((n) => n.classList.remove("playing"));
    } else player.resume();
  });

  // iPad/iPhone: pages can't change the volume, so hide the slider there.
  try { const probe = new Audio(); probe.volume = 0.5; if (probe.volume !== 0.5) document.body.classList.add("no-volume"); } catch { /* ignore */ }

  // Lets the app open instantly and install to the Home Screen (needs https, e.g. GitHub Pages).
  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  selectGenre(state.genre);
})();
