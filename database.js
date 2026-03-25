const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
require('dotenv').config();

// PostgreSQL connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Test database connection
pool.connect((err, client, release) => {
  if (err) {
    console.error('❌ Error connecting to PostgreSQL:', err.message);
  } else {
    console.log('✅ Connected to PostgreSQL database');
    release();
    initializeDatabase();
  }
});

async function initializeDatabase() {
  const client = await pool.connect();
  try {
    // Users table
    await client.query(`
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
      )
    `);
    console.log('✅ Users table ready');

    // Tasks table
    await client.query(`
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
      )
    `);
    console.log('✅ Tasks table ready');

    // Shared schedules table
    await client.query(`
      CREATE TABLE IF NOT EXISTS shared_schedules (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        user_email TEXT NOT NULL,
        share_with_email TEXT NOT NULL,
        share_token TEXT UNIQUE,
        share_type TEXT DEFAULT 'view',
        expires_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Shared schedules table ready');

    // Reminders table
    await client.query(`
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
      )
    `);
    console.log('✅ Reminders table ready');

    // Activity log table
    await client.query(`
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
      )
    `);
    console.log('✅ Activity log table ready');

    // Email log table
    await client.query(`
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
      )
    `);
    console.log('✅ Email log table ready');

    // Suggestions table
    await client.query(`
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
      )
    `);
    console.log('✅ Suggestions table ready');

    // Projects table
    await client.query(`
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
      )
    `);
    console.log('✅ Projects table ready');

    // Create indexes for better performance
    const indexes = [
      'CREATE INDEX IF NOT EXISTS idx_tasks_user_id ON tasks(user_id)',
      'CREATE INDEX IF NOT EXISTS idx_tasks_user_email ON tasks(user_email)',
      'CREATE INDEX IF NOT EXISTS idx_tasks_scheduled_start ON tasks(scheduled_start)',
      'CREATE INDEX IF NOT EXISTS idx_tasks_deadline ON tasks(deadline)',
      'CREATE INDEX IF NOT EXISTS idx_tasks_completed ON tasks(completed)',
      'CREATE INDEX IF NOT EXISTS idx_reminders_reminder_time ON reminders(reminder_time)',
      'CREATE INDEX IF NOT EXISTS idx_reminders_sent ON reminders(sent)',
      'CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)',
      'CREATE INDEX IF NOT EXISTS idx_activity_user_id ON activity_log(user_id)',
      'CREATE INDEX IF NOT EXISTS idx_activity_email ON activity_log(email)',
      'CREATE INDEX IF NOT EXISTS idx_email_log_recipient ON email_log(recipient)',
      'CREATE INDEX IF NOT EXISTS idx_suggestions_user_id ON suggestions(user_id)',
      'CREATE INDEX IF NOT EXISTS idx_projects_user_id ON projects(user_id)',
      'CREATE INDEX IF NOT EXISTS idx_shared_schedules_user_email ON shared_schedules(user_email)',
      'CREATE INDEX IF NOT EXISTS idx_shared_schedules_token ON shared_schedules(share_token)'
    ];

    for (const index of indexes) {
      await client.query(index).catch(() => {});
    }
    console.log('✅ All indexes created successfully');

    // Create demo user if not exists
    const demoEmail = 'demo@taskweaver.com';
    const existingDemo = await client.query('SELECT id FROM users WHERE email = $1', [demoEmail]);
    
    if (existingDemo.rows.length === 0) {
      const hashedPassword = await bcrypt.hash('Demo@2024', 10);
      await client.query(
        `INSERT INTO users (username, email, password, email_notifications, push_notifications, timezone, theme, email_verified) 
         VALUES ($1, $2, $3, 1, 1, 'UTC', 'light', 1)`,
        ['DEMOUSER', demoEmail, hashedPassword]
      );
      console.log('✅ Demo user created: demo@taskweaver.com / Demo@2024');
    } else {
      console.log('ℹ️ Demo user already exists');
    }

    console.log('✅ Database initialization complete');

  } catch (err) {
    console.error('❌ Database initialization error:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

// Helper functions for database operations
const dbHelpers = {
  // Query helper
  query: async (text, params) => {
    try {
      const result = await pool.query(text, params);
      return result;
    } catch (err) {
      console.error('Database query error:', err.message);
      throw err;
    }
  },

  // User helpers
  getUserById: async (id) => {
    const result = await pool.query(
      "SELECT id, username, email, reminder_interval, auto_reminders, email_notifications, push_notifications, timezone, theme, created_at, last_login FROM users WHERE id = $1",
      [id]
    );
    return result.rows[0];
  },
  
  getUserByEmail: async (email) => {
    const result = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
    return result.rows[0];
  },
  
  updateLastLogin: async (userId, ip, userAgent) => {
    await pool.query(
      "UPDATE users SET last_login = CURRENT_TIMESTAMP, last_login_ip = $1, last_login_user_agent = $2, login_count = login_count + 1 WHERE id = $3",
      [ip, userAgent, userId]
    );
  },
  
  // Task helpers
  getTasksByUser: async (userId) => {
    const result = await pool.query(
      `SELECT * FROM tasks WHERE user_id = $1 AND (deleted_at IS NULL OR deleted_at = '') 
       ORDER BY 
         CASE severity WHEN 'Critical' THEN 1 WHEN 'High' THEN 2 WHEN 'Medium' THEN 3 WHEN 'Low' THEN 4 END,
         deadline ASC NULLS LAST, 
         scheduled_start ASC NULLS LAST`,
      [userId]
    );
    return result.rows;
  },
  
  getTasksByDate: async (userId, date) => {
    const result = await pool.query(
      `SELECT * FROM tasks WHERE user_id = $1 AND DATE(scheduled_start) = DATE($2)`,
      [userId, date]
    );
    return result.rows;
  },
  
  getOverdueTasks: async (userId) => {
    const result = await pool.query(
      `SELECT * FROM tasks WHERE user_id = $1 AND deadline < CURRENT_TIMESTAMP AND completed = 0`,
      [userId]
    );
    return result.rows;
  },
  
  // Reminder helpers
  getPendingReminders: async () => {
    const result = await pool.query(`
      SELECT r.*, t.title, t.description, t.project, u.email as user_email, u.email_notifications
      FROM reminders r
      JOIN tasks t ON r.task_id = t.id
      JOIN users u ON r.user_id = u.id
      WHERE r.reminder_time <= CURRENT_TIMESTAMP 
        AND r.sent = 0 
        AND u.email_notifications = 1
        AND t.completed = 0
    `);
    return result.rows;
  },
  
  markReminderSent: async (reminderId) => {
    await pool.query(
      "UPDATE reminders SET sent = 1, sent_at = CURRENT_TIMESTAMP WHERE id = $1",
      [reminderId]
    );
  },
  
  // Activity logging
  logActivity: async (userId, email, action, details, req = null) => {
    const ip = req?.ip || req?.connection?.remoteAddress || 'unknown';
    const userAgent = req?.headers['user-agent'] || 'unknown';
    const method = req?.method;
    const url = req?.originalUrl;
    
    await pool.query(
      `INSERT INTO activity_log (user_id, email, action, details, ip_address, user_agent, request_method, request_url) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [userId, email, action, details, ip, userAgent, method, url]
    );
  },
  
  getRecentActivity: async (userId, limit = 10) => {
    const result = await pool.query(
      "SELECT * FROM activity_log WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2",
      [userId, limit]
    );
    return result.rows;
  },
  
  // Statistics
  getUserStats: async (userId) => {
    const result = await pool.query(`
      SELECT 
        COUNT(CASE WHEN completed = 1 THEN 1 END) as completed_tasks,
        COUNT(CASE WHEN completed = 0 AND scheduled_start IS NOT NULL AND scheduled_start != '' THEN 1 END) as scheduled_tasks,
        COUNT(CASE WHEN completed = 0 AND (scheduled_start IS NULL OR scheduled_start = '') THEN 1 END) as unscheduled_tasks,
        COUNT(CASE WHEN severity = 'Critical' AND completed = 0 THEN 1 END) as critical_tasks,
        COUNT(CASE WHEN severity = 'High' AND completed = 0 THEN 1 END) as high_priority_tasks,
        COUNT(CASE WHEN deadline < CURRENT_TIMESTAMP AND completed = 0 THEN 1 END) as overdue_tasks,
        COUNT(CASE WHEN created_at > CURRENT_TIMESTAMP - INTERVAL '7 days' THEN 1 END) as tasks_this_week
      FROM tasks WHERE user_id = $1
    `, [userId]);
    return result.rows[0];
  },
  
  // Projects helpers
  getProjectsByUser: async (userId) => {
    const result = await pool.query(
      "SELECT * FROM projects WHERE user_id = $1 ORDER BY created_at DESC",
      [userId]
    );
    return result.rows;
  },
  
  createProject: async (userId, userEmail, name, description, color, status, progress, startDate, endDate) => {
    const result = await pool.query(
      `INSERT INTO projects (user_id, user_email, name, description, color, status, progress, start_date, end_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [userId, userEmail, name, description, color, status || 'active', progress || 0, startDate, endDate]
    );
    return result.rows[0].id;
  },
  
  updateProject: async (id, userId, updates) => {
    const fields = [];
    const values = [];
    let paramCounter = 1;
    
    if (updates.name !== undefined) { fields.push(`name = $${paramCounter++}`); values.push(updates.name); }
    if (updates.description !== undefined) { fields.push(`description = $${paramCounter++}`); values.push(updates.description); }
    if (updates.color !== undefined) { fields.push(`color = $${paramCounter++}`); values.push(updates.color); }
    if (updates.status !== undefined) { fields.push(`status = $${paramCounter++}`); values.push(updates.status); }
    if (updates.progress !== undefined) { fields.push(`progress = $${paramCounter++}`); values.push(updates.progress); }
    if (updates.start_date !== undefined) { fields.push(`start_date = $${paramCounter++}`); values.push(updates.start_date); }
    if (updates.end_date !== undefined) { fields.push(`end_date = $${paramCounter++}`); values.push(updates.end_date); }
    
    if (fields.length === 0) return false;
    
    fields.push(`updated_at = NOW()`);
    values.push(id, userId);
    
    const query = `UPDATE projects SET ${fields.join(', ')} WHERE id = $${paramCounter++} AND user_id = $${paramCounter}`;
    const result = await pool.query(query, values);
    return result.rowCount > 0;
  },
  
  deleteProject: async (id, userId) => {
    const result = await pool.query("DELETE FROM projects WHERE id = $1 AND user_id = $2", [id, userId]);
    return result.rowCount > 0;
  },
  
  // Suggestions helpers
  getSuggestions: async (userId, limit = 10) => {
    const result = await pool.query(
      "SELECT * FROM suggestions WHERE user_id = $1 AND is_read = 0 ORDER BY priority DESC, created_at ASC LIMIT $2",
      [userId, limit]
    );
    return result.rows;
  },
  
  addSuggestion: async (userId, userEmail, suggestion, type, priority = 0) => {
    const result = await pool.query(
      `INSERT INTO suggestions (user_id, user_email, suggestion, type, priority) 
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [userId, userEmail, suggestion, type, priority]
    );
    return result.rows[0].id;
  },
  
  markSuggestionRead: async (suggestionId, userId) => {
    await pool.query(
      "UPDATE suggestions SET is_read = 1, read_at = NOW() WHERE id = $1 AND user_id = $2",
      [suggestionId, userId]
    );
  },
  
  // Share schedule helpers
  createShareLink: async (userId, userEmail, shareWithEmail, shareToken, shareType, expiresAt) => {
    const result = await pool.query(
      `INSERT INTO shared_schedules (user_id, user_email, share_with_email, share_token, share_type, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [userId, userEmail, shareWithEmail, shareToken, shareType, expiresAt]
    );
    return result.rows[0].id;
  },
  
  getSharedSchedule: async (token) => {
    const result = await pool.query(
      "SELECT * FROM shared_schedules WHERE share_token = $1 AND expires_at > NOW()",
      [token]
    );
    return result.rows[0];
  },
  
  // Cleanup old data
  cleanupOldData: async () => {
    const reminderResult = await pool.query("DELETE FROM reminders WHERE created_at < CURRENT_TIMESTAMP - INTERVAL '30 days'");
    const activityResult = await pool.query("DELETE FROM activity_log WHERE created_at < CURRENT_TIMESTAMP - INTERVAL '90 days'");
    const emailResult = await pool.query("DELETE FROM email_log WHERE created_at < CURRENT_TIMESTAMP - INTERVAL '180 days'");
    const suggestionResult = await pool.query("DELETE FROM suggestions WHERE created_at < CURRENT_TIMESTAMP - INTERVAL '30 days' AND is_read = 1");
    const shareResult = await pool.query("DELETE FROM shared_schedules WHERE expires_at < CURRENT_TIMESTAMP");
    
    console.log(`Cleaned up: ${reminderResult.rowCount} reminders, ${activityResult.rowCount} activities, ${emailResult.rowCount} emails, ${suggestionResult.rowCount} suggestions, ${shareResult.rowCount} shares`);
    return true;
  },
  
  // Get pool for transactions
  getPool: () => pool
};

// Export database connection and helpers
module.exports = {
  pool,
  ...dbHelpers
};