import "./style.css";
import { setupDiscord } from "./discord";
import { SyncClient } from "./sync";
import type { RoomState, Track } from "./types";

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
  <header>
    <h1>Audius Together</h1>
    <span id="who"></span><span id="members"></span><span id="sync-status">connecting...</span>
  </header>
  <section class="search">
    <form id="search-form"><input id="q" placeholder="曲名・アーティストで検索" autocomplete="off" /><button>検索</button></form>
    <button id="trending">トレンド</button>
  </section>
  <p id="error" class="error"></p>
  <main>
    <ul id="results"></ul>
    <aside>
      <div id="now"></div>
      <h2>キュー</h2><ul id="queue"></ul><button id="clear">キューを空にする</button>
    </aside>
  </main>
  <footer id="player">
    <audio id="audio" preload="auto"></audio>
    <button id="toggle">▶ / ❚❚</button><button id="skip">スキップ</button>
    <input id="seek" type="range" min="0" max="1000" value="0" />
    <span id="time">0:00 / 0:00</span>
    <label>音量（自分だけ）<input id="vol" type="range" min="0" max="100" value="80" /></label>
  </footer>
`;

const $ = <T extends HTMLElement>(s: string) => document.querySelector<T>(s)!;
const audio = $<HTMLAudioElement>("#audio");
const resultsEl = $<HTMLUListElement>("#results");
const queueEl = $<HTMLUListElement>("#queue");
const nowEl = $<HTMLDivElement>("#now");
const seekEl = $<HTMLInputElement>("#seek");
const timeEl = $<HTMLSpanElement>("#time");
const errorEl = $<HTMLParagraphElement>("#error");

const fmt = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

let state: RoomState | null = null;
let loadedTrackId: string | null = null;
let seeking = false;

async function fetchTracks(url: string): Promise<Track[]> {
  const r = await fetch(url);
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data.data as Track[];
}

function renderResults(tracks: Track[], sync: SyncClient) {
  resultsEl.innerHTML = tracks.map((t, i) => `
    <li>
      ${t.artwork ? `<img src="/api/image?url=${encodeURIComponent(t.artwork)}" alt="" />` : ""}
      <div><strong>${esc(t.title)}</strong><small>${esc(t.user.name)} ・ ${fmt(t.duration)}</small></div>
      <button data-play="${i}">今すぐ再生</button><button data-add="${i}">キューへ</button>
    </li>`).join("");
  resultsEl.querySelectorAll<HTMLButtonElement>("[data-add]").forEach((b) =>
    b.onclick = () => sync.enqueue(tracks[Number(b.dataset.add)]));
  resultsEl.querySelectorAll<HTMLButtonElement>("[data-play]").forEach((b) =>
    b.onclick = () => sync.playNow(tracks[Number(b.dataset.play)]));
}

function expectedPosition(s: RoomState): number {
  // Server state position is stamped at serverNow; add elapsed local time while playing.
  if (!s.isPlaying) return s.position;
  return Math.min(s.position + (Date.now() - s.serverNow) / 1000, s.currentTrack?.duration || Infinity);
}

function applyState(s: RoomState, sync: SyncClient) {
  state = s;
  $("#members").textContent = ` ・ ${s.memberCount}人で同期中`;
  $("#sync-status").textContent = "synced";

  const cur = s.currentTrack;
  nowEl.innerHTML = cur
    ? `${cur.artwork ? `<img src="/api/image?url=${encodeURIComponent(cur.artwork)}" alt="" />` : ""}<strong>${esc(cur.title)}</strong><small>${esc(cur.user.name)}</small>`
    : "<strong>再生中の曲はありません</strong><small>検索してキューに入れてね</small>";

  queueEl.innerHTML = s.queue.map((t, i) =>
    `<li>${i + 1}. ${esc(t.title)} - ${esc(t.user.name)} <button data-rm="${i}">削除</button></li>`).join("") || "<li>空です</li>";
  queueEl.querySelectorAll<HTMLButtonElement>("[data-rm]").forEach((b) =>
    b.onclick = () => sync.remove(Number(b.dataset.rm)));

  if (!cur) { audio.removeAttribute("src"); loadedTrackId = null; return; }

  if (loadedTrackId !== cur.id) {
    loadedTrackId = cur.id;
    audio.src = `/api/audius/stream/${encodeURIComponent(cur.id)}`;
  }
  const expected = expectedPosition(s);
  if (Math.abs(audio.currentTime - expected) > 1.5 && !seeking) audio.currentTime = expected;
  if (s.isPlaying) audio.play().catch(() => { errorEl.textContent = "自動再生がブロックされました。再生ボタンを押してください。"; });
  else audio.pause();
}

async function main() {
  const ctx = await setupDiscord();
  $("#who").textContent = `${ctx.user.username}${ctx.isMock ? "" : " さん"}`;
  if (ctx.isMock) errorEl.textContent = "モックモード: Discord外で開いています。部屋は dev-room 固定です。";

  const sync = new SyncClient(ctx.roomId);
  sync.onState((s) => applyState(s, sync));
  sync.connect();

  $("#search-form").addEventListener("submit", async (e) => {
    e.preventDefault(); errorEl.textContent = "";
    try { renderResults(await fetchTracks(`/api/audius/search?query=${encodeURIComponent($<HTMLInputElement>("#q").value)}`), sync); }
    catch (err) { errorEl.textContent = String((err as Error).message || err); }
  });
  $("#trending").onclick = async () => {
    errorEl.textContent = "";
    try { renderResults(await fetchTracks("/api/audius/trending"), sync); }
    catch (err) { errorEl.textContent = String((err as Error).message || err); }
  };
  $("#toggle").onclick = () => { if (!state?.currentTrack) return; state.isPlaying ? sync.pause() : sync.resume(); };
  $("#skip").onclick = () => sync.skip();
  $("#clear").onclick = () => sync.clear();
  $<HTMLInputElement>("#vol").oninput = (e) => { audio.volume = Number((e.target as HTMLInputElement).value) / 100; };
  audio.volume = 0.8;

  seekEl.addEventListener("pointerdown", () => (seeking = true));
  seekEl.addEventListener("change", () => {
    if (state?.currentTrack) sync.seek((Number(seekEl.value) / 1000) * state.currentTrack.duration);
    seeking = false;
  });
  audio.addEventListener("ended", () => { if (state?.currentTrack) sync.ended(state.currentTrack.id); });

  window.setInterval(() => {
    if (!state?.currentTrack || seeking) return;
    const pos = state.isPlaying ? expectedPosition(state) : audio.currentTime;
    seekEl.value = String(state.currentTrack.duration ? Math.floor((pos / state.currentTrack.duration) * 1000) : 0);
    timeEl.textContent = `${fmt(pos)} / ${fmt(state.currentTrack.duration)}`;
    // Drift correction while playing
    if (state.isPlaying && Math.abs(audio.currentTime - pos) > 2.5) audio.currentTime = pos;
  }, 500);

  // Show trending on load
  try { renderResults(await fetchTracks("/api/audius/trending"), sync); } catch { /* Audius key may not be set yet */ }
}

main().catch((e) => { errorEl.textContent = `初期化エラー: ${String(e?.message || e)}`; });
