const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./database.sqlite');

console.log('Fixing database triggers...\n');

db.serialize(() => {
    // Drop existing triggers
    console.log('Dropping existing triggers...');
    db.run("DROP TRIGGER IF EXISTS update_users_timestamp");
    db.run("DROP TRIGGER IF EXISTS update_tasks_timestamp");
    db.run("DROP TRIGGER IF EXISTS update_projects_timestamp");
    
    // Check if updated_at column exists in users table
    db.all("PRAGMA table_info(users)", (err, columns) => {
        const hasUpdatedAt = columns.some(c => c.name === 'updated_at');
        
        if (!hasUpdatedAt) {
            console.log('Adding updated_at column to users table...');
            db.run("ALTER TABLE users ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP");
        } else {
            console.log('updated_at column already exists in users table');
        }
        
        // Check if updated_at column exists in tasks table
        db.all("PRAGMA table_info(tasks)", (err, taskColumns) => {
            const hasTaskUpdatedAt = taskColumns.some(c => c.name === 'updated_at');
            
            if (!hasTaskUpdatedAt) {
                console.log('Adding updated_at column to tasks table...');
                db.run("ALTER TABLE tasks ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP");
            } else {
                console.log('updated_at column already exists in tasks table');
            }
            
            // Check if updated_at column exists in projects table
            db.all("PRAGMA table_info(projects)", (err, projColumns) => {
                const hasProjUpdatedAt = projColumns && projColumns.some(c => c.name === 'updated_at');
                
                if (projColumns && !hasProjUpdatedAt) {
                    console.log('Adding updated_at column to projects table...');
                    db.run("ALTER TABLE projects ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP");
                } else if (projColumns) {
                    console.log('updated_at column already exists in projects table');
                }
                
                // Recreate triggers with proper error handling
                console.log('\nRecreating triggers...');
                
                db.run(`CREATE TRIGGER IF NOT EXISTS update_users_timestamp 
                        AFTER UPDATE ON users
                        BEGIN
                            UPDATE users SET updated_at = CURRENT_TIMESTAMP 
                            WHERE id = NEW.id AND updated_at IS NOT NULL;
                        END`, (err) => {
                    if (err) {
                        console.error('Error creating users trigger:', err.message);
                    } else {
                        console.log('✓ Users trigger created');
                    }
                });
                
                db.run(`CREATE TRIGGER IF NOT EXISTS update_tasks_timestamp 
                        AFTER UPDATE ON tasks
                        BEGIN
                            UPDATE tasks SET updated_at = CURRENT_TIMESTAMP 
                            WHERE id = NEW.id AND updated_at IS NOT NULL;
                        END`, (err) => {
                    if (err) {
                        console.error('Error creating tasks trigger:', err.message);
                    } else {
                        console.log('✓ Tasks trigger created');
                    }
                });
                
                db.run(`CREATE TRIGGER IF NOT EXISTS update_projects_timestamp 
                        AFTER UPDATE ON projects
                        BEGIN
                            UPDATE projects SET updated_at = CURRENT_TIMESTAMP 
                            WHERE id = NEW.id AND updated_at IS NOT NULL;
                        END`, (err) => {
                    if (err) {
                        console.error('Error creating projects trigger:', err.message);
                    } else {
                        console.log('✓ Projects trigger created');
                    }
                });
                
                // Update existing records
                console.log('\nUpdating existing records...');
                db.run("UPDATE users SET updated_at = CURRENT_TIMESTAMP WHERE updated_at IS NULL", (err) => {
                    if (err) console.error('Error updating users:', err.message);
                    else console.log('✓ Updated users records');
                });
                
                db.run("UPDATE tasks SET updated_at = CURRENT_TIMESTAMP WHERE updated_at IS NULL", (err) => {
                    if (err) console.error('Error updating tasks:', err.message);
                    else console.log('✓ Updated tasks records');
                });
                
                if (projColumns) {
                    db.run("UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE updated_at IS NULL", (err) => {
                        if (err) console.error('Error updating projects:', err.message);
                        else console.log('✓ Updated projects records');
                    });
                }
                
                setTimeout(() => {
                    console.log('\n✅ Database fix completed!');
                    console.log('Restart your server: npm start\n');
                    db.close();
                }, 1000);
            });
        });
    });
});