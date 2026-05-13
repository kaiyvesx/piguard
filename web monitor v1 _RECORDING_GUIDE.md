# Remote Camera Recording System Guide

## Overview

This web-based recording system manages **remote camera recordings** from mobile devices (Raspberry Pi cameras, mobile phones, etc.) and routes them to a central backend server at `10.10.218.105:8000`. The system uses a real-time communication approach with **Socket.IO** for live device status and upload notifications.

---

## System Architecture

### Key Components

```
┌─────────────────────────────────────────────────────────────┐
│                    Admin Web Interface                       │
│          (camera-admin-recording.html + .js)                │
└──────────────────────┬──────────────────────────────────────┘
                       │
        ┌──────────────┼──────────────┐
        │              │              │
        ▼              ▼              ▼
   HTTP REST      Socket.IO      Device List
   /api/record    (Real-time)    /api/devices
        │              │              │
        └──────────────┼──────────────┘
                       │
        ┌──────────────▼──────────────┐
        │  Backend Server             │
        │  10.10.218.105:8000         │
        │  ├─ API Routes              │
        │  ├─ Socket.IO Server        │
        │  └─ File Storage            │
        └──────────────┬──────────────┘
                       │
        ┌──────────────┴──────────────┐
        │              │              │
        ▼              ▼              ▼
   Captured        Captured       Captured
   Videos          Images         Location
   (Storage)       (Storage)      (Storage)
```

---

## Data Flow: How Recordings Get to the Server

### Step 1: Initialize Connection
1. The admin web interface loads `admin_recording.js`
2. Configures backend URL (default: `http://10.10.218.105:8000`)
3. Sets up optional Bearer token authentication
4. Stores configuration in browser localStorage

### Step 2: Fetch Connected Devices
- **Endpoint:** `GET /api/devices`
- **Headers:** `Authorization: Bearer {token}` (if provided)
- **Response:** List of connected devices with:
  - `socket_id` - Unique Socket.IO connection ID
  - `device_id` - Device identifier
  - `device_name` - Human-readable name
  - `user_id` - Associated user
  - `connected_at` - Connection timestamp
  - `last_seen_at` - Last activity timestamp

### Step 3: Real-Time Socket.IO Connection
The admin interface establishes a **persistent Socket.IO connection** to the backend:

```javascript
socket = io("http://10.10.218.105:8000", {
  transports: ["websocket", "polling"],
  auth: { token: bearerToken }
})
```

**Events Listened:**
- `connect` - Socket connected successfully
- `disconnect` - Socket disconnected
- `devices:updated` - Device list changed (new device connected/disconnected)
- `admin:upload_ready` - **A recording upload is ready** ← Key event

### Step 4: Send Recording Command
Admin selects a device and sends a recording request:

**Request:**
```http
POST /api/record
Content-Type: application/json
Authorization: Bearer {token}

{
  "socket_id": "aBcDeF123456",
  "camera": "front",        // or "back"
  "duration": 15            // seconds (1-600)
}
```

**What happens on the backend:**
1. Backend locates the connected device via `socket_id`
2. Sends a recording command through the Socket.IO connection to that device
3. Device receives the command and starts recording video
4. Device captures video from specified camera for specified duration
5. Device uploads the video file to the backend's storage

### Step 5: Upload Ready Notification
Once the device finishes recording and uploads the file:

**Backend emits Socket.IO event to admin:**
```javascript
socket.on("admin:upload_ready", (payload) => {
  {
    socket_id: "aBcDeF123456",
    device_id: "device-001",
    device_name: "Kitchen Camera",
    file_url: "http://10.10.218.105:8000/files/captured_video/...",
    camera: "front",
    duration: 15,
    path: "s3://bucket/path/...",  // Cloud storage path if used
    bucket: "recordings",
    uploaded_at: 1715200000000
  }
})
```

**Admin interface:**
1. Receives the upload notification
2. Displays it in the "Upload Feed" list
3. Keeps last 20 uploads in memory
4. Provides downloadable link to the video file

### Step 6: Access Stored Files
Admin can browse recorded files through the **Storage Browser**:

**Request:**
```http
GET /api/admin/files?folder=captured_video
Authorization: Bearer {token}
```

**Response:**
```json
{
  "files": [
    {
      "name": "recording_2025_05_09.mp4",
      "size": 5242880,
      "modified_at": 1715200000000,
      "url": "http://10.10.218.105:8000/download/..."
    }
  ]
}
```

---

## Configuration

### Backend Server Settings

| Setting | Default | Description |
|---------|---------|-------------|
| **Backend URL** | `http://10.10.218.105:8000` | Main API and Socket.IO server |
| **Admin Token** | (optional) | Bearer token for authenticated requests |
| **Duration** | 15 seconds | Recording length (1-600 seconds) |

### Storage Folders

The system supports organizing files into categories:
- `captured_video` - Video recordings
- `captured_img` - Still images from cameras
- `captured_location` - GPS/location data

---

## Authentication Flow

### Bearer Token
If configured, all requests include authorization:

