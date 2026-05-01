# Electron admin panel — integration guide

The admin dashboard talks **only** to the central backend. Use WebSockets for live command/response flow; optionally use HTTP to enqueue a command if you prefer `fetch` for that step.

## Base URL

- HTTP: `https://your-server.example.com` (or `http://` in dev)
- Admin WebSocket: `wss://your-server.example.com/ws/admin` (or `ws://` in dev)

## Authentication

Same as HTTP: send the admin bearer token configured as `ADMIN_BEARER_TOKEN` on the server.

Recommended for WebSocket:

1. Connect to `/ws/admin`.
2. Send a single **hello** JSON frame as the first message:

```json
{
  "type": "hello",
  "role": "admin",
  "token": "<ADMIN_BEARER_TOKEN>"
}
```

You can use `"bearer"` instead of `"token"` if you prefer.

3. Wait for:

```json
{ "type": "ready" }
```

If authentication fails, the server closes the socket (non-standard close codes in the 4400 range may be used).

## Sending a command (WebSocket)

After `ready`, send:

```json
{
  "type": "command_request",
  "user_id": "<supabase-auth-uid>",
  "action": "get_gps",
  "request_id": "abc123",
  "payload": {}
}
```

- **`request_id`**: optional; the server generates a UUID if omitted. Use your own string to correlate UI state.
- **`payload`**: optional object; forwarded to the device.

Shorthand (same handler): you may omit `type` and send:

```json
{
  "user_id": "<supabase-auth-uid>",
  "action": "get_gps",
  "request_id": "abc123",
  "payload": {}
}
```

You will receive an acknowledgement:

```json
{
  "type": "accepted",
  "request_id": "abc123",
  "user_id": "<supabase-auth-uid>",
  "device_id": "<optional-device-id>",
  "device_name": "<optional-device-name>",
  "action": "get_gps"
}
```

## Receiving results (WebSocket)

The server pushes to **all** connected admin clients.

### Device tracking workflow events (new)

When mobile requests admin approval for live tracking, it now emits backend log events that are forwarded to admin sockets as:

```json
{
  "type": "device_event",
  "user_id": "<supabase-auth-uid>",
  "device_id": "<optional-device-id>",
  "device_name": "<optional-device-name>",
  "action": "tracking_request",
  "event": "tracking_request",
  "payload": {
    "type": "tracking_request",
    "action": "tracking_request",
    "user_id": "<supabase-auth-uid>",
    "device_id": "<optional-device-id>",
    "device_name": "<optional-device-name>",
    "ts": 1770000000000
  },
  "received_at": 1770000000100
}
```

While tracking is active, mobile sends `location_update` events every ~5 seconds with coordinates in `payload`.
When tracking stops, mobile sends `tracking_session_end` with a session summary payload (start/end/duration/route array).

Admin should:
- show pending approval UI when `tracking_request` arrives
- approve by sending a command with `action: "tracking_approved"` to that `user_id`
- reject by sending `action: "tracking_rejected"`

**Success** (normalized by the server):

```json
{
  "type": "command_response",
  "request_id": "abc123",
  "user_id": "<supabase-auth-uid>",
  "device_id": "<optional-device-id>",
  "action": "get_gps",
  "status": "success",
  "data": {
    "lat": 14.5995,
    "lng": 120.9842
  }
}
```

**Error**:

```json
{
  "type": "command_response",
  "request_id": "abc123",
  "user_id": "<supabase-auth-uid>",
  "device_id": "<optional-device-id>",
  "action": "get_gps",
  "status": "error",
  "error": {
    "code": "permission_denied",
    "message": "User denied location"
  }
}
```

**Device offline** (command queued):

```json
{
  "type": "command_queued",
  "request_id": "abc123",
  "user_id": "<supabase-auth-uid>",
  "device_id": "<optional-device-id>",
  "action": "get_gps",
  "message": "User is offline; command will be delivered when the active session reconnects."
}
```

## Keepalive

You may send:

```json
{ "type": "ping" }
```

The server replies with `{ "type": "pong" }`.

## Optional: enqueue via HTTP

`POST /admin/command` with headers:

- `Authorization: Bearer <ADMIN_BEARER_TOKEN>`
- `Content-Type: application/json`

Body:

```json
{
  "user_id": "<supabase-auth-uid>",
  "action": "take_photo",
  "request_id": "optional-id",
  "payload": {}
}
```

Still keep the WebSocket open to receive `command_response` events.

## Electron implementation sketch (Main process)

Use the [`ws`](https://www.npmjs.com/package/ws) package (or browser `WebSocket` in a `BrowserWindow` with caution around CORS/TLS).

```javascript
const WebSocket = require('ws');

const url = 'wss://your-server.example.com/ws/admin';
const adminToken = process.env.ADMIN_TOKEN;

const ws = new WebSocket(url);

ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'hello', role: 'admin', token: adminToken }));
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === 'ready') {
    ws.send(
      JSON.stringify({
        type: 'command_request',
        user_id: 'SUPABASE_USER_ID_HERE',
        action: 'get_gps',
        request_id: 'ui-123',
        payload: {},
      }),
    );
    return;
  }
  if (msg.type === 'command_response') {
    // Update renderer via webContents.send('command-response', msg)
  }
});
```

Store `ADMIN_BEARER_TOKEN` in environment variables or a secrets manager, not in source control.

## UX tips

- Map **`request_id`** to a pending row in your UI; resolve it when `command_response` arrives.
- Show user presence using **`command_queued`** vs immediate execution, and display `device_id` / `device_name` only as secondary metadata.
- For camera/GPS/SMS/call actions, show the same JSON `data` / `error` objects the server forwards from the device.
