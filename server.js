// server.js
const express = require('express');
const path = require('path');
const { spawn } = require('child_process');
const sqlite3 = require('sqlite3').verbose();
const cookieParser = require('cookie-parser');
const multer = require('multer');
const fs = require('fs').promises;
const fsSync = require('fs');
const pdfParse = require('pdf-parse');
const session = require('express-session');

const app = express();

// ===== 配置区域 =====

// 你的本地代码库路径
const PROJECT_ROOT = '/Users/wangzhen/code/test/doc-claude-web';

// Claude CLI 绝对路径
const CLAUDE_CMD = '/opt/homebrew/bin/claude';

// 数据库路径
const DB_PATH = path.join(__dirname, 'chat_history.db');

// 管理员密码（建议使用环境变量配置）
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

// PDF和MD文件目录
const PDF_DIR = path.join(__dirname, 'pdf');
const MD_DIR = path.join(__dirname, 'md');

// Session密钥
const SESSION_SECRET = process.env.SESSION_SECRET || 'your-secret-key-change-in-production';

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
  // 创建聊天记录表
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

  // 创建PDF文件表
  db.run(`
    CREATE TABLE IF NOT EXISTS pdf_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      pdf_path TEXT NOT NULL,
      md_path TEXT,
      status TEXT DEFAULT 'pending',
      error_message TEXT,
      file_size INTEGER,
      uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      converted_at DATETIME
    )
  `, (err) => {
    if (err) {
      console.error('创建pdf_files表失败:', err.message);
    } else {
      console.log('数据表 pdf_files 已就绪');
    }
  });
}

// ===== 中间件 & 静态资源 =====

app.use(express.json());
app.use(cookieParser());
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 24 * 60 * 60 * 1000, // 24小时
    httpOnly: true
  }
}));
app.use(express.static(path.join(__dirname, 'public')));

// ===== 文件上传配置 =====

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, PDF_DIR);
  },
  filename: (req, file, cb) => {
    // 使用已经转换好的utf8文件名（在fileFilter中已转换）
    const originalName = file.utf8name || file.originalname;
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(originalName);
    const baseName = path.basename(originalName, ext);
    // 使用原始文件名（去除特殊字符）+ 时间戳
    const safeName = baseName.replace(/[^\u4e00-\u9fa5a-zA-Z0-9_-]/g, '_');
    cb(null, safeName + '-' + uniqueSuffix + ext);
  }
});

// 单文件上传配置（仅PDF）
const upload = multer({
  storage: storage,
  fileFilter: (req, file, cb) => {
    // 修复中文文件名 - 保存到新属性避免重复转换
    try {
      file.utf8name = Buffer.from(file.originalname, 'latin1').toString('utf8');
    } catch (e) {
      file.utf8name = file.originalname;
    }

    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('只允许上传PDF文件'));
    }
  },
  limits: {
    fileSize: 50 * 1024 * 1024 // 50MB
  }
});

// 批量导入配置（PDF和MD）
const uploadBatch = multer({
  storage: storage,
  fileFilter: (req, file, cb) => {
    // 修复中文文件名 - 保存到新属性避免重复转换
    try {
      file.utf8name = Buffer.from(file.originalname, 'latin1').toString('utf8');
    } catch (e) {
      file.utf8name = file.originalname;
    }

    const ext = path.extname(file.utf8name || file.originalname).toLowerCase();
    if (ext === '.pdf' || ext === '.md') {
      cb(null, true);
    } else {
      cb(new Error('只允许上传PDF或Markdown文件'));
    }
  },
  limits: {
    fileSize: 50 * 1024 * 1024 // 50MB
  }
});

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

// 管理员认证中间件
function requireAdminAuth(req, res, next) {
  if (!req.session.isAdmin) {
    return res.status(401).json({ error: '需要管理员权限', needAdminLogin: true });
  }
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

// ===== 知识库管理接口 =====

// 管理员登录接口
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;

  if (password === ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    res.json({ success: true });
  } else {
    res.status(401).json({ error: '密码错误' });
  }
});

