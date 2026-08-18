require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : false,
});

const OWNER_PIN = process.env.OWNER_PIN || '0000';
const MANAGER_PIN = process.env.MANAGER_PIN || '1111';
const SYSADMIN_PIN = process.env.SYSADMIN_PIN || '2222';

// --- auth: PIN comes in header 'x-pin', resolves to a role ---
function resolveRole(pin) {
  if (pin === OWNER_PIN) return 'owner';
  if (pin === MANAGER_PIN) return 'manager';
  if (pin === SYSADMIN_PIN) return 'sysadmin';
  return null;
}

function requireRole(...allowed) {
  return (req, res, next) => {
    const pin = req.header('x-pin');
    const role = resolveRole(pin);
    if (!role) return res.status(401).json({ error: 'invalid_pin' });
    if (!allowed.includes(role)) return res.status(403).json({ error: 'forbidden_for_role', role });
    req.role = role;
    next();
  };
}

// login check (frontend calls this once to know which role it got and store it)
app.post('/api/login', (req, res) => {
  const { pin } = req.body;
  const role = resolveRole(pin);
  if (!role) return res.status(401).json({ error: 'invalid_pin' });
  res.json({ role });
});

// --- projects ---
app.get('/api/projects', requireRole('owner', 'manager'), async (req, res) => {
  const projects = await pool.query('SELECT * FROM projects ORDER BY created_at ASC');
  const tasks = await pool.query('SELECT * FROM tasks ORDER BY created_at ASC');
  const comments = await pool.query('SELECT * FROM comments ORDER BY created_at ASC');

  const tasksByProject = {};
  for (const t of tasks.rows) {
    (tasksByProject[t.project_id] ||= []).push({ ...t, comments: [] });
  }
  const taskById = {};
  for (const list of Object.values(tasksByProject)) {
    for (const t of list) taskById[t.id] = t;
  }
  for (const c of comments.rows) {
    if (taskById[c.task_id]) taskById[c.task_id].comments.push(c);
  }

  const result = projects.rows.map(p => ({ ...p, tasks: tasksByProject[p.id] || [] }));
  res.json(result);
});

app.post('/api/projects', requireRole('owner'), async (req, res) => {
  const { name, description, status } = req.body;
  const r = await pool.query(
    'INSERT INTO projects (name, description, status) VALUES ($1,$2,$3) RETURNING *',
    [name, description || null, status || 'active']
  );
  res.json(r.rows[0]);
});

app.patch('/api/projects/:id', requireRole('owner'), async (req, res) => {
  const { name, description, status } = req.body;
  const r = await pool.query(
    `UPDATE projects SET
       name = COALESCE($1, name),
       description = COALESCE($2, description),
       status = COALESCE($3, status),
       updated_at = now()
     WHERE id = $4 RETURNING *`,
    [name, description, status, req.params.id]
  );
  res.json(r.rows[0]);
});

// --- tasks ---
app.post('/api/projects/:id/tasks', requireRole('owner'), async (req, res) => {
  const { title, description, status } = req.body;
  const r = await pool.query(
    'INSERT INTO tasks (project_id, title, description, status) VALUES ($1,$2,$3,$4) RETURNING *',
    [req.params.id, title, description || null, status || 'todo']
  );
  res.json(r.rows[0]);
});

// owner can edit everything; manager can only change status
app.patch('/api/tasks/:id', requireRole('owner', 'manager'), async (req, res) => {
  const { title, description, status } = req.body;
  if (req.role === 'manager') {
    if (title !== undefined || description !== undefined) {
      return res.status(403).json({ error: 'manager_can_only_change_status' });
    }
    const r = await pool.query(
      'UPDATE tasks SET status = COALESCE($1, status), updated_at = now() WHERE id = $2 RETURNING *',
      [status, req.params.id]
    );
    return res.json(r.rows[0]);
  }
  const r = await pool.query(
    `UPDATE tasks SET
       title = COALESCE($1, title),
       description = COALESCE($2, description),
       status = COALESCE($3, status),
       updated_at = now()
     WHERE id = $4 RETURNING *`,
    [title, description, status, req.params.id]
  );
  res.json(r.rows[0]);
});

