# TaskWeaver - Windows Installation Script
# Run this in PowerShell as Administrator

Write-Host "🚀 TaskWeaver Installation Script v2.0" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""

# Function to print colored output
function Write-Status {
    param([string]$Message)
    Write-Host "[✓] $Message" -ForegroundColor Green
}

function Write-Error {
    param([string]$Message)
    Write-Host "[✗] $Message" -ForegroundColor Red
}

function Write-Info {
    param([string]$Message)
    Write-Host "[i] $Message" -ForegroundColor Cyan
}

function Write-Warning {
    param([string]$Message)
    Write-Host "[!] $Message" -ForegroundColor Yellow
}

# Get the user's Desktop path
$DesktopPath = [Environment]::GetFolderPath("Desktop")
$DefaultLogoPath = Join-Path $DesktopPath "TaskWeaver System\Copilot_20260324_104928.png"

# Step 1: Get project directory name
Write-Info "Enter project directory name (default: TaskWeaver_System):"
$ProjectName = Read-Host
if ([string]::IsNullOrWhiteSpace($ProjectName)) {
    $ProjectName = "TaskWeaver_System"
}

# Create project directory
Write-Info "Creating project directory..."
New-Item -ItemType Directory -Force -Path $ProjectName | Out-Null
Set-Location $ProjectName
Write-Status "Project directory created: $(Get-Location)"

# Step 2: Create folder structure
Write-Info "Creating folder structure..."
$Folders = @(
    "public\css",
    "public\js", 
    "public\images",
    "logs",
    "backups"
)
foreach ($Folder in $Folders) {
    New-Item -ItemType Directory -Force -Path $Folder | Out-Null
}
Write-Status "Folder structure created"

# Step 3: Prompt for logo path
Write-Host ""
Write-Info "Please provide the path to your TaskWeaver logo image:"
Write-Host "Default: $DefaultLogoPath"
$LogoPath = Read-Host "Enter logo path (press Enter for default, or type 'skip' to skip)"

if ($LogoPath -eq "skip") {
    Write-Warning "Skipping logo installation"
} else {
    if ([string]::IsNullOrWhiteSpace($LogoPath)) {
        $LogoPath = $DefaultLogoPath
    }
    
    if (Test-Path $LogoPath) {
        Copy-Item $LogoPath "public\images\logo.png" -Force
        Write-Status "Logo copied successfully to public\images\logo.png"
    } else {
        Write-Warning "Logo not found at: $LogoPath"
        $Retry = Read-Host "Would you like to enter a different path? (y/n)"
        if ($Retry -eq "y") {
            $NewPath = Read-Host "Enter new logo path"
            if (Test-Path $NewPath) {
                Copy-Item $NewPath "public\images\logo.png" -Force
                Write-Status "Logo copied successfully"
            } else {
                Write-Warning "Continuing without logo"
            }
        } else {
            Write-Warning "Continuing without logo"
        }
    }
}

# Step 4: Initialize npm
Write-Info "Initializing npm project..."
npm init -y 2>$null
if ($LASTEXITCODE -eq 0) {
    Write-Status "npm initialized"
} else {
    Write-Error "Failed to initialize npm. Make sure Node.js is installed."
    exit 1
}

# Step 5: Install dependencies
Write-Info "Installing dependencies..."
$Packages = @(
    "express@4.18.2",
    "sqlite3@5.1.6", 
    "body-parser@1.20.2",
    "cors@2.8.5",
    "nodemailer@6.9.7",
    "node-cron@3.0.3",
    "bcrypt@5.1.1",
    "express-session@1.17.3",
    "connect-sqlite3@0.9.13",
    "dotenv@16.3.1",
    "nodemon@3.0.1"
)

foreach ($Package in $Packages) {
    Write-Info "Installing $Package..."
    npm install $Package --save 2>$null
}

Write-Status "Dependencies installed"

# Step 6: Create .env file
Write-Info "Creating environment configuration..."
$envContent = @"
# TaskWeaver Environment Configuration
EMAIL_USER=your-email@gmail.com
EMAIL_PASS=your-app-password
SESSION_SECRET=taskweaver_secret_key_2024
PORT=3000
"@
$envContent | Out-File -FilePath ".env" -Encoding utf8
Write-Status ".env file created - Please update with your email credentials"

