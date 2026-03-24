const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const DB_PATH = './database.sqlite';

console.log('🔧 TaskWeaver Database Fix Script');
console.log('================================');

// Check if database exists
if (!fs.existsSync(DB_PATH)) {
    console.log('❌ Database file not found. Please start the server first to create the database.');
    process.exit(1);
}

// Create backup before making changes
function backupDatabase() {
    const backupPath = `database_backup_${Date.now()}.sqlite`;
    console.log(`📦 Creating database backup: ${backupPath}`);
    
    try {
        fs.copyFileSync(DB_PATH, backupPath);
        console.log('✅ Backup created successfully');
        return true;
    } catch (error) {
        console.error('❌ Failed to create backup:', error.message);
        return false;
    }
}

function fixDatabase() {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(DB_PATH, (err) => {
            if (err) {
                console.error('❌ Failed to open database:', err);
                reject(err);
                return;
            }
            
            console.log('📂 Database opened successfully');
            
            db.serialize(() => {
                // Enable foreign keys
                db.run("PRAGMA foreign_keys = ON");
                db.run("PRAGMA journal_mode = WAL");
                
                // Fix activity_log table - add email column if missing
                console.log('\n🔍 Checking and fixing activity_log table...');
                db.all("PRAGMA table_info(activity_log)", (err, cols) => {
                    if (err) {
                        console.error('Error checking table:', err);
                    } else {
                        const hasEmail = cols.some(col => col.name === 'email');
                        if (!hasEmail) {
                            console.log('📝 Adding email column to activity_log...');
                            db.run("ALTER TABLE activity_log ADD COLUMN email TEXT", (err) => {
                                if (err) {
                                    console.error('❌ Failed to add email column:', err);
                                } else {
                                    console.log('✅ Email column added to activity_log');
                                }
                            });
                        } else {
                            console.log('✅ Email column already exists in activity_log');
                        }
                    }
                });
                
                // Fix reminders table - add user_email column if missing
                console.log('\n🔍 Checking and fixing reminders table...');
                db.all("PRAGMA table_info(reminders)", (err, cols) => {
                    if (err) {
                        console.error('Error checking reminders table:', err);
                    } else {
                        const hasUserEmail = cols.some(col => col.name === 'user_email');
                        if (!hasUserEmail) {
                            console.log('📝 Adding user_email column to reminders...');
                            db.run("ALTER TABLE reminders ADD COLUMN user_email TEXT", (err) => {
                                if (err) {
                                    console.error('❌ Failed to add user_email column:', err);
                                } else {
                                    console.log('✅ user_email column added to reminders');
                                    // Update existing records
                                    db.run(`UPDATE reminders SET user_email = (
                                        SELECT email FROM users WHERE users.id = reminders.user_id
                                    ) WHERE user_email IS NULL`, (err) => {
                                        if (err) {
                                            console.error('❌ Failed to update user_email:', err);
                                        } else {
                                            console.log('✅ Updated existing reminders with user_email');
                                        }
                                    });
                                }
                            });
                        } else {
                            console.log('✅ user_email column already exists in reminders');
                        }
                    }
                });
                
                // Fix email_log table - add user_email column if missing
                console.log('\n🔍 Checking and fixing email_log table...');
                db.all("PRAGMA table_info(email_log)", (err, cols) => {
                    if (err) {
                        console.error('Error checking email_log table:', err);
                    } else {
                        const hasUserEmail = cols.some(col => col.name === 'user_email');
                        if (!hasUserEmail) {
                            console.log('📝 Adding user_email column to email_log...');
                            db.run("ALTER TABLE email_log ADD COLUMN user_email TEXT", (err) => {
                                if (err) {
                                    console.error('❌ Failed to add user_email column:', err);
                                } else {
                                    console.log('✅ user_email column added to email_log');
                                }
                            });
                        } else {
                            console.log('✅ user_email column already exists in email_log');
                        }
                    }
                });
                
                // Fix tasks table - add user_email column if missing
                console.log('\n🔍 Checking and fixing tasks table...');
                db.all("PRAGMA table_info(tasks)", (err, cols) => {
                    if (err) {
                        console.error('Error checking tasks table:', err);
                    } else {
                        const hasUserEmail = cols.some(col => col.name === 'user_email');
                        if (!hasUserEmail) {
                            console.log('📝 Adding user_email column to tasks...');
                            db.run("ALTER TABLE tasks ADD COLUMN user_email TEXT", (err) => {
                                if (err) {
                                    console.error('❌ Failed to add user_email column:', err);
                                } else {
                                    console.log('✅ user_email column added to tasks');
                                    // Update existing records
                                    db.run(`UPDATE tasks SET user_email = (
                                        SELECT email FROM users WHERE users.id = tasks.user_id
                                    ) WHERE user_email IS NULL`, (err) => {
                                        if (err) {
                                            console.error('❌ Failed to update user_email:', err);
                                        } else {
                                            console.log('✅ Updated existing tasks with user_email');
                                        }
                                    });
                                }
                            });
                        } else {
                            console.log('✅ user_email column already exists in tasks');
                        }
                    }
                });
                
                // Fix suggestions table - add user_email column if missing
                console.log('\n🔍 Checking and fixing suggestions table...');
                db.all("PRAGMA table_info(suggestions)", (err, cols) => {
                    if (err) {
                        console.error('Error checking suggestions table:', err);
                    } else {
                        const hasUserEmail = cols.some(col => col.name === 'user_email');
                        if (!hasUserEmail) {
                            console.log('📝 Adding user_email column to suggestions...');
                            db.run("ALTER TABLE suggestions ADD COLUMN user_email TEXT", (err) => {
                                if (err) {
                                    console.error('❌ Failed to add user_email column:', err);
                                } else {
                                    console.log('✅ user_email column added to suggestions');
                                }
                            });
                        } else {
                            console.log('✅ user_email column already exists in suggestions');
                        }
                    }
                });
                
                // Fix projects table - add user_email column if missing
                console.log('\n🔍 Checking and fixing projects table...');
                db.all("PRAGMA table_info(projects)", (err, cols) => {
                    if (err) {
                        console.error('Error checking projects table:', err);
                    } else {
                        const hasUserEmail = cols.some(col => col.name === 'user_email');
                        if (!hasUserEmail) {
                            console.log('📝 Adding user_email column to projects...');
                            db.run("ALTER TABLE projects ADD COLUMN user_email TEXT", (err) => {
                                if (err) {
                                    console.error('❌ Failed to add user_email column:', err);
                                } else {
                                    console.log('✅ user_email column added to projects');
                                }
                            });
                        } else {
                            console.log('✅ user_email column already exists in projects');
                        }
                    }
                });
                
                // Fix shared_schedules table - ensure all columns exist
                console.log('\n🔍 Checking shared_schedules table...');
                db.all("PRAGMA table_info(shared_schedules)", (err, cols) => {
                    if (err) {
                        console.error('Error checking shared_schedules:', err);
                    } else if (cols && cols.length > 0) {
                        const existingColumns = cols.map(c => c.name);
                        
                        if (!existingColumns.includes('user_email')) {
                            console.log('📝 Adding user_email column to shared_schedules...');
                            db.run("ALTER TABLE shared_schedules ADD COLUMN user_email TEXT", (err) => {
                                if (err) {
                                    console.error('❌ Failed to add user_email:', err);
                                } else {
                                    console.log('✅ user_email column added');
                                }
                            });
                        }
                    } else {
                        console.log('⚠️  shared_schedules table not found, will be created on server restart');
                    }
                });
                
                // Fix users table - add email_verified and verification_token if missing
                console.log('\n🔍 Checking users table...');
                db.all("PRAGMA table_info(users)", (err, cols) => {
                    if (err) {
                        console.error('Error checking users table:', err);
                    } else {
                        const existingColumns = cols.map(c => c.name);
                        
                        if (!existingColumns.includes('email_verified')) {
                            console.log('📝 Adding email_verified column to users...');
                            db.run("ALTER TABLE users ADD COLUMN email_verified INTEGER DEFAULT 0", (err) => {
                                if (err) {
                                    console.error('❌ Failed to add email_verified:', err);
                                } else {
                                    console.log('✅ email_verified column added');
                                }
                            });
                        } else {
                            console.log('✅ email_verified column exists');
                        }
                        
                        if (!existingColumns.includes('verification_token')) {
                            console.log('📝 Adding verification_token column to users...');
                            db.run("ALTER TABLE users ADD COLUMN verification_token TEXT", (err) => {
                                if (err) {
                                    console.error('❌ Failed to add verification_token:', err);
                                } else {
                                    console.log('✅ verification_token column added');
                                }
                            });
                        } else {
                            console.log('✅ verification_token column exists');
                        }
                        
                        // Verify demo user has email_verified = 1
                        db.run(`UPDATE users SET email_verified = 1 WHERE email = 'demo@taskweaver.com'`, (err) => {
                            if (err) {
                                console.error('❌ Failed to update demo user:', err);
                            } else {
                                console.log('✅ Demo user verified');
                            }
                        });
                    }
                });
                
                // Create missing indexes
                console.log('\n🔍 Creating missing indexes...');
                const indexes = [
                    'CREATE INDEX IF NOT EXISTS idx_activity_log_email ON activity_log(email)',
                    'CREATE INDEX IF NOT EXISTS idx_tasks_user_email ON tasks(user_email)',
                    'CREATE INDEX IF NOT EXISTS idx_reminders_user_email ON reminders(user_email)',
                    'CREATE INDEX IF NOT EXISTS idx_email_log_user_email ON email_log(user_email)',
                    'CREATE INDEX IF NOT EXISTS idx_suggestions_user_email ON suggestions(user_email)',
                    'CREATE INDEX IF NOT EXISTS idx_projects_user_email ON projects(user_email)'
                ];
                
                let indexCount = 0;
                indexes.forEach(sql => {
                    db.run(sql, (err) => {
                        if (err) {
                            console.log(`⚠️  Index already exists or error: ${sql.split('ON')[0]}`);
                        } else {
                            console.log(`✅ Index created: ${sql.split('ON')[1].trim()}`);
                        }
                        indexCount++;
                        if (indexCount === indexes.length) {
                            console.log('\n🎉 Database fix complete!');
                            setTimeout(() => {
                                db.close((err) => {
                                    if (err) {
                                        console.error('Error closing database:', err);
                                    } else {
                                        console.log('📁 Database closed');
                                        resolve();
                                    }
                                });
                            }, 1000);
                        }
                    });
                });
            });
        });
    });
}

// Run the fix
async function run() {
    console.log('\n⚠️  This script will fix database issues and create a backup.');
    console.log('⚠️  Please ensure the server is NOT running while this script executes.\n');
    
    // Backup database
    backupDatabase();
    
    // Fix database
    try {
        await fixDatabase();
        console.log('\n✅ Database fix completed successfully!');
        console.log('\n📝 Next steps:');
        console.log('1. Restart the server: npm start');
        console.log('2. Clear browser cache');
        console.log('3. Login again');
    } catch (error) {
        console.error('\n❌ Database fix failed:', error);
    }
}

run();