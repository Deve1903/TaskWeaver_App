const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const cors = require('cors');
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');
const { Parser } = require('json2csv');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// ============ LOGGING SYSTEM ============
const LOG_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR);
}

const errorLogStream = fs.createWriteStream(path.join(LOG_DIR, 'error.log'), { flags: 'a' });
const activityLogStream = fs.createWriteStream(path.join(LOG_DIR, 'activity.log'), { flags: 'a' });
const emailLogStream = fs.createWriteStream(path.join(LOG_DIR, 'email.log'), { flags: 'a' });

function logToFile(stream, level, message, data = null) {
    const timestamp = new Date().toISOString();
    const logEntry = { timestamp, level, message, ...(data && { data }) };
    stream.write(JSON.stringify(logEntry) + '\n');
    
    const consoleMessage = `[${timestamp}] [${level}] ${message}`;
    if (level === 'ERROR') console.error('\x1b[31m%s\x1b[0m', consoleMessage);
    else if (level === 'WARNING') console.warn('\x1b[33m%s\x1b[0m', consoleMessage);
    else if (level === 'SUCCESS') console.log('\x1b[32m%s\x1b[0m', consoleMessage);
    else console.log('\x1b[36m%s\x1b[0m', consoleMessage);
}

function logUserActivity(userId, email, action, details, req = null) {
    const logData = {
        userId, email, action, details,
        ip: req?.ip || req?.connection?.remoteAddress || 'unknown',
        userAgent: req?.headers['user-agent'] || 'unknown',
        method: req?.method, url: req?.originalUrl
    };
    logToFile(activityLogStream, 'ACTIVITY', `User ${email} (ID: ${userId}): ${action}`, logData);
    console.log(`\x1b[36m[USER ACTIVITY] ${email}: ${action}\x1b[0m`);
    
    if (db) {
        db.run(`INSERT INTO activity_log (user_id, email, action, details, ip_address, user_agent, request_method, request_url) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [userId, email, action, details, logData.ip, logData.userAgent, logData.method, logData.url], 
            (err) => { if (err) logToFile(errorLogStream, 'ERROR', 'Failed to log activity to DB', err); });
    }
}

function logEmailSent(userId, email, to, subject, status, error = null) {
    logToFile(emailLogStream, 'EMAIL', `Email sent to ${to}: ${subject} - ${status}`, { userId, email, to, subject, status, error: error?.message });
    console.log(`\x1b[33m[EMAIL] ${email} -> ${to}: ${subject} - ${status}\x1b[0m`);
    
    if (db) {
        db.run(`INSERT INTO email_log (user_id, user_email, recipient, subject, status, error_message) VALUES (?, ?, ?, ?, ?, ?)`,
            [userId, email, to, subject, status, error?.message], 
            (err) => { if (err) logToFile(errorLogStream, 'ERROR', 'Failed to log email to DB', err); });
    }
}

// ============ HEALTH CHECK ============
let healthStatus = {
    status: 'healthy', startTime: new Date(), uptime: 0, database: 'unknown',
    memory: process.memoryUsage(), version: process.version, platform: process.platform
};

setInterval(() => {
    healthStatus.uptime = process.uptime();
    healthStatus.memory = process.memoryUsage();
    if (db) {
        db.get("SELECT 1", (err) => {
            healthStatus.database = err ? 'unhealthy' : 'healthy';
            healthStatus.status = err ? 'degraded' : 'healthy';
        });
    }
}, 60000);

app.get('/api/health', (req, res) => {
    res.json({ status: healthStatus.status, uptime: Math.floor(healthStatus.uptime), database: healthStatus.database, timestamp: new Date().toISOString() });
});

// ============ CORS CONFIGURATION ============
const allowedOrigins = [
    'http://localhost:3000', 'http://localhost:5500', 'http://localhost:5501',
    'http://127.0.0.1:3000', 'http://127.0.0.1:5500', 'http://127.0.0.1:5501'
];

app.use(cors({
    origin: function (origin, callback) {
        if (!origin) return callback(null, true);
        if (allowedOrigins.indexOf(origin) !== -1 || process.env.NODE_ENV !== 'production') {
            callback(null, true);
        } else {
            logToFile(errorLogStream, 'WARNING', `CORS blocked request from: ${origin}`);
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'X-Requested-With']
}));

app.options('*', cors());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));

// ============ STATIC FILE SERVING ============
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });
app.get('/login', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'login.html')); });
app.get('/index.html', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });
app.get('/login.html', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'login.html')); });

// ============ SESSION CONFIGURATION ============
app.use(session({
    store: new SQLiteStore({ 
        db: 'sessions.db', 
        table: 'sessions',
        ttl: 24 * 60 * 60 * 1000 // 24 hours
    }),
    secret: process.env.SESSION_SECRET || 'taskweaver_secret_key_2024',
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: false, // Set to false for local development (HTTP)
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000, // 24 hours
        sameSite: 'lax'
    },
    name: 'taskweaver.sid',
    rolling: true // Reset cookie expiration on each request
}));

// Session debug middleware
app.use((req, res, next) => {
    if (req.session && req.session.userId) {
        res.locals.userId = req.session.userId;
        res.locals.email = req.session.email;
    }
    next();
});

// ============ DATABASE SETUP ============
let db;

function initDatabase() {
    return new Promise((resolve, reject) => {
        db = new sqlite3.Database('./database.sqlite', (err) => {
            if (err) {
                logToFile(errorLogStream, 'ERROR', 'Failed to open database', err);
                reject(err);
            } else {
                logToFile(activityLogStream, 'INFO', 'Database connected successfully');
                resolve();
            }
        });
    });
}

async function initializeDatabase() {
    return new Promise((resolve, reject) => {
        db.serialize(() => {
            db.run("PRAGMA foreign_keys = ON");
            db.run("PRAGMA journal_mode = WAL");
            
            // Users table with email as primary identifier
            db.run(`CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                email TEXT UNIQUE NOT NULL,
                password TEXT NOT NULL,
                reset_token TEXT,
                reset_token_expiry DATETIME,
                reminder_interval INTEGER DEFAULT 20,
                auto_reminders INTEGER DEFAULT 1,
                email_notifications INTEGER DEFAULT 1,
                push_notifications INTEGER DEFAULT 1,
                timezone TEXT DEFAULT 'UTC',
                theme TEXT DEFAULT 'light',
                last_login_ip TEXT,
                last_login_user_agent TEXT,
                login_count INTEGER DEFAULT 0,
                account_status TEXT DEFAULT 'active',
                failed_login_attempts INTEGER DEFAULT 0,
                last_failed_login DATETIME,
                locked_until DATETIME,
                email_verified INTEGER DEFAULT 0,
                verification_token TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                last_login DATETIME
            )`, (err) => { if (err) logToFile(errorLogStream, 'ERROR', 'Error creating users table', err); else logToFile(activityLogStream, 'SUCCESS', 'Users table ready'); });
            
            // Tasks table with email reference
            db.run(`CREATE TABLE IF NOT EXISTS tasks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                user_email TEXT NOT NULL,
                title TEXT NOT NULL,
                description TEXT,
                project TEXT,
                category TEXT,
                severity TEXT DEFAULT 'Medium',
                priority INTEGER DEFAULT 2,
                deadline DATETIME,
                is_recurring INTEGER DEFAULT 0,
                recurrence_pattern TEXT,
                recurrence_end_date DATETIME,
                scheduled_start DATETIME,
                scheduled_end DATETIME,
                actual_start DATETIME,
                actual_end DATETIME,
                completed INTEGER DEFAULT 0,
                completed_at DATETIME,
                completion_notes TEXT,
                email_reminder_sent INTEGER DEFAULT 0,
                deadline_reminder_sent INTEGER DEFAULT 0,
                overdue_reminder_sent INTEGER DEFAULT 0,
                reminder_count INTEGER DEFAULT 0,
                last_reminder_sent DATETIME,
                estimated_duration INTEGER,
                actual_duration INTEGER,
                tags TEXT,
                attachments TEXT,
                subtasks TEXT,
                dependencies TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                deleted_at DATETIME,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            )`, (err) => { if (err) logToFile(errorLogStream, 'ERROR', 'Error creating tasks table', err); else logToFile(activityLogStream, 'SUCCESS', 'Tasks table ready'); });
            
            // Shared schedules table
            db.run(`CREATE TABLE IF NOT EXISTS shared_schedules (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                user_email TEXT NOT NULL,
                share_with_email TEXT NOT NULL,
                share_token TEXT UNIQUE,
                share_type TEXT DEFAULT 'view',
                expires_at DATETIME,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            )`, (err) => { if (err) logToFile(errorLogStream, 'ERROR', 'Error creating shared_schedules table', err); else logToFile(activityLogStream, 'SUCCESS', 'Shared schedules table ready'); });
            
            // Reminders table
            db.run(`CREATE TABLE IF NOT EXISTS reminders (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                user_email TEXT NOT NULL,
                task_id INTEGER NOT NULL,
                reminder_time DATETIME NOT NULL,
                reminder_type TEXT DEFAULT 'scheduled',
                reminder_method TEXT DEFAULT 'email',
                sent INTEGER DEFAULT 0,
                sent_at DATETIME,
                retry_count INTEGER DEFAULT 0,
                last_error TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
            )`, (err) => { if (err) logToFile(errorLogStream, 'ERROR', 'Error creating reminders table', err); else logToFile(activityLogStream, 'SUCCESS', 'Reminders table ready'); });
            
            // Activity log table with email
            db.run(`CREATE TABLE IF NOT EXISTS activity_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                email TEXT NOT NULL,
                action TEXT NOT NULL,
                details TEXT,
                ip_address TEXT,
                user_agent TEXT,
                request_method TEXT,
                request_url TEXT,
                response_status INTEGER,
                response_time INTEGER,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            )`, (err) => { if (err) logToFile(errorLogStream, 'ERROR', 'Error creating activity_log table', err); else logToFile(activityLogStream, 'SUCCESS', 'Activity log table ready'); });
            
            // Email log table with user_email
            db.run(`CREATE TABLE IF NOT EXISTS email_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER,
                user_email TEXT,
                recipient TEXT NOT NULL,
                subject TEXT NOT NULL,
                body TEXT,
                status TEXT,
                error_message TEXT,
                sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
            )`, (err) => { if (err) logToFile(errorLogStream, 'ERROR', 'Error creating email_log table', err); else logToFile(activityLogStream, 'SUCCESS', 'Email log table ready'); });
            
            // Suggestions table
            db.run(`CREATE TABLE IF NOT EXISTS suggestions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                user_email TEXT NOT NULL,
                suggestion TEXT NOT NULL,
                type TEXT,
                priority INTEGER DEFAULT 0,
                is_read INTEGER DEFAULT 0,
                read_at DATETIME,
                action_taken TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            )`, (err) => { if (err) logToFile(errorLogStream, 'ERROR', 'Error creating suggestions table', err); else logToFile(activityLogStream, 'SUCCESS', 'Suggestions table ready'); });
            
            // Projects table
            db.run(`CREATE TABLE IF NOT EXISTS projects (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                user_email TEXT NOT NULL,
                name TEXT NOT NULL,
                description TEXT,
                color TEXT,
                status TEXT DEFAULT 'active',
                progress INTEGER DEFAULT 0,
                start_date DATETIME,
                end_date DATETIME,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            )`, (err) => { if (err) logToFile(errorLogStream, 'ERROR', 'Error creating projects table', err); else logToFile(activityLogStream, 'SUCCESS', 'Projects table ready'); });
            
            // Create indexes
            const indexes = [
                'CREATE INDEX IF NOT EXISTS idx_tasks_user_id ON tasks(user_id)',
                'CREATE INDEX IF NOT EXISTS idx_tasks_user_email ON tasks(user_email)',
                'CREATE INDEX IF NOT EXISTS idx_tasks_scheduled_start ON tasks(scheduled_start)',
                'CREATE INDEX IF NOT EXISTS idx_tasks_deadline ON tasks(deadline)',
                'CREATE INDEX IF NOT EXISTS idx_tasks_completed ON tasks(completed)',
                'CREATE INDEX IF NOT EXISTS idx_tasks_severity ON tasks(severity)',
                'CREATE INDEX IF NOT EXISTS idx_reminders_reminder_time ON reminders(reminder_time)',
                'CREATE INDEX IF NOT EXISTS idx_reminders_sent ON reminders(sent)',
                'CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)',
                'CREATE INDEX IF NOT EXISTS idx_activity_user_id ON activity_log(user_id)',
                'CREATE INDEX IF NOT EXISTS idx_activity_email ON activity_log(email)',
                'CREATE INDEX IF NOT EXISTS idx_email_log_recipient ON email_log(recipient)',
                'CREATE INDEX IF NOT EXISTS idx_suggestions_user_id ON suggestions(user_id)',
                'CREATE INDEX IF NOT EXISTS idx_projects_user_id ON projects(user_id)',
                'CREATE INDEX IF NOT EXISTS idx_shared_schedules_user_email ON shared_schedules(user_email)'
            ];
            
            let indexCount = 0;
            indexes.forEach(index => {
                db.run(index, (err) => {
                    if (err) logToFile(errorLogStream, 'ERROR', `Failed to create index`, err);
                    indexCount++;
                    if (indexCount === indexes.length) {
                        logToFile(activityLogStream, 'SUCCESS', 'Database initialization complete');
                        resolve();
                    }
                });
            });
        });
    });
}

async function createDemoUser() {
    return new Promise((resolve) => {
        const demoEmail = 'demo@taskweaver.com';
        const demoPassword = 'Demo@2024';
        
        db.get("SELECT id FROM users WHERE email = ?", [demoEmail], async (err, user) => {
            if (err) {
                logToFile(errorLogStream, 'ERROR', 'Error checking demo user', err);
                resolve();
                return;
            }
            
            if (!user) {
                try {
                    const hashedPassword = await bcrypt.hash(demoPassword, 10);
                    db.run(`INSERT INTO users (username, email, password, email_notifications, push_notifications, timezone, theme, email_verified) 
                            VALUES (?, ?, ?, 1, 1, 'UTC', 'light', 1)`,
                        ['DEMOUSER', demoEmail, hashedPassword],
                        function(err) {
                            if (err) logToFile(errorLogStream, 'ERROR', 'Error creating demo user', err);
                            else logToFile(activityLogStream, 'SUCCESS', `Demo user created: ${demoEmail} / Demo@2024`);
                            resolve();
                        });
                } catch (error) {
                    logToFile(errorLogStream, 'ERROR', 'Error hashing demo password', error);
                    resolve();
                }
            } else {
                logToFile(activityLogStream, 'INFO', `Demo user already exists: ${demoEmail}`);
                resolve();
            }
        });
    });
}

// ============ EMAIL TRANSPORTER ============
let transporter;

function setupEmailTransporter() {
    try {
        transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: { user: process.env.EMAIL_USER || 'your-email@gmail.com', pass: process.env.EMAIL_PASS || 'your-app-password' }
        });
        transporter.verify((error) => {
            if (error) logToFile(errorLogStream, 'ERROR', 'Email configuration error', error);
            else logToFile(activityLogStream, 'SUCCESS', 'Email server is ready');
        });
    } catch (error) {
        logToFile(errorLogStream, 'ERROR', 'Failed to setup email transporter', error);
        transporter = null;
    }
}

// Professional email template with TaskWeaver branding
function getEmailTemplate(title, content, buttonText = null, buttonLink = null) {
    return `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>TaskWeaver</title>
            <style>
                body {
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
                    line-height: 1.6;
                    margin: 0;
                    padding: 0;
                    background-color: #f7fafc;
                }
                .container {
                    max-width: 600px;
                    margin: 20px auto;
                    background: #ffffff;
                    border-radius: 12px;
                    overflow: hidden;
                    box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
                }
                .header {
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    padding: 30px 20px;
                    text-align: center;
                }
                .header h1 {
                    color: #ffffff;
                    margin: 0;
                    font-size: 28px;
                    font-weight: 700;
                    letter-spacing: -0.5px;
                }
                .header p {
                    color: rgba(255, 255, 255, 0.9);
                    margin: 10px 0 0;
                    font-size: 14px;
                }
                .content {
                    padding: 40px 30px;
                    background: #ffffff;
                }
                .title {
                    color: #2d3748;
                    font-size: 24px;
                    font-weight: 600;
                    margin-bottom: 20px;
                    border-left: 4px solid #667eea;
                    padding-left: 15px;
                }
                .message {
                    color: #4a5568;
                    font-size: 16px;
                    margin-bottom: 30px;
                    line-height: 1.8;
                }
                .button {
                    display: inline-block;
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    color: #ffffff;
                    padding: 12px 30px;
                    text-decoration: none;
                    border-radius: 8px;
                    font-weight: 600;
                    margin: 20px 0;
                    transition: transform 0.2s;
                }
                .button:hover {
                    transform: translateY(-2px);
                }
                .info-box {
                    background: #f7fafc;
                    border-left: 4px solid #667eea;
                    padding: 15px 20px;
                    margin: 20px 0;
                    border-radius: 8px;
                }
                .footer {
                    background: #f7fafc;
                    padding: 20px 30px;
                    text-align: center;
                    border-top: 1px solid #e2e8f0;
                    font-size: 12px;
                    color: #718096;
                }
                .footer a {
                    color: #667eea;
                    text-decoration: none;
                }
                hr {
                    border: none;
                    border-top: 1px solid #e2e8f0;
                    margin: 20px 0;
                }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1>⚡ TaskWeaver</h1>
                    <p>Your Intelligent Task Management Solution</p>
                </div>
                <div class="content">
                    <div class="title">${title}</div>
                    <div class="message">${content}</div>
                    ${buttonText && buttonLink ? `<div style="text-align: center;"><a href="${buttonLink}" class="button">${buttonText}</a></div>` : ''}
                </div>
                <div class="footer">
                    <p>© 2024 TaskWeaver. All rights reserved.</p>
                    <p>Made with <span style="color: #667eea;">❤️</span> for better productivity</p>
                    <p><a href="#">Privacy Policy</a> | <a href="#">Terms of Service</a></p>
                </div>
            </div>
        </body>
        </html>
    `;
}

// ============ EXPORT FUNCTIONS ============
async function generatePDF(tasks, userEmail) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ margin: 50, size: 'A4' });
        const buffers = [];
        
        doc.on('data', buffers.push.bind(buffers));
        doc.on('end', () => {
            const pdfData = Buffer.concat(buffers);
            resolve(pdfData);
        });
        doc.on('error', reject);
        
        // Header with gradient effect
        doc.rect(0, 0, doc.page.width, 100).fill('#667eea');
        doc.fillColor('#ffffff')
           .fontSize(28)
           .font('Helvetica-Bold')
           .text('TaskWeaver', 50, 35);
        doc.fontSize(14)
           .font('Helvetica')
           .text('Schedule Report', 50, 70);
        
        // User info
        doc.fillColor('#2d3748')
           .fontSize(12)
           .text(`Generated for: ${userEmail}`, 50, 120);
        doc.text(`Generated on: ${new Date().toLocaleString()}`, 50, 140);
        
        let yPos = 180;
        
        tasks.forEach((task, index) => {
            if (yPos > doc.page.height - 150) {
                doc.addPage();
                yPos = 50;
            }
            
            // Task card background
            doc.rect(50, yPos - 10, doc.page.width - 100, 100)
               .fill('#f7fafc');
            
            // Priority color coding
            let priorityColor = '#48bb78';
            if (task.severity === 'High') priorityColor = '#ed8936';
            if (task.severity === 'Critical') priorityColor = '#f56565';
            
            doc.rect(50, yPos - 10, 5, 100).fill(priorityColor);
            
            // Task title
            doc.fillColor('#2d3748')
               .fontSize(14)
               .font('Helvetica-Bold')
               .text(task.title, 65, yPos);
            
            // Task details
            doc.fontSize(10)
               .font('Helvetica')
               .fillColor('#4a5568');
            
            let details = [];
            if (task.description) details.push(`📝 ${task.description.substring(0, 100)}`);
            if (task.project) details.push(`📁 Project: ${task.project}`);
            if (task.scheduled_start) details.push(`⏰ ${new Date(task.scheduled_start).toLocaleString()}`);
            if (task.deadline) details.push(`⏰ Deadline: ${new Date(task.deadline).toLocaleString()}`);
            if (task.completed) details.push(`✅ Completed: ${task.completed_at ? new Date(task.completed_at).toLocaleString() : 'Yes'}`);
            
            doc.text(details.join(' • '), 65, yPos + 20);
            
            yPos += 110;
        });
        
        // Footer
        const totalPages = doc.bufferedPageRange().count;
        for (let i = 0; i < totalPages; i++) {
            doc.switchToPage(i);
            doc.fillColor('#a0aec0')
               .fontSize(10)
               .text(`Page ${i + 1} of ${totalPages}`, doc.page.width - 100, doc.page.height - 30, { align: 'right' });
        }
        
        doc.end();
    });
}

async function generateExcel(tasks) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'TaskWeaver';
    workbook.created = new Date();
    
    const worksheet = workbook.addWorksheet('Schedule Report');
    
    // Style headers
    worksheet.columns = [
        { header: 'Task Title', key: 'title', width: 30 },
        { header: 'Description', key: 'description', width: 40 },
        { header: 'Project', key: 'project', width: 20 },
        { header: 'Severity', key: 'severity', width: 12 },
        { header: 'Scheduled Start', key: 'scheduled_start', width: 20 },
        { header: 'Deadline', key: 'deadline', width: 20 },
        { header: 'Completed', key: 'completed', width: 12 },
        { header: 'Tags', key: 'tags', width: 20 }
    ];
    
    // Header styling
    worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    worksheet.getRow(1).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF667EEA' }
    };
    
    tasks.forEach(task => {
        worksheet.addRow({
            title: task.title,
            description: task.description || '',
            project: task.project || '',
            severity: task.severity || 'Medium',
            scheduled_start: task.scheduled_start ? new Date(task.scheduled_start).toLocaleString() : '',
            deadline: task.deadline ? new Date(task.deadline).toLocaleString() : '',
            completed: task.completed ? 'Yes' : 'No',
            tags: task.tags || ''
        });
    });
    
    const buffer = await workbook.xlsx.writeBuffer();
    return buffer;
}

function generateCSV(tasks) {
    const fields = ['title', 'description', 'project', 'severity', 'scheduled_start', 'deadline', 'completed', 'tags'];
    const opts = { fields };
    const parser = new Parser(opts);
    
    const formattedTasks = tasks.map(task => ({
        ...task,
        scheduled_start: task.scheduled_start ? new Date(task.scheduled_start).toLocaleString() : '',
        deadline: task.deadline ? new Date(task.deadline).toLocaleString() : '',
        completed: task.completed ? 'Yes' : 'No'
    }));
    
    return parser.parse(formattedTasks);
}

// ============ HELPER FUNCTIONS ============
function generateUsername(email) {
    return new Promise((resolve) => {
        let base = email.split('@')[0].replace(/[^a-zA-Z]/g, '').toUpperCase();
        if (base.length < 3) base = base + 'USER';
        const checkUnique = (attempt) => {
            let username = base + (attempt > 0 ? attempt : '');
            db.get("SELECT id FROM users WHERE username = ?", [username], (err, row) => {
                if (row) checkUnique(attempt + 1);
                else resolve(username);
            });
        };
        checkUnique(0);
    });
}

function checkPasswordStrength(password) {
    let score = 0;
    if (!password) return { score: 0, strength: 'No Password', color: '#6c757d', width: '0%' };
    if (password.length >= 8) score += 1;
    if (password.length >= 12) score += 1;
    if (/[A-Z]/.test(password)) score += 1;
    if (/[0-9]/.test(password)) score += 1;
    if (/[^A-Za-z0-9]/.test(password)) score += 1;
    
    let strength = score <= 2 ? 'Weak' : (score === 3 || score === 4) ? 'Medium' : 'Strong';
    let color = score <= 2 ? '#dc3545' : (score === 3 || score === 4) ? '#ffc107' : '#28a745';
    return { score, strength, color, width: `${(score / 5) * 100}%` };
}

function requireAuth(req, res, next) {
    if (!req.session.userId) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    next();
}

// ============ AUTHENTICATION ROUTES ============
app.post('/api/register', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    
    const strength = checkPasswordStrength(password);
    if (strength.score < 3) {
        return res.status(400).json({ error: 'Password too weak. Use at least 8 characters with uppercase, numbers, and special characters.' });
    }
    
    db.get("SELECT id FROM users WHERE email = ?", [email], async (err, existingUser) => {
        if (err) return res.status(500).json({ error: err.message });
        if (existingUser) return res.status(400).json({ error: 'Email already registered' });
        
        const username = await generateUsername(email);
        const hashedPassword = await bcrypt.hash(password, 10);
        const verificationToken = crypto.randomBytes(32).toString('hex');
        
        db.run(`INSERT INTO users (username, email, password, last_login_ip, last_login_user_agent, verification_token) 
                VALUES (?, ?, ?, ?, ?, ?)`,
            [username, email, hashedPassword, req.ip, req.headers['user-agent'], verificationToken],
            async function(err) {
                if (err) return res.status(500).json({ error: err.message });
                
                const userId = this.lastID;
                console.log(`\x1b[32m[REGISTRATION] New user registered: ${email} (ID: ${userId})\x1b[0m`);
                
                // Send welcome email with verification
                if (transporter) {
                    const verificationLink = `http://localhost:${port}/api/verify-email?token=${verificationToken}`;
                    const emailContent = getEmailTemplate(
                        'Welcome to TaskWeaver! 🎉',
                        `Hi ${username},<br><br>Thank you for joining TaskWeaver! We're excited to help you manage your tasks more efficiently.<br><br>
                        Please verify your email address by clicking the button below. This helps us ensure the security of your account.<br><br>
                        <div class="info-box">
                            <strong>Your Account Details:</strong><br>
                            Email: ${email}<br>
                            Username: ${username}<br>
                        </div>`,
                        'Verify Email Address',
                        verificationLink
                    );
                    
                    try {
                        await transporter.sendMail({
                            from: process.env.EMAIL_USER,
                            to: email,
                            subject: '🎉 Welcome to TaskWeaver - Verify Your Email',
                            html: emailContent
                        });
                        logEmailSent(userId, email, email, 'Welcome Email', 'success');
                        console.log(`\x1b[32m[EMAIL] Welcome email sent to: ${email}\x1b[0m`);
                    } catch (error) {
                        logEmailSent(userId, email, email, 'Welcome Email', 'failed', error);
                        console.log(`\x1b[31m[EMAIL] Failed to send welcome email to: ${email}\x1b[0m`);
                    }
                }
                
                logUserActivity(userId, email, 'REGISTER', 'User registered successfully', req);
                res.json({ success: true, username, email, message: 'Registration successful! Please check your email to verify your account.' });
            });
    });
});