// 管理员登出接口
app.post('/api/admin/logout', (req, res) => {
  req.session.isAdmin = false;
  res.json({ success: true });
});

// 检查管理员登录状态
app.get('/api/admin/status', (req, res) => {
  res.json({ isAdmin: !!req.session.isAdmin });
});

// 上传PDF文件
app.post('/api/admin/upload', requireAdminAuth, upload.single('pdf'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: '未选择文件' });
  }

  const { filename, utf8name, path: pdfPath, size } = req.file;
  const originalname = utf8name || req.file.originalname; // 使用转换后的utf8文件名
  const mdFilename = filename.replace(/\.pdf$/i, '.md');
  const mdPath = path.join(MD_DIR, mdFilename);

  // 保存文件信息到数据库
  const sql = `
    INSERT INTO pdf_files (filename, original_name, pdf_path, md_path, status, file_size)
    VALUES (?, ?, ?, ?, 'processing', ?)
  `;

  db.run(sql, [filename, originalname, pdfPath, mdPath, size], async function(err) {
    if (err) {
      console.error('保存文件信息失败:', err.message);
      return res.status(500).json({ error: '保存文件信息失败' });
    }

    const fileId = this.lastID;

    // 异步转换PDF到MD
    convertPdfToMarkdown(pdfPath, mdPath)
      .then(result => {
        if (result.success) {
          db.run(
            'UPDATE pdf_files SET status = ?, converted_at = CURRENT_TIMESTAMP WHERE id = ?',
            ['completed', fileId]
          );
        } else {
          db.run(
            'UPDATE pdf_files SET status = ?, error_message = ? WHERE id = ?',
            ['failed', result.error, fileId]
          );
        }
      })
      .catch(error => {
        db.run(
          'UPDATE pdf_files SET status = ?, error_message = ? WHERE id = ?',
          ['failed', error.message, fileId]
        );
      });

    res.json({
      success: true,
      fileId: fileId,
      message: '文件上传成功，正在转换中...'
    });
  });
});

// 获取文件列表
app.get('/api/admin/files', requireAdminAuth, (req, res) => {
  const sql = `
    SELECT
      id,
      filename,
      original_name,
      status,
      error_message,
      file_size,
      uploaded_at,
      converted_at
    FROM pdf_files
    ORDER BY uploaded_at DESC
  `;

  db.all(sql, [], (err, rows) => {
    if (err) {
      console.error('获取文件列表失败:', err.message);
      return res.status(500).json({ error: '获取文件列表失败' });
    }
    res.json({ files: rows });
  });
});

// 删除文件
app.delete('/api/admin/files/:id', requireAdminAuth, async (req, res) => {
  const fileId = req.params.id;

  db.get('SELECT * FROM pdf_files WHERE id = ?', [fileId], async (err, row) => {
    if (err) {
      return res.status(500).json({ error: '查询文件失败' });
    }
    if (!row) {
      return res.status(404).json({ error: '文件不存在' });
    }

    try {
      // 删除物理文件
      if (row.pdf_path && fsSync.existsSync(row.pdf_path)) {
        await fs.unlink(row.pdf_path);
      }
      if (row.md_path && fsSync.existsSync(row.md_path)) {
        await fs.unlink(row.md_path);
      }

      // 删除数据库记录
      db.run('DELETE FROM pdf_files WHERE id = ?', [fileId], (err) => {
        if (err) {
          return res.status(500).json({ error: '删除数据库记录失败' });
        }
        res.json({ success: true });
      });
    } catch (error) {
      console.error('删除文件失败:', error);
      res.status(500).json({ error: '删除文件失败: ' + error.message });
    }
  });
});

