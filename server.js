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

// --- auth: PIN comes in header 'x-pin', resolves to a role ---
function resolveRole(pin) {
  if (pin === OWNER_PIN) return 'owner';
  if (pin === MANAGER_PIN) return 'manager';
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

app.get('/api/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Task dashboard API running on port ${PORT}`));