app.get('/api/verify-email', (req, res) => {
    const { token } = req.query;
    
    db.get("SELECT id, email FROM users WHERE verification_token = ?", [token], (err, user) => {
        if (err || !user) {
            return res.redirect('/login.html?error=invalid_verification_token');
        }
        
        db.run("UPDATE users SET email_verified = 1, verification_token = NULL WHERE id = ?", [user.id], (err) => {
            if (err) {
                return res.redirect('/login.html?error=verification_failed');
            }
            console.log(`\x1b[32m[VERIFICATION] Email verified: ${user.email}\x1b[0m`);
            res.redirect('/login.html?verified=true');
        });
    });
});

app.post('/api/login', (req, res) => {
    const { email, password } = req.body;
    
    db.get("SELECT * FROM users WHERE email = ?", [email], async (err, user) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!user) return res.status(401).json({ error: 'Invalid credentials' });
        
        console.log(`\x1b[36m[LOGIN ATTEMPT] User: ${email}\x1b[0m`);
        
        if (user.locked_until && new Date(user.locked_until) > new Date()) {
            console.log(`\x1b[31m[LOGIN] Account locked for: ${email}\x1b[0m`);
            return res.status(401).json({ error: 'Account is temporarily locked. Try again later.' });
        }
        
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            const failedAttempts = (user.failed_login_attempts || 0) + 1;
            let lockedUntil = null;
            if (failedAttempts >= 5) lockedUntil = new Date(Date.now() + 15 * 60 * 1000);
            db.run(`UPDATE users SET failed_login_attempts = ?, last_failed_login = ?, locked_until = ? WHERE id = ?`,
                [failedAttempts, new Date().toISOString(), lockedUntil, user.id]);
            console.log(`\x1b[31m[LOGIN] Failed attempt for: ${email} (Attempt ${failedAttempts}/5)\x1b[0m`);
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        db.run(`UPDATE users SET failed_login_attempts = 0, locked_until = NULL, 
                last_login = CURRENT_TIMESTAMP, last_login_ip = ?, last_login_user_agent = ?,
                login_count = login_count + 1 WHERE id = ?`,
            [req.ip, req.headers['user-agent'], user.id]);
        
        req.session.userId = user.id;
        req.session.username = user.username;
        req.session.email = user.email;
        
        req.session.save((err) => {
            if (err) {
                console.error('Session save error:', err);
                return res.status(500).json({ error: 'Session error' });
            }
            
            console.log(`\x1b[32m[LOGIN] Successful login: ${email} (ID: ${user.id})\x1b[0m`);
            console.log(`\x1b[36m[SESSION] Session ID: ${req.sessionID}\x1b[0m`);
            
            logUserActivity(user.id, user.email, 'LOGIN', 'User logged in', req);
            
            res.json({ 
                success: true, 
                username: user.username,
                email: user.email,
                reminder_interval: user.reminder_interval,
                auto_reminders: user.auto_reminders === 1,
                message: 'Login successful!' 
            });
        });
    });
});

