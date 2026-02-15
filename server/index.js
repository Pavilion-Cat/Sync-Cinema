require('dotenv').config({ path: require('path').resolve(__dirname, '../.env.local') }); // 生产环境请通过环境变量注入方式设置 .env.local 中的变量，开发环境可直接使用 .env.local 文件

const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

// ====== 适配本地开发环境 ======
// 使用 path.join 和 __dirname 确保在 Windows/Mac/Linux 都能正确找到 videos 文件夹
const VIDEO_DIR = process.env.VIDEO_DIR || path.join(__dirname, 'videos');
// 修改端口为 3001，避免与 Next.js (3000) 冲突
const PORT = process.env.PORT || 3001; 

const ROOM_PASSWORD = process.env.SYNC_PASSWORD || 'default';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin_control';

// ====== 日志功能模块 ======
const LOG_DIR = path.join(__dirname, 'logs');
// 确保日志目录存在
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
  
  // 异步写入文件
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
// ===========================

// ====== 核心逻辑 ======
let authoritativeState = {
  currentFile: null,
  baseTime: 0,
  lastUpdateTime: Date.now(),
  isPlaying: false,
  adminClientId: null
};

// ====== 获取客户端 IP 的辅助函数 ======
const getClientIP = (req) => {
  // 优先从 Nginx/代理 获取真实 IP
  let ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'Unknown';
  // 处理 IPv6 映射的 IPv4 地址 (如 ::ffff:127.0.0.1 -> 127.0.0.1)
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

// ====== HTTP 服务增加 CORS 和视频文件服务 ======
const server = http.createServer((req, res) => {
  
  const ip = getClientIP(req);  
  // 记录 HTTP 访问日志 (排除 favicon 等静态资源请求，减少日志噪音)
  if (!req.url.includes('favicon')) {
    serverLog('ACCESS', `IP: ${ip} ${req.method} ${req.url}`);
  }

  // 设置 CORS 头，允许 Next.js 前端跨域访问，开发环境使用
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // 视频列表 API
  if (req.url === '/api/videos') {
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
      res.setHeader('Cache-Control', 'public, max-age=60');
      res.end(JSON.stringify(mp4s));
    });
    return;
  }

  // 视频文件服务 
  // 匹配 /videos/xxx.mp4 请求
  if (req.url.startsWith('/videos/')) {
    const filePath = path.join(VIDEO_DIR, decodeURIComponent(req.url.replace('/videos/', '')));
    
    // 安全检查：防止路径穿越攻击
    if (!filePath.startsWith(VIDEO_DIR)) {
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
        // 处理 Range 请求 (视频拖动进度条必需)
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
        const chunksize = (end - start) + 1;
        const file = fs.createReadStream(filePath, { start, end });
        
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunksize,
          'Content-Type': 'video/mp4',
        });
        file.pipe(res);
      } else {
        // 普通请求
        res.writeHead(200, {
          'Content-Length': stat.size,
          'Content-Type': 'video/mp4',
        });
        fs.createReadStream(filePath).pipe(res);
      }
    });
    return;
  }

  // 404 处理
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
  // 解析 URL 参数 (兼容新版 Node.js)
  const parsedUrl = url.parse(request.url, true);
  const params = parsedUrl.query; // 直接使用 query 对象
  
  // ====== 新增：获取并记录 IP ======
  const ip = getClientIP(request);

  const roomPass = params.pass;
  const adminPass = params.adminPass;

  if (roomPass !== ROOM_PASSWORD) {
    serverLog('WARN', `无效房间密码尝试 (ID: ${clientId}, IP: ${ip})`);
    console.log(`无效房间密码尝试 (ID: ${clientId}, IP: ${ip})`);
    ws.close(4001, 'Invalid room password');
    return;
  }

  const isAdmin = (adminPass === ADMIN_PASSWORD);

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
          // 发送特殊类型 timeCheckResult，前端收到后只对比不跳转
          sendToClient(clientId, { type: 'timeCheckResult', ...snap });
          
          // ====== 开始修改：增加对 msg.time 的判断，防止崩溃 ======
          const clientTime = (typeof msg.time === 'number' && !isNaN(msg.time)) 
                            ? msg.time.toFixed(2) + 's' 
                            : '未上报';
          
          serverLog('TIME_CHECK', `时间检查 (ID: ${clientId}, IP: ${clients.get(clientId)?.ip || 'Unknown'}, 客户端时间: ${clientTime}, 服务器时间: ${snap.time.toFixed(2)}s)`);
          console.log(`[检查响应] ID: ${clientId.slice(0,6)}, IP: ${clients.get(clientId)?.ip || 'Unknown'}, 服务器时间: ${snap.time.toFixed(2)}s`);
          // ====== 修改结束 ======
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
        const newTime = authoritativeState.isPlaying ? getCurrentAuthoritativeTime() : msg.time;
        serverLog('SEEK', `跳转进度: ${newTime.toFixed(1)}s (主持人: ${clientId}, IP: ${clients.get(clientId)?.ip || 'Unknown'})`);
        console.log(`[操作] 跳转进度: ${newTime.toFixed(1)}s (主持人: ${clientId.slice(0,6)}, IP: ${clients.get(clientId)?.ip || 'Unknown'})`);
        updateAuthoritativeState(authoritativeState.currentFile, newTime, false);
        broadcast({ type: 'seek', time: newTime }, clientId);
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
        // 1. 获取服务器当前的推算状态（在更新之前）
        const serverTime = getCurrentAuthoritativeTime();
        
        // 2. 计算时间差（误差）
        const timeDiff = Math.abs(serverTime - msg.time);

        // 3. 详细打印日志
        console.log(`--- [心跳] ID: ${clientId.slice(0,6)}, IP: ${clients.get(clientId)?.ip || 'Unknown'} ---`);
        console.log(`[客户端上报] 时间: ${msg.time.toFixed(2)}s | 状态: ${msg.playing ? '播放中' : '暂停'}`);
        console.log(`[服务器推算] 时间: ${serverTime.toFixed(2)}s`);
        console.log(`[同步误差] 差异: ${timeDiff.toFixed(2)}s`);
        console.log(`-----------------------------`);
        serverLog('HEARTBEAT', `心跳检测 (ID: ${clientId}, IP: ${clients.get(clientId)?.ip || 'Unknown'}, 客户端时间: ${msg.time.toFixed(2)}s, 服务器时间: ${serverTime.toFixed(2)}s, 误差: ${timeDiff.toFixed(2)}s)`);
        
        // 4. 如果误差过大（例如超过1秒），给出明显警告
        if (timeDiff > 1.0) {
          serverLog('WARN', `检测到显著偏差 (ID: ${clientId}, IP: ${clients.get(clientId)?.ip || 'Unknown'}, 误差: ${timeDiff.toFixed(2)}s)`);
          console.log(`警告: 检测到显著偏差! 正在重置基准...`);
        }

        // 5. 执行更新操作
        updateAuthoritativeState(msg.file, msg.time, msg.playing);
        serverLog('SYNC', `基准更新 (ID: ${clientId}, IP: ${clients.get(clientId)?.ip || 'Unknown'}, 新基准时间: ${msg.time.toFixed(2)}s)`);
        console.log(`[校准完成] 新基准已设定为: ${msg.time.toFixed(2)}s (IP: ${clients.get(clientId)?.ip || 'Unknown'})`);
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
      authoritativeState = { currentFile: null, baseTime: 0, lastUpdateTime: Date.now(), isPlaying: false, adminClientId: null };
      broadcast({ type: 'adminLeft', reason: reason.toString() });
    }
    clients.delete(clientId);
    serverLog('INFO', `客户端断开 (ID: ${clientId}, IP: ${client?.ip || 'Unknown'}, 剩余连接数: ${clients.size})`);
    console.log(`客户端断开 (ID: ${clientId}, IP: ${client?.ip || 'Unknown'}, 剩余: ${clients.size})`);
  });
  
  ws.on('error', (err) => clients.delete(clientId));
});

// 定期清理
setInterval(() => {
  clients.forEach(({ ws }, clientId) => {
    if (ws.readyState !== WebSocket.OPEN) {
      clients.delete(clientId);
      if (authoritativeState.adminClientId === clientId) {
        authoritativeState = { currentFile: null, baseTime: 0, lastUpdateTime: Date.now(), isPlaying: false, adminClientId: null };
        broadcast({ type: 'adminLeft' });
      }
    }
  });
}, 30000);

server.listen(PORT, '0.0.0.0', () => {
  serverLog('INFO', `云阁同步影院后端服务已启动 (端口: ${PORT}, 视频目录: ${VIDEO_DIR})，房间密码: ${ROOM_PASSWORD}, 主持人密码: ${ADMIN_PASSWORD}`);
  console.log('云阁同步影院后端服务已启动');
  console.log(`服务地址: http://localhost:${PORT}`);
  console.log(`视频目录: ${VIDEO_DIR}`);
  console.log(`房间密码: ${ROOM_PASSWORD}`);
  console.log(`主持人密码: ${ADMIN_PASSWORD}`);
});