```javascript
headers: {
  "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

The token is:
1. Entered in the admin UI
2. Automatically normalized (removes "Bearer " prefix if included)
3. Stored in localStorage for persistence
4. Sent with all API calls and Socket.IO auth
5. Optional - system works without token if not required

---

## Device Communication Protocol

### Device → Server Flow

1. **Device establishes Socket.IO connection** to backend
   - Authenticates with device credentials
   - Receives unique `socket_id`

2. **Device listens for commands**
   - Backend sends `record:start` command via Socket.IO
   - Contains: camera side, duration, quality settings

3. **Device captures video**
   - Opens specified camera (front/back)
   - Records for specified duration
   - Stores in device's local storage temporarily

4. **Device uploads to backend**
   - HTTP POST to `/api/upload` endpoint
   - Sends video file in multipart/form-data
   - Backend stores in file system or cloud storage

5. **Backend notifies admin**
   - Emits `admin:upload_ready` event to admin Socket.IO
   - Includes download URL and metadata

---

## Real-Time Features

### Socket.IO Events Summary

| Event | Direction | Payload |
|-------|-----------|---------|
| `connect` | Server → Admin | - |
| `disconnect` | Server → Admin | - |
| `devices:updated` | Server → Admin | Array of connected devices |
| `admin:upload_ready` | Server → Admin | Upload details with file URL |
| `record:start` | Server → Device | Recording parameters |

### Connection Status Indicators

- **Connected** ✓ Green - Admin is connected to Socket.IO server
- **Disconnected** ✗ Red - Lost connection to server
- **Connecting** ⟳ Yellow - Attempting to establish connection
- **Device Count** - Shows number of connected recording devices
- **Upload Count** - Shows number of recordings received

---

## API Endpoints Reference

### Device Management
```
GET /api/devices
  → Returns list of connected devices
  Headers: Authorization (optional)
```

### Recording Control
```
POST /api/record
  → Queue a recording on a specific device
  Headers: Authorization, Content-Type: application/json
  Body: { socket_id, camera, duration }
```

### File Management
```
GET /api/admin/files?folder={folder_name}
  → List files in storage folder
  Headers: Authorization (required)
  Query: folder=captured_video|captured_img|captured_location
```

```
GET /api/download/{file_id}
  → Download a recorded file
  Headers: Authorization (optional)
```

---

## Troubleshooting

### Issue: "Disconnected" status
- **Cause:** Backend server is unreachable
- **Solution:** 
  1. Verify backend URL is correct (http://10.10.218.105:8000)
  2. Check if backend server is running
  3. Verify network connectivity to server

### Issue: No devices showing
- **Cause:** No mobile devices connected yet
- **Solution:**
  1. Ensure mobile app is installed and running on devices
  2. Devices should auto-connect if on same network
  3. Check device logs for connection errors

### Issue: Recording fails to upload
- **Cause:** Device network issues or backend storage full
- **Solution:**
  1. Check device internet connection
  2. Verify backend has available storage
  3. Check backend logs for upload errors
  4. Retry the recording

### Issue: Can't access uploaded files
- **Cause:** Missing or incorrect admin token
- **Solution:**
  1. Verify token is correct
  2. Try refreshing storage browser
  3. Check token hasn't expired

---

## Security Considerations

1. **Bearer Token:** Use strong, cryptographically secure tokens
2. **HTTPS:** In production, use `https://10.10.218.105:8000` instead of HTTP
3. **Firewall:** Restrict access to 10.10.218.105:8000 to authorized networks
4. **Storage:** Recorded files should be encrypted at rest
5. **Token Rotation:** Periodically refresh authentication tokens

---

## Data Retention

- **In-Memory Upload List:** Last 20 uploads kept in browser memory
- **Browser Storage:** Configuration stored in localStorage
- **Server Storage:** Depends on backend configuration (typically in `/captured_video`, `/captured_img`, `/captured_location`)

---

## Performance Notes

- **Socket.IO Polling Fallback:** System uses websocket + polling for compatibility
- **Reconnection:** Automatic reconnection with up to 10 retry attempts
- **Device Updates:** Pushed in real-time via Socket.IO events
- **Storage Browsing:** On-demand REST API calls (no polling)

---

## Example Workflow

### Complete Recording Session

```
1. Admin opens web interface
2. Backend URL auto-loads: http://10.10.218.105:8000
3. Admin clicks "Refresh Devices" → fetches /api/devices
4. Admin sees 3 connected devices listed
5. Admin selects "Kitchen Camera"
6. Admin sets duration to 30 seconds
7. Admin clicks "Send Record Command"
8. Backend receives POST /api/record with device socket_id
9. Backend sends command to Kitchen Camera device via Socket.IO
10. Device starts recording video
11. After 30 seconds, device stops and uploads to backend
12. Backend receives upload, stores file
13. Backend emits admin:upload_ready event
14. Admin interface receives notification
15. Upload appears in "Upload Feed" with download link
16. Admin clicks link to download MP4 video file
```

---

## File Structure

- `admin_recording.js` - Main recording admin interface logic
- `camera-admin.js` - Camera control functions
- `camera-admin.html` - Recording UI templates and forms
- `index.html` - Entry point with configuration panel

---

## Support & Documentation

For API specifications, see backend documentation at:
- Backend Swagger/OpenAPI: `http://10.10.218.105:8000/docs`
- Backend Health: `http://10.10.218.105:8000/health`

---

**Last Updated:** May 9, 2025  
**System Version:** Remote Recording Admin v1.0