// Session check endpoint - FIXED AND ADDED
app.get('/api/check-session', (req, res) => {
    console.log(`\x1b[36m[SESSION CHECK] Session ID: ${req.sessionID}\x1b[0m`);
    console.log(`\x1b[36m[SESSION CHECK] Session data:`, req.session);
    
    if (req.session && req.session.userId) {
        // Fetch user details to get email
        db.get("SELECT email, username FROM users WHERE id = ?", [req.session.userId], (err, user) => {
            if (err) {
                console.error('Error fetching user:', err);
                return res.status(500).json({ error: err.message });
            }
            console.log(`\x1b[32m[SESSION CHECK] Valid session for: ${user?.email}\x1b[0m`);
            res.json({ 
                authenticated: true, 
                userId: req.session.userId,
                username: user?.username || req.session.username,
                email: user?.email || req.session.email
            });
        });
    } else {
        console.log(`\x1b[33m[SESSION CHECK] No active session\x1b[0m`);
        res.json({ authenticated: false });
    }
});

app.post('/api/logout', (req, res) => {
    if (req.session.userId) {
        console.log(`\x1b[36m[LOGOUT] User: ${req.session.email}\x1b[0m`);
        logUserActivity(req.session.userId, req.session.email, 'LOGOUT', 'User logged out', req);
    }
    req.session.destroy((err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, message: 'Logged out successfully' });
    });
});

