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
const { body, validationResult, param, query } = require('express-validator');
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

// ============ CORS ============
const allowedOrigins = process.env.NODE_ENV === 'production'
    ? ['https://taskweaver.onrender.com', 'https://taskweaver-app.onrender.com']
    : ['http://localhost:3000', 'http://localhost:5500', 'http://localhost:5501'];

app.use(cors({
    origin: function (origin, callback) {
        if (!origin) return callback(null, true);
        if (allowedOrigins.indexOf(origin) !== -1) {
            return callback(null, true);
        }
        if (process.env.NODE_ENV === 'production' && origin && origin.includes('onrender.com')) {
            return callback(null, true);
        }
        logger.warn(`CORS blocked: ${origin}`);
        callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'X-Requested-With', 'Cookie']
}));

app.options('*', cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));

// ============ STATIC FILES ============
app.use(express.static(path.join(__dirname, 'public')));
app.use('/shared', express.static(path.join(__dirname, 'public/shared')));

// ============ HELPER FUNCTIONS ============
function safeTimestamp(value) {
    if (!value || value === '' || value === 'null' || value === 'undefined' || value === 'Invalid Date') {
        return null;
    }
    try {
        const date = new Date(value);
        if (isNaN(date.getTime())) return null;
        return date.toISOString();
    } catch (err) {
        logger.error('Timestamp conversion error:', err);
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
                Keywords: 'tasks, schedule, productivity',
                Creator: 'TaskWeaver',
                Producer: 'TaskWeaver Professional Suite'
            }
        });
        
        const buffers = [];
        doc.on('data', buffers.push.bind(buffers));
        doc.on('end', () => resolve(Buffer.concat(buffers)));
        doc.on('error', reject);
        
        // Header with gradient effect
        const gradient = doc.linearGradient(0, 0, doc.page.width, 80);
        gradient.stop(0, '#667eea');
        gradient.stop(1, '#764ba2');
        doc.rect(0, 0, doc.page.width, 120).fill(gradient);
        
        // Logo and Title
        doc.fontSize(32)
           .fillColor('#ffffff')
           .font('Helvetica-Bold')
           .text('⚡ TaskWeaver', 50, 35);
        
        doc.fontSize(12)
           .fillColor('#f0f0f0')
           .font('Helvetica')
           .text('Professional Schedule Report', 50, 75);
        
        // Decorative line
        doc.strokeColor('#ffffff')
           .lineWidth(2)
           .moveTo(50, 95)
           .lineTo(doc.page.width - 50, 95)
           .stroke();
        
        // Company Info
        doc.fontSize(8)
           .fillColor('#ffffff')
           .text('© 2025 TaskWeaver Inc. | weaving@taskweaver.com | www.taskweaver.com', 50, 105, {
               align: 'center',
               width: doc.page.width - 100
           });
        
        // Main Content Area
        let y = 150;
        
        // Report Metadata
        doc.fillColor('#2d3748')
           .fontSize(18)
           .font('Helvetica-Bold')
           .text('Schedule Overview', 50, y);
        y += 30;
        
        const metadataBox = {
            x: 50,
            y: y,
            width: doc.page.width - 100,
            height: 100
        };
        
        doc.rect(metadataBox.x, metadataBox.y, metadataBox.width, metadataBox.height)
           .fill('#f7fafc')
           .stroke('#e2e8f0');
        
        doc.fillColor('#4a5568')
           .fontSize(10)
           .font('Helvetica');
        
        doc.text(`Generated for: ${user.email}`, 70, y + 10);
        doc.text(`Generated on: ${moment().format('MMMM Do YYYY, h:mm:ss a')}`, 70, y + 25);
        doc.text(`Report ID: ${uuidv4().substring(0, 8).toUpperCase()}`, 70, y + 40);
        doc.text(`Total Tasks: ${tasks.length}`, 70, y + 55);
        
        if (shareToken) {
            doc.text(`Shared via: Secure Link (Valid 24h)`, 70, y + 70);
        }
        
        y += 120;
        
        // Statistics Section
        const stats = {
            completed: tasks.filter(t => t.completed).length,
            pending: tasks.filter(t => !t.completed).length,
            critical: tasks.filter(t => t.severity === 'Critical' && !t.completed).length,
            overdue: tasks.filter(t => t.deadline && new Date(t.deadline) < new Date() && !t.completed).length
        };
        
        doc.fillColor('#2d3748')
           .fontSize(14)
           .font('Helvetica-Bold')
           .text('Statistics', 50, y);
        y += 25;
        
        const statsBox = {
            x: 50,
            y: y,
            width: doc.page.width - 100,
            height: 80
        };
        
        doc.rect(statsBox.x, statsBox.y, statsBox.width, statsBox.height)
           .fill('#edf2f7')
           .stroke('#cbd5e0');
        
        const statsText = [
            `✓ Completed: ${stats.completed}`,
            `⏳ Pending: ${stats.pending}`,
            `⚠️ Critical: ${stats.critical}`,
            `🔴 Overdue: ${stats.overdue}`
        ];
        
        let statsX = 70;
        statsText.forEach((text, i) => {
            doc.fillColor('#2d3748')
               .fontSize(10)
               .text(text, statsX + (i * 120), y + 10);
        });
        
        y += 100;
        
        // Tasks Section
        doc.fillColor('#2d3748')
           .fontSize(14)
           .font('Helvetica-Bold')
           .text('Task Details', 50, y);
        y += 25;
        
        // Table Header
        const tableTop = y;
        const colWidths = [30, 180, 100, 80, 80, 80];
        
        doc.fillColor('#667eea')
           .fontSize(9)
           .font('Helvetica-Bold');
        
        doc.text('#', 50, tableTop);
        doc.text('Task Title', 80, tableTop);
        doc.text('Project', 260, tableTop);
        doc.text('Severity', 360, tableTop);
        doc.text('Deadline', 440, tableTop);
        doc.text('Status', 520, tableTop);
        
        doc.strokeColor('#cbd5e0')
           .lineWidth(0.5)
           .moveTo(50, tableTop + 15)
           .lineTo(doc.page.width - 50, tableTop + 15)
           .stroke();
        
        y = tableTop + 25;
        
        // Table Rows
        tasks.forEach((task, index) => {
            if (y > doc.page.height - 100) {
                doc.addPage();
                y = 50;
                
                // Repeat header on new page
                doc.fillColor('#667eea')
                   .fontSize(9)
                   .font('Helvetica-Bold');
                doc.text('#', 50, y);
                doc.text('Task Title', 80, y);
                doc.text('Project', 260, y);
                doc.text('Severity', 360, y);
                doc.text('Deadline', 440, y);
                doc.text('Status', 520, y);
                doc.strokeColor('#cbd5e0')
                   .lineWidth(0.5)
                   .moveTo(50, y + 15)
                   .lineTo(doc.page.width - 50, y + 15)
                   .stroke();
                y += 25;
            }
            
            const rowColor = index % 2 === 0 ? '#ffffff' : '#f8fafc';
            doc.rect(50, y - 8, doc.page.width - 100, 20)
               .fill(rowColor);
            
            doc.fillColor('#2d3748')
               .fontSize(8)
               .font('Helvetica');
            
            doc.text((index + 1).toString(), 50, y);
            doc.text(sanitizeInput(task.title).substring(0, 40), 80, y);
            doc.text(sanitizeInput(task.project || '-').substring(0, 15), 260, y);
            
            const severityColor = task.severity === 'Critical' ? '#f56565' : 
                                 task.severity === 'High' ? '#ed8936' : '#48bb78';
            doc.fillColor(severityColor)
               .text(task.severity || 'Medium', 360, y);
            
            doc.fillColor('#4a5568')
               .text(task.deadline ? moment(task.deadline).format('MMM DD, HH:mm') : '-', 440, y);
            
            const statusText = task.completed ? '✓ Completed' : '⏳ Pending';
            const statusColor = task.completed ? '#48bb78' : '#ed8936';
            doc.fillColor(statusColor)
               .text(statusText, 520, y);
            
            y += 22;
        });
        
        // Footer with QR Code
        const footerY = doc.page.height - 50;
        if (shareToken) {
            const qrData = `${process.env.BASE_URL || 'https://taskweaver.onrender.com'}/api/view-shared-schedule?token=${shareToken}`;
            QRCode.toBuffer(qrData, { width: 100 }, (err, buffer) => {
                if (!err) {
                    doc.image(buffer, doc.page.width - 120, footerY - 40, { width: 80 });
                }
            });
        }
        
        doc.fontSize(8)
           .fillColor('#718096')
           .text('This is a computer-generated document. No signature required.', 50, footerY, {
               align: 'center',
               width: doc.page.width - 100
           });
        
        doc.end();
    });
}

