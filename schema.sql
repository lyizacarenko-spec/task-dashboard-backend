-- Task Dashboard schema
-- Run this once in Railway PostgreSQL (or Supabase SQL editor)

CREATE TABLE IF NOT EXISTS projects (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active', -- active | paused | done
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tasks (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'todo', -- todo | in_progress | done
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS comments (
  id SERIAL PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author_role TEXT NOT NULL, -- 'owner' | 'manager'
  author_name TEXT,
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_comments_task_id ON comments(task_id);

-- Seed: current known projects (edit freely, this is just a starting point)
INSERT INTO projects (name, description, status) VALUES
('Комерційна реорганізація v7.0', 'Реструктуризація на роздріб / МО / B2B-реселлерів, старт 1 серпня', 'active'),
('Регламент передачі клієнта (GOV-01)', 'Регламент передачі клієнта між відділами, узгодження з Пальчун Еллою', 'active'),
('exam-rzpk-app', 'Додаток для екзаменів/атестації відділу РЗПК', 'active'),
('ikorka-training-bot', 'Telegram-бот навчання для менеджерів продажу (@IkorkaTraining2_bot)', 'active'),
('Графік змін (schedule-app)', 'Графік змін для 8 відділів, фронт GitHub Pages + бек на Railway', 'active'),
('tg-parcel-bot', 'Telegram-бот трекінгу посилок Нової Пошти (@ikorkabot)', 'active'),
('qa-checklist-site', 'Сайт QA-чеклистів для менеджерів/рев''юерів', 'active'),
('caviar-manager-app', 'Веб-додаток для менеджерів: прайси і калькулятор акцій', 'active'),
('Регламент скасування посилок', 'Регламент скасування посилок клієнтів', 'active'),
('Аналіз якості дзвінків (call-quality)', 'AI-аналіз дзвінків менеджерів, МО і роздріб', 'active')
ON CONFLICT DO NOTHING;

-- Sample seed task showing a known open issue (schedule-app)
INSERT INTO tasks (project_id, title, description, status)
SELECT id, 'Виправити помилку foreign key при створенні співробітника', 'Підозра на застарілий закешований department_id у браузері', 'in_progress'
FROM projects WHERE name = 'Графік змін (schedule-app)'
ON CONFLICT DO NOTHING;

-- ============================================================
-- ikorka-sysadmin (equipment + task panel)
-- No real inventory/employee data here on purpose — this file is
-- committed to a public repo. Real rows go in through the app
-- (POST /api/equipment etc.), which only ever touches the DB
-- directly, never the git history.
-- ============================================================

CREATE TABLE IF NOT EXISTS equipment (
  id SERIAL PRIMARY KEY,
  cat TEXT NOT NULL DEFAULT 'other',      -- laptop | headset | mouse | other
  name TEXT NOT NULL,
  inv TEXT,                                -- inventory number
  owner TEXT,                              -- location / holder
  status TEXT NOT NULL DEFAULT 'storage',  -- working | storage | repair | decommissioned
  last_check DATE,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS equipment_log (
  id SERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  action TEXT NOT NULL,   -- created | status_changed | deleted
  item TEXT NOT NULL,
  detail TEXT,
  author_role TEXT
);

CREATE TABLE IF NOT EXISTS daily_tasks (
  id SERIAL PRIMARY KEY,
  text TEXT NOT NULL,
  done BOOLEAN NOT NULL DEFAULT false,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS assigned_tasks (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  from_user TEXT,
  status TEXT NOT NULL DEFAULT 'queued', -- queued | active | done
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_equipment_log_ts ON equipment_log(ts);
CREATE INDEX IF NOT EXISTS idx_assigned_tasks_status ON assigned_tasks(status);

-- No INSERT statements here on purpose — see note above.

-- ============================================================
-- zone split (office vs warehouse) + generic assets (SIM cards etc.)
-- ============================================================

-- Physical location, distinct from `status`/`owner`. All equipment
-- loaded so far came from the warehouse stock sheet, so it defaults
-- to 'warehouse' — office equipment starts empty and gets entered
-- through the app under the "Офіс" zone.
ALTER TABLE equipment ADD COLUMN IF NOT EXISTS zone TEXT NOT NULL DEFAULT 'warehouse'; -- office | warehouse

-- Generic asset type for things that aren't physical equipment with a
-- fixed field set (starting with SIM cards). `fields` holds whatever
-- the asset type needs (number/operator/assigned_to for a SIM, etc.)
-- so a new asset type is a frontend-only addition, no migration needed.
CREATE TABLE IF NOT EXISTS assets (
  id SERIAL PRIMARY KEY,
  type TEXT NOT NULL,                       -- 'sim', extensible later
  fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'active',
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_assets_type ON assets(type);

-- ============================================================
-- luiza-personal (owner-only dashboard: daily checklist + tasks
-- someone else assigns to her, e.g. Євгенія — free-text "from", not
-- a role). No seed data on purpose, same reason as the sysadmin tables.
-- ============================================================

CREATE TABLE IF NOT EXISTS luiza_daily_tasks (
  id SERIAL PRIMARY KEY,
  text TEXT NOT NULL,
  done BOOLEAN NOT NULL DEFAULT false,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS luiza_assigned_tasks (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  from_user TEXT,                        -- free text, e.g. "Євгенія" — no login of their own
  status TEXT NOT NULL DEFAULT 'queued', -- queued | active | done
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_luiza_assigned_tasks_status ON luiza_assigned_tasks(status);

-- ============================================================
-- luiza-personal: projects registry (4th tab, ikorka-luiza)
-- ============================================================

CREATE TABLE IF NOT EXISTS luiza_projects (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  repo_url TEXT,
  live_url TEXT,
  tech_stack TEXT,
  status TEXT NOT NULL DEFAULT 'active', -- active | done | archived
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_luiza_projects_status ON luiza_projects(status);

-- ============================================================
-- assigned_tasks report/notes field (ikorka-sysadmin, "Задачі від
-- керівника") — sysadmin writes progress/findings, owner reads it after
-- completion. Editable at any status, not just while active.
-- ============================================================
ALTER TABLE assigned_tasks ADD COLUMN IF NOT EXISTS report TEXT;

-- ============================================================
-- luiza_assigned_tasks report/notes field (ikorka-luiza, "Задачі") —
-- same pattern as assigned_tasks.report above, editable at any status.
-- ============================================================
ALTER TABLE luiza_assigned_tasks ADD COLUMN IF NOT EXISTS report TEXT;
