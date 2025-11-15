# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a web-based UI wrapper for Claude Code CLI with knowledge base management functionality. It provides:
1. A chat interface for users to interact with Claude Code
2. An admin portal for uploading PDFs and managing knowledge base
3. Automatic PDF-to-Markdown conversion
4. Integration of knowledge base content into Claude queries

**Architecture**: Express.js server with static HTML/CSS/JS frontend + SQLite database

## Key Features

### User Features
- Chat interface with Claude Code based on local codebase analysis
- Optional knowledge base mode (checkbox to include uploaded PDF content)
- User authentication with cookie-based sessions
- Chat history tracking

### Admin Features (accessible at `/admin/`)
- Password-protected admin portal (default: `admin123`)
- PDF file upload (up to 50MB)
- Automatic PDF to Markdown conversion
- File management: view status, delete, reconvert, preview
- Status tracking: pending, processing, completed, failed

## Key Commands

### Development
```bash
# Install dependencies
npm install

# Start the server (runs on port 3000)
npm start

# Or directly
node server.js
```

### Environment Variables
```bash
# Set custom admin password (recommended)
export ADMIN_PASSWORD=your-secure-password

# Set session secret (recommended for production)
export SESSION_SECRET=your-session-secret
```

### Testing
- Main interface: `http://localhost:3000`
- Admin portal: `http://localhost:3000/admin/`
- Health check: `http://localhost:3000/api/health`

## Configuration

**Important**: Before running, you must configure the paths in `server.js`:

- `PROJECT_ROOT` (line 18): Path to the local codebase that Claude Code will analyze
- `CLAUDE_CMD` (line 21): Absolute path to the Claude CLI executable
- `ADMIN_PASSWORD` (line 27): Admin password (default: 'admin123', use env var to override)

Default configuration:
- Project: `/Users/wangzhen/code/examples/erp.vedeng.com`
- Command: `/opt/homebrew/bin/claude`
- Admin password: `admin123` (change via `ADMIN_PASSWORD` env var)

## Directory Structure

```
.
├── server.js           # Main Express server
├── package.json        # Dependencies
├── chat_history.db     # SQLite database (auto-created)
├── pdf/                # Uploaded PDF files (auto-created)
├── md/                 # Converted Markdown files (auto-created)
└── public/
    ├── index.html      # Main chat interface
    ├── login.html      # User login page
    ├── admin/
    │   └── index.html  # Admin portal
    └── images/         # Static assets
```

## Architecture Details

### Request Flow

#### Standard Query Flow
1. User submits question via web UI (`public/index.html`)
2. Frontend sends POST request to `/api/ask` with `{ question, useKnowledgeBase }`
3. If `useKnowledgeBase=true`, server reads all completed MD files from database
4. Backend spawns Claude CLI process with augmented prompt
5. Server collects stdout/stderr and returns to frontend
6. Response saved to database with username and timestamp

#### Knowledge Base Upload Flow
1. Admin logs in at `/admin/` with password
2. Admin uploads PDF file (drag-drop or file picker)
3. Server saves PDF to `pdf/` directory
4. Database record created with status='processing'
5. `convertPdfToMarkdown()` function extracts text and formats as Markdown
6. MD file saved to `md/` directory
7. Status updated to 'completed' or 'failed'
8. Admin can view status, preview MD, or reconvert if needed

### Key Implementation Details

**PDF Conversion** (server.js:377-417):
- Uses `pdf-parse` library to extract text from PDF
- Simple heuristic formatting: detects titles, lists, paragraphs
- Converts to Markdown with preserved structure
- Async processing with status tracking

**Knowledge Base Integration** (server.js:463-507):
- When `useKnowledgeBase=true`, queries database for completed files
- Reads all MD files and concatenates content
- Prepends to user question: "根据md/目录下的知识库内容，回答以下问题："
- Full knowledge base content included in Claude prompt

**Authentication**:
- User auth: Cookie-based username storage (no password, login.html)
- Admin auth: Session-based with password verification
- Middleware: `requireAuth` for users, `requireAdminAuth` for admin

**Database Schema**:
- `chat_logs`: username, question, answer, duration_seconds, created_at
- `pdf_files`: filename, original_name, pdf_path, md_path, status, error_message, file_size, uploaded_at, converted_at

### API Endpoints

#### Public Endpoints
- `GET /api/health` - Health check
- `POST /api/login` - User login (username only)
- `POST /api/logout` - User logout
- `GET /api/current-user` - Get current logged-in user

#### User Endpoints (requires auth)
- `POST /api/ask` - Main query endpoint
  - Request: `{ "question": "string", "useKnowledgeBase": boolean }`
  - Response: `{ "answer": "string", "stderr": "string" }`

#### Admin Endpoints (requires admin auth)
- `POST /api/admin/login` - Admin login
  - Request: `{ "password": "string" }`
- `POST /api/admin/logout` - Admin logout
- `GET /api/admin/status` - Check admin login status
- `POST /api/admin/upload` - Upload PDF (multipart/form-data)
- `GET /api/admin/files` - List all uploaded files with status
- `DELETE /api/admin/files/:id` - Delete file (PDF + MD)
- `POST /api/admin/convert/:id` - Reconvert PDF to MD
- `GET /api/admin/preview/:id` - Preview MD content
- `GET /api/admin/users` - Get user list with chat stats
- `GET /api/admin/chats/:username` - Get user's chat history

## Dependencies

- **express** (^4.19.2): Web server framework
- **sqlite3** (^5.1.7): SQLite database
- **cookie-parser** (^1.4.6): Cookie parsing
- **multer**: File upload handling
- **pdf-parse**: PDF text extraction
- **express-session**: Session management

Built-in Node.js modules: `child_process`, `path`, `fs`

## Usage Guide

### For End Users

1. Access `http://localhost:3000`
2. Login with any username (no password required)
3. Type your question in the chat
4. [Optional] Check "使用知识库" to include uploaded PDF content
5. Press "发送" or Ctrl/Cmd+Enter

### For Administrators

1. Access `http://localhost:3000/admin/`
2. Login with admin password (default: `admin123`)
3. Upload PDF files by drag-drop or clicking upload area
4. Monitor conversion status in file list
5. Use action buttons to:
   - **预览**: View converted Markdown content
   - **重转**: Reconvert failed or outdated files
   - **删除**: Delete files (both PDF and MD)

## Security Notes

- Change `ADMIN_PASSWORD` before deploying to production
- Use `SESSION_SECRET` environment variable for session security
- User authentication is username-only (suitable for internal/trusted environments)
- Admin portal is password-protected
- File uploads limited to 50MB PDFs only
- No file upload validation beyond extension/mimetype check

## Notes

- Static assets served from `public/` directory
- Chinese UI labels throughout
- Port 3000 (modify server.js line ~312 to change)
- Session expires after 24 hours
- Background PDF conversion (non-blocking)
