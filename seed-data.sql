-- Seed data for TaskWeaver
-- This adds demo data for testing

-- Insert demo user (password is 'Demo@2024' hashed with bcrypt)
-- Note: In production, you should create this via the application, not directly in SQL
-- This is just a reference for the hashed password structure
INSERT INTO users (username, email, password, email_notifications, push_notifications, timezone, theme, email_verified)
VALUES ('DEMOUSER', 'demo@taskweaver.com', '$2b$10$YOUR_HASHED_PASSWORD_HERE', 1, 1, 'UTC', 'light', 1)
ON CONFLICT (email) DO NOTHING;

-- Sample tasks for demo user
-- Note: These will be created when the demo user registers, not via SQL