# Step 7: Create database schema file
Write-Info "Creating database schema file..."
$schemaContent = @"
-- TaskWeaver Database Schema
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    reset_token TEXT,
    reset_token_expiry DATETIME,
    reminder_interval INTEGER DEFAULT 20,
    auto_reminders BOOLEAN DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_login DATETIME
);

CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    project TEXT,
    category TEXT,
    severity TEXT DEFAULT 'Medium',
    deadline DATETIME,
    is_recurring BOOLEAN DEFAULT 0,
    recurrence_pattern TEXT,
    scheduled_start DATETIME,
    scheduled_end DATETIME,
    completed BOOLEAN DEFAULT 0,
    email_reminder_sent BOOLEAN DEFAULT 0,
    deadline_reminder_sent BOOLEAN DEFAULT 0,
    overdue_reminder_sent BOOLEAN DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    task_id INTEGER NOT NULL,
    reminder_time DATETIME NOT NULL,
    reminder_type TEXT DEFAULT 'scheduled',
    sent BOOLEAN DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS suggestions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    suggestion TEXT NOT NULL,
    type TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    details TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tasks_user_id ON tasks(user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_scheduled_start ON tasks(scheduled_start);
CREATE INDEX IF NOT EXISTS idx_tasks_deadline ON tasks(deadline);
CREATE INDEX IF NOT EXISTS idx_reminders_reminder_time ON reminders(reminder_time);
CREATE INDEX IF NOT EXISTS idx_reminders_type ON reminders(reminder_type);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
"@
$schemaContent | Out-File -FilePath "schema.sql" -Encoding utf8
Write-Status "Schema file created"

# Step 8: Initialize database
Write-Info "Initializing database..."

# Check if sqlite3 is available
$sqlite3Path = Get-Command sqlite3 -ErrorAction SilentlyContinue
if ($sqlite3Path) {
    try {
        # Read schema file and pipe to sqlite3
        $schema = Get-Content "schema.sql" -Raw
        $schema | sqlite3 database.sqlite 2>&1 | Out-Null
        
        if (Test-Path "database.sqlite") {
            Write-Status "Database created successfully"
            
            # Verify tables were created
            $tableCount = sqlite3 database.sqlite "SELECT count(*) FROM sqlite_master WHERE type='table';" 2>&1
            if ($tableCount -match '\d+') {
                Write-Info "Created $($Matches[0]) tables"
            }
        } else {
            Write-Warning "Database file not created. Will be created by server.js on first run."
        }
    } catch {
        Write-Warning "Database creation failed: $_"
        Write-Warning "Database will be created automatically by server.js on first run."
    }
} else {
    Write-Warning "SQLite3 not found. Database will be created by server.js on first run."
    Write-Info "To install SQLite3, download it from: https://www.sqlite.org/download.html"
}

# Step 9: Update package.json
Write-Info "Updating package.json..."
$PackageJsonPath = "package.json"
if (Test-Path $PackageJsonPath) {
    try {
        $PackageJson = Get-Content $PackageJsonPath -Raw | ConvertFrom-Json
        $PackageJson.scripts = @{
            start = "node server.js"
            dev = "nodemon server.js"
            "db:init" = "sqlite3 database.sqlite < schema.sql"
        }
        $PackageJson | ConvertTo-Json -Depth 10 | Set-Content $PackageJsonPath
        Write-Status "package.json updated"
    } catch {
        Write-Warning "Failed to update package.json"
    }
}

# Step 10: Create CSS file
Write-Info "Creating CSS file..."
$cssContent = @"
/* TaskWeaver Main Styles */
:root {
    --primary: #6B46C1;
    --primary-dark: #553C9A;
    --primary-light: #9F7AEA;
    --success: #48BB78;
    --danger: #F56565;
    --warning: #F6AD55;
    --info: #4299E1;
}

* {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
}

body {
    font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    min-height: 100vh;
}

.glass-card {
    background: rgba(255, 255, 255, 0.95);
    backdrop-filter: blur(10px);
    border-radius: 20px;
    padding: 20px;
    margin-bottom: 20px;
    transition: transform 0.3s ease;
    box-shadow: 0 4px 6px rgba(0,0,0,0.1);
}

.glass-card:hover {
    transform: translateY(-5px);
}

.timer-container {
    text-align: center;
    padding: 20px;
    background: linear-gradient(135deg, var(--primary), var(--primary-dark));
    border-radius: 15px;
    color: white;
}

.timer-display {
    font-size: 3rem;
    font-weight: bold;
    font-family: monospace;
}

.btn-focus {
    background: white;
    color: var(--primary);
    border: none;
    padding: 8px 16px;
    margin: 5px;
    border-radius: 8px;
    cursor: pointer;
}

.calendar-container {
    background: white;
    border-radius: 20px;
    padding: 20px;
}

@media (max-width: 768px) {
    .timer-display {
        font-size: 2rem;
    }
}
"@
$cssContent | Out-File -FilePath "public\css\style.css" -Encoding utf8
Write-Status "CSS file created"

# Step 11: Create JavaScript file
Write-Info "Creating JavaScript file..."
$jsContent = @"
// TaskWeaver Dashboard JavaScript
let calendar;
let timerInterval = null;
let timerSeconds = 25 * 60;

document.addEventListener('DOMContentLoaded', async () => {
    await checkAuth();
    await loadTasks();
    initCalendar();
    initTimer();
    
    const taskForm = document.getElementById('taskForm');
    if (taskForm) {
        taskForm.addEventListener('submit', addTask);
    }
});

async function checkAuth() {
    try {
        const response = await fetch('/api/check-session');
        const data = await response.json();
        if (!data.authenticated) {
            window.location.href = '/login.html';
        } else {
            const userDisplay = document.getElementById('userDisplay');
            if (userDisplay) {
                userDisplay.innerHTML = '<i class="fas fa-user"></i> ' + data.username;
            }
        }
    } catch (error) {
        console.error('Auth check failed:', error);
        window.location.href = '/login.html';
    }
}

async function loadTasks() {
    try {
        const response = await fetch('/api/tasks');
        const tasks = await response.json();
        if (calendar) {
            calendar.removeAllEvents();
            tasks.forEach(task => {
                if (task.scheduled_start && !task.completed) {
                    calendar.addEvent({
                        id: task.id.toString(),
                        title: task.title,
                        start: task.scheduled_start,
                        end: task.scheduled_end,
                        backgroundColor: getSeverityColor(task.severity)
                    });
                }
            });
        }
    } catch (error) {
        console.error('Failed to load tasks:', error);
    }
}

async function addTask(e) {
    e.preventDefault();
    const title = document.getElementById('taskTitle').value;
    const description = document.getElementById('taskDesc').value;
    const severity = document.getElementById('taskSeverity').value;
    
    try {
        const response = await fetch('/api/tasks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title, description, severity })
        });
        
        if (response.ok) {
            document.getElementById('taskForm').reset();
            await loadTasks();
            alert('Task added successfully!');
        } else {
            alert('Failed to add task');
        }
    } catch (error) {
        console.error('Add task failed:', error);
        alert('Error adding task');
    }
}

