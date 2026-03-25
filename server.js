const express = require('express');
const { Pool } = require('pg');
const bodyParser = require('body-parser');
const cors = require('cors');
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');
const { Parser } = require('json2csv');
require('dotenv').config();

// ============ RENDER ENVIRONMENT DETECTION ============
const isRender = process.env.RENDER === 'true' || 
                 process.env.RENDER_SERVICE_ID || 
                 process.env.RENDER_INSTANCE_ID ||
                 process.env.DATABASE_URL?.includes('render.com');

console.log('\x1b[36m%s\x1b[0m', `🔍 Environment: ${isRender ? 'Render (Production)' : 'Local (Development)'}`);

const app = express();
const port = process.env.PORT || 3000;

// ============ CONSOLE LOGGING WITH TIMESTAMPS ============
function consoleLog(type, message, data = null) {
    const timestamp = new Date().toISOString();
    const logMsg = `[${timestamp}] [${type}] ${message}`;
    
    switch(type) {
        case 'ERROR':
            console.error('\x1b[31m%s\x1b[0m', logMsg);
            break;
        case 'SUCCESS':
            console.log('\x1b[32m%s\x1b[0m', logMsg);
            break;
        case 'WARNING':
            console.warn('\x1b[33m%s\x1b[0m', logMsg);
            break;
        case 'ACTIVITY':
            console.log('\x1b[36m%s\x1b[0m', logMsg);
            break;
        default:
            console.log('\x1b[90m%s\x1b[0m', logMsg);
    }
    
    if (data) {
        console.log('\x1b[90m%s\x1b[0m', `  └─ Data:`, data);
    }
}

// ============ DATABASE CONNECTION ============
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

let dbConnected = false;

pool.connect((err, client, release) => {
  if (err) {
    consoleLog('ERROR', 'Database connection error:', err.message);
  } else {
    consoleLog('SUCCESS', 'PostgreSQL database connected');
    dbConnected = true;
    release();
  }
});

// ============ LOGGING SYSTEM ============
const LOG_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
}

const errorLogStream = fs.createWriteStream(path.join(LOG_DIR, 'error.log'), { flags: 'a' });
const activityLogStream = fs.createWriteStream(path.join(LOG_DIR, 'activity.log'), { flags: 'a' });
const emailLogStream = fs.createWriteStream(path.join(LOG_DIR, 'email.log'), { flags: 'a' });

function logToFile(stream, level, message, data = null) {
    const timestamp = new Date().toISOString();
    const logEntry = { timestamp, level, message, ...(data && { data }) };
    stream.write(JSON.stringify(logEntry) + '\n');
}

async function logUserActivity(userId, email, action, details, req = null) {
    if (!dbConnected) return;
    
    const logData = {
        userId, email, action, details,
        ip: req?.ip || req?.connection?.remoteAddress || 'unknown',
        userAgent: req?.headers['user-agent'] || 'unknown',
        method: req?.method, 
        url: req?.originalUrl
    };
    
    logToFile(activityLogStream, 'ACTIVITY', `User ${email}: ${action}`, logData);
    consoleLog('ACTIVITY', `${email} - ${action}`, { details, ip: logData.ip });
    
    try {
        await pool.query(
            `INSERT INTO activity_log (user_id, email, action, details, ip_address, user_agent, request_method, request_url) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [userId, email, action, details, logData.ip, logData.userAgent, logData.method, logData.url]
        );
    } catch (err) {
        logToFile(errorLogStream, 'ERROR', 'Failed to log activity', err);
    }
}

async function logEmailSent(userId, email, to, subject, status, error = null) {
    logToFile(emailLogStream, 'EMAIL', `Email to ${to}: ${subject} - ${status}`, { userId, email, to, subject, status });
    consoleLog('EMAIL', `${email} -> ${to}: ${subject} - ${status}`);
    
    if (!dbConnected) return;
    
    try {
        await pool.query(
            `INSERT INTO email_log (user_id, user_email, recipient, subject, status, error_message) 
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [userId, email, to, subject, status, error?.message]
        );
    } catch (err) {
        logToFile(errorLogStream, 'ERROR', 'Failed to log email', err);
    }
}

// ============ HELPER FUNCTIONS ============
function safeTimestamp(value) {
    if (!value || value === '' || value === 'null' || value === 'undefined' || value === 'Invalid Date') {
        return null;
    }
    try {
        const date = new Date(value);
        return isNaN(date.getTime()) ? null : date.toISOString();
    } catch (err) {
        return null;
    }
}

function formatTimestampForResponse(timestamp) {
    if (!timestamp) return null;
    try {
        return new Date(timestamp).toISOString();
    } catch (err) {
        return null;
    }
}

async function generateUsername(email) {
    let base = email.split('@')[0].replace(/[^a-zA-Z]/g, '').toUpperCase();
    if (base.length < 3) base = base + 'USER';
    let attempt = 0;
    while (true) {
        let username = base + (attempt > 0 ? attempt : '');
        const result = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
        if (result.rows.length === 0) return username;
        attempt++;
    }
}

function checkPasswordStrength(password) {
    let score = 0;
    if (!password) return { score: 0, strength: 'No Password', color: '#6c757d', width: '0%' };
    if (password.length >= 8) score++;
    if (password.length >= 12) score++;
    if (/[A-Z]/.test(password)) score++;
    if (/[0-9]/.test(password)) score++;
    if (/[^A-Za-z0-9]/.test(password)) score++;
    let strength = score <= 2 ? 'Weak' : score <= 4 ? 'Medium' : 'Strong';
    let color = score <= 2 ? '#dc3545' : score <= 4 ? '#ffc107' : '#28a745';
    return { score, strength, color, width: `${(score / 5) * 100}%` };
}

// ============ PDF/EXCEL/CSV GENERATION FUNCTIONS ============
async function generatePDF(tasks, userEmail) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ margin: 50, size: 'A4' });
        const buffers = [];
        doc.on('data', buffers.push.bind(buffers));
        doc.on('end', () => resolve(Buffer.concat(buffers)));
        doc.on('error', reject);
        
        doc.rect(0, 0, doc.page.width, 100).fill('#667eea');
        doc.fillColor('#fff').fontSize(28).font('Helvetica-Bold').text('TaskWeaver', 50, 35);
        doc.fontSize(14).font('Helvetica').text('Schedule Report', 50, 70);
        doc.fillColor('#2d3748').fontSize(12).text(`Generated for: ${userEmail}`, 50, 120);
        doc.text(`Generated on: ${new Date().toLocaleString()}`, 50, 140);
        
        let y = 180;
        tasks.forEach(task => {
            if (y > doc.page.height - 150) { doc.addPage(); y = 50; }
            let color = task.severity === 'Critical' ? '#f56565' : task.severity === 'High' ? '#ed8936' : '#48bb78';
            doc.rect(50, y - 10, doc.page.width - 100, 100).fill('#f7fafc');
            doc.rect(50, y - 10, 5, 100).fill(color);
            doc.fillColor('#2d3748').fontSize(14).font('Helvetica-Bold').text(task.title, 65, y);
            doc.fontSize(10).font('Helvetica').fillColor('#4a5568');
            let details = [];
            if (task.description) details.push(`📝 ${task.description.substring(0, 100)}`);
            if (task.project) details.push(`📁 Project: ${task.project}`);
            if (task.scheduled_start) details.push(`⏰ ${new Date(task.scheduled_start).toLocaleString()}`);
            if (task.deadline) details.push(`⚠️ Deadline: ${new Date(task.deadline).toLocaleString()}`);
            doc.text(details.join(' • '), 65, y + 20);
            y += 110;
        });
        doc.end();
    });
}

async function generateExcel(tasks) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'TaskWeaver';
    const worksheet = workbook.addWorksheet('Schedule Report');
    worksheet.columns = [
        { header: 'Task Title', key: 'title', width: 30 },
        { header: 'Description', key: 'description', width: 40 },
        { header: 'Project', key: 'project', width: 20 },
        { header: 'Category', key: 'category', width: 15 },
        { header: 'Severity', key: 'severity', width: 12 },
        { header: 'Priority', key: 'priority', width: 10 },
        { header: 'Scheduled Start', key: 'scheduled_start', width: 20 },
        { header: 'Deadline', key: 'deadline', width: 20 },
        { header: 'Completed', key: 'completed', width: 12 },
        { header: 'Tags', key: 'tags', width: 20 }
    ];
    worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    worksheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF667EEA' } };
    tasks.forEach(task => {
        worksheet.addRow({
            title: task.title,
            description: task.description || '',
            project: task.project || '',
            category: task.category || '',
            severity: task.severity || 'Medium',
            priority: task.priority || 2,
            scheduled_start: task.scheduled_start ? new Date(task.scheduled_start).toLocaleString() : '',
            deadline: task.deadline ? new Date(task.deadline).toLocaleString() : '',
            completed: task.completed ? 'Yes' : 'No',
            tags: task.tags || ''
        });
    });
    return await workbook.xlsx.writeBuffer();
}

function generateCSV(tasks) {
    const fields = ['title', 'description', 'project', 'category', 'severity', 'priority', 'scheduled_start', 'deadline', 'completed', 'tags'];
    const parser = new Parser({ fields });
    const formattedTasks = tasks.map(task => ({
        ...task,
        scheduled_start: task.scheduled_start ? new Date(task.scheduled_start).toLocaleString() : '',
        deadline: task.deadline ? new Date(task.deadline).toLocaleString() : '',
        completed: task.completed ? 'Yes' : 'No'
    }));
    return parser.parse(formattedTasks);
}

