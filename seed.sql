-- TaskWeaver Seed Data v2.0
-- Test data for enhanced reminder system

-- Delete existing data (for fresh seeding)
DELETE FROM reminders;
DELETE FROM tasks;
DELETE FROM activity_log;
DELETE FROM suggestions;
DELETE FROM users;

-- Insert demo user (password: Demo@2024)
-- Hash for 'Demo@2024' using bcrypt (10 rounds)
INSERT INTO users (username, email, password, reminder_interval, auto_reminders)
VALUES ('DEMOUSER', 'demo@taskweaver.com', '$2b$10$YourHashHere', 20, 1);

-- Note: Replace the hash above with actual bcrypt hash from your server
-- For testing without hash, you can use this plain text version (remove after testing):
-- INSERT INTO users (username, email, password, reminder_interval, auto_reminders)
-- VALUES ('DEMOUSER', 'demo@taskweaver.com', 'demo123', 20, 1);

-- Insert sample tasks with various scenarios
INSERT INTO tasks (user_id, title, description, project, category, severity, deadline, is_recurring, recurrence_pattern, scheduled_start, scheduled_end, deadline_reminder_sent, overdue_reminder_sent, completed)
VALUES 
    -- 1. Critical task due in 24 hours
    (1, 'Complete FHC Portal Authentication', 'Implement JWT authentication and user session management', 
     'FHC Portal', 'Work', 'Critical', datetime('now', '+1 day', '17:00'), 0, NULL, 
     datetime('now', '+1 day', '09:00'), datetime('now', '+1 day', '12:00'), 0, 0, 0),
    
    -- 2. High priority task due in 3 days
    (1, 'Customer Repair App Database Design', 'Design and implement SQLite schema for repair tracking', 
     'Customer Repair App', 'Work', 'High', datetime('now', '+3 days', '18:00'), 0, NULL, 
     datetime('now', '+2 days', '13:00'), datetime('now', '+2 days', '16:00'), 0, 0, 0),
    
    -- 3. Medium priority task due in 5 days
    (1, 'Paint Tracks UI/UX Review', 'Review and provide feedback on new dashboard design', 
     'Paint Tracks', 'Work', 'Medium', datetime('now', '+5 days', '16:00'), 0, NULL, 
     datetime('now', '+3 days', '10:00'), datetime('now', '+3 days', '12:00'), 0, 0, 0),
    
    -- 4. Study recurring task (daily)
    (1, 'Study: Advanced Node.js Patterns', 'Learn about streams, clusters, and performance optimization', 
     'Personal Development', 'Study', 'Medium', datetime('now', '+7 days', '22:00'), 1, 'daily', 
     datetime('now', '19:00'), datetime('now', '21:00'), 0, 0, 0),
    
    -- 5. Family weekly task
    (1, 'Family Dinner', 'Weekly family dinner at home', 
     'Family Time', 'Family', 'Low', datetime('now', '+6 days', '19:00'), 1, 'weekly', 
     datetime('now', '+6 days', '18:00'), datetime('now', '+6 days', '20:00'), 0, 0, 0),
    
    -- 6. Critical task due tomorrow (urgent)
    (1, 'Supplier Voucher Portal Testing', 'Perform end-to-end testing of voucher generation', 
     'Supplier Voucher Portal', 'Work', 'Critical', datetime('now', '+1 day', '16:00'), 0, NULL, 
     datetime('now', '+1 day', '09:00'), datetime('now', '+1 day', '12:00'), 0, 0, 0),
    
    -- 7. Recurring daily task (meditation)
    (1, 'Morning Meditation', 'Start the day with 15 minutes of mindfulness', 
     'Health', 'Rest', 'Low', NULL, 1, 'daily', 
     datetime('now', '+1 day', '06:00'), datetime('now', '+1 day', '06:15'), 0, 0, 0),
    
    -- 8. Task with past deadline (overdue)
    (1, 'Code Review: Customer Repair App', 'Review pull requests and provide feedback', 
     'Customer Repair App', 'Work', 'High', datetime('now', '-1 day', '16:00'), 0, NULL, 
     datetime('now', '-1 day', '14:00'), datetime('now', '-1 day', '16:00'), 0, 0, 0),
    
    -- 9. Task due in 48 hours
    (1, 'Deploy FHC Portal to Staging', 'Deploy latest changes to staging environment', 
     'FHC Portal', 'Work', 'High', datetime('now', '+2 days', '15:00'), 0, NULL, 
     datetime('now', '+2 days', '10:00'), datetime('now', '+2 days', '12:00'), 0, 0, 0),
    
    -- 10. Task due next week
    (1, 'Project Documentation', 'Create comprehensive documentation for all projects', 
     'Documentation', 'Work', 'Medium', datetime('now', '+7 days', '17:00'), 0, NULL, 
     datetime('now', '+6 days', '14:00'), datetime('now', '+6 days', '17:00'), 0, 0, 0),
    
    -- 11. Completed task (for statistics)
    (1, 'Team Meeting', 'Weekly team sync meeting', 
     'Meetings', 'Work', 'Medium', datetime('now', '-2 days', '10:00'), 0, NULL, 
     datetime('now', '-2 days', '09:00'), datetime('now', '-2 days', '10:00'), 0, 0, 1),
    
    -- 12. Task with no scheduled time (unscheduled)
    (1, 'Research AI Tools', 'Research and evaluate AI productivity tools', 
     'Research', 'Study', 'Low', datetime('now', '+10 days', '23:59'), 0, NULL, 
     NULL, NULL, 0, 0, 0);

