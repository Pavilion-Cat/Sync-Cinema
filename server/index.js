require('dotenv').config({ path: require('path').resolve(__dirname, '../.env.local') });

const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3001;
const VIDEO_DIR = path.resolve(process.env.VIDEO_DIR || path.join(__dirname, 'videos'));
const LOG_DIR = path.join(__dirname, 'logs');
const CLIENT_CLEANUP_INTERVAL_MS = 30000;
const SIGNIFICANT_DRIFT_SECONDS = 1;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const LOGIN_BLOCK_MS = 10 * 60 * 1000;
const TOKEN_VERSION = 1;
const VIEWER_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const ADMIN_TOKEN_TTL_MS = 4 * 60 * 60 * 1000;
const AUTH_COOKIE_NAME = 'sync_auth';
const AUTH_COOKIE_PATH = '/';
const ROOM_PASSWORD = process.env.SYNC_PASSWORD;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const AUTH_TOKEN_SECRET = process.env.AUTH_TOKEN_SECRET;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

if (!ROOM_PASSWORD || !ADMIN_PASSWORD || !AUTH_TOKEN_SECRET) {
  console.error('缺少必要环境变量: SYNC_PASSWORD, ADMIN_PASSWORD, AUTH_TOKEN_SECRET');
  process.exit(1);
}

if (!fs.existsSync(LOG_DIR)) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch (err) {
    console.error('无法创建日志目录:', err);
  }
}
const getLogFilename = () => path.join(LOG_DIR, `server-${new Date().toISOString().slice(0, 10)}.log`);
const writeLog = (level, message) => {
  const timestamp = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const logEntry = `[${timestamp}] [${level}] ${message}\n`;

  fs.appendFile(getLogFilename(), logEntry, (err) => {
    if (err) console.error('写入日志失败:', err);
  });
};
const serverLog = (level, message) => {
  if (level === 'ERROR') {
    console.error(`[${level}]`, message);
  } else {
    console.log(`[${level}]`, message);
  }
  writeLog(level, message);
};

let authoritativeState = {
  currentFile: null,
  baseTime: 0,
  lastUpdateTime: Date.now(),
  isPlaying: false,
  adminClientId: null
};

const loginAttempts = new Map();

const encodeBase64Url = (value) => Buffer.from(value).toString('base64url');
const decodeBase64Url = (value) => Buffer.from(value, 'base64url').toString('utf8');

const parseCookies = (req) => {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return {};

  return cookieHeader.split(';').reduce((acc, part) => {
    const [rawName, ...rawValueParts] = part.trim().split('=');
    if (!rawName) return acc;
    acc[rawName] = decodeURIComponent(rawValueParts.join('='));
    return acc;
  }, {});
};

const signToken = (payload) => {
  const encodedPayload = encodeBase64Url(JSON.stringify(payload));
  const signature = crypto
    .createHmac('sha256', AUTH_TOKEN_SECRET)
    .update(encodedPayload)
    .digest('base64url');
  return `${encodedPayload}.${signature}`;
};

const verifyToken = (token) => {
  if (!token || typeof token !== 'string') return null;
  const [encodedPayload, signature] = token.split('.');
  if (!encodedPayload || !signature) return null;

  const expectedSignature = crypto
    .createHmac('sha256', AUTH_TOKEN_SECRET)
    .update(encodedPayload)
    .digest('base64url');

  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (signatureBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) {
    return null;
  }

  try {
    const payload = JSON.parse(decodeBase64Url(encodedPayload));
    if (payload.ver !== TOKEN_VERSION || !payload.role || !payload.exp || Date.now() > payload.exp) {
      return null;
    }
    return payload;
  } catch (error) {
    return null;
  }
};

const createAuthToken = (role) => {
  const now = Date.now();
  return signToken({
    role,
    iat: now,
    exp: now + (role === 'admin' ? ADMIN_TOKEN_TTL_MS : VIEWER_TOKEN_TTL_MS),
    ver: TOKEN_VERSION
  });
};

