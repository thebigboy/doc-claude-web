// server.js
const express = require('express');
const path = require('path');
const { spawn } = require('child_process');
const sqlite3 = require('sqlite3').verbose();
const cookieParser = require('cookie-parser');

const app = express();

// ===== 配置区域 =====

// 你的本地代码库路径
const PROJECT_ROOT = '/Users/wangzhen/code/examples/erp.vedeng.com';

// Claude CLI 绝对路径
const CLAUDE_CMD = '/opt/homebrew/bin/claude';

// 数据库路径
const DB_PATH = path.join(__dirname, 'chat_history.db');

// ===== 数据库初始化 =====

const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('数据库连接失败:', err.message);
  } else {
    console.log('数据库连接成功:', DB_PATH);
    initDatabase();
  }
});

function initDatabase() {
  db.run(`
    CREATE TABLE IF NOT EXISTS chat_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      question TEXT NOT NULL,
      answer TEXT,
      duration_seconds INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `, (err) => {
    if (err) {
      console.error('创建表失败:', err.message);
    } else {
      console.log('数据表 chat_logs 已就绪');
    }
  });
}

// ===== 中间件 & 静态资源 =====

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// ===== 认证中间件 =====

function requireAuth(req, res, next) {
  const username = req.cookies.username;

  if (!username) {
    // 未登录，返回 401
    return res.status(401).json({ error: '未登录', needLogin: true });
  }

  // 将用户名存储在请求对象中，供后续使用
  req.username = username;
  next();
}

// ===== 路由 =====

// 健康检查接口
app.get('/api/health', (req, res) => {
  res.json({ ok: true, projectRoot: PROJECT_ROOT, cmd: CLAUDE_CMD });
});

// 登录接口
app.post('/api/login', (req, res) => {
  const { username, remember } = req.body;

  if (!username || !username.trim()) {
    return res.status(400).json({ error: '用户名不能为空' });
  }

  const cleanUsername = username.trim();

  // 设置 cookie
  const cookieOptions = {
    httpOnly: false, // 允许前端读取（用于显示用户名）
    maxAge: remember ? 30 * 24 * 60 * 60 * 1000 : undefined // 30天 或 session
  };

  res.cookie('username', cleanUsername, cookieOptions);

  res.json({ success: true, username: cleanUsername });
});

// 退出登录接口
app.post('/api/logout', (req, res) => {
  res.clearCookie('username');
  res.json({ success: true });
});

// 获取当前用户信息
app.get('/api/current-user', requireAuth, (req, res) => {
  res.json({ username: req.username });
});

// ===== 管理后台接口 =====

// 获取所有用户及最后会话时间
app.get('/api/admin/users', (req, res) => {
  const sql = `
    SELECT
      username,
      MAX(created_at) as last_chat_time,
      COUNT(*) as chat_count
    FROM chat_logs
    GROUP BY username
    ORDER BY last_chat_time DESC
  `;

  db.all(sql, [], (err, rows) => {
    if (err) {
      console.error('[admin] 获取用户列表失败:', err.message);
      return res.status(500).json({ error: '获取用户列表失败' });
    }
    res.json({ users: rows });
  });
});

// 获取指定用户的会话记录
app.get('/api/admin/chats/:username', (req, res) => {
  const username = req.params.username;

  const sql = `
    SELECT
      id,
      question,
      answer,
      duration_seconds,
      created_at
    FROM chat_logs
    WHERE username = ?
    ORDER BY created_at DESC
  `;

  db.all(sql, [username], (err, rows) => {
    if (err) {
      console.error('[admin] 获取会话记录失败:', err.message);
      return res.status(500).json({ error: '获取会话记录失败' });
    }
    res.json({ chats: rows, username: username });
  });
});