// ============ ADVANCED EXCEL GENERATION ============
async function generateAdvancedExcel(tasks, user) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'TaskWeaver';
    workbook.lastModifiedBy = user.email;
    workbook.created = new Date();
    workbook.modified = new Date();
    
    // Main Schedule Sheet
    const scheduleSheet = workbook.addWorksheet('Schedule', {
        pageSetup: { paperSize: 9, orientation: 'landscape' }
    });
    
    // Header with styling
    scheduleSheet.mergeCells('A1:J1');
    const titleCell = scheduleSheet.getCell('A1');
    titleCell.value = '⚡ TaskWeaver - Professional Schedule Report';
    titleCell.font = { size: 20, bold: true, color: { argb: 'FFFFFFFF' } };
    titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF667EEA' } };
    titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
    scheduleSheet.getRow(1).height = 40;
    
    scheduleSheet.mergeCells('A2:J2');
    const dateCell = scheduleSheet.getCell('A2');
    dateCell.value = `Generated for: ${user.email} on ${moment().format('MMMM Do YYYY, h:mm:ss a')}`;
    dateCell.font = { italic: true, color: { argb: 'FF4A5568' } };
    dateCell.alignment = { horizontal: 'center' };
    
    // Columns
    scheduleSheet.columns = [
        { header: '#', key: 'index', width: 6 },
        { header: 'Task Title', key: 'title', width: 35 },
        { header: 'Description', key: 'description', width: 45 },
        { header: 'Project', key: 'project', width: 20 },
        { header: 'Category', key: 'category', width: 15 },
        { header: 'Severity', key: 'severity', width: 12 },
        { header: 'Priority', key: 'priority', width: 10 },
        { header: 'Scheduled Start', key: 'scheduled_start', width: 20 },
        { header: 'Deadline', key: 'deadline', width: 20 },
        { header: 'Status', key: 'status', width: 12 },
        { header: 'Completion Date', key: 'completed_at', width: 20 },
        { header: 'Tags', key: 'tags', width: 20 }
    ];
    
    // Header styling
    const headerRow = scheduleSheet.getRow(4);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF667EEA' } };
    headerRow.alignment = { horizontal: 'center', vertical: 'middle' };
    
    // Data rows
    tasks.forEach((task, index) => {
        const row = scheduleSheet.addRow({
            index: index + 1,
            title: sanitizeInput(task.title),
            description: sanitizeInput(task.description || ''),
            project: sanitizeInput(task.project || ''),
            category: task.category || '',
            severity: task.severity || 'Medium',
            priority: task.priority || 2,
            scheduled_start: task.scheduled_start ? moment(task.scheduled_start).format('MMM DD, YYYY HH:mm') : '',
            deadline: task.deadline ? moment(task.deadline).format('MMM DD, YYYY HH:mm') : '',
            status: task.completed ? 'Completed' : 'Pending',
            completed_at: task.completed_at ? moment(task.completed_at).format('MMM DD, YYYY HH:mm') : '',
            tags: task.tags || ''
        });
        
        // Color coding based on severity
        const severityColors = {
            'Critical': 'FFFF6B6B',
            'High': 'FFFFA07A',
            'Medium': 'FF98FB98',
            'Low': 'FFE0E0E0'
        };
        
        const rowColor = severityColors[task.severity] || 'FFFFFFFF';
        row.eachCell(cell => {
            cell.fill = {
                type: 'pattern',
                pattern: 'solid',
                fgColor: { argb: rowColor }
            };
        });
    });
    
    // Statistics Sheet
    const statsSheet = workbook.addWorksheet('Statistics');
    
    const stats = {
        'Total Tasks': tasks.length,
        'Completed Tasks': tasks.filter(t => t.completed).length,
        'Pending Tasks': tasks.filter(t => !t.completed).length,
        'Completion Rate': `${((tasks.filter(t => t.completed).length / tasks.length) * 100 || 0).toFixed(1)}%`,
        'Critical Tasks': tasks.filter(t => t.severity === 'Critical').length,
        'High Priority': tasks.filter(t => t.severity === 'High').length,
        'Overdue Tasks': tasks.filter(t => t.deadline && new Date(t.deadline) < new Date() && !t.completed).length,
        'Tasks This Week': tasks.filter(t => t.created_at && moment(t.created_at).isAfter(moment().subtract(7, 'days'))).length
    };
    
    let rowIndex = 1;
    Object.entries(stats).forEach(([key, value]) => {
        statsSheet.getCell(`A${rowIndex}`).value = key;
        statsSheet.getCell(`B${rowIndex}`).value = value;
        statsSheet.getCell(`A${rowIndex}`).font = { bold: true };
        rowIndex++;
    });
    
    return await workbook.xlsx.writeBuffer();
}

// ============ WORD DOCUMENT GENERATION ============
async function generateWordDocument(tasks, user) {
    const html = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <title>TaskWeaver Schedule Report</title>
            <style>
                body {
                    font-family: 'Segoe UI', Arial, sans-serif;
                    margin: 40px;
                    color: #2d3748;
                    line-height: 1.6;
                }
                .header {
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    padding: 40px;
                    border-radius: 12px;
                    margin-bottom: 30px;
                    text-align: center;
                }
                .header h1 {
                    color: white;
                    margin: 0;
                    font-size: 28px;
                }
                .header p {
                    color: rgba(255,255,255,0.9);
                    margin: 10px 0 0;
                }
                .metadata {
                    background: #f7fafc;
                    padding: 20px;
                    border-radius: 8px;
                    margin-bottom: 30px;
                    border-left: 4px solid #667eea;
                }
                .stats {
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
                    gap: 20px;
                    margin-bottom: 30px;
                }
                .stat-card {
                    background: #f7fafc;
                    padding: 15px;
                    border-radius: 8px;
                    text-align: center;
                }
                .stat-value {
                    font-size: 24px;
                    font-weight: bold;
                    color: #667eea;
                }
                table {
                    width: 100%;
                    border-collapse: collapse;
                    margin-top: 20px;
                }
                th, td {
                    border: 1px solid #e2e8f0;
                    padding: 12px;
                    text-align: left;
                }
                th {
                    background: #667eea;
                    color: white;
                }
                .completed {
                    background-color: #c6f6d5;
                }
                .critical {
                    background-color: #fed7d7;
                }
                .footer {
                    margin-top: 40px;
                    padding-top: 20px;
                    border-top: 1px solid #e2e8f0;
                    text-align: center;
                    font-size: 12px;
                    color: #718096;
                }
            </style>
        </head>
        <body>
            <div class="header">
                <h1>⚡ TaskWeaver Professional Report</h1>
                <p>Your Intelligent Task Management Solution</p>
            </div>
            
            <div class="metadata">
                <strong>Generated for:</strong> ${user.email}<br>
                <strong>Generated on:</strong> ${moment().format('MMMM Do YYYY, h:mm:ss a')}<br>
                <strong>Report ID:</strong> ${uuidv4().substring(0, 8).toUpperCase()}<br>
                <strong>Total Tasks:</strong> ${tasks.length}
            </div>
            
            <div class="stats">
                <div class="stat-card">
                    <div class="stat-value">${tasks.filter(t => t.completed).length}</div>
                    <div>Completed Tasks</div>
                </div>
                <div class="stat-card">
                    <div class="stat-value">${tasks.filter(t => !t.completed).length}</div>
                    <div>Pending Tasks</div>
                </div>
                <div class="stat-card">
                    <div class="stat-value">${tasks.filter(t => t.severity === 'Critical').length}</div>
                    <div>Critical Tasks</div>
                </div>
                <div class="stat-card">
                    <div class="stat-value">${((tasks.filter(t => t.completed).length / tasks.length) * 100 || 0).toFixed(1)}%</div>
                    <div>Completion Rate</div>
                </div>
            </div>
            
            <h2>Task Details</h2>
            <table>
                <thead>
                    <tr>
                        <th>#</th>
                        <th>Task Title</th>
                        <th>Project</th>
                        <th>Severity</th>
                        <th>Deadline</th>
                        <th>Status</th>
                    </tr>
                </thead>
                <tbody>
                    ${tasks.map((task, index) => `
                        <tr class="${task.completed ? 'completed' : ''} ${task.severity === 'Critical' && !task.completed ? 'critical' : ''}">
                            <td>${index + 1}</td>
                            <td>${sanitizeInput(task.title)}</td>
                            <td>${sanitizeInput(task.project || '-')}</td>
                            <td>${task.severity || 'Medium'}</td>
                            <td>${task.deadline ? moment(task.deadline).format('MMM DD, YYYY HH:mm') : '-'}</td>
                            <td>${task.completed ? '✓ Completed' : '⏳ Pending'}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
            
            <div class="footer">
                <p>© 2025 TaskWeaver Inc. All rights reserved.</p>
                <p>This document was generated automatically. For support, contact weaving@taskweaver.com</p>
            </div>
        </body>
        </html>
    `;
    
    return Buffer.from(html);
}

// ============ DATABASE CONNECTION WITH ENHANCED TIMESTAMP HANDLING ============
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: true } : false,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    retryDelay: 5000,
    retryCount: 3,
    types: {
        // Enhanced timestamp parsing
        getTypeParser: (typeId, format) => {
            if (typeId === 1114 || typeId === 1184) {
                return (value) => {
                    if (!value || value === '' || value === 'null') return null;
                    try {
                        const date = new Date(value);
                        return isNaN(date.getTime()) ? null : date;
                    } catch {
                        return null;
                    }
                };
            }
            return require('pg-types').getTypeParser(typeId, format);
        }
    }
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

// ============ ADVANCED EMAIL SERVICE WITH QUEUE ============
let emailConfigured = false;
let emailQueue = [];
let isProcessingQueue = false;

function setupEmailTransporter() {
    if (process.env.NODE_ENV !== 'production') {
        logger.info('Development mode: Emails will be logged to console');
        emailConfigured = true;
        return;
    }
    
    if (!process.env.SENDGRID_API_KEY) {
        logger.error('SendGrid API key not found');
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
                logger.info('✓ SendGrid configured and working');
                emailConfigured = true;
            })
            .catch(err => {
                logger.error('SendGrid test failed:', err.message);
                emailConfigured = false;
            });
    } catch (error) {
        logger.error('SendGrid setup error:', error.message);
        emailConfigured = false;
    }
}