const createSetCookieValue = (token, maxAgeMs) => {
  const parts = [
    `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}`,
    `Path=${AUTH_COOKIE_PATH}`,
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`
  ];

  if (IS_PRODUCTION) {
    parts.push('Secure');
  }

  return parts.join('; ');
};

const clearAuthCookieValue = () => {
  const parts = [
    `${AUTH_COOKIE_NAME}=`,
    `Path=${AUTH_COOKIE_PATH}`,
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0'
  ];

  if (IS_PRODUCTION) {
    parts.push('Secure');
  }

  return parts.join('; ');
};

const getAuthPayloadFromRequest = (req) => {
  const cookies = parseCookies(req);
  return verifyToken(cookies[AUTH_COOKIE_NAME]);
};

const getLoginAttemptRecord = (ip) => {
  const record = loginAttempts.get(ip);
  if (!record) {
    return { count: 0, firstFailedAt: 0, blockedUntil: 0 };
  }

  if (record.blockedUntil && Date.now() > record.blockedUntil) {
    loginAttempts.delete(ip);
    return { count: 0, firstFailedAt: 0, blockedUntil: 0 };
  }

  if (record.firstFailedAt && Date.now() - record.firstFailedAt > LOGIN_WINDOW_MS) {
    loginAttempts.delete(ip);
    return { count: 0, firstFailedAt: 0, blockedUntil: 0 };
  }

  return record;
};

const isLoginBlocked = (ip) => {
  const record = getLoginAttemptRecord(ip);
  return Boolean(record.blockedUntil && record.blockedUntil > Date.now());
};

const recordLoginFailure = (ip) => {
  const now = Date.now();
  const record = getLoginAttemptRecord(ip);
  const nextRecord = {
    count: record.count + 1,
    firstFailedAt: record.firstFailedAt || now,
    blockedUntil: 0
  };

  if (nextRecord.count >= LOGIN_MAX_FAILURES) {
    nextRecord.blockedUntil = now + LOGIN_BLOCK_MS;
  }

  loginAttempts.set(ip, nextRecord);
  return nextRecord;
};

const clearLoginFailures = (ip) => {
  loginAttempts.delete(ip);
};

const getClientIP = (req) => {
  let ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'Unknown';
  if (ip.startsWith('::1')) {
    ip = '127.0.0.1';
  }
  if (ip.startsWith('::ffff:')) {
    ip = ip.substring(7);
  }
  return ip;
};

const getCurrentAuthoritativeTime = () => {
  if (!authoritativeState.currentFile || !authoritativeState.isPlaying) {
    return authoritativeState.baseTime;
  }
  const elapsed = (Date.now() - authoritativeState.lastUpdateTime) / 1000;
  return authoritativeState.baseTime + elapsed;
};

const updateAuthoritativeState = (file, baseTime, isPlaying) => {
  authoritativeState = {
    currentFile: file,
    baseTime: baseTime || 0,
    lastUpdateTime: Date.now(),
    isPlaying: isPlaying,
    adminClientId: authoritativeState.adminClientId
  };
};

const getAuthoritativeSnapshot = () => {
  if (!authoritativeState.currentFile) return null;
  return {
    file: authoritativeState.currentFile,
    time: getCurrentAuthoritativeTime(),
    playing: authoritativeState.isPlaying
  };
};

const resetAuthoritativeState = () => {
  authoritativeState = {
    currentFile: null,
    baseTime: 0,
    lastUpdateTime: Date.now(),
    isPlaying: false,
    adminClientId: null
  };
};

const isSubPath = (parentPath, childPath) => {
  const relative = path.relative(parentPath, childPath);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
};

const server = http.createServer((req, res) => {
  const ip = getClientIP(req);
  if (!req.url.includes('favicon')) {
    serverLog('ACCESS', `IP: ${ip} ${req.method} ${req.url}`);
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.url === '/api/auth/me') {
    const auth = getAuthPayloadFromRequest(req);
    res.setHeader('Content-Type', 'application/json');

    if (!auth) {
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, authenticated: false }));
      return;
    }

    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, authenticated: true, role: auth.role }));
    return;
  }

  if (req.url === '/api/auth/logout' && req.method === 'POST') {
    res.setHeader('Set-Cookie', clearAuthCookieValue());
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.url === '/api/auth/login' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
      if (body.length > 1024 * 16) {
        req.destroy();
      }
    });

    req.on('end', () => {
      if (isLoginBlocked(ip)) {
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(429);
        res.end(JSON.stringify({ ok: false, error: '尝试次数过多，请稍后再试' }));
        return;
      }

      let payload;
      try {
        payload = body ? JSON.parse(body) : {};
      } catch (error) {
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(400);
        res.end(JSON.stringify({ ok: false, error: '请求格式无效' }));
        return;
      }

      const roomPass = typeof payload.roomPass === 'string' ? payload.roomPass : '';
      const adminPass = typeof payload.adminPass === 'string' ? payload.adminPass : '';

      if (roomPass !== ROOM_PASSWORD) {
        const attempt = recordLoginFailure(ip);
        serverLog('WARN', `登录失败: 房间密码错误 (IP: ${ip}, 次数: ${attempt.count})`);
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(401);
        res.end(JSON.stringify({ ok: false, error: '房间密码错误' }));
        return;
      }

      clearLoginFailures(ip);
      const role = adminPass && adminPass === ADMIN_PASSWORD ? 'admin' : 'viewer';
      const token = createAuthToken(role);
      const ttl = role === 'admin' ? ADMIN_TOKEN_TTL_MS : VIEWER_TOKEN_TTL_MS;
      res.setHeader('Set-Cookie', createSetCookieValue(token, ttl));
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, role }));
    });
    return;
  }

  if (req.url === '/api/videos') {
    const auth = getAuthPayloadFromRequest(req);
    if (!auth) {
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(401);
      res.end(JSON.stringify({ ok: false, error: '未登录或登录已过期' }));
      return;
    }

    fs.readdir(VIDEO_DIR, (err, files) => {
      if (err) {
        console.error('视频目录读取失败:', err);
        serverLog('ERROR', `视频目录读取失败: ${err.message} (IP: ${ip})`);
        res.writeHead(500);
        res.end('Internal Server Error');
        return;
      }
      
      const mp4s = files.filter(f => f.toLowerCase().endsWith('.mp4')).sort();
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'private, max-age=60');
      res.end(JSON.stringify(mp4s));
    });
    return;
  }

  if (req.url.startsWith('/videos/')) {
    const requestedFile = decodeURIComponent(req.url.replace('/videos/', ''));
    const filePath = path.resolve(VIDEO_DIR, requestedFile);

    if (filePath !== VIDEO_DIR && !isSubPath(VIDEO_DIR, filePath)) {
      serverLog('WARN', `路径穿越攻击尝试 (IP: ${ip}, 路径: ${filePath})`);
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    fs.stat(filePath, (err, stat) => {
      if (err || !stat.isFile()) {
        serverLog('WARN', `视频文件不存在或无法访问 (IP: ${ip}, 路径: ${filePath})`);
        res.writeHead(404);
        res.end('Not Found');
        return;
      }

      const range = req.headers.range;
      if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = Number.parseInt(parts[0], 10);
        const requestedEnd = parts[1] ? Number.parseInt(parts[1], 10) : stat.size - 1;
        const end = Math.min(requestedEnd, stat.size - 1);

        if (Number.isNaN(start) || Number.isNaN(end) || start < 0 || start > end || start >= stat.size) {
          res.writeHead(416, {
            'Content-Range': `bytes */${stat.size}`,
          });
          res.end();
          return;
        }

        const chunkSize = (end - start) + 1;
        const file = fs.createReadStream(filePath, { start, end });

        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunkSize,
          'Content-Type': 'video/mp4',
        });
        file.pipe(res);
      } else {
        res.writeHead(200, {
          'Content-Length': stat.size,
          'Content-Type': 'video/mp4',
        });
        fs.createReadStream(filePath).pipe(res);
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

const wss = new WebSocket.Server({ server, path: '/sync' });
const clients = new Map();

const generateClientId = () => {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
};

const broadcast = (message, excludeClientId = null) => {
  clients.forEach(({ ws }, clientId) => {
    if (clientId !== excludeClientId && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify(message)); } catch (e) {}
    }
  });
};

const sendToClient = (clientId, message) => {
  const client = clients.get(clientId);
  if (client && client.ws.readyState === WebSocket.OPEN) {
    try { client.ws.send(JSON.stringify(message)); } catch (e) {}
  }
};

wss.on('connection', (ws, request) => {
  const clientId = generateClientId();
  const ip = getClientIP(request);
  const auth = getAuthPayloadFromRequest(request);

  if (!auth) {
    serverLog('WARN', `无效登录态 WebSocket 尝试 (ID: ${clientId}, IP: ${ip})`);
    ws.close(4001, 'Invalid auth token');
    return;
  }

  const isAdmin = auth.role === 'admin';

  if (isAdmin && authoritativeState.adminClientId) {
    const oldAdminId = authoritativeState.adminClientId;
    const oldAdmin = clients.get(oldAdminId);
    if (oldAdmin) {
      sendToClient(oldAdminId, { type: 'roleRevoked', reason: '新主持人已加入' });
      oldAdmin.ws.close(4000, 'Replaced by new admin');
    }
  }

  clients.set(clientId, { ws, isAdmin, ip });
  if (isAdmin) {
    authoritativeState.adminClientId = clientId;
    serverLog('INFO', `新主持人加入 (ID: ${clientId}, IP: ${ip})`);
    console.log(`新主持人加入 (ID: ${clientId}, IP: ${ip})`);
  }
  serverLog('INFO', `客户端加入 (ID: ${clientId}, 管理员: ${isAdmin}, IP: ${ip}, 总连接数: ${clients.size})`);
  console.log(`客户端加入 (ID: ${clientId}, 管理员: ${isAdmin}, IP: ${ip}, 总连接数: ${clients.size})`);

  sendToClient(clientId, { type: 'roleAssigned', isAdmin, isAdminActive: !!authoritativeState.adminClientId,ip: ip });

  const snap = getAuthoritativeSnapshot();
  if (snap) {
    sendToClient(clientId, { type: 'authoritativeState', ...snap });
  }

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === 'requestSync' && !isAdmin) {
        const snap = getAuthoritativeSnapshot();
        serverLog('SYNC', `同步请求 (ID: ${clientId}, IP: ${clients.get(clientId)?.ip || 'Unknown'})`);
        console.log(`[同步请求] 来自 ID: ${clientId.slice(0,6)}, IP: ${clients.get(clientId)?.ip || 'Unknown'} 的同步请求`);
        if (snap) sendToClient(clientId, { type: 'authoritativeSync', ...snap });
        else sendToClient(clientId, { type: 'noContent', reason: '暂无播放内容' });
        return;
      }

      if (msg.type === 'checkTime' && !isAdmin) {
        const snap = getAuthoritativeSnapshot();
        if (snap) {
          sendToClient(clientId, { type: 'timeCheckResult', ...snap });
          
          const clientTime = (typeof msg.time === 'number' && !isNaN(msg.time)) 
                            ? msg.time.toFixed(2) + 's' 
                            : '未上报';
          
          serverLog('TIME_CHECK', `时间检查 (ID: ${clientId}, IP: ${clients.get(clientId)?.ip || 'Unknown'}, 客户端时间: ${clientTime}, 服务器时间: ${snap.time.toFixed(2)}s)`);
          console.log(`[检查响应] ID: ${clientId.slice(0,6)}, IP: ${clients.get(clientId)?.ip || 'Unknown'}, 服务器时间: ${snap.time.toFixed(2)}s`);
        }
        return;
      }

      if (!isAdmin) return;

      if (msg.type === 'load') {
        serverLog('LOAD', `加载视频: ${msg.file} (主持人: ${clientId}, IP: ${clients.get(clientId)?.ip || 'Unknown'})`);
        console.log(`[操作] 加载视频: ${msg.file} (主持人: ${clientId.slice(0,6)}, IP: ${clients.get(clientId)?.ip || 'Unknown'})`);
        updateAuthoritativeState(msg.file, 0, false);
        broadcast({ type: 'load', file: msg.file }, clientId);
      } else if (msg.type === 'seek') {
        const newTime = typeof msg.time === 'number' ? msg.time : getCurrentAuthoritativeTime();
        const nextPlaying = authoritativeState.isPlaying;
        serverLog('SEEK', `跳转进度: ${newTime.toFixed(1)}s, 播放状态: ${nextPlaying ? '播放中' : '暂停'} (主持人: ${clientId}, IP: ${clients.get(clientId)?.ip || 'Unknown'})`);
        console.log(`[操作] 跳转进度: ${newTime.toFixed(1)}s, 播放状态: ${nextPlaying ? '播放中' : '暂停'} (主持人: ${clientId.slice(0,6)}, IP: ${clients.get(clientId)?.ip || 'Unknown'})`);
        updateAuthoritativeState(authoritativeState.currentFile, newTime, nextPlaying);
        broadcast({
          type: 'authoritativeSync',
          file: authoritativeState.currentFile,
          time: newTime,
          playing: nextPlaying
        }, clientId);
      } else if (msg.type === 'play') {
        const currentTime = getCurrentAuthoritativeTime();
        serverLog('PLAY', `开始播放: 基准时间 ${currentTime.toFixed(1)}s (主持人: ${clientId}, IP: ${clients.get(clientId)?.ip || 'Unknown'})`);
        console.log(`▶ [操作] 开始播放: 基准时间 ${currentTime.toFixed(1)}s (主持人: ${clientId.slice(0,6)}, IP: ${clients.get(clientId)?.ip || 'Unknown'})`);
        updateAuthoritativeState(authoritativeState.currentFile, currentTime, true);
        broadcast({ type: 'play' }, clientId);
      } else if (msg.type === 'pause') {
        const currentTime = getCurrentAuthoritativeTime();
        serverLog('PAUSE', `暂停播放: 当前时间 ${currentTime.toFixed(1)}s (主持人: ${clientId}, IP: ${clients.get(clientId)?.ip || 'Unknown'})`);
        console.log(`⏸ [操作] 暂停播放: 当前时间 ${currentTime.toFixed(1)}s (主持人: ${clientId.slice(0,6)}, IP: ${clients.get(clientId)?.ip || 'Unknown'})`);
        updateAuthoritativeState(authoritativeState.currentFile, currentTime, false);
        broadcast({ type: 'pause' }, clientId);
      } else if (msg.type === 'heartbeat') {
        const reportedTime = typeof msg.time === 'number' && Number.isFinite(msg.time)
          ? msg.time
          : getCurrentAuthoritativeTime();
        const serverTime = getCurrentAuthoritativeTime();
        const timeDiff = Math.abs(serverTime - reportedTime);

        console.log(`--- [心跳] ID: ${clientId.slice(0,6)}, IP: ${clients.get(clientId)?.ip || 'Unknown'} ---`);
        console.log(`[客户端上报] 时间: ${reportedTime.toFixed(2)}s | 状态: ${msg.playing ? '播放中' : '暂停'}`);
        console.log(`[服务器推算] 时间: ${serverTime.toFixed(2)}s`);
        console.log(`[同步误差] 差异: ${timeDiff.toFixed(2)}s`);
        console.log(`-----------------------------`);
        serverLog('HEARTBEAT', `心跳检测 (ID: ${clientId}, IP: ${clients.get(clientId)?.ip || 'Unknown'}, 客户端时间: ${reportedTime.toFixed(2)}s, 服务器时间: ${serverTime.toFixed(2)}s, 误差: ${timeDiff.toFixed(2)}s)`);
        
        if (timeDiff > SIGNIFICANT_DRIFT_SECONDS) {
          serverLog('WARN', `检测到显著偏差 (ID: ${clientId}, IP: ${clients.get(clientId)?.ip || 'Unknown'}, 误差: ${timeDiff.toFixed(2)}s)`);
          console.log(`警告: 检测到显著偏差! 正在重置基准...`);
        }

        updateAuthoritativeState(msg.file, reportedTime, msg.playing);
        serverLog('SYNC', `基准更新 (ID: ${clientId}, IP: ${clients.get(clientId)?.ip || 'Unknown'}, 新基准时间: ${reportedTime.toFixed(2)}s)`);
        console.log(`[校准完成] 新基准已设定为: ${reportedTime.toFixed(2)}s (IP: ${clients.get(clientId)?.ip || 'Unknown'})`);
      } else if (msg.type === 'forceSync') {
        serverLog('FORCE_SYNC', `强制同步所有观众 (主持人: ${clientId}, IP: ${clients.get(clientId)?.ip || 'Unknown'})`);
        console.log(`[操作] 强制同步所有观众 (主持人: ${clientId.slice(0,6)}, IP: ${clients.get(clientId)?.ip || 'Unknown'})`);
        updateAuthoritativeState(msg.file, msg.time, msg.playing);
        const snap = getAuthoritativeSnapshot();
        broadcast({ type: 'authoritativeSync', ...snap }, clientId);
      }
    } catch (e) {
      serverLog('ERROR', `消息处理错误 (ID: ${clientId}, IP: ${clients.get(clientId)?.ip || 'Unknown'}, 错误: ${e.message})`);
      console.error('消息处理错误:', e);
    }
  });

  ws.on('close', (code, reason) => {
    const client = clients.get(clientId);
    if (client?.isAdmin && authoritativeState.adminClientId === clientId) {
      resetAuthoritativeState();
      broadcast({ type: 'adminLeft', reason: reason.toString() });
    }
    clients.delete(clientId);
    serverLog('INFO', `客户端断开 (ID: ${clientId}, IP: ${client?.ip || 'Unknown'}, 剩余连接数: ${clients.size})`);
    console.log(`客户端断开 (ID: ${clientId}, IP: ${client?.ip || 'Unknown'}, 剩余: ${clients.size})`);
  });

  ws.on('error', () => clients.delete(clientId));
});

setInterval(() => {
  clients.forEach(({ ws }, clientId) => {
    if (ws.readyState !== WebSocket.OPEN) {
      clients.delete(clientId);
      if (authoritativeState.adminClientId === clientId) {
        resetAuthoritativeState();
        broadcast({ type: 'adminLeft' });
      }
    }
  });
}, CLIENT_CLEANUP_INTERVAL_MS);

server.listen(PORT, '0.0.0.0', () => {
  serverLog('INFO', `云阁同步影院后端服务已启动 (端口: ${PORT}, 视频目录: ${VIDEO_DIR})，认证配置已加载`);
  console.log('云阁同步影院后端服务已启动');
  console.log(`服务地址: http://localhost:${PORT}`);
  console.log(`视频目录: ${VIDEO_DIR}`);
  console.log('SYNC_PASSWORD: configured');
  console.log('ADMIN_PASSWORD: configured');
  console.log('AUTH_TOKEN_SECRET: configured');
});