function getEmailTemplate(title, content, buttonText = null, buttonLink = null) {
    return `<!DOCTYPE html>
    <html>
    <head><meta charset="UTF-8"><title>TaskWeaver</title>
    <style>
        body{font-family:'Segoe UI',Arial,sans-serif;background:#f7fafc;margin:0;padding:20px}
        .container{max-width:600px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 6px rgba(0,0,0,0.1)}
        .header{background:linear-gradient(135deg,#667eea,#764ba2);padding:30px;text-align:center}
        .header h1{color:#fff;margin:0;font-size:28px}
        .header p{color:rgba(255,255,255,0.9);margin:10px 0 0}
        .content{padding:40px}
        .title{font-size:24px;font-weight:bold;color:#2d3748;margin-bottom:20px;border-left:4px solid #667eea;padding-left:15px}
        .message{color:#4a5568;line-height:1.6}
        .info-box{background:#f7fafc;border-left:4px solid #667eea;padding:15px;margin:20px 0;border-radius:8px}
        .button{display:inline-block;background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;padding:12px 30px;text-decoration:none;border-radius:8px;margin:20px 0;font-weight:600}
        .footer{background:#f7fafc;padding:20px;text-align:center;font-size:12px;color:#718096}
        hr{border:none;border-top:1px solid #e2e8f0;margin:20px 0}
    </style>
    </head>
    <body>
    <div class="container">
        <div class="header"><h1>⚡ TaskWeaver</h1><p>Your Intelligent Task Management Solution</p></div>
        <div class="content">
            <div class="title">${title}</div>
            <div class="message">${content}</div>
            ${buttonText && buttonLink ? `<div style="text-align:center"><a href="${buttonLink}" class="button">${buttonText}</a></div>` : ''}
        </div>
        <div class="footer"><p>© 2025 TaskWeaver. All rights reserved.</p><p>Made with ❤️ for better productivity</p></div>
    </div>
    </body>
    </html>`;
}

// ============ EMAIL TRANSPORTER ============
let transporter = null;

function setupEmailTransporter() {
    consoleLog('INFO', 'Configuring email transporter...');
    
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
        consoleLog('WARNING', 'Email credentials not configured. Email notifications will be disabled.');
        consoleLog('INFO', 'To enable email, set EMAIL_USER and EMAIL_PASS in environment variables');
        return;
    }
    
    if (process.env.EMAIL_USER === 'your-email@gmail.com') {
        consoleLog('WARNING', 'Using placeholder email. Please update EMAIL_USER in environment variables');
        return;
    }
    
    const emailPass = process.env.EMAIL_PASS.replace(/\s/g, '');
    const emailUser = process.env.EMAIL_USER.trim();
    
    try {
        const smtpConfig = isRender ? {
            host: 'smtp.gmail.com',
            port: 587,
            secure: false,
            auth: { user: emailUser, pass: emailPass },
            tls: { rejectUnauthorized: false },
            connectionTimeout: 30000,
            greetingTimeout: 30000,
            socketTimeout: 30000,
            debug: false
        } : {
            service: 'gmail',
            auth: { user: emailUser, pass: emailPass },
            debug: false
        };
        
        transporter = nodemailer.createTransport(smtpConfig);
        
        transporter.verify((error, success) => {
            if (error) {
                consoleLog('ERROR', '✗ Email server connection FAILED:', error.message);
                transporter = null;
            } else {
                consoleLog('SUCCESS', '✓ Email server CONNECTED and READY');
                consoleLog('SUCCESS', `  └─ Using email: ${emailUser}`);
                if (isRender) {
                    consoleLog('SUCCESS', `  └─ Render mode: SMTP on port ${smtpConfig.port}`);
                }
            }
        });
    } catch (error) {
        consoleLog('ERROR', 'Failed to setup email transporter:', error.message);
        transporter = null;
    }
}

function sendEmail(to, subject, html) {
    if (!transporter) {
        consoleLog('WARNING', `Email not sent to ${to}: Email service not configured`);
        return Promise.reject(new Error('Email service not configured'));
    }
    
    consoleLog('INFO', `Sending email to ${to}: ${subject}`);
    
    const mailOptions = {
        from: `"TaskWeaver" <${process.env.EMAIL_USER}>`,
        to: to,
        subject: subject,
        html: html,
        headers: {
            'X-Priority': '3',
            'X-Mailer': 'TaskWeaver'
        }
    };
    
    return transporter.sendMail(mailOptions)
        .then(info => {
            consoleLog('SUCCESS', `✓ Email sent to ${to}: ${subject} (Message ID: ${info.messageId})`);
            return info;
        })
        .catch(error => {
            consoleLog('ERROR', `✗ Failed to send email to ${to}:`, error.message);
            if (error.code === 'EAUTH') {
                consoleLog('ERROR', '  └─ Authentication failed. Use App Password for Gmail');
            } else if (error.code === 'ECONNECTION') {
                consoleLog('ERROR', '  └─ Connection failed. Check network/firewall');
            }
            throw error;
        });
}

// ============ CORS CONFIGURATION ============
const allowedOrigins = [
    'http://localhost:3000',
    'http://localhost:5500',
    'http://localhost:5501',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:5500',
    'http://127.0.0.1:5501',
    'https://taskweaver.onrender.com',
    'https://taskweaver-app.onrender.com'
];

app.use(cors({
    origin: function (origin, callback) {
        if (!origin) return callback(null, true);
        if (allowedOrigins.indexOf(origin) !== -1) {
            return callback(null, true);
        }
        if (process.env.NODE_ENV === 'production' && origin && origin.includes('onrender.com')) {
            return callback(null, true);
        }
        consoleLog('WARNING', `CORS blocked request from: ${origin}`);
        callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'X-Requested-With', 'Cookie']
}));

app.options('*', cors());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));

// ============ STATIC FILE SERVING ============
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => { 
    consoleLog('INFO', `Serving index.html to ${req.ip}`);
    res.sendFile(path.join(__dirname, 'public', 'index.html')); 
});
app.get('/login', (req, res) => { 
    consoleLog('INFO', `Serving login.html to ${req.ip}`);
    res.sendFile(path.join(__dirname, 'public', 'login.html')); 
});
app.get('/reset-password.html', (req, res) => { 
    res.sendFile(path.join(__dirname, 'public', 'reset-password.html')); 
});

// ============ SESSION CONFIGURATION ============
app.use(session({
    store: new pgSession({
        pool: pool,
        tableName: 'session',
        createTableIfMissing: true,
    }),
    secret: process.env.SESSION_SECRET || 'taskweaver_secret_key_2024_secure_32_chars',
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: false,
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000,
        sameSite: 'lax'
    },
    name: 'taskweaver.sid',
    rolling: true
}));

app.use((req, res, next) => {
    if (req.session && req.session.userId) {
        res.locals.userId = req.session.userId;
        res.locals.email = req.session.email;
    }
    next();
});

