// ============================================================
// Offscreen Document — 保持 Service Worker 存活
// 通过长连接 Port 阻止 SW 被浏览器杀掉
// ============================================================

let port = null;
let reconnectTimer = null;
const HEARTBEAT_MS = 15000;   // 每 15 秒心跳一次
const RECONNECT_MS = 2000;    // 断连后 2 秒重连

function connect() {
  if (port) {
    try { port.disconnect(); } catch (_) { /* ignore */ }
  }

  port = chrome.runtime.connect({ name: 'offscreen-keepalive' });

  port.onMessage.addListener((msg) => {
    if (msg.type === 'heartbeat-ack') {
      // SW 存活确认，无需操作
    }
    if (msg.type === 'state-sync') {
      // SW 推送状态同步（预留）
      console.log('[Offscreen] 状态同步:', msg);
    }
  });

  port.onDisconnect.addListener(() => {
    console.log('[Offscreen] SW 端口断开，2秒后重连...');
    port = null;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, RECONNECT_MS);
  });
}

// 心跳循环：定期向 SW 发消息，保持连接活跃
function heartbeat() {
  if (port) {
    try {
      port.postMessage({ type: 'heartbeat', ts: Date.now() });
    } catch (_) {
      // 发送失败，触发重连
      port = null;
      connect();
    }
  } else {
    connect();
  }
}

// 启动
connect();
setInterval(heartbeat, HEARTBEAT_MS);
console.log('[Offscreen] 保活页面已启动');