app.post('/api/forgot-password', async (req, res) => {
    const { email } = req.body;
    db.get("SELECT * FROM users WHERE email = ?", [email], async (err, user) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!user) return res.status(404).json({ error: 'Email not found' });
        
        const resetToken = crypto.randomBytes(32).toString('hex');
        const resetExpiry = new Date(Date.now() + 3600000);
        
        db.run("UPDATE users SET reset_token = ?, reset_token_expiry = ? WHERE id = ?",
            [resetToken, resetExpiry.toISOString(), user.id],
            async (err) => {
                if (err) return res.status(500).json({ error: err.message });
                
                const resetLink = `http://localhost:${port}/reset-password.html?token=${resetToken}`;
                if (transporter) {
                    try {
                        await transporter.sendMail({
                            from: process.env.EMAIL_USER,
                            to: email,
                            subject: 'Password Reset - TaskWeaver',
                            html: `<div><h2>Password Reset</h2><p>Click <a href="${resetLink}">here</a> to reset your password.</p><p>This link expires in 1 hour.</p></div>`
                        });
                        logEmailSent(user.id, email, email, 'Password Reset', 'success');
                        res.json({ success: true, message: 'Password reset email sent' });
                    } catch (error) {
                        logEmailSent(user.id, email, email, 'Password Reset', 'failed', error);
                        res.status(500).json({ error: 'Failed to send email' });
                    }
                } else {
                    res.json({ success: true, message: 'Reset link would be sent: ' + resetLink });
                }
            });
    });
});

