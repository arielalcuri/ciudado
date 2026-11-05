// ============================================================================
// CUIDADO FAMILIAR MULTI-PERFIL (GPS, RUTAS POR DISPOSITIVO, CÁMARA Y VOZ)
// ============================================================================

const state = {
  familyCode: localStorage.getItem('cf_code') || 'MAMA-2026',
  memberName: localStorage.getItem('cf_name') || '',
  avatar: localStorage.getItem('cf_avatar') || '👵',
  role: localStorage.getItem('cf_role') || '', // 'patient' | 'caregiver'
  memberId: localStorage.getItem('cf_member_id') || ('mem_' + Math.random().toString(36).slice(2, 10)),

  // Perfil seleccionado actualmente en el Panel Familiar ('all' o memberId específico)
  selectedMemberId: 'all',

  // Sensores propios
  lat: null,
  lng: null,
  accuracy: null,
  speedKmh: 0,
  battery: null,
  charging: false,
  motionState: 'En reposo',
  accelMag: 9.8,

  // Sala familiar multi-dispositivo
  members: {},
  routeHistory: [],
  alerts: [],
  safeZones: {},
  geofenceAlertSent: {},

  // WebRTC P2P Cloud (PeerJS)
  peer: null,
  peerId: null,
  hubPeer: null,
  activeCall: null,
  dataConnections: new Map(),
  localStream: null,
  cameraFacingMode: 'user',
  snapshotInterval: null,
  micMuted: false,

  // Detección de caídas y alarmas
  fallCountdownTimer: null,
  fallSecondsLeft: 10,
  alarmInterval: null,
  wakeLock: null,
  demoInterval: null
};

localStorage.setItem('cf_member_id', state.memberId);

const el = (id) => document.getElementById(id);

// ============================================================================
// 1. SONIDOS SINTETIZADOS Y VOZ HABLADA (TEXT-TO-SPEECH)
// ============================================================================
let audioCtx = null;
function getAudioContext() {
  if (!audioCtx) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) audioCtx = new AudioContextClass();
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
  return audioCtx;
}

function playTone(freq = 880, durationMs = 250, type = 'sine', gainVal = 0.35) {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, ctx.currentTime);
    gain.gain.setValueAtTime(gainVal, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + durationMs / 1000);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + durationMs / 1000);
  } catch {}
}

function playGentleConnectTone() {
  playTone(523.25, 180, 'sine', 0.3);
  setTimeout(() => playTone(659.25, 220, 'sine', 0.3), 190);
  setTimeout(() => playTone(783.99, 300, 'sine', 0.3), 400);
}

function playAttentionChime() {
  const notes = [880, 1174.66, 880, 1174.66, 1318.5];
  notes.forEach((n, idx) => {
    setTimeout(() => playTone(n, 260, 'triangle', 0.6), idx * 280);
  });
  if (navigator.vibrate) navigator.vibrate([300, 150, 300, 150, 500]);
}

function startEmergencySiren() {
  stopEmergencySiren();
  let high = true;
  playTone(960, 350, 'sawtooth', 0.5);
  state.alarmInterval = setInterval(() => {
    playTone(high ? 960 : 720, 350, 'sawtooth', 0.5);
    if (navigator.vibrate) navigator.vibrate(300);
    high = !high;
  }, 400);
}

function stopEmergencySiren() {
  if (state.alarmInterval) {
    clearInterval(state.alarmInterval);
    state.alarmInterval = null;
  }
}

function speakTextOutLoud(text) {
  if (!text) return;
  try {
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(text);
      utter.lang = 'es-AR';
      utter.rate = 0.92;
      utter.pitch = 1.0;
      utter.volume = 1.0;
      window.speechSynthesis.speak(utter);
    }
  } catch {}
}

// ============================================================================
// 2. WAKELOCK (PANTALLA ACTIVA EN ANDROID)
// ============================================================================
async function requestScreenWakeLock() {
  if ('wakeLock' in navigator) {
    try {
      state.wakeLock = await navigator.wakeLock.request('screen');
    } catch {}
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.role) {
    requestScreenWakeLock();
  }
});