app.delete('/api/tasks/:id', requireRole('owner'), async (req, res) => {
  await pool.query('DELETE FROM tasks WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// --- comments (both roles can post) ---
app.post('/api/tasks/:id/comments', requireRole('owner', 'manager'), async (req, res) => {
  const { text, author_name } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'empty_comment' });
  const r = await pool.query(
    'INSERT INTO comments (task_id, author_role, author_name, text) VALUES ($1,$2,$3,$4) RETURNING *',
    [req.params.id, req.role, author_name || null, text.trim()]
  );
  res.json(r.rows[0]);
});

// --- quick add: for pasting a batch of updates fast (owner only) ---
// body: { updates: [{ project: "name", task: "title", status: "done" }, ...] }
// Matches project by name (case-insensitive, partial), creates the task if it
// doesn't exist yet under that project, otherwise updates status by title match.
app.post('/api/quick-update', requireRole('owner'), async (req, res) => {
  const { updates } = req.body;
  if (!Array.isArray(updates)) return res.status(400).json({ error: 'updates_must_be_array' });
  const results = [];
  for (const u of updates) {
    const proj = await pool.query(
      'SELECT * FROM projects WHERE name ILIKE $1 LIMIT 1',
      [`%${u.project}%`]
    );
    if (!proj.rows[0]) {
      results.push({ ...u, error: 'project_not_found' });
      continue;
    }
    const projectId = proj.rows[0].id;
    const existing = await pool.query(
      'SELECT * FROM tasks WHERE project_id = $1 AND title ILIKE $2 LIMIT 1',
      [projectId, `%${u.task}%`]
    );
    if (existing.rows[0]) {
      const r = await pool.query(
        'UPDATE tasks SET status = $1, updated_at = now() WHERE id = $2 RETURNING *',
        [u.status || 'done', existing.rows[0].id]
      );
      results.push(r.rows[0]);
    } else {
      const r = await pool.query(
        'INSERT INTO tasks (project_id, title, status) VALUES ($1,$2,$3) RETURNING *',
        [projectId, u.task, u.status || 'todo']
      );
      results.push(r.rows[0]);
    }
  }
  res.json({ results });
});

// ============================================================
// Sysadmin dashboard (ikorka-sysadmin) — equipment + task panel
// Accessible to 'owner' (sees everything) and 'sysadmin'
// (own panel only, same endpoints, same permissions here).
// ============================================================
const sysadminRoles = ['owner', 'sysadmin'];

// --- equipment ---
app.get('/api/equipment', requireRole(...sysadminRoles), async (req, res) => {
  const r = await pool.query('SELECT * FROM equipment ORDER BY created_at ASC');
  res.json(r.rows);
});

app.post('/api/equipment', requireRole(...sysadminRoles), async (req, res) => {
  const { cat, name, inv, owner, status, note, zone } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name_required' });
  if (zone && !['office', 'warehouse'].includes(zone)) {
    return res.status(400).json({ error: 'invalid_zone' });
  }
  const r = await pool.query(
    `INSERT INTO equipment (cat, name, inv, owner, status, last_check, note, zone)
     VALUES ($1,$2,$3,$4,$5, CURRENT_DATE, $6, $7) RETURNING *`,
    [cat || 'other', name.trim(), inv || null, owner || null, status || 'storage', note || null, zone || 'warehouse']
  );
  await pool.query(
    'INSERT INTO equipment_log (action, item, detail, author_role) VALUES ($1,$2,$3,$4)',
    ['created', r.rows[0].name, inv || '', req.role]
  );
  res.json(r.rows[0]);
});

// bulk inventory check: mark last_check = today for a batch of ids at once
// (used by the "Почати інвентаризацію" flow — one request instead of N).
// Must be declared BEFORE '/api/equipment/:id' — otherwise Express would
// match "bulk-check" as an :id on the param route above it.
app.patch('/api/equipment/bulk-check', requireRole(...sysadminRoles), async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids_must_be_nonempty_array' });
  }
  const r = await pool.query(
    'UPDATE equipment SET last_check = CURRENT_DATE WHERE id = ANY($1::int[]) RETURNING *',
    [ids]
  );
  await pool.query(
    'INSERT INTO equipment_log (action, item, detail, author_role) VALUES ($1,$2,$3,$4)',
    ['inventory_check', `${r.rows.length} одиниць`, 'Перевірено на місці', req.role]
  );
  res.json(r.rows);
});