-- Create reminders for scheduled tasks
INSERT INTO reminders (user_id, task_id, reminder_time, reminder_type, sent)
SELECT 
    user_id, 
    id, 
    datetime(scheduled_start, '-' || (SELECT reminder_interval FROM users WHERE id = 1) || ' minutes'),
    'scheduled',
    0
FROM tasks 
WHERE user_id = 1 AND scheduled_start IS NOT NULL;

-- Create deadline reminders for tasks with deadlines
INSERT INTO reminders (user_id, task_id, reminder_time, reminder_type, sent)
SELECT 
    user_id, 
    id, 
    datetime(deadline, '-1 day'),
    'deadline',
    0
FROM tasks 
WHERE user_id = 1 AND deadline IS NOT NULL AND deadline > CURRENT_TIMESTAMP;

-- Create overdue reminders for tasks that are past deadline
INSERT INTO reminders (user_id, task_id, reminder_time, reminder_type, sent)
SELECT 
    user_id, 
    id, 
    datetime('now'),
    'overdue',
    0
FROM tasks 
WHERE user_id = 1 AND deadline < CURRENT_TIMESTAMP AND completed = 0;

-- Insert sample activity log
INSERT INTO activity_log (user_id, action, details)
VALUES 
    (1, 'LOGIN', 'User logged in'),
    (1, 'REGISTER', 'User registered successfully'),
    (1, 'TASK_CREATED', 'Task: Complete FHC Portal Authentication'),
    (1, 'TASK_CREATED', 'Task: Customer Repair App Database Design'),
    (1, 'TASK_CREATED', 'Task: Morning Meditation'),
    (1, 'DEADLINE_REMINDER_SENT', 'Task: Supplier Voucher Portal Testing - 24hours'),
    (1, 'SETTINGS_UPDATED', 'Reminder interval: 20 minutes, Auto reminders: true'),
    (1, 'TASK_COMPLETED', 'Task: Team Meeting'),
    (1, 'OVERDUE_REMINDER_SENT', 'Task: Code Review: Customer Repair App - 1 days overdue'),
    (1, 'LOGOUT', 'User logged out');