async function sendEmail(to, subject, html, attachments = []) {
    if (!emailConfigured) {
        logger.warn(`Email not sent to ${to}: Service not configured`);
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

// ============ DATABASE INITIALIZATION WITH ENHANCED SCHEMA ============
async function initializeDatabase() {
    logger.info('Initializing database...');
    const client = await pool.connect();
    try {
        // Users table with enhanced fields
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
        
        // Shared schedules table with enhanced security
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
        
        // Session table
        await client.query(`
            CREATE TABLE IF NOT EXISTS session (
                sid VARCHAR NOT NULL PRIMARY KEY,
                sess JSON NOT NULL,
                expire TIMESTAMP NOT NULL
            )
        `);
        
        // Enhanced timestamp validation trigger
        await client.query(`
            CREATE OR REPLACE FUNCTION validate_task_timestamps()
            RETURNS TRIGGER AS $$
            BEGIN
                -- Auto-fix invalid timestamps
                NEW.deadline := CASE 
                    WHEN NEW.deadline IS NULL OR NEW.deadline::text IN ('', 'null', 'undefined', 'Invalid Date') 
                    THEN NULL 
                    ELSE NEW.deadline 
                END;
                
                NEW.scheduled_start := CASE 
                    WHEN NEW.scheduled_start IS NULL OR NEW.scheduled_start::text IN ('', 'null', 'undefined', 'Invalid Date') 
                    THEN NULL 
                    ELSE NEW.scheduled_start 
                END;
                
                NEW.scheduled_end := CASE 
                    WHEN NEW.scheduled_end IS NULL OR NEW.scheduled_end::text IN ('', 'null', 'undefined', 'Invalid Date') 
                    THEN NULL 
                    ELSE NEW.scheduled_end 
                END;
                
                NEW.completed_at := CASE 
                    WHEN NEW.completed_at IS NULL OR NEW.completed_at::text IN ('', 'null', 'undefined', 'Invalid Date') 
                    THEN NULL 
                    ELSE NEW.completed_at 
                END;
                
                NEW.recurrence_end_date := CASE 
                    WHEN NEW.recurrence_end_date IS NULL OR NEW.recurrence_end_date::text IN ('', 'null', 'undefined', 'Invalid Date') 
                    THEN NULL 
                    ELSE NEW.recurrence_end_date 
                END;
                
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
        
        // Create indexes for performance
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
                logger.warn(`Index creation skipped: ${err.message}`);
            }
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
            logger.info('Demo user created: demo@taskweaver.com / Demo@2024');
        }
        
        logger.info('Database initialization complete');
        
    } catch (err) {
        logger.error('Database initialization error:', err.message);
        throw err;
    } finally {
        client.release();
    }
}

// ============ SESSION CONFIGURATION ============
app.use(session({
    store: new pgSession({
        pool: pool,
        tableName: 'session',
        createTableIfMissing: true,
    }),
    secret: process.env.SESSION_SECRET,
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

// ============ AUTHENTICATION MIDDLEWARE ============
function requireAuth(req, res, next) {
    if (!req.session?.userId) {
        logger.warn(`Unauthorized access attempt from ${req.ip}`);
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

// ============ AUTHENTICATION ROUTES ============
app.post('/api/register', [
    body('email').isEmail().normalizeEmail(),
    body('password').isLength({ min: 8 }).matches(/^(?=.*[A-Z])(?=.*[0-9])(?=.*[!@#$%^&*])/),
    body('username').optional().isLength({ min: 3, max: 30 })
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
    }
    
    const { email, password, username: customUsername } = req.body;
    logger.info(`Registration attempt for email: ${email}`);
    
    try {
        const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
        if (existing.rows.length > 0) {
            return res.status(400).json({ error: 'Email already registered' });
        }
        
        const username = customUsername || await generateUsername(email);
        const hashedPassword = await bcrypt.hash(password, 10);
        const verificationToken = crypto.randomBytes(32).toString('hex');
        
        const result = await pool.query(
            `INSERT INTO users (username, email, password, last_login_ip, last_login_user_agent, verification_token, created_at, updated_at) 
             VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW()) RETURNING id`,
            [username, email, hashedPassword, req.ip, req.headers['user-agent'], verificationToken]
        );
        
        const userId = result.rows[0].id;
        logger.info(`New user registered: ${email} (ID: ${userId})`);
        
        if (emailConfigured) {
            const verificationLink = `${process.env.BASE_URL || `https://${req.get('host')}`}/api/verify-email?token=${verificationToken}`;
            const emailContent = getEmailTemplate(
                'Welcome to TaskWeaver! 🎉',
                `Hi ${username},<br><br>Thank you for joining TaskWeaver! Please verify your email address by clicking the button below.<br><br>
                <div class="info-box">
                    <strong>Your Account Details:</strong><br>
                    Email: ${email}<br>
                    Username: ${username}<br>
                </div>`,
                'Verify Email Address',
                verificationLink
            );
            
            sendEmail(email, '🎉 Welcome to TaskWeaver - Verify Your Email', emailContent)
                .catch(err => logger.error('Welcome email failed:', err));
        }
        
        await logUserActivity(userId, email, 'REGISTER', 'User registered successfully', req);
        res.json({ success: true, username, email, message: 'Registration successful! Please check your email to verify your account.' });
        
    } catch (err) {
        logger.error(`Registration error for ${email}:`, err.message);
        res.status(500).json({ error: 'Registration failed' });
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
    logger.info(`Login attempt for email: ${email}`);
    
    try {
        const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        const user = result.rows[0];
        
        if (!user) {
            logger.warn(`Login failed: User not found - ${email}`);
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        if (user.locked_until && new Date(user.locked_until) > new Date()) {
            logger.warn(`Login failed: Account locked for ${email}`);
            return res.status(401).json({ error: 'Account is temporarily locked. Try again later.' });
        }
        
        const valid = await bcrypt.compare(password, user.password);
        if (!valid) {
            const attempts = (user.failed_login_attempts || 0) + 1;
            const locked = attempts >= 5 ? new Date(Date.now() + 15 * 60000) : null;
            await pool.query('UPDATE users SET failed_login_attempts = $1, last_failed_login = $2, locked_until = $3 WHERE id = $4', 
                [attempts, new Date().toISOString(), locked, user.id]);
            logger.warn(`Login failed: Invalid password for ${email} (Attempt ${attempts}/5)`);
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
                logger.error(`Session save error for ${email}:`, err.message);
                return res.status(500).json({ error: 'Session error' });
            }
            
            logger.info(`User logged in: ${email} (ID: ${user.id})`);
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
        logger.error(`Login error for ${email}:`, err.message);
        res.status(500).json({ error: 'Login failed' });
    }
});

// ============ TASK ROUTES WITH RECURRENCE SUPPORT ============
app.get('/api/tasks', requireAuth, async (req, res) => {
    logger.info(`Loading tasks for user: ${req.session.email}`);
    try {
        const result = await pool.query(`
            SELECT 
                id, user_id, user_email, title, description, project, category, 
                severity, priority, deadline, scheduled_start, scheduled_end, 
                completed, completed_at, tags, is_recurring, recurrence_pattern,
                recurrence_end_date, color, location, attachments, subtasks,
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
            recurrence_end_date: formatTimestampForResponse(task.recurrence_end_date),
            created_at: formatTimestampForResponse(task.created_at),
            updated_at: formatTimestampForResponse(task.updated_at),
            attachments: task.attachments || [],
            subtasks: task.subtasks || []
        }));
        
        res.json(formattedTasks);
    } catch (err) {
        logger.error(`Failed to load tasks:`, err.message);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/tasks', requireAuth, [
    body('title').trim().notEmpty().isLength({ max: 255 }),
    body('description').optional().trim().isLength({ max: 5000 }),
    body('deadline').optional().isISO8601(),
    body('priority').optional().isInt({ min: 1, max: 5 }),
    body('is_recurring').optional().isBoolean(),
    body('recurrence_pattern').optional().isIn(['daily', 'weekly', 'monthly', 'yearly'])
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
    }
    
    const { 
        title, description, project, category, severity, priority, deadline, 
        is_recurring, recurrence_pattern, recurrence_end_date, scheduled_start, 
        scheduled_end, estimated_duration, tags, color, location, attachments, subtasks 
    } = req.body;
    
    logger.info(`Creating task for user: ${req.session.email} - Title: ${title}`);
    
    try {
        const safeDeadline = safeTimestamp(deadline);
        const safeScheduledStart = safeTimestamp(scheduled_start);
        const safeScheduledEnd = safeTimestamp(scheduled_end);
        const safeRecurrenceEnd = safeTimestamp(recurrence_end_date);
        
        const result = await pool.query(`
            INSERT INTO tasks (
                user_id, user_email, title, description, project, category, 
                severity, priority, deadline, is_recurring, recurrence_pattern, 
                recurrence_end_date, scheduled_start, scheduled_end, estimated_duration, 
                tags, color, location, attachments, subtasks, created_at, updated_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, NOW(), NOW())
            RETURNING id
        `, [
            req.session.userId, req.session.email, title, description || null, 
            project || null, category || null, severity || 'Medium', priority || 2,
            safeDeadline, is_recurring ? 1 : 0, recurrence_pattern || null,
            safeRecurrenceEnd, safeScheduledStart, safeScheduledEnd, estimated_duration || null,
            tags || null, color || null, location || null, 
            attachments ? JSON.stringify(attachments) : '[]',
            subtasks ? JSON.stringify(subtasks) : '[]'
        ]);
        
        const taskId = result.rows[0].id;
        
        // Handle recurring tasks - generate future instances
        if (is_recurring && recurrence_pattern && safeRecurrenceEnd) {
            await generateRecurringTasks(taskId, recurrence_pattern, safeRecurrenceEnd, req.session.userId);
        }
        
        // Create reminder if scheduled
        if (safeScheduledStart) {
            const reminderTime = new Date(new Date(safeScheduledStart).getTime() - 20 * 60 * 1000);
            await pool.query(`
                INSERT INTO reminders (user_id, user_email, task_id, reminder_time, reminder_type, created_at) 
                VALUES ($1, $2, $3, $4, 'scheduled', NOW())
            `, [req.session.userId, req.session.email, taskId, reminderTime]);
        }
        
        logger.info(`Task created for ${req.session.email}: ${title} (ID: ${taskId})`);
        await logUserActivity(req.session.userId, req.session.email, 'TASK_CREATED', `Task: ${title}`, req);
        res.json({ id: taskId, message: 'Task created successfully' });
        
    } catch (err) {
        logger.error(`Failed to create task:`, err.message);
        res.status(500).json({ error: err.message });
    }
});

