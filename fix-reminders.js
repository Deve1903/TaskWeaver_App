const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');

const DB_PATH = './database.sqlite';

console.log('🔧 TaskWeaver Reminder System Fix');
console.log('================================');

if (!fs.existsSync(DB_PATH)) {
    console.log('❌ Database file not found. Please start the server first.');
    process.exit(1);
}

const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) {
        console.error('❌ Failed to open database:', err);
        process.exit(1);
    }
    
    console.log('📂 Database opened successfully\n');
    
    db.serialize(() => {
        // Check if reminders table exists
        db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='reminders'", (err, table) => {
            if (err || !table) {
                console.log('⚠️  Reminders table not found. It will be created when server restarts.');
                db.close();
                return;
            }
            
            // Check and fix reminders table structure
            console.log('🔍 Checking reminders table structure...');
            db.all("PRAGMA table_info(reminders)", (err, columns) => {
                if (err) {
                    console.error('Error checking table:', err);
                    db.close();
                    return;
                }
                
                console.log('Current columns:', columns.map(c => c.name).join(', '));
                
                // Add missing columns
                const existingColumns = columns.map(c => c.name);
                
                if (!existingColumns.includes('user_email')) {
                    console.log('📝 Adding user_email column...');
                    db.run("ALTER TABLE reminders ADD COLUMN user_email TEXT", (err) => {
                        if (err) {
                            console.error('❌ Failed to add user_email:', err.message);
                        } else {
                            console.log('✅ user_email column added');
                        }
                    });
                }
                
                if (!existingColumns.includes('reminder_type')) {
                    console.log('📝 Adding reminder_type column...');
                    db.run("ALTER TABLE reminders ADD COLUMN reminder_type TEXT DEFAULT 'scheduled'", (err) => {
                        if (err) {
                            console.error('❌ Failed to add reminder_type:', err.message);
                        } else {
                            console.log('✅ reminder_type column added');
                        }
                    });
                }
                
                if (!existingColumns.includes('reminder_method')) {
                    console.log('📝 Adding reminder_method column...');
                    db.run("ALTER TABLE reminders ADD COLUMN reminder_method TEXT DEFAULT 'email'", (err) => {
                        if (err) {
                            console.error('❌ Failed to add reminder_method:', err.message);
                        } else {
                            console.log('✅ reminder_method column added');
                        }
                    });
                }
                
                if (!existingColumns.includes('retry_count')) {
                    console.log('📝 Adding retry_count column...');
                    db.run("ALTER TABLE reminders ADD COLUMN retry_count INTEGER DEFAULT 0", (err) => {
                        if (err) {
                            console.error('❌ Failed to add retry_count:', err.message);
                        } else {
                            console.log('✅ retry_count column added');
                        }
                    });
                }
                
                if (!existingColumns.includes('last_error')) {
                    console.log('📝 Adding last_error column...');
                    db.run("ALTER TABLE reminders ADD COLUMN last_error TEXT", (err) => {
                        if (err) {
                            console.error('❌ Failed to add last_error:', err.message);
                        } else {
                            console.log('✅ last_error column added');
                        }
                    });
                }
            });
        });
        
        // Update existing reminders with user_email
        setTimeout(() => {
            console.log('\n🔍 Updating existing reminders with user_email...');
            db.run(`UPDATE reminders SET user_email = (
                SELECT email FROM users WHERE users.id = reminders.user_id
            ) WHERE user_email IS NULL OR user_email = ''`, function(err) {
                if (err) {
                    console.error('❌ Failed to update reminders:', err);
                } else {
                    console.log(`✅ Updated ${this.changes || 0} reminders with user_email`);
                }
            });
            
            // Fix any reminders with invalid data
            console.log('\n🔍 Cleaning up invalid reminders...');
            db.run(`DELETE FROM reminders WHERE task_id NOT IN (SELECT id FROM tasks)`, function(err) {
                if (err) {
                    console.error('❌ Failed to clean up reminders:', err);
                } else {
                    console.log(`✅ Removed ${this.changes || 0} invalid reminders`);
                }
            });
            
            // Test the reminder query
            setTimeout(() => {
                console.log('\n🔍 Testing reminder query...');
                db.all(`
                    SELECT r.*, t.title, t.description, t.user_id, u.email_notifications
                    FROM reminders r
                    JOIN tasks t ON r.task_id = t.id
                    JOIN users u ON r.user_id = u.id
                    WHERE r.reminder_time <= datetime('now')
                    AND r.sent = 0
                    AND u.email_notifications = 1
                    AND t.completed = 0
                    AND (t.deleted_at IS NULL OR t.deleted_at = '')
                    LIMIT 5
                `, (err, reminders) => {
                    if (err) {
                        console.error('❌ Reminder query failed:', err);
                    } else {
                        console.log(`✅ Reminder query successful. Found ${reminders.length} pending reminders`);
                        if (reminders.length > 0) {
                            console.log('\nSample pending reminders:');
                            reminders.forEach(r => {
                                console.log(`  - ${r.title} (Reminder: ${new Date(r.reminder_time).toLocaleString()})`);
                            });
                        }
                    }
                    
                    // Close database
                    setTimeout(() => {
                        db.close((err) => {
                            if (err) {
                                console.error('Error closing database:', err);
                            } else {
                                console.log('\n🎉 Reminder fix completed!');
                                console.log('\n📝 Next steps:');
                                console.log('1. Restart the server: npm start');
                                console.log('2. Test reminders by adding a task with a deadline');
                            }
                        });
                    }, 1000);
                });
            }, 500);
        }, 500);
    });
});