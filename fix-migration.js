const sqlite3 = require('sqlite3').verbose();

const db = new sqlite3.Database('./database.sqlite');

console.log('🔧 Starting database fix migration...\n');

db.serialize(() => {
    // Add missing columns to users table
    const userMissingColumns = [
        { name: 'updated_at', type: 'DATETIME DEFAULT CURRENT_TIMESTAMP' },
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
    
    console.log('📊 Adding missing columns to users table...');
    userMissingColumns.forEach(column => {
        db.run(`ALTER TABLE users ADD COLUMN ${column.name} ${column.type}`, (err) => {
            if (err && !err.message.includes('duplicate column name')) {
                console.error(`   ✗ Error adding ${column.name}:`, err.message);
            } else if (!err) {
                console.log(`   ✓ Added column: ${column.name}`);
            } else {
                console.log(`   → Column already exists: ${column.name}`);
            }
        });
    });
    
    // Add missing columns to tasks table
    const taskMissingColumns = [
        { name: 'updated_at', type: 'DATETIME DEFAULT CURRENT_TIMESTAMP' },
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
    
    console.log('\n📊 Adding missing columns to tasks table...');
    taskMissingColumns.forEach(column => {
        db.run(`ALTER TABLE tasks ADD COLUMN ${column.name} ${column.type}`, (err) => {
            if (err && !err.message.includes('duplicate column name')) {
                console.error(`   ✗ Error adding ${column.name}:`, err.message);
            } else if (!err) {
                console.log(`   ✓ Added column: ${column.name}`);
            } else {
                console.log(`   → Column already exists: ${column.name}`);
            }
        });
    });
    
    // Add missing columns to reminders table
    const reminderMissingColumns = [
        { name: 'reminder_method', type: 'TEXT DEFAULT "email"' },
        { name: 'sent_at', type: 'DATETIME' },
        { name: 'retry_count', type: 'INTEGER DEFAULT 0' },
        { name: 'last_error', type: 'TEXT' }
    ];
    
    console.log('\n📊 Adding missing columns to reminders table...');
    reminderMissingColumns.forEach(column => {
        db.run(`ALTER TABLE reminders ADD COLUMN ${column.name} ${column.type}`, (err) => {
            if (err && !err.message.includes('duplicate column name')) {
                console.error(`   ✗ Error adding ${column.name}:`, err.message);
            } else if (!err) {
                console.log(`   ✓ Added column: ${column.name}`);
            } else {
                console.log(`   → Column already exists: ${column.name}`);
            }
        });
    });
    
    // Add missing columns to activity_log table
    const activityMissingColumns = [
        { name: 'ip_address', type: 'TEXT' },
        { name: 'user_agent', type: 'TEXT' },
        { name: 'request_method', type: 'TEXT' },
        { name: 'request_url', type: 'TEXT' },
        { name: 'response_status', type: 'INTEGER' },
        { name: 'response_time', type: 'INTEGER' }
    ];
    
    console.log('\n📊 Adding missing columns to activity_log table...');
    activityMissingColumns.forEach(column => {
        db.run(`ALTER TABLE activity_log ADD COLUMN ${column.name} ${column.type}`, (err) => {
            if (err && !err.message.includes('duplicate column name')) {
                console.error(`   ✗ Error adding ${column.name}:`, err.message);
            } else if (!err) {
                console.log(`   ✓ Added column: ${column.name}`);
            } else {
                console.log(`   → Column already exists: ${column.name}`);
            }
        });
    });
    
    // Add missing columns to email_log table
    const emailMissingColumns = [
        { name: 'body', type: 'TEXT' },
        { name: 'error_message', type: 'TEXT' }
    ];
    
    console.log('\n📊 Adding missing columns to email_log table...');
    emailMissingColumns.forEach(column => {
        db.run(`ALTER TABLE email_log ADD COLUMN ${column.name} ${column.type}`, (err) => {
            if (err && !err.message.includes('duplicate column name')) {
                console.error(`   ✗ Error adding ${column.name}:`, err.message);
            } else if (!err) {
                console.log(`   ✓ Added column: ${column.name}`);
            } else {
                console.log(`   → Column already exists: ${column.name}`);
            }
        });
    });
    
    // Add missing columns to suggestions table
    const suggestionMissingColumns = [
        { name: 'priority', type: 'INTEGER DEFAULT 0' },
        { name: 'is_read', type: 'INTEGER DEFAULT 0' },
        { name: 'read_at', type: 'DATETIME' },
        { name: 'action_taken', type: 'TEXT' }
    ];
    
    console.log('\n📊 Adding missing columns to suggestions table...');
    suggestionMissingColumns.forEach(column => {
        db.run(`ALTER TABLE suggestions ADD COLUMN ${column.name} ${column.type}`, (err) => {
            if (err && !err.message.includes('duplicate column name')) {
                console.error(`   ✗ Error adding ${column.name}:`, err.message);
            } else if (!err) {
                console.log(`   ✓ Added column: ${column.name}`);
            } else {
                console.log(`   → Column already exists: ${column.name}`);
            }
        });
    });
    
    // Add missing columns to projects table
    const projectMissingColumns = [
        { name: 'updated_at', type: 'DATETIME DEFAULT CURRENT_TIMESTAMP' },
        { name: 'color', type: 'TEXT' },
        { name: 'progress', type: 'INTEGER DEFAULT 0' },
        { name: 'start_date', type: 'DATETIME' },
        { name: 'end_date', type: 'DATETIME' }
    ];
    
    console.log('\n📊 Adding missing columns to projects table...');
    projectMissingColumns.forEach(column => {
        db.run(`ALTER TABLE projects ADD COLUMN ${column.name} ${column.type}`, (err) => {
            if (err && !err.message.includes('duplicate column name')) {
                console.error(`   ✗ Error adding ${column.name}:`, err.message);
            } else if (!err) {
                console.log(`   ✓ Added column: ${column.name}`);
            } else {
                console.log(`   → Column already exists: ${column.name}`);
            }
        });
    });
    
    // Update existing records with default values
    console.log('\n📊 Updating existing records with default values...');
    
    db.run(`UPDATE users SET updated_at = CURRENT_TIMESTAMP WHERE updated_at IS NULL`, (err) => {
        if (!err) console.log('   ✓ Updated users.updated_at');
    });
    
    db.run(`UPDATE users SET email_notifications = 1 WHERE email_notifications IS NULL`, (err) => {
        if (!err) console.log('   ✓ Updated users.email_notifications');
    });
    
    db.run(`UPDATE users SET push_notifications = 1 WHERE push_notifications IS NULL`, (err) => {
        if (!err) console.log('   ✓ Updated users.push_notifications');
    });
    
    db.run(`UPDATE users SET timezone = 'UTC' WHERE timezone IS NULL`, (err) => {
        if (!err) console.log('   ✓ Updated users.timezone');
    });
    
    db.run(`UPDATE users SET theme = 'light' WHERE theme IS NULL`, (err) => {
        if (!err) console.log('   ✓ Updated users.theme');
    });
    
    db.run(`UPDATE users SET login_count = 0 WHERE login_count IS NULL`, (err) => {
        if (!err) console.log('   ✓ Updated users.login_count');
    });
    
    db.run(`UPDATE users SET failed_login_attempts = 0 WHERE failed_login_attempts IS NULL`, (err) => {
        if (!err) console.log('   ✓ Updated users.failed_login_attempts');
    });
    
    db.run(`UPDATE tasks SET updated_at = CURRENT_TIMESTAMP WHERE updated_at IS NULL`, (err) => {
        if (!err) console.log('   ✓ Updated tasks.updated_at');
    });
    
    db.run(`UPDATE tasks SET priority = 2 WHERE priority IS NULL`, (err) => {
        if (!err) console.log('   ✓ Updated tasks.priority');
    });
    
    db.run(`UPDATE tasks SET reminder_count = 0 WHERE reminder_count IS NULL`, (err) => {
        if (!err) console.log('   ✓ Updated tasks.reminder_count');
    });
    
    db.run(`UPDATE reminders SET reminder_method = 'email' WHERE reminder_method IS NULL`, (err) => {
        if (!err) console.log('   ✓ Updated reminders.reminder_method');
    });
    
    db.run(`UPDATE reminders SET retry_count = 0 WHERE retry_count IS NULL`, (err) => {
        if (!err) console.log('   ✓ Updated reminders.retry_count');
    });
    
    db.run(`UPDATE suggestions SET priority = 0 WHERE priority IS NULL`, (err) => {
        if (!err) console.log('   ✓ Updated suggestions.priority');
    });
    
    db.run(`UPDATE suggestions SET is_read = 0 WHERE is_read IS NULL`, (err) => {
        if (!err) console.log('   ✓ Updated suggestions.is_read');
    });
    
    db.run(`UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE updated_at IS NULL`, (err) => {
        if (!err) console.log('   ✓ Updated projects.updated_at');
    });
    
    db.run(`UPDATE projects SET progress = 0 WHERE progress IS NULL`, (err) => {
        if (!err) console.log('   ✓ Updated projects.progress');
    });
    
    // Create triggers for updated_at if they don't exist
    console.log('\n📊 Creating update triggers...');
    
    db.run(`CREATE TRIGGER IF NOT EXISTS update_users_timestamp 
            AFTER UPDATE ON users
            BEGIN
                UPDATE users SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
            END`, (err) => {
        if (!err) console.log('   ✓ Created users update trigger');
    });
    
    db.run(`CREATE TRIGGER IF NOT EXISTS update_tasks_timestamp 
            AFTER UPDATE ON tasks
            BEGIN
                UPDATE tasks SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
            END`, (err) => {
        if (!err) console.log('   ✓ Created tasks update trigger');
    });
    
    db.run(`CREATE TRIGGER IF NOT EXISTS update_projects_timestamp 
            AFTER UPDATE ON projects
            BEGIN
                UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
            END`, (err) => {
        if (!err) console.log('   ✓ Created projects update trigger');
    });
    
    // Verify the migration
    setTimeout(() => {
        console.log('\n✅ Migration completed successfully!\n');
        
        // Check users table structure
        db.all("PRAGMA table_info(users)", (err, columns) => {
            if (!err) {
                console.log('📋 Users table columns:');
                columns.forEach(col => {
                    console.log(`   - ${col.name} (${col.type})`);
                });
            }
        });
        
        console.log('\n🔄 Please restart your server: npm start\n');
        db.close();
    }, 2000);
});