app.patch('/api/equipment/:id', requireRole(...sysadminRoles), async (req, res) => {
  const { cat, name, inv, owner, status, note, touchLastCheck, zone } = req.body;
  if (zone && !['office', 'warehouse'].includes(zone)) {
    return res.status(400).json({ error: 'invalid_zone' });
  }
  const r = await pool.query(
    `UPDATE equipment SET
       cat = COALESCE($1, cat),
       name = COALESCE($2, name),
       inv = COALESCE($3, inv),
       owner = COALESCE($4, owner),
       status = COALESCE($5, status),
       note = COALESCE($6, note),
       zone = COALESCE($7, zone),
       last_check = CASE WHEN $8 THEN CURRENT_DATE ELSE last_check END
     WHERE id = $9 RETURNING *`,
    [cat, name, inv, owner, status, note, zone, !!touchLastCheck, req.params.id]
  );
  if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
  if (status) {
    await pool.query(
      'INSERT INTO equipment_log (action, item, detail, author_role) VALUES ($1,$2,$3,$4)',
      ['status_changed', r.rows[0].name, status, req.role]
    );
  }
  if (zone) {
    await pool.query(
      'INSERT INTO equipment_log (action, item, detail, author_role) VALUES ($1,$2,$3,$4)',
      ['zone_changed', r.rows[0].name, zone, req.role]
    );
  }
  res.json(r.rows[0]);
});

app.delete('/api/equipment/:id', requireRole(...sysadminRoles), async (req, res) => {
  const r = await pool.query('DELETE FROM equipment WHERE id = $1 RETURNING *', [req.params.id]);
  if (r.rows[0]) {
    await pool.query(
      'INSERT INTO equipment_log (action, item, detail, author_role) VALUES ($1,$2,$3,$4)',
      ['deleted', r.rows[0].name, r.rows[0].inv || '', req.role]
    );
  }
  res.json({ ok: true });
});

app.get('/api/equipment-log', requireRole(...sysadminRoles), async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 200, 2000);
  const r = await pool.query('SELECT * FROM equipment_log ORDER BY ts DESC LIMIT $1', [limit]);
  res.json(r.rows);
});

// manual entry for something that happened outside the app (e.g. logging
// yesterday's physical repair today) — `ts` is optional and defaults to
// now(), but can be set explicitly to backdate the entry.
app.post('/api/equipment-log', requireRole(...sysadminRoles), async (req, res) => {
  const { action, item, detail, ts } = req.body;
  if (!item || !item.trim()) return res.status(400).json({ error: 'item_required' });
  const r = await pool.query(
    `INSERT INTO equipment_log (ts, action, item, detail, author_role)
     VALUES (COALESCE($1, now()), $2, $3, $4, $5) RETURNING *`,
    [ts || null, action || 'manual', item.trim(), detail || null, req.role]
  );
  res.json(r.rows[0]);
});

app.delete('/api/equipment-log/:id', requireRole('owner'), async (req, res) => {
  await pool.query('DELETE FROM equipment_log WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// --- daily tasks (today's checklist, resets manually) ---
app.get('/api/daily-tasks', requireRole(...sysadminRoles), async (req, res) => {
  const r = await pool.query('SELECT * FROM daily_tasks ORDER BY created_at ASC');
  res.json(r.rows);
});

app.post('/api/daily-tasks', requireRole(...sysadminRoles), async (req, res) => {
  const { text } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'text_required' });
  const r = await pool.query(
    'INSERT INTO daily_tasks (text, done) VALUES ($1, false) RETURNING *',
    [text.trim()]
  );
  res.json(r.rows[0]);
});

