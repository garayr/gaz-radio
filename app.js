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
  // Gaz's Cloudflare helper: song titles for more stations and favourites sync.
  // Leave empty to run without it.
  const HELPER_URL = "https://gaz-radio.garethayres.workers.dev";
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
    sync.changed();
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
    async helper(url, station) {
      const data = await fetchJson(`${HELPER_URL}/meta?url=${encodeURIComponent(url.href)}`);
      return tidySong(data && data.title, station);
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
      const key = station.url_resolved;
      const known = songSource[key];
      if (known === "none") return null;
      const all = HELPER_URL ? ["helper", "icecast", "shoutcast"] : ["icecast", "shoutcast"];
      const order = known ? [known, ...all.filter((k) => k !== known)] : all;
      let reachable = false;
      for (const kind of order) {
        try {
          const song = await songReaders[kind](url, station);
          reachable = true;
          if (song) { songSource[key] = kind; return song; }
          if (known === kind) return ""; // same source as before, just between songs
        } catch { /* not readable this way */ }
      }
      if (!reachable && !known) { songSource[key] = "none"; return null; }
      return "";
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

  // ---- Sleep timer and wake-up alarm ---------------------------------------
  // Sleep: stops the radio after a set time (fading out where the browser allows).
  // Wake: starts a chosen station at a set time. Web pages can only do this while
  // they are open, so the screen is kept awake while an alarm is set. If the
  // browser still refuses to start sound by itself, a "tap to play" screen appears.

  const FADE_MS = 60000;
  const userVolume = () => Number($("volume").value) || 0.8;
  const pad = (n) => String(n).padStart(2, "0");
  const clock = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

  const sleep = {
    endsAt: 0,
    set(minutes) {
      this.endsAt = minutes ? Date.now() + minutes * 60000 : 0;
      if (!minutes) audio.volume = userVolume();
      timers.refresh();
    },
    tick(now) {
      if (!this.endsAt) return;
      const left = this.endsAt - now;
      if (left <= 0) {
        this.endsAt = 0;
        if (player.playing) {
          player.stop();
          document.querySelectorAll(".station.playing").forEach((n) => n.classList.remove("playing"));
          ui.playerState("Sleep timer stopped the radio. Good night.");
        }
        audio.volume = userVolume();
      } else if (left < FADE_MS && player.playing) {
        audio.volume = userVolume() * (left / FADE_MS);
      }
    },
  };

  const alarm = {
    data: store.get("alarm", null), // { time: "07:00", station, repeat, next }
    wakeLock: null,
    nextFor(time, from = new Date()) {
      const [h, m] = time.split(":").map(Number);
      const d = new Date(from);
      d.setHours(h, m, 0, 0);
      if (d.getTime() <= from.getTime()) d.setDate(d.getDate() + 1);
      return d.getTime();
    },
    set(time, station, repeat) {
      this.data = { time, station: slim(station), repeat: !!repeat, next: this.nextFor(time) };
      store.set("alarm", this.data);
      unlockAudio();
      this.keepAwake();
      timers.refresh();
    },
    clear() {
      this.data = null;
      store.set("alarm", null);
      this.releaseAwake();
      timers.refresh();
    },
    async keepAwake() {
      if (!this.data || this.wakeLock || !("wakeLock" in navigator) || document.hidden) return;
      try {
        this.wakeLock = await navigator.wakeLock.request("screen");
        this.wakeLock.addEventListener("release", () => { this.wakeLock = null; });
      } catch { /* not allowed right now */ }
    },
    releaseAwake() { if (this.wakeLock) { this.wakeLock.release().catch(() => {}); this.wakeLock = null; } },
    tick(now) {
      if (!this.data || now < this.data.next) return;
      const late = now - this.data.next;
      const station = this.data.station;
      if (this.data.repeat) {
        this.data.next = this.nextFor(this.data.time, new Date(now + 60000));
        store.set("alarm", this.data);
      } else {
        this.data = null;
        store.set("alarm", null);
        this.releaseAwake();
      }
      timers.refresh();
      if (late < 30 * 60000) wakeUp(station); // device was asleep for ages: don't go off at lunchtime
    },
  };

  function wakeUp(station) {
    sleep.endsAt = 0;
    showPlayer(station);
    player.play(station);
    // Gentle fade-in where the browser allows volume changes (not on iPad/iPhone).
    const target = userVolume();
    const start = Date.now();
    audio.volume = 0;
    const fade = setInterval(() => {
      const t = Math.min(1, (Date.now() - start) / FADE_MS);
      audio.volume = target * t;
      if (t >= 1 || !player.playing && Date.now() - start > 15000) { clearInterval(fade); audio.volume = target; }
    }, 500);
    // If the browser blocked the sound, ask for a tap instead.
    setTimeout(() => { if (!player.playing || audio.paused) showWakeScreen(station); }, 4000);
  }

  function showWakeScreen(station) {
    const scr = $("wakeScreen");
    if (!scr) return;
    $("wakeStation").textContent = station.name;
    scr.hidden = false;
    $("wakeTime").textContent = clock(new Date());
  }
  $("wakeScreen")?.addEventListener("click", () => {
    $("wakeScreen").hidden = true;
    const s = player.current;
    if (s && !player.playing) { audio.volume = userVolume(); player.play(s); }
  });

  // iPad/iPhone only let a page start sound later if it has played something
  // after a tap, so play a moment of silence when the alarm is set.
  function unlockAudio() {
    if (player.playing) return;
    try {
      const rate = 8000, n = 800, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
      const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
      w(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); w(8, "WAVEfmt "); v.setUint32(16, 16, true);
      v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true);
      v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, "data"); v.setUint32(40, n * 2, true);
      const url = URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
      audio.src = url;
      audio.play().then(() => { audio.pause(); audio.removeAttribute("src"); audio.load(); ui.playButton(false); URL.revokeObjectURL(url); })
        .catch(() => URL.revokeObjectURL(url));
    } catch { /* ignore */ }
  }

  const timers = {
    refresh() {
      const now = Date.now();
      // Badge on the player-bar button
      const badge = $("timerBadge");
      const btn = $("timerBtn");
      let label = "";
      if (sleep.endsAt) label = Math.max(1, Math.ceil((sleep.endsAt - now) / 60000)) + "m";
      else if (alarm.data) label = alarm.data.time;
      if (badge) { badge.textContent = label; badge.hidden = !label; }
      if (btn) btn.classList.toggle("active", !!label);

      // Sleep section
      document.querySelectorAll("[data-sleep]").forEach((b) => b.setAttribute("aria-pressed", "false"));
      $("sleepStatus").textContent = sleep.endsAt
        ? `Radio will stop at ${clock(new Date(sleep.endsAt))} (in ${Math.max(1, Math.ceil((sleep.endsAt - now) / 60000))} min).`
        : "Off";

      // Alarm section
      const on = !!alarm.data;
      $("alarmSet").hidden = on;
      $("alarmOn").hidden = !on;
      if (on) {
        const d = new Date(alarm.data.next);
        const day = d.toDateString() === new Date().toDateString() ? "today" : "tomorrow";
        $("alarmSummary").textContent = `${alarm.data.station.name} at ${alarm.data.time} ${day}${alarm.data.repeat ? ", every day" : ""}.`;
      }
      $("playerFav") && document.body.classList.toggle("alarm-armed", on);
    },
    fillStations() {
      const sel = $("alarmStation");
      const options = [];
      const seen = new Set();
      const add = (s) => { if (s && !seen.has(s.stationuuid)) { seen.add(s.stationuuid); options.push(s); } };
      add(player.current);
      favourites.forEach(add);
      sel.replaceChildren(...options.map((s) => new Option(s.name, s.stationuuid)));
      sel.disabled = !options.length;
      $("alarmBtn").disabled = !options.length;
      $("alarmHint").textContent = options.length ? "" : "Play a station or add favourites first.";
      sel._stations = options;
    },
  };

  const sheet = $("timerSheet");
  $("timerBtn")?.addEventListener("click", () => {
    timers.fillStations();
    if (!$("alarmTime").value) $("alarmTime").value = store.get("alarmTimeLast", "07:00");
    timers.refresh();
    sheet.showModal();
  });
  $("timerClose").addEventListener("click", () => sheet.close());
  sheet.addEventListener("click", (e) => { if (e.target === sheet) sheet.close(); });
  document.querySelectorAll("[data-sleep]").forEach((b) =>
    b.addEventListener("click", () => { sleep.set(Number(b.dataset.sleep)); if (Number(b.dataset.sleep)) b.setAttribute("aria-pressed", "true"); })
  );
  $("alarmBtn").addEventListener("click", () => {
    const time = $("alarmTime").value;
    const sel = $("alarmStation");
    const station = (sel._stations || []).find((s) => s.stationuuid === sel.value);
    if (!time || !station) return;
    store.set("alarmTimeLast", time);
    alarm.set(time, station, $("alarmRepeat").checked);
  });
  $("alarmOff").addEventListener("click", () => alarm.clear());

  document.addEventListener("visibilitychange", () => { if (!document.hidden) { alarm.keepAwake(); tickTimers(); } });
  function tickTimers() { const now = Date.now(); sleep.tick(now); alarm.tick(now); }
  setInterval(() => { tickTimers(); if (sleep.endsAt || alarm.data) timers.refresh(); }, 1000);
  // While audio plays, phones keep sending these events even with the screen off,
  // so the sleep timer still fires if the page's own clock has been slowed down.
  let lastTU = 0;
  audio.addEventListener("timeupdate", () => { const now = Date.now(); if (now - lastTU > 5000) { lastTU = now; tickTimers(); } });
  if (alarm.data) { alarm.data.next = Math.max(alarm.data.next, 0); alarm.keepAwake(); }
  timers.refresh();

  // ---- Favourites sync (via the Cloudflare helper) -------------------------
  // Each device that enters the same sync code shares one favourites list.

  const sync = {
    code: store.get("syncCode", ""),
    updated: store.get("syncUpdated", 0), // server time of the list we last saw
    dirty: store.get("syncDirty", false), // local change not yet saved online
    timer: null,
    busy: false,
    get on() { return !!(HELPER_URL && this.code); },
    newCode() {
      const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
      const bytes = crypto.getRandomValues(new Uint8Array(12));
      const chars = [...bytes].map((b) => abc[b % abc.length]).join("");
      return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
    },
    async request(method, body) {
      const res = await fetch(`${HELPER_URL}/favs/${encodeURIComponent(this.code)}`, {
        method, cache: "no-store",
        headers: body ? { "Content-Type": "application/json" } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    },
    remember(updated) {
      this.updated = updated || 0;
      store.set("syncUpdated", this.updated);
      store.set("syncLast", Date.now());
    },
    setDirty(v) { this.dirty = v; store.set("syncDirty", v); },
    apply(list) {
      favourites = list;
      store.set("favourites", favourites);
      syncFavButtons();
      if (state.genre === FAVOURITES && !state.worldSearch) { state.list = favourites; renderCountries(); render(); }
    },
    merge(a, b) {
      const byId = new Map();
      [...a, ...b].forEach((s) => { if (s && s.stationuuid && !byId.has(s.stationuuid)) byId.set(s.stationuuid, s); });
      return [...byId.values()];
    },
    async link(code) {
      this.code = code;
      store.set("syncCode", code);
      const remote = await this.request("GET");
      const merged = this.merge(favourites, remote.favourites || []);
      const saved = await this.request("PUT", { favourites: merged });
      this.apply(saved.favourites);
      this.remember(saved.updated);
      this.setDirty(false);
    },
    unlink() {
      this.code = ""; store.set("syncCode", "");
      this.remember(0); this.setDirty(false);
    },
    changed() { // called after a star is added or removed here
      if (!this.on) return;
      this.setDirty(true);
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.push(), 1500);
    },
    async push() {
      if (!this.on) return;
      try {
        const saved = await this.request("PUT", { favourites });
        this.remember(saved.updated);
        this.setDirty(false);
      } catch { /* offline: try again on the next check */ }
      settings.refresh();
    },
    async pull() {
      if (!this.on || this.busy) return;
      this.busy = true;
      try {
        const remote = await this.request("GET");
        if (this.dirty) {
          // We changed something while offline: keep both sides, then save.
          const saved = await this.request("PUT", { favourites: this.merge(favourites, remote.favourites || []) });
          this.apply(saved.favourites); this.remember(saved.updated); this.setDirty(false);
        } else if ((remote.updated || 0) > this.updated) {
          this.apply(remote.favourites || []); this.remember(remote.updated);
        } else {
          store.set("syncLast", Date.now());
        }
      } catch { /* offline */ }
      finally { this.busy = false; settings.refresh(); }
    },
  };

  const settings = {
    refresh() {
      const box = $("syncBox");
      if (!box) return;
      box.hidden = !HELPER_URL;
      $("syncOff").hidden = sync.on;
      $("syncOnBox").hidden = !sync.on;
      if (sync.on) {
        $("syncCodeShow").textContent = sync.code;
        const last = store.get("syncLast", 0);
        $("syncStatus").textContent = sync.dirty ? "Waiting to sync…" : last ? `Synced at ${clock(new Date(last))}` : "";
      }
    },
  };

  $("syncCreate")?.addEventListener("click", async () => {
    $("syncMsg").textContent = "Setting up…";
    try { await sync.link(sync.newCode()); $("syncMsg").textContent = "Done. Enter this code on your other devices."; }
    catch { sync.unlink(); $("syncMsg").textContent = "Couldn't reach the sync service. Try again."; }
    settings.refresh();
  });
  $("syncJoin")?.addEventListener("click", async () => {
    const code = $("syncInput").value.trim().toUpperCase().replace(/\s+/g, "");
    if (!/^[A-Z0-9-]{12,64}$/.test(code)) { $("syncMsg").textContent = "That code doesn't look right. It's like ABCD-EFGH-JKLM."; return; }
    $("syncMsg").textContent = "Linking…";
    try { await sync.link(code); $("syncMsg").textContent = "Linked. Favourites from both devices are now combined."; $("syncInput").value = ""; }
    catch { sync.unlink(); $("syncMsg").textContent = "Couldn't reach the sync service. Try again."; }
    settings.refresh();
  });
  $("syncCopy")?.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(sync.code); $("syncMsg").textContent = "Code copied."; }
    catch { $("syncMsg").textContent = "Copy didn't work. Write the code down instead."; }
  });
  $("syncStop")?.addEventListener("click", () => {
    sync.unlink(); $("syncMsg").textContent = "This device has stopped syncing. Its favourites stay here.";
    settings.refresh();
  });
  $("syncOpen")?.addEventListener("click", () => { $("timerBtn")?.click(); setTimeout(() => $("syncBox")?.scrollIntoView({ block: "start" }), 50); });

  document.addEventListener("visibilitychange", () => { if (!document.hidden) sync.pull(); });
  setInterval(() => { if (!document.hidden) sync.pull(); }, 120000);
  settings.refresh();
  sync.pull();

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
