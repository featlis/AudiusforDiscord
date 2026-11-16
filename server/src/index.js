import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { WebSocketServer } from "ws";

dotenv.config({ path: path.resolve(process.cwd(), "../.env") });
dotenv.config(); // server/.env as fallback

const PORT = process.env.PORT || 3001;
const AUDIUS_API_KEY = process.env.AUDIUS_API_KEY || "";
const AUDIUS_APP_NAME = process.env.AUDIUS_APP_NAME || "AudiusDiscordActivity";
const AUDIUS_BASE = "https://api.audius.co/v1";
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || "";
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || "";

if (!AUDIUS_API_KEY) console.warn("[warn] AUDIUS_API_KEY is empty - Audius search/trending may be rate-limited or rejected.");
if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET) console.warn("[warn] DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET are empty - /api/token will fail until set.");

const app = express();
app.use(cors());
app.use(express.json());

function audiusHeaders() {
  return AUDIUS_API_KEY ? { "x-api-key": AUDIUS_API_KEY } : {};
}

function normalizeTrack(t) {
  if (!t) return null;
  return {
    id: t.id,
    title: t.title || "Unknown title",
    duration: t.duration || 0, // seconds
    permalink: t.permalink ? `https://audius.co${t.permalink}` : null,
    artwork: t.artwork?.["480x480"] || t.artwork?.["150x150"] || null,
    genre: t.genre || null,
    playCount: t.play_count ?? 0,
    user: { handle: t.user?.handle || "", name: t.user?.name || "Unknown artist" },
  };
}

async function audiusGet(pathname, params = {}) {
  const url = new URL(`${AUDIUS_BASE}${pathname}`);
  url.searchParams.set("app_name", AUDIUS_APP_NAME);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== "") url.searchParams.set(k, String(v));
  const res = await fetch(url, { headers: audiusHeaders() });
  if (!res.ok) throw new Error(`Audius ${res.status}: ${await res.text().catch(() => "")}`);
  return res.json();
}

app.get("/api/health", (_req, res) => res.json({ ok: true, audiusKeySet: Boolean(AUDIUS_API_KEY) }));

// --- Discord OAuth code -> access_token (Embedded App SDK authenticate flow) ---
app.post("/api/token", async (req, res) => {
  try {
    const { code } = req.body || {};
    if (!code) return res.status(400).json({ error: "code is required" });
    const body = new URLSearchParams({
      client_id: DISCORD_CLIENT_ID,
      client_secret: DISCORD_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
    });
    const r = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);
    res.json({ access_token: data.access_token });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// --- Audius proxy (keeps API key server-side, avoids Discord CSP issues) ---
app.get("/api/audius/search", async (req, res) => {
  try {
    const data = await audiusGet("/tracks/search", { query: req.query.query || "", limit: req.query.limit || 20, sort_method: "relevant" });
    res.json({ data: (data.data || []).map(normalizeTrack).filter(Boolean) });
  } catch (e) { res.status(502).json({ error: String(e?.message || e) }); }
});

app.get("/api/audius/trending", async (req, res) => {
  try {
    const data = await audiusGet("/tracks/trending", { limit: req.query.limit || 20, genre: req.query.genre, time: req.query.time || "week" });
    res.json({ data: (data.data || []).map(normalizeTrack).filter(Boolean) });
  } catch (e) { res.status(502).json({ error: String(e?.message || e) }); }
});

// Artwork lives on many different Audius content nodes, so Discord's CSP
// would block direct <img> loads. Proxy images through this server instead.
// NOTE: tighten this allowlist before public release.
app.get("/api/image", async (req, res) => {
  try {
    const url = new URL(String(req.query.url || ""));
    if (url.protocol !== "https:") return res.status(400).send("https only");
    const upstream = await fetch(url);
    const type = upstream.headers.get("content-type") || "";
    if (!upstream.ok || !type.startsWith("image/")) return res.status(502).send("not an image");
    res.setHeader("content-type", type);
    res.setHeader("cache-control", "public, max-age=86400");
    if (upstream.body) Readable.fromWeb(upstream.body).pipe(res); else res.end();
  } catch (e) { res.status(400).json({ error: String(e?.message || e) }); }
});

app.get("/api/audius/stream/:id", async (req, res) => {
  try {
    const url = `${AUDIUS_BASE}/tracks/${encodeURIComponent(req.params.id)}/stream?app_name=${encodeURIComponent(AUDIUS_APP_NAME)}`;
    const headers = { ...audiusHeaders() };
    if (req.headers.range) headers.Range = req.headers.range; // seeking support
    const upstream = await fetch(url, { headers, redirect: "follow" });
    if (!upstream.ok && upstream.status !== 206) return res.status(502).send(`Audius stream ${upstream.status}`);
    res.status(upstream.status);
    for (const k of ["content-type", "content-length", "content-range", "accept-ranges"]) {
      const v = upstream.headers.get(k); if (v) res.setHeader(k, v);
    }
    if (upstream.body) Readable.fromWeb(upstream.body).pipe(res); else res.end();
  } catch (e) { res.status(502).json({ error: String(e?.message || e) }); }
});

// Serve built client in production (single origin = single Discord URL Mapping)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.resolve(__dirname, "../../client/dist");
app.use(express.static(clientDist));
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  res.sendFile(path.join(clientDist, "index.html"), (err) => { if (err) res.status(404).send("Client not built yet. Run: npm run build"); });
});

