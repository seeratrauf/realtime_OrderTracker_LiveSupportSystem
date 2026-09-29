const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const ORIGIN = process.env.CLIENT_ORIGIN || '*';
const app = express();
app.use(cors({ origin: ORIGIN }));
app.use(express.json());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: ORIGIN } });

// ---------- In-memory data ----------
const STATUSES = ['PLACED', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED'];
const catalog = [
  { id: 1, name: 'Wireless Headphones', price: 59.99 },
  { id: 2, name: 'Mechanical Keyboard', price: 89.5 },
  { id: 3, name: 'USB-C Hub', price: 34 },
  { id: 4, name: 'Webcam 1080p', price: 47.25 },
];
const orders = [];
const chats = {}; // orderId -> messages[]
let seq = 1001;
const findOrder = (id) => orders.find((o) => o.id === Number(id));

// ---------- SSE: /events ----------
const sseClients = new Set();
function alertAll(level, message) {
  const data = JSON.stringify({ level, message, at: new Date().toISOString() });
  for (const res of sseClients) res.write(`event: alert\ndata: ${data}\n\n`);
}
app.get('/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write(`event: alert\ndata: ${JSON.stringify({ level: 'info', message: 'Connected to live alerts', at: new Date().toISOString() })}\n\n`);
  sseClients.add(res);
  const hb = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(hb); sseClients.delete(res); });
});
setInterval(() => alertAll('info', `System healthy · ${orders.length} orders · ${io.engine.clientsCount} live connections`), 60000);

// ---------- Shared business logic ----------
function setStatus(order, status) {
  order.status = status;
  order.updatedAt = new Date().toISOString();
  io.to('order:' + order.id).emit('order:status', order); // WebSocket push to subscribers
  io.emit('order:updated', order);
  alertAll(status === 'CANCELLED' ? 'warning' : 'info', `Order #${order.id} is now ${status}`); // SSE push
  return order;
}

// ---------- REST: /api/v1 ----------
const api = express.Router();
api.get('/catalog', (_q, r) => r.json(catalog));
api.get('/orders', (_q, r) => r.json(orders));
api.get('/orders/:id', (q, r) => {
  const o = findOrder(q.params.id);
  o ? r.json(o) : r.status(404).json({ error: 'Order not found' });
});
api.post('/orders', (q, r) => {
  const { customer, items } = q.body || {};
  if (!customer || !Array.isArray(items) || !items.length) return r.status(400).json({ error: 'customer and items[] required' });
  const lines = [];
  for (const i of items) {
    const p = catalog.find((c) => c.id === Number(i.productId));
    if (!p) return r.status(400).json({ error: `Unknown product ${i.productId}` });
    lines.push({ productId: p.id, name: p.name, price: p.price, qty: Number(i.qty) || 1 });
  }
  const now = new Date().toISOString();
  const order = { id: seq++, customer, items: lines, total: +lines.reduce((s, l) => s + l.price * l.qty, 0).toFixed(2), status: 'PLACED', createdAt: now, updatedAt: now };
  orders.push(order);
  io.emit('order:created', order);
  alertAll('info', `New order #${order.id} from ${customer}`);
  r.status(201).json(order);
});
api.patch('/orders/:id/status', (q, r) => {
  const o = findOrder(q.params.id);
  if (!o) return r.status(404).json({ error: 'Order not found' });
  if (!STATUSES.includes(q.body?.status)) return r.status(400).json({ error: `status must be one of ${STATUSES.join(', ')}` });
  r.json(setStatus(o, q.body.status));
});
app.use('/api/v1', api);
app.get('/', (_q, r) => r.json({ service: 'order-tracker', endpoints: ['/api/v1/orders', '/api/v1/catalog', '/rpc', '/events', 'socket.io'] }));

// ---------- JSON-RPC 2.0: /rpc ----------
const rpcErr = (code, message) => Object.assign(new Error(message), { code });
const needOrder = (id) => findOrder(id) || (() => { throw rpcErr(-32002, `Order ${id} not found`); })();
const methods = {
  listOrders: () => orders,
  getOrderStatus: ({ orderId }) => { const o = needOrder(orderId); return { orderId: o.id, status: o.status, updatedAt: o.updatedAt }; },
  cancelOrder: ({ orderId }) => {
    const o = needOrder(orderId);
    if (['SHIPPED', 'DELIVERED', 'CANCELLED'].includes(o.status)) throw rpcErr(-32001, `Cannot cancel an order that is ${o.status}`);
    return setStatus(o, 'CANCELLED');
  },
  updateOrderStatus: ({ orderId, status }) => {
    if (!STATUSES.includes(status)) throw rpcErr(-32602, 'Invalid params: bad status');
    return setStatus(needOrder(orderId), status);
  },
};
app.post('/rpc', (req, res) => {
  const { jsonrpc, method, params, id } = req.body || {};
  const reply = (o) => (id === undefined ? res.status(204).end() : res.json({ jsonrpc: '2.0', id, ...o }));
  if (jsonrpc !== '2.0' || typeof method !== 'string') return res.json({ jsonrpc: '2.0', id: id ?? null, error: { code: -32600, message: 'Invalid Request' } });
  if (!methods[method]) return reply({ error: { code: -32601, message: 'Method not found' } });
  try { reply({ result: methods[method](params || {}) }); }
  catch (e) { reply({ error: { code: e.code || -32603, message: e.message } }); }
});
app.use((err, req, res, _next) => {
  if (req.path === '/rpc') return res.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  res.status(400).json({ error: err.message });
});

// ---------- WebSockets (Socket.io) ----------
const sysMsg = (orderId, text) => saveMsg(orderId, { name: 'System', role: 'system', text });
function saveMsg(orderId, m) {
  const msg = { ...m, at: new Date().toISOString() };
  (chats[orderId] ||= []).push(msg);
  return msg;
}
io.on('connection', (socket) => {
  socket.on('order:subscribe', (orderId) => socket.join('order:' + orderId));

  socket.on('chat:join', ({ orderId, name, role }) => {
    const room = 'chat:' + orderId;
    for (const sid of io.sockets.adapter.rooms.get(room) || []) { // enforce 1-on-1: one customer + one agent
      if (io.sockets.sockets.get(sid)?.data.role === role) return socket.emit('chat:error', `A ${role} is already in this chat`);
    }
    socket.data = { orderId, name, role };
    socket.join(room);
    socket.emit('chat:history', chats[orderId] || []);
    io.to(room).emit('chat:message', sysMsg(orderId, `${name} (${role}) joined`));
    if (role === 'customer') io.emit('support:request', { orderId, name });
  });

  socket.on('chat:message', ({ orderId, text }) => {
    const room = 'chat:' + orderId;
    if (!text?.trim() || !socket.rooms.has(room)) return;
    io.to(room).emit('chat:message', saveMsg(orderId, { name: socket.data.name, role: socket.data.role, text: text.trim().slice(0, 500) }));
  });

  socket.on('chat:typing', ({ orderId }) => socket.to('chat:' + orderId).emit('chat:typing', { name: socket.data?.name }));

  socket.on('disconnect', () => {
    const { orderId, name, role } = socket.data || {};
    if (orderId) io.to('chat:' + orderId).emit('chat:message', sysMsg(orderId, `${name} (${role}) left`));
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Listening on ${PORT}`));