function initCalendar() {
    const calendarEl = document.getElementById('calendar');
    if (calendarEl) {
        calendar = new FullCalendar.Calendar(calendarEl, {
            initialView: 'timeGridWeek',
            headerToolbar: {
                left: 'prev,next today',
                center: 'title',
                right: 'dayGridMonth,timeGridWeek,timeGridDay'
            },
            slotMinTime: '06:00:00',
            slotMaxTime: '22:00:00',
            height: 'auto',
            eventClick: function(info) {
                alert('Task: ' + info.event.title);
            }
        });
        calendar.render();
    }
}

function getSeverityColor(severity) {
    const colors = {
        'Critical': '#dc3545',
        'High': '#fd7e14',
        'Medium': '#ffc107',
        'Low': '#28a745'
    };
    return colors[severity] || '#6B46C1';
}

function initTimer() {
    updateTimerDisplay();
}

function startTimer(minutes) {
    stopTimer();
    timerSeconds = minutes * 60;
    updateTimerDisplay();
    timerInterval = setInterval(() => {
        if (timerSeconds <= 0) {
            stopTimer();
            alert('Time is up! Take a break!');
        } else {
            timerSeconds--;
            updateTimerDisplay();
        }
    }, 1000);
}

function stopTimer() {
    if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
    }
    timerSeconds = 25 * 60;
    updateTimerDisplay();
}