// ============ DATABASE INITIALIZATION - COMPLETE WITH ALL ORIGINAL FEATURES ============
async function initializeDatabase() {
    consoleLog('INFO', 'Initializing database...');
    const client = await pool.connect();
    try {
        // Users table
        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username TEXT UNIQUE NOT NULL,
                email TEXT UNIQUE NOT NULL,
                password TEXT NOT NULL,
                reset_token TEXT,
                reset_token_expiry TIMESTAMP,
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
                last_failed_login TIMESTAMP,
                locked_until TIMESTAMP,
                email_verified INTEGER DEFAULT 0,
                verification_token TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_login TIMESTAMP
            )
        `);
        consoleLog('SUCCESS', 'Users table ready');
        
        // Tasks table
        await client.query(`
            CREATE TABLE IF NOT EXISTS tasks (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                user_email TEXT NOT NULL,
                title TEXT NOT NULL,
                description TEXT,
                project TEXT,
                category TEXT,
                severity TEXT DEFAULT 'Medium',
                priority INTEGER DEFAULT 2,
                deadline TIMESTAMP,
                is_recurring INTEGER DEFAULT 0,
                recurrence_pattern TEXT,
                recurrence_end_date TIMESTAMP,
                scheduled_start TIMESTAMP,
                scheduled_end TIMESTAMP,
                actual_start TIMESTAMP,
                actual_end TIMESTAMP,
                completed INTEGER DEFAULT 0,
                completed_at TIMESTAMP,
                completion_notes TEXT,
                email_reminder_sent INTEGER DEFAULT 0,
                deadline_reminder_sent INTEGER DEFAULT 0,
                overdue_reminder_sent INTEGER DEFAULT 0,
                reminder_count INTEGER DEFAULT 0,
                last_reminder_sent TIMESTAMP,
                estimated_duration INTEGER,
                actual_duration INTEGER,
                tags TEXT,
                attachments TEXT,
                subtasks TEXT,
                dependencies TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                deleted_at TIMESTAMP
            )
        `);
        consoleLog('SUCCESS', 'Tasks table ready');
        
        // Shared schedules table
        await client.query(`
            CREATE TABLE IF NOT EXISTS shared_schedules (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                user_email TEXT NOT NULL,
                share_with_email TEXT NOT NULL,
                share_token TEXT UNIQUE,
                share_type TEXT DEFAULT 'view',
                expires_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        consoleLog('SUCCESS', 'Shared schedules table ready');
        
        // Reminders table
        await client.query(`
            CREATE TABLE IF NOT EXISTS reminders (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                user_email TEXT NOT NULL,
                task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
                reminder_time TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                reminder_type TEXT DEFAULT 'scheduled',
                reminder_method TEXT DEFAULT 'email',
                sent INTEGER DEFAULT 0,
                sent_at TIMESTAMP,
                retry_count INTEGER DEFAULT 0,
                last_error TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        consoleLog('SUCCESS', 'Reminders table ready');
        
        // Activity log table
        await client.query(`
            CREATE TABLE IF NOT EXISTS activity_log (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                email TEXT NOT NULL,
                action TEXT NOT NULL,
                details TEXT,
                ip_address TEXT,
                user_agent TEXT,
                request_method TEXT,
                request_url TEXT,
                response_status INTEGER,
                response_time INTEGER,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        consoleLog('SUCCESS', 'Activity log table ready');
        
        // Email log table
        await client.query(`
            CREATE TABLE IF NOT EXISTS email_log (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                user_email TEXT,
                recipient TEXT NOT NULL,
                subject TEXT NOT NULL,
                body TEXT,
                status TEXT,
                error_message TEXT,
                sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        consoleLog('SUCCESS', 'Email log table ready');
        
        // Suggestions table
        await client.query(`
            CREATE TABLE IF NOT EXISTS suggestions (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                user_email TEXT NOT NULL,
                suggestion TEXT NOT NULL,
                type TEXT,
                priority INTEGER DEFAULT 0,
                is_read INTEGER DEFAULT 0,
                read_at TIMESTAMP,
                action_taken TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        consoleLog('SUCCESS', 'Suggestions table ready');
        
        // Projects table
        await client.query(`
            CREATE TABLE IF NOT EXISTS projects (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                user_email TEXT NOT NULL,
                name TEXT NOT NULL,
                description TEXT,
                color TEXT,
                status TEXT DEFAULT 'active',
                progress INTEGER DEFAULT 0,
                start_date TIMESTAMP,
                end_date TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        consoleLog('SUCCESS', 'Projects table ready');
        
        // Session table
        await client.query(`
            CREATE TABLE IF NOT EXISTS session (
                sid VARCHAR NOT NULL PRIMARY KEY,
                sess JSON NOT NULL,
                expire TIMESTAMP NOT NULL
            )
        `);
        consoleLog('SUCCESS', 'Session table ready');
        
        // Create timestamp validation triggers
        await client.query(`
            CREATE OR REPLACE FUNCTION validate_task_timestamps()
            RETURNS TRIGGER AS $$
            BEGIN
                IF NEW.deadline IS NULL OR NEW.deadline::text = 'null' OR NEW.deadline = '' THEN
                    NEW.deadline := NULL;
                END IF;
                IF NEW.scheduled_start IS NULL OR NEW.scheduled_start::text = 'null' OR NEW.scheduled_start = '' THEN
                    NEW.scheduled_start := NULL;
                END IF;
                IF NEW.scheduled_end IS NULL OR NEW.scheduled_end::text = 'null' OR NEW.scheduled_end = '' THEN
                    NEW.scheduled_end := NULL;
                END IF;
                IF NEW.completed_at IS NULL OR NEW.completed_at::text = 'null' OR NEW.completed_at = '' THEN
                    NEW.completed_at := NULL;
                END IF;
                IF NEW.last_reminder_sent IS NULL OR NEW.last_reminder_sent::text = 'null' OR NEW.last_reminder_sent = '' THEN
                    NEW.last_reminder_sent := NULL;
                END IF;
                IF NEW.recurrence_end_date IS NULL OR NEW.recurrence_end_date::text = 'null' OR NEW.recurrence_end_date = '' THEN
                    NEW.recurrence_end_date := NULL;
                END IF;
                RETURN NEW;
            END;
            $$ LANGUAGE plpgsql;
        `);
        
        await client.query(`
            DROP TRIGGER IF EXISTS validate_task_timestamps_trigger ON tasks;
            CREATE TRIGGER validate_task_timestamps_trigger
                BEFORE INSERT OR UPDATE ON tasks
                FOR EACH ROW
                EXECUTE FUNCTION validate_task_timestamps();
        `);
        
        await client.query(`
            CREATE OR REPLACE FUNCTION validate_reminder_time()
            RETURNS TRIGGER AS $$
            BEGIN
                IF NEW.reminder_time IS NULL OR NEW.reminder_time::text = 'null' OR NEW.reminder_time = '' THEN
                    NEW.reminder_time := NOW();
                END IF;
                RETURN NEW;
            END;
            $$ LANGUAGE plpgsql;
        `);
        
        await client.query(`
            DROP TRIGGER IF EXISTS ensure_valid_reminder_time ON reminders;
            CREATE TRIGGER ensure_valid_reminder_time
                BEFORE INSERT OR UPDATE ON reminders
                FOR EACH ROW
                EXECUTE FUNCTION validate_reminder_time();
        `);
        
        consoleLog('SUCCESS', 'Timestamp validation triggers created');
        
        // Create indexes
        const indexQueries = [
            'CREATE INDEX IF NOT EXISTS idx_tasks_user_id ON tasks(user_id)',
            'CREATE INDEX IF NOT EXISTS idx_tasks_user_email ON tasks(user_email)',
            'CREATE INDEX IF NOT EXISTS idx_tasks_scheduled_start ON tasks(scheduled_start)',
            'CREATE INDEX IF NOT EXISTS idx_tasks_deadline ON tasks(deadline)',
            'CREATE INDEX IF NOT EXISTS idx_tasks_completed ON tasks(completed)',
            'CREATE INDEX IF NOT EXISTS idx_reminders_reminder_time ON reminders(reminder_time)',
            'CREATE INDEX IF NOT EXISTS idx_reminders_sent ON reminders(sent)',
            'CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)',
            'CREATE INDEX IF NOT EXISTS idx_activity_user_id ON activity_log(user_id)',
            'CREATE INDEX IF NOT EXISTS idx_email_log_recipient ON email_log(recipient)',
            'CREATE INDEX IF NOT EXISTS idx_suggestions_user_id ON suggestions(user_id)',
            'CREATE INDEX IF NOT EXISTS idx_projects_user_id ON projects(user_id)',
            'CREATE INDEX IF NOT EXISTS idx_shared_schedules_user_email ON shared_schedules(user_email)',
            'CREATE INDEX IF NOT EXISTS idx_shared_schedules_token ON shared_schedules(share_token)'
        ];
        
        for (const query of indexQueries) {
            try {
                await client.query(query);
                consoleLog('SUCCESS', `Index created: ${query.split('ON')[1]?.trim() || query}`);
            } catch (err) {
                consoleLog('WARNING', `Index creation skipped: ${err.message}`);
            }
        }
        consoleLog('SUCCESS', 'All indexes created');
        
        // Fix any existing tasks with empty timestamps
        try {
            await client.query(`
                UPDATE tasks SET 
                    deadline = NULL WHERE deadline IS NULL OR deadline = '' OR deadline::text = 'null',
                    scheduled_start = NULL WHERE scheduled_start IS NULL OR scheduled_start = '' OR scheduled_start::text = 'null',
                    scheduled_end = NULL WHERE scheduled_end IS NULL OR scheduled_end = '' OR scheduled_end::text = 'null',
                    completed_at = NULL WHERE completed_at IS NULL OR completed_at = '' OR completed_at::text = 'null'
            `);
        } catch (err) {
            consoleLog('WARNING', 'Timestamp cleanup skipped:', err.message);
        }
        
        // Create demo user
        const demoEmail = 'demo@taskweaver.com';
        const existingDemo = await client.query('SELECT id FROM users WHERE email = $1', [demoEmail]);
        
        if (existingDemo.rows.length === 0) {
            const hashedPassword = await bcrypt.hash('Demo@2024', 10);
            await client.query(
                `INSERT INTO users (username, email, password, email_notifications, push_notifications, timezone, theme, email_verified, created_at) 
                 VALUES ($1, $2, $3, 1, 1, 'UTC', 'light', 1, NOW())`,
                ['DEMOUSER', demoEmail, hashedPassword]
            );
            consoleLog('SUCCESS', 'Demo user created: demo@taskweaver.com / Demo@2024');
        } else {
            consoleLog('INFO', 'Demo user already exists');
        }
        
        consoleLog('SUCCESS', 'Database initialization complete');
        
    } catch (err) {
        consoleLog('ERROR', 'Database initialization error:', err.message);
        throw err;
    } finally {
        client.release();
    }
}

// ============ HEALTH CHECK ============
app.get('/api/health', async (req, res) => {
    consoleLog('INFO', 'Health check requested');
    try {
        await pool.query('SELECT 1');
        res.json({ 
            status: 'healthy', 
            database: 'connected',
            email: transporter ? 'configured' : 'disabled',
            uptime: process.uptime(),
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        consoleLog('ERROR', 'Health check failed:', err.message);
        res.status(500).json({ 
            status: 'unhealthy', 
            database: 'disconnected',
            error: err.message
        });
    }
});

// ============ TEST EMAIL ENDPOINT ============
app.get('/api/test-email', async (req, res) => {
    consoleLog('INFO', '📧 Test email endpoint called');
    
    if (!transporter) {
        return res.json({ 
            success: false, 
            error: 'Email not configured',
            message: 'Email service is not configured. Check your EMAIL_USER and EMAIL_PASS'
        });
    }
    
    try {
        const testEmail = process.env.EMAIL_USER;
        await sendEmail(
            testEmail,
            'TaskWeaver Email Test',
            getEmailTemplate(
                'Email Test Successful! 🎉',
                `Your TaskWeaver email configuration is working perfectly!<br><br>
                <div class="info-box">
                    <strong>Test Details:</strong><br>
                    Environment: ${isRender ? 'Render (Production)' : 'Local (Development)'}<br>
                    Server Port: ${port}<br>
                    Email User: ${process.env.EMAIL_USER}<br>
                    Timestamp: ${new Date().toLocaleString()}
                </div>`
            )
        );
        
        res.json({ 
            success: true, 
            message: 'Test email sent successfully! Check your inbox.',
            details: {
                environment: isRender ? 'Render' : 'Local',
                port: port,
                emailTo: testEmail
            }
        });
    } catch (error) {
        consoleLog('ERROR', 'Test email failed:', error.message);
        res.json({ 
            success: false, 
            error: error.message
        });
    }
});

// ============ AUTHENTICATION ROUTES ============
app.post('/api/check-password-strength', (req, res) => {
    try {
        const strength = checkPasswordStrength(req.body.password);
        consoleLog('INFO', `Password strength check: ${strength.strength}`);
        res.json(strength);
    } catch (error) {
        consoleLog('ERROR', 'Password strength check error:', error.message);
        res.status(500).json({ error: 'Failed to check password' });
    }
});

app.post('/api/register', async (req, res) => {
    const { email, password } = req.body;
    consoleLog('INFO', `Registration attempt for email: ${email}`);
    
    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password required' });
    }
    
    const strength = checkPasswordStrength(password);
    if (strength.score < 3) {
        return res.status(400).json({ error: 'Password too weak. Use 8+ chars with uppercase, numbers, and special characters.' });
    }
    
    try {
        const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
        if (existing.rows.length > 0) {
            return res.status(400).json({ error: 'Email already registered' });
        }
        
        const username = await generateUsername(email);
        const hashedPassword = await bcrypt.hash(password, 10);
        const verificationToken = crypto.randomBytes(32).toString('hex');
        
        const result = await pool.query(
            `INSERT INTO users (username, email, password, last_login_ip, last_login_user_agent, verification_token, created_at, updated_at) 
             VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW()) RETURNING id`,
            [username, email, hashedPassword, req.ip, req.headers['user-agent'], verificationToken]
        );
        
        const userId = result.rows[0].id;
        consoleLog('SUCCESS', `New user registered: ${email} (ID: ${userId})`);
        
        if (transporter) {
            const verificationLink = `https://${req.get('host')}/api/verify-email?token=${verificationToken}`;
            const emailContent = getEmailTemplate(
                'Welcome to TaskWeaver! 🎉',
                `Hi ${username},<br><br>Thank you for joining TaskWeaver! We're excited to help you manage your tasks more efficiently.<br><br>
                Please verify your email address by clicking the button below.<br><br>
                <div class="info-box">
                    <strong>Your Account Details:</strong><br>
                    Email: ${email}<br>
                    Username: ${username}<br>
                </div>`,
                'Verify Email Address',
                verificationLink
            );
            
            sendEmail(email, '🎉 Welcome to TaskWeaver - Verify Your Email', emailContent)
                .then(() => logEmailSent(userId, email, email, 'Welcome Email', 'success'))
                .catch(err => logEmailSent(userId, email, email, 'Welcome Email', 'failed', err));
        }
        
        await logUserActivity(userId, email, 'REGISTER', 'User registered successfully', req);
        res.json({ success: true, username, email, message: 'Registration successful! Please check your email to verify your account.' });
        
    } catch (err) {
        consoleLog('ERROR', `Registration error for ${email}:`, err.message);
        res.status(500).json({ error: 'Registration failed' });
    }
});

app.get('/api/verify-email', async (req, res) => {
    const { token } = req.query;
    consoleLog('INFO', `Email verification attempt with token: ${token?.substring(0, 10)}...`);
    
    try {
        const result = await pool.query('UPDATE users SET email_verified = 1, verification_token = NULL WHERE verification_token = $1 RETURNING id, email', [token]);
        if (result.rows.length > 0) {
            consoleLog('SUCCESS', `Email verified: ${result.rows[0].email}`);
            await logUserActivity(result.rows[0].id, result.rows[0].email, 'VERIFY_EMAIL', 'Email verified', req);
            res.redirect('/login.html?verified=true');
        } else {
            consoleLog('WARNING', `Invalid verification token: ${token?.substring(0, 10)}...`);
            res.redirect('/login.html?error=invalid_token');
        }
    } catch (err) {
        consoleLog('ERROR', 'Email verification error:', err.message);
        res.redirect('/login.html?error=verification_failed');
    }
});

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    consoleLog('INFO', `Login attempt for email: ${email}`);
    
    try {
        const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        const user = result.rows[0];
        
        if (!user) {
            consoleLog('WARNING', `Login failed: User not found - ${email}`);
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        if (user.locked_until && new Date(user.locked_until) > new Date()) {
            consoleLog('WARNING', `Login failed: Account locked for ${email} until ${user.locked_until}`);
            return res.status(401).json({ error: 'Account is temporarily locked. Try again later.' });
        }
        
        const valid = await bcrypt.compare(password, user.password);
        if (!valid) {
            const attempts = (user.failed_login_attempts || 0) + 1;
            const locked = attempts >= 5 ? new Date(Date.now() + 15 * 60000) : null;
            await pool.query('UPDATE users SET failed_login_attempts = $1, last_failed_login = $2, locked_until = $3 WHERE id = $4', 
                [attempts, new Date().toISOString(), locked, user.id]);
            consoleLog('WARNING', `Login failed: Invalid password for ${email} (Attempt ${attempts}/5)`);
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        await pool.query(
            `UPDATE users SET failed_login_attempts = 0, locked_until = NULL, 
             last_login = CURRENT_TIMESTAMP, last_login_ip = $1, last_login_user_agent = $2,
             login_count = login_count + 1 WHERE id = $3`,
            [req.ip, req.headers['user-agent'], user.id]
        );
        
        req.session.userId = user.id;
        req.session.username = user.username;
        req.session.email = user.email;
        
        req.session.save((err) => {
            if (err) {
                consoleLog('ERROR', `Session save error for ${email}:`, err.message);
                return res.status(500).json({ error: 'Session error' });
            }
            
            consoleLog('SUCCESS', `User logged in: ${email} (ID: ${user.id})`);
            consoleLog('ACTIVITY', `Session created: ${req.sessionID}`);
            
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
    } catch (err) {
        consoleLog('ERROR', `Login error for ${email}:`, err.message);
        res.status(500).json({ error: 'Login failed' });
    }
});

app.get('/api/check-session', async (req, res) => {
    consoleLog('INFO', `Session check - ID: ${req.sessionID}`);
    
    if (req.session?.userId) {
        try {
            const result = await pool.query('SELECT email, username FROM users WHERE id = $1', [req.session.userId]);
            const user = result.rows[0];
            consoleLog('SUCCESS', `Valid session for user: ${user?.email}`);
            res.json({ 
                authenticated: true, 
                userId: req.session.userId,
                username: user?.username || req.session.username,
                email: user?.email || req.session.email
            });
        } catch (err) {
            consoleLog('ERROR', 'Session check database error:', err.message);
            res.json({ authenticated: true, username: req.session.username, email: req.session.email });
        }
    } else {
        consoleLog('INFO', 'No active session found');
        res.json({ authenticated: false });
    }
});

app.post('/api/logout', (req, res) => {
    if (req.session.userId) {
        consoleLog('ACTIVITY', `User logging out: ${req.session.email}`);
        logUserActivity(req.session.userId, req.session.email, 'LOGOUT', 'User logged out', req);
    }
    req.session.destroy((err) => {
        if (err) {
            consoleLog('ERROR', 'Logout error:', err.message);
            return res.status(500).json({ error: err.message });
        }
        consoleLog('SUCCESS', 'User logged out successfully');
        res.json({ success: true });
    });
});

app.post('/api/forgot-password', async (req, res) => {
    const { email } = req.body;
    consoleLog('INFO', `Password reset request for: ${email}`);
    
    try {
        const user = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
        if (user.rows.length === 0) {
            consoleLog('WARNING', `Password reset: Email not found - ${email}`);
            return res.status(404).json({ error: 'Email not found' });
        }
        
        const token = crypto.randomBytes(32).toString('hex');
        const expiry = new Date(Date.now() + 3600000);
        await pool.query('UPDATE users SET reset_token = $1, reset_token_expiry = $2 WHERE id = $3', [token, expiry, user.rows[0].id]);
        
        const resetLink = `https://${req.get('host')}/reset-password.html?token=${token}`;
        if (transporter) {
            const emailContent = getEmailTemplate(
                'Password Reset',
                'Click the button below to reset your password. This link expires in 1 hour.',
                'Reset Password',
                resetLink
            );
            sendEmail(email, 'Password Reset - TaskWeaver', emailContent)
                .then(() => logEmailSent(user.rows[0].id, email, email, 'Password Reset', 'success'))
                .catch(err => logEmailSent(user.rows[0].id, email, email, 'Password Reset', 'failed', err));
        }
        
        consoleLog('SUCCESS', `Password reset email sent to: ${email}`);
        res.json({ success: true, message: 'Password reset email sent' });
    } catch (err) {
        consoleLog('ERROR', `Password reset error for ${email}:`, err.message);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/reset-password', async (req, res) => {
    const { token, newPassword } = req.body;
    consoleLog('INFO', `Password reset attempt with token: ${token?.substring(0, 10)}...`);
    
    const strength = checkPasswordStrength(newPassword);
    if (strength.score < 3) {
        consoleLog('WARNING', 'Password reset: Weak password');
        return res.status(400).json({ error: 'Password too weak.' });
    }
    
    try {
        const user = await pool.query('SELECT id, email FROM users WHERE reset_token = $1 AND reset_token_expiry > NOW()', [token]);
        if (user.rows.length === 0) {
            consoleLog('WARNING', `Password reset: Invalid or expired token`);
            return res.status(400).json({ error: 'Invalid or expired token' });
        }
        
        const hashed = await bcrypt.hash(newPassword, 10);
        await pool.query('UPDATE users SET password = $1, reset_token = NULL, reset_token_expiry = NULL WHERE id = $2', [hashed, user.rows[0].id]);
        
        consoleLog('SUCCESS', `Password reset successful for: ${user.rows[0].email}`);
        await logUserActivity(user.rows[0].id, user.rows[0].email, 'PASSWORD_RESET', 'Password reset successfully', req);
        res.json({ success: true, message: 'Password reset successful' });
    } catch (err) {
        consoleLog('ERROR', 'Password reset error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

function requireAuth(req, res, next) {
    if (!req.session?.userId) {
        consoleLog('WARNING', `Unauthorized access attempt from ${req.ip}`);
        return res.status(401).json({ error: 'Authentication required' });
    }
    next();
}

// ============ DEBUG ENDPOINTS ============
app.get('/api/debug-tasks', requireAuth, async (req, res) => {
    try {
        consoleLog('INFO', `Debug tasks for user: ${req.session.email}`);
        
        const tasksByUserId = await pool.query(`
            SELECT id, title, user_id, user_email, created_at, deleted_at, completed, scheduled_start, deadline
            FROM tasks 
            WHERE user_id = $1
            ORDER BY id DESC
            LIMIT 20
        `, [req.session.userId]);
        
        res.json({
            sessionInfo: {
                userId: req.session.userId,
                email: req.session.email,
                username: req.session.username
            },
            tasks: tasksByUserId.rows,
            count: tasksByUserId.rows.length
        });
        
    } catch (error) {
        consoleLog('ERROR', 'Debug tasks error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/debug-schema', async (req, res) => {
    try {
        const tables = await pool.query(`
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public'
            ORDER BY table_name
        `);
        
        const tasksColumns = await pool.query(`
            SELECT column_name, data_type, is_nullable
            FROM information_schema.columns 
            WHERE table_name = 'tasks'
            ORDER BY ordinal_position
        `);
        
        res.json({
            tables: tables.rows.map(t => t.table_name),
            tasksColumns: tasksColumns.rows,
            message: 'Database schema info'
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/create-test-task', requireAuth, async (req, res) => {
    try {
        const testTitle = `Test Task ${new Date().toLocaleTimeString()}`;
        
        const result = await pool.query(`
            INSERT INTO tasks (user_id, user_email, title, description, severity, priority, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
            RETURNING *
        `, [req.session.userId, req.session.email, testTitle, 'This is a test task created to verify task creation is working', 'Medium', 2]);
        
        consoleLog('SUCCESS', `Test task created: ${testTitle} for user ${req.session.email}`);
        
        res.json({
            success: true,
            message: 'Test task created',
            task: result.rows[0]
        });
    } catch (error) {
        consoleLog('ERROR', 'Create test task error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// ============ USER SETTINGS ============
app.get('/api/settings', requireAuth, async (req, res) => {
    consoleLog('INFO', `Loading settings for user: ${req.session.email}`);
    try {
        const result = await pool.query(
            'SELECT reminder_interval, auto_reminders, email_notifications, push_notifications, timezone, theme FROM users WHERE id = $1',
            [req.session.userId]
        );
        const user = result.rows[0];
        res.json({ 
            reminder_interval: user?.reminder_interval || 20,
            auto_reminders: user?.auto_reminders === 1,
            email_notifications: user?.email_notifications === 1,
            push_notifications: user?.push_notifications === 1,
            timezone: user?.timezone || 'UTC',
            theme: user?.theme || 'light'
        });
    } catch (err) {
        consoleLog('ERROR', `Failed to load settings for ${req.session.email}:`, err.message);
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/settings', requireAuth, async (req, res) => {
    const { reminder_interval, auto_reminders, email_notifications, push_notifications, timezone, theme } = req.body;
    consoleLog('INFO', `Updating settings for user: ${req.session.email}`);
    
    try {
        await pool.query(
            `UPDATE users SET reminder_interval = COALESCE($1, reminder_interval), auto_reminders = COALESCE($2, auto_reminders),
             email_notifications = COALESCE($3, email_notifications), push_notifications = COALESCE($4, push_notifications),
             timezone = COALESCE($5, timezone), theme = COALESCE($6, theme), updated_at = NOW()
             WHERE id = $7`,
            [reminder_interval, auto_reminders ? 1 : 0, email_notifications ? 1 : 0, push_notifications ? 1 : 0, timezone, theme, req.session.userId]
        );
        consoleLog('SUCCESS', `Settings updated for ${req.session.email}`);
        await logUserActivity(req.session.userId, req.session.email, 'SETTINGS_UPDATED', 'Settings updated', req);
        res.json({ success: true });
    } catch (err) {
        consoleLog('ERROR', `Failed to update settings for ${req.session.email}:`, err.message);
        res.status(500).json({ error: err.message });
    }
});

// ============ TASK ROUTES ============
app.get('/api/tasks', requireAuth, async (req, res) => {
    consoleLog('INFO', `Loading tasks for user: ${req.session.email}`);
    try {
        const result = await pool.query(`
            SELECT 
                id, user_id, user_email, title, description, project, category, 
                severity, priority, deadline, scheduled_start, scheduled_end, 
                completed, completed_at, tags, is_recurring, recurrence_pattern,
                created_at, updated_at
            FROM tasks 
            WHERE user_id = $1 
            AND (deleted_at IS NULL)
            ORDER BY 
                CASE severity 
                    WHEN 'Critical' THEN 1 
                    WHEN 'High' THEN 2 
                    WHEN 'Medium' THEN 3 
                    WHEN 'Low' THEN 4 
                    ELSE 5 
                END,
                deadline ASC NULLS LAST, 
                scheduled_start ASC NULLS LAST
        `, [req.session.userId]);
        
        const formattedTasks = result.rows.map(task => ({
            ...task,
            deadline: formatTimestampForResponse(task.deadline),
            scheduled_start: formatTimestampForResponse(task.scheduled_start),
            scheduled_end: formatTimestampForResponse(task.scheduled_end),
            completed_at: formatTimestampForResponse(task.completed_at),
            created_at: formatTimestampForResponse(task.created_at),
            updated_at: formatTimestampForResponse(task.updated_at)
        }));
        
        consoleLog('SUCCESS', `Loaded ${formattedTasks.length} tasks for ${req.session.email}`);
        res.json(formattedTasks);
    } catch (err) {
        consoleLog('ERROR', `Failed to load tasks:`, err.message);
        res.json([]);
    }
});

app.get('/api/unscheduled-tasks', requireAuth, async (req, res) => {
    consoleLog('INFO', `Loading unscheduled tasks for user: ${req.session.email}`);
    try {
        const result = await pool.query(
            `SELECT * FROM tasks WHERE user_id = $1 AND (scheduled_start IS NULL) 
             AND completed = 0 AND deleted_at IS NULL
             ORDER BY CASE severity WHEN 'Critical' THEN 1 WHEN 'High' THEN 2 WHEN 'Medium' THEN 3 WHEN 'Low' THEN 4 END,
             deadline ASC NULLS LAST`,
            [req.session.userId]
        );
        res.json(result.rows);
    } catch (err) {
        consoleLog('ERROR', `Failed to load unscheduled tasks:`, err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/upcoming-deadlines', requireAuth, async (req, res) => {
    consoleLog('INFO', `Loading upcoming deadlines for user: ${req.session.email}`);
    try {
        const result = await pool.query(
            `SELECT * FROM tasks WHERE user_id = $1 AND completed = 0 AND deadline IS NOT NULL 
             AND deadline >= NOW() ORDER BY deadline ASC LIMIT 10`,
            [req.session.userId]
        );
        res.json(result.rows);
    } catch (err) {
        consoleLog('ERROR', `Failed to load upcoming deadlines:`, err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/overdue-tasks', requireAuth, async (req, res) => {
    consoleLog('INFO', `Loading overdue tasks for user: ${req.session.email}`);
    try {
        const result = await pool.query(
            `SELECT * FROM tasks WHERE user_id = $1 AND completed = 0 AND deadline IS NOT NULL 
             AND deadline < NOW() ORDER BY deadline ASC`,
            [req.session.userId]
        );
        res.json(result.rows);
    } catch (err) {
        consoleLog('ERROR', `Failed to load overdue tasks:`, err.message);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/tasks', requireAuth, async (req, res) => {
    const { title, description, project, category, severity, priority, deadline, is_recurring, recurrence_pattern, scheduled_start, scheduled_end, estimated_duration, tags } = req.body;
    
    consoleLog('INFO', `Creating task for user: ${req.session.email} - Title: ${title}`);
    
    if (!title) {
        return res.status(400).json({ error: 'Task title is required' });
    }
    
    try {
        const safeDeadline = safeTimestamp(deadline);
        const safeScheduledStart = safeTimestamp(scheduled_start);
        const safeScheduledEnd = safeTimestamp(scheduled_end);
        
        const result = await pool.query(`
            INSERT INTO tasks (
                user_id, user_email, title, description, project, category, 
                severity, priority, deadline, is_recurring, recurrence_pattern, 
                scheduled_start, scheduled_end, estimated_duration, tags,
                created_at, updated_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW(), NOW())
            RETURNING id
        `, [
            req.session.userId, req.session.email, title, description || null, 
            project || null, category || null, severity || 'Medium', priority || 2,
            safeDeadline, is_recurring ? 1 : 0, recurrence_pattern || null,
            safeScheduledStart, safeScheduledEnd, estimated_duration || null, tags || null
        ]);
        
        const taskId = result.rows[0].id;
        
        // Create reminder if scheduled
        if (safeScheduledStart) {
            try {
                const reminderTime = new Date(new Date(safeScheduledStart).getTime() - 20 * 60 * 1000);
                await pool.query(`
                    INSERT INTO reminders (user_id, user_email, task_id, reminder_time, reminder_type, created_at) 
                    VALUES ($1, $2, $3, $4, 'scheduled', NOW())
                `, [req.session.userId, req.session.email, taskId, reminderTime.toISOString()]);
                consoleLog('INFO', `Reminder created for task ${taskId} at ${reminderTime}`);
            } catch (reminderErr) {
                consoleLog('WARNING', 'Could not create reminder:', reminderErr.message);
            }
        }
        
        consoleLog('SUCCESS', `Task created for ${req.session.email}: ${title} (ID: ${taskId})`);
        await logUserActivity(req.session.userId, req.session.email, 'TASK_CREATED', `Task: ${title}`, req);
        res.json({ id: taskId, message: 'Task created successfully' });
        
    } catch (err) {
        consoleLog('ERROR', `Failed to create task:`, err.message);
        res.status(500).json({ error: err.message || 'Failed to create task' });
    }
});

app.put('/api/tasks/:id', requireAuth, async (req, res) => {
    const taskId = req.params.id;
    consoleLog('INFO', `Updating task ${taskId} for user: ${req.session.email}`);
    
    const { title, description, project, category, severity, priority, deadline, scheduled_start, scheduled_end, completed, actual_start, actual_end, completion_notes, tags } = req.body;
    
    const updates = [];
    const values = [];
    let paramCounter = 1;
    
    if (title !== undefined) { updates.push(`title = $${paramCounter++}`); values.push(title); }
    if (description !== undefined) { updates.push(`description = $${paramCounter++}`); values.push(description); }
    if (project !== undefined) { updates.push(`project = $${paramCounter++}`); values.push(project); }
    if (category !== undefined) { updates.push(`category = $${paramCounter++}`); values.push(category); }
    if (severity !== undefined) { updates.push(`severity = $${paramCounter++}`); values.push(severity); }
    if (priority !== undefined) { updates.push(`priority = $${paramCounter++}`); values.push(priority); }
    if (tags !== undefined) { updates.push(`tags = $${paramCounter++}`); values.push(tags); }
    if (deadline !== undefined) { updates.push(`deadline = $${paramCounter++}`); values.push(safeTimestamp(deadline)); }
    if (scheduled_start !== undefined) { updates.push(`scheduled_start = $${paramCounter++}`); values.push(safeTimestamp(scheduled_start)); }
    if (scheduled_end !== undefined) { updates.push(`scheduled_end = $${paramCounter++}`); values.push(safeTimestamp(scheduled_end)); }
    if (actual_start !== undefined) { updates.push(`actual_start = $${paramCounter++}`); values.push(safeTimestamp(actual_start)); }
    if (actual_end !== undefined) { updates.push(`actual_end = $${paramCounter++}`); values.push(safeTimestamp(actual_end)); }
    if (completion_notes !== undefined) { updates.push(`completion_notes = $${paramCounter++}`); values.push(completion_notes); }
    
    if (completed !== undefined) { 
        updates.push(`completed = $${paramCounter++}`); 
        values.push(completed ? 1 : 0);
        if (completed) updates.push(`completed_at = NOW()`);
        else updates.push(`completed_at = NULL`);
        updates.push(`updated_at = NOW()`);
    }
    
    if (updates.length === 0) return res.status(400).json({ error: 'No updates provided' });
    
    values.push(taskId, req.session.userId);
    const query = `UPDATE tasks SET ${updates.join(', ')} WHERE id = $${paramCounter++} AND user_id = $${paramCounter}`;
    
    try {
        const result = await pool.query(query, values);
        consoleLog('SUCCESS', `Task ${taskId} updated for ${req.session.email}`);
        await logUserActivity(req.session.userId, req.session.email, 'TASK_UPDATED', `Task ID: ${taskId}`, req);
        res.json({ updated: result.rowCount });
    } catch (err) {
        consoleLog('ERROR', `Failed to update task ${taskId}:`, err.message);
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/tasks/:id', requireAuth, async (req, res) => {
    const taskId = req.params.id;
    consoleLog('INFO', `Deleting task ${taskId} for user: ${req.session.email}`);
    
    try {
        const taskResult = await pool.query('SELECT title FROM tasks WHERE id = $1 AND user_id = $2', [taskId, req.session.userId]);
        const result = await pool.query('DELETE FROM tasks WHERE id = $1 AND user_id = $2', [taskId, req.session.userId]);
        
        if (taskResult.rows[0]) {
            consoleLog('SUCCESS', `Task deleted: ${taskResult.rows[0].title} (ID: ${taskId})`);
            await logUserActivity(req.session.userId, req.session.email, 'TASK_DELETED', `Task: ${taskResult.rows[0].title}`, req);
        }
        res.json({ deleted: result.rowCount });
    } catch (err) {
        consoleLog('ERROR', `Failed to delete task ${taskId}:`, err.message);
        res.status(500).json({ error: err.message });
    }
});

// ============ PROJECTS ============
app.get('/api/projects', requireAuth, async (req, res) => {
    consoleLog('INFO', `Loading projects for user: ${req.session.email}`);
    try {
        const result = await pool.query('SELECT * FROM projects WHERE user_id = $1 ORDER BY created_at DESC', [req.session.userId]);
        if (result.rows.length === 0) {
            res.json([
                { name: 'FHC Portal', status: 'active', progress: 65, color: '#6B46C1', description: 'Full-stack web portal' },
                { name: 'Customer Repair App', status: 'active', progress: 40, color: '#48BB78', description: 'Mobile repair tracking' },
                { name: 'Paint Tracks', status: 'active', progress: 80, color: '#F6AD55', description: 'Project management tool' }
            ]);
        } else {
            res.json(result.rows);
        }
    } catch (err) {
        consoleLog('ERROR', `Failed to load projects:`, err.message);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/projects', requireAuth, async (req, res) => {
    const { name, description, color, status, progress, start_date, end_date } = req.body;
    consoleLog('INFO', `Creating project for user: ${req.session.email} - Name: ${name}`);
    
    if (!name) return res.status(400).json({ error: 'Project name required' });
    
    try {
        const result = await pool.query(
            `INSERT INTO projects (user_id, user_email, name, description, color, status, progress, start_date, end_date, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW()) RETURNING id`,
            [req.session.userId, req.session.email, name, description, color, status || 'active', progress || 0, safeTimestamp(start_date), safeTimestamp(end_date)]
        );
        consoleLog('SUCCESS', `Project created: ${name} for ${req.session.email}`);
        await logUserActivity(req.session.userId, req.session.email, 'PROJECT_CREATED', `Project: ${name}`, req);
        res.json({ id: result.rows[0].id, message: 'Project created' });
    } catch (err) {
        consoleLog('ERROR', `Failed to create project:`, err.message);
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/projects/:id', requireAuth, async (req, res) => {
    const projectId = req.params.id;
    consoleLog('INFO', `Updating project ${projectId} for user: ${req.session.email}`);
    
    const { name, description, color, status, progress, start_date, end_date } = req.body;
    try {
        await pool.query(
            `UPDATE projects SET name = COALESCE($1, name), description = COALESCE($2, description), color = COALESCE($3, color),
             status = COALESCE($4, status), progress = COALESCE($5, progress), start_date = COALESCE($6, start_date),
             end_date = COALESCE($7, end_date), updated_at = NOW() WHERE id = $8 AND user_id = $9`,
            [name, description, color, status, progress, safeTimestamp(start_date), safeTimestamp(end_date), projectId, req.session.userId]
        );
        consoleLog('SUCCESS', `Project ${projectId} updated for ${req.session.email}`);
        await logUserActivity(req.session.userId, req.session.email, 'PROJECT_UPDATED', `Project ID: ${projectId}`, req);
        res.json({ success: true });
    } catch (err) {
        consoleLog('ERROR', `Failed to update project:`, err.message);
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/projects/:id', requireAuth, async (req, res) => {
    const projectId = req.params.id;
    consoleLog('INFO', `Deleting project ${projectId} for user: ${req.session.email}`);
    
    try {
        await pool.query('DELETE FROM projects WHERE id = $1 AND user_id = $2', [projectId, req.session.userId]);
        consoleLog('SUCCESS', `Project ${projectId} deleted for ${req.session.email}`);
        await logUserActivity(req.session.userId, req.session.email, 'PROJECT_DELETED', `Project ID: ${projectId}`, req);
        res.json({ success: true });
    } catch (err) {
        consoleLog('ERROR', `Failed to delete project:`, err.message);
        res.status(500).json({ error: err.message });
    }
});

// ============ SUGGESTIONS ============
app.get('/api/suggestions', requireAuth, async (req, res) => {
    consoleLog('INFO', `Loading suggestions for user: ${req.session.email}`);
    try {
        const suggestions = await pool.query(
            'SELECT * FROM suggestions WHERE user_id = $1 AND is_read = 0 ORDER BY priority DESC, created_at ASC LIMIT 10',
            [req.session.userId]
        );
        
        if (suggestions.rows.length === 0) {
            const tasks = await pool.query(
                `SELECT * FROM tasks WHERE user_id = $1 AND completed = 0 AND scheduled_start IS NULL 
                 ORDER BY CASE severity WHEN 'Critical' THEN 1 WHEN 'High' THEN 2 WHEN 'Medium' THEN 3 WHEN 'Low' THEN 4 END, 
                 deadline ASC LIMIT 5`,
                [req.session.userId]
            );
            const suggestionTexts = [];
            const now = new Date();
            tasks.rows.forEach(task => {
                if (task.severity === 'Critical' && task.deadline) {
                    const hoursLeft = (new Date(task.deadline) - now) / (1000 * 3600);
                    if (hoursLeft < 24) {
                        suggestionTexts.push(`⚠️ CRITICAL: "${task.title}" is due in less than ${Math.ceil(hoursLeft)} hours! Schedule it immediately.`);
                    }
                }
            });
            if (suggestionTexts.length === 0) {
                suggestionTexts.push("✨ Great job! All tasks are scheduled. Consider planning some personal development time.");
                suggestionTexts.push("💡 Tip: Use the Focus Timer for 25-minute productivity sprints.");
                suggestionTexts.push("📊 Check your statistics to see your productivity trends!");
                suggestionTexts.push("🔔 Don't forget to configure your email notification settings.");
            }
            res.json(suggestionTexts.slice(0, 5));
        } else {
            res.json(suggestions.rows.map(s => s.suggestion));
        }
    } catch (err) {
        consoleLog('ERROR', `Failed to load suggestions:`, err.message);
        res.status(500).json({ error: err.message });
    }
});

// ============ SHARING AND EXPORT ============
app.post('/api/share-schedule', requireAuth, async (req, res) => {
    const { shareWithEmail, shareType = 'view' } = req.body;
    const userEmail = req.session.email;
    const userId = req.session.userId;
    
    consoleLog('INFO', `Sharing schedule from ${userEmail} to ${shareWithEmail}`);
    
    if (!shareWithEmail) {
        return res.status(400).json({ error: 'Recipient email is required' });
    }
    
    try {
        const recipientResult = await pool.query('SELECT id, email FROM users WHERE email = $1', [shareWithEmail]);
        if (recipientResult.rows.length === 0) {
            consoleLog('WARNING', `Share failed: Recipient not found - ${shareWithEmail}`);
            return res.status(404).json({ error: 'Recipient email not found in TaskWeaver' });
        }
        
        const recipient = recipientResult.rows[0];
        const shareToken = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        
        await pool.query(
            `INSERT INTO shared_schedules (user_id, user_email, share_with_email, share_token, share_type, expires_at, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
            [userId, userEmail, shareWithEmail, shareToken, shareType, expiresAt.toISOString()]
        );
        
        const tasksResult = await pool.query(
            `SELECT * FROM tasks WHERE user_id = $1 AND completed = 0 AND deleted_at IS NULL 
             ORDER BY scheduled_start ASC, deadline ASC`,
            [userId]
        );
        const tasks = tasksResult.rows;
        
        const shareLink = `https://${req.get('host')}/api/view-shared-schedule?token=${shareToken}`;
        
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
            You can view the schedule online using the link below.`,
            'View Schedule Online',
            shareLink
        );
        
        if (transporter) {
            sendEmail(shareWithEmail, `📅 Schedule Shared with You - TaskWeaver`, emailContent)
                .then(() => logEmailSent(userId, userEmail, shareWithEmail, 'Schedule Shared', 'success'))
                .catch(err => logEmailSent(userId, userEmail, shareWithEmail, 'Schedule Shared', 'failed', err));
        }
        
        res.json({ success: true, message: `Schedule shared with ${shareWithEmail}` });
    } catch (err) {
        consoleLog('ERROR', `Share schedule error:`, err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/view-shared-schedule', async (req, res) => {
    const { token, format = 'json' } = req.query;
    consoleLog('INFO', `Viewing shared schedule with token: ${token?.substring(0, 10)}...`);
    
    try {
        const shareResult = await pool.query(
            'SELECT * FROM shared_schedules WHERE share_token = $1 AND expires_at > NOW()',
            [token]
        );
        const share = shareResult.rows[0];
        
        if (!share) {
            consoleLog('WARNING', `Invalid or expired share token: ${token?.substring(0, 10)}...`);
            return res.status(404).json({ error: 'Invalid or expired share link' });
        }
        
        const tasksResult = await pool.query(
            `SELECT * FROM tasks WHERE user_id = $1 AND completed = 0 AND deleted_at IS NULL 
             ORDER BY scheduled_start ASC, deadline ASC`,
            [share.user_id]
        );
        const tasks = tasksResult.rows;
        
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
    } catch (err) {
        consoleLog('ERROR', `View shared schedule error:`, err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/export-schedule', requireAuth, async (req, res) => {
    const { format = 'json' } = req.query;
    const userId = req.session.userId;
    const userEmail = req.session.email;
    
    consoleLog('INFO', `Exporting schedule for ${userEmail} as ${format}`);
    
    try {
        const result = await pool.query(
            `SELECT * FROM tasks WHERE user_id = $1 AND completed = 0 AND deleted_at IS NULL 
             ORDER BY scheduled_start ASC, deadline ASC`,
            [userId]
        );
        const tasks = result.rows;
        
        await logUserActivity(userId, userEmail, 'EXPORT_SCHEDULE', `Exported schedule as ${format}`, req);
        
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
    } catch (err) {
        consoleLog('ERROR', `Export schedule error:`, err.message);
        res.status(500).json({ error: err.message });
    }
});

// ============ STATISTICS ============
app.get('/api/user-stats', requireAuth, async (req, res) => {
    consoleLog('INFO', `Loading stats for user: ${req.session.email}`);
    try {
        const result = await pool.query(`
            SELECT 
                COUNT(CASE WHEN completed = 1 THEN 1 END) as completed_tasks,
                COUNT(CASE WHEN completed = 0 AND scheduled_start IS NOT NULL THEN 1 END) as scheduled_tasks,
                COUNT(CASE WHEN completed = 0 AND scheduled_start IS NULL THEN 1 END) as unscheduled_tasks,
                COUNT(CASE WHEN severity = 'Critical' AND completed = 0 THEN 1 END) as critical_tasks,
                COUNT(CASE WHEN severity = 'High' AND completed = 0 THEN 1 END) as high_priority_tasks,
                COUNT(CASE WHEN deadline < CURRENT_TIMESTAMP AND completed = 0 THEN 1 END) as overdue_tasks,
                COUNT(CASE WHEN created_at > NOW() - INTERVAL '7 days' THEN 1 END) as tasks_this_week
            FROM tasks 
            WHERE user_id = $1 AND deleted_at IS NULL
        `, [req.session.userId]);
        
        const stats = result.rows[0] || {
            completed_tasks: 0,
            scheduled_tasks: 0,
            unscheduled_tasks: 0,
            critical_tasks: 0,
            high_priority_tasks: 0,
            overdue_tasks: 0,
            tasks_this_week: 0
        };
        
        res.json(stats);
    } catch (err) {
        consoleLog('ERROR', `Failed to load stats:`, err.message);
        res.json({
            completed_tasks: 0,
            scheduled_tasks: 0,
            unscheduled_tasks: 0,
            critical_tasks: 0,
            high_priority_tasks: 0,
            overdue_tasks: 0,
            tasks_this_week: 0
        });
    }
});

app.get('/api/activity', requireAuth, async (req, res) => {
    consoleLog('INFO', `Loading activity log for user: ${req.session.email}`);
    try {
        const result = await pool.query(
            'SELECT * FROM activity_log WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50',
            [req.session.userId]
        );
        res.json(result.rows || []);
    } catch (err) {
        consoleLog('ERROR', `Failed to load activity:`, err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/debug', async (req, res) => {
    consoleLog('INFO', 'Debug endpoint called');
    try {
        const users = await pool.query('SELECT COUNT(*) FROM users');
        const tasks = await pool.query('SELECT COUNT(*) FROM tasks');
        const projects = await pool.query('SELECT COUNT(*) FROM projects');
        res.json({
            status: 'ok',
            database: 'connected',
            email: transporter ? 'configured' : 'disabled',
            userCount: parseInt(users.rows[0].count),
            taskCount: parseInt(tasks.rows[0].count),
            projectCount: parseInt(projects.rows[0].count),
            environment: process.env.NODE_ENV,
            port: port,
            nodeVersion: process.version
        });
    } catch (error) {
        consoleLog('ERROR', 'Debug endpoint error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// ============ REMINDER SYSTEM ============
async function checkScheduledReminders() {
    if (!dbConnected || !transporter) return;
    
    try {
        const result = await pool.query(`
            SELECT r.*, t.title, t.description, t.user_id, t.user_email, u.email_notifications
            FROM reminders r
            JOIN tasks t ON r.task_id = t.id
            JOIN users u ON r.user_id = u.id
            WHERE r.reminder_time <= NOW()
            AND r.sent = 0
            AND u.email_notifications = 1
            AND t.completed = 0
            AND t.deleted_at IS NULL
        `);
        
        const reminders = result.rows;
        if (reminders.length > 0) {
            consoleLog('INFO', `Found ${reminders.length} reminders to process`);
        }
        
        for (const reminder of reminders) {
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
            
            sendEmail(reminder.user_email, `🔔 Task Reminder: ${reminder.title}`, emailContent)
                .then(async () => {
                    await pool.query('UPDATE reminders SET sent = 1, sent_at = NOW() WHERE id = $1', [reminder.id]);
                    await logEmailSent(reminder.user_id, reminder.user_email, reminder.user_email, `Reminder: ${reminder.title}`, 'success');
                    await pool.query('UPDATE tasks SET reminder_count = reminder_count + 1, last_reminder_sent = NOW() WHERE id = $1', [reminder.task_id]);
                    consoleLog('SUCCESS', `Reminder sent to ${reminder.user_email}: ${reminder.title}`);
                })
                .catch(async (error) => {
                    await logEmailSent(reminder.user_id, reminder.user_email, reminder.user_email, `Reminder: ${reminder.title}`, 'failed', error);
                    await pool.query('UPDATE reminders SET retry_count = retry_count + 1, last_error = $1 WHERE id = $2', [error.message, reminder.id]);
                    consoleLog('ERROR', `Failed to send reminder for ${reminder.title}:`, error.message);
                });
        }
    } catch (err) {
        consoleLog('ERROR', 'Error checking reminders:', err.message);
    }
}

async function checkDeadlineReminders() {
    if (!dbConnected || !transporter) return;
    
    try {
        const result = await pool.query(`
            SELECT t.*, u.email as user_email, u.email_notifications
            FROM tasks t
            JOIN users u ON t.user_id = u.id
            WHERE t.completed = 0 
            AND t.deadline IS NOT NULL
            AND t.deadline_reminder_sent = 0
            AND u.email_notifications = 1
            AND EXTRACT(EPOCH FROM (t.deadline - NOW())) / 3600 <= 24
            AND t.deadline > NOW()
        `);
        
        for (const task of result.rows) {
            const deadline = new Date(task.deadline);
            const hoursLeft = Math.ceil((deadline - new Date()) / (1000 * 3600));
            const emailContent = getEmailTemplate(
                `⚠️ Deadline Approaching: ${task.title}`,
                `<div class="info-box" style="border-left-color: #f56565;">
                    <strong>Urgent Task Reminder</strong><br>
                    Title: ${task.title}<br>
                    Deadline: ${deadline.toLocaleString()}<br>
                    Time Remaining: ${hoursLeft} hours<br>
                    Priority: ${task.severity}<br>
                    ${task.project ? `Project: ${task.project}<br>` : ''}
                </div>
                <hr>
                <p>Don't forget to complete this task before the deadline! 🚀</p>`
            );
            
            sendEmail(task.user_email, `⚠️ DEADLINE APPROACHING: ${task.title}`, emailContent)
                .then(async () => {
                    await pool.query('UPDATE tasks SET deadline_reminder_sent = 1 WHERE id = $1', [task.id]);
                    await logEmailSent(task.user_id, task.user_email, task.user_email, `Deadline: ${task.title}`, 'success');
                    consoleLog('SUCCESS', `Deadline reminder sent to ${task.user_email}: ${task.title} due in ${hoursLeft}h`);
                })
                .catch(async (error) => {
                    await logEmailSent(task.user_id, task.user_email, task.user_email, `Deadline: ${task.title}`, 'failed', error);
                    consoleLog('ERROR', `Failed to send deadline reminder for ${task.title}:`, error.message);
                });
        }
    } catch (err) {
        consoleLog('ERROR', 'Error checking deadline reminders:', err.message);
    }
}

async function checkOverdueTasks() {
    if (!dbConnected || !transporter) return;
    
    try {
        const result = await pool.query(`
            SELECT t.*, u.email as user_email, u.email_notifications
            FROM tasks t
            JOIN users u ON t.user_id = u.id
            WHERE t.completed = 0 
            AND t.deadline IS NOT NULL
            AND t.deadline < NOW()
            AND t.overdue_reminder_sent = 0
            AND u.email_notifications = 1
        `);
        
        for (const task of result.rows) {
            const deadline = new Date(task.deadline);
            const daysOverdue = Math.floor((new Date() - deadline) / (1000 * 3600 * 24));
            const emailContent = getEmailTemplate(
                `⚠️ OVERDUE TASK: ${task.title}`,
                `<div class="info-box" style="border-left-color: #f56565;">
                    <strong>Overdue Task Alert</strong><br>
                    Title: ${task.title}<br>
                    Original Deadline: ${deadline.toLocaleString()}<br>
                    Days Overdue: ${daysOverdue}<br>
                    Priority: ${task.severity}<br>
                    ${task.project ? `Project: ${task.project}<br>` : ''}
                </div>
                <hr>
                <p>Please address this overdue task as soon as possible! ⚠️</p>`
            );
            
            sendEmail(task.user_email, `⚠️ OVERDUE TASK: ${task.title}`, emailContent)
                .then(async () => {
                    await pool.query('UPDATE tasks SET overdue_reminder_sent = 1 WHERE id = $1', [task.id]);
                    await logEmailSent(task.user_id, task.user_email, task.user_email, `Overdue: ${task.title}`, 'success');
                    consoleLog('SUCCESS', `Overdue alert sent to ${task.user_email}: ${task.title} overdue by ${daysOverdue}d`);
                })
                .catch(async (error) => {
                    await logEmailSent(task.user_id, task.user_email, task.user_email, `Overdue: ${task.title}`, 'failed', error);
                    consoleLog('ERROR', `Failed to send overdue alert for ${task.title}:`, error.message);
                });
        }
    } catch (err) {
        consoleLog('ERROR', 'Error checking overdue tasks:', err.message);
    }
}

// Schedule reminders
cron.schedule('* * * * *', () => { 
    checkScheduledReminders().catch(err => consoleLog('ERROR', 'Scheduled reminder cron error:', err.message));
});

cron.schedule('*/30 * * * *', () => { 
    checkDeadlineReminders().catch(err => consoleLog('ERROR', 'Deadline reminder cron error:', err.message));
    checkOverdueTasks().catch(err => consoleLog('ERROR', 'Overdue tasks cron error:', err.message));
});

// ============ ERROR HANDLING ============
app.use((err, req, res, next) => {
    consoleLog('ERROR', 'Unhandled error:', err.message);
    logToFile(errorLogStream, 'ERROR', 'Unhandled error', err);
    res.status(500).json({ error: 'Internal server error' });
});

app.use((req, res) => {
    consoleLog('WARNING', `404 - Route not found: ${req.method} ${req.url}`);
    res.status(404).json({ error: 'Not found' });
});

// ============ SERVER STARTUP ============
async function startServer() {
    try {
        consoleLog('INFO', 'Starting TaskWeaver server...');
        
        await initializeDatabase();
        setupEmailTransporter();
        
        app.listen(port, '0.0.0.0', () => {
            consoleLog('SUCCESS', `\n╔══════════════════════════════════════════════════════════════╗`);
            consoleLog('SUCCESS', `║                    🚀 TASKWEAVER SERVER 🚀                      ║`);
            consoleLog('SUCCESS', `╠══════════════════════════════════════════════════════════════╣`);
            consoleLog('SUCCESS', `║  Port: ${port.toString().padEnd(55)}║`);
            consoleLog('SUCCESS', `║  Database: ${dbConnected ? '✓ CONNECTED'.padEnd(52) : '✗ DISCONNECTED'.padEnd(52)}║`);
            consoleLog('SUCCESS', `║  Email: ${transporter ? '✓ CONNECTED & READY'.padEnd(52) : '✗ NOT CONFIGURED'.padEnd(52)}║`);
            if (transporter) {
                consoleLog('SUCCESS', `║    └─ Using: ${process.env.EMAIL_USER.padEnd(52)}║`);
            }
            consoleLog('SUCCESS', `╠══════════════════════════════════════════════════════════════╣`);
            consoleLog('SUCCESS', `║  Features Active:                                            ║`);
            consoleLog('SUCCESS', `║    ✓ Task Management (CRUD)                                   ║`);
            consoleLog('SUCCESS', `║    ✓ Project Management                                      ║`);
            consoleLog('SUCCESS', `║    ✓ Reminder System (every minute)                          ║`);
            consoleLog('SUCCESS', `║    ✓ Schedule Sharing (PDF/Excel/CSV)                        ║`);
            consoleLog('SUCCESS', `║    ✓ Email Notifications ${transporter ? '✓ ENABLED'.padEnd(41) : '✗ DISABLED'.padEnd(41)}║`);
            consoleLog('SUCCESS', `║    ✓ Activity Logging                                        ║`);
            consoleLog('SUCCESS', `║    ✓ Password Strength Checker                               ║`);
            consoleLog('SUCCESS', `║    ✓ Session Management                                      ║`);
            consoleLog('SUCCESS', `╠══════════════════════════════════════════════════════════════╣`);
            consoleLog('SUCCESS', `║  Demo Login:                                                 ║`);
            consoleLog('SUCCESS', `║    📧 demo@taskweaver.com                                    ║`);
            consoleLog('SUCCESS', `║    🔑 Demo@2024                                               ║`);
            consoleLog('SUCCESS', `╠══════════════════════════════════════════════════════════════╣`);
            consoleLog('SUCCESS', `║  Health: http://localhost:${port}/api/health${' '.repeat(47 - port.toString().length)}║`);
            consoleLog('SUCCESS', `║  Debug:  http://localhost:${port}/api/debug${' '.repeat(48 - port.toString().length)}║`);
            consoleLog('SUCCESS', `║  Test Email: http://localhost:${port}/api/test-email${' '.repeat(44 - port.toString().length)}║`);
            consoleLog('SUCCESS', `╚══════════════════════════════════════════════════════════════╝\n`);
        });
        
        process.on('SIGTERM', () => { 
            consoleLog('INFO', 'SIGTERM received, shutting down gracefully...');
            pool.end(() => {
                consoleLog('SUCCESS', 'Database connections closed');
                process.exit(0);
            });
        });
        
        process.on('SIGINT', () => { 
            consoleLog('INFO', 'SIGINT received, shutting down gracefully...');
            pool.end(() => {
                consoleLog('SUCCESS', 'Database connections closed');
                process.exit(0);
            });
        });
        
    } catch (error) {
        consoleLog('ERROR', 'Failed to start server:', error.message);
        consoleLog('ERROR', error.stack);
        process.exit(1);
    }
}

startServer();