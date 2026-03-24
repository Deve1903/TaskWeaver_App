# 🚀 TaskWeaver - Intelligent Task Management System

[![Node.js Version](https://img.shields.io/badge/node-%3E%3D14.0.0-brightgreen)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![SQLite](https://img.shields.io/badge/database-SQLite3-blue)](https://www.sqlite.org/)
[![Express](https://img.shields.io/badge/framework-Express.js-green)](https://expressjs.com/)

**TaskWeaver** is a comprehensive, full-featured task management application that transforms how individuals and teams organize, schedule, and track their work. Built with a modern tech stack, it combines a sleek calendar interface with an intuitive task funnel system, making task management both visual and efficient.

## ✨ Key Features

### 📋 Smart Task Management
- **Dual Interface**: Seamlessly switch between Task Funnel (unscheduled tasks) and Calendar views
- **Drag & Drop Scheduling**: Simply drag tasks from the funnel onto the calendar to schedule them
- **Priority Levels**: Critical, High, Medium, and Low priority tasks with color-coded visual indicators
- **Rich Task Details**: Add descriptions, projects, categories, deadlines, tags, and recurrence patterns
- **Project Organization**: Group tasks by projects with progress tracking

### 📅 Visual Calendar Integration
- **Multiple Views**: Day, Week, and Month views with FullCalendar integration
- **Time-Aware Scheduling**: Set precise start and end times for tasks
- **Deadline Tracking**: Visual indicators for approaching and overdue deadlines
- **Real-time Updates**: Instant calendar updates when tasks are created, moved, or completed

### 🔔 Intelligent Reminders
- **Email Notifications**: Automated reminders before scheduled tasks
- **Deadline Alerts**: Proactive notifications for approaching deadlines
- **Overdue Task Warnings**: Alerts for tasks that have passed their deadlines
- **Configurable Intervals**: Customize reminder timing to match your workflow

### 👥 Collaboration & Sharing
- **Schedule Sharing**: Share your entire schedule with other TaskWeaver users
- **Multi-Format Exports**: Export schedules as PDF, Excel, CSV, or JSON
- **Email Attachments**: Shared schedules include PDF, Excel, and CSV attachments
- **Secure Access**: Token-based sharing with expiration dates

### 📊 Analytics & Insights
- **Statistics Dashboard**: Visual overview of completed, scheduled, and overdue tasks
- **Productivity Metrics**: Track weekly task completion and priority distribution
- **Activity Logging**: Complete audit trail of all user actions
- **Performance Trends**: Monitor your productivity over time

## 🛠️ Technical Stack

### Backend
| Technology | Purpose |
|------------|---------|
| Node.js | Runtime environment |
| Express.js | Web application framework |
| SQLite3 | Lightweight, file-based database |
| Nodemailer | Email delivery system |
| Node-Cron | Scheduled task automation |
| bcrypt | Password encryption |
| Express-Session | Session management with SQLite store |

### Frontend
| Technology | Purpose |
|------------|---------|
| HTML5/CSS3 | Modern, responsive UI |
| Bootstrap 5 | Responsive framework |
| FullCalendar | Interactive calendar component |
| Font Awesome | Icon library |
| SortableJS | Drag-and-drop functionality |
| JavaScript | Dynamic client-side interactions |

### Export Capabilities
| Library | Purpose |
|---------|---------|
| PDFKit | Professional PDF generation with custom styling |
| ExcelJS | Excel spreadsheet creation |
| json2csv | CSV data export |

## 📦 Installation

### Prerequisites
- Node.js (v14.0.0 or higher)
- npm (v6.0.0 or higher)

### Step-by-Step Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/yourusername/taskweaver.git
   cd taskweaver