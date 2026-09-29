# 📦 Order Tracking & Live Support System

One full-stack app demonstrating **REST, WebSockets (Socket.io), JSON-RPC 2.0 and Server-Sent Events**.

- `server/` – Node + Express + Socket.io (deploy to Render/Railway)
- `client/` – static HTML/JS (deploy to Vercel/Netlify)

## Run locally
```bash
cd server && npm install && npm start      # http://localhost:3000
cd client && npx serve .                   # or open index.html; edit config.js if needed
```
Open two browser tabs: set one role to **Support agent**, the other to **Customer**, place an order, click **Chat**.

## Protocols & endpoints
| Protocol | Endpoint | Purpose |
|---|---|---|
| REST | `GET /api/v1/catalog`, `GET/POST /api/v1/orders`, `GET /api/v1/orders/:id`, `PATCH /api/v1/orders/:id/status` | Catalog & order resources |
| JSON-RPC 2.0 | `POST /rpc` | `cancelOrder`, `getOrderStatus`, `updateOrderStatus`, `listOrders` |
| SSE | `GET /events` | `alert` events `{level,message,at}` |
| WebSocket | Socket.io on same host | see below |

JSON-RPC example:
```bash
curl -X POST $API/rpc -H 'Content-Type: application/json' \
 -d '{"jsonrpc":"2.0","method":"cancelOrder","params":{"orderId":1001},"id":1}'
```
Errors: `-32700` parse, `-32600` invalid request, `-32601` method not found, `-32602` invalid params, `-32001` cannot cancel, `-32002` order not found.

## WebSocket events
**Client → Server**
| Event | Payload | Description |
|---|---|---|
| `order:subscribe` | `orderId` | Join `order:<id>` room for status pushes |
| `chat:join` | `{orderId,name,role}` | Join 1-on-1 room `chat:<id>` (`role`: `customer`/`agent`, max one of each) |
| `chat:message` | `{orderId,text}` | Send message to the room |
| `chat:typing` | `{orderId}` | Typing indicator |

**Server → Client**
| Event | Payload | Description |
|---|---|---|
| `order:status` | order | Sent to subscribers of that order when status changes |
| `order:updated` / `order:created` | order | Broadcast to everyone (keeps lists in sync) |
| `chat:history` | message[] | Sent to the joiner |
| `chat:message` | `{name,role,text,at}` | New message (role `system` for join/leave) |
| `chat:typing` | `{name}` | Peer is typing |
| `chat:error` | string | e.g. that role is already taken |
| `support:request` | `{orderId,name}` | A customer opened a chat (agents see it) |

## Deploy
**Backend (Render):** New → Web Service → connect repo → Root Directory `server`, Build `npm install`, Start `npm start`. Optional env: `CLIENT_ORIGIN=https://your-app.vercel.app`. (Railway: same settings.) Note: Render free tier sleeps after inactivity — open the URL once before submitting.

**Frontend (Vercel/Netlify):** Import repo → Root Directory `client`, no build command. Before deploying set `client/config.js` → `window.API_URL = 'https://your-backend.onrender.com'`, commit, push.

## Notes
Data is in memory (resets on restart) to keep the demo simple; swap the arrays for a database for production.