app.post('/api/reset-password', async (req, res) => {
    const { token, newPassword } = req.body;
    const strength = checkPasswordStrength(newPassword);
    if (strength.score < 3) return res.status(400).json({ error: 'Password too weak.' });
    
    db.get("SELECT * FROM users WHERE reset_token = ? AND reset_token_expiry > ?", 
        [token, new Date().toISOString()], async (err, user) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!user) return res.status(400).json({ error: 'Invalid or expired token' });
            
            const hashedPassword = await bcrypt.hash(newPassword, 10);
            db.run("UPDATE users SET password = ?, reset_token = NULL, reset_token_expiry = NULL WHERE id = ?",
                [hashedPassword, user.id], function(err) {
                    if (err) return res.status(500).json({ error: err.message });
                    logUserActivity(user.id, user.email, 'PASSWORD_RESET', 'Password reset successfully', req);
                    res.json({ success: true, message: 'Password reset successful' });
                });
        });
});

// ============ USER SETTINGS ============
app.get('/api/settings', requireAuth, (req, res) => {
    db.get("SELECT reminder_interval, auto_reminders, email_notifications, push_notifications, timezone, theme FROM users WHERE id = ?", 
        [req.session.userId], (err, user) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ 
                reminder_interval: user?.reminder_interval || 20,
                auto_reminders: user?.auto_reminders === 1,
                email_notifications: user?.email_notifications === 1,
                push_notifications: user?.push_notifications === 1,
                timezone: user?.timezone || 'UTC',
                theme: user?.theme || 'light'
            });
        });
});

