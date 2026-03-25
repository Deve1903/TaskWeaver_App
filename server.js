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

const app = express();
const port = process.env.PORT || 3000;

// ============ DATABASE CONNECTION (PostgreSQL with retry) ============
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

let dbConnected = false;
let retryCount = 0;
const maxRetries = 5;

async function connectWithRetry() {
  while (retryCount < maxRetries && !dbConnected) {
    try {
      await pool.query('SELECT 1');
      dbConnected = true;
      console.log('✅ PostgreSQL database connected successfully');
      return true;
    } catch (err) {
      retryCount++;
      console.log(`Database connection attempt ${retryCount}/${maxRetries} failed: ${err.message}`);
      if (retryCount < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  }
  if (!dbConnected) {
    console.error('❌ Failed to connect to database after multiple attempts');
  }
  return dbConnected;
}

connectWithRetry();

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
    
    const consoleMessage = `[${timestamp}] [${level}] ${message}`;
    if (level === 'ERROR') console.error('\x1b[31m%s\x1b[0m', consoleMessage);
    else if (level === 'WARNING') console.warn('\x1b[33m%s\x1b[0m', consoleMessage);
    else if (level === 'SUCCESS') console.log('\x1b[32m%s\x1b[0m', consoleMessage);
    else console.log('\x1b[36m%s\x1b[0m', consoleMessage);
}

async function logUserActivity(userId, email, action, details, req = null) {
    if (!dbConnected) return;
    
    const logData = {
        userId, email, action, details,
        ip: req?.ip || req?.connection?.remoteAddress || 'unknown',
        userAgent: req?.headers['user-agent'] || 'unknown',
        method: req?.method, url: req?.originalUrl
    };
    logToFile(activityLogStream, 'ACTIVITY', `User ${email}: ${action}`, logData);
    console.log(`\x1b[36m[USER ACTIVITY] ${email}: ${action}\x1b[0m`);
    
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
    console.log(`\x1b[33m[EMAIL] ${email} -> ${to}: ${subject} - ${status}\x1b[0m`);
    
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

// ============ HEALTH CHECK ============
app.get('/api/health', async (req, res) => {
    try {
        if (!dbConnected) await connectWithRetry();
        await pool.query('SELECT 1');
        res.json({ 
            status: 'healthy', 
            database: 'connected',
            uptime: process.uptime(),
            timestamp: new Date().toISOString(),
            environment: process.env.NODE_ENV
        });
    } catch (err) {
        res.status(500).json({ 
            status: 'unhealthy', 
            database: 'disconnected',
            error: err.message
        });
    }
});

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
        console.log(`CORS blocked: ${origin}`);
        logToFile(errorLogStream, 'WARNING', `CORS blocked request from: ${origin}`);
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

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });
app.get('/login', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'login.html')); });
app.get('/index.html', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });
app.get('/login.html', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'login.html')); });
app.get('/reset-password.html', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'reset-password.html')); });

// ============ SESSION CONFIGURATION ============
app.use(session({
    store: new pgSession({
        pool: pool,
        tableName: 'session',
        createTableIfMissing: true,
    }),
    secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000,
        sameSite: 'lax'
    },
    name: 'taskweaver.sid',
    rolling: true
}));

// Session debug middleware
app.use((req, res, next) => {
    if (req.session && req.session.userId) {
        res.locals.userId = req.session.userId;
        res.locals.email = req.session.email;
    }
    next();
});