function updateTimerDisplay() {
    const minutes = Math.floor(timerSeconds / 60);
    const seconds = timerSeconds % 60;
    const timerDisplay = document.getElementById('timer');
    if (timerDisplay) {
        timerDisplay.textContent = minutes.toString().padStart(2, '0') + ':' + seconds.toString().padStart(2, '0');
    }
}

async function logout() {
    try {
        await fetch('/api/logout', { method: 'POST' });
        window.location.href = '/login.html';
    } catch (error) {
        console.error('Logout failed:', error);
        window.location.href = '/login.html';
    }
}
"@
$jsContent | Out-File -FilePath "public\js\dashboard.js" -Encoding utf8
Write-Status "JavaScript file created"

# Step 12: Create login.html
Write-Info "Creating login page..."
$loginContent = @'
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>TaskWeaver - Login</title>
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.1.3/dist/css/bootstrap.min.css" rel="stylesheet">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css">
    <link rel="stylesheet" href="/css/style.css">
</head>
<body style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh;">
    <div class="container d-flex align-items-center justify-content-center min-vh-100">
        <div class="glass-card" style="max-width: 400px; width: 100%;">
            <div class="text-center mb-4">
                <img src="/images/logo.png" alt="TaskWeaver" style="width: 80px; height: 80px; border-radius: 50%; object-fit: cover;" onerror="this.style.display='none'">
                <h2 class="mt-3">TaskWeaver</h2>
                <p class="text-muted">Weaving Productivity into Your Life</p>
            </div>
            <form id="loginForm">
                <div class="mb-3">
                    <input type="email" class="form-control" id="email" placeholder="Email" required>
                </div>
                <div class="mb-3">
                    <input type="password" class="form-control" id="password" placeholder="Password" required>
                </div>
                <button type="submit" class="btn btn-primary w-100">Login</button>
            </form>
            <div class="text-center mt-3">
                <a href="#" onclick="showRegister()">Create Account</a> |
                <a href="#" onclick="showForgotPassword()">Forgot Password?</a>
            </div>
        </div>
    </div>
    <script>
        document.getElementById('loginForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const email = document.getElementById('email').value;
            const password = document.getElementById('password').value;
            
            try {
                const response = await fetch('/api/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email, password })
                });
                
                const data = await response.json();
                if (response.ok && data.success) {
                    window.location.href = '/index.html';
                } else {
                    alert(data.error || 'Login failed');
                }
            } catch (error) {
                console.error('Login error:', error);
                alert('Login failed. Please try again.');
            }
        });
        
        function showRegister() {
            alert('Registration form will be available in the full version');
        }
        
        function showForgotPassword() {
            alert('Password reset will be available in the full version');
        }
    </script>
</body>
</html>
'@
$loginContent | Out-File -FilePath "public\login.html" -Encoding utf8
Write-Status "Login page created"

# Step 13: Create index.html (dashboard)
Write-Info "Creating dashboard page..."
$indexContent = @'
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>TaskWeaver - Dashboard</title>
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.1.3/dist/css/bootstrap.min.css" rel="stylesheet">
    <link href="https://cdn.jsdelivr.net/npm/fullcalendar@5.11.3/main.min.css" rel="stylesheet">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css">
    <link rel="stylesheet" href="/css/style.css">