app.put('/api/settings', requireAuth, (req, res) => {
    const { reminder_interval, auto_reminders, email_notifications, push_notifications, timezone, theme } = req.body;
    const updates = [], values = [];
    if (reminder_interval !== undefined) { updates.push("reminder_interval = ?"); values.push(reminder_interval); }
    if (auto_reminders !== undefined) { updates.push("auto_reminders = ?"); values.push(auto_reminders ? 1 : 0); }
    if (email_notifications !== undefined) { updates.push("email_notifications = ?"); values.push(email_notifications ? 1 : 0); }
    if (push_notifications !== undefined) { updates.push("push_notifications = ?"); values.push(push_notifications ? 1 : 0); }
    if (timezone !== undefined) { updates.push("timezone = ?"); values.push(timezone); }
    if (theme !== undefined) { updates.push("theme = ?"); values.push(theme); }
    if (updates.length === 0) return res.status(400).json({ error: 'No updates provided' });
    values.push(req.session.userId);
    db.run(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, values, function(err) {
        if (err) return res.status(500).json({ error: err.message });
        logUserActivity(req.session.userId, req.session.email, 'SETTINGS_UPDATED', `Settings updated`, req);
        res.json({ success: true });
    });
});

// ============ TASK ROUTES ============
app.get('/api/tasks', requireAuth, (req, res) => {
    db.all(`SELECT * FROM tasks WHERE user_id = ? AND (deleted_at IS NULL OR deleted_at = '') ORDER BY 
            CASE severity WHEN 'Critical' THEN 1 WHEN 'High' THEN 2 WHEN 'Medium' THEN 3 WHEN 'Low' THEN 4 END, 
            deadline ASC, scheduled_start ASC`, 
        [req.session.userId], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows || []);
        });
});

app.post('/api/tasks', requireAuth, (req, res) => {
    const { title, description, project, category, severity, priority, deadline, is_recurring, recurrence_pattern, scheduled_start, scheduled_end, estimated_duration, tags } = req.body;
    if (!title) return res.status(400).json({ error: 'Task title is required' });
    
    db.run(`INSERT INTO tasks (user_id, user_email, title, description, project, category, severity, priority, deadline, is_recurring, recurrence_pattern, scheduled_start, scheduled_end, estimated_duration, tags)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [req.session.userId, req.session.email, title, description || null, project || null, category || null, severity || 'Medium', priority || 2, deadline || null, is_recurring ? 1 : 0, recurrence_pattern || null, scheduled_start || null, scheduled_end || null, estimated_duration || null, tags || null],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            
            // Create reminder if scheduled
            if (scheduled_start) {
                const reminderTime = new Date(new Date(scheduled_start).getTime() - 20 * 60 * 1000);
                db.run(`INSERT INTO reminders (user_id, user_email, task_id, reminder_time, reminder_type) VALUES (?, ?, ?, ?, 'scheduled')`,
                    [req.session.userId, req.session.email, this.lastID, reminderTime.toISOString()]);
            }
            
            console.log(`\x1b[36m[TASK] ${req.session.email} created task: ${title}\x1b[0m`);
            logUserActivity(req.session.userId, req.session.email, 'TASK_CREATED', `Task: ${title}`, req);
            res.json({ id: this.lastID, message: 'Task created successfully' });
        });
});

app.put('/api/tasks/:id', requireAuth, (req, res) => {
    const { title, description, project, category, severity, priority, deadline, scheduled_start, scheduled_end, completed, actual_start, actual_end, completion_notes, tags } = req.body;
    const updates = [], values = [];
    
    if (title !== undefined) { updates.push("title = ?"); values.push(title); }
    if (description !== undefined) { updates.push("description = ?"); values.push(description); }
    if (project !== undefined) { updates.push("project = ?"); values.push(project); }
    if (category !== undefined) { updates.push("category = ?"); values.push(category); }
    if (severity !== undefined) { updates.push("severity = ?"); values.push(severity); }
    if (priority !== undefined) { updates.push("priority = ?"); values.push(priority); }
    if (deadline !== undefined) { updates.push("deadline = ?"); values.push(deadline); }
    if (scheduled_start !== undefined) { updates.push("scheduled_start = ?"); values.push(scheduled_start); }
    if (scheduled_end !== undefined) { updates.push("scheduled_end = ?"); values.push(scheduled_end); }
    if (actual_start !== undefined) { updates.push("actual_start = ?"); values.push(actual_start); }
    if (actual_end !== undefined) { updates.push("actual_end = ?"); values.push(actual_end); }
    if (completion_notes !== undefined) { updates.push("completion_notes = ?"); values.push(completion_notes); }
    if (tags !== undefined) { updates.push("tags = ?"); values.push(tags); }
    if (completed !== undefined) { 
        updates.push("completed = ?"); 
        values.push(completed ? 1 : 0);
        if (completed) updates.push("completed_at = CURRENT_TIMESTAMP");
        else updates.push("completed_at = NULL");
        updates.push("updated_at = CURRENT_TIMESTAMP");
    }
    
    if (updates.length === 0) return res.status(400).json({ error: 'No updates provided' });
    
    values.push(req.params.id, req.session.userId);
    db.run(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`, values, function(err) {
        if (err) return res.status(500).json({ error: err.message });
        logUserActivity(req.session.userId, req.session.email, 'TASK_UPDATED', `Task ID: ${req.params.id}`, req);
        res.json({ updated: this.changes });
    });
});

app.delete('/api/tasks/:id', requireAuth, (req, res) => {
    db.get("SELECT title FROM tasks WHERE id = ? AND user_id = ?", [req.params.id, req.session.userId], (err, task) => {
        if (err) return res.status(500).json({ error: err.message });
        db.run(`DELETE FROM tasks WHERE id = ? AND user_id = ?`, [req.params.id, req.session.userId], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            if (task) logUserActivity(req.session.userId, req.session.email, 'TASK_DELETED', `Task: ${task.title}`, req);
            res.json({ deleted: this.changes });
        });
    });
});

// ============ SHARING AND EXPORT ROUTES ============
app.post('/api/share-schedule', requireAuth, async (req, res) => {
    const { shareWithEmail, shareType = 'view' } = req.body;
    const userEmail = req.session.email;
    const userId = req.session.userId;
    
    if (!shareWithEmail) {
        return res.status(400).json({ error: 'Recipient email is required' });
    }
    
    // Check if recipient exists
    db.get("SELECT id, email FROM users WHERE email = ?", [shareWithEmail], async (err, recipient) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!recipient) return res.status(404).json({ error: 'Recipient email not found in TaskWeaver' });
        
        const shareToken = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
        
        db.run(`INSERT INTO shared_schedules (user_id, user_email, share_with_email, share_token, share_type, expires_at)
                VALUES (?, ?, ?, ?, ?, ?)`,
            [userId, userEmail, shareWithEmail, shareToken, shareType, expiresAt.toISOString()],
            async function(err) {
                if (err) return res.status(500).json({ error: err.message });
                
                // Get user's tasks to share
                db.all(`SELECT * FROM tasks WHERE user_id = ? AND completed = 0 AND (deleted_at IS NULL OR deleted_at = '') 
                        ORDER BY scheduled_start ASC, deadline ASC`, 
                    [userId], async (err, tasks) => {
                        if (err) return res.status(500).json({ error: err.message });
                        
                        const shareLink = `http://localhost:${port}/api/view-shared-schedule?token=${shareToken}`;
                        
                        // Generate PDF attachment
                        const pdfBuffer = await generatePDF(tasks, userEmail);
                        const excelBuffer = await generateExcel(tasks);
                        const csvData = generateCSV(tasks);
                        
                        const emailContent = getEmailTemplate(
                            `${userEmail} has shared their schedule with you! 📅`,
                            `Hi ${recipient.email},<br><br>
                            <strong>${userEmail}</strong> has shared their TaskWeaver schedule with you.<br><br>
                            <div class="info-box">
                                <strong>Schedule Details:</strong><br>
                                Total Tasks: ${tasks.length}<br>
                                Shared by: ${userEmail}<br>
                                Share Type: ${shareType}<br>
                                Expires: ${expiresAt.toLocaleString()}<br>
                            </div>
                            You can view the schedule online using the link below, or check the attached files.`,
                            'View Schedule Online',
                            shareLink
                        );
                        
                        if (transporter) {
                            try {
                                await transporter.sendMail({
                                    from: process.env.EMAIL_USER,
                                    to: shareWithEmail,
                                    subject: `📅 Schedule Shared with You - TaskWeaver`,
                                    html: emailContent,
                                    attachments: [
                                        {
                                            filename: `schedule_${userEmail.replace('@', '_')}.pdf`,
                                            content: pdfBuffer,
                                            contentType: 'application/pdf'
                                        },
                                        {
                                            filename: `schedule_${userEmail.replace('@', '_')}.xlsx`,
                                            content: excelBuffer,
                                            contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
                                        },
                                        {
                                            filename: `schedule_${userEmail.replace('@', '_')}.csv`,
                                            content: csvData,
                                            contentType: 'text/csv'
                                        }
                                    ]
                                });
                                logEmailSent(userId, userEmail, shareWithEmail, 'Schedule Shared', 'success');
                                console.log(`\x1b[32m[SCHARE] Schedule shared from ${userEmail} to ${shareWithEmail}\x1b[0m`);
                                res.json({ success: true, message: `Schedule shared with ${shareWithEmail}` });
                            } catch (error) {
                                logEmailSent(userId, userEmail, shareWithEmail, 'Schedule Shared', 'failed', error);
                                console.log(`\x1b[31m[SCHARE] Failed to share schedule: ${error.message}\x1b[0m`);
                                res.status(500).json({ error: 'Failed to send share email' });
                            }
                        } else {
                            res.json({ success: true, shareLink, message: 'Share link generated (email not configured)' });
                        }
                    });
            });
    });
});