// ============ DATABASE INITIALIZATION ============
async function initializeDatabase() {
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
        console.log('✅ Users table ready');
        
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
        console.log('✅ Tasks table ready');
        
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
        console.log('✅ Shared schedules table ready');
        
        // Reminders table
        await client.query(`
            CREATE TABLE IF NOT EXISTS reminders (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                user_email TEXT NOT NULL,
                task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
                reminder_time TIMESTAMP NOT NULL,
                reminder_type TEXT DEFAULT 'scheduled',
                reminder_method TEXT DEFAULT 'email',
                sent INTEGER DEFAULT 0,
                sent_at TIMESTAMP,
                retry_count INTEGER DEFAULT 0,
                last_error TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log('✅ Reminders table ready');
        
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
        console.log('✅ Activity log table ready');
        
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
        console.log('✅ Email log table ready');
        
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
        console.log('✅ Suggestions table ready');
        
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
        console.log('✅ Projects table ready');
        
        // Create indexes
        const indexes = [
            'CREATE INDEX IF NOT EXISTS idx_tasks_user_id ON tasks(user_id)',
            'CREATE INDEX IF NOT EXISTS idx_tasks_user_email ON tasks(user_email)',
            'CREATE INDEX IF NOT EXISTS idx_tasks_scheduled_start ON tasks(scheduled_start)',
            'CREATE INDEX IF NOT EXISTS idx_tasks_deadline ON tasks(deadline)',
            'CREATE INDEX IF NOT EXISTS idx_tasks_completed ON tasks(completed)',
            'CREATE INDEX IF NOT EXISTS idx_reminders_reminder_time ON reminders(reminder_time)',
            'CREATE INDEX IF NOT EXISTS idx_reminders_sent ON reminders(sent)',
            'CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)',
            'CREATE INDEX IF NOT EXISTS idx_activity_user_id ON activity_log(user_id)',
            'CREATE INDEX IF NOT EXISTS idx_activity_email ON activity_log(email)',
            'CREATE INDEX IF NOT EXISTS idx_email_log_recipient ON email_log(recipient)',
            'CREATE INDEX IF NOT EXISTS idx_suggestions_user_id ON suggestions(user_id)',
            'CREATE INDEX IF NOT EXISTS idx_projects_user_id ON projects(user_id)',
            'CREATE INDEX IF NOT EXISTS idx_shared_schedules_user_email ON shared_schedules(user_email)',
            'CREATE INDEX IF NOT EXISTS idx_shared_schedules_token ON shared_schedules(share_token)'
        ];
        
        for (const index of indexes) {
            await client.query(index).catch(() => {});
        }
        console.log('✅ All indexes created successfully');
        
        // Create demo user
        const demoEmail = 'demo@taskweaver.com';
        const existingDemo = await client.query('SELECT id FROM users WHERE email = $1', [demoEmail]);
        if (existingDemo.rows.length === 0) {
            const hashedPassword = await bcrypt.hash('Demo@2024', 10);
            await client.query(
                `INSERT INTO users (username, email, password, email_notifications, push_notifications, timezone, theme, email_verified) 
                 VALUES ($1, $2, $3, 1, 1, 'UTC', 'light', 1)`,
                ['DEMOUSER', demoEmail, hashedPassword]
            );
            console.log('✅ Demo user created: demo@taskweaver.com / Demo@2024');
        } else {
            console.log('ℹ️ Demo user already exists');
        }
        
        console.log('✅ Database initialization complete');
        
    } catch (err) {
        console.error('❌ Database initialization error:', err.message);
        throw err;
    } finally {
        client.release();
    }
}

// ============ EMAIL TRANSPORTER ============
let transporter = null;

function setupEmailTransporter() {
    if (process.env.EMAIL_USER && process.env.EMAIL_PASS && 
        process.env.EMAIL_USER !== 'your-email@gmail.com') {
        try {
            transporter = nodemailer.createTransport({
                service: 'gmail',
                auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
            });
            transporter.verify((error) => {
                if (error) console.log('⚠️ Email verification failed:', error.message);
                else console.log('✅ Email server ready');
            });
        } catch (error) {
            console.log('⚠️ Email setup failed:', error.message);
            transporter = null;
        }
    } else {
        console.log('⚠️ Email not configured - using demo mode');
    }
}

// Professional email template
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
        <div class="footer"><p>© 2024 TaskWeaver. All rights reserved.</p><p>Made with ❤️ for better productivity</p></div>
    </div>
    </body>
    </html>`;
}

// ============ EXPORT FUNCTIONS ============
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
            if (task.deadline) details.push(`⏰ Deadline: ${new Date(task.deadline).toLocaleString()}`);
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
            scheduled_start: task.scheduled_start ? new Date(task.scheduled_start).toLocaleString() : '',
            deadline: task.deadline ? new Date(task.deadline).toLocaleString() : '',
            completed: task.completed ? 'Yes' : 'No',
            tags: task.tags || ''
        });
    });
    return await workbook.xlsx.writeBuffer();
}

function generateCSV(tasks) {
    const fields = ['title', 'description', 'project', 'category', 'severity', 'scheduled_start', 'deadline', 'completed', 'tags'];
    const parser = new Parser({ fields });
    const formattedTasks = tasks.map(task => ({
        ...task,
        scheduled_start: task.scheduled_start ? new Date(task.scheduled_start).toLocaleString() : '',
        deadline: task.deadline ? new Date(task.deadline).toLocaleString() : '',
        completed: task.completed ? 'Yes' : 'No'
    }));
    return parser.parse(formattedTasks);
}

// ============ HELPER FUNCTIONS ============
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

function requireAuth(req, res, next) {
    if (!req.session?.userId) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    next();
}

// ============ AUTHENTICATION ROUTES ============
app.post('/api/check-password-strength', (req, res) => {
    try {
        res.json(checkPasswordStrength(req.body.password));
    } catch (error) {
        res.status(500).json({ error: 'Failed to check password' });
    }
});

app.post('/api/register', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    
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
            `INSERT INTO users (username, email, password, last_login_ip, last_login_user_agent, verification_token) 
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
            [username, email, hashedPassword, req.ip, req.headers['user-agent'], verificationToken]
        );
        
        const userId = result.rows[0].id;
        console.log(`\x1b[32m[REGISTRATION] New user registered: ${email} (ID: ${userId})\x1b[0m`);
        
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
            transporter.sendMail({
                from: process.env.EMAIL_USER,
                to: email,
                subject: '🎉 Welcome to TaskWeaver - Verify Your Email',
                html: emailContent
            }).catch(error => console.log('Email send failed:', error.message));
        }
        
        await logUserActivity(userId, email, 'REGISTER', 'User registered successfully', req);
        res.json({ success: true, username, email, message: 'Registration successful! Please check your email to verify your account.' });
    } catch (err) {
        console.error('Registration error:', err.message);
        res.status(500).json({ error: 'Registration failed' });
    }
});

app.get('/api/verify-email', async (req, res) => {
    const { token } = req.query;
    try {
        const result = await pool.query('UPDATE users SET email_verified = 1, verification_token = NULL WHERE verification_token = $1 RETURNING id', [token]);
        if (result.rows.length > 0) {
            res.redirect('/login.html?verified=true');
        } else {
            res.redirect('/login.html?error=invalid_token');
        }
    } catch {
        res.redirect('/login.html?error=verification_failed');
    }
});

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        const user = result.rows[0];
        if (!user) return res.status(401).json({ error: 'Invalid credentials' });
        
        console.log(`\x1b[36m[LOGIN ATTEMPT] User: ${email}\x1b[0m`);
        
        if (user.locked_until && new Date(user.locked_until) > new Date()) {
            console.log(`\x1b[31m[LOGIN] Account locked for: ${email}\x1b[0m`);
            return res.status(401).json({ error: 'Account is temporarily locked. Try again later.' });
        }
        
        const valid = await bcrypt.compare(password, user.password);
        if (!valid) {
            const attempts = (user.failed_login_attempts || 0) + 1;
            const locked = attempts >= 5 ? new Date(Date.now() + 15 * 60000) : null;
            await pool.query('UPDATE users SET failed_login_attempts = $1, last_failed_login = $2, locked_until = $3 WHERE id = $4', 
                [attempts, new Date().toISOString(), locked, user.id]);
            console.log(`\x1b[31m[LOGIN] Failed attempt for: ${email} (Attempt ${attempts}/5)\x1b[0m`);
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
    } catch (err) {
        console.error('Login error:', err.message);
        res.status(500).json({ error: 'Login failed' });
    }
});

app.get('/api/check-session', async (req, res) => {
    console.log(`\x1b[36m[SESSION CHECK] Session ID: ${req.sessionID}\x1b[0m`);
    if (req.session?.userId) {
        try {
            const result = await pool.query('SELECT email, username FROM users WHERE id = $1', [req.session.userId]);
            const user = result.rows[0];
            console.log(`\x1b[32m[SESSION CHECK] Valid session for: ${user?.email}\x1b[0m`);
            res.json({ 
                authenticated: true, 
                userId: req.session.userId,
                username: user?.username || req.session.username,
                email: user?.email || req.session.email
            });
        } catch (err) {
            res.json({ authenticated: true, username: req.session.username, email: req.session.email });
        }
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
    req.session.destroy(() => res.json({ success: true }));
});

app.post('/api/forgot-password', async (req, res) => {
    const { email } = req.body;
    try {
        const user = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
        if (user.rows.length === 0) return res.status(404).json({ error: 'Email not found' });
        
        const token = crypto.randomBytes(32).toString('hex');
        const expiry = new Date(Date.now() + 3600000);
        await pool.query('UPDATE users SET reset_token = $1, reset_token_expiry = $2 WHERE id = $3', [token, expiry, user.rows[0].id]);
        
        const resetLink = `https://${req.get('host')}/reset-password.html?token=${token}`;
        if (transporter) {
            transporter.sendMail({
                from: process.env.EMAIL_USER,
                to: email,
                subject: 'Password Reset - TaskWeaver',
                html: getEmailTemplate('Password Reset', 'Click the button below to reset your password. This link expires in 1 hour.', 'Reset Password', resetLink)
            }).catch(() => {});
            await logEmailSent(user.rows[0].id, email, email, 'Password Reset', 'success');
        }
        res.json({ success: true, message: 'Password reset email sent' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/reset-password', async (req, res) => {
    const { token, newPassword } = req.body;
    const strength = checkPasswordStrength(newPassword);
    if (strength.score < 3) return res.status(400).json({ error: 'Password too weak.' });
    
    try {
        const user = await pool.query('SELECT id FROM users WHERE reset_token = $1 AND reset_token_expiry > NOW()', [token]);
        if (user.rows.length === 0) return res.status(400).json({ error: 'Invalid or expired token' });
        
        const hashed = await bcrypt.hash(newPassword, 10);
        await pool.query('UPDATE users SET password = $1, reset_token = NULL, reset_token_expiry = NULL WHERE id = $2', [hashed, user.rows[0].id]);
        await logUserActivity(user.rows[0].id, user.rows[0].email, 'PASSWORD_RESET', 'Password reset successfully', req);
        res.json({ success: true, message: 'Password reset successful' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============ USER SETTINGS ============
app.get('/api/settings', requireAuth, async (req, res) => {
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
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/settings', requireAuth, async (req, res) => {
    const { reminder_interval, auto_reminders, email_notifications, push_notifications, timezone, theme } = req.body;
    const updates = [];
    const values = [];
    let paramCounter = 1;
    
    if (reminder_interval !== undefined) { updates.push(`reminder_interval = $${paramCounter++}`); values.push(reminder_interval); }
    if (auto_reminders !== undefined) { updates.push(`auto_reminders = $${paramCounter++}`); values.push(auto_reminders ? 1 : 0); }
    if (email_notifications !== undefined) { updates.push(`email_notifications = $${paramCounter++}`); values.push(email_notifications ? 1 : 0); }
    if (push_notifications !== undefined) { updates.push(`push_notifications = $${paramCounter++}`); values.push(push_notifications ? 1 : 0); }
    if (timezone !== undefined) { updates.push(`timezone = $${paramCounter++}`); values.push(timezone); }
    if (theme !== undefined) { updates.push(`theme = $${paramCounter++}`); values.push(theme); }
    
    if (updates.length === 0) return res.status(400).json({ error: 'No updates provided' });
    
    values.push(req.session.userId);
    const query = `UPDATE users SET ${updates.join(', ')} WHERE id = $${paramCounter}`;
    
    try {
        await pool.query(query, values);
        await logUserActivity(req.session.userId, req.session.email, 'SETTINGS_UPDATED', 'Settings updated', req);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============ TASK ROUTES ============
app.get('/api/tasks', requireAuth, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT * FROM tasks WHERE user_id = $1 AND (deleted_at IS NULL OR deleted_at = '') 
             ORDER BY CASE severity 
                WHEN 'Critical' THEN 1 WHEN 'High' THEN 2 WHEN 'Medium' THEN 3 WHEN 'Low' THEN 4 
             END, deadline ASC NULLS LAST, scheduled_start ASC NULLS LAST`,
            [req.session.userId]
        );
        res.json(result.rows || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/unscheduled-tasks', requireAuth, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT * FROM tasks WHERE user_id = $1 AND (scheduled_start IS NULL OR scheduled_start = '') 
             AND completed = 0 AND (deleted_at IS NULL OR deleted_at = '')
             ORDER BY CASE severity WHEN 'Critical' THEN 1 WHEN 'High' THEN 2 WHEN 'Medium' THEN 3 WHEN 'Low' THEN 4 END,
             deadline ASC NULLS LAST`,
            [req.session.userId]
        );
        res.json(result.rows || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/upcoming-deadlines', requireAuth, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT * FROM tasks WHERE user_id = $1 AND completed = 0 AND deadline IS NOT NULL 
             AND deadline >= NOW() ORDER BY deadline ASC LIMIT 10`,
            [req.session.userId]
        );
        res.json(result.rows || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/overdue-tasks', requireAuth, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT * FROM tasks WHERE user_id = $1 AND completed = 0 AND deadline IS NOT NULL 
             AND deadline < NOW() ORDER BY deadline ASC`,
            [req.session.userId]
        );
        res.json(result.rows || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/tasks', requireAuth, async (req, res) => {
    const { title, description, project, category, severity, priority, deadline, is_recurring, recurrence_pattern, scheduled_start, scheduled_end, estimated_duration, tags } = req.body;
    if (!title) return res.status(400).json({ error: 'Task title is required' });
    
    try {
        const result = await pool.query(
            `INSERT INTO tasks (user_id, user_email, title, description, project, category, severity, priority, deadline, 
              is_recurring, recurrence_pattern, scheduled_start, scheduled_end, estimated_duration, tags)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id`,
            [req.session.userId, req.session.email, title, description || null, project || null, category || null, 
             severity || 'Medium', priority || 2, deadline || null, is_recurring ? 1 : 0, recurrence_pattern || null, 
             scheduled_start || null, scheduled_end || null, estimated_duration || null, tags || null]
        );
        
        const taskId = result.rows[0].id;
        
        if (scheduled_start) {
            const reminderTime = new Date(new Date(scheduled_start).getTime() - 20 * 60 * 1000);
            await pool.query(
                `INSERT INTO reminders (user_id, user_email, task_id, reminder_time, reminder_type) VALUES ($1, $2, $3, $4, 'scheduled')`,
                [req.session.userId, req.session.email, taskId, reminderTime.toISOString()]
            );
        }
        
        console.log(`\x1b[36m[TASK] ${req.session.email} created task: ${title}\x1b[0m`);
        await logUserActivity(req.session.userId, req.session.email, 'TASK_CREATED', `Task: ${title}`, req);
        res.json({ id: taskId, message: 'Task created successfully' });
    } catch (err) {
        console.error('Task creation error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/tasks/:id', requireAuth, async (req, res) => {
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
    if (deadline !== undefined) { updates.push(`deadline = $${paramCounter++}`); values.push(deadline); }
    if (scheduled_start !== undefined) { updates.push(`scheduled_start = $${paramCounter++}`); values.push(scheduled_start); }
    if (scheduled_end !== undefined) { updates.push(`scheduled_end = $${paramCounter++}`); values.push(scheduled_end); }
    if (actual_start !== undefined) { updates.push(`actual_start = $${paramCounter++}`); values.push(actual_start); }
    if (actual_end !== undefined) { updates.push(`actual_end = $${paramCounter++}`); values.push(actual_end); }
    if (completion_notes !== undefined) { updates.push(`completion_notes = $${paramCounter++}`); values.push(completion_notes); }
    if (tags !== undefined) { updates.push(`tags = $${paramCounter++}`); values.push(tags); }
    if (completed !== undefined) { 
        updates.push(`completed = $${paramCounter++}`); 
        values.push(completed ? 1 : 0);
        if (completed) updates.push(`completed_at = CURRENT_TIMESTAMP`);
        else updates.push(`completed_at = NULL`);
        updates.push(`updated_at = CURRENT_TIMESTAMP`);
    }
    
    if (updates.length === 0) return res.status(400).json({ error: 'No updates provided' });
    
    values.push(req.params.id, req.session.userId);
    const query = `UPDATE tasks SET ${updates.join(', ')} WHERE id = $${paramCounter++} AND user_id = $${paramCounter}`;
    
    try {
        const result = await pool.query(query, values);
        await logUserActivity(req.session.userId, req.session.email, 'TASK_UPDATED', `Task ID: ${req.params.id}`, req);
        res.json({ updated: result.rowCount });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/tasks/:id', requireAuth, async (req, res) => {
    try {
        const taskResult = await pool.query('SELECT title FROM tasks WHERE id = $1 AND user_id = $2', [req.params.id, req.session.userId]);
        const task = taskResult.rows[0];
        const result = await pool.query('DELETE FROM tasks WHERE id = $1 AND user_id = $2', [req.params.id, req.session.userId]);
        if (task) await logUserActivity(req.session.userId, req.session.email, 'TASK_DELETED', `Task: ${task.title}`, req);
        res.json({ deleted: result.rowCount });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============ SUGGESTIONS ============
app.get('/api/suggestions', requireAuth, async (req, res) => {
    try {
        const suggestions = await pool.query(
            'SELECT * FROM suggestions WHERE user_id = $1 AND is_read = 0 ORDER BY priority DESC, created_at ASC LIMIT 10',
            [req.session.userId]
        );
        
        if (suggestions.rows.length === 0) {
            const tasks = await pool.query(
                `SELECT * FROM tasks WHERE user_id = $1 AND completed = 0 AND (scheduled_start IS NULL OR scheduled_start = '') 
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
            }
            res.json(suggestionTexts.slice(0, 5));
        } else {
            res.json(suggestions.rows.map(s => s.suggestion));
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============ PROJECTS ============
app.get('/api/projects', requireAuth, async (req, res) => {
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
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/projects', requireAuth, async (req, res) => {
    const { name, description, color, status, progress, start_date, end_date } = req.body;
    if (!name) return res.status(400).json({ error: 'Project name required' });
    
    try {
        const result = await pool.query(
            `INSERT INTO projects (user_id, user_email, name, description, color, status, progress, start_date, end_date)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
            [req.session.userId, req.session.email, name, description, color, status || 'active', progress || 0, start_date, end_date]
        );
        res.json({ id: result.rows[0].id, message: 'Project created' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/projects/:id', requireAuth, async (req, res) => {
    const { name, description, color, status, progress, start_date, end_date } = req.body;
    try {
        await pool.query(
            `UPDATE projects SET name = COALESCE($1, name), description = COALESCE($2, description), color = COALESCE($3, color),
             status = COALESCE($4, status), progress = COALESCE($5, progress), start_date = COALESCE($6, start_date),
             end_date = COALESCE($7, end_date), updated_at = NOW() WHERE id = $8 AND user_id = $9`,
            [name, description, color, status, progress, start_date, end_date, req.params.id, req.session.userId]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/projects/:id', requireAuth, async (req, res) => {
    try {
        await pool.query('DELETE FROM projects WHERE id = $1 AND user_id = $2', [req.params.id, req.session.userId]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============ SHARING AND EXPORT ROUTES ============
app.post('/api/share-schedule', requireAuth, async (req, res) => {
    const { shareWithEmail, shareType = 'view' } = req.body;
    const userEmail = req.session.email;
    const userId = req.session.userId;
    
    if (!shareWithEmail) {
        return res.status(400).json({ error: 'Recipient email is required' });
    }
    
    try {
        const recipientResult = await pool.query('SELECT id, email FROM users WHERE email = $1', [shareWithEmail]);
        if (recipientResult.rows.length === 0) {
            return res.status(404).json({ error: 'Recipient email not found in TaskWeaver' });
        }
        
        const recipient = recipientResult.rows[0];
        const shareToken = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        
        await pool.query(
            `INSERT INTO shared_schedules (user_id, user_email, share_with_email, share_token, share_type, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [userId, userEmail, shareWithEmail, shareToken, shareType, expiresAt.toISOString()]
        );
        
        const tasksResult = await pool.query(
            `SELECT * FROM tasks WHERE user_id = $1 AND completed = 0 AND (deleted_at IS NULL OR deleted_at = '') 
             ORDER BY scheduled_start ASC, deadline ASC`,
            [userId]
        );
        const tasks = tasksResult.rows;
        
        const shareLink = `https://${req.get('host')}/api/view-shared-schedule?token=${shareToken}`;
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
            transporter.sendMail({
                from: process.env.EMAIL_USER,
                to: shareWithEmail,
                subject: `📅 Schedule Shared with You - TaskWeaver`,
                html: emailContent,
                attachments: [
                    { filename: `schedule_${userEmail.replace('@', '_')}.pdf`, content: pdfBuffer, contentType: 'application/pdf' },
                    { filename: `schedule_${userEmail.replace('@', '_')}.xlsx`, content: excelBuffer, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
                    { filename: `schedule_${userEmail.replace('@', '_')}.csv`, content: csvData, contentType: 'text/csv' }
                ]
            }).catch(error => console.log('Share email failed:', error.message));
            await logEmailSent(userId, userEmail, shareWithEmail, 'Schedule Shared', 'success');
        }
        
        console.log(`\x1b[32m[SHARE] Schedule shared from ${userEmail} to ${shareWithEmail}\x1b[0m`);
        res.json({ success: true, message: `Schedule shared with ${shareWithEmail}` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/view-shared-schedule', async (req, res) => {
    const { token, format = 'json' } = req.query;
    
    try {
        const shareResult = await pool.query(
            'SELECT * FROM shared_schedules WHERE share_token = $1 AND expires_at > NOW()',
            [token]
        );
        const share = shareResult.rows[0];
        
        if (!share) {
            return res.status(404).json({ error: 'Invalid or expired share link' });
        }
        
        const tasksResult = await pool.query(
            `SELECT * FROM tasks WHERE user_id = $1 AND completed = 0 AND (deleted_at IS NULL OR deleted_at = '') 
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
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/export-schedule', requireAuth, async (req, res) => {
    const { format = 'json' } = req.query;
    const userId = req.session.userId;
    const userEmail = req.session.email;
    
    try {
        const result = await pool.query(
            `SELECT * FROM tasks WHERE user_id = $1 AND completed = 0 AND (deleted_at IS NULL OR deleted_at = '') 
             ORDER BY scheduled_start ASC, deadline ASC`,
            [userId]
        );
        const tasks = result.rows;
        
        console.log(`\x1b[36m[EXPORT] User ${userEmail} exporting schedule as ${format}\x1b[0m`);
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
        res.status(500).json({ error: err.message });
    }
});

// ============ STATISTICS ============
app.get('/api/user-stats', requireAuth, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                COUNT(CASE WHEN completed = 1 THEN 1 END) as completed_tasks,
                COUNT(CASE WHEN completed = 0 AND scheduled_start IS NOT NULL AND scheduled_start != '' AND (deleted_at IS NULL OR deleted_at = '') THEN 1 END) as scheduled_tasks,
                COUNT(CASE WHEN completed = 0 AND (scheduled_start IS NULL OR scheduled_start = '') AND (deleted_at IS NULL OR deleted_at = '') THEN 1 END) as unscheduled_tasks,
                COUNT(CASE WHEN severity = 'Critical' AND completed = 0 AND (deleted_at IS NULL OR deleted_at = '') THEN 1 END) as critical_tasks,
                COUNT(CASE WHEN severity = 'High' AND completed = 0 AND (deleted_at IS NULL OR deleted_at = '') THEN 1 END) as high_priority_tasks,
                COUNT(CASE WHEN deadline < CURRENT_TIMESTAMP AND completed = 0 AND (deleted_at IS NULL OR deleted_at = '') THEN 1 END) as overdue_tasks,
                COUNT(CASE WHEN created_at > NOW() - INTERVAL '7 days' THEN 1 END) as tasks_this_week
            FROM tasks WHERE user_id = $1`,
            [req.session.userId]
        );
        res.json(result.rows[0] || {});
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/activity', requireAuth, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM activity_log WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50',
            [req.session.userId]
        );
        res.json(result.rows || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/debug', async (req, res) => {
    try {
        const users = await pool.query('SELECT COUNT(*) FROM users');
        const tasks = await pool.query('SELECT COUNT(*) FROM tasks');
        const projects = await pool.query('SELECT COUNT(*) FROM projects');
        const reminders = await pool.query('SELECT COUNT(*) FROM reminders');
        const tables = await pool.query(`
            SELECT table_name FROM information_schema.tables 
            WHERE table_schema = 'public' ORDER BY table_name
        `);
        
        res.json({
            status: 'ok',
            database: 'connected',
            userCount: parseInt(users.rows[0].count),
            taskCount: parseInt(tasks.rows[0].count),
            projectCount: parseInt(projects.rows[0].count),
            reminderCount: parseInt(reminders.rows[0].count),
            tables: tables.rows.map(t => t.table_name),
            environment: process.env.NODE_ENV,
            port: port,
            nodeVersion: process.version
        });
    } catch (error) {
        res.status(500).json({ error: error.message, databaseConnected: false });
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
            AND (t.deleted_at IS NULL OR t.deleted_at = '')
        `);
        
        const reminders = result.rows;
        
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
            
            transporter.sendMail({
                from: process.env.EMAIL_USER,
                to: reminder.user_email,
                subject: `🔔 Task Reminder: ${reminder.title}`,
                html: emailContent
            }, async (error) => {
                if (!error) {
                    await pool.query('UPDATE reminders SET sent = 1, sent_at = NOW() WHERE id = $1', [reminder.id]);
                    await logEmailSent(reminder.user_id, reminder.user_email, reminder.user_email, `Reminder: ${reminder.title}`, 'success');
                    await pool.query('UPDATE tasks SET reminder_count = reminder_count + 1, last_reminder_sent = NOW() WHERE id = $1', [reminder.task_id]);
                    console.log(`\x1b[32m[REMINDER] Sent to ${reminder.user_email}: ${reminder.title}\x1b[0m`);
                } else {
                    await logEmailSent(reminder.user_id, reminder.user_email, reminder.user_email, `Reminder: ${reminder.title}`, 'failed', error);
                    await pool.query('UPDATE reminders SET retry_count = retry_count + 1, last_error = $1 WHERE id = $2', [error.message, reminder.id]);
                }
            });
        }
    } catch (err) {
        logToFile(errorLogStream, 'ERROR', 'Error checking reminders', err);
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
            
            transporter.sendMail({
                from: process.env.EMAIL_USER,
                to: task.user_email,
                subject: `⚠️ DEADLINE APPROACHING: ${task.title}`,
                html: emailContent
            }, async (error) => {
                if (!error) {
                    await pool.query('UPDATE tasks SET deadline_reminder_sent = 1 WHERE id = $1', [task.id]);
                    await logEmailSent(task.user_id, task.user_email, task.user_email, `Deadline: ${task.title}`, 'success');
                    console.log(`\x1b[33m[DEADLINE] Reminder sent to ${task.user_email}: ${task.title} due in ${hoursLeft}h\x1b[0m`);
                } else {
                    await logEmailSent(task.user_id, task.user_email, task.user_email, `Deadline: ${task.title}`, 'failed', error);
                }
            });
        }
    } catch (err) {
        logToFile(errorLogStream, 'ERROR', 'Error checking deadline reminders', err);
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
            
            transporter.sendMail({
                from: process.env.EMAIL_USER,
                to: task.user_email,
                subject: `⚠️ OVERDUE TASK: ${task.title}`,
                html: emailContent
            }, async (error) => {
                if (!error) {
                    await pool.query('UPDATE tasks SET overdue_reminder_sent = 1 WHERE id = $1', [task.id]);
                    await logEmailSent(task.user_id, task.user_email, task.user_email, `Overdue: ${task.title}`, 'success');
                    console.log(`\x1b[31m[OVERDUE] Alert sent to ${task.user_email}: ${task.title} overdue by ${daysOverdue}d\x1b[0m`);
                } else {
                    await logEmailSent(task.user_id, task.user_email, task.user_email, `Overdue: ${task.title}`, 'failed', error);
                }
            });
        }
    } catch (err) {
        logToFile(errorLogStream, 'ERROR', 'Error checking overdue tasks', err);
    }
}

// Schedule reminders
cron.schedule('* * * * *', () => { checkScheduledReminders(); });
cron.schedule('*/30 * * * *', () => { checkDeadlineReminders(); checkOverdueTasks(); });

// Daily cleanup
cron.schedule('0 2 * * *', async () => {
    try {
        await pool.query("DELETE FROM activity_log WHERE created_at < NOW() - INTERVAL '90 days'");
        await pool.query("DELETE FROM reminders WHERE created_at < NOW() - INTERVAL '30 days'");
        await pool.query("DELETE FROM email_log WHERE created_at < NOW() - INTERVAL '180 days'");
        await pool.query("DELETE FROM suggestions WHERE created_at < NOW() - INTERVAL '30 days' AND is_read = 1");
        await pool.query("DELETE FROM shared_schedules WHERE expires_at < NOW()");
        console.log('✅ Daily cleanup completed');
    } catch (err) {
        logToFile(errorLogStream, 'ERROR', 'Error during cleanup', err);
    }
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
        await initializeDatabase();
        setupEmailTransporter();
        
        app.listen(port, '0.0.0.0', () => {
            console.log('\x1b[36m%s\x1b[0m', `\n🚀 TaskWeaver server running on port ${port}`);
            console.log('\x1b[32m%s\x1b[0m', `📧 Email: ${transporter ? 'configured' : 'demo mode'}`);
            console.log('\x1b[32m%s\x1b[0m', `🐘 PostgreSQL: ${dbConnected ? 'connected' : 'waiting...'}`);
            console.log('\x1b[33m%s\x1b[0m', `⏰ Reminder system active (checking every minute)`);
            console.log('\x1b[33m%s\x1b[0m', `📅 Schedule sharing enabled with PDF/Excel/CSV exports`);
            console.log('\x1b[32m%s\x1b[0m', `\n📝 Demo Login: demo@taskweaver.com / Demo@2024`);
            console.log('\x1b[36m%s\x1b[0m', `🩺 Health check: http://localhost:${port}/api/health\n`);
        });
        
        process.on('SIGTERM', () => { pool.end(() => process.exit(0)); });
        process.on('SIGINT', () => { pool.end(() => process.exit(0)); });
    } catch (error) {
        console.error('\x1b[31m%s\x1b[0m', 'Failed to start server:', error.message);
        process.exit(1);
    }
}

startServer();