</head>
<body>
    <div class="container-fluid py-4">
        <div class="row">
            <div class="col-12">
                <div class="glass-card d-flex justify-content-between align-items-center">
                    <div>
                        <img src="/images/logo.png" alt="TaskWeaver" style="width: 40px; height: 40px; border-radius: 50%; object-fit: cover;" onerror="this.style.display='none'">
                        <h1 class="d-inline-block ms-2">TaskWeaver</h1>
                    </div>
                    <div>
                        <span id="userDisplay" class="me-3"></span>
                        <button class="btn btn-danger" onclick="logout()">
                            <i class="fas fa-sign-out-alt"></i> Logout
                        </button>
                    </div>
                </div>
            </div>
        </div>
        
        <div class="row mt-3">
            <div class="col-md-3">
                <div class="glass-card">
                    <h4><i class="fas fa-plus-circle"></i> Add Task</h4>
                    <form id="taskForm">
                        <input type="text" class="form-control mb-2" id="taskTitle" placeholder="Title" required>
                        <textarea class="form-control mb-2" id="taskDesc" placeholder="Description" rows="2"></textarea>
                        <select class="form-control mb-2" id="taskSeverity">
                            <option value="Low">Low Priority</option>
                            <option value="Medium" selected>Medium Priority</option>
                            <option value="High">High Priority</option>
                            <option value="Critical">Critical Priority</option>
                        </select>
                        <button type="submit" class="btn btn-primary w-100">
                            <i class="fas fa-save"></i> Add Task
                        </button>
                    </form>
                </div>
                
                <div class="timer-container mt-3">
                    <h5><i class="fas fa-hourglass-half"></i> Focus Mode</h5>
                    <div class="timer-display" id="timer">25:00</div>
                    <div class="mt-3">
                        <button class="btn-focus" onclick="startTimer(25)">
                            <i class="fas fa-play"></i> 25 min
                        </button>
                        <button class="btn-focus" onclick="startTimer(5)">
                            <i class="fas fa-coffee"></i> 5 min
                        </button>
                        <button class="btn-focus" onclick="stopTimer()">
                            <i class="fas fa-stop"></i> Stop
                        </button>
                    </div>
                </div>
            </div>
            
            <div class="col-md-9">
                <div class="calendar-container">
                    <div id="calendar"></div>
                </div>
            </div>
        </div>
    </div>
    
    <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.1.3/dist/js/bootstrap.bundle.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/fullcalendar@5.11.3/main.min.js"></script>
    <script src="/js/dashboard.js"></script>
</body>
</html>
'@
$indexContent | Out-File -FilePath "public\index.html" -Encoding utf8
Write-Status "Dashboard page created"

# Step 14: Create start.bat
Write-Info "Creating start script..."
$startBatContent = @'
@echo off
echo Starting TaskWeaver Server...
echo.
echo Server will be available at http://localhost:3000
echo.
echo Press Ctrl+C to stop the server
echo.
npm start
pause
'@
$startBatContent | Out-File -FilePath "start.bat" -Encoding ascii
Write-Status "Start script created"

# Step 15: Create README file
Write-Info "Creating README file..."
$readmeContent = @'
# TaskWeaver Installation Complete

## Quick Start
1. Update the `.env` file with your email credentials
2. Copy your complete `server.js` file to this directory
3. Run `npm start` or double-click `start.bat`
4. Open browser to `http://localhost:3000`

## Default Login (after adding server.js)
- Email: demo@taskweaver.com
- Password: Demo@2024

## Folder Structure
- `/public` - Static files (HTML, CSS, JS, images)
- `/logs` - Application logs
- `/backups` - Database backups
- `database.sqlite` - SQLite database file
- `server.js` - Main application file

## Features
- Task management with calendar integration
- Email reminders for upcoming deadlines
- Overdue task notifications
- Focus timer for productivity
- User authentication and session management

## Support
For issues, check the logs folder or contact support.
'@
$readmeContent | Out-File -FilePath "README.md" -Encoding utf8
Write-Status "README file created"

# Final instructions
Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "✅ TaskWeaver Installation Complete!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
Write-Info "Next steps:"
Write-Host "1. Update the .env file with your email credentials"
Write-Host "2. Copy your complete server.js file to the project directory"
Write-Host "3. Run the application: npm start or double-click start.bat"
Write-Host ""
Write-Info "Project Information:"
Write-Host "Project directory: $(Get-Location)" -ForegroundColor Yellow
Write-Host "Logo location: $(Get-Location)\public\images\logo.png"
Write-Host "Database location: $(Get-Location)\database.sqlite"
Write-Host "Backup location: $(Get-Location)\backups"
Write-Host ""
Write-Info "Quick Start:"
Write-Host "1. Open PowerShell in: $(Get-Location)"
Write-Host "2. Run: npm install (if not already done)"
Write-Host "3. Run: npm start"
Write-Host "4. Open browser: http://localhost:3000"
Write-Host ""
Write-Status "Installation completed successfully!"
Write-Host ""

# Optional: Open the project folder
$OpenFolder = Read-Host "Open project folder? (y/n)"
if ($OpenFolder -eq "y") {
    explorer.exe .
}