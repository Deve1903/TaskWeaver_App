const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const db = new sqlite3.Database('./database.sqlite');

console.log('Starting database migration...');

// Add missing columns to users table
db.serialize(() => {
    // Check and add columns to users table
    const userColumns = [
        { name: 'email_notifications', type: 'INTEGER DEFAULT 1' },
        { name: 'push_notifications', type: 'INTEGER DEFAULT 1' },
        { name: 'timezone', type: 'TEXT DEFAULT "UTC"' },
        { name: 'theme', type: 'TEXT DEFAULT "light"' },
        { name: 'last_login_ip', type: 'TEXT' },
        { name: 'last_login_user_agent', type: 'TEXT' },
        { name: 'login_count', type: 'INTEGER DEFAULT 0' },
        { name: 'account_status', type: 'TEXT DEFAULT "active"' },
        { name: 'failed_login_attempts', type: 'INTEGER DEFAULT 0' },
        { name: 'last_failed_login', type: 'DATETIME' },
        { name: 'locked_until', type: 'DATETIME' }
    ];
    
    userColumns.forEach(column => {
        db.run(`ALTER TABLE users ADD COLUMN ${column.name} ${column.type}`, (err) => {
            if (err && !err.message.includes('duplicate column name')) {
                console.error(`Error adding column ${column.name}:`, err.message);
            } else if (!err) {
                console.log(`✓ Added column: ${column.name}`);
            }
        });
    });
    
    // Add missing columns to tasks table
    const taskColumns = [
        { name: 'priority', type: 'INTEGER DEFAULT 2' },
        { name: 'recurrence_end_date', type: 'DATETIME' },
        { name: 'actual_start', type: 'DATETIME' },
        { name: 'actual_end', type: 'DATETIME' },
        { name: 'completed_at', type: 'DATETIME' },
        { name: 'completion_notes', type: 'TEXT' },
        { name: 'reminder_count', type: 'INTEGER DEFAULT 0' },
        { name: 'last_reminder_sent', type: 'DATETIME' },
        { name: 'estimated_duration', type: 'INTEGER' },
        { name: 'actual_duration', type: 'INTEGER' },
        { name: 'tags', type: 'TEXT' },
        { name: 'attachments', type: 'TEXT' },
        { name: 'subtasks', type: 'TEXT' },
        { name: 'dependencies', type: 'TEXT' },
        { name: 'deleted_at', type: 'DATETIME' }
    ];
    
    taskColumns.forEach(column => {
        db.run(`ALTER TABLE tasks ADD COLUMN ${column.name} ${column.type}`, (err) => {
            if (err && !err.message.includes('duplicate column name')) {
                console.error(`Error adding column ${column.name}:`, err.message);
            } else if (!err) {
                console.log(`✓ Added column to tasks: ${column.name}`);
            }
        });
    });
    
    // Add missing columns to reminders table
    const reminderColumns = [
        { name: 'reminder_method', type: 'TEXT DEFAULT "email"' },
        { name: 'sent_at', type: 'DATETIME' },
        { name: 'retry_count', type: 'INTEGER DEFAULT 0' },
        { name: 'last_error', type: 'TEXT' }
    ];
    
    reminderColumns.forEach(column => {
        db.run(`ALTER TABLE reminders ADD COLUMN ${column.name} ${column.type}`, (err) => {
            if (err && !err.message.includes('duplicate column name')) {
                console.error(`Error adding column ${column.name}:`, err.message);
            } else if (!err) {
                console.log(`✓ Added column to reminders: ${column.name}`);
            }
        });
    });
    
    // Add missing columns to activity_log table
    const activityColumns = [
        { name: 'ip_address', type: 'TEXT' },
        { name: 'user_agent', type: 'TEXT' },
        { name: 'request_method', type: 'TEXT' },
        { name: 'request_url', type: 'TEXT' },
        { name: 'response_status', type: 'INTEGER' },
        { name: 'response_time', type: 'INTEGER' }
    ];
    
    activityColumns.forEach(column => {
        db.run(`ALTER TABLE activity_log ADD COLUMN ${column.name} ${column.type}`, (err) => {
            if (err && !err.message.includes('duplicate column name')) {
                console.error(`Error adding column ${column.name}:`, err.message);
            } else if (!err) {
                console.log(`✓ Added column to activity_log: ${column.name}`);
            }
        });
    });
    
    // Add missing columns to email_log table
    const emailColumns = [
        { name: 'body', type: 'TEXT' },
        { name: 'error_message', type: 'TEXT' }
    ];
    
    emailColumns.forEach(column => {
        db.run(`ALTER TABLE email_log ADD COLUMN ${column.name} ${column.type}`, (err) => {
            if (err && !err.message.includes('duplicate column name')) {
                console.error(`Error adding column ${column.name}:`, err.message);
            } else if (!err) {
                console.log(`✓ Added column to email_log: ${column.name}`);
            }
        });
    });
    
    // Add missing columns to suggestions table
    const suggestionColumns = [
        { name: 'priority', type: 'INTEGER DEFAULT 0' },
        { name: 'is_read', type: 'INTEGER DEFAULT 0' },
        { name: 'read_at', type: 'DATETIME' },
        { name: 'action_taken', type: 'TEXT' }
    ];
    
    suggestionColumns.forEach(column => {
        db.run(`ALTER TABLE suggestions ADD COLUMN ${column.name} ${column.type}`, (err) => {
            if (err && !err.message.includes('duplicate column name')) {
                console.error(`Error adding column ${column.name}:`, err.message);
            } else if (!err) {
                console.log(`✓ Added column to suggestions: ${column.name}`);
            }
        });
    });
    
    // Add missing columns to projects table
    const projectColumns = [
        { name: 'color', type: 'TEXT' },
        { name: 'progress', type: 'INTEGER DEFAULT 0' },
        { name: 'start_date', type: 'DATETIME' },
        { name: 'end_date', type: 'DATETIME' }
    ];
    
    projectColumns.forEach(column => {
        db.run(`ALTER TABLE projects ADD COLUMN ${column.name} ${column.type}`, (err) => {
            if (err && !err.message.includes('duplicate column name')) {
                console.error(`Error adding column ${column.name}:`, err.message);
            } else if (!err) {
                console.log(`✓ Added column to projects: ${column.name}`);
            }
        });
    });
    
    // Update existing users with default values
    db.run(`UPDATE users SET email_notifications = 1 WHERE email_notifications IS NULL`, (err) => {
        if (!err) console.log('✓ Updated existing users with default notifications');
    });
    
    db.run(`UPDATE users SET push_notifications = 1 WHERE push_notifications IS NULL`, (err) => {
        if (!err) console.log('✓ Updated existing users with default push notifications');
    });
    
    db.run(`UPDATE users SET timezone = 'UTC' WHERE timezone IS NULL`, (err) => {
        if (!err) console.log('✓ Updated existing users with default timezone');
    });
    
    db.run(`UPDATE users SET theme = 'light' WHERE theme IS NULL`, (err) => {
        if (!err) console.log('✓ Updated existing users with default theme');
    });
    
    db.run(`UPDATE users SET login_count = 0 WHERE login_count IS NULL`, (err) => {
        if (!err) console.log('✓ Updated existing users with login count');
    });
    
    db.run(`UPDATE users SET failed_login_attempts = 0 WHERE failed_login_attempts IS NULL`, (err) => {
        if (!err) console.log('✓ Updated existing users with failed login attempts');
    });
    
    // Update existing tasks with default values
    db.run(`UPDATE tasks SET priority = 2 WHERE priority IS NULL`, (err) => {
        if (!err) console.log('✓ Updated existing tasks with default priority');
    });
    
    db.run(`UPDATE tasks SET reminder_count = 0 WHERE reminder_count IS NULL`, (err) => {
        if (!err) console.log('✓ Updated existing tasks with reminder count');
    });
    
    // Create triggers if they don't exist
    db.run(`CREATE TRIGGER IF NOT EXISTS update_users_timestamp 
            AFTER UPDATE ON users
            BEGIN
                UPDATE users SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
            END`, (err) => {
        if (!err) console.log('✓ Created users update trigger');
    });
    
    db.run(`CREATE TRIGGER IF NOT EXISTS update_tasks_timestamp 
            AFTER UPDATE ON tasks
            BEGIN
                UPDATE tasks SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
            END`, (err) => {
        if (!err) console.log('✓ Created tasks update trigger');
    });
    
    db.run(`CREATE TRIGGER IF NOT EXISTS update_projects_timestamp 
            AFTER UPDATE ON projects
            BEGIN
                UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
            END`, (err) => {
        if (!err) console.log('✓ Created projects update trigger');
    });
    
    // Verify migration
    setTimeout(() => {
        db.get("SELECT * FROM users LIMIT 1", (err, user) => {
            if (err) {
                console.error('Error verifying migration:', err);
            } else {
                console.log('\n✅ Migration completed successfully!');
                console.log('Added columns to:');
                console.log('  - users table');
                console.log('  - tasks table');
                console.log('  - reminders table');
                console.log('  - activity_log table');
                console.log('  - email_log table');
                console.log('  - suggestions table');
                console.log('  - projects table');
                console.log('\nYou can now restart the server.');
            }
            db.close();
        });
    }, 2000);
}); 