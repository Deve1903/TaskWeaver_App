const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');

const db = new sqlite3.Database('./database.sqlite');

// Simple schema without any complex constraints
const schema = `
-- Users table
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    reset_token TEXT,
    reset_token_expiry DATETIME,
    reminder_interval INTEGER DEFAULT 20,
    auto_reminders INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_login DATETIME
);

-- Tasks table
CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    project TEXT,
    category TEXT,
    severity TEXT DEFAULT 'Medium',
    deadline DATETIME,
    is_recurring INTEGER DEFAULT 0,
    recurrence_pattern TEXT,
    scheduled_start DATETIME,
    scheduled_end DATETIME,
    completed INTEGER DEFAULT 0,
    email_reminder_sent INTEGER DEFAULT 0,
    deadline_reminder_sent INTEGER DEFAULT 0,
    overdue_reminder_sent INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Reminders table
CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    task_id INTEGER NOT NULL,
    reminder_time DATETIME NOT NULL,
    reminder_type TEXT DEFAULT 'scheduled',
    sent INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Suggestions table
CREATE TABLE IF NOT EXISTS suggestions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    suggestion TEXT NOT NULL,
    type TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Activity log table
CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    details TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_tasks_user_id ON tasks(user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_scheduled_start ON tasks(scheduled_start);
CREATE INDEX IF NOT EXISTS idx_tasks_deadline ON tasks(deadline);
CREATE INDEX IF NOT EXISTS idx_reminders_reminder_time ON reminders(reminder_time);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
`;

console.log('📦 Creating database schema...');