// 重新转换PDF
app.post('/api/admin/convert/:id', requireAdminAuth, async (req, res) => {
  const fileId = req.params.id;

  db.get('SELECT * FROM pdf_files WHERE id = ?', [fileId], async (err, row) => {
    if (err) {
      return res.status(500).json({ error: '查询文件失败' });
    }
    if (!row) {
      return res.status(404).json({ error: '文件不存在' });
    }

    // 更新状态为处理中
    db.run('UPDATE pdf_files SET status = ?, error_message = NULL WHERE id = ?', ['processing', fileId]);

    // 异步转换
    convertPdfToMarkdown(row.pdf_path, row.md_path)
      .then(result => {
        if (result.success) {
          db.run(
            'UPDATE pdf_files SET status = ?, converted_at = CURRENT_TIMESTAMP WHERE id = ?',
            ['completed', fileId]
          );
        } else {
          db.run(
            'UPDATE pdf_files SET status = ?, error_message = ? WHERE id = ?',
            ['failed', result.error, fileId]
          );
        }
      })
      .catch(error => {
        db.run(
          'UPDATE pdf_files SET status = ?, error_message = ? WHERE id = ?',
          ['failed', error.message, fileId]
        );
      });

    res.json({ success: true, message: '开始重新转换' });
  });
});

// 预览MD内容
app.get('/api/admin/preview/:id', requireAdminAuth, async (req, res) => {
  const fileId = req.params.id;

  db.get('SELECT * FROM pdf_files WHERE id = ?', [fileId], async (err, row) => {
    if (err) {
      return res.status(500).json({ error: '查询文件失败' });
    }
    if (!row) {
      return res.status(404).json({ error: '文件不存在' });
    }
    if (row.status !== 'completed') {
      return res.status(400).json({ error: '文件尚未转换完成' });
    }

    try {
      const content = await fs.readFile(row.md_path, 'utf8');
      res.json({ content: content, filename: row.original_name });
    } catch (error) {
      res.status(500).json({ error: '读取文件失败: ' + error.message });
    }
  });
});

// 批量导入接口 - 支持多个PDF或MD文件
app.post('/api/admin/batch-import', requireAdminAuth, uploadBatch.array('files', 500), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: '未选择文件' });
  }

  const results = {
    total: req.files.length,
    success: 0,
    failed: 0,
    processing: 0,
    files: []
  };

  // 异步处理所有文件
  const processFiles = async () => {
    for (const file of req.files) {
      try {
        const originalname = file.utf8name || file.originalname;
        const ext = path.extname(originalname).toLowerCase();

        if (ext === '.pdf') {
          // PDF文件：保存到数据库并转换
          const { filename, path: pdfPath, size } = file;
          const mdFilename = filename.replace(/\.pdf$/i, '.md');
          const mdPath = path.join(MD_DIR, mdFilename);

          const sql = `
            INSERT INTO pdf_files (filename, original_name, pdf_path, md_path, status, file_size)
            VALUES (?, ?, ?, ?, 'processing', ?)
          `;

          await new Promise((resolve) => {
            db.run(sql, [filename, originalname, pdfPath, mdPath, size], async function(err) {
              if (err) {
                console.error('保存文件信息失败:', originalname, err.message);
                results.failed++;
                results.files.push({ name: originalname, status: 'failed', error: err.message });
                resolve();
                return;
              }

              const fileId = this.lastID;
              results.processing++;
              results.files.push({ name: originalname, status: 'processing', id: fileId });

              // 异步转换
              convertPdfToMarkdown(pdfPath, mdPath)
                .then(result => {
                  if (result.success) {
                    db.run(
                      'UPDATE pdf_files SET status = ?, converted_at = CURRENT_TIMESTAMP WHERE id = ?',
                      ['completed', fileId]
                    );
                    console.log('PDF转换成功:', originalname);
                  } else {
                    db.run(
                      'UPDATE pdf_files SET status = ?, error_message = ? WHERE id = ?',
                      ['failed', result.error, fileId]
                    );
                    console.error('PDF转换失败:', originalname, result.error);
                  }
                })
                .catch(error => {
                  db.run(
                    'UPDATE pdf_files SET status = ?, error_message = ? WHERE id = ?',
                    ['failed', error.message, fileId]
                  );
                  console.error('PDF转换异常:', originalname, error);
                });

              resolve();
            });
          });

        } else if (ext === '.md') {
          // MD文件：直接复制到md目录
          const timestamp = Date.now() + '-' + Math.round(Math.random() * 1E9);
          const safeName = path.basename(originalname, ext).replace(/[^\u4e00-\u9fa5a-zA-Z0-9_-]/g, '_');
          const newFilename = `${safeName}-${timestamp}.md`;
          const destPath = path.join(MD_DIR, newFilename);

          try {
            await fs.copyFile(file.path, destPath);
            await fs.unlink(file.path); // 删除临时文件

            // 保存到数据库
            const sql = `
              INSERT INTO pdf_files (filename, original_name, pdf_path, md_path, status, file_size)
              VALUES (?, ?, ?, ?, 'completed', ?)
            `;

            await new Promise((resolve) => {
              db.run(sql, [newFilename, originalname, '', destPath, file.size], function(err) {
                if (err) {
                  console.error('保存MD文件信息失败:', originalname, err.message);
                  results.failed++;
                  results.files.push({ name: originalname, status: 'failed', error: err.message });
                } else {
                  results.success++;
                  results.files.push({ name: originalname, status: 'completed', id: this.lastID });
                  console.log('MD文件导入成功:', originalname);
                }
                resolve();
              });
            });
          } catch (error) {
            console.error('复制MD文件失败:', originalname, error);
            results.failed++;
            results.files.push({ name: originalname, status: 'failed', error: error.message });
          }

        } else {
          // 不支持的文件类型
          results.failed++;
          results.files.push({ name: originalname, status: 'failed', error: '不支持的文件类型' });
          // 删除上传的文件
          try {
            await fs.unlink(file.path);
          } catch (e) {
            console.error('删除不支持的文件失败:', file.path, e);
          }
        }

      } catch (error) {
        console.error('处理文件失败:', file.originalname, error);
        results.failed++;
        results.files.push({ name: file.originalname, status: 'failed', error: error.message });
      }
    }
  };

  // 启动异步处理
  processFiles().catch(err => {
    console.error('批量导入处理异常:', err);
  });

  // 立即返回结果
  res.json({
    success: true,
    message: `开始批量导入 ${results.total} 个文件`,
    summary: {
      total: results.total,
      processing: req.files.filter(f => {
        const ext = path.extname(f.utf8name || f.originalname).toLowerCase();
        return ext === '.pdf' || ext === '.md';
      }).length
    }
  });
});