// Recurring task generator
async function generateRecurringTasks(parentTaskId, pattern, endDate, userId) {
    const parentTask = await pool.query('SELECT * FROM tasks WHERE id = $1', [parentTaskId]);
    const task = parentTask.rows[0];
    if (!task) return;
    
    const startDate = new Date(task.scheduled_start || task.created_at);
    const end = new Date(endDate);
    let currentDate = new Date(startDate);
    const intervals = {
        daily: 1,
        weekly: 7,
        monthly: 30,
        yearly: 365
    };
    
    const interval = intervals[pattern] || 1;
    
    while (currentDate <= end) {
        currentDate.setDate(currentDate.getDate() + interval);
        if (currentDate > end) break;
        
        await pool.query(`
            INSERT INTO tasks (
                user_id, user_email, title, description, project, category,
                severity, priority, deadline, scheduled_start, scheduled_end,
                is_recurring, recurrence_parent_id, tags, color, location,
                created_at, updated_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 0, $12, $13, $14, $15, NOW(), NOW())
        `, [
            userId, task.user_email, task.title, task.description, task.project,
            task.category, task.severity, task.priority, 
            task.deadline ? new Date(new Date(task.deadline).getTime() + interval * 86400000) : null,
            currentDate,
            task.scheduled_end ? new Date(new Date(task.scheduled_end).getTime() + interval * 86400000) : null,
            parentTaskId, task.tags, task.color, task.location
        ]);
    }
}