-- Insert sample suggestions
INSERT INTO suggestions (user_id, suggestion, type)
VALUES 
    (1, '⚠️ You have a critical task due in 24 hours! Focus on completing it today.', 'priority'),
    (1, '🔴 High priority: "Complete FHC Portal Authentication" needs your attention soon.', 'priority'),
    (1, '📚 Study time: "Study: Advanced Node.js Patterns" - Allocate 2 hours for focused learning.', 'time_management'),
    (1, '✨ Great job! All tasks are scheduled. Consider planning some personal development time.', 'motivation'),
    (1, '💡 Tip: Use the Focus Timer for 25-minute productivity sprints.', 'productivity'),
    (1, '🎯 Goal: Complete your most important task first thing in the morning.', 'goal'),
    (1, '⚠️ OVERDUE: "Code Review: Customer Repair App" was due yesterday! Please complete ASAP.', 'urgent');

-- Verify data insertion
SELECT '=== DATABASE SEED COMPLETE ===' as Status;

SELECT 'Users:' as Item, COUNT(*) as Count FROM users
UNION ALL
SELECT 'Tasks:', COUNT(*) FROM tasks
UNION ALL
SELECT 'Tasks Completed:', COUNT(CASE WHEN completed = 1 THEN 1 END) FROM tasks
UNION ALL
SELECT 'Tasks Overdue:', COUNT(CASE WHEN deadline < CURRENT_TIMESTAMP AND completed = 0 THEN 1 END) FROM tasks
UNION ALL
SELECT 'Tasks with Deadlines:', COUNT(CASE WHEN deadline IS NOT NULL THEN 1 END) FROM tasks
UNION ALL
SELECT 'Reminders - Total:', COUNT(*) FROM reminders
UNION ALL
SELECT 'Reminders - Scheduled:', COUNT(CASE WHEN reminder_type = 'scheduled' THEN 1 END) FROM reminders
UNION ALL
SELECT 'Reminders - Deadline:', COUNT(CASE WHEN reminder_type = 'deadline' THEN 1 END) FROM reminders
UNION ALL
SELECT 'Reminders - Overdue:', COUNT(CASE WHEN reminder_type = 'overdue' THEN 1 END) FROM reminders
UNION ALL
SELECT 'Reminders - Pending:', COUNT(CASE WHEN sent = 0 THEN 1 END) FROM reminders
UNION ALL
SELECT 'Activity Log:', COUNT(*) FROM activity_log
UNION ALL
SELECT 'Suggestions:', COUNT(*) FROM suggestions;

-- Display reminder statistics by type
SELECT 
    'Reminder Statistics by Type' as Info,
    reminder_type,
    COUNT(*) as total,
    SUM(CASE WHEN sent = 1 THEN 1 ELSE 0 END) as sent,
    SUM(CASE WHEN sent = 0 THEN 1 ELSE 0 END) as pending
FROM reminders
GROUP BY reminder_type;

-- Display task priority distribution
SELECT 
    'Task Priority Distribution' as Info,
    severity,
    COUNT(*) as count,
    COUNT(CASE WHEN completed = 1 THEN 1 END) as completed,
    COUNT(CASE WHEN completed = 0 THEN 1 END) as pending
FROM tasks
WHERE user_id = 1
GROUP BY severity
ORDER BY 
    CASE severity 
        WHEN 'Critical' THEN 1 
        WHEN 'High' THEN 2 
        WHEN 'Medium' THEN 3 
        WHEN 'Low' THEN 4 
    END;

-- Display upcoming deadlines
SELECT 
    'Upcoming Deadlines (Next 7 Days)' as Info,
    title,
    severity,
    deadline,
    CASE 
        WHEN julianday(deadline) - julianday('now') <= 1 THEN 'URGENT'
        WHEN julianday(deadline) - julianday('now') <= 3 THEN 'Soon'
        ELSE 'Upcoming'
    END as urgency
FROM tasks
WHERE user_id = 1 
    AND completed = 0 
    AND deadline IS NOT NULL 
    AND deadline >= CURRENT_TIMESTAMP
    AND deadline <= datetime('now', '+7 days')
ORDER BY deadline ASC;