-- TaskWeaver Database Schema
-- This script initializes the PostgreSQL database for TaskWeaver

-- Users table
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    reset_token TEXT,
    reset_token_expiry TIMESTAMP,
    reminder_interval INTEGER DEFAULT 20,
    auto_reminders INTEGER DEFAULT 1,
    email_notifications INTEGER DEFAULT 1,
    push_notifications INTEGER DEFAULT 1,
    timezone TEXT DEFAULT 'UTC',
    theme TEXT DEFAULT 'light',
    last_login_ip TEXT,
    last_login_user_agent TEXT,
    login_count INTEGER DEFAULT 0,
    account_status TEXT DEFAULT 'active',
    failed_login_attempts INTEGER DEFAULT 0,
    last_failed_login TIMESTAMP,
    locked_until TIMESTAMP,
    email_verified INTEGER DEFAULT 0,
    verification_token TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_login TIMESTAMP
);

-- Tasks table
CREATE TABLE IF NOT EXISTS tasks (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_email TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    project TEXT,
    category TEXT,
    severity TEXT DEFAULT 'Medium',
    priority INTEGER DEFAULT 2,
    deadline TIMESTAMP,
    is_recurring INTEGER DEFAULT 0,
    recurrence_pattern TEXT,
    recurrence_end_date TIMESTAMP,
    scheduled_start TIMESTAMP,
    scheduled_end TIMESTAMP,
    actual_start TIMESTAMP,
    actual_end TIMESTAMP,
    completed INTEGER DEFAULT 0,
    completed_at TIMESTAMP,
    completion_notes TEXT,
    email_reminder_sent INTEGER DEFAULT 0,
    deadline_reminder_sent INTEGER DEFAULT 0,
    overdue_reminder_sent INTEGER DEFAULT 0,
    reminder_count INTEGER DEFAULT 0,
    last_reminder_sent TIMESTAMP,
    estimated_duration INTEGER,
    actual_duration INTEGER,
    tags TEXT,
    attachments TEXT,
    subtasks TEXT,
    dependencies TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP
);

-- Shared schedules table
CREATE TABLE IF NOT EXISTS shared_schedules (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_email TEXT NOT NULL,
    share_with_email TEXT NOT NULL,
    share_token TEXT UNIQUE,
    share_type TEXT DEFAULT 'view',
    expires_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Reminders table
CREATE TABLE IF NOT EXISTS reminders (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_email TEXT NOT NULL,
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    reminder_time TIMESTAMP NOT NULL,
    reminder_type TEXT DEFAULT 'scheduled',
    reminder_method TEXT DEFAULT 'email',
    sent INTEGER DEFAULT 0,
    sent_at TIMESTAMP,
    retry_count INTEGER DEFAULT 0,
    last_error TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Activity log table
CREATE TABLE IF NOT EXISTS activity_log (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    action TEXT NOT NULL,
    details TEXT,
    ip_address TEXT,
    user_agent TEXT,
    request_method TEXT,
    request_url TEXT,
    response_status INTEGER,
    response_time INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Email log table
CREATE TABLE IF NOT EXISTS email_log (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    user_email TEXT,
    recipient TEXT NOT NULL,
    subject TEXT NOT NULL,
    body TEXT,
    status TEXT,
    error_message TEXT,
    sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Suggestions table
CREATE TABLE IF NOT EXISTS suggestions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_email TEXT NOT NULL,
    suggestion TEXT NOT NULL,
    type TEXT,
    priority INTEGER DEFAULT 0,
    is_read INTEGER DEFAULT 0,
    read_at TIMESTAMP,
    action_taken TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Projects table
CREATE TABLE IF NOT EXISTS projects (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_email TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    color TEXT,
    status TEXT DEFAULT 'active',
    progress INTEGER DEFAULT 0,
    start_date TIMESTAMP,
    end_date TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_tasks_user_id ON tasks(user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_user_email ON tasks(user_email);
CREATE INDEX IF NOT EXISTS idx_tasks_scheduled_start ON tasks(scheduled_start);
CREATE INDEX IF NOT EXISTS idx_tasks_deadline ON tasks(deadline);
CREATE INDEX IF NOT EXISTS idx_tasks_completed ON tasks(completed);
CREATE INDEX IF NOT EXISTS idx_reminders_reminder_time ON reminders(reminder_time);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_activity_user_id ON activity_log(user_id);
CREATE INDEX IF NOT EXISTS idx_activity_email ON activity_log(email);
CREATE INDEX IF NOT EXISTS idx_shared_schedules_user_email ON shared_schedules(user_email);
CREATE INDEX IF NOT EXISTS idx_shared_schedules_token ON shared_schedules(share_token);