// ============ ENHANCED SCHEDULE SHARING WITH ATTACHMENTS ============
app.post('/api/share-schedule', requireAuth, [
    body('shareWithEmail').isEmail().normalizeEmail(),
    body('shareType').optional().isIn(['view', 'edit']),
    body('format').optional().isIn(['pdf', 'excel', 'word', 'csv', 'ical'])
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
    }
    
    const { shareWithEmail, shareType = 'view', format = 'pdf' } = req.body;
    const userEmail = req.session.email;
    const userId = req.session.userId;
    
    logger.info(`Sharing schedule from ${userEmail} to ${shareWithEmail} as ${format}`);
    
    try {
        // Check if recipient exists
        const recipientResult = await pool.query('SELECT id, email, username FROM users WHERE email = $1', [shareWithEmail]);
        if (recipientResult.rows.length === 0) {
            return res.status(404).json({ error: 'Recipient email not found in TaskWeaver' });
        }
        
        const recipient = recipientResult.rows[0];
        
        // Get user's tasks
        const tasksResult = await pool.query(
            `SELECT * FROM tasks WHERE user_id = $1 AND deleted_at IS NULL 
             ORDER BY scheduled_start ASC, deadline ASC`,
            [userId]
        );
        const tasks = tasksResult.rows;
        
        // Get user info
        const userResult = await pool.query('SELECT username, email FROM users WHERE id = $1', [userId]);
        const user = userResult.rows[0];
        
        // Generate share token with 24-hour expiry
        const shareToken = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
        
        await pool.query(
            `INSERT INTO shared_schedules (user_id, user_email, share_with_email, share_token, share_type, expires_at, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
            [userId, userEmail, shareWithEmail, shareToken, shareType, expiresAt]
        );
        
        // Generate attachments based on format
        let attachmentBuffer = null;
        let contentType = '';
        let filename = '';
        
        switch(format) {
            case 'pdf':
                attachmentBuffer = await generateProfessionalPDF(tasks, user, shareToken);
                contentType = 'application/pdf';
                filename = `schedule_${user.username}_${moment().format('YYYY-MM-DD')}.pdf`;
                break;
            case 'excel':
                attachmentBuffer = await generateAdvancedExcel(tasks, user);
                contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
                filename = `schedule_${user.username}_${moment().format('YYYY-MM-DD')}.xlsx`;
                break;
            case 'word':
                attachmentBuffer = await generateWordDocument(tasks, user);
                contentType = 'application/msword';
                filename = `schedule_${user.username}_${moment().format('YYYY-MM-DD')}.doc`;
                break;
            case 'csv':
                const csvData = generateCSV(tasks);
                attachmentBuffer = Buffer.from(csvData);
                contentType = 'text/csv';
                filename = `schedule_${user.username}_${moment().format('YYYY-MM-DD')}.csv`;
                break;
            case 'ical':
                const icalData = generateICalendar(tasks);
                attachmentBuffer = Buffer.from(icalData);
                contentType = 'text/calendar';
                filename = `schedule_${user.username}_${moment().format('YYYY-MM-DD')}.ics`;
                break;
        }
        
        // Create share link
        const shareLink = `${process.env.BASE_URL || `https://${req.get('host')}`}/shared/${shareToken}`;
        
        // Generate QR code for the share link
        const qrCodeBuffer = await QRCode.toBuffer(shareLink, { width: 200 });
        
        // Send email with attachments
        const emailContent = getShareEmailTemplate(
            user.username,
            user.email,
            recipient.username || recipient.email,
            tasks.length,
            shareType,
            expiresAt,
            shareLink
        );
        
        const attachments = [{
            filename,
            content: attachmentBuffer.toString('base64'),
            contentType,
            disposition: 'attachment'
        }, {
            filename: 'qr_code.png',
            content: qrCodeBuffer.toString('base64'),
            contentType: 'image/png',
            disposition: 'attachment'
        }];
        
        if (emailConfigured) {
            await sendEmail(shareWithEmail, `📅 ${user.username} shared their schedule with you`, emailContent, attachments);
            logger.info(`Schedule shared with ${shareWithEmail} (Format: ${format})`);
        }
        
        await logUserActivity(userId, userEmail, 'SHARE_SCHEDULE', `Shared with ${shareWithEmail} as ${format}`, req);
        
        res.json({ 
            success: true, 
            message: `Schedule shared with ${shareWithEmail}`,
            shareLink,
            expiresAt
        });
        
    } catch (err) {
        logger.error(`Share schedule error:`, err.message);
        res.status(500).json({ error: err.message });
    }
});

// Generate iCalendar format
function generateICalendar(tasks) {
    const cal = ical({ 
        domain: 'taskweaver.com',
        prodId: { company: 'TaskWeaver', product: 'Schedule' },
        name: 'TaskWeaver Schedule'
    });
    
    tasks.forEach(task => {
        if (task.scheduled_start) {
            cal.createEvent({
                start: moment(task.scheduled_start).toDate(),
                end: moment(task.scheduled_end || task.scheduled_start).add(1, 'hour').toDate(),
                summary: task.title,
                description: task.description || '',
                location: task.location || '',
                categories: [task.category, task.severity].filter(Boolean),
                status: task.completed ? 'CONFIRMED' : 'TENTATIVE',
                priority: task.priority || 2,
                transparency: 'OPAQUE'
            });
        }
    });
    
    return cal.toString();
}

// Enhanced share email template
function getShareEmailTemplate(senderName, senderEmail, recipientName, taskCount, shareType, expiresAt, shareLink) {
    return `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <title>Schedule Shared with You</title>
            <style>
                body {
                    font-family: 'Segoe UI', Arial, sans-serif;
                    background: #f7fafc;
                    margin: 0;
                    padding: 20px;
                }
                .container {
                    max-width: 600px;
                    margin: 0 auto;
                    background: white;
                    border-radius: 16px;
                    overflow: hidden;
                    box-shadow: 0 4px 6px rgba(0,0,0,0.1);
                }
                .header {
                    background: linear-gradient(135deg, #667eea, #764ba2);
                    padding: 30px;
                    text-align: center;
                }
                .header h1 {
                    color: white;
                    margin: 0;
                    font-size: 28px;
                }
                .content {
                    padding: 40px;
                }
                .info-box {
                    background: #f7fafc;
                    border-left: 4px solid #667eea;
                    padding: 20px;
                    margin: 20px 0;
                    border-radius: 8px;
                }
                .stats {
                    display: flex;
                    justify-content: space-around;
                    margin: 30px 0;
                }
                .stat {
                    text-align: center;
                }
                .stat-number {
                    font-size: 32px;
                    font-weight: bold;
                    color: #667eea;
                }
                .button {
                    display: inline-block;
                    background: linear-gradient(135deg, #667eea, #764ba2);
                    color: white;
                    padding: 12px 30px;
                    text-decoration: none;
                    border-radius: 8px;
                    margin: 20px 0;
                    font-weight: 600;
                }
                .warning {
                    background: #fef5e7;
                    border-left-color: #f39c12;
                    padding: 15px;
                    margin: 20px 0;
                    border-radius: 8px;
                }
                .footer {
                    background: #f7fafc;
                    padding: 20px;
                    text-align: center;
                    font-size: 12px;
                    color: #718096;
                }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1>⚡ TaskWeaver</h1>
                    <p style="color: rgba(255,255,255,0.9); margin: 10px 0 0;">Schedule Sharing</p>
                </div>
                <div class="content">
                    <h2>Hello ${recipientName}! 👋</h2>
                    <p><strong>${senderName}</strong> (${senderEmail}) has shared their schedule with you.</p>
                    
                    <div class="stats">
                        <div class="stat">
                            <div class="stat-number">${taskCount}</div>
                            <div>Total Tasks</div>
                        </div>
                        <div class="stat">
                            <div class="stat-number">${shareType === 'view' ? '👁️ View' : '✏️ Edit'}</div>
                            <div>Access Level</div>
                        </div>
                        <div class="stat">
                            <div class="stat-number">24h</div>
                            <div>Valid Period</div>
                        </div>
                    </div>
                    
                    <div class="info-box">
                        <strong>📋 Schedule Overview</strong><br>
                        This shared schedule includes all tasks, projects, and deadlines.
                        You can view it online, download as PDF/Excel, or add to your calendar.
                    </div>
                    
                    <div style="text-align: center;">
                        <a href="${shareLink}" class="button">📅 View Schedule Online</a>
                    </div>
                    
                    <div class="warning">
                        <strong>⚠️ Security Notice</strong><br>
                        • This link expires in 24 hours<br>
                        • The QR code attached contains the same link<br>
                        • Do not forward this email to others<br>
                        • All access is logged and monitored
                    </div>
                    
                    <hr>
                    <small>This is an automated message from TaskWeaver. If you didn't expect this, please ignore this email.</small>
                </div>
                <div class="footer">
                    <p>© 2025 TaskWeaver Inc. | Weaving Productivity into Your Life</p>
                    <p>Made with ❤️ for better collaboration</p>
                </div>
            </div>
        </body>
        </html>
    `;
}

// ============ ENHANCED SHARED VIEW WITH MODERN UI ============
app.get('/shared/:token', async (req, res) => {
    const { token } = req.params;
    logger.info(`Accessing shared schedule with token: ${token.substring(0, 10)}...`);
    
    try {
        const shareResult = await pool.query(
            'SELECT * FROM shared_schedules WHERE share_token = $1 AND expires_at > NOW()',
            [token]
        );
        const share = shareResult.rows[0];
        
        if (!share) {
            return res.sendFile(path.join(__dirname, 'public', 'expired-link.html'));
        }
        
        // Update access count
        await pool.query(
            'UPDATE shared_schedules SET access_count = access_count + 1, last_accessed = NOW() WHERE id = $1',
            [share.id]
        );
        
        const tasksResult = await pool.query(
            `SELECT * FROM tasks WHERE user_id = $1 AND deleted_at IS NULL 
             ORDER BY scheduled_start ASC, deadline ASC`,
            [share.user_id]
        );
        const tasks = tasksResult.rows;
        
        const userResult = await pool.query('SELECT username, email FROM users WHERE id = $1', [share.user_id]);
        const user = userResult.rows[0];
        
        // Serve the shared view HTML with data embedded
        const html = `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Shared Schedule - ${user.username} | TaskWeaver</title>
                <link href="https://cdn.jsdelivr.net/npm/tailwindcss@2.2.19/dist/tailwind.min.css" rel="stylesheet">
                <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet">
                <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
                <script src="https://cdn.jsdelivr.net/npm/fullcalendar@5.11.3/main.min.js"></script>
                <link href="https://cdn.jsdelivr.net/npm/fullcalendar@5.11.3/main.min.css" rel="stylesheet">
                <style>
                    * { margin: 0; padding: 0; box-sizing: border-box; }
                    body {
                        font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                        min-height: 100vh;
                    }
                    .glass-card {
                        background: rgba(255, 255, 255, 0.95);
                        backdrop-filter: blur(10px);
                        border-radius: 20px;
                        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.1);
                    }
                    .task-card {
                        transition: transform 0.3s ease, box-shadow 0.3s ease;
                        cursor: pointer;
                    }
                    .task-card:hover {
                        transform: translateY(-5px);
                        box-shadow: 0 10px 25px rgba(0, 0, 0, 0.15);
                    }
                    .severity-critical { border-left: 4px solid #f56565; }
                    .severity-high { border-left: 4px solid #ed8936; }
                    .severity-medium { border-left: 4px solid #48bb78; }
                    .severity-low { border-left: 4px solid #4299e1; }
                    .modal {
                        display: none;
                        position: fixed;
                        top: 0;
                        left: 0;
                        width: 100%;
                        height: 100%;
                        background: rgba(0, 0, 0, 0.5);
                        backdrop-filter: blur(5px);
                        z-index: 1000;
                        justify-content: center;
                        align-items: center;
                    }
                    .modal-content {
                        background: white;
                        border-radius: 20px;
                        max-width: 600px;
                        width: 90%;
                        max-height: 80vh;
                        overflow-y: auto;
                        animation: slideIn 0.3s ease;
                    }
                    @keyframes slideIn {
                        from {
                            transform: translateY(-50px);
                            opacity: 0;
                        }
                        to {
                            transform: translateY(0);
                            opacity: 1;
                        }
                    }
                    .filter-btn {
                        transition: all 0.3s ease;
                    }
                    .filter-btn.active {
                        background: #667eea;
                        color: white;
                    }
                    .stat-card {
                        background: linear-gradient(135deg, #667eea, #764ba2);
                        color: white;
                        border-radius: 15px;
                        padding: 20px;
                        transition: transform 0.3s ease;
                    }
                    .stat-card:hover {
                        transform: scale(1.05);
                    }
                </style>
            </head>
            <body>
                <div class="container mx-auto px-4 py-8">
                    <!-- Header -->
                    <div class="glass-card p-8 mb-8">
                        <div class="flex justify-between items-center flex-wrap gap-4">
                            <div>
                                <h1 class="text-3xl font-bold bg-gradient-to-r from-purple-600 to-indigo-600 bg-clip-text text-transparent">
                                    ⚡ TaskWeaver
                                </h1>
                                <p class="text-gray-600 mt-2">Shared Schedule • ${user.username}</p>
                            </div>
                            <div class="flex gap-3">
                                <button onclick="downloadSchedule('pdf')" class="px-4 py-2 bg-red-500 text-white rounded-lg hover:bg-red-600 transition">
                                    <i class="fas fa-file-pdf"></i> PDF
                                </button>
                                <button onclick="downloadSchedule('excel')" class="px-4 py-2 bg-green-500 text-white rounded-lg hover:bg-green-600 transition">
                                    <i class="fas fa-file-excel"></i> Excel
                                </button>
                                <button onclick="downloadSchedule('word')" class="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition">
                                    <i class="fas fa-file-word"></i> Word
                                </button>
                                <button onclick="downloadSchedule('ical')" class="px-4 py-2 bg-purple-500 text-white rounded-lg hover:bg-purple-600 transition">
                                    <i class="fas fa-calendar-plus"></i> iCal
                                </button>
                            </div>
                        </div>
                        <div class="mt-4 text-sm text-gray-500">
                            <i class="fas fa-clock"></i> Shared: ${moment(share.created_at).format('MMMM Do YYYY, h:mm a')} &nbsp;|&nbsp;
                            <i class="fas fa-hourglass-half"></i> Expires: ${moment(share.expires_at).format('MMMM Do YYYY, h:mm a')} &nbsp;|&nbsp;
                            <i class="fas fa-eye"></i> Views: ${share.access_count || 0}
                        </div>
                    </div>
                    
                    <!-- Statistics Cards -->
                    <div class="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8" id="statsContainer"></div>
                    
                    <!-- View Toggle -->
                    <div class="flex gap-4 mb-6">
                        <button onclick="setView('list')" id="listViewBtn" class="filter-btn px-6 py-2 bg-gray-200 rounded-lg hover:bg-gray-300 transition active">
                            <i class="fas fa-list"></i> List View
                        </button>
                        <button onclick="setView('calendar')" id="calendarViewBtn" class="filter-btn px-6 py-2 bg-gray-200 rounded-lg hover:bg-gray-300 transition">
                            <i class="fas fa-calendar"></i> Calendar View
                        </button>
                        <button onclick="setView('board')" id="boardViewBtn" class="filter-btn px-6 py-2 bg-gray-200 rounded-lg hover:bg-gray-300 transition">
                            <i class="fas fa-columns"></i> Board View
                        </button>
                    </div>
                    
                    <!-- Filters -->
                    <div class="glass-card p-4 mb-6">
                        <div class="flex flex-wrap gap-3">
                            <input type="text" id="searchInput" placeholder="Search tasks..." class="flex-1 px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500">
                            <select id="severityFilter" class="px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500">
                                <option value="">All Severities</option>
                                <option value="Critical">Critical</option>
                                <option value="High">High</option>
                                <option value="Medium">Medium</option>
                                <option value="Low">Low</option>
                            </select>
                            <select id="statusFilter" class="px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500">
                                <option value="">All Status</option>
                                <option value="completed">Completed</option>
                                <option value="pending">Pending</option>
                            </select>
                            <button onclick="resetFilters()" class="px-4 py-2 bg-gray-500 text-white rounded-lg hover:bg-gray-600 transition">
                                <i class="fas fa-undo"></i> Reset
                            </button>
                        </div>
                    </div>
                    
                    <!-- List View -->
                    <div id="listView" class="space-y-4"></div>
                    
                    <!-- Calendar View -->
                    <div id="calendarView" style="display: none;" class="glass-card p-6"></div>
                    
                    <!-- Board View -->
                    <div id="boardView" style="display: none;" class="grid grid-cols-1 md:grid-cols-3 gap-6"></div>
                </div>
                
                <!-- Task Detail Modal -->
                <div id="taskModal" class="modal">
                    <div class="modal-content p-6">
                        <div class="flex justify-between items-center mb-4">
                            <h3 id="modalTitle" class="text-2xl font-bold"></h3>
                            <button onclick="closeModal()" class="text-gray-500 hover:text-gray-700">
                                <i class="fas fa-times text-2xl"></i>
                            </button>
                        </div>
                        <div id="modalContent"></div>
                    </div>
                </div>
                
                <script>
                    const tasks = ${JSON.stringify(tasks)};
                    let currentView = 'list';
                    
                    // Initialize page
                    document.addEventListener('DOMContentLoaded', () => {
                        updateStats();
                        renderView();
                        
                        // Add event listeners for filters
                        document.getElementById('searchInput').addEventListener('input', renderView);
                        document.getElementById('severityFilter').addEventListener('change', renderView);
                        document.getElementById('statusFilter').addEventListener('change', renderView);
                    });
                    
                    function updateStats() {
                        const total = tasks.length;
                        const completed = tasks.filter(t => t.completed).length;
                        const pending = total - completed;
                        const critical = tasks.filter(t => t.severity === 'Critical' && !t.completed).length;
                        const overdue = tasks.filter(t => t.deadline && new Date(t.deadline) < new Date() && !t.completed).length;
                        
                        const statsHtml = \`
                            <div class="stat-card"><div class="text-3xl font-bold">\${total}</div><div>Total Tasks</div></div>
                            <div class="stat-card"><div class="text-3xl font-bold">\${completed}</div><div>Completed</div></div>
                            <div class="stat-card"><div class="text-3xl font-bold">\${pending}</div><div>Pending</div></div>
                            <div class="stat-card"><div class="text-3xl font-bold">\${critical}</div><div>Critical</div></div>
                        \`;
                        document.getElementById('statsContainer').innerHTML = statsHtml;
                    }
                    
                    function filterTasks() {
                        const searchTerm = document.getElementById('searchInput').value.toLowerCase();
                        const severity = document.getElementById('severityFilter').value;
                        const status = document.getElementById('statusFilter').value;
                        
                        return tasks.filter(task => {
                            const matchesSearch = task.title.toLowerCase().includes(searchTerm) ||
                                                (task.description && task.description.toLowerCase().includes(searchTerm));
                            const matchesSeverity = !severity || task.severity === severity;
                            const matchesStatus = !status || (status === 'completed' ? task.completed : !task.completed);
                            return matchesSearch && matchesSeverity && matchesStatus;
                        });
                    }
                    
                    function renderView() {
                        if (currentView === 'list') renderListView();
                        else if (currentView === 'calendar') renderCalendarView();
                        else if (currentView === 'board') renderBoardView();
                    }
                    
                    function renderListView() {
                        const filtered = filterTasks();
                        const container = document.getElementById('listView');
                        container.innerHTML = filtered.map(task => \`
                            <div class="task-card glass-card p-6 severity-\${task.severity?.toLowerCase() || 'medium'} cursor-pointer" onclick="showTaskDetail(\${task.id})">
                                <div class="flex justify-between items-start">
                                    <div class="flex-1">
                                        <h3 class="text-xl font-semibold mb-2">\${escapeHtml(task.title)}</h3>
                                        <p class="text-gray-600 mb-3">\${escapeHtml(task.description || 'No description')}</p>
                                        <div class="flex flex-wrap gap-2 text-sm">
                                            \${task.project ? \`<span class="px-2 py-1 bg-purple-100 text-purple-700 rounded"><i class="fas fa-folder"></i> \${escapeHtml(task.project)}</span>\` : ''}
                                            \${task.category ? \`<span class="px-2 py-1 bg-blue-100 text-blue-700 rounded"><i class="fas fa-tag"></i> \${escapeHtml(task.category)}</span>\` : ''}
                                            \${task.location ? \`<span class="px-2 py-1 bg-green-100 text-green-700 rounded"><i class="fas fa-map-marker-alt"></i> \${escapeHtml(task.location)}</span>\` : ''}
                                        </div>
                                    </div>
                                    <div class="text-right">
                                        <div class="mb-2">
                                            <span class="px-3 py-1 rounded-full text-sm font-semibold \${getSeverityClass(task.severity)}">
                                                \${task.severity || 'Medium'}
                                            </span>
                                        </div>
                                        \${task.deadline ? \`
                                            <div class="text-sm text-gray-500">
                                                <i class="far fa-calendar-alt"></i> \${new Date(task.deadline).toLocaleString()}
                                            </div>
                                        \` : ''}
                                        <div class="mt-2">
                                            <span class="px-3 py-1 rounded-full text-sm \${task.completed ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'}">
                                                \${task.completed ? '✓ Completed' : '⏳ Pending'}
                                            </span>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        \`).join('');
                    }
                    
                    function renderCalendarView() {
                        const container = document.getElementById('calendarView');
                        container.style.display = 'block';
                        container.innerHTML = '<div id="calendar"></div>';
                        
                        const calendarEl = document.getElementById('calendar');
                        const calendar = new FullCalendar.Calendar(calendarEl, {
                            initialView: 'timeGridWeek',
                            headerToolbar: {
                                left: 'prev,next today',
                                center: 'title',
                                right: 'dayGridMonth,timeGridWeek,timeGridDay'
                            },
                            events: tasks.filter(t => t.scheduled_start).map(task => ({
                                title: task.title,
                                start: task.scheduled_start,
                                end: task.scheduled_end || task.scheduled_start,
                                backgroundColor: task.completed ? '#48bb78' : 
                                                task.severity === 'Critical' ? '#f56565' :
                                                task.severity === 'High' ? '#ed8936' : '#4299e1',
                                borderColor: 'transparent',
                                extendedProps: { task }
                            })),
                            eventClick: (info) => showTaskDetail(info.event.extendedProps.task.id)
                        });
                        calendar.render();
                    }
                    
                    function renderBoardView() {
                        const filtered = filterTasks();
                        const columns = {
                            'Pending': filtered.filter(t => !t.completed),
                            'Completed': filtered.filter(t => t.completed)
                        };
                        
                        const container = document.getElementById('boardView');
                        container.style.display = 'grid';
                        container.innerHTML = Object.entries(columns).map(([title, tasks]) => \`
                            <div class="glass-card p-4">
                                <h3 class="text-lg font-bold mb-4 pb-2 border-b">\${title} <span class="text-sm text-gray-500">(\${tasks.length})</span></h3>
                                <div class="space-y-3">
                                    \${tasks.map(task => \`
                                        <div class="task-card bg-white p-4 rounded-lg shadow cursor-pointer severity-\${task.severity?.toLowerCase() || 'medium'}" onclick="showTaskDetail(\${task.id})">
                                            <h4 class="font-semibold">\${escapeHtml(task.title)}</h4>
                                            \${task.deadline ? \`<p class="text-xs text-gray-500 mt-1"><i class="far fa-clock"></i> \${new Date(task.deadline).toLocaleDateString()}</p>\` : ''}
                                        </div>
                                    \`).join('')}
                                </div>
                            </div>
                        \`).join('');
                    }
                    
                    function showTaskDetail(taskId) {
                        const task = tasks.find(t => t.id === taskId);
                        if (!task) return;
                        
                        document.getElementById('modalTitle').innerHTML = task.completed ? 
                            '<i class="fas fa-check-circle text-green-500"></i> ' + escapeHtml(task.title) : 
                            escapeHtml(task.title);
                        
                        const content = \`
                            <div class="space-y-4">
                                \${task.description ? \`
                                    <div>
                                        <h4 class="font-semibold text-gray-700 mb-2">Description</h4>
                                        <p class="text-gray-600">\${escapeHtml(task.description)}</p>
                                    </div>
                                \` : ''}
                                <div class="grid grid-cols-2 gap-4">
                                    \${task.project ? \`
                                        <div>
                                            <h4 class="font-semibold text-gray-700 mb-1">Project</h4>
                                            <p class="text-gray-600">\${escapeHtml(task.project)}</p>
                                        </div>
                                    \` : ''}
                                    \${task.category ? \`
                                        <div>
                                            <h4 class="font-semibold text-gray-700 mb-1">Category</h4>
                                            <p class="text-gray-600">\${escapeHtml(task.category)}</p>
                                        </div>
                                    \` : ''}
                                    \${task.location ? \`
                                        <div>
                                            <h4 class="font-semibold text-gray-700 mb-1">Location</h4>
                                            <p class="text-gray-600"><i class="fas fa-map-marker-alt"></i> \${escapeHtml(task.location)}</p>
                                        </div>
                                    \` : ''}
                                    \${task.priority ? \`
                                        <div>
                                            <h4 class="font-semibold text-gray-700 mb-1">Priority</h4>
                                            <p class="text-gray-600">\${task.priority}/5</p>
                                        </div>
                                    \` : ''}
                                </div>
                                \${task.scheduled_start ? \`
                                    <div>
                                        <h4 class="font-semibold text-gray-700 mb-1">Schedule</h4>
                                        <p class="text-gray-600">
                                            <i class="far fa-calendar-alt"></i> Start: \${new Date(task.scheduled_start).toLocaleString()}
                                            \${task.scheduled_end ? \`<br><i class="far fa-calendar-check"></i> End: \${new Date(task.scheduled_end).toLocaleString()}\` : ''}
                                        </p>
                                    </div>
                                \` : ''}
                                \${task.tags ? \`
                                    <div>
                                        <h4 class="font-semibold text-gray-700 mb-1">Tags</h4>
                                        <div class="flex flex-wrap gap-2">
                                            \${task.tags.split(',').map(tag => \`<span class="px-2 py-1 bg-gray-100 rounded-full text-sm">\${escapeHtml(tag.trim())}</span>\`).join('')}
                                        </div>
                                    </div>
                                \` : ''}
                                \${task.subtasks?.length > 0 ? \`
                                    <div>
                                        <h4 class="font-semibold text-gray-700 mb-1">Subtasks</h4>
                                        <ul class="list-disc list-inside space-y-1">
                                            \${task.subtasks.map(sub => \`<li class="text-gray-600">\${escapeHtml(sub)}</li>\`).join('')}
                                        </ul>
                                    </div>
                                \` : ''}
                            </div>
                        \`;
                        
                        document.getElementById('modalContent').innerHTML = content;
                        document.getElementById('taskModal').style.display = 'flex';
                    }
                    
                    function closeModal() {
                        document.getElementById('taskModal').style.display = 'none';
                    }
                    
                    function setView(view) {
                        currentView = view;
                        document.getElementById('listView').style.display = view === 'list' ? 'block' : 'none';
                        document.getElementById('calendarView').style.display = view === 'calendar' ? 'block' : 'none';
                        document.getElementById('boardView').style.display = view === 'board' ? 'grid' : 'none';
                        
                        // Update button styles
                        ['listViewBtn', 'calendarViewBtn', 'boardViewBtn'].forEach(id => {
                            document.getElementById(id).classList.remove('active');
                        });
                        document.getElementById(view + 'ViewBtn').classList.add('active');
                        
                        renderView();
                    }
                    
                    function resetFilters() {
                        document.getElementById('searchInput').value = '';
                        document.getElementById('severityFilter').value = '';
                        document.getElementById('statusFilter').value = '';
                        renderView();
                    }
                    
                    function downloadSchedule(format) {
                        window.location.href = \`/api/export-shared-schedule?token=${token}&format=\${format}\`;
                    }
                    
                    function getSeverityClass(severity) {
                        switch(severity) {
                            case 'Critical': return 'bg-red-100 text-red-700';
                            case 'High': return 'bg-orange-100 text-orange-700';
                            case 'Medium': return 'bg-green-100 text-green-700';
                            case 'Low': return 'bg-blue-100 text-blue-700';
                            default: return 'bg-gray-100 text-gray-700';
                        }
                    }
                    
                    function escapeHtml(text) {
                        if (!text) return '';
                        const div = document.createElement('div');
                        div.textContent = text;
                        return div.innerHTML;
                    }
                </script>
            </body>
            </html>
        `;
        
        res.send(html);
        
    } catch (err) {
        logger.error(`Shared view error:`, err.message);
        res.status(500).send('Error loading shared schedule');
    }
});

// Export shared schedule endpoint
app.get('/api/export-shared-schedule', async (req, res) => {
    const { token, format = 'pdf' } = req.query;
    
    try {
        const shareResult = await pool.query(
            'SELECT * FROM shared_schedules WHERE share_token = $1 AND expires_at > NOW()',
            [token]
        );
        const share = shareResult.rows[0];
        
        if (!share) {
            return res.status(404).json({ error: 'Invalid or expired link' });
        }
        
        const tasksResult = await pool.query(
            `SELECT * FROM tasks WHERE user_id = $1 AND deleted_at IS NULL`,
            [share.user_id]
        );
        const tasks = tasksResult.rows;
        
        const userResult = await pool.query('SELECT username, email FROM users WHERE id = $1', [share.user_id]);
        const user = userResult.rows[0];
        
        switch(format) {
            case 'pdf':
                const pdfBuffer = await generateProfessionalPDF(tasks, user);
                res.setHeader('Content-Type', 'application/pdf');
                res.setHeader('Content-Disposition', `attachment; filename=shared_schedule_${user.username}.pdf`);
                res.send(pdfBuffer);
                break;
            case 'excel':
                const excelBuffer = await generateAdvancedExcel(tasks, user);
                res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
                res.setHeader('Content-Disposition', `attachment; filename=shared_schedule_${user.username}.xlsx`);
                res.send(excelBuffer);
                break;
            case 'word':
                const wordBuffer = await generateWordDocument(tasks, user);
                res.setHeader('Content-Type', 'application/msword');
                res.setHeader('Content-Disposition', `attachment; filename=shared_schedule_${user.username}.doc`);
                res.send(wordBuffer);
                break;
            case 'ical':
                const icalData = generateICalendar(tasks);
                res.setHeader('Content-Type', 'text/calendar');
                res.setHeader('Content-Disposition', `attachment; filename=shared_schedule_${user.username}.ics`);
                res.send(icalData);
                break;
            default:
                const csvData = generateCSV(tasks);
                res.setHeader('Content-Type', 'text/csv');
                res.setHeader('Content-Disposition', `attachment; filename=shared_schedule_${user.username}.csv`);
                res.send(csvData);
        }
    } catch (err) {
        logger.error(`Export error:`, err.message);
        res.status(500).json({ error: err.message });
    }
});

// ============ REMINDER SYSTEM WITH ENHANCED LOGIC ============
async function checkScheduledReminders() {
    if (!dbConnected || !emailConfigured) return;
    
    try {
        const result = await pool.query(`
            SELECT r.*, t.title, t.description, t.user_id, t.user_email, 
                   u.email_notifications, u.timezone
            FROM reminders r
            JOIN tasks t ON r.task_id = t.id
            JOIN users u ON r.user_id = u.id
            WHERE r.reminder_time <= NOW()
            AND r.sent = 0
            AND u.email_notifications = 1
            AND t.completed = 0
            AND t.deleted_at IS NULL
        `);
        
        for (const reminder of result.rows) {
            const userTime = moment().tz(reminder.timezone || 'UTC');
            const reminderTime = moment(reminder.reminder_time).tz(reminder.timezone || 'UTC');
            
            const emailContent = `
                <!DOCTYPE html>
                <html>
                <head><meta charset="UTF-8"><title>Task Reminder</title></head>
                <body style="font-family: Arial, sans-serif;">
                    <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
                        <div style="background: linear-gradient(135deg, #667eea, #764ba2); padding: 30px; text-align: center; border-radius: 12px;">
                            <h1 style="color: white; margin: 0;">⚡ Task Reminder</h1>
                        </div>
                        <div style="padding: 30px;">
                            <h2>${reminder.title}</h2>
                            <p>${reminder.description || 'No description provided.'}</p>
                            <div style="background: #f7fafc; padding: 15px; border-radius: 8px; margin: 20px 0;">
                                <strong>Reminder Time:</strong> ${reminderTime.format('MMMM Do YYYY, h:mm a')}<br>
                                <strong>Your Timezone:</strong> ${reminder.timezone || 'UTC'}
                            </div>
                            <p>Stay focused and complete your task on time! 💪</p>
                        </div>
                    </div>
                </body>
                </html>
            `;
            
            try {
                await sendEmail(reminder.user_email, `🔔 Task Reminder: ${reminder.title}`, emailContent);
                await pool.query('UPDATE reminders SET sent = 1, sent_at = NOW() WHERE id = $1', [reminder.id]);
                await pool.query('UPDATE tasks SET reminder_count = reminder_count + 1, last_reminder_sent = NOW() WHERE id = $1', [reminder.task_id]);
                logger.info(`Reminder sent to ${reminder.user_email}: ${reminder.title}`);
            } catch (error) {
                logger.error(`Failed to send reminder:`, error.message);
                await pool.query('UPDATE reminders SET retry_count = retry_count + 1, last_error = $1 WHERE id = $2', [error.message, reminder.id]);
            }
        }
    } catch (err) {
        logger.error('Error checking reminders:', err.message);
    }
}

// Schedule reminders every minute
schedule.scheduleJob('* * * * *', checkScheduledReminders);

// ============ ADDITIONAL UTILITY FUNCTIONS ============
function generateCSV(tasks) {
    const fields = ['title', 'description', 'project', 'category', 'severity', 'priority', 'scheduled_start', 'deadline', 'completed', 'tags', 'location'];
    const parser = new Parser({ fields });
    const formattedTasks = tasks.map(task => ({
        ...task,
        scheduled_start: task.scheduled_start ? moment(task.scheduled_start).format() : '',
        deadline: task.deadline ? moment(task.deadline).format() : '',
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

// ============ SERVER STARTUP ============
async function startServer() {
    try {
        logger.info('Starting TaskWeaver server...');
        
        await initializeDatabase();
        setupEmailTransporter();
        
        app.listen(port, '0.0.0.0', () => {
            console.log('\x1b[36m%s\x1b[0m', '\n╔══════════════════════════════════════════════════════════════╗');
            console.log('\x1b[36m%s\x1b[0m', '║                    🚀 TASKWEAVER SERVER 🚀                      ║');
            console.log('\x1b[36m%s\x1b[0m', '╠══════════════════════════════════════════════════════════════╣');
            console.log('\x1b[36m%s\x1b[0m', `║  Port: ${port.toString().padEnd(55)}║`);
            console.log('\x1b[36m%s\x1b[0m', `║  Database: ${dbConnected ? '✓ CONNECTED'.padEnd(52) : '✗ DISCONNECTED'.padEnd(52)}║`);
            console.log('\x1b[36m%s\x1b[0m', `║  Email: ${emailConfigured ? '✓ CONFIGURED'.padEnd(52) : '✗ DISABLED'.padEnd(52)}║`);
            console.log('\x1b[36m%s\x1b[0m', '╠══════════════════════════════════════════════════════════════╣');
            console.log('\x1b[36m%s\x1b[0m', '║  ✨ NEW FEATURES ACTIVE:                                    ║');
            console.log('\x1b[36m%s\x1b[0m', '║    ✓ Professional PDF with Letterhead                        ║');
            console.log('\x1b[36m%s\x1b[0m', '║    ✓ Excel/Word/CSV/iCal Export                              ║');
            console.log('\x1b[36m%s\x1b[0m', '║    ✓ Recurring Tasks (Daily/Weekly/Monthly/Yearly)          ║');
            console.log('\x1b[36m%s\x1b[0m', '║    ✓ QR Code Generation for Shares                           ║');
            console.log('\x1b[36m%s\x1b[0m', '║    ✓ Enhanced Shared View with Calendar/Board                ║');
            console.log('\x1b[36m%s\x1b[0m', '║    ✓ 24-Hour Expiring Share Links                            ║');
            console.log('\x1b[36m%s\x1b[0m', '║    ✓ Automatic Timestamp Fixing                              ║');
            console.log('\x1b[36m%s\x1b[0m', '║    ✓ Advanced Rate Limiting                                  ║');
            console.log('\x1b[36m%s\x1b[0m', '║    ✓ Security Headers with Helmet                            ║');
            console.log('\x1b[36m%s\x1b[0m', '║    ✓ Input Validation & Sanitization                         ║');
            console.log('\x1b[36m%s\x1b[0m', '╠══════════════════════════════════════════════════════════════╣');
            console.log('\x1b[36m%s\x1b[0m', '║  Demo Login:                                                 ║');
            console.log('\x1b[36m%s\x1b[0m', '║    📧 demo@taskweaver.com                                    ║');
            console.log('\x1b[36m%s\x1b[0m', '║    🔑 Demo@2024                                               ║');
            console.log('\x1b[36m%s\x1b[0m', '╚══════════════════════════════════════════════════════════════╝\n');
        });
        
        process.on('SIGTERM', () => { 
            logger.info('SIGTERM received, shutting down gracefully...');
            pool.end(() => {
                logger.info('Database connections closed');
                process.exit(0);
            });
        });
        
        process.on('SIGINT', () => { 
            logger.info('SIGINT received, shutting down gracefully...');
            pool.end(() => {
                logger.info('Database connections closed');
                process.exit(0);
            });
        });
        
    } catch (error) {
        logger.error('Failed to start server:', error.message);
        process.exit(1);
    }
}

startServer();