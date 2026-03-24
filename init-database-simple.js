const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const bcrypt = require('bcrypt');

const db = new sqlite3.Database('./database.sqlite');

// Simple schema without triggers
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
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Reminders table
CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    task_id INTEGER NOT NULL,
    reminder_time DATETIME NOT NULL,
    reminder_type TEXT DEFAULT 'scheduled',
    sent INTEGER DEFAULT 0,
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

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_tasks_user_id ON tasks(user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_scheduled_start ON tasks(scheduled_start);
CREATE INDEX IF NOT EXISTS idx_tasks_deadline ON tasks(deadline);
CREATE INDEX IF NOT EXISTS idx_reminders_reminder_time ON reminders(reminder_time);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
`;

console.log('Creating database schema...');

// Execute schema
db.exec(schema, async (err) => {
    if (err) {
        console.error('Error creating schema:', err);
        process.exit(1);
    }
    console.log('✓ Database schema created');
    
    // Delete existing data
    db.run('DELETE FROM reminders');
    db.run('DELETE FROM tasks');
    db.run('DELETE FROM activity_log');
    db.run('DELETE FROM suggestions');
    db.run('DELETE FROM users');
    
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
            console.log('✓ Demo user created: demo@taskweaver.com / Demo@2024');
            
            const userId = this.lastID;
            
            // Insert sample tasks
            const tasks = [
                ['Complete FHC Portal Authentication', 'Implement JWT authentication and user session management', 'FHC Portal', 'Work', 'Critical', new Date(Date.now() + 2 * 24 * 60 * 60 * 1000), 0, null, new Date(Date.now() + 1 * 24 * 60 * 60 * 1000), new Date(Date.now() + 1 * 24 * 60 * 60 * 1000 + 3 * 60 * 60 * 1000), 0],
                ['Customer Repair App Database Design', 'Design and implement SQLite schema for repair tracking', 'Customer Repair App', 'Work', 'High', new Date(Date.now() + 3 * 24 * 60 * 60 * 1000), 0, null, new Date(Date.now() + 2 * 24 * 60 * 60 * 1000), new Date(Date.now() + 2 * 24 * 60 * 60 * 1000 + 3 * 60 * 60 * 1000), 0],
                ['Paint Tracks UI/UX Review', 'Review and provide feedback on new dashboard design', 'Paint Tracks', 'Work', 'Medium', new Date(Date.now() + 5 * 24 * 60 * 60 * 1000), 0, null, new Date(Date.now() + 3 * 24 * 60 * 60 * 1000), new Date(Date.now() + 3 * 24 * 60 * 60 * 1000 + 2 * 60 * 60 * 1000), 0],
                ['Study: Advanced Node.js Patterns', 'Learn about streams, clusters, and performance optimization', 'Personal Development', 'Study', 'Medium', new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), 1, 'daily', new Date(Date.now() + 1 * 24 * 60 * 60 * 1000), new Date(Date.now() + 1 * 24 * 60 * 60 * 1000 + 2 * 60 * 60 * 1000), 0],
                ['Family Dinner', 'Weekly family dinner at home', 'Family Time', 'Family', 'Low', new Date(Date.now() + 6 * 24 * 60 * 60 * 1000), 1, 'weekly', new Date(Date.now() + 6 * 24 * 60 * 60 * 1000), new Date(Date.now() + 6 * 24 * 60 * 60 * 1000 + 2 * 60 * 60 * 1000), 0],
                ['Supplier Voucher Portal Testing', 'Perform end-to-end testing of voucher generation', 'Supplier Voucher Portal', 'Work', 'Critical', new Date(Date.now() + 1 * 24 * 60 * 60 * 1000), 0, null, new Date(Date.now() + 1 * 24 * 60 * 60 * 1000), new Date(Date.now() + 1 * 24 * 60 * 60 * 1000 + 3 * 60 * 60 * 1000), 0],
                ['Morning Meditation', 'Start the day with 15 minutes of mindfulness', 'Health', 'Rest', 'Low', null, 1, 'daily', new Date(Date.now() + 1 * 24 * 60 * 60 * 1000), new Date(Date.now() + 1 * 24 * 60 * 60 * 1000 + 15 * 60 * 1000), 0],
                ['Code Review: Customer Repair App', 'Review pull requests and provide feedback', 'Customer Repair App', 'Work', 'High', new Date(Date.now() - 1 * 24 * 60 * 60 * 1000), 0, null, new Date(Date.now() - 1 * 24 * 60 * 60 * 1000), new Date(Date.now() - 1 * 24 * 60 * 60 * 1000 + 2 * 60 * 60 * 1000), 0],
                ['Deploy FHC Portal to Staging', 'Deploy latest changes to staging environment', 'FHC Portal', 'Work', 'High', new Date(Date.now() + 2 * 24 * 60 * 60 * 1000), 0, null, new Date(Date.now() + 2 * 24 * 60 * 60 * 1000), new Date(Date.now() + 2 * 24 * 60 * 60 * 1000 + 2 * 60 * 60 * 1000), 0],
                ['Project Documentation', 'Create comprehensive documentation for all projects', 'Documentation', 'Work', 'Medium', new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), 0, null, new Date(Date.now() + 6 * 24 * 60 * 60 * 1000), new Date(Date.now() + 6 * 24 * 60 * 60 * 1000 + 3 * 60 * 60 * 1000), 0],
                ['Team Meeting', 'Weekly team sync meeting', 'Meetings', 'Work', 'Medium', new Date(Date.now() - 2 * 24 * 60 * 60 * 1000), 0, null, new Date(Date.now() - 2 * 24 * 60 * 60 * 1000), new Date(Date.now() - 2 * 24 * 60 * 60 * 1000 + 1 * 60 * 60 * 1000), 1],
                ['Research AI Tools', 'Research and evaluate AI productivity tools', 'Research', 'Study', 'Low', new Date(Date.now() + 10 * 24 * 60 * 60 * 1000), 0, null, null, null, 0]
            ];
            
            let taskCount = 0;
            let taskIds = [];
            
            tasks.forEach((task, index) => {
                db.run(`INSERT INTO tasks (user_id, title, description, project, category, severity, deadline, is_recurring, recurrence_pattern, scheduled_start, scheduled_end, completed)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [userId, ...task],
                    function(err) {
                        if (err) {
                            console.error('Error inserting task:', err);
                        } else {
                            taskCount++;
                            taskIds.push(this.lastID);
                            
                            // After all tasks are inserted, add reminders
                            if (taskCount === tasks.length) {
                                console.log(`✓ ${taskCount} sample tasks created`);
                                
                                // Add reminders for scheduled tasks
                                let reminderCount = 0;
                                taskIds.forEach(taskId => {
                                    db.get("SELECT scheduled_start FROM tasks WHERE id = ?", [taskId], (err, task) => {
                                        if (task && task.scheduled_start) {
                                            const reminderTime = new Date(new Date(task.scheduled_start).getTime() - 20 * 60 * 1000);
                                            db.run(`INSERT INTO reminders (user_id, task_id, reminder_time, reminder_type, sent)
                                                   VALUES (?, ?, ?, 'scheduled', 0)`,
                                                [userId, taskId, reminderTime.toISOString()],
                                                (err) => {
                                                    if (!err) reminderCount++;
                                                }
                                            );
                                        }
                                        
                                        // Add deadline reminders for tasks with deadlines
                                        db.get("SELECT deadline FROM tasks WHERE id = ? AND deadline IS NOT NULL", [taskId], (err, taskWithDeadline) => {
                                            if (taskWithDeadline && taskWithDeadline.deadline) {
                                                const deadlineReminder = new Date(new Date(taskWithDeadline.deadline).getTime() - 24 * 60 * 60 * 1000);
                                                if (deadlineReminder > new Date()) {
                                                    db.run(`INSERT INTO reminders (user_id, task_id, reminder_time, reminder_type, sent)
                                                           VALUES (?, ?, ?, 'deadline', 0)`,
                                                        [userId, taskId, deadlineReminder.toISOString()],
                                                        (err) => {
                                                            if (!err) reminderCount++;
                                                        }
                                                    );
                                                }
                                            }
                                        });
                                        
                                        // Add overdue reminders for past tasks
                                        db.get("SELECT deadline FROM tasks WHERE id = ? AND deadline < CURRENT_TIMESTAMP AND completed = 0", [taskId], (err, overdueTask) => {
                                            if (overdueTask) {
                                                db.run(`INSERT INTO reminders (user_id, task_id, reminder_time, reminder_type, sent)
                                                       VALUES (?, ?, datetime('now'), 'overdue', 0)`,
                                                    [userId, taskId],
                                                    (err) => {
                                                        if (!err) reminderCount++;
                                                    }
                                                );
                                            }
                                        });
                                    });
                                });
                                
                                // Add activity log
                                const activities = [
                                    [userId, 'LOGIN', 'User logged in'],
                                    [userId, 'REGISTER', 'User registered successfully'],
                                    [userId, 'TASK_CREATED', 'Task: Complete FHC Portal Authentication'],
                                    [userId, 'TASK_CREATED', 'Task: Customer Repair App Database Design'],
                                    [userId, 'TASK_CREATED', 'Task: Morning Meditation'],
                                    [userId, 'DEADLINE_REMINDER_SENT', 'Task: Supplier Voucher Portal Testing - 24hours'],
                                    [userId, 'SETTINGS_UPDATED', 'Reminder interval: 20 minutes, Auto reminders: true'],
                                    [userId, 'TASK_COMPLETED', 'Task: Team Meeting'],
                                    [userId, 'OVERDUE_REMINDER_SENT', 'Task: Code Review: Customer Repair App - 1 days overdue'],
                                    [userId, 'LOGOUT', 'User logged out']
                                ];
                                
                                activities.forEach(activity => {
                                    db.run("INSERT INTO activity_log (user_id, action, details) VALUES (?, ?, ?)", activity);
                                });
                                console.log('✓ Activity log created');
                                
                                // Add suggestions
                                const suggestions = [
                                    [userId, '⚠️ You have a critical task due in 24 hours! Focus on completing it today.', 'priority'],
                                    [userId, '🔴 High priority: "Complete FHC Portal Authentication" needs your attention soon.', 'priority'],
                                    [userId, '📚 Study time: "Study: Advanced Node.js Patterns" - Allocate 2 hours for focused learning.', 'time_management'],
                                    [userId, '✨ Great job! All tasks are scheduled. Consider planning some personal development time.', 'motivation'],
                                    [userId, '💡 Tip: Use the Focus Timer for 25-minute productivity sprints.', 'productivity'],
                                    [userId, '🎯 Goal: Complete your most important task first thing in the morning.', 'goal'],
                                    [userId, '⚠️ OVERDUE: "Code Review: Customer Repair App" was due yesterday! Please complete ASAP.', 'urgent']
                                ];
                                
                                suggestions.forEach(suggestion => {
                                    db.run("INSERT INTO suggestions (user_id, suggestion, type) VALUES (?, ?, ?)", suggestion);
                                });
                                console.log('✓ Suggestions created');
                                
                                // Final summary
                                setTimeout(() => {
                                    db.get("SELECT COUNT(*) as count FROM users", [], (err, result) => {
                                        console.log(`\n✅ Database initialization complete!`);
                                        console.log(`📊 Summary:`);
                                        console.log(`   - Users: ${result?.count || 0}`);
                                        db.get("SELECT COUNT(*) as count FROM tasks", [], (err, taskResult) => {
                                            console.log(`   - Tasks: ${taskResult?.count || 0}`);
                                            db.get("SELECT COUNT(*) as count FROM reminders", [], (err, reminderResult) => {
                                                console.log(`   - Reminders: ${reminderResult?.count || 0}`);
                                                db.close();
                                                console.log(`\n🔐 Login with: demo@taskweaver.com / Demo@2024\n`);
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