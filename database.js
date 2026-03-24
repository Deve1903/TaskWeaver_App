const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcrypt');

const dbPath = path.join(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error opening database:', err);
    } else {
        console.log('Connected to SQLite database at:', dbPath);
        initializeDatabase();
    }
});

function initializeDatabase() {
    // Users table
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        reset_token TEXT,
        reset_token_expiry DATETIME,
        reminder_interval INTEGER DEFAULT 20,
        auto_reminders BOOLEAN DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_login DATETIME
    )`);

    // Tasks table
    db.run(`CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        project TEXT,
        category TEXT,
        severity TEXT DEFAULT 'Medium',
        deadline DATETIME,
        is_recurring BOOLEAN DEFAULT 0,
        recurrence_pattern TEXT,
        scheduled_start DATETIME,
        scheduled_end DATETIME,
        completed BOOLEAN DEFAULT 0,
        email_reminder_sent BOOLEAN DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )`);

    // Reminders table
    db.run(`CREATE TABLE IF NOT EXISTS reminders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        task_id INTEGER NOT NULL,
        reminder_time DATETIME NOT NULL,
        sent BOOLEAN DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
    )`);

    // Suggestions table
    db.run(`CREATE TABLE IF NOT EXISTS suggestions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        suggestion TEXT NOT NULL,
        type TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )`);

    // Activity log table
    db.run(`CREATE TABLE IF NOT EXISTS activity_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        action TEXT NOT NULL,
        details TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )`);

    // Create indexes for better performance
    db.run(`CREATE INDEX IF NOT EXISTS idx_tasks_user_id ON tasks(user_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_tasks_scheduled_start ON tasks(scheduled_start)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_reminders_reminder_time ON reminders(reminder_time)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`);

    console.log('Database tables and indexes created successfully');
    
    // Create default admin user if not exists (optional)
    createDefaultAdmin();
}

async function createDefaultAdmin() {
    db.get("SELECT id FROM users WHERE email = ?", ['admin@taskweaver.com'], async (err, user) => {
        if (err) {
            console.error('Error checking admin user:', err);
            return;
        }
        
        if (!user) {
            const hashedPassword = await bcrypt.hash('Admin@2024', 10);
            db.run(`INSERT INTO users (username, email, password, auto_reminders) 
                    VALUES (?, ?, ?, ?)`,
                ['ADMIN', 'admin@taskweaver.com', hashedPassword, 1],
                (err) => {
                    if (err) {
                        console.error('Error creating admin user:', err);
                    } else {
                        console.log('Default admin user created');
                    }
                }
            );
        }
    });
}

// Helper functions for database operations
const dbHelpers = {
    // User helpers
    getUserById: (id, callback) => {
        db.get("SELECT id, username, email, reminder_interval, auto_reminders, created_at FROM users WHERE id = ?", [id], callback);
    },
    
    getUserByEmail: (email, callback) => {
        db.get("SELECT * FROM users WHERE email = ?", [email], callback);
    },
    
    updateLastLogin: (userId, callback) => {
        db.run("UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?", [userId], callback);
    },
    
    // Task helpers
    getTasksByUser: (userId, callback) => {
        db.all("SELECT * FROM tasks WHERE user_id = ? ORDER BY severity DESC, deadline ASC", [userId], callback);
    },
    
    getTasksByDate: (userId, date, callback) => {
        db.all(`SELECT * FROM tasks WHERE user_id = ? AND DATE(scheduled_start) = DATE(?)`, [userId, date], callback);
    },
    
    getOverdueTasks: (userId, callback) => {
        db.all(`SELECT * FROM tasks WHERE user_id = ? AND deadline < CURRENT_TIMESTAMP AND completed = 0`, [userId], callback);
    },
    
    // Reminder helpers
    getPendingReminders: (callback) => {
        db.all(`SELECT r.*, t.title, t.description, t.project, u.email as user_email 
                FROM reminders r
                JOIN tasks t ON r.task_id = t.id
                JOIN users u ON r.user_id = u.id
                WHERE r.reminder_time <= CURRENT_TIMESTAMP AND r.sent = 0 AND u.auto_reminders = 1`, callback);
    },
    
    markReminderSent: (reminderId, callback) => {
        db.run("UPDATE reminders SET sent = 1 WHERE id = ?", [reminderId], callback);
    },
    
    // Activity logging
    logActivity: (userId, action, details, callback) => {
        db.run("INSERT INTO activity_log (user_id, action, details) VALUES (?, ?, ?)", 
            [userId, action, details], callback);
    },
    
    getRecentActivity: (userId, limit = 10, callback) => {
        db.all("SELECT * FROM activity_log WHERE user_id = ? ORDER BY created_at DESC LIMIT ?", 
            [userId, limit], callback);
    },
    
    // Statistics
    getUserStats: (userId, callback) => {
        db.get(`SELECT 
                    COUNT(CASE WHEN completed = 1 THEN 1 END) as completed_tasks,
                    COUNT(CASE WHEN completed = 0 AND scheduled_start IS NOT NULL THEN 1 END) as scheduled_tasks,
                    COUNT(CASE WHEN completed = 0 AND scheduled_start IS NULL THEN 1 END) as unscheduled_tasks,
                    COUNT(CASE WHEN severity = 'Critical' AND completed = 0 THEN 1 END) as critical_tasks,
                    COUNT(CASE WHEN severity = 'High' AND completed = 0 THEN 1 END) as high_priority_tasks,
                    COUNT(CASE WHEN deadline < CURRENT_TIMESTAMP AND completed = 0 THEN 1 END) as overdue_tasks
                FROM tasks WHERE user_id = ?`, [userId], callback);
    },
    
    // Cleanup old data
    cleanupOldData: (callback) => {
        // Delete old reminders (older than 30 days)
        db.run("DELETE FROM reminders WHERE created_at < datetime('now', '-30 days')", (err) => {
            if (err) console.error('Error cleaning reminders:', err);
        });
        
        // Delete old activity logs (older than 90 days)
        db.run("DELETE FROM activity_log WHERE created_at < datetime('now', '-90 days')", (err) => {
            if (err) console.error('Error cleaning activity logs:', err);
        });
        
        if (callback) callback();
    }
};

// Export database connection and helpers
module.exports = {
    db,
    ...dbHelpers
};