// 获取所有已完成的MD文件列表（供前台知识库选择使用）
app.get('/api/knowledge-base/list', requireAuth, (req, res) => {
  const sql = `
    SELECT id, original_name, filename
    FROM pdf_files
    WHERE status = 'completed'
    ORDER BY original_name
  `;

  db.all(sql, [], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: '获取知识库列表失败' });
    }
    res.json({ files: rows });
  });
});

// 流式输出接口：使用 Server-Sent Events 实时推送 Claude 输出
app.get('/api/ask-stream', requireAuth, async (req, res) => {
  const question = req.query.question || '';
  const useKnowledgeBase = req.query.useKnowledgeBase === 'true';
  const username = req.username;

  if (!question.trim()) {
    return res.status(400).json({ error: '问题不能为空' });
  }

  const startTime = Date.now();

  // 设置 SSE 响应头
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // 禁用 Nginx 缓冲

  // 如果启用知识库，准备知识库内容
  let knowledgeBaseContent = '';
  if (useKnowledgeBase) {
    knowledgeBaseContent = "需要使用资料库内容来回答问题。";
  }

  // 构建最终问题
  let finalQuestion = question;
  if (knowledgeBaseContent) {
    finalQuestion = `根据md/目录下的知识库内容，回答以下问题：\n${question}`;
  }

  // 使用 Claude CLI 的流式输出功能
  const args = [
    '-p',
    finalQuestion,
    '--output-format=stream-json',
    '--include-partial-messages',
    '--verbose'
  ];

  console.log('========== 调用 /api/ask-stream ==========');
  console.log('[claude-web-stream] user =', username);
  console.log('[claude-web-stream] cwd =', PROJECT_ROOT);
  console.log('[claude-web-stream] cmd =', CLAUDE_CMD, args.map(a => JSON.stringify(a)).join(' '));
  console.log('[claude-web-stream] useKnowledgeBase =', useKnowledgeBase);
  console.log('[claude-web-stream] question =', JSON.stringify(question));

  let stdoutBuf = '';
  let stderrBuf = '';
  let partialLine = ''; // 用于处理不完整的 JSON 行
  let fullAnswer = ''; // 累积完整的回答文本

  const child = spawn(
    CLAUDE_CMD,
    args,
    {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        NO_COLOR: '1'
      }
    }
  );

  // 发送 SSE 数据的辅助函数
  function sendSSE(event, data) {
    res.write(`event: ${event}\n`);
    // SSE 规范要求：如果 data 包含多行，每行都要以 "data: " 开头
    const lines = data.split('\n');
    lines.forEach(line => {
      res.write(`data: ${line}\n`);
    });
    res.write('\n'); // 空行表示消息结束
  }

  child.on('spawn', () => {
    console.log('[claude-web-stream] 子进程已启动，pid =', child.pid);
  });

  // 实时推送 stdout 数据 - 解析流式 JSON
  child.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    console.log(text);
    stdoutBuf += text;

    // 将数据按行分割并处理
    const lines = (partialLine + text).split('\n');
    partialLine = lines.pop() || ''; // 保存不完整的行

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const jsonData = JSON.parse(line);
        console.log('[claude-web-stream] JSON event:', jsonData.type);

        // 提取流式文本内容
        if (jsonData.type === 'content_block_delta' &&
            jsonData.delta &&
            jsonData.delta.type === 'text_delta' &&
            jsonData.delta.text) {
          const textChunk = jsonData.delta.text;
          console.log('[claude-web-stream] text chunk:', textChunk);

          // 累积完整回答
          fullAnswer += textChunk;

          // 实时推送文本块到前端
          sendSSE('data', textChunk);
        }
      } catch (err) {
        console.error('[claude-web-stream] JSON 解析失败:', line, err.message);
      }
    }
  });

  child.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    stderrBuf += text;
    console.log('[claude-web-stream] stderr chunk =\n', text);
  });

  child.on('error', (err) => {
    console.log('[claude-web-stream] 子进程 error =', err);
    sendSSE('error', JSON.stringify({ error: '启动 Claude 子进程失败', detail: err.message }));

    const duration = Math.round((Date.now() - startTime) / 1000);
    saveToDatabase(username, question, `错误：${err.message}`, duration);

    res.end();
  });

  child.on('close', (code, signal) => {
    console.log('[claude-web-stream] 子进程 close, code =', code, ', signal =', signal);
    console.log('[claude-web-stream] 最终 fullAnswer =\n', fullAnswer);
    console.log('[claude-web-stream] 最终 stderr =\n', stderrBuf);

    const duration = Math.round((Date.now() - startTime) / 1000);

    if (code !== 0) {
      const errorMsg = `Claude 退出码非 0: ${code}`;
      const detail = stderrBuf || stdoutBuf || `signal=${signal}`;

      sendSSE('error', JSON.stringify({ error: errorMsg, detail: detail }));
      saveToDatabase(username, question, `${errorMsg}\n${detail}`, duration);
    } else {
      const answer = fullAnswer || '(没有输出)';
      saveToDatabase(username, question, answer, duration);

      // 发送完成事件
      sendSSE('done', JSON.stringify({ duration: duration }));
    }

    res.end();
  });

  // 不再需要通过 stdin 传递问题，因为已经通过 -p 参数传递了

  // 超时保护
  const KILL_TIMEOUT_MS = 5 * 60 * 1000;
  const timeout = setTimeout(() => {
    console.log('[claude-web-stream] 超时未返回，强制杀死子进程 pid =', child.pid);
    child.kill('SIGKILL');

    const duration = Math.round((Date.now() - startTime) / 1000);
    const errorMsg = '调用 Claude 超时，子进程在超时时间内未退出，已被强制终止';

    sendSSE('error', JSON.stringify({ error: errorMsg }));
    saveToDatabase(username, question, errorMsg, duration);

    res.end();
  }, KILL_TIMEOUT_MS);

  // 客户端断开连接时清理
  req.on('close', () => {
    clearTimeout(timeout);
    if (child && !child.killed) {
      console.log('[claude-web-stream] 客户端断开，杀死子进程 pid =', child.pid);
      child.kill();
    }
  });
});

