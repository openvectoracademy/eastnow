// functions/api/[[route]].js
// EAST NOW — Cloudflare Pages API (single catch-all)
// All tables auto-create on cold start.

/* ═══════════════════════════════════════════════════════════════
   UTILITIES
   ═══════════════════════════════════════════════════════════════ */

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...(init.headers || {}),
    },
    status: init.status || 200,
  });
}

function err(msg, status = 400) { return json({ error: msg }, { status }); }

function toHex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function fromHex(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

async function pbkdf2Hash(password, saltBytes, iterations = 100000) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(password), { name: 'PBKDF2' }, false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes, iterations, hash: 'SHA-256' },
    key, 256
  );
  return toHex(bits);
}

function randomToken() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return toHex(b);
}
function nowIso() { return new Date().toISOString(); }

/* ═══════════════════════════════════════════════════════════════
   TABLE BOOTSTRAP
   ═══════════════════════════════════════════════════════════════ */

let __tablesReady = false;

async function ensureTables(db) {
  if (__tablesReady) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS schedule (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_index INTEGER NOT NULL,
      type TEXT NOT NULL DEFAULT 'youtube',
      media_ref TEXT NOT NULL,
      title TEXT NOT NULL,
      source TEXT DEFAULT 'EAST NOW',
      show_tag TEXT DEFAULT 'FEATURED',
      duration_seconds INTEGER NOT NULL,
      active INTEGER DEFAULT 1
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_schedule_active ON schedule(active, order_index)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS control (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      revision INTEGER DEFAULT 0,
      headline TEXT,
      subheadline TEXT,
      breaking_tag TEXT DEFAULT 'LIVE',
      ticker_json TEXT,
      override_video_id TEXT,
      override_title TEXT,
      updated_at TEXT
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS admin_users (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      username TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      created_at TEXT
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS admin_sessions (
      token TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      created_at TEXT,
      expires_at TEXT
    )`),
    db.prepare(`INSERT OR IGNORE INTO control
      (id, revision, headline, subheadline, breaking_tag, ticker_json)
      VALUES (1, 0,
        'EAST NOW brings you continuous coverage around the clock',
        'EAST NOW', 'BREAKING NEWS',
        '["Welcome to EAST NOW","Broadcasting 24 hours a day","Stay with us for the latest updates"]')`),
    db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES ('epoch_start','2026-01-01T00:00:00Z')`),
  ]);
  __tablesReady = true;
}

/* ═══════════════════════════════════════════════════════════════
   AUTH HELPERS
   ═══════════════════════════════════════════════════════════════ */

async function requireAdmin(db, request) {
  const token = request.headers.get('x-admin-token') || '';
  if (!token) return { ok: false, reason: 'missing token' };
  const row = await db.prepare(
    `SELECT token, username, expires_at FROM admin_sessions WHERE token = ?`
  ).bind(token).first();
  if (!row) return { ok: false, reason: 'invalid token' };
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await db.prepare(`DELETE FROM admin_sessions WHERE token = ?`).bind(token).run();
    return { ok: false, reason: 'expired token' };
  }
  return { ok: true, username: row.username };
}

async function bumpRevision(db) {
  await db.prepare(
    `UPDATE control SET revision = revision + 1, updated_at = ? WHERE id = 1`
  ).bind(nowIso()).run();
}

/* ═══════════════════════════════════════════════════════════════
   SCHEDULE MATH (24/7 virtual loop)
   ═══════════════════════════════════════════════════════════════ */

async function computeScheduleState(db) {
  // Read active schedule in order
  const { results: items } = await db.prepare(
    `SELECT id, order_index, type, media_ref, title, source, show_tag, duration_seconds
     FROM schedule WHERE active = 1 ORDER BY order_index ASC, id ASC`
  ).all();

  // Read epoch
  const epochRow = await db.prepare(
    `SELECT value FROM settings WHERE key = 'epoch_start'`
  ).first();
  const epochMs = Date.parse(epochRow?.value || '2026-01-01T00:00:00Z');

  // Read control for revision + override
  const ctl = await db.prepare(`SELECT revision, override_video_id, override_title FROM control WHERE id = 1`).first();

  if (!items.length) {
    return { current: null, next: null, revision: ctl?.revision ?? 0, override: null };
  }

  const total = items.reduce((s, it) => s + Math.max(1, it.duration_seconds | 0), 0);
  const nowMs = Date.now();
  const elapsed = Math.max(0, ((nowMs - epochMs) / 1000) | 0) % total;

  let acc = 0, idx = 0;
  for (let i = 0; i < items.length; i++) {
    const d = Math.max(1, items[i].duration_seconds | 0);
    if (elapsed < acc + d) { idx = i; break; }
    acc += d;
  }
  const cur = items[idx];
  const offsetSeconds = elapsed - acc;
  const remainingSeconds = Math.max(1, (cur.duration_seconds | 0) - offsetSeconds);
  const nxt = items[(idx + 1) % items.length];

  const override = ctl?.override_video_id ? {
    media_ref: ctl.override_video_id,
    title: ctl.override_title || 'Override',
  } : null;

  return {
    revision: ctl?.revision ?? 0,
    current: {
      id: cur.id,
      type: cur.type,
      mediaRef: cur.media_ref,
      title: cur.title,
      source: cur.source,
      tag: cur.show_tag,
      durationSeconds: cur.duration_seconds | 0,
      offsetSeconds,
      remainingSeconds,
    },
    next: {
      id: nxt.id,
      type: nxt.type,
      mediaRef: nxt.media_ref,
      title: nxt.title,
      source: nxt.source,
      tag: nxt.show_tag,
      durationSeconds: nxt.duration_seconds | 0,
    },
    override,
  };
}