const server = http.createServer(app);

// ---------------- Synchronized playback rooms ----------------
// Room state is authoritative on the server. Clients never trust their own
// clock alone: position = positionBase + (serverNow - startedAt) while playing.
const rooms = new Map();

function getRoom(id) {
  if (!rooms.has(id)) {
    rooms.set(id, {
      id, queue: [], currentTrack: null, isPlaying: false,
      positionBase: 0, startedAt: null, version: 0, lastAdvanceAt: 0, members: new Set(),
    });
  }
  return rooms.get(id);
}
function positionNow(room) {
  if (!room.currentTrack) return 0;
  if (!room.isPlaying || !room.startedAt) return room.positionBase;
  return Math.min(room.positionBase + (Date.now() - room.startedAt) / 1000, room.currentTrack.duration || Infinity);
}
function publicState(room) {
  return {
    queue: room.queue, currentTrack: room.currentTrack, isPlaying: room.isPlaying,
    position: positionNow(room), serverNow: Date.now(), version: room.version,
    memberCount: room.members.size,
  };
}
function broadcast(room) {
  const msg = JSON.stringify({ type: "state", state: publicState(room) });
  for (const ws of room.members) if (ws.readyState === ws.OPEN) ws.send(msg);
}
function startTrack(room, track, position = 0) {
  room.currentTrack = track; room.isPlaying = true; room.positionBase = position; room.startedAt = Date.now(); room.version++;
}
function playNext(room) {
  const next = room.queue.shift();
  if (next) startTrack(room, next, 0);
  else { room.currentTrack = null; room.isPlaying = false; room.positionBase = 0; room.startedAt = null; room.version++; }
}

const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (ws) => {
  let room = null;
  ws.on("message", (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.type === "join") {
      room = getRoom(String(m.roomId || "dev-room"));
      room.members.add(ws);
      ws.send(JSON.stringify({ type: "state", state: publicState(room) }));
      broadcast(room); return;
    }
    if (!room) return;
    switch (m.type) {
      case "enqueue":
        if (m.track) { room.queue.push(m.track); if (!room.currentTrack) playNext(room); else room.version++; }
        break;
      case "playNow":
        if (m.track) startTrack(room, m.track, 0);
        break;
      case "pause":
        room.positionBase = positionNow(room); room.isPlaying = false; room.startedAt = null; room.version++;
        break;
      case "resume":
        if (room.currentTrack) { room.isPlaying = true; room.startedAt = Date.now(); room.version++; }
        break;
      case "seek": {
        const pos = Math.max(0, Number(m.position) || 0);
        room.positionBase = pos; room.startedAt = room.isPlaying ? Date.now() : null; room.version++;
        break;
      }
      case "skip": playNext(room); break;
      case "remove": room.queue.splice(Number(m.index), 1); room.version++; break;
      case "clear": room.queue = []; room.version++; break;
      case "ended":
        // Many clients fire 'ended' at once - advance only once per track.
        if (room.currentTrack && m.trackId === room.currentTrack.id && Date.now() - room.lastAdvanceAt > 2000) {
          room.lastAdvanceAt = Date.now(); playNext(room);
        }
        break;
      default: return;
    }
    broadcast(room);
  });
  ws.on("close", () => {
    if (room) { room.members.delete(ws); if (room.members.size === 0) rooms.delete(room.id); else broadcast(room); }
  });
});

server.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}  (ws: /ws)`));
