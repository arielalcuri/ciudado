import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3050;

app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PROFILE_COLORS = [
  '#e11d48', // Rosa/Rojo (Mamá / Principal)
  '#2563eb', // Azul
  '#10b981', // Esmeralda
  '#f59e0b', // Ámbar
  '#8b5cf6', // Violeta
  '#06b6d4', // Cian
  '#ec4899'  // Fucsia
];

// Almacenamiento en memoria por Código Familiar (ej. "MAMA-2026")
const familyRooms = new Map();

function getRoom(code) {
  const normalized = (code || 'FAMILIA').trim().toUpperCase();
  if (!familyRooms.has(normalized)) {
    familyRooms.set(normalized, {
      code: normalized,
      members: {},       // memberId -> { id, name, avatar, color, role, lat, lng, accuracy, speed, battery, charging, motionState, accelMag, lastSeen, peerId }
      routeHistory: [],  // [{ memberId, name, color, lat, lng, timestamp, speed, motionState }]
      alerts: [],        // [{ id, type, message, timestamp, senderName, targetMemberId, lat, lng }]
      safeZones: {},     // memberId -> { lat, lng, radiusMeters }
      clients: new Set() // Clientes SSE conectados
    });
  }
  return familyRooms.get(normalized);
}

function broadcastToRoom(room, eventType, payload) {
  const data = `event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of room.clients) {
    try {
      res.write(data);
    } catch {
      room.clients.delete(res);
    }
  }
}

// SSE: Canal de eventos en tiempo real para la familia
app.get('/api/room/:code/stream', (req, res) => {
  const room = getRoom(req.params.code);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  // Enviar estado inicial completo al conectarse
  res.write(`event: init\ndata: ${JSON.stringify({
    code: room.code,
    members: room.members,
    routeHistory: room.routeHistory.slice(-600),
    alerts: room.alerts.slice(-60),
    safeZones: room.safeZones
  })}\n\n`);

  room.clients.add(res);

  const keepAlive = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(keepAlive);
      room.clients.delete(res);
    }
  }, 20000);

  req.on('close', () => {
    clearInterval(keepAlive);
    room.clients.delete(res);
  });
});

// Obtener estado actual de la sala familiar
app.get('/api/room/:code/state', (req, res) => {
  const room = getRoom(req.params.code);
  res.json({
    code: room.code,
    members: room.members,
    routeHistory: room.routeHistory.slice(-600),
    alerts: room.alerts.slice(-60),
    safeZones: room.safeZones
  });
});

// Actualizar telemetría de CUALQUIER perfil/dispositivo de la familia
app.post('/api/room/:code/telemetry', (req, res) => {
  const room = getRoom(req.params.code);
  const {
    memberId,
    name,
    avatar,
    role,
    lat,
    lng,
    accuracy,
    speed,
    heading,
    battery,
    charging,
    motionState,
    accelMag,
    peerId
  } = req.body;

  if (!memberId) {
    return res.status(400).json({ error: 'memberId es requerido' });
  }

  const now = new Date().toISOString();
  const prev = room.members[memberId] || {};

  // Asignar color único por dispositivo/perfil
  let assignedColor = prev.color;
  if (!assignedColor) {
    if (role === 'patient') {
      assignedColor = PROFILE_COLORS[0];
    } else {
      const existingCount = Object.keys(room.members).length;
      assignedColor = PROFILE_COLORS[(existingCount % (PROFILE_COLORS.length - 1)) + 1];
    }
  }

  const updatedMember = {
    ...prev,
    id: memberId,
    name: name || prev.name || (role === 'patient' ? 'Mamá' : 'Familiar'),
    avatar: avatar || prev.avatar || (role === 'patient' ? '👵' : '🛡️'),
    color: assignedColor,
    role: role || prev.role || 'caregiver',
    lat: typeof lat === 'number' ? lat : prev.lat,
    lng: typeof lng === 'number' ? lng : prev.lng,
    accuracy: typeof accuracy === 'number' ? accuracy : prev.accuracy,
    speed: typeof speed === 'number' ? speed : (prev.speed || 0),
    heading: typeof heading === 'number' ? heading : prev.heading,
    battery: typeof battery === 'number' ? battery : prev.battery,
    charging: typeof charging === 'boolean' ? charging : prev.charging,
    motionState: motionState || prev.motionState || 'En reposo',
    accelMag: typeof accelMag === 'number' ? accelMag : prev.accelMag,
    peerId: peerId || prev.peerId,
    lastSeen: now
  };

  room.members[memberId] = updatedMember;

  // Guardar punto en el historial de ruta para TODOS los perfiles de la familia
  if (typeof lat === 'number' && typeof lng === 'number') {
    const memberPoints = room.routeHistory.filter((p) => p.memberId === memberId);
    const lastPoint = memberPoints[memberPoints.length - 1];
    const shouldAdd =
      !lastPoint ||
      Math.abs(lastPoint.lat - lat) > 0.00005 ||
      Math.abs(lastPoint.lng - lng) > 0.00005 ||
      Date.now() - new Date(lastPoint.timestamp).getTime() > 60000;

    if (shouldAdd) {
      const point = {
        memberId,
        name: updatedMember.name,
        color: updatedMember.color,
        lat,
        lng,
        speed: updatedMember.speed,
        motionState: updatedMember.motionState,
        timestamp: now
      };
      room.routeHistory.push(point);
      if (room.routeHistory.length > 1500) {
        room.routeHistory.shift();
      }
      broadcastToRoom(room, 'route_point', point);
    }
  }

  broadcastToRoom(room, 'member_update', updatedMember);
  res.json({ ok: true, member: updatedMember });
});

// Enviar alerta o comando dirigido a un dispositivo específico (targetMemberId) o a todos
app.post('/api/room/:code/command', (req, res) => {
  const room = getRoom(req.params.code);
  const {
    type,
    message,
    senderId,
    senderName,
    senderRole,
    targetMemberId,
    payload,
    lat,
    lng
  } = req.body;

  const eventObj = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    type: type || 'info',
    message: message || '',
    senderId: senderId || '',
    senderName: senderName || 'Sistema',
    senderRole: senderRole || 'system',
    targetMemberId: targetMemberId || 'all',
    payload: payload || {},
    lat,
    lng,
    timestamp: new Date().toISOString()
  };

  if (['sos', 'fall', 'status_ok', 'geofence', 'low_battery'].includes(type)) {
    room.alerts.push(eventObj);
    if (room.alerts.length > 200) room.alerts.shift();
  }

  if (type === 'set_safe_zone' && payload?.safeZone && payload?.memberId) {
    room.safeZones[payload.memberId] = payload.safeZone;
    broadcastToRoom(room, 'safe_zones', room.safeZones);
  }

  if (type === 'clear_route') {
    if (targetMemberId && targetMemberId !== 'all') {
      room.routeHistory = room.routeHistory.filter((p) => p.memberId !== targetMemberId);
    } else {
      room.routeHistory = [];
    }
    broadcastToRoom(room, 'route_cleared', { targetMemberId: targetMemberId || 'all' });
  }

  if (type === 'remove_member' && targetMemberId) {
    delete room.members[targetMemberId];
    broadcastToRoom(room, 'member_removed', { memberId: targetMemberId });
  }

  broadcastToRoom(room, 'command', eventObj);
  res.json({ ok: true, event: eventObj });
});

function getLocalIPs() {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        ips.push(net.address);
      }
    }
  }
  return ips;
}

app.get('/api/server-info', (req, res) => {
  res.json({
    port: PORT,
    localIPs: getLocalIPs()
  });
});

app.listen(PORT, '0.0.0.0', () => {
  const ips = getLocalIPs();
  console.log(`\n=============================================================`);
  console.log(`❤️  SERVIDOR CUIDADO FAMILIAR MULTIPERFIL EN PUERTO ${PORT}`);
  console.log(`=============================================================`);
  console.log(`👉 En esta PC: http://localhost:${PORT}`);
  ips.forEach((ip) => {
    console.log(`📱 En celulares (misma red Wi-Fi): http://${ip}:${PORT}`);
  });
  console.log(`🌐 Soporta múltiples perfiles familiares y conexión P2P Online`);
  console.log(`=============================================================\n`);
});