// ============================================================================
// 3. GEOLOCALIZACIÓN CONTINUA Y DISTANCIAS
// ============================================================================
function calculateDistanceMeters(lat1, lon1, lat2, lon2) {
  if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) return null;
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function formatDistance(meters) {
  if (meters == null) return '--';
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(2)} km`;
}

let geoWatchId = null;
function startGpsTracking() {
  if (!('geolocation' in navigator)) {
    updateGpsBadge('GPS no disponible', false);
    sendTelemetryUpdate();
    return;
  }

  if (geoWatchId !== null) navigator.geolocation.clearWatch(geoWatchId);

  geoWatchId = navigator.geolocation.watchPosition(
    (pos) => {
      state.lat = pos.coords.latitude;
      state.lng = pos.coords.longitude;
      state.accuracy = Math.round(pos.coords.accuracy || 10);
      const rawSpeed = pos.coords.speed;
      state.speedKmh = rawSpeed && rawSpeed > 0 ? +(rawSpeed * 3.6).toFixed(1) : 0;

      updateGpsBadge(`Activo (±${state.accuracy}m)`, true);
      sendTelemetryUpdate();
    },
    () => {
      updateGpsBadge('Permiso GPS pendiente', false);
      sendTelemetryUpdate();
    },
    {
      enableHighAccuracy: true,
      maximumAge: 3000,
      timeout: 12000
    }
  );
}

function updateGpsBadge(text, ok) {
  const badge = el('ptGpsStatus');
  if (badge) {
    badge.textContent = text;
    badge.className = `text-sm font-bold ${ok ? 'text-emerald-400' : 'text-amber-400'}`;
  }
}

// ============================================================================
// 4. SENSORES DE MOVIMIENTO Y DETECCIÓN DE CAÍDAS
// ============================================================================
let lastMotionSentAt = 0;
function startMotionAndFallDetection() {
  if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
    DeviceMotionEvent.requestPermission().catch(() => {});
  }

  window.addEventListener('devicemotion', (event) => {
    const acc = event.accelerationIncludingGravity;
    if (!acc || (acc.x === null && acc.y === null && acc.z === null)) return;

    const x = acc.x || 0;
    const y = acc.y || 0;
    const z = acc.z || 0;
    const mag = Math.sqrt(x * x + y * y + z * z);
    state.accelMag = +mag.toFixed(1);

    const delta = Math.abs(mag - 9.81);
    let newState = 'En reposo';
    if (mag > 24.5) {
      newState = '⚠️ Impacto / Posible Caída';
      if (state.role === 'patient') {
        triggerFallCountdown();
      }
    } else if (delta > 3.8 || state.speedKmh > 2.5) {
      newState = 'Caminando / En traslado';
    } else if (delta > 1.2) {
      newState = 'Movimiento leve';
    }

    state.motionState = newState;

    const accelLabel = el('ptAccelValue');
    if (accelLabel) accelLabel.textContent = `${state.accelMag} m/s²`;
    const motionBadge = el('ptMotionStatus');
    if (motionBadge) motionBadge.textContent = newState;

    const now = Date.now();
    if (now - lastMotionSentAt > 3500) {
      lastMotionSentAt = now;
      sendTelemetryUpdate();
    }
  });
}

function triggerFallCountdown() {
  if (state.fallCountdownTimer) return;

  const box = el('ptFallCountdownBox');
  const secSpan = el('ptFallSeconds');
  if (box) box.classList.remove('hidden');

  state.fallSecondsLeft = 10;
  if (secSpan) secSpan.textContent = String(state.fallSecondsLeft);

  playAttentionChime();
  speakTextOutLoud('Se detectó un golpe o posible caída. Si estás bien, tocá el botón verde en la pantalla.');

  state.fallCountdownTimer = setInterval(() => {
    state.fallSecondsLeft -= 1;
    if (secSpan) secSpan.textContent = String(state.fallSecondsLeft);
    playTone(880, 180, 'square', 0.4);

    if (state.fallSecondsLeft <= 0) {
      clearInterval(state.fallCountdownTimer);
      state.fallCountdownTimer = null;
      if (box) box.classList.add('hidden');
      sendEmergencyAlert('fall', `⚠️ ¡POSIBLE CAÍDA DETECTADA en el teléfono de ${state.memberName}! No hubo respuesta tras 10 segundos.`);
    }
  }, 1000);
}

function cancelFallCountdown() {
  if (state.fallCountdownTimer) {
    clearInterval(state.fallCountdownTimer);
    state.fallCountdownTimer = null;
  }
  el('ptFallCountdownBox')?.classList.add('hidden');
  state.motionState = 'En reposo';
  speakTextOutLoud('Alerta cancelada. Avisando a tu familia que estás bien.');
  sendCommandToRoom('status_ok', `✅ ${state.memberName} confirmó: "ESTOY BIEN".`);
}

// ============================================================================
// 5. MONITOR DE BATERÍA
// ============================================================================
async function startBatteryMonitor() {
  if ('getBattery' in navigator) {
    try {
      const bat = await navigator.getBattery();
      const updateBat = () => {
        state.battery = Math.round(bat.level * 100);
        state.charging = bat.charging;
        const ptBat = el('ptBatteryStatus');
        if (ptBat) {
          ptBat.textContent = `${state.battery}% ${state.charging ? '⚡' : ''}`;
        }
        sendTelemetryUpdate();
      };
      updateBat();
      bat.addEventListener('levelchange', updateBat);
      bat.addEventListener('chargingchange', updateBat);
    } catch {}
  }
}

// ============================================================================
// 6. MAPA MULTI-PERFIL, BARRA DE DISPOSITIVOS Y RUTAS POR INTEGRANTE
// ============================================================================
let map = null;
const memberMarkers = new Map();
const memberRouteLines = new Map();
const memberSafeCircles = new Map();

function initCaregiverMap() {
  if (map) return;
  const mapContainer = el('map');
  if (!mapContainer) return;

  map = L.map('map').setView([-34.6037, -58.3816], 15);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap'
  }).addTo(map);
}

function getFocusedMember() {
  const membersArr = Object.values(state.members);
  if (state.selectedMemberId !== 'all' && state.members[state.selectedMemberId]) {
    return state.members[state.selectedMemberId];
  }
  return membersArr.find((m) => m.role === 'patient') || membersArr[0] || null;
}

function renderProfilesSelectorBar() {
  const bar = el('profilesSelectorBar');
  if (!bar) return;

  const membersArr = Object.values(state.members);
  bar.innerHTML = '';

  // Botón 1: Ver Todos los dispositivos a la vez
  const allBtn = document.createElement('button');
  const isAllSelected = state.selectedMemberId === 'all';
  allBtn.className = `shrink-0 px-3.5 py-2 rounded-xl border-2 text-xs font-bold flex items-center gap-2 transition ${
    isAllSelected
      ? 'bg-indigo-600/30 border-indigo-400 text-white shadow-lg'
      : 'bg-slate-950 border-slate-800 text-slate-300 hover:border-slate-700'
  }`;
  allBtn.innerHTML = `
    <span class="text-lg">🌍</span>
    <div class="text-left">
      <div class="font-extrabold">Toda la Familia</div>
      <div class="text-[10px] text-slate-400">${membersArr.length} dispositivo(s)</div>
    </div>
  `;
  allBtn.addEventListener('click', () => {
    state.selectedMemberId = 'all';
    updateMapAndDashboard();
    fitAllMembersOnMap();
  });
  bar.appendChild(allBtn);

  // Tarjeta por cada dispositivo/perfil conectado
  membersArr.forEach((m) => {
    const isSelected = state.selectedMemberId === m.id;
    const ageSec = m.lastSeen ? Math.round((Date.now() - new Date(m.lastSeen).getTime()) / 1000) : 999;
    const isOnline = ageSec < 60;
    const color = m.color || (m.role === 'patient' ? '#e11d48' : '#2563eb');
    const avatar = m.avatar || (m.role === 'patient' ? '👵' : '🛡️');

    const card = document.createElement('button');
    card.className = `shrink-0 px-3.5 py-2 rounded-xl border-2 text-xs flex items-center gap-2.5 transition ${
      isSelected
        ? 'bg-slate-800 text-white shadow-lg scale-[1.02]'
        : 'bg-slate-950 text-slate-300 hover:bg-slate-900'
    }`;
    card.style.borderColor = isSelected ? color : '#1e293b';

    card.innerHTML = `
      <div class="relative">
        <span class="text-2xl">${avatar}</span>
        <span class="w-2.5 h-2.5 rounded-full absolute -top-0.5 -right-0.5 border border-slate-950 ${
          isOnline ? 'bg-emerald-400' : 'bg-amber-400'
        }"></span>
      </div>
      <div class="text-left">
        <div class="font-extrabold flex items-center gap-1.5">
          <span>${m.name}</span>
          <span class="w-2 h-2 rounded-full inline-block" style="background:${color}"></span>
        </div>
        <div class="text-[10px] text-slate-400">
          ${m.motionState || 'Activo'} ${m.battery != null ? `· 🔋${m.battery}%` : ''}
        </div>
      </div>
    `;

    card.addEventListener('click', () => {
      state.selectedMemberId = m.id;
      updateMapAndDashboard();
      if (typeof m.lat === 'number' && typeof m.lng === 'number' && map) {
        map.setView([m.lat, m.lng], 17);
      }
    });

    bar.appendChild(card);
  });
}

function fitAllMembersOnMap() {
  if (!map) return;
  const coords = Object.values(state.members)
    .filter((m) => typeof m.lat === 'number' && typeof m.lng === 'number')
    .map((m) => [m.lat, m.lng]);
  if (coords.length > 1) {
    map.fitBounds(coords, { padding: [45, 45], maxZoom: 17 });
  } else if (coords.length === 1) {
    map.setView(coords[0], 16);
  }
}

function updateMapAndDashboard() {
  if (state.role !== 'caregiver') return;
  initCaregiverMap();
  renderProfilesSelectorBar();

  const membersArr = Object.values(state.members);
  const focused = getFocusedMember();

  // Actualizar nombre del destinatario en controles de Cámara / Voz
  const targetNameEl = el('cgTargetActionName');
  if (targetNameEl) {
    targetNameEl.textContent = focused ? `${focused.avatar || ''} ${focused.name}` : 'Toda la Familia';
  }

  // Mostrar botón de quitar perfil solo cuando hay un perfil individual seleccionado
  const removeBtn = el('btnRemoveSelectedMember');
  if (removeBtn) {
    if (state.selectedMemberId !== 'all' && state.members[state.selectedMemberId]) {
      removeBtn.classList.remove('hidden');
    } else {
      removeBtn.classList.add('hidden');
    }
  }

  // Actualizar tarjetas superiores con el perfil seleccionado
  if (focused) {
    const ageSec = focused.lastSeen ? Math.round((Date.now() - new Date(focused.lastSeen).getTime()) / 1000) : 999;
    const isOnline = ageSec < 60;
    el('cgPatientOnlineDot').className = `w-2.5 h-2.5 rounded-full ${isOnline ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'}`;
    el('cgPatientName').textContent = `${focused.avatar || ''} ${focused.name}`;
    el('cgLastSeen').textContent = isOnline ? 'Conectado en vivo' : `Hace ${ageSec}s`;

    el('cgMotionState').textContent = focused.motionState || 'En reposo';
    el('cgAccelDetail').textContent = focused.accelMag ? `Fuerza G: ${focused.accelMag} m/s²` : 'Acelerómetro activo';

    el('cgSpeedValue').textContent = `${(focused.speed || 0).toFixed(1)} km/h`;
    el('cgAccuracyValue').textContent = `Precisión GPS: ±${focused.accuracy || 10} m`;

    el('cgBatteryValue').textContent = focused.battery != null ? `${focused.battery}%` : '--%';
    el('cgChargingState').textContent = focused.charging ? '⚡ Cargando' : 'En batería';

    if (state.lat != null && focused.lat != null) {
      const dist = calculateDistanceMeters(state.lat, state.lng, focused.lat, focused.lng);
      el('cgDistanceToPatient').textContent =
        focused.id === state.memberId ? 'Es este dispositivo' : `Distancia a ti: ${formatDistance(dist)}`;
    }

    // Geocerca del perfil seleccionado
    const sz = state.safeZones[focused.id];
    if (sz && focused.lat != null && focused.lng != null) {
      const distFromZone = calculateDistanceMeters(sz.lat, sz.lng, focused.lat, focused.lng);
      if (distFromZone > sz.radiusMeters) {
        el('cgGeofenceStatus').textContent = `⚠️ Fuera (${Math.round(distFromZone)}m)`;
        el('cgGeofenceStatus').className = 'text-base font-bold text-rose-400 block mt-1';
        if (!state.geofenceAlertSent[focused.id]) {
          state.geofenceAlertSent[focused.id] = true;
          showCriticalBanner(
            `¡${focused.name.toUpperCase()} SALIÓ DE ZONA SEGURA!`,
            `${focused.name} está a ${Math.round(distFromZone)}m de su zona segura configurada.`
          );
        }
      } else {
        state.geofenceAlertSent[focused.id] = false;
        el('cgGeofenceStatus').textContent = `Dentro (${Math.round(distFromZone)}m)`;
        el('cgGeofenceStatus').className = 'text-base font-bold text-emerald-400 block mt-1';
      }
    } else {
      el('cgGeofenceStatus').textContent = 'No definida';
      el('cgGeofenceStatus').className = 'text-base font-bold text-slate-400 block mt-1';
    }
  }

  // Lista detallada de todos los familiares y distancias
  const listEl = el('familyMembersList');
  if (listEl) listEl.innerHTML = '';

  membersArr.forEach((m) => {
    const color = m.color || (m.role === 'patient' ? '#e11d48' : '#2563eb');
    const avatar = m.avatar || (m.role === 'patient' ? '👵' : '🛡️');
    const isFocused = state.selectedMemberId === m.id;

    if (typeof m.lat === 'number' && typeof m.lng === 'number' && map) {
      const iconHtml = `
        <div class="flex flex-col items-center">
          <div style="background:${color}" class="px-2.5 py-0.5 rounded-full text-[11px] font-extrabold text-white shadow-lg whitespace-nowrap border-2 ${
            isFocused ? 'border-yellow-300 scale-110' : 'border-white'
          }">
            ${avatar} ${m.name}
          </div>
          <div style="background:${color}" class="w-4 h-4 mt-0.5 rounded-full border-2 border-white shadow"></div>
        </div>
      `;
      const customIcon = L.divIcon({
        html: iconHtml,
        className: '',
        iconSize: [100, 44],
        iconAnchor: [50, 36]
      });

      if (memberMarkers.has(m.id)) {
        const marker = memberMarkers.get(m.id);
        marker.setLatLng([m.lat, m.lng]);
        marker.setIcon(customIcon);
      } else {
        const marker = L.marker([m.lat, m.lng], { icon: customIcon }).addTo(map);
        marker.on('click', () => {
          state.selectedMemberId = m.id;
          updateMapAndDashboard();
        });
        memberMarkers.set(m.id, marker);
      }
    }

    if (listEl) {
      const distStr =
        focused && m.id !== focused.id && m.lat != null && focused.lat != null
          ? `a ${formatDistance(calculateDistanceMeters(m.lat, m.lng, focused.lat, focused.lng))} de ${focused.name}`
          : 'Referencia actual';

      const item = document.createElement('div');
      item.className = `flex items-center justify-between px-2.5 py-1.5 rounded-lg border cursor-pointer transition ${
        isFocused ? 'bg-slate-800 border-rose-500/60' : 'bg-slate-900 border-slate-800 hover:bg-slate-800/60'
      }`;
      item.innerHTML = `
        <div class="flex items-center gap-2">
          <span class="w-2.5 h-2.5 rounded-full shrink-0" style="background:${color}"></span>
          <span class="font-bold text-white">${avatar} ${m.name}</span>
          <span class="text-[11px] text-slate-400">(${distStr})</span>
        </div>
        <div class="flex items-center gap-2">
          <span class="text-[11px] text-emerald-400 font-semibold">${(m.speed || 0).toFixed(1)} km/h</span>
        </div>
      `;
      item.addEventListener('click', () => {
        state.selectedMemberId = m.id;
        updateMapAndDashboard();
        if (m.lat != null && map) map.setView([m.lat, m.lng], 17);
      });
      listEl.appendChild(item);
    }
  });

  // Dibujar rutas individuales por cada familiar con su color
  if (map) {
    const groupedRoutes = {};
    state.routeHistory.forEach((pt) => {
      if (typeof pt.lat === 'number' && typeof pt.lng === 'number') {
        if (!groupedRoutes[pt.memberId]) groupedRoutes[pt.memberId] = [];
        groupedRoutes[pt.memberId].push([pt.lat, pt.lng]);
      }
    });

    // Limpiar líneas que no correspondan al filtro actual
    for (const [mId, poly] of memberRouteLines.entries()) {
      if (!groupedRoutes[mId] || (state.selectedMemberId !== 'all' && state.selectedMemberId !== mId)) {
        map.removeLayer(poly);
        memberRouteLines.delete(mId);
      }
    }

    let visiblePtsCount = 0;
    Object.entries(groupedRoutes).forEach(([mId, coords]) => {
      if (state.selectedMemberId !== 'all' && state.selectedMemberId !== mId) return;
      visiblePtsCount += coords.length;
      const memberColor = state.members[mId]?.color || '#e11d48';

      if (memberRouteLines.has(mId)) {
        const poly = memberRouteLines.get(mId);
        poly.setLatLngs(coords);
        poly.setStyle({ color: memberColor });
      } else {
        const poly = L.polyline(coords, {
          color: memberColor,
          weight: 5,
          opacity: 0.85
        }).addTo(map);
        memberRouteLines.set(mId, poly);
      }
    });

    const ptsLabel = el('routePointsCount');
    if (ptsLabel) ptsLabel.textContent = `${visiblePtsCount} pts de ruta`;

    // Dibujar geocercas
    for (const [mId, circle] of memberSafeCircles.entries()) {
      if (!state.safeZones[mId]) {
        map.removeLayer(circle);
        memberSafeCircles.delete(mId);
      }
    }
    Object.entries(state.safeZones).forEach(([mId, sz]) => {
      if (!sz || typeof sz.lat !== 'number') return;
      if (memberSafeCircles.has(mId)) {
        const c = memberSafeCircles.get(mId);
        c.setLatLng([sz.lat, sz.lng]);
        c.setRadius(sz.radiusMeters);
      } else {
        const c = L.circle([sz.lat, sz.lng], {
          color: '#10b981',
          fillColor: '#10b981',
          fillOpacity: 0.14,
          radius: sz.radiusMeters
        }).addTo(map);
        memberSafeCircles.set(mId, c);
      }
    });
  }

  el('cgFamilyCount').textContent = `${membersArr.length} dispositivo(s)`;
  el('cgRoomCodeBadge').textContent = `Código: ${state.familyCode}`;
}

