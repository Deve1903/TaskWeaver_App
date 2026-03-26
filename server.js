const express = require('express');
const sgMail = require('@sendgrid/mail');
const { Pool } = require('pg');
const bodyParser = require('body-parser');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');
const { Parser } = require('json2csv');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const schedule = require('node-schedule');
const moment = require('moment-timezone');
const ical = require('ical-generator');
const QRCode = require('qrcode');
const sanitizeHtml = require('sanitize-html');
const winston = require('winston');
const natural = require('natural');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

// ============ ENVIRONMENT VALIDATION ============
const requiredEnvVars = ['DATABASE_URL', 'SESSION_SECRET'];
const isRender = process.env.RENDER === 'true' || 
                 process.env.RENDER_SERVICE_ID || 
                 process.env.RENDER_INSTANCE_ID ||
                 process.env.DATABASE_URL?.includes('render.com');

if (isRender) {
    requiredEnvVars.push('SENDGRID_API_KEY', 'EMAIL_USER');
}

const missingEnvVars = requiredEnvVars.filter(varName => !process.env[varName]);
if (missingEnvVars.length > 0) {
    console.error(`\x1b[31m❌ Missing required environment variables: ${missingEnvVars.join(', ')}\x1b[0m`);
    if (isRender) {
        console.error('\x1b[31mPlease add these to your Render environment variables\x1b[0m');
        process.exit(1);
    }
}

if (!process.env.SESSION_SECRET && process.env.NODE_ENV === 'production') {
    console.error('\x1b[31m❌ SESSION_SECRET must be set in production\x1b[0m');
    process.exit(1);
}

console.log('\x1b[36m%s\x1b[0m', `🔍 Environment: ${isRender ? 'Render (Production)' : 'Local (Development)'}`);

const app = express();
const port = process.env.PORT || 3000;

// ============ ADVANCED LOGGING ============
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
        new winston.transports.File({ filename: 'logs/combined.log' }),
        new winston.transports.Console({ format: winston.format.simple() })
    ]
});

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

// ============ SECURITY MIDDLEWARE ============
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com"],
            scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://cdn.jsdelivr.net"],
            fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
            imgSrc: ["'self'", "data:", "https:", "blob:"],
            connectSrc: ["'self'", "https://api.sendgrid.com", "wss:"],
        },
    },
    crossOriginEmbedderPolicy: false,
}));

app.use(compression());

// ============ RATE LIMITING ============
const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    message: 'Too many requests',
    standardHeaders: true,
    legacyHeaders: false,
});

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: 'Too many authentication attempts',
    skipSuccessfulRequests: true,
});

const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    message: 'Rate limit exceeded',
});

app.use('/api/', generalLimiter);
app.use('/api/login', authLimiter);
app.use('/api/register', authLimiter);
app.use('/api/forgot-password', authLimiter);
app.use('/api/tasks', apiLimiter);

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
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));

// ============ STATIC FILE SERVING ============
app.use(express.static(path.join(__dirname, 'public')));
app.use('/shared', express.static(path.join(__dirname, 'public/shared')));

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

// ============ DATABASE CONNECTION ============
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
});

let dbConnected = false;
let poolRetryCount = 0;
const maxPoolRetries = 3;

function checkDatabaseConnection() {
    pool.query('SELECT 1')
        .then(() => {
            if (!dbConnected) {
                dbConnected = true;
                logger.info('Database reconnected');
                poolRetryCount = 0;
            }
        })
        .catch(err => {
            dbConnected = false;
            logger.error('Database connection lost:', err.message);
            
            if (poolRetryCount < maxPoolRetries) {
                poolRetryCount++;
                setTimeout(checkDatabaseConnection, 5000 * poolRetryCount);
            }
        });
}

setInterval(checkDatabaseConnection, 30000);

pool.connect((err, client, release) => {
    if (err) {
        logger.error('Database connection error:', err.message);
    } else {
        logger.info('PostgreSQL database connected');
        dbConnected = true;
        release();
    }
});

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
        return moment(timestamp).format();
    } catch (err) {
        return null;
    }
}