// 核心接口：转发问题给 Claude，并基于本地代码库回答
app.post('/api/ask', requireAuth, (req, res) => {
  const question = (req.body && req.body.question) || '';
  const username = req.username;

  if (!question.trim()) {
    return res.status(400).json({ error: '问题不能为空' });
  }

  const startTime = Date.now();

  // 我们改成：通过 stdin 把问题喂给 claude，而不是作为参数。
  // 等价于在终端执行：
  //   cd /Users/wangzhen/code/ideaProjects/erp.vedeng.com
  //   echo "问题内容" | /opt/homebrew/bin/claude -p
  const args = ['-p'];

  console.log('========== 调用 /api/ask ==========');
  console.log('[claude-web] user =', username);
  console.log('[claude-web] cwd =', PROJECT_ROOT);
  console.log('[claude-web] cmd =', CLAUDE_CMD, args.map(a => JSON.stringify(a)).join(' '));
  console.log('[claude-web] question =', JSON.stringify(question));

  let stdoutBuf = '';
  let stderrBuf = '';
  let responded = false;

  const child = spawn(
      CLAUDE_CMD,
      args,
      {
        cwd: PROJECT_ROOT,
        env: {
          ...process.env,
          NO_COLOR: '1' // 尽量去掉彩色控制符，输出更干净
        }
      }
  );

  // 子进程事件监听（调试日志）
  child.on('spawn', () => {
    console.log('[claude-web] 子进程已启动，pid =', child.pid);
  });

  child.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    stdoutBuf += text;
    console.log('[claude-web] stdout chunk =\n', text);
  });

  child.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    stderrBuf += text;
    console.log('[claude-web] stderr chunk =\n', text);
  });

  child.on('error', (err) => {
    console.log('[claude-web] 子进程 error =', err);
    if (!responded) {
      responded = true;

      // 记录失败的问答
      const duration = Math.round((Date.now() - startTime) / 1000);
      saveToDatabase(username, question, `错误：${err.message}`, duration);

      return res.status(500).json({
        error: '启动 Claude 子进程失败',
        detail: err.message
      });
    }
  });

  child.on('close', (code, signal) => {
    console.log('[claude-web] 子进程 close, code =', code, ', signal =', signal);
    console.log('[claude-web] 最终 stdout =\n', stdoutBuf);
    console.log('[claude-web] 最终 stderr =\n', stderrBuf);

    if (responded) return;

    responded = true;

    const duration = Math.round((Date.now() - startTime) / 1000);

    if (code !== 0) {
      const errorMsg = `Claude 退出码非 0: ${code}`;
      const detail = stderrBuf || stdoutBuf || `signal=${signal}`;

      // 记录失败的问答
      saveToDatabase(username, question, `${errorMsg}\n${detail}`, duration);

      return res.status(500).json({
        error: errorMsg,
        detail: detail
      });
    }

    const answer = stdoutBuf || '(没有输出)';

    // 记录成功的问答
    saveToDatabase(username, question, answer, duration);

    res.json({
      answer: answer,
      stderr: stderrBuf || ''
    });
  });

  // 把问题写入 stdin，然后显式关闭 stdin
  child.stdin.write(question + '\n');
  child.stdin.end();

  // 保险起见，加一个超时防止无限挂起
  const KILL_TIMEOUT_MS = 5 * 60 * 1000; // 5 分钟
  setTimeout(() => {
    if (!responded) {
      console.log('[claude-web] 超时未返回，强制杀死子进程 pid =', child.pid);
      child.kill('SIGKILL');
      responded = true;

      const duration = Math.round((Date.now() - startTime) / 1000);
      const errorMsg = '调用 Claude 超时，子进程在超时时间内未退出，已被强制终止';

      // 记录超时的问答
      saveToDatabase(username, question, errorMsg, duration);

      res.status(500).json({
        error: '调用 Claude 超时',
        detail: '子进程在超时时间内未退出，已被强制终止'
      });
    }
  }, KILL_TIMEOUT_MS);
});

// ===== 数据库操作函数 =====

function saveToDatabase(username, question, answer, durationSeconds) {
  const sql = `
    INSERT INTO chat_logs (username, question, answer, duration_seconds)
    VALUES (?, ?, ?, ?)
  `;

  db.run(sql, [username, question, answer, durationSeconds], (err) => {
    if (err) {
      console.error('[claude-web] 保存聊天记录失败:', err.message);
    } else {
      console.log('[claude-web] 聊天记录已保存');
    }
  });
}

// ===== 启动服务 =====

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`服务器已启动：http://localhost:${PORT}`);
  console.log(`项目代码库路径：${PROJECT_ROOT}`);
  console.log(`使用命令：echo "你的问题" | ${CLAUDE_CMD} -p`);
});