app.get('/api/view-shared-schedule', (req, res) => {
    const { token, format = 'json' } = req.query;
    
    db.get(`SELECT * FROM shared_schedules WHERE share_token = ? AND expires_at > datetime('now')`, 
        [token], (err, share) => {
            if (err || !share) {
                return res.status(404).json({ error: 'Invalid or expired share link' });
            }
            
            db.all(`SELECT * FROM tasks WHERE user_id = ? AND completed = 0 AND (deleted_at IS NULL OR deleted_at = '') 
                    ORDER BY scheduled_start ASC, deadline ASC`, 
                [share.user_id], async (err, tasks) => {
                    if (err) return res.status(500).json({ error: err.message });
                    
                    switch(format) {
                        case 'pdf':
                            const pdfBuffer = await generatePDF(tasks, share.user_email);
                            res.setHeader('Content-Type', 'application/pdf');
                            res.setHeader('Content-Disposition', `attachment; filename=shared_schedule_${share.user_email}.pdf`);
                            res.send(pdfBuffer);
                            break;
                        case 'excel':
                        case 'xlsx':
                            const excelBuffer = await generateExcel(tasks);
                            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
                            res.setHeader('Content-Disposition', `attachment; filename=shared_schedule_${share.user_email}.xlsx`);
                            res.send(excelBuffer);
                            break;
                        case 'csv':
                            const csvData = generateCSV(tasks);
                            res.setHeader('Content-Type', 'text/csv');
                            res.setHeader('Content-Disposition', `attachment; filename=shared_schedule_${share.user_email}.csv`);
                            res.send(csvData);
                            break;
                        default:
                            res.json({ sharedBy: share.user_email, tasks, shareType: share.share_type });
                    }
                });
        });
});

app.get('/api/export-schedule', requireAuth, async (req, res) => {
    const { format = 'json' } = req.query;
    const userId = req.session.userId;
    const userEmail = req.session.email;
    
    db.all(`SELECT * FROM tasks WHERE user_id = ? AND completed = 0 AND (deleted_at IS NULL OR deleted_at = '') 
            ORDER BY scheduled_start ASC, deadline ASC`, 
        [userId], async (err, tasks) => {
            if (err) return res.status(500).json({ error: err.message });
            
            console.log(`\x1b[36m[EXPORT] User ${userEmail} exporting schedule as ${format}\x1b[0m`);
            logUserActivity(userId, userEmail, 'EXPORT_SCHEDULE', `Exported schedule as ${format}`, req);
            
            switch(format) {
                case 'pdf':
                    const pdfBuffer = await generatePDF(tasks, userEmail);
                    res.setHeader('Content-Type', 'application/pdf');
                    res.setHeader('Content-Disposition', `attachment; filename=my_schedule_${new Date().toISOString().split('T')[0]}.pdf`);
                    res.send(pdfBuffer);
                    break;
                case 'excel':
                case 'xlsx':
                    const excelBuffer = await generateExcel(tasks);
                    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
                    res.setHeader('Content-Disposition', `attachment; filename=my_schedule_${new Date().toISOString().split('T')[0]}.xlsx`);
                    res.send(excelBuffer);
                    break;
                case 'csv':
                    const csvData = generateCSV(tasks);
                    res.setHeader('Content-Type', 'text/csv');
                    res.setHeader('Content-Disposition', `attachment; filename=my_schedule_${new Date().toISOString().split('T')[0]}.csv`);
                    res.send(csvData);
                    break;
                default:
                    res.json(tasks);
            }
        });
});

