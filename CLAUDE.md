# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a web-based UI wrapper for Claude Code CLI. It provides a chat interface that allows users to interact with Claude Code through a browser, with the backend spawning Claude CLI processes to analyze a configured local codebase.

**Architecture**: Simple Express.js server with static HTML/CSS/JS frontend

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

### Testing
Access the application at `http://localhost:3000` after starting the server.

Use `/api/health` endpoint to verify configuration:
```bash
curl http://localhost:3000/api/health
```

## Configuration

**Important**: Before running, you must configure the paths in `server.js`:

- `PROJECT_ROOT` (line 11): Path to the local codebase that Claude Code will analyze
- `CLAUDE_CMD` (line 14): Absolute path to the Claude CLI executable

Default configuration references:
- Project: `/Users/wangzhen/code/ideaProjects/erp.vedeng.com`
- Command: `/opt/homebrew/bin/claude`

## Architecture Details

### Request Flow

1. User submits question via web UI (`public/index.html`)
2. Frontend sends POST request to `/api/ask` with question text
3. Backend spawns Claude CLI process:
   - Working directory: `PROJECT_ROOT`
   - Command: `claude -p` (plaintext mode)
   - Input: Question via stdin
4. Server collects stdout/stderr and returns to frontend
5. Frontend displays response in chat interface

### Key Implementation Details

**Process Management** (server.js:48-126):
- Questions are sent to Claude CLI via stdin (not command arguments)
- 5-minute timeout protection prevents hanging processes
- Stdout/stderr are buffered and logged for debugging
- `NO_COLOR=1` environment variable strips ANSI color codes

**Frontend** (public/index.html):
- Single-page application with chat interface
- Messages stored in-memory (cleared on page refresh)
- Loading indicator with animated GIF (`./images/loading.gif`)
- Keyboard shortcut: Ctrl/Cmd+Enter to send message

### API Endpoints

- `GET /api/health` - Health check, returns current configuration
- `POST /api/ask` - Main endpoint that processes questions
  - Request: `{ "question": "string" }`
  - Response: `{ "answer": "string", "stderr": "string" }` or `{ "error": "string", "detail": "string" }`

## Dependencies

- **express** (^4.19.2): Web server framework
- Built-in Node.js modules: `child_process`, `path`

No build step or bundler required - serves static files directly.

## Notes

- Not a git repository (no version control configured)
- Static assets served from `public/` directory
- Chinese UI labels (can be localized if needed)
- Hardcoded port 3000 (modify line 131 in server.js to change)