app.patch('/api/daily-tasks/:id', requireRole(...sysadminRoles), async (req, res) => {
  const { done, text, completed_at } = req.body;
  if (text !== undefined && !text.trim()) return res.status(400).json({ error: 'text_required' });
  const r = await pool.query(
    `UPDATE daily_tasks SET
       text = COALESCE($1, text),
       done = COALESCE($2, done),
       completed_at = CASE
         WHEN $4 THEN $3
         WHEN $2 IS NULL THEN completed_at
         WHEN $2 THEN COALESCE(completed_at, now())
         ELSE NULL
       END
     WHERE id = $5 RETURNING *`,
    [
      text !== undefined ? text.trim() : null,
      done !== undefined ? !!done : null,
      completed_at || null,
      completed_at !== undefined,
      req.params.id,
    ]
  );
  if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
  res.json(r.rows[0]);
});

app.delete('/api/daily-tasks/:id', requireRole(...sysadminRoles), async (req, res) => {
  await pool.query('DELETE FROM daily_tasks WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// --- assigned tasks (time-tracked, set by owner, worked by sysadmin) ---
app.get('/api/assigned-tasks', requireRole(...sysadminRoles), async (req, res) => {
  const r = await pool.query('SELECT * FROM assigned_tasks ORDER BY created_at DESC');
  res.json(r.rows);
});

app.post('/api/assigned-tasks', requireRole('owner'), async (req, res) => {
  const { title, from_user } = req.body;
  if (!title || !title.trim()) return res.status(400).json({ error: 'title_required' });
  const r = await pool.query(
    `INSERT INTO assigned_tasks (title, from_user, status) VALUES ($1,$2,'queued') RETURNING *`,
    [title.trim(), from_user || null]
  );
  res.json(r.rows[0]);
});

// owner can rename the task; both roles can move it through queued/active/done
app.patch('/api/assigned-tasks/:id', requireRole(...sysadminRoles), async (req, res) => {
  const { status, title } = req.body;
  if (status !== undefined && !['queued', 'active', 'done'].includes(status)) {
    return res.status(400).json({ error: 'invalid_status' });
  }
  if (title !== undefined) {
    if (req.role !== 'owner') return res.status(403).json({ error: 'only_owner_can_rename' });
    if (!title.trim()) return res.status(400).json({ error: 'title_required' });
  }
  const r = await pool.query(
    `UPDATE assigned_tasks SET
       title = COALESCE($1, title),
       status = COALESCE($2, status),
       started_at = CASE WHEN $2 = 'active' AND started_at IS NULL THEN now() ELSE started_at END,
       finished_at = CASE WHEN $2 = 'done' THEN now() ELSE finished_at END
     WHERE id = $3 RETURNING *`,
    [title !== undefined ? title.trim() : null, status || null, req.params.id]
  );
  if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
  res.json(r.rows[0]);
});

app.delete('/api/assigned-tasks/:id', requireRole('owner'), async (req, res) => {
  await pool.query('DELETE FROM assigned_tasks WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// --- generic assets (SIM cards etc.) — type-specific data lives in
// `fields` (JSONB), so a new asset type is a frontend-only addition ---
app.get('/api/assets', requireRole(...sysadminRoles), async (req, res) => {
  const r = await pool.query('SELECT * FROM assets ORDER BY created_at ASC');
  res.json(r.rows);
});

app.post('/api/assets', requireRole(...sysadminRoles), async (req, res) => {
  const { type, fields, status, note } = req.body;
  if (!type || !type.trim()) return res.status(400).json({ error: 'type_required' });
  const r = await pool.query(
    `INSERT INTO assets (type, fields, status, note) VALUES ($1,$2,$3,$4) RETURNING *`,
    [type.trim(), fields || {}, status || 'active', note || null]
  );
  res.json(r.rows[0]);
});

app.patch('/api/assets/:id', requireRole(...sysadminRoles), async (req, res) => {
  const { fields, status, note } = req.body;
  const r = await pool.query(
    `UPDATE assets SET
       fields = COALESCE($1, fields),
       status = COALESCE($2, status),
       note = COALESCE($3, note),
       updated_at = now()
     WHERE id = $4 RETURNING *`,
    [fields, status, note, req.params.id]
  );
  if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
  res.json(r.rows[0]);
});

app.delete('/api/assets/:id', requireRole(...sysadminRoles), async (req, res) => {
  await pool.query('DELETE FROM assets WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Task dashboard API running on port ${PORT}`));