// Drop all tables first (clean slate)
db.exec(`
DROP TABLE IF EXISTS activity_log;
DROP TABLE IF EXISTS suggestions;
DROP TABLE IF EXISTS reminders;
DROP TABLE IF EXISTS tasks;
DROP TABLE IF EXISTS users;
`, (err) => {
    if (err) console.log('No tables to drop');
    
    // Create new schema
    db.exec(schema, async (err) => {
        if (err) {
            console.error('Error creating schema:', err);
            process.exit(1);
        }
        console.log('✓ Database schema created');
        
        // Create demo user
        const demoEmail = 'demo@taskweaver.com';
        const demoPassword = 'Demo@2024';
        const hash = await bcrypt.hash(demoPassword, 10);
        
        db.run(`INSERT INTO users (username, email, password, reminder_interval, auto_reminders) 
                VALUES (?, ?, ?, 20, 1)`,
            ['DEMOUSER', demoEmail, hash],
            function(err) {
                if (err) {
                    console.error('Error creating demo user:', err);
                    process.exit(1);
                }
                const userId = this.lastID;
                console.log('✓ Demo user created: demo@taskweaver.com / Demo@2024');
                
                // Get current date for dynamic dates
                const now = new Date();
                const today = new Date(now);
                const tomorrow = new Date(now);
                tomorrow.setDate(tomorrow.getDate() + 1);
                const dayAfter = new Date(now);
                dayAfter.setDate(dayAfter.getDate() + 2);
                const threeDays = new Date(now);
                threeDays.setDate(threeDays.getDate() + 3);
                const fiveDays = new Date(now);
                fiveDays.setDate(fiveDays.getDate() + 5);
                const sixDays = new Date(now);
                sixDays.setDate(sixDays.getDate() + 6);
                const sevenDays = new Date(now);
                sevenDays.setDate(sevenDays.getDate() + 7);
                const tenDays = new Date(now);
                tenDays.setDate(tenDays.getDate() + 10);
                const yesterday = new Date(now);
                yesterday.setDate(yesterday.getDate() - 1);
                const twoDaysAgo = new Date(now);
                twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
                
                // Format dates for SQLite
                const formatDate = (date) => date.toISOString().slice(0, 19).replace('T', ' ');
                
                // Insert sample tasks
                const tasks = [
                    // Critical task due tomorrow
                    [userId, 'Complete FHC Portal Authentication', 'Implement JWT authentication and user session management', 'FHC Portal', 'Work', 'Critical', formatDate(tomorrow), 0, null, formatDate(today), formatDate(new Date(today.getTime() + 3*60*60*1000)), 0],
                    
                    // High priority task due in 3 days
                    [userId, 'Customer Repair App Database Design', 'Design and implement SQLite schema for repair tracking', 'Customer Repair App', 'Work', 'High', formatDate(threeDays), 0, null, formatDate(dayAfter), formatDate(new Date(dayAfter.getTime() + 3*60*60*1000)), 0],
                    
                    // Medium priority task due in 5 days
                    [userId, 'Paint Tracks UI/UX Review', 'Review and provide feedback on new dashboard design', 'Paint Tracks', 'Work', 'Medium', formatDate(fiveDays), 0, null, formatDate(threeDays), formatDate(new Date(threeDays.getTime() + 2*60*60*1000)), 0],
                    
                    // Recurring study task
                    [userId, 'Study: Advanced Node.js Patterns', 'Learn about streams, clusters, and performance optimization', 'Personal Development', 'Study', 'Medium', formatDate(sevenDays), 1, 'daily', formatDate(tomorrow), formatDate(new Date(tomorrow.getTime() + 2*60*60*1000)), 0],
                    
                    // Family task
                    [userId, 'Family Dinner', 'Weekly family dinner at home', 'Family Time', 'Family', 'Low', formatDate(sixDays), 1, 'weekly', formatDate(sixDays), formatDate(new Date(sixDays.getTime() + 2*60*60*1000)), 0],
                    
                    // Critical task due today
                    [userId, 'Supplier Voucher Portal Testing', 'Perform end-to-end testing of voucher generation', 'Supplier Voucher Portal', 'Work', 'Critical', formatDate(today), 0, null, formatDate(today), formatDate(new Date(today.getTime() + 3*60*60*1000)), 0],
                    
                    // Daily meditation
                    [userId, 'Morning Meditation', 'Start the day with 15 minutes of mindfulness', 'Health', 'Rest', 'Low', null, 1, 'daily', formatDate(tomorrow), formatDate(new Date(tomorrow.getTime() + 15*60*1000)), 0],
                    
                    // Overdue task
                    [userId, 'Code Review: Customer Repair App', 'Review pull requests and provide feedback', 'Customer Repair App', 'Work', 'High', formatDate(yesterday), 0, null, formatDate(yesterday), formatDate(new Date(yesterday.getTime() + 2*60*60*1000)), 0],
                    
                    // Task due in 2 days
                    [userId, 'Deploy FHC Portal to Staging', 'Deploy latest changes to staging environment', 'FHC Portal', 'Work', 'High', formatDate(dayAfter), 0, null, formatDate(dayAfter), formatDate(new Date(dayAfter.getTime() + 2*60*60*1000)), 0],
                    
                    // Task due next week
                    [userId, 'Project Documentation', 'Create comprehensive documentation for all projects', 'Documentation', 'Work', 'Medium', formatDate(sevenDays), 0, null, formatDate(sixDays), formatDate(new Date(sixDays.getTime() + 3*60*60*1000)), 0],
                    
                    // Completed task
                    [userId, 'Team Meeting', 'Weekly team sync meeting', 'Meetings', 'Work', 'Medium', formatDate(twoDaysAgo), 0, null, formatDate(twoDaysAgo), formatDate(new Date(twoDaysAgo.getTime() + 1*60*60*1000)), 1],
                    
                    // Unscheduled task
                    [userId, 'Research AI Tools', 'Research and evaluate AI productivity tools', 'Research', 'Study', 'Low', formatDate(tenDays), 0, null, null, null, 0]
                ];
                
                let taskCount = 0;
                const taskIds = [];
                
                tasks.forEach((task, index) => {
                    db.run(`INSERT INTO tasks (user_id, title, description, project, category, severity, deadline, is_recurring, recurrence_pattern, scheduled_start, scheduled_end, completed)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                        task,
                        function(err) {
                            if (err) {
                                console.error('Error inserting task:', err);
                            } else {
                                taskCount++;
                                taskIds.push(this.lastID);
                                
                                if (taskCount === tasks.length) {
                                    console.log(`✓ ${taskCount} sample tasks created`);
                                    
                                    // Add reminders for scheduled tasks
                                    let reminderCount = 0;
                                    taskIds.forEach(taskId => {
                                        db.get("SELECT scheduled_start FROM tasks WHERE id = ?", [taskId], (err, row) => {
                                            if (row && row.scheduled_start) {
                                                const reminderTime = new Date(new Date(row.scheduled_start).getTime() - 20 * 60 * 1000);
                                                if (reminderTime > new Date()) {
                                                    db.run(`INSERT INTO reminders (user_id, task_id, reminder_time, reminder_type, sent)
                                                           VALUES (?, ?, ?, 'scheduled', 0)`,
                                                        [userId, taskId, reminderTime.toISOString()],
                                                        (err) => { if (!err) reminderCount++; }
                                                    );
                                                }
                                            }
                                        });
                                    });
                                    
                                    // Add activity log
                                    const activities = [
                                        [userId, 'LOGIN', 'User logged in'],
                                        [userId, 'REGISTER', 'User registered successfully'],
                                        [userId, 'TASK_CREATED', 'Task: Complete FHC Portal Authentication'],
                                        [userId, 'TASK_CREATED', 'Task: Customer Repair App Database Design'],
                                        [userId, 'TASK_CREATED', 'Task: Morning Meditation'],
                                        [userId, 'SETTINGS_UPDATED', 'Reminder interval: 20 minutes, Auto reminders: true'],
                                        [userId, 'TASK_COMPLETED', 'Task: Team Meeting']
                                    ];
                                    
                                    activities.forEach(activity => {
                                        db.run("INSERT INTO activity_log (user_id, action, details) VALUES (?, ?, ?)", activity);
                                    });
                                    console.log('✓ Activity log created');
                                    
                                    // Add suggestions
                                    const suggestions = [
                                        [userId, '⚠️ You have a critical task due soon! Focus on completing it today.', 'priority'],
                                        [userId, '🔴 High priority tasks need your attention.', 'priority'],
                                        [userId, '📚 Schedule time for your study tasks.', 'time_management'],
                                        [userId, '✨ Great job staying productive!', 'motivation'],
                                        [userId, '💡 Tip: Use the Focus Timer for 25-minute productivity sprints.', 'productivity'],
                                        [userId, '🎯 Complete your most important task first thing in the morning.', 'goal']
                                    ];
                                    
                                    suggestions.forEach(suggestion => {
                                        db.run("INSERT INTO suggestions (user_id, suggestion, type) VALUES (?, ?, ?)", suggestion);
                                    });
                                    console.log('✓ Suggestions created');
                                    
                                    // Final summary
                                    setTimeout(() => {
                                        db.get("SELECT COUNT(*) as count FROM users", (err, result) => {
                                            console.log(`\n✅ Database initialization complete!`);
                                            console.log(`📊 Summary:`);
                                            console.log(`   - Users: ${result?.count || 0}`);
                                            db.get("SELECT COUNT(*) as count FROM tasks", (err, taskResult) => {
                                                console.log(`   - Tasks: ${taskResult?.count || 0}`);
                                                db.get("SELECT COUNT(*) as count FROM reminders", (err, reminderResult) => {
                                                    console.log(`   - Reminders: ${reminderResult?.count || 0}`);
                                                    db.close();
                                                    console.log(`\n🔐 Login with: demo@taskweaver.com / Demo@2024`);
                                                    console.log(`🌐 Open: http://localhost:3000\n`);
                                                });
                                            });
                                        });
                                    }, 1000);
                                }
                            }
                        }
                    );
                });
            }
        );
    });
});