// ============================================================================
// 7. SINCRONIZACIÓN MULTI-DISPOSITIVO (SSE + HUB P2P ONLINE WEBRTC)
// ============================================================================
let sseSource = null;

function connectRoomSync() {
  if (sseSource) sseSource.close();

  sseSource = new EventSource(`/api/room/${encodeURIComponent(state.familyCode)}/stream`);

  sseSource.addEventListener('init', (e) => {
    const data = JSON.parse(e.data);
    state.members = data.members || {};
    state.routeHistory = data.routeHistory || [];
    state.alerts = data.alerts || [];
    state.safeZones = data.safeZones || {};
    updateConnectionIndicator(true, `Sala Familiar Online (${state.familyCode})`);
    renderAlertsLog();
    updateMapAndDashboard();
  });

  sseSource.addEventListener('member_update', (e) => {
    const member = JSON.parse(e.data);
    state.members[member.id] = member;
    updateMapAndDashboard();
  });

  sseSource.addEventListener('member_removed', (e) => {
    const { memberId } = JSON.parse(e.data);
    delete state.members[memberId];
    delete state.safeZones[memberId];
    state.routeHistory = state.routeHistory.filter((p) => p.memberId !== memberId);
    if (memberMarkers.has(memberId) && map) {
      map.removeLayer(memberMarkers.get(memberId));
      memberMarkers.delete(memberId);
    }
    if (memberRouteLines.has(memberId) && map) {
      map.removeLayer(memberRouteLines.get(memberId));
      memberRouteLines.delete(memberId);
    }
    updateMapAndDashboard();
  });

  sseSource.addEventListener('route_point', (e) => {
    const pt = JSON.parse(e.data);
    state.routeHistory.push(pt);
    updateMapAndDashboard();
  });

  sseSource.addEventListener('route_cleared', (e) => {
    const { targetMemberId } = JSON.parse(e.data);
    if (targetMemberId && targetMemberId !== 'all') {
      state.routeHistory = state.routeHistory.filter((p) => p.memberId !== targetMemberId);
    } else {
      state.routeHistory = [];
    }
    updateMapAndDashboard();
  });

  sseSource.addEventListener('safe_zones', (e) => {
    state.safeZones = JSON.parse(e.data) || {};
    updateMapAndDashboard();
  });

  sseSource.addEventListener('command', (e) => {
    const cmd = JSON.parse(e.data);
    handleIncomingCommand(cmd);
  });

  sseSource.onerror = () => {
    updateConnectionIndicator(true, `Reconectando en 2do plano (${state.familyCode})`);
    setTimeout(() => {
      if (state.role) connectRoomSync();
    }, 5000);
  };
}

const processedCommandIds = new Set();
async function pollServerState() {
  if (!state.role) return;
  try {
    const res = await fetch(`/api/room/${encodeURIComponent(state.familyCode)}/state`);
    if (!res.ok) return;
    const data = await res.json();
    if (data.members) {
      state.members = data.members;
      updateMapAndDashboard();
    }
    if (Array.isArray(data.recentCommands)) {
      data.recentCommands.forEach((cmd) => {
        if (cmd.id && !processedCommandIds.has(cmd.id)) {
          processedCommandIds.add(cmd.id);
          handleIncomingCommand(cmd);
        }
      });
      if (processedCommandIds.size > 200) {
        const arr = Array.from(processedCommandIds);
        processedCommandIds.clear();
        arr.slice(-100).forEach((id) => processedCommandIds.add(id));
      }
    }
  } catch (err) {}
}

function updateConnectionIndicator(ok, text) {
  const label = el('connectionStatusText');
  if (label) {
    label.innerHTML = `<span id="connectionDot" class="w-2 h-2 rounded-full ${
      ok ? 'bg-emerald-400' : 'bg-amber-400'
    } inline-block"></span> ${text}`;
  }
}

async function sendTelemetryUpdate() {
  if (!state.role) return;

  const payload = {
    memberId: state.memberId,
    name: state.memberName,
    avatar: state.avatar,
    role: state.role,
    lat: state.lat,
    lng: state.lng,
    accuracy: state.accuracy,
    speed: state.speedKmh,
    battery: state.battery,
    charging: state.charging,
    motionState: state.motionState,
    accelMag: state.accelMag,
    peerId: state.peerId
  };

  state.members[state.memberId] = {
    ...(state.members[state.memberId] || {}),
    ...payload,
    id: state.memberId,
    lastSeen: new Date().toISOString()
  };

  broadcastP2PData({ kind: 'telemetry', data: state.members[state.memberId] });

  try {
    await fetch(`/api/room/${encodeURIComponent(state.familyCode)}/telemetry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch {}
}

async function sendCommandToRoom(type, message, extraPayload = {}, targetMemberId = 'all') {
  const body = {
    type,
    message,
    senderId: state.memberId,
    senderName: state.memberName,
    senderRole: state.role,
    targetMemberId,
    payload: extraPayload,
    lat: state.lat,
    lng: state.lng
  };

  broadcastP2PData({ kind: 'command', data: { ...body, timestamp: new Date().toISOString() } });

  try {
    await fetch(`/api/room/${encodeURIComponent(state.familyCode)}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch {}
}

function sendEmergencyAlert(type, message) {
  playAttentionChime();
  sendCommandToRoom(type, message, {}, 'all');
}

// ============================================================================
// 8. RECEPCIÓN DE COMANDOS POR DISPOSITIVO (CÁMARA, VOZ TTS, ALARMA)
// ============================================================================
function handleIncomingCommand(cmd) {
  if (!cmd) return;

  if (['sos', 'fall', 'status_ok', 'geofence', 'tts', 'ring', 'start_intercom'].includes(cmd.type)) {
    state.alerts.push(cmd);
    renderAlertsLog();
  }

  // Verificar si este comando va dirigido a este dispositivo en particular o a todos
  const isForMe =
    !cmd.targetMemberId ||
    cmd.targetMemberId === 'all' ||
    cmd.targetMemberId === state.memberId ||
    (cmd.targetMemberId === 'patient' && state.role === 'patient');

  if (isForMe && cmd.senderId !== state.memberId) {
    if (cmd.type === 'tts' && cmd.message) {
      playGentleConnectTone();
      const card = el('ptIncomingMessageCard');
      const txt = el('ptIncomingMessageText');
      if (card && txt) {
        txt.textContent = `"${cmd.message}"`;
        card.classList.remove('hidden');
      }
      setTimeout(() => speakTextOutLoud(cmd.message), 450);
    }

    if (cmd.type === 'ring') {
      playAttentionChime();
      speakTextOutLoud(`Atención, ${cmd.senderName || 'tu familia'} está haciendo sonar este teléfono.`);
    }

    if (cmd.type === 'start_intercom') {
      autoAnswerAndStreamPatientCamera(cmd.payload?.facingMode || state.cameraFacingMode, cmd.payload?.caregiverPeerId);
    }

    if (cmd.type === 'switch_camera') {
      state.cameraFacingMode = state.cameraFacingMode === 'user' ? 'environment' : 'user';
      autoAnswerAndStreamPatientCamera(state.cameraFacingMode, cmd.payload?.caregiverPeerId);
    }

    if (cmd.type === 'stop_intercom') {
      stopPatientCameraStream();
    }
  }

  // Acciones en el Panel Familiar
  if (state.role === 'caregiver') {
    if (cmd.type === 'sos' || cmd.type === 'fall') {
      showCriticalBanner(
        cmd.type === 'sos' ? `🚨 ¡PEDIDO DE AYUDA DE ${cmd.senderName?.toUpperCase()}!` : '⚠️ ¡ALERTA DE CAÍDA DETECTADA!',
        cmd.message
      );
      if (cmd.senderId && state.members[cmd.senderId]) {
        state.selectedMemberId = cmd.senderId;
        updateMapAndDashboard();
      }
      if (cmd.lat && cmd.lng && map) {
        map.setView([cmd.lat, cmd.lng], 18);
      }
    }

    if (cmd.type === 'status_ok') {
      stopEmergencySiren();
      el('criticalAlertBanner')?.classList.add('hidden');
      playGentleConnectTone();
    }

    if (cmd.type === 'camera_snapshot' && cmd.payload?.imageDataUrl) {
      const img = el('cgSnapshotFallback');
      const placeholder = el('cgVideoPlaceholder');
      const video = el('cgRemoteVideo');
      if (img && (!video || video.classList.contains('hidden'))) {
        img.src = cmd.payload.imageDataUrl;
        img.classList.remove('hidden');
        placeholder?.classList.add('hidden');
        const badge = el('cgStreamBadge');
        if (badge) {
          badge.textContent = `En Vivo (${cmd.senderName || 'Cámara'})`;
          badge.className = 'text-xs px-2.5 py-1 rounded-full bg-emerald-600 text-white font-bold animate-pulse';
        }
      }
    }
  }
}

function showCriticalBanner(title, desc) {
  const banner = el('criticalAlertBanner');
  const titleEl = el('criticalAlertTitle');
  const descEl = el('criticalAlertDesc');
  if (titleEl) titleEl.textContent = title;
  if (descEl) descEl.textContent = desc;
  if (banner) banner.classList.remove('hidden');
  startEmergencySiren();
}

function renderAlertsLog() {
  const container = el('eventsLogContainer');
  if (!container) return;

  if (!state.alerts.length) {
    container.innerHTML = '<p class="text-slate-500">Sin alertas recientes. Todos los dispositivos monitoreados.</p>';
    return;
  }

  container.innerHTML = '';
  const recent = [...state.alerts].reverse().slice(0, 25);
  recent.forEach((a) => {
    const timeStr = a.timestamp
      ? new Date(a.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      : '';
    let colorClass = 'border-slate-800 bg-slate-950 text-slate-300';
    if (a.type === 'sos' || a.type === 'fall') colorClass = 'border-rose-500/60 bg-rose-950/50 text-rose-200 font-semibold';
    if (a.type === 'status_ok') colorClass = 'border-emerald-500/50 bg-emerald-950/40 text-emerald-200';
    if (a.type === 'tts') colorClass = 'border-indigo-500/40 bg-indigo-950/30 text-indigo-200';

    const item = document.createElement('div');
    item.className = `p-2 rounded-lg border ${colorClass} flex items-start justify-between gap-2`;
    item.innerHTML = `
      <span>${a.message || a.type}</span>
      <span class="text-[10px] text-slate-400 shrink-0 font-mono">${timeStr}</span>
    `;
    container.appendChild(item);
  });
}

// ============================================================================
// 9. RED P2P ONLINE EN LA NUBE (PEERJS HUB + VIDEO/AUDIO MULTIPERFIL)
// ============================================================================
function sanitizeRoomPeerId(code, suffix) {
  const clean = code.replace(/[^a-zA-Z0-9]/g, '').toUpperCase() || 'FAMILIA';
  return `cf-room-${clean}-${suffix}`;
}

function initPeerJS() {
  if (typeof Peer === 'undefined') return;
  if (state.peer) state.peer.destroy();

  // Cada dispositivo tiene su propio PeerID único basado en su memberId
  const myPeerId = sanitizeRoomPeerId(state.familyCode, state.memberId);
  const peer = new Peer(myPeerId);
  state.peer = peer;

  peer.on('open', (id) => {
    state.peerId = id;
    sendTelemetryUpdate();

    // Conectar al Hub P2P de la Sala Familiar para descubrir otros celulares por Internet (4G/5G)
    initOrConnectFamilyHub();
  });

  peer.on('connection', (conn) => {
    setupDataConnection(conn);
  });

  peer.on('call', async (call) => {
    state.activeCall = call;

    if (state.role === 'patient') {
      playGentleConnectTone();
      speakTextOutLoud('Conectando cámara y altavoz con tu familia.');
      const stream = await getOrStartPatientMedia(state.cameraFacingMode);
      call.answer(stream || undefined);

      call.on('stream', (remoteStream) => {
        const remoteVid = el('ptRemoteVideo');
        if (remoteVid) {
          remoteVid.srcObject = remoteStream;
          remoteVid.play().catch(() => {});
        }
      });
    } else {
      call.answer(state.localStream || undefined);
      call.on('stream', (remoteStream) => {
        attachCaregiverRemoteStream(remoteStream);
      });
    }
  });
}

// Hub P2P: El primer dispositivo de la familia en conectarse actúa también como coordinador P2P en la nube
function initOrConnectFamilyHub() {
  const hubId = sanitizeRoomPeerId(state.familyCode, 'HUB');

  // Intentamos conectarnos al Hub existente
  const connToHub = state.peer.connect(hubId, { reliable: true });
  setupDataConnection(connToHub);

  // Además intentamos levantar el nodo Hub por si aún no existe en la nube
  const hubPeer = new Peer(hubId);
  hubPeer.on('open', () => {
    state.hubPeer = hubPeer;
    hubPeer.on('connection', (clientConn) => {
      setupDataConnection(clientConn);
      clientConn.on('open', () => {
        // Enviar lista completa de miembros conocidos al nuevo integrante online
        clientConn.send({ kind: 'full_sync', members: state.members, routeHistory: state.routeHistory.slice(-200) });
      });
    });
  });
  hubPeer.on('error', () => {
    // Normal si otro familiar ya tiene el nodo HUB activo
    hubPeer.destroy();
  });
}

function setupDataConnection(conn) {
  if (!conn) return;
  conn.on('open', () => {
    state.dataConnections.set(conn.peer, conn);
    if (state.members[state.memberId]) {
      conn.send({ kind: 'telemetry', data: state.members[state.memberId] });
    }
  });
  conn.on('data', (msg) => {
    if (!msg) return;
    if (msg.kind === 'full_sync') {
      if (msg.members) Object.assign(state.members, msg.members);
      if (Array.isArray(msg.routeHistory) && !state.routeHistory.length) {
        state.routeHistory = msg.routeHistory;
      }
      updateMapAndDashboard();
    }
    if (msg.kind === 'telemetry' && msg.data) {
      state.members[msg.data.id] = msg.data;
      updateMapAndDashboard();
    }
    if (msg.kind === 'command' && msg.data) {
      handleIncomingCommand(msg.data);
    }
  });
  conn.on('close', () => {
    state.dataConnections.delete(conn.peer);
  });
}

function broadcastP2PData(payload) {
  for (const conn of state.dataConnections.values()) {
    try {
      if (conn.open) conn.send(payload);
    } catch {}
  }
}

async function getOrStartPatientMedia(facingMode = 'user') {
  try {
    if (state.localStream) {
      state.localStream.getTracks().forEach((t) => t.stop());
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: facingMode }, width: { ideal: 640 }, height: { ideal: 480 } },
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    state.localStream = stream;

    el('ptVideoContainer')?.classList.remove('hidden');
    const ptLocalVid = el('ptLocalVideo');
    if (ptLocalVid) {
      ptLocalVid.srcObject = stream;
      ptLocalVid.play().catch(() => {});
    }
    const facingLbl = el('ptCameraFacingLabel');
    if (facingLbl) {
      facingLbl.textContent = facingMode === 'environment' ? 'Cámara Trasera' : 'Cámara Frontal';
    }

    startPatientSnapshotFallback();
    return stream;
  } catch {
    try {
      const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      state.localStream = audioStream;
      return audioStream;
    } catch {
      return null;
    }
  }
}

function startPatientSnapshotFallback() {
  if (state.snapshotInterval) clearInterval(state.snapshotInterval);
  const canvas = document.createElement('canvas');
  canvas.width = 360;
  canvas.height = 270;
  const ctx = canvas.getContext('2d');

  state.snapshotInterval = setInterval(() => {
    const vid = el('ptLocalVideo');
    if (!vid || !state.localStream || vid.readyState < 2) return;
    try {
      ctx.drawImage(vid, 0, 0, canvas.width, canvas.height);
      const imageDataUrl = canvas.toDataURL('image/jpeg', 0.45);
      sendCommandToRoom('camera_snapshot', '', { imageDataUrl });
    } catch {}
  }, 1400);
}

async function autoAnswerAndStreamPatientCamera(facingMode = 'user', caregiverPeerId = null) {
  const stream = await getOrStartPatientMedia(facingMode);
  if (stream && state.peer && caregiverPeerId) {
    const call = state.peer.call(caregiverPeerId, stream);
    state.activeCall = call;
    call?.on('stream', (remoteStream) => {
      const remoteVid = el('ptRemoteVideo');
      if (remoteVid) {
        remoteVid.srcObject = remoteStream;
        remoteVid.play().catch(() => {});
      }
    });
  }
}

function stopPatientCameraStream() {
  if (state.snapshotInterval) {
    clearInterval(state.snapshotInterval);
    state.snapshotInterval = null;
  }
  if (state.localStream) {
    state.localStream.getTracks().forEach((t) => t.stop());
    state.localStream = null;
  }
  if (state.activeCall) {
    state.activeCall.close();
    state.activeCall = null;
  }
  el('ptVideoContainer')?.classList.add('hidden');
}

async function startCaregiverRemoteIntercom() {
  getAudioContext();
  const target = getFocusedMember();
  const targetId = target ? target.id : 'all';

  const badge = el('cgStreamBadge');
  if (badge) {
    badge.textContent = `Conectando con ${target?.name || 'Familiar'}...`;
    badge.className = 'text-xs px-2.5 py-1 rounded-full bg-amber-500 text-slate-950 font-bold animate-pulse';
  }

  try {
    state.localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: { width: 320, height: 240 }
    });
    const localVid = el('cgLocalVideo');
    if (localVid) {
      localVid.srcObject = state.localStream;
      localVid.classList.remove('hidden');
    }
  } catch {
    try {
      state.localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {}
  }

  await sendCommandToRoom(
    'start_intercom',
    `📹 ${state.memberName} conectó la cámara y altavoz de ${target?.name || 'la familia'}.`,
    {
      facingMode: state.cameraFacingMode,
      caregiverPeerId: state.peerId
    },
    targetId
  );

  if (state.peer && target?.peerId && state.localStream) {
    const call = state.peer.call(target.peerId, state.localStream);
    state.activeCall = call;
    call?.on('stream', (remoteStream) => {
      attachCaregiverRemoteStream(remoteStream);
    });
  }

  el('btnToggleMyMic')?.classList.remove('hidden');
  el('btnRemoteCameraStop')?.classList.remove('hidden');
}

function attachCaregiverRemoteStream(remoteStream) {
  const remoteVid = el('cgRemoteVideo');
  const snapImg = el('cgSnapshotFallback');
  const placeholder = el('cgVideoPlaceholder');
  const badge = el('cgStreamBadge');

  if (remoteVid) {
    remoteVid.srcObject = remoteStream;
    remoteVid.classList.remove('hidden');
    remoteVid.play().catch(() => {});
  }
  snapImg?.classList.add('hidden');
  placeholder?.classList.add('hidden');

  if (badge) {
    badge.textContent = '🔴 En Vivo (Video + Voz Activos)';
    badge.className = 'text-xs px-2.5 py-1 rounded-full bg-emerald-600 text-white font-bold animate-pulse';
  }
}

function stopCaregiverRemoteIntercom() {
  const target = getFocusedMember();
  sendCommandToRoom('stop_intercom', `⏹️ ${state.memberName} desconectó la cámara remota.`, {}, target?.id || 'all');
  if (state.activeCall) {
    state.activeCall.close();
    state.activeCall = null;
  }
  if (state.localStream) {
    state.localStream.getTracks().forEach((t) => t.stop());
    state.localStream = null;
  }
  el('cgRemoteVideo')?.classList.add('hidden');
  el('cgSnapshotFallback')?.classList.add('hidden');
  el('cgLocalVideo')?.classList.add('hidden');
  el('cgVideoPlaceholder')?.classList.remove('hidden');
  el('btnToggleMyMic')?.classList.add('hidden');
  el('btnRemoteCameraStop')?.classList.add('hidden');

  const badge = el('cgStreamBadge');
  if (badge) {
    badge.textContent = 'Desconectado';
    badge.className = 'text-xs px-2.5 py-1 rounded-full bg-slate-800 text-slate-400 font-semibold';
  }
}

// ============================================================================
// 10. INICIO Y EVENTOS DE INTERFAZ
// ============================================================================
function startRoleSession(role) {
  getAudioContext();
  const codeInput = el('inputFamilyCode')?.value.trim().toUpperCase() || 'MAMA-2026';
  const defaultName = role === 'patient' ? 'Mamá' : 'Ariel';
  const nameInput = el('inputMemberName')?.value.trim() || defaultName;

  state.familyCode = codeInput;
  state.memberName = nameInput;
  state.role = role;

  localStorage.setItem('cf_code', state.familyCode);
  localStorage.setItem('cf_name', state.memberName);
  localStorage.setItem('cf_avatar', state.avatar);
  localStorage.setItem('cf_role', state.role);

  el('setupScreen')?.classList.add('hidden');
  el('btnSwitchMode')?.classList.remove('hidden');

  const badge = el('headerRoleBadge');
  if (badge) {
    badge.classList.remove('hidden');
    badge.textContent = `${state.avatar} ${state.memberName}`;
  }

  requestScreenWakeLock();
  startGpsTracking();
  startMotionAndFallDetection();
  startBatteryMonitor();
  connectRoomSync();
  initPeerJS();

  // Keep-Alive agresivo y polling de comandos para que nunca se desconecte en segundo plano
  if (state.keepAliveTimer) clearInterval(state.keepAliveTimer);
  state.keepAliveTimer = setInterval(() => {
    sendTelemetryUpdate();
    pollServerState();
  }, 10000);

  if (role === 'patient') {
    el('patientScreen')?.classList.remove('hidden');
    el('caregiverScreen')?.classList.add('hidden');
    const codeLbl = el('ptCodeLabel');
    if (codeLbl) codeLbl.textContent = state.familyCode;
    navigator.mediaDevices
      ?.getUserMedia({ video: true, audio: true })
      .then((s) => s.getTracks().forEach((t) => t.stop()))
      .catch(() => {});
  } else {
    el('caregiverScreen')?.classList.remove('hidden');
    el('patientScreen')?.classList.add('hidden');
    setTimeout(() => {
      initCaregiverMap();
      updateMapAndDashboard();
    }, 150);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  if (el('inputFamilyCode')) el('inputFamilyCode').value = state.familyCode;
  if (el('inputMemberName')) el('inputMemberName').value = state.memberName;

  // Selector de Avatar en la pantalla inicial
  document.querySelectorAll('#avatarPicker .avatar-option').forEach((btn) => {
    if (btn.getAttribute('data-avatar') === state.avatar) {
      document.querySelectorAll('#avatarPicker .avatar-option').forEach((b) => b.classList.remove('selected'));
      btn.classList.add('selected');
    }
    btn.addEventListener('click', () => {
      document.querySelectorAll('#avatarPicker .avatar-option').forEach((b) => b.classList.remove('selected'));
      btn.classList.add('selected');
      state.avatar = btn.getAttribute('data-avatar') || '👵';
      const nameInput = el('inputMemberName');
      if (nameInput && !nameInput.value.trim()) {
        nameInput.value = btn.getAttribute('data-default-name') || '';
      }
    });
  });

  el('btnStartPatient')?.addEventListener('click', () => startRoleSession('patient'));
  el('btnStartCaregiver')?.addEventListener('click', () => startRoleSession('caregiver'));

  el('btnSwitchMode')?.addEventListener('click', () => {
    stopEmergencySiren();
    stopCaregiverRemoteIntercom();
    stopPatientCameraStream();
    el('patientScreen')?.classList.add('hidden');
    el('caregiverScreen')?.classList.add('hidden');
    el('setupScreen')?.classList.remove('hidden');
  });

  el('btnRemoveSelectedMember')?.addEventListener('click', () => {
    if (state.selectedMemberId && state.selectedMemberId !== 'all') {
      const targetId = state.selectedMemberId;
      state.selectedMemberId = 'all';
      sendCommandToRoom('remove_member', 'Perfil eliminado de la sala.', {}, targetId);
    }
  });

  // Botones del celular de Mamá
  el('btnPatientSOS')?.addEventListener('click', () => {
    sendEmergencyAlert('sos', `🚨 ¡${state.memberName} presionó el botón NECESITO AYUDA (SOS)!`);
    speakTextOutLoud('Enviando alerta urgente a tu familia y activando micrófono y cámara.');
    autoAnswerAndStreamPatientCamera('user');
  });

  el('btnPatientOk')?.addEventListener('click', () => {
    cancelFallCountdown();
    playGentleConnectTone();
    sendCommandToRoom('status_ok', `✅ ${state.memberName} presionó el botón: "ESTOY BIEN".`);
    speakTextOutLoud('Tu familia recibió el aviso de que estás bien.');
  });

  el('btnCancelFallAlert')?.addEventListener('click', () => cancelFallCountdown());

  // Botones del Mapa y Panel Cuidador
  el('btnCenterSelected')?.addEventListener('click', () => {
    const focused = getFocusedMember();
    if (focused && focused.lat != null && map) {
      map.setView([focused.lat, focused.lng], 17);
    }
  });

  el('btnFitAllFamily')?.addEventListener('click', () => {
    state.selectedMemberId = 'all';
    updateMapAndDashboard();
    fitAllMembersOnMap();
  });

  el('btnSetSafeZone')?.addEventListener('click', () => {
    const focused = getFocusedMember();
    if (!focused || focused.lat == null) return;
    const radiusMeters = Number(el('selectSafeZoneRadius')?.value || 250);
    const safeZone = { lat: focused.lat, lng: focused.lng, radiusMeters };
    state.safeZones[focused.id] = safeZone;
    sendCommandToRoom('set_safe_zone', `🛡️ Zona segura fijada para ${focused.name} (${radiusMeters}m).`, {
      memberId: focused.id,
      safeZone
    });
    updateMapAndDashboard();
  });

  el('btnClearRoute')?.addEventListener('click', () => {
    sendCommandToRoom('clear_route', 'Historial de ruta reiniciado.', {}, state.selectedMemberId);
  });

  el('btnRemoteCameraStart')?.addEventListener('click', () => startCaregiverRemoteIntercom());
  el('btnRemoteCameraStop')?.addEventListener('click', () => stopCaregiverRemoteIntercom());

  el('btnRemoteSwitchCam')?.addEventListener('click', () => {
    const focused = getFocusedMember();
    state.cameraFacingMode = state.cameraFacingMode === 'user' ? 'environment' : 'user';
    sendCommandToRoom(
      'switch_camera',
      `🔄 Cambiando cámara de ${focused?.name || 'familiar'}...`,
      { caregiverPeerId: state.peerId },
      focused?.id || 'all'
    );
  });

  el('btnRemoteSoundAlert')?.addEventListener('click', () => {
    const focused = getFocusedMember();
    sendCommandToRoom(
      'ring',
      `🔔 ${state.memberName} hizo sonar el timbre en el celular de ${focused?.name || 'la familia'}.`,
      {},
      focused?.id || 'all'
    );
  });

  el('btnToggleMyMic')?.addEventListener('click', () => {
    if (!state.localStream) return;
    state.micMuted = !state.micMuted;
    state.localStream.getAudioTracks().forEach((t) => {
      t.enabled = !state.micMuted;
    });
    const btn = el('btnToggleMyMic');
    if (btn) {
      btn.textContent = state.micMuted ? '🔇 Micrófono Silenciado' : '🎙️ Micrófono Activo (Hablando)';
    }
  });

  // Voz Hablada Remota (TTS) dirigida al perfil seleccionado
  document.querySelectorAll('.tts-quick-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const phrase = btn.getAttribute('data-tts');
      const focused = getFocusedMember();
      if (phrase) {
        sendCommandToRoom('tts', phrase, {}, focused?.id || 'all');
      }
    });
  });

  el('btnSendCustomTts')?.addEventListener('click', () => {
    const input = el('inputCustomTts');
    const text = input?.value.trim();
    const focused = getFocusedMember();
    if (text) {
      sendCommandToRoom('tts', text, {}, focused?.id || 'all');
      input.value = '';
    }
  });

  el('inputCustomTts')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') el('btnSendCustomTts')?.click();
  });

  el('btnDismissAlert')?.addEventListener('click', () => {
    stopEmergencySiren();
    el('criticalAlertBanner')?.classList.add('hidden');
  });

  el('btnAlertConnectCam')?.addEventListener('click', () => {
    stopEmergencySiren();
    el('criticalAlertBanner')?.classList.add('hidden');
    startCaregiverRemoteIntercom();
  });

  // Modal Online / APK
  const openModal = async () => {
    el('apkModal')?.classList.remove('hidden');
    const box = el('serverUrlList');
    if (box) {
      box.innerHTML = `🌐 Enlace Online (4G/5G/Wi-Fi): <strong>https://ciudado.onrender.com</strong><br/>📍 Servidor actual: ${window.location.origin}`;
    }
  };
  el('btnOpenApkModal')?.addEventListener('click', openModal);
  el('btnCloseApkModal')?.addEventListener('click', () => el('apkModal')?.classList.add('hidden'));
  el('btnCloseApkModalBottom')?.addEventListener('click', () => el('apkModal')?.classList.add('hidden'));

  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    const btn = el('btnInstallPwa');
    if (btn) {
      btn.classList.remove('hidden');
      btn.addEventListener('click', async () => {
        if (!deferredPrompt) return;
        deferredPrompt.prompt();
        await deferredPrompt.userChoice;
        deferredPrompt = null;
        btn.classList.add('hidden');
      });
    }
  });
});