/* ═══════════════════════════════════════════════════════════════
   ROUTER
   ═══════════════════════════════════════════════════════════════ */

export async function onRequest(context) {
  const { request, env } = context;
  const db = env.DB;

  if (!db) return err('D1 binding "DB" not configured', 500);

  try { await ensureTables(db); } catch (e) { return err('DB init failed: ' + e.message, 500); }

  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/?/, '');
  const method = request.method.toUpperCase();
  const parts = path.split('/').filter(Boolean);

  try {
    // ── PUBLIC ─────────────────────────────────────────────────
    if (path === 'live' && method === 'GET') {
      const c = await db.prepare(
        `SELECT revision, headline, subheadline, breaking_tag, ticker_json,
                override_video_id, override_title FROM control WHERE id = 1`
      ).first();
      const ticker = (() => { try { return JSON.parse(c?.ticker_json || '[]'); } catch { return []; } })();
      return json({
        revision: c?.revision ?? 0,
        headline: c?.headline || '',
        subheadline: c?.subheadline || '',
        breaking_tag: c?.breaking_tag || 'LIVE',
        ticker,
        override_video_id: c?.override_video_id || null,
        override_title: c?.override_title || null,
      }, {
        headers: { 'cache-control': 'public, max-age=3, s-maxage=3' },
      });
    }

    if (path === 'schedule-state' && method === 'GET') {
      const state = await computeScheduleState(db);
      return json(state);
    }

    // ── AUTH ───────────────────────────────────────────────────
    if (path === 'admin/status' && method === 'GET') {
      const u = await db.prepare(`SELECT username FROM admin_users WHERE id = 1`).first();
      return json({ setupRequired: !u });
    }

    if (path === 'admin/setup' && method === 'POST') {
      const existing = await db.prepare(`SELECT id FROM admin_users WHERE id = 1`).first();
      if (existing) return err('Admin already exists', 409);

      const body = await request.json().catch(() => null);
      const username = (body?.username || '').trim();
      const password = (body?.password || '');
      if (!username || username.length < 3) return err('Username must be at least 3 characters');
      if (!password || password.length < 6) return err('Password must be at least 6 characters');

      const salt = new Uint8Array(16);
      crypto.getRandomValues(salt);
      const saltHex = toHex(salt);
      const hash = await pbkdf2Hash(password, salt, 100000);

      await db.prepare(
        `INSERT INTO admin_users (id, username, password_hash, salt, created_at)
         VALUES (1, ?, ?, ?, ?)`
      ).bind(username, hash, saltHex, nowIso()).run();

      // Auto-login after setup
      const token = randomToken();
      const exp = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
      await db.prepare(
        `INSERT INTO admin_sessions (token, username, created_at, expires_at)
         VALUES (?, ?, ?, ?)`
      ).bind(token, username, nowIso(), exp).run();

      return json({ ok: true, token, username });
    }

    if (path === 'admin/login' && method === 'POST') {
      const body = await request.json().catch(() => null);
      const username = (body?.username || '').trim();
      const password = (body?.password || '');
      if (!username || !password) return err('Username and password required');

      const u = await db.prepare(
        `SELECT username, password_hash, salt FROM admin_users WHERE id = 1`
      ).first();
      if (!u) return err('No admin account exists', 404);
      if (u.username !== username) return err('Invalid credentials', 401);

      const hash = await pbkdf2Hash(password, fromHex(u.salt), 100000);
      if (hash !== u.password_hash) return err('Invalid credentials', 401);

      const token = randomToken();
      const exp = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
      await db.prepare(
        `INSERT INTO admin_sessions (token, username, created_at, expires_at)
         VALUES (?, ?, ?, ?)`
      ).bind(token, username, nowIso(), exp).run();

      return json({ ok: true, token, username });
    }

    if (path === 'admin/logout' && method === 'POST') {
      const token = request.headers.get('x-admin-token') || '';
      if (token) await db.prepare(`DELETE FROM admin_sessions WHERE token = ?`).bind(token).run();
      return json({ ok: true });
    }

    // ── ADMIN (require session) ────────────────────────────────
    if (path.startsWith('admin/')) {
      const auth = await requireAdmin(db, request);
      if (!auth.ok) return err('Unauthorized: ' + auth.reason, 401);

      // /api/admin/schedule
      if (path === 'admin/schedule' && method === 'GET') {
        const { results } = await db.prepare(
          `SELECT * FROM schedule ORDER BY order_index ASC, id ASC`
        ).all();
        return json({ items: results });
      }

      if (path === 'admin/schedule' && method === 'POST') {
        const b = await request.json().catch(() => null);
        if (!b) return err('Invalid JSON');
        const type = (b.type || 'youtube').toLowerCase();
        const mediaRef = (b.media_ref || '').trim();
        const title = (b.title || '').trim();
        const duration = parseInt(b.duration_seconds, 10);
        if (!mediaRef) return err('media_ref required');
        if (!title) return err('title required');
        if (!duration || duration < 1) return err('duration_seconds must be >= 1');

        const maxRow = await db.prepare(`SELECT MAX(order_index) AS m FROM schedule`).first();
        const order = (maxRow?.m ?? 0) + 10;

        const res = await db.prepare(
          `INSERT INTO schedule (order_index, type, media_ref, title, source, show_tag, duration_seconds, active)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
        ).bind(order, type, mediaRef, title, b.source || 'EAST NOW', b.show_tag || 'FEATURED', duration).run();

        await bumpRevision(db);
        return json({ ok: true, id: res.meta?.last_row_id });
      }

      if (parts[1] === 'schedule' && parts[2] && method === 'PUT') {
        const id = parseInt(parts[2], 10);
        const b = await request.json().catch(() => null);
        if (!b) return err('Invalid JSON');

        await db.prepare(
          `UPDATE schedule SET
            type = COALESCE(?, type),
            media_ref = COALESCE(?, media_ref),
            title = COALESCE(?, title),
            source = COALESCE(?, source),
            show_tag = COALESCE(?, show_tag),
            duration_seconds = COALESCE(?, duration_seconds),
            active = COALESCE(?, active)
           WHERE id = ?`
        ).bind(
          b.type ?? null, b.media_ref ?? null, b.title ?? null,
          b.source ?? null, b.show_tag ?? null,
          b.duration_seconds ? parseInt(b.duration_seconds, 10) : null,
          (b.active === undefined ? null : (b.active ? 1 : 0)),
          id
        ).run();

        await bumpRevision(db);
        return json({ ok: true });
      }

      if (parts[1] === 'schedule' && parts[2] && method === 'DELETE') {
        const id = parseInt(parts[2], 10);
        await db.prepare(`DELETE FROM schedule WHERE id = ?`).bind(id).run();
        await bumpRevision(db);
        return json({ ok: true });
      }

      // /api/admin/reorder — body: { items: [{id, order_index}, ...] }
      if (path === 'admin/reorder' && method === 'POST') {
        const b = await request.json().catch(() => null);
        if (!b || !Array.isArray(b.items)) return err('items array required');
        const stmts = b.items.map(it =>
          db.prepare(`UPDATE schedule SET order_index = ? WHERE id = ?`).bind(it.order_index, it.id)
        );
        if (stmts.length) await db.batch(stmts);
        await bumpRevision(db);
        return json({ ok: true, updated: stmts.length });
      }

      // /api/admin/control
      if (path === 'admin/control' && method === 'POST') {
        const b = await request.json().catch(() => null);
        if (!b) return err('Invalid JSON');
        const tickerJson = Array.isArray(b.ticker) ? JSON.stringify(b.ticker) : null;

        await db.prepare(
          `UPDATE control SET
            headline = COALESCE(?, headline),
            subheadline = COALESCE(?, subheadline),
            breaking_tag = COALESCE(?, breaking_tag),
            ticker_json = COALESCE(?, ticker_json),
            updated_at = ?
           WHERE id = 1`
        ).bind(
          b.headline ?? null, b.subheadline ?? null,
          b.breaking_tag ?? null, tickerJson, nowIso()
        ).run();

        await bumpRevision(db);
        return json({ ok: true });
      }

      // /api/admin/override — set
      if (path === 'admin/override' && method === 'POST') {
        const b = await request.json().catch(() => null);
        if (!b || !b.media_ref) return err('media_ref required');
        await db.prepare(
          `UPDATE control SET override_video_id = ?, override_title = ?, updated_at = ? WHERE id = 1`
        ).bind(b.media_ref, b.title || 'Live Override', nowIso()).run();
        await bumpRevision(db);
        return json({ ok: true });
      }

      // /api/admin/override — clear
      if (path === 'admin/override' && method === 'DELETE') {
        await db.prepare(
          `UPDATE control SET override_video_id = NULL, override_title = NULL, updated_at = ? WHERE id = 1`
        ).bind(nowIso()).run();
        await bumpRevision(db);
        return json({ ok: true });
      }

      return err('Unknown admin route: ' + path, 404);
    }

    return err('Unknown route: ' + path, 404);
  } catch (e) {
    return err('Server error: ' + (e.message || e), 500);
  }
}