// 核心接口：转发问题给 Claude，并基于本地代码库回答
app.post('/api/ask', requireAuth, async (req, res) => {
  const question = (req.body && req.body.question) || '';
  const useKnowledgeBase = req.body.useKnowledgeBase || false;
  const username = req.username;

  if (!question.trim()) {
    return res.status(400).json({ error: '问题不能为空' });
  }

  const startTime = Date.now();

  // 如果启用知识库，准备知识库内容
  let knowledgeBaseContent = '';
  if (useKnowledgeBase) {
    try {
      const sql = 'SELECT md_path FROM pdf_files WHERE status = "completed"';
      const rows = await new Promise((resolve, reject) => {
        db.all(sql, [], (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        });
      });

      if (rows.length > 0) {
        knowledgeBaseContent = '\n\n===== 知识库内容 =====\n\n';
        for (const row of rows) {
          try {
            const content = await fs.readFile(row.md_path, 'utf8');
            knowledgeBaseContent += `\n--- ${path.basename(row.md_path)} ---\n\n${content}\n\n`;
          } catch (err) {
            console.error('读取MD文件失败:', row.md_path, err);
          }
        }
        knowledgeBaseContent += '\n===== 知识库内容结束 =====\n\n';
      }
    } catch (error) {
      console.error('获取知识库失败:', error);
    }
  }

  // 构建最终问题
  let finalQuestion = question;
  if (knowledgeBaseContent) {
    //finalQuestion = `根据md/目录下的知识库内容，回答以下问题：\n\n${knowledgeBaseContent}\n问题：${question}`;
    finalQuestion = `根据md/目录下的知识库内容，回答以下问题：\n${question}`;

  }

  // 我们改成：通过 stdin 把问题喂给 claude，而不是作为参数。
  // 等价于在终端执行：
  //   cd /Users/wangzhen/code/ideaProjects/erp.vedeng.com
  //   echo "问题内容" | /opt/homebrew/bin/claude -p
  const args = ['-p'];

  console.log('========== 调用 /api/ask ==========');
  console.log('[claude-web] user =', username);
  console.log('[claude-web] cwd =', PROJECT_ROOT);
  console.log('[claude-web] cmd =', CLAUDE_CMD, args.map(a => JSON.stringify(a)).join(' '));
  console.log('[claude-web] useKnowledgeBase =', useKnowledgeBase);
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
  child.stdin.write(finalQuestion + '\n');
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

// PDF转Markdown功能
async function convertPdfToMarkdown(pdfPath, mdPath) {
  try {
    const dataBuffer = await fs.readFile(pdfPath);
    const data = await pdfParse(dataBuffer);

    let markdown = `# ${path.basename(pdfPath, '.pdf')}\n\n`;

    // 简单的文本到Markdown转换
    const text = data.text;
    const lines = text.split('\n');

    let inCodeBlock = false;
    for (let i = 0; i < lines.length; i++) {
      let line = lines[i].trim();

      if (!line) {
        markdown += '\n';
        continue;
      }

      // 检测可能的标题（全大写或较短的行）
      if (line.length < 50 && line === line.toUpperCase() && /^[A-Z\s]+$/.test(line)) {
        markdown += `\n## ${line}\n\n`;
      }
      // 检测列表项
      else if (/^[\d\-\•\*]\s/.test(line)) {
        markdown += `${line}\n`;
      }
      // 普通段落
      else {
        markdown += `${line}\n`;
      }
    }

    await fs.writeFile(mdPath, markdown, 'utf8');
    return { success: true };
  } catch (error) {
    console.error('PDF转换失败:', error);
    return { success: false, error: error.message };
  }
}

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