// ============ ADDITIONAL ENDPOINTS ============
app.get('/api/user-stats', requireAuth, (req, res) => {
    db.get(`SELECT 
                COUNT(CASE WHEN completed = 1 THEN 1 END) as completed_tasks,
                COUNT(CASE WHEN completed = 0 AND (scheduled_start IS NOT NULL AND scheduled_start != '') AND (deleted_at IS NULL OR deleted_at = '') THEN 1 END) as scheduled_tasks,
                COUNT(CASE WHEN completed = 0 AND (scheduled_start IS NULL OR scheduled_start = '') AND (deleted_at IS NULL OR deleted_at = '') THEN 1 END) as unscheduled_tasks,
                COUNT(CASE WHEN severity = 'Critical' AND completed = 0 AND (deleted_at IS NULL OR deleted_at = '') THEN 1 END) as critical_tasks,
                COUNT(CASE WHEN severity = 'High' AND completed = 0 AND (deleted_at IS NULL OR deleted_at = '') THEN 1 END) as high_priority_tasks,
                COUNT(CASE WHEN deadline < CURRENT_TIMESTAMP AND completed = 0 AND (deleted_at IS NULL OR deleted_at = '') THEN 1 END) as overdue_tasks,
                COUNT(CASE WHEN created_at > datetime('now', '-7 days') THEN 1 END) as tasks_this_week
            FROM tasks WHERE user_id = ?`, 
        [req.session.userId], (err, stats) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(stats || {});
        });
});

// ============ REMINDER SYSTEM ============
function checkScheduledReminders() {
    db.all(`
        SELECT r.*, t.title, t.description, t.user_id, t.user_email, u.email_notifications
        FROM reminders r
        JOIN tasks t ON r.task_id = t.id
        JOIN users u ON r.user_id = u.id
        WHERE r.reminder_time <= datetime('now')
        AND r.sent = 0
        AND u.email_notifications = 1
        AND t.completed = 0
        AND (t.deleted_at IS NULL OR t.deleted_at = '')
    `, (err, reminders) => {
        if (err) {
            logToFile(errorLogStream, 'ERROR', 'Error checking reminders', err);
            return;
        }
        
        reminders.forEach(reminder => {
            if (transporter) {
                const emailContent = getEmailTemplate(
                    `Reminder: ${reminder.title}`,
                    `<div class="info-box">
                        <strong>Task Details:</strong><br>
                        Title: ${reminder.title}<br>
                        ${reminder.description ? `Description: ${reminder.description}<br>` : ''}
                        Reminder Time: ${new Date(reminder.reminder_time).toLocaleString()}<br>
                        ${reminder.scheduled_start ? `Scheduled: ${new Date(reminder.scheduled_start).toLocaleString()}<br>` : ''}
                    </div>
                    <hr>
                    <p>Stay focused and complete your task on time! 💪</p>`
                );
                
                transporter.sendMail({
                    from: process.env.EMAIL_USER,
                    to: reminder.user_email,
                    subject: `🔔 Task Reminder: ${reminder.title}`,
                    html: emailContent
                }, (error) => {
                    if (!error) {
                        db.run("UPDATE reminders SET sent = 1, sent_at = CURRENT_TIMESTAMP WHERE id = ?", [reminder.id]);
                        logEmailSent(reminder.user_id, reminder.user_email, reminder.user_email, `Reminder: ${reminder.title}`, 'success');
                        db.run("UPDATE tasks SET reminder_count = reminder_count + 1, last_reminder_sent = CURRENT_TIMESTAMP WHERE id = ?", [reminder.task_id]);
                        console.log(`\x1b[32m[REMINDER] Sent to ${reminder.user_email}: ${reminder.title}\x1b[0m`);
                    } else {
                        logEmailSent(reminder.user_id, reminder.user_email, reminder.user_email, `Reminder: ${reminder.title}`, 'failed', error);
                        db.run("UPDATE reminders SET retry_count = retry_count + 1, last_error = ? WHERE id = ?", [error.message, reminder.id]);
                    }
                });
            }
        });
    });
}

// Schedule reminders
cron.schedule('* * * * *', () => { checkScheduledReminders(); });

// Daily cleanup
cron.schedule('0 2 * * *', () => {
    db.run("DELETE FROM activity_log WHERE created_at < datetime('now', '-90 days')");
    db.run("DELETE FROM reminders WHERE created_at < datetime('now', '-30 days')");
    db.run("DELETE FROM email_log WHERE created_at < datetime('now', '-180 days')");
    db.run("DELETE FROM suggestions WHERE created_at < datetime('now', '-30 days') AND is_read = 1");
    db.run("DELETE FROM shared_schedules WHERE expires_at < datetime('now')");
});

// ============ ERROR HANDLING ============
app.use((err, req, res, next) => {
    logToFile(errorLogStream, 'ERROR', 'Unhandled error', err);
    res.status(500).json({ error: 'Internal server error' });
});

app.use((req, res) => {
    res.status(404).json({ error: 'Route not found' });
});

// ============ SERVER STARTUP ============
async function startServer() {
    try {
        await initDatabase();
        await initializeDatabase();
        await createDemoUser();
        setupEmailTransporter();
        
        app.listen(port, () => {
            console.log('\x1b[36m%s\x1b[0m', `\n🚀 TaskWeaver server running on http://localhost:${port}`);
            console.log('\x1b[32m%s\x1b[0m', `📧 Email notifications configured`);
            console.log('\x1b[33m%s\x1b[0m', `⏰ Deadline reminders will be sent for tasks approaching deadlines`);
            console.log('\x1b[33m%s\x1b[0m', `📅 Schedule sharing enabled with PDF/Excel/CSV exports`);
            console.log('\x1b[36m%s\x1b[0m', `💾 Database: database.sqlite`);
            console.log('\x1b[32m%s\x1b[0m', `\n📝 Default Login: demo@taskweaver.com / Demo@2024`);
            console.log('\x1b[36m%s\x1b[0m', `🩺 Health check: http://localhost:${port}/api/health\n`);
        });
        
        process.on('SIGTERM', () => { if (db) db.close(() => process.exit(0)); else process.exit(0); });
        process.on('SIGINT', () => { if (db) db.close(() => process.exit(0)); else process.exit(0); });
    } catch (error) {
        logToFile(errorLogStream, 'ERROR', 'Failed to start server', error);
        console.error('\x1b[31m%s\x1b[0m', 'Failed to start server:', error);
        process.exit(1);
    }
}

startServer();