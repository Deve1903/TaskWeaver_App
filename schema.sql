-- TaskWeaver Database Schema v3.0 - Calendar Enhanced
-- Drop existing tables if you want a fresh start
-- DROP TABLE IF EXISTS activity_log;
-- DROP TABLE IF EXISTS suggestions;
-- DROP TABLE IF EXISTS reminders;
-- DROP TABLE IF EXISTS tasks;
-- DROP TABLE IF EXISTS users;

-- Users table
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    reset_token TEXT,
    reset_token_expiry DATETIME,
    reminder_interval INTEGER DEFAULT 20,
    auto_reminders BOOLEAN DEFAULT 1,
    deadline_reminder_days INTEGER DEFAULT 1,
    overdue_reminder_enabled BOOLEAN DEFAULT 1,
    calendar_view TEXT DEFAULT 'timeGridWeek',
    calendar_theme TEXT DEFAULT 'light',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_login DATETIME
);

-- Tasks table with calendar support
CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    project TEXT,
    category TEXT CHECK(category IN ('Work', 'Study', 'Family', 'Rest')),
    severity TEXT CHECK(severity IN ('Critical', 'High', 'Medium', 'Low')) DEFAULT 'Medium',
    deadline DATETIME,
    is_recurring BOOLEAN DEFAULT 0,
    recurrence_pattern TEXT CHECK(recurrence_pattern IN ('daily', 'weekly', 'monthly', 'custom_2', 'custom_3', NULL)),
    scheduled_start DATETIME,
    scheduled_end DATETIME,
    completed BOOLEAN DEFAULT 0,
    email_reminder_sent BOOLEAN DEFAULT 0,
    deadline_reminder_sent BOOLEAN DEFAULT 0,
    overdue_reminder_sent BOOLEAN DEFAULT 0,
    last_reminder_sent DATETIME,
    reminder_count INTEGER DEFAULT 0,
    color_code TEXT, -- Custom color for calendar events
    estimated_duration INTEGER DEFAULT 60, -- Duration in minutes
    priority_score INTEGER DEFAULT 0, -- Auto-calculated priority score
    dragged_from_funnel BOOLEAN DEFAULT 0, -- Track if task was dragged from funnel
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Enhanced reminders table
CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    task_id INTEGER NOT NULL,
    reminder_time DATETIME NOT NULL,
    reminder_type TEXT CHECK(reminder_type IN ('scheduled', 'deadline', 'overdue')) DEFAULT 'scheduled',
    sent BOOLEAN DEFAULT 0,
    sent_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

-- Suggestions table
CREATE TABLE IF NOT EXISTS suggestions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    suggestion TEXT NOT NULL,
    type TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Activity log table
CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    details TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Calendar events table for custom events (like family time, study blocks)
CREATE TABLE IF NOT EXISTS calendar_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    event_type TEXT CHECK(event_type IN ('work', 'study', 'family', 'rest', 'custom')),
    start_time DATETIME NOT NULL,
    end_time DATETIME NOT NULL,
    color TEXT,
    is_recurring BOOLEAN DEFAULT 0,
    recurrence_pattern TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_tasks_user_id ON tasks(user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_scheduled_start ON tasks(scheduled_start);
CREATE INDEX IF NOT EXISTS idx_tasks_deadline ON tasks(deadline);
CREATE INDEX IF NOT EXISTS idx_tasks_completed ON tasks(completed);
CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority_score);
CREATE INDEX IF NOT EXISTS idx_reminders_reminder_time ON reminders(reminder_time);
CREATE INDEX IF NOT EXISTS idx_reminders_type ON reminders(reminder_type);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_activity_user_id ON activity_log(user_id);
CREATE INDEX IF NOT EXISTS idx_calendar_events_user_id ON calendar_events(user_id);
CREATE INDEX IF NOT EXISTS idx_calendar_events_start ON calendar_events(start_time);

-- Create trigger for updated_at
CREATE TRIGGER IF NOT EXISTS update_tasks_updated_at 
AFTER UPDATE ON tasks
BEGIN
    UPDATE tasks SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

-- Create trigger to auto-calculate priority score
CREATE TRIGGER IF NOT EXISTS calculate_priority_score 
AFTER INSERT ON tasks
BEGIN
    UPDATE tasks SET priority_score = 
        CASE NEW.severity
            WHEN 'Critical' THEN 100
            WHEN 'High' THEN 75
            WHEN 'Medium' THEN 50
            WHEN 'Low' THEN 25
        END + 
        CASE WHEN NEW.deadline IS NOT NULL AND NEW.deadline < datetime('now', '+2 days') THEN 20 ELSE 0 END
    WHERE id = NEW.id;
END;

-- Create trigger for scheduled reminders
CREATE TRIGGER IF NOT EXISTS create_scheduled_reminder 
AFTER INSERT ON tasks
WHEN NEW.scheduled_start IS NOT NULL AND NEW.completed = 0
BEGIN
    INSERT INTO reminders (user_id, task_id, reminder_time, reminder_type)
    SELECT NEW.user_id, NEW.id, 
           datetime(NEW.scheduled_start, '-' || (SELECT reminder_interval FROM users WHERE id = NEW.user_id) || ' minutes'),
           'scheduled';
END;

-- Create trigger for deadline reminders
CREATE TRIGGER IF NOT EXISTS create_deadline_reminder 
AFTER INSERT ON tasks
WHEN NEW.deadline IS NOT NULL AND NEW.completed = 0
BEGIN
    INSERT INTO reminders (user_id, task_id, reminder_time, reminder_type)
    SELECT NEW.user_id, NEW.id, 
           datetime(NEW.deadline, '-' || (SELECT deadline_reminder_days FROM users WHERE id = NEW.user_id) || ' days'),
           'deadline';
END;