function sanitizeInput(input) {
    if (typeof input !== 'string') return input;
    return sanitizeHtml(input, {
        allowedTags: [],
        allowedAttributes: {},
    });
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
let emailConfigured = false;
let transporter = null;
let emailQueue = [];
let isProcessingQueue = false;

function setupEmailTransporter() {
    consoleLog('INFO', 'Configuring SendGrid for Render...');
    
    if (!process.env.SENDGRID_API_KEY) {
        consoleLog('ERROR', 'SendGrid API key not found');
        return;
    }
    
    if (!process.env.EMAIL_USER) {
        consoleLog('ERROR', 'EMAIL_USER not set');
        return;
    }
    
    try {
        sgMail.setApiKey(process.env.SENDGRID_API_KEY);
        
        const testMsg = {
            to: process.env.EMAIL_USER,
            from: { email: process.env.EMAIL_USER, name: 'TaskWeaver' },
            subject: '✅ TaskWeaver Email Test',
            text: 'SendGrid is working!'
        };
        
        sgMail.send(testMsg)
            .then(() => {
                consoleLog('SUCCESS', '✓ SendGrid configured and working');
                emailConfigured = true;
                transporter = 'sendgrid';
            })
            .catch(err => {
                consoleLog('ERROR', 'SendGrid test failed:', err.message);
                emailConfigured = false;
                transporter = null;
            });
    } catch (error) {
        consoleLog('ERROR', 'SendGrid setup error:', error.message);
        emailConfigured = false;
        transporter = null;
    }
}

async function sendEmail(to, subject, html, attachments = []) {
    if (!emailConfigured || !transporter) {
        consoleLog('WARNING', `Email not sent to ${to}: Service not configured`);
        throw new Error('Email service not configured');
    }
    
    return new Promise((resolve, reject) => {
        emailQueue.push({ to, subject, html, attachments, resolve, reject, timestamp: Date.now() });
        processEmailQueue();
    });
}

async function processEmailQueue() {
    if (isProcessingQueue || emailQueue.length === 0) return;
    isProcessingQueue = true;
    
    while (emailQueue.length > 0) {
        const email = emailQueue.shift();
        try {
            const msg = {
                to: email.to,
                from: { email: process.env.EMAIL_USER, name: 'TaskWeaver' },
                subject: email.subject,
                html: email.html,
                attachments: email.attachments,
                trackingSettings: {
                    openTracking: { enable: true },
                    clickTracking: { enable: true }
                }
            };
            
            const response = await sgMail.send(msg);
            email.resolve(response);
            logger.info(`Email sent to ${email.to}: ${email.subject}`);
        } catch (error) {
            logger.error(`Failed to send email to ${email.to}:`, error.message);
            email.reject(error);
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    isProcessingQueue = false;
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

// ============ PROFESSIONAL PDF GENERATION WITH LETTERHEAD ============
async function generateProfessionalPDF(tasks, user, shareToken = null) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ 
            margin: 50, 
            size: 'A4',
            layout: 'portrait',
            info: {
                Title: 'TaskWeaver Schedule Report',
                Author: user.email,
                Subject: 'Task Schedule',
                Creator: 'TaskWeaver'
            }
        });
        
        const buffers = [];
        doc.on('data', buffers.push.bind(buffers));
        doc.on('end', () => resolve(Buffer.concat(buffers)));
        doc.on('error', reject);
        
        const gradient = doc.linearGradient(0, 0, doc.page.width, 80);
        gradient.stop(0, '#667eea');
        gradient.stop(1, '#764ba2');
        doc.rect(0, 0, doc.page.width, 120).fill(gradient);
        
        doc.fontSize(32).fillColor('#ffffff').font('Helvetica-Bold').text('⚡ TaskWeaver', 50, 35);
        doc.fontSize(12).fillColor('#f0f0f0').font('Helvetica').text('Professional Schedule Report', 50, 75);
        
        doc.fillColor('#2d3748').fontSize(18).font('Helvetica-Bold').text('Schedule Overview', 50, 150);
        
        doc.fillColor('#4a5568').fontSize(10).font('Helvetica');
        doc.text(`Generated for: ${user.email}`, 70, 180);
        doc.text(`Generated on: ${moment().format('MMMM Do YYYY, h:mm:ss a')}`, 70, 195);
        doc.text(`Report ID: ${uuidv4().substring(0, 8).toUpperCase()}`, 70, 210);
        doc.text(`Total Tasks: ${tasks.length}`, 70, 225);
        
        let y = 280;
        tasks.forEach(task => {
            if (y > doc.page.height - 100) {
                doc.addPage();
                y = 50;
            }
            doc.fillColor('#2d3748').fontSize(12).font('Helvetica-Bold').text(task.title, 50, y);
            doc.fontSize(9).font('Helvetica').fillColor('#4a5568');
            let details = [];
            if (task.description) details.push(task.description.substring(0, 100));
            if (task.project) details.push(`Project: ${task.project}`);
            if (task.scheduled_start) details.push(moment(task.scheduled_start).format('MMM DD, HH:mm'));
            if (task.deadline) details.push(`Due: ${moment(task.deadline).format('MMM DD, HH:mm')}`);
            doc.text(details.join(' • '), 50, y + 15);
            y += 50;
        });
        
        if (shareToken) {
            const qrData = `${process.env.BASE_URL}/shared/${shareToken}`;
            QRCode.toBuffer(qrData, { width: 100 }, (err, buffer) => {
                if (!err) doc.image(buffer, doc.page.width - 120, doc.page.height - 80, { width: 80 });
            });
        }
        
        doc.end();
    });
}

// ============ ADVANCED EXCEL GENERATION ============
async function generateAdvancedExcel(tasks, user) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'TaskWeaver';
    workbook.lastModifiedBy = user.email;
    
    const scheduleSheet = workbook.addWorksheet('Schedule');
    
    scheduleSheet.mergeCells('A1:I1');
    const titleCell = scheduleSheet.getCell('A1');
    titleCell.value = '⚡ TaskWeaver - Professional Schedule Report';
    titleCell.font = { size: 16, bold: true, color: { argb: 'FFFFFFFF' } };
    titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF667EEA' } };
    
    scheduleSheet.columns = [
        { header: '#', key: 'index', width: 6 },
        { header: 'Task Title', key: 'title', width: 35 },
        { header: 'Description', key: 'description', width: 40 },
        { header: 'Project', key: 'project', width: 20 },
        { header: 'Severity', key: 'severity', width: 12 },
        { header: 'Scheduled Start', key: 'scheduled_start', width: 20 },
        { header: 'Deadline', key: 'deadline', width: 20 },
        { header: 'Status', key: 'status', width: 12 },
        { header: 'Tags', key: 'tags', width: 20 }
    ];
    
    const headerRow = scheduleSheet.getRow(3);
    headerRow.font = { bold: true };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF667EEA' } };
    
    tasks.forEach((task, index) => {
        scheduleSheet.addRow({
            index: index + 1,
            title: task.title || '',
            description: task.description || '',
            project: task.project || '',
            severity: task.severity || 'Medium',
            scheduled_start: task.scheduled_start ? moment(task.scheduled_start).format('MMM DD, YYYY HH:mm') : '',
            deadline: task.deadline ? moment(task.deadline).format('MMM DD, YYYY HH:mm') : '',
            status: task.completed ? 'Completed' : 'Pending',
            tags: task.tags || ''
        });
    });
    
    return await workbook.xlsx.writeBuffer();
}

// ============ WORD DOCUMENT GENERATION ============
async function generateWordDocument(tasks, user) {
    const html = `
        <!DOCTYPE html>
        <html>
        <head><meta charset="UTF-8"><title>TaskWeaver Report</title>
        <style>
            body { font-family: 'Segoe UI', Arial, sans-serif; margin: 40px; }
            .header { background: #667eea; padding: 20px; color: white; text-align: center; }
            table { width: 100%; border-collapse: collapse; margin-top: 20px; }
            th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
            th { background: #667eea; color: white; }
        </style>
        </head>
        <body>
            <div class="header"><h1>⚡ TaskWeaver Report</h1></div>
            <p><strong>Generated for:</strong> ${user.email}<br><strong>Date:</strong> ${moment().format('MMMM Do YYYY, h:mm:ss a')}</p>
            <table>
                <thead><tr><th>#</th><th>Task Title</th><th>Project</th><th>Severity</th><th>Deadline</th><th>Status</th></tr></thead>
                <tbody>
                    ${tasks.map((task, index) => `
                        <tr>
                            <td>${index + 1}</td>
                            <td>${task.title || ''}</td>
                            <td>${task.project || '-'}</td>
                            <td>${task.severity || 'Medium'}</td>
                            <td>${task.deadline ? moment(task.deadline).format('MMM DD, YYYY') : '-'}</td>
                            <td>${task.completed ? 'Completed' : 'Pending'}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </body>
        </html>
    `;
    return Buffer.from(html);
}

// ============ iCALENDAR GENERATION ============
function generateICalendar(tasks) {
    const cal = ical({ domain: 'taskweaver.com', name: 'TaskWeaver Schedule' });
    tasks.forEach(task => {
        if (task.scheduled_start) {
            cal.createEvent({
                start: moment(task.scheduled_start).toDate(),
                end: moment(task.scheduled_end || task.scheduled_start).add(1, 'hour').toDate(),
                summary: task.title,
                description: task.description || '',
                status: task.completed ? 'CONFIRMED' : 'TENTATIVE'
            });
        }
    });
    return cal.toString();
}

// ============ RECURRING TASK GENERATOR ============
async function generateRecurringTasks(parentTaskId, pattern, endDate, userId) {
    const parentTask = await pool.query('SELECT * FROM tasks WHERE id = $1', [parentTaskId]);
    const task = parentTask.rows[0];
    if (!task) return;
    
    const startDate = new Date(task.scheduled_start || task.created_at);
    const end = new Date(endDate);
    let currentDate = new Date(startDate);
    const intervals = { daily: 1, weekly: 7, monthly: 30, yearly: 365 };
    const interval = intervals[pattern] || 1;
    
    while (currentDate <= end) {
        currentDate.setDate(currentDate.getDate() + interval);
        if (currentDate > end) break;
        
        await pool.query(`
            INSERT INTO tasks (user_id, user_email, title, description, project, category, severity, priority, 
            deadline, scheduled_start, scheduled_end, is_recurring, recurrence_parent_id, tags, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 0, $12, $13, NOW(), NOW())
        `, [
            userId, task.user_email, task.title, task.description, task.project, task.category, 
            task.severity, task.priority,
            task.deadline ? new Date(new Date(task.deadline).getTime() + interval * 86400000) : null,
            currentDate,
            task.scheduled_end ? new Date(new Date(task.scheduled_end).getTime() + interval * 86400000) : null,
            parentTaskId, task.tags
        ]);
    }
}

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
        secure: process.env.NODE_ENV === 'production',
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

// ============ AUTHENTICATION MIDDLEWARE ============
function requireAuth(req, res, next) {
    if (!req.session?.userId) {
        consoleLog('WARNING', `Unauthorized access attempt from ${req.ip}`);
        return res.status(401).json({ error: 'Authentication required' });
    }
    next();
}

// ============ HEALTH CHECK ============
app.get('/api/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({ 
            status: 'healthy', 
            database: 'connected',
            email: emailConfigured ? 'configured' : 'disabled',
            uptime: process.uptime(),
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        res.status(500).json({ 
            status: 'unhealthy', 
            database: 'disconnected',
            error: err.message
        });
    }
});

// ============ TEST EMAIL ENDPOINT ============
app.get('/api/test-email', async (req, res) => {
    if (!emailConfigured) {
        return res.json({ success: false, error: 'Email not configured' });
    }
    
    try {
        await sendEmail(process.env.EMAIL_USER, 'TaskWeaver Email Test', '<h1>Test Successful!</h1>');
        res.json({ success: true, message: 'Test email sent!' });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// ============ AUTHENTICATION ROUTES ============
app.post('/api/check-password-strength', (req, res) => {
    res.json(checkPasswordStrength(req.body.password));
});

app.post('/api/register', [
    body('email').isEmail().normalizeEmail(),
    body('password').isLength({ min: 8 })
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
    }
    
    const { email, password } = req.body;
    
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
        
        if (emailConfigured) {
            const verificationLink = `${process.env.BASE_URL || `https://${req.get('host')}`}/api/verify-email?token=${verificationToken}`;
            const emailContent = getEmailTemplate(
                'Welcome to TaskWeaver! 🎉',
                `Hi ${username},<br><br>Thank you for joining TaskWeaver! Please verify your email address.`,
                'Verify Email',
                verificationLink
            );
            sendEmail(email, 'Welcome to TaskWeaver', emailContent).catch(err => consoleLog('ERROR', 'Welcome email failed:', err));
        }
        
        await logUserActivity(userId, email, 'REGISTER', 'User registered successfully', req);
        res.json({ success: true, username, email, message: 'Registration successful!' });
        
    } catch (err) {
        consoleLog('ERROR', `Registration error:`, err.message);
        res.status(500).json({ error: 'Registration failed' });
    }
});

app.get('/api/verify-email', async (req, res) => {
    const { token } = req.query;
    try {
        const result = await pool.query('UPDATE users SET email_verified = 1, verification_token = NULL WHERE verification_token = $1 RETURNING id, email', [token]);
        if (result.rows.length > 0) {
            await logUserActivity(result.rows[0].id, result.rows[0].email, 'VERIFY_EMAIL', 'Email verified', req);
            res.redirect('/login.html?verified=true');
        } else {
            res.redirect('/login.html?error=invalid_token');
        }
    } catch (err) {
        res.redirect('/login.html?error=verification_failed');
    }
});

app.post('/api/login', [
    body('email').isEmail().normalizeEmail(),
    body('password').notEmpty()
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
    }
    
    const { email, password } = req.body;
    
    try {
        const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        const user = result.rows[0];
        
        if (!user) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        if (user.locked_until && new Date(user.locked_until) > new Date()) {
            return res.status(401).json({ error: 'Account is temporarily locked. Try again later.' });
        }
        
        const valid = await bcrypt.compare(password, user.password);
        if (!valid) {
            const attempts = (user.failed_login_attempts || 0) + 1;
            const locked = attempts >= 5 ? new Date(Date.now() + 15 * 60000) : null;
            await pool.query('UPDATE users SET failed_login_attempts = $1, last_failed_login = $2, locked_until = $3 WHERE id = $4', 
                [attempts, new Date().toISOString(), locked, user.id]);
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
                return res.status(500).json({ error: 'Session error' });
            }
            
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
        consoleLog('ERROR', `Login error:`, err.message);
        res.status(500).json({ error: 'Login failed' });
    }
});

app.get('/api/check-session', async (req, res) => {
    if (req.session?.userId) {
        try {
            const result = await pool.query('SELECT email, username FROM users WHERE id = $1', [req.session.userId]);
            const user = result.rows[0];
            res.json({ authenticated: true, userId: req.session.userId, username: user?.username || req.session.username, email: user?.email || req.session.email });
        } catch (err) {
            res.json({ authenticated: true, username: req.session.username, email: req.session.email });
        }
    } else {
        res.json({ authenticated: false });
    }
});

app.post('/api/logout', (req, res) => {
    if (req.session.userId) {
        logUserActivity(req.session.userId, req.session.email, 'LOGOUT', 'User logged out', req);
    }
    req.session.destroy((err) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json({ success: true });
    });
});

app.post('/api/forgot-password', async (req, res) => {
    const { email } = req.body;
    
    try {
        const user = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
        if (user.rows.length === 0) {
            return res.status(404).json({ error: 'Email not found' });
        }
        
        const token = crypto.randomBytes(32).toString('hex');
        const expiry = new Date(Date.now() + 3600000);
        await pool.query('UPDATE users SET reset_token = $1, reset_token_expiry = $2 WHERE id = $3', [token, expiry, user.rows[0].id]);
        
        const resetLink = `${process.env.BASE_URL || `https://${req.get('host')}`}/reset-password.html?token=${token}`;
        if (emailConfigured) {
            const emailContent = getEmailTemplate(
                'Password Reset',
                'Click the button below to reset your password. This link expires in 1 hour.',
                'Reset Password',
                resetLink
            );
            sendEmail(email, 'Password Reset', emailContent);
        }
        
        res.json({ success: true, message: 'Password reset email sent' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/reset-password', async (req, res) => {
    const { token, newPassword } = req.body;
    
    const strength = checkPasswordStrength(newPassword);
    if (strength.score < 3) {
        return res.status(400).json({ error: 'Password too weak.' });
    }
    
    try {
        const user = await pool.query('SELECT id, email FROM users WHERE reset_token = $1 AND reset_token_expiry > NOW()', [token]);
        if (user.rows.length === 0) {
            return res.status(400).json({ error: 'Invalid or expired token' });
        }
        
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
        const result = await pool.query('SELECT reminder_interval, auto_reminders, email_notifications, push_notifications, timezone, theme FROM users WHERE id = $1', [req.session.userId]);
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
    
    try {
        await pool.query(
            `UPDATE users SET reminder_interval = COALESCE($1, reminder_interval), auto_reminders = COALESCE($2, auto_reminders),
             email_notifications = COALESCE($3, email_notifications), push_notifications = COALESCE($4, push_notifications),
             timezone = COALESCE($5, timezone), theme = COALESCE($6, theme), updated_at = NOW()
             WHERE id = $7`,
            [reminder_interval, auto_reminders ? 1 : 0, email_notifications ? 1 : 0, push_notifications ? 1 : 0, timezone, theme, req.session.userId]
        );
        await logUserActivity(req.session.userId, req.session.email, 'SETTINGS_UPDATED', 'Settings updated', req);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============ TASK ROUTES ============
app.get('/api/tasks', requireAuth, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT id, user_id, user_email, title, description, project, category, severity, priority, 
            deadline, scheduled_start, scheduled_end, completed, completed_at, tags, is_recurring, recurrence_pattern,
            recurrence_end_date, color, location, created_at, updated_at
            FROM tasks WHERE user_id = $1 AND (deleted_at IS NULL)
            ORDER BY CASE severity WHEN 'Critical' THEN 1 WHEN 'High' THEN 2 WHEN 'Medium' THEN 3 WHEN 'Low' THEN 4 END,
            deadline ASC NULLS LAST, scheduled_start ASC NULLS LAST
        `, [req.session.userId]);
        
        const formattedTasks = result.rows.map(task => ({
            ...task,
            deadline: formatTimestampForResponse(task.deadline),
            scheduled_start: formatTimestampForResponse(task.scheduled_start),
            scheduled_end: formatTimestampForResponse(task.scheduled_end),
            recurrence_end_date: formatTimestampForResponse(task.recurrence_end_date),
            completed_at: formatTimestampForResponse(task.completed_at),
            created_at: formatTimestampForResponse(task.created_at),
            updated_at: formatTimestampForResponse(task.updated_at)
        }));
        
        res.json(formattedTasks);
    } catch (err) {
        consoleLog('ERROR', `Failed to load tasks:`, err.message);
        res.json([]);
    }
});

app.get('/api/unscheduled-tasks', requireAuth, async (req, res) => {
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
        res.json(result.rows);
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
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/tasks', requireAuth, async (req, res) => {
    const { title, description, project, category, severity, priority, deadline, is_recurring, recurrence_pattern, recurrence_end_date, scheduled_start, scheduled_end, tags } = req.body;
    
    if (!title) {
        return res.status(400).json({ error: 'Task title is required' });
    }
    
    try {
        const safeDeadline = safeTimestamp(deadline);
        const safeScheduledStart = safeTimestamp(scheduled_start);
        const safeScheduledEnd = safeTimestamp(scheduled_end);
        const safeRecurrenceEnd = safeTimestamp(recurrence_end_date);
        
        const result = await pool.query(`
            INSERT INTO tasks (user_id, user_email, title, description, project, category, severity, priority, 
            deadline, is_recurring, recurrence_pattern, recurrence_end_date, scheduled_start, scheduled_end, tags, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW(), NOW()) RETURNING id
        `, [
            req.session.userId, req.session.email, title, description || null, project || null, category || null, 
            severity || 'Medium', priority || 2, safeDeadline, is_recurring ? 1 : 0, recurrence_pattern || null,
            safeRecurrenceEnd, safeScheduledStart, safeScheduledEnd, tags || null
        ]);
        
        const taskId = result.rows[0].id;
        
        // Handle recurring tasks
        if (is_recurring && recurrence_pattern && safeRecurrenceEnd) {
            await generateRecurringTasks(taskId, recurrence_pattern, safeRecurrenceEnd, req.session.userId);
        }
        
        // Create reminder if scheduled
        if (safeScheduledStart) {
            const reminderTime = new Date(new Date(safeScheduledStart).getTime() - 20 * 60 * 1000);
            await pool.query(`INSERT INTO reminders (user_id, user_email, task_id, reminder_time, reminder_type, created_at) 
                VALUES ($1, $2, $3, $4, 'scheduled', NOW())`, 
                [req.session.userId, req.session.email, taskId, reminderTime]);
        }
        
        await logUserActivity(req.session.userId, req.session.email, 'TASK_CREATED', `Task: ${title}`, req);
        res.json({ id: taskId, message: 'Task created successfully' });
        
    } catch (err) {
        consoleLog('ERROR', `Failed to create task:`, err.message);
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/tasks/:id', requireAuth, async (req, res) => {
    const taskId = req.params.id;
    const { title, description, project, category, severity, priority, deadline, scheduled_start, scheduled_end, completed, tags } = req.body;
    
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
        await pool.query(query, values);
        await logUserActivity(req.session.userId, req.session.email, 'TASK_UPDATED', `Task ID: ${taskId}`, req);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/tasks/:id', requireAuth, async (req, res) => {
    const taskId = req.params.id;
    try {
        const taskResult = await pool.query('SELECT title FROM tasks WHERE id = $1 AND user_id = $2', [taskId, req.session.userId]);
        await pool.query('UPDATE tasks SET deleted_at = NOW() WHERE id = $1 AND user_id = $2', [taskId, req.session.userId]);
        if (taskResult.rows[0]) {
            await logUserActivity(req.session.userId, req.session.email, 'TASK_DELETED', `Task: ${taskResult.rows[0].title}`, req);
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============ DEBUG ENDPOINTS ============
app.get('/api/debug-tasks', requireAuth, async (req, res) => {
    try {
        const tasksByUserId = await pool.query(`
            SELECT id, title, user_id, user_email, created_at, deleted_at, completed, scheduled_start, deadline
            FROM tasks WHERE user_id = $1 ORDER BY id DESC LIMIT 20
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
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/debug-schema', async (req, res) => {
    try {
        const tables = await pool.query(`
            SELECT table_name FROM information_schema.tables 
            WHERE table_schema = 'public' ORDER BY table_name
        `);
        res.json({ tables: tables.rows.map(t => t.table_name) });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/create-test-task', requireAuth, async (req, res) => {
    try {
        const testTitle = `Test Task ${new Date().toLocaleTimeString()}`;
        const result = await pool.query(`
            INSERT INTO tasks (user_id, user_email, title, description, severity, priority, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW()) RETURNING *
        `, [req.session.userId, req.session.email, testTitle, 'This is a test task', 'Medium', 2]);
        
        res.json({ success: true, message: 'Test task created', task: result.rows[0] });
    } catch (error) {
        res.status(500).json({ error: error.message });
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
            `INSERT INTO projects (user_id, user_email, name, description, color, status, progress, start_date, end_date, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW()) RETURNING id`,
            [req.session.userId, req.session.email, name, description, color, status || 'active', progress || 0, safeTimestamp(start_date), safeTimestamp(end_date)]
        );
        await logUserActivity(req.session.userId, req.session.email, 'PROJECT_CREATED', `Project: ${name}`, req);
        res.json({ id: result.rows[0].id, message: 'Project created' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/projects/:id', requireAuth, async (req, res) => {
    const projectId = req.params.id;
    const { name, description, color, status, progress, start_date, end_date } = req.body;
    try {
        await pool.query(
            `UPDATE projects SET name = COALESCE($1, name), description = COALESCE($2, description), color = COALESCE($3, color),
             status = COALESCE($4, status), progress = COALESCE($5, progress), start_date = COALESCE($6, start_date),
             end_date = COALESCE($7, end_date), updated_at = NOW() WHERE id = $8 AND user_id = $9`,
            [name, description, color, status, progress, safeTimestamp(start_date), safeTimestamp(end_date), projectId, req.session.userId]
        );
        await logUserActivity(req.session.userId, req.session.email, 'PROJECT_UPDATED', `Project ID: ${projectId}`, req);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/projects/:id', requireAuth, async (req, res) => {
    const projectId = req.params.id;
    try {
        await pool.query('DELETE FROM projects WHERE id = $1 AND user_id = $2', [projectId, req.session.userId]);
        await logUserActivity(req.session.userId, req.session.email, 'PROJECT_DELETED', `Project ID: ${projectId}`, req);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============ SUGGESTIONS ============
app.get('/api/suggestions', requireAuth, async (req, res) => {
    try {
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
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============ SHARING AND EXPORT ============
app.post('/api/share-schedule', requireAuth, async (req, res) => {
    const { shareWithEmail, shareType = 'view', format = 'pdf' } = req.body;
    const userEmail = req.session.email;
    const userId = req.session.userId;
    
    if (!shareWithEmail) {
        return res.status(400).json({ error: 'Recipient email is required' });
    }
    
    try {
        const recipientResult = await pool.query('SELECT id, email, username FROM users WHERE email = $1', [shareWithEmail]);
        if (recipientResult.rows.length === 0) {
            return res.status(404).json({ error: 'Recipient email not found in TaskWeaver' });
        }
        
        const recipient = recipientResult.rows[0];
        const shareToken = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
        
        await pool.query(
            `INSERT INTO shared_schedules (user_id, user_email, share_with_email, share_token, share_type, expires_at, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
            [userId, userEmail, shareWithEmail, shareToken, shareType, expiresAt]
        );
        
        const tasksResult = await pool.query(
            `SELECT * FROM tasks WHERE user_id = $1 AND deleted_at IS NULL ORDER BY scheduled_start ASC, deadline ASC`,
            [userId]
        );
        const tasks = tasksResult.rows;
        const userResult = await pool.query('SELECT username, email FROM users WHERE id = $1', [userId]);
        const user = userResult.rows[0];
        
        const shareLink = `${process.env.BASE_URL || `https://${req.get('host')}`}/api/view-shared-schedule?token=${shareToken}`;
        
        // Generate attachment based on format
        let attachmentBuffer = null;
        let contentType = '';
        let filename = '';
        
        if (format === 'pdf') {
            attachmentBuffer = await generateProfessionalPDF(tasks, user, shareToken);
            contentType = 'application/pdf';
            filename = `schedule_${user.username}_${moment().format('YYYY-MM-DD')}.pdf`;
        } else if (format === 'excel') {
            attachmentBuffer = await generateAdvancedExcel(tasks, user);
            contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
            filename = `schedule_${user.username}_${moment().format('YYYY-MM-DD')}.xlsx`;
        } else if (format === 'word') {
            attachmentBuffer = await generateWordDocument(tasks, user);
            contentType = 'application/msword';
            filename = `schedule_${user.username}_${moment().format('YYYY-MM-DD')}.doc`;
        } else if (format === 'csv') {
            const csvData = generateCSV(tasks);
            attachmentBuffer = Buffer.from(csvData);
            contentType = 'text/csv';
            filename = `schedule_${user.username}_${moment().format('YYYY-MM-DD')}.csv`;
        } else if (format === 'ical') {
            const icalData = generateICalendar(tasks);
            attachmentBuffer = Buffer.from(icalData);
            contentType = 'text/calendar';
            filename = `schedule_${user.username}_${moment().format('YYYY-MM-DD')}.ics`;
        }
        
        // Generate QR code
        const qrCodeBuffer = await QRCode.toBuffer(shareLink, { width: 200 });
        
        const emailContent = getShareEmailTemplate(
            user.username, user.email, recipient.username || recipient.email, 
            tasks.length, shareType, expiresAt, shareLink
        );
        
        if (emailConfigured) {
            const attachments = [];
            if (attachmentBuffer) {
                attachments.push({
                    filename,
                    content: attachmentBuffer.toString('base64'),
                    contentType,
                    disposition: 'attachment'
                });
            }
            attachments.push({
                filename: 'qr_code.png',
                content: qrCodeBuffer.toString('base64'),
                contentType: 'image/png',
                disposition: 'attachment'
            });
            
            await sendEmail(shareWithEmail, `📅 ${user.username} shared their schedule with you`, emailContent, attachments);
        }
        
        await logUserActivity(userId, userEmail, 'SHARE_SCHEDULE', `Shared with ${shareWithEmail} as ${format}`, req);
        res.json({ success: true, message: `Schedule shared with ${shareWithEmail}`, shareLink, expiresAt });
    } catch (err) {
        consoleLog('ERROR', `Share schedule error:`, err.message);
        res.status(500).json({ error: err.message });
    }
});

function getShareEmailTemplate(senderName, senderEmail, recipientName, taskCount, shareType, expiresAt, shareLink) {
    return `
        <!DOCTYPE html>
        <html>
        <head><meta charset="UTF-8"><title>Schedule Shared with You</title></head>
        <body style="font-family: Arial, sans-serif;">
            <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
                <div style="background: linear-gradient(135deg, #667eea, #764ba2); padding: 30px; text-align: center; border-radius: 12px;">
                    <h1 style="color: white;">⚡ TaskWeaver</h1>
                </div>
                <h2>Hello ${recipientName}! 👋</h2>
                <p><strong>${senderName}</strong> (${senderEmail}) has shared their schedule with you.</p>
                <div style="background: #f7fafc; padding: 15px; border-radius: 8px; margin: 20px 0;">
                    <strong>Schedule Details:</strong><br>
                    Total Tasks: ${taskCount}<br>
                    Share Type: ${shareType}<br>
                    Expires: ${new Date(expiresAt).toLocaleString()}
                </div>
                <div style="text-align: center;">
                    <a href="${shareLink}" style="display: inline-block; background: linear-gradient(135deg, #667eea, #764ba2); color: white; padding: 12px 30px; text-decoration: none; border-radius: 8px;">📅 View Schedule Online</a>
                </div>
                <hr>
                <small>This link expires in 24 hours. All access is logged and monitored.</small>
            </div>
        </body>
        </html>
    `;
}

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
        
        await pool.query('UPDATE shared_schedules SET access_count = access_count + 1, last_accessed = NOW() WHERE id = $1', [share.id]);
        
        const tasksResult = await pool.query(
            `SELECT * FROM tasks WHERE user_id = $1 AND deleted_at IS NULL ORDER BY scheduled_start ASC, deadline ASC`,
            [share.user_id]
        );
        const tasks = tasksResult.rows;
        const userResult = await pool.query('SELECT username, email FROM users WHERE id = $1', [share.user_id]);
        const user = userResult.rows[0];
        
        if (format === 'json') {
            res.json({ sharedBy: share.user_email, tasks, shareType: share.share_type, expiresAt: share.expires_at });
        } else if (format === 'pdf') {
            const pdfBuffer = await generateProfessionalPDF(tasks, user, token);
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename=shared_schedule_${user.username}.pdf`);
            res.send(pdfBuffer);
        } else if (format === 'excel') {
            const excelBuffer = await generateAdvancedExcel(tasks, user);
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', `attachment; filename=shared_schedule_${user.username}.xlsx`);
            res.send(excelBuffer);
        } else if (format === 'word') {
            const wordBuffer = await generateWordDocument(tasks, user);
            res.setHeader('Content-Type', 'application/msword');
            res.setHeader('Content-Disposition', `attachment; filename=shared_schedule_${user.username}.doc`);
            res.send(wordBuffer);
        } else if (format === 'csv') {
            const csvData = generateCSV(tasks);
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', `attachment; filename=shared_schedule_${user.username}.csv`);
            res.send(csvData);
        } else if (format === 'ical') {
            const icalData = generateICalendar(tasks);
            res.setHeader('Content-Type', 'text/calendar');
            res.setHeader('Content-Disposition', `attachment; filename=shared_schedule_${user.username}.ics`);
            res.send(icalData);
        } else {
            res.status(400).json({ error: 'Invalid format' });
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
    
    try {
        const result = await pool.query(
            `SELECT * FROM tasks WHERE user_id = $1 AND deleted_at IS NULL ORDER BY scheduled_start ASC, deadline ASC`,
            [userId]
        );
        const tasks = result.rows;
        const user = { email: userEmail, username: req.session.username };
        
        await logUserActivity(userId, userEmail, 'EXPORT_SCHEDULE', `Exported schedule as ${format}`, req);
        
        if (format === 'json') {
            res.json(tasks);
        } else if (format === 'pdf') {
            const pdfBuffer = await generateProfessionalPDF(tasks, user);
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename=my_schedule_${moment().format('YYYY-MM-DD')}.pdf`);
            res.send(pdfBuffer);
        } else if (format === 'excel') {
            const excelBuffer = await generateAdvancedExcel(tasks, user);
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', `attachment; filename=my_schedule_${moment().format('YYYY-MM-DD')}.xlsx`);
            res.send(excelBuffer);
        } else if (format === 'word') {
            const wordBuffer = await generateWordDocument(tasks, user);
            res.setHeader('Content-Type', 'application/msword');
            res.setHeader('Content-Disposition', `attachment; filename=my_schedule_${moment().format('YYYY-MM-DD')}.doc`);
            res.send(wordBuffer);
        } else if (format === 'csv') {
            const csvData = generateCSV(tasks);
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', `attachment; filename=my_schedule_${moment().format('YYYY-MM-DD')}.csv`);
            res.send(csvData);
        } else {
            res.status(400).json({ error: 'Invalid format' });
        }
    } catch (err) {
        consoleLog('ERROR', `Export schedule error:`, err.message);
        res.status(500).json({ error: err.message });
    }
});

// ============ STATISTICS ============
app.get('/api/user-stats', requireAuth, async (req, res) => {
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
            FROM tasks WHERE user_id = $1 AND deleted_at IS NULL
        `, [req.session.userId]);
        
        res.json(result.rows[0]);
    } catch (err) {
        res.json({
            completed_tasks: 0, scheduled_tasks: 0, unscheduled_tasks: 0,
            critical_tasks: 0, high_priority_tasks: 0, overdue_tasks: 0, tasks_this_week: 0
        });
    }
});

app.get('/api/activity', requireAuth, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM activity_log WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50', [req.session.userId]);
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
        res.json({
            status: 'ok',
            database: 'connected',
            email: emailConfigured ? 'configured' : 'disabled',
            userCount: parseInt(users.rows[0].count),
            taskCount: parseInt(tasks.rows[0].count),
            projectCount: parseInt(projects.rows[0].count),
            environment: process.env.NODE_ENV,
            port: port,
            nodeVersion: process.version
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============ REMINDER SYSTEM ============
async function checkScheduledReminders() {
    if (!dbConnected || !emailConfigured) return;
    
    try {
        const result = await pool.query(`
            SELECT r.*, t.title, t.description, t.user_id, t.user_email, u.email_notifications
            FROM reminders r
            JOIN tasks t ON r.task_id = t.id
            JOIN users u ON r.user_id = u.id
            WHERE r.reminder_time <= NOW() AND r.sent = 0 AND u.email_notifications = 1 
            AND t.completed = 0 AND t.deleted_at IS NULL
        `);
        
        for (const reminder of result.rows) {
            const emailContent = getEmailTemplate(
                `Reminder: ${reminder.title}`,
                `<div class="info-box"><strong>Task Details:</strong><br>Title: ${reminder.title}<br>
                ${reminder.description ? `Description: ${reminder.description}<br>` : ''}
                Reminder Time: ${moment(reminder.reminder_time).format('MMMM Do YYYY, h:mm a')}<br></div>
                <p>Stay focused and complete your task on time! 💪</p>`
            );
            
            try {
                await sendEmail(reminder.user_email, `🔔 Task Reminder: ${reminder.title}`, emailContent);
                await pool.query('UPDATE reminders SET sent = 1, sent_at = NOW() WHERE id = $1', [reminder.id]);
                await pool.query('UPDATE tasks SET reminder_count = reminder_count + 1, last_reminder_sent = NOW() WHERE id = $1', [reminder.task_id]);
                await logEmailSent(reminder.user_id, reminder.user_email, reminder.user_email, `Reminder: ${reminder.title}`, 'success');
                consoleLog('SUCCESS', `Reminder sent to ${reminder.user_email}: ${reminder.title}`);
            } catch (error) {
                await logEmailSent(reminder.user_id, reminder.user_email, reminder.user_email, `Reminder: ${reminder.title}`, 'failed', error);
                await pool.query('UPDATE reminders SET retry_count = retry_count + 1, last_error = $1 WHERE id = $2', [error.message, reminder.id]);
            }
        }
    } catch (err) {
        consoleLog('ERROR', 'Error checking reminders:', err.message);
    }
}

async function checkDeadlineReminders() {
    if (!dbConnected || !emailConfigured) return;
    
    try {
        const result = await pool.query(`
            SELECT t.*, u.email as user_email, u.email_notifications
            FROM tasks t JOIN users u ON t.user_id = u.id
            WHERE t.completed = 0 AND t.deadline IS NOT NULL AND t.deadline_reminder_sent = 0
            AND u.email_notifications = 1 AND EXTRACT(EPOCH FROM (t.deadline - NOW())) / 3600 <= 24 
            AND t.deadline > NOW()
        `);
        
        for (const task of result.rows) {
            const hoursLeft = Math.ceil((new Date(task.deadline) - new Date()) / (1000 * 3600));
            const emailContent = getEmailTemplate(
                `⚠️ Deadline Approaching: ${task.title}`,
                `<div class="info-box"><strong>Urgent Task Reminder</strong><br>
                Title: ${task.title}<br>
                Deadline: ${moment(task.deadline).format('MMMM Do YYYY, h:mm a')}<br>
                Time Remaining: ${hoursLeft} hours<br></div>
                <p>Don't forget to complete this task before the deadline! 🚀</p>`
            );
            
            try {
                await sendEmail(task.user_email, `⚠️ DEADLINE APPROACHING: ${task.title}`, emailContent);
                await pool.query('UPDATE tasks SET deadline_reminder_sent = 1 WHERE id = $1', [task.id]);
                await logEmailSent(task.user_id, task.user_email, task.user_email, `Deadline: ${task.title}`, 'success');
                consoleLog('SUCCESS', `Deadline reminder sent to ${task.user_email}: ${task.title}`);
            } catch (error) {
                await logEmailSent(task.user_id, task.user_email, task.user_email, `Deadline: ${task.title}`, 'failed', error);
            }
        }
    } catch (err) {
        consoleLog('ERROR', 'Error checking deadline reminders:', err.message);
    }
}

async function checkOverdueTasks() {
    if (!dbConnected || !emailConfigured) return;
    
    try {
        const result = await pool.query(`
            SELECT t.*, u.email as user_email, u.email_notifications
            FROM tasks t JOIN users u ON t.user_id = u.id
            WHERE t.completed = 0 AND t.deadline IS NOT NULL AND t.deadline < NOW()
            AND t.overdue_reminder_sent = 0 AND u.email_notifications = 1
        `);
        
        for (const task of result.rows) {
            const daysOverdue = Math.floor((new Date() - new Date(task.deadline)) / (1000 * 3600 * 24));
            const emailContent = getEmailTemplate(
                `⚠️ OVERDUE TASK: ${task.title}`,
                `<div class="info-box"><strong>Overdue Task Alert</strong><br>
                Title: ${task.title}<br>
                Original Deadline: ${moment(task.deadline).format('MMMM Do YYYY, h:mm a')}<br>
                Days Overdue: ${daysOverdue}<br></div>
                <p>Please address this overdue task as soon as possible! ⚠️</p>`
            );
            
            try {
                await sendEmail(task.user_email, `⚠️ OVERDUE TASK: ${task.title}`, emailContent);
                await pool.query('UPDATE tasks SET overdue_reminder_sent = 1 WHERE id = $1', [task.id]);
                await logEmailSent(task.user_id, task.user_email, task.user_email, `Overdue: ${task.title}`, 'success');
                consoleLog('SUCCESS', `Overdue alert sent to ${task.user_email}: ${task.title}`);
            } catch (error) {
                await logEmailSent(task.user_id, task.user_email, task.user_email, `Overdue: ${task.title}`, 'failed', error);
            }
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

// ============ DATABASE INITIALIZATION WITH ALL TABLES ============
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
                preferences JSONB DEFAULT '{}',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_login TIMESTAMP
            )
        `);
        consoleLog('SUCCESS', 'Users table ready');
        
        // Tasks table with recurrence support
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
                recurrence_parent_id INTEGER,
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
                attachments JSONB DEFAULT '[]',
                subtasks JSONB DEFAULT '[]',
                dependencies JSONB DEFAULT '[]',
                color TEXT,
                location TEXT,
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
                share_token TEXT UNIQUE NOT NULL,
                share_type TEXT DEFAULT 'view',
                expires_at TIMESTAMP NOT NULL,
                access_count INTEGER DEFAULT 0,
                last_accessed TIMESTAMP,
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
        
        // Timestamp validation trigger
        await client.query(`
            CREATE OR REPLACE FUNCTION validate_task_timestamps()
            RETURNS TRIGGER AS $$
            BEGIN
                NEW.deadline := CASE WHEN NEW.deadline IS NULL OR NEW.deadline::text IN ('', 'null', 'undefined', 'Invalid Date') THEN NULL ELSE NEW.deadline END;
                NEW.scheduled_start := CASE WHEN NEW.scheduled_start IS NULL OR NEW.scheduled_start::text IN ('', 'null', 'undefined', 'Invalid Date') THEN NULL ELSE NEW.scheduled_start END;
                NEW.scheduled_end := CASE WHEN NEW.scheduled_end IS NULL OR NEW.scheduled_end::text IN ('', 'null', 'undefined', 'Invalid Date') THEN NULL ELSE NEW.scheduled_end END;
                NEW.completed_at := CASE WHEN NEW.completed_at IS NULL OR NEW.completed_at::text IN ('', 'null', 'undefined', 'Invalid Date') THEN NULL ELSE NEW.completed_at END;
                NEW.recurrence_end_date := CASE WHEN NEW.recurrence_end_date IS NULL OR NEW.recurrence_end_date::text IN ('', 'null', 'undefined', 'Invalid Date') THEN NULL ELSE NEW.recurrence_end_date END;
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
        consoleLog('SUCCESS', 'Timestamp validation triggers created');
        
        // Create indexes
        const indexQueries = [
            'CREATE INDEX IF NOT EXISTS idx_tasks_user_id ON tasks(user_id)',
            'CREATE INDEX IF NOT EXISTS idx_tasks_user_email ON tasks(user_email)',
            'CREATE INDEX IF NOT EXISTS idx_tasks_scheduled_start ON tasks(scheduled_start)',
            'CREATE INDEX IF NOT EXISTS idx_tasks_deadline ON tasks(deadline)',
            'CREATE INDEX IF NOT EXISTS idx_tasks_completed ON tasks(completed)',
            'CREATE INDEX IF NOT EXISTS idx_tasks_recurring ON tasks(is_recurring)',
            'CREATE INDEX IF NOT EXISTS idx_reminders_reminder_time ON reminders(reminder_time)',
            'CREATE INDEX IF NOT EXISTS idx_reminders_sent ON reminders(sent)',
            'CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)',
            'CREATE INDEX IF NOT EXISTS idx_shared_schedules_token ON shared_schedules(share_token)',
            'CREATE INDEX IF NOT EXISTS idx_shared_schedules_expires ON shared_schedules(expires_at)'
        ];
        
        for (const query of indexQueries) {
            try {
                await client.query(query);
            } catch (err) {
                consoleLog('WARNING', `Index creation skipped: ${err.message}`);
            }
        }
        consoleLog('SUCCESS', 'All indexes created');
        
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
            consoleLog('SUCCESS', `║  Email: ${emailConfigured ? '✓ CONFIGURED'.padEnd(52) : '✗ DISABLED'.padEnd(52)}║`);
            consoleLog('SUCCESS', `╠══════════════════════════════════════════════════════════════╣`);
            consoleLog('SUCCESS', `║  ✨ ALL FEATURES ACTIVE:                                      ║`);
            consoleLog('SUCCESS', `║    ✓ Task Management (CRUD)                                   ║`);
            consoleLog('SUCCESS', `║    ✓ Project Management                                      ║`);
            consoleLog('SUCCESS', `║    ✓ Reminder System (every minute)                          ║`);
            consoleLog('SUCCESS', `║    ✓ Schedule Sharing (PDF/Excel/Word/CSV/iCal)              ║`);
            consoleLog('SUCCESS', `║    ✓ Professional PDF with Letterhead                        ║`);
            consoleLog('SUCCESS', `║    ✓ Recurring Tasks (Daily/Weekly/Monthly/Yearly)           ║`);
            consoleLog('SUCCESS', `║    ✓ QR Code Generation                                      ║`);
            consoleLog('SUCCESS', `║    ✓ 24-Hour Expiring Share Links                            ║`);
            consoleLog('SUCCESS', `║    ✓ Security Headers & Rate Limiting                        ║`);
            consoleLog('SUCCESS', `║    ✓ Activity Logging & Email Tracking                       ║`);
            consoleLog('SUCCESS', `║    ✓ Password Strength Checker                               ║`);
            consoleLog('SUCCESS', `║    ✓ Session Management                                      ║`);
            consoleLog('SUCCESS', `║    ✓ Auto-Timestamp Fixing                                   ║`);
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