import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TextureLoader } from 'three';
import { createWorld } from './physics.js';
import { createTrack } from './track.js';
import { createCar, createCarVisual } from './car.js';
import { InputController } from './controls.js';
import { createLapSystem } from './lapSystem.js';
import { createCameraController } from './cameraController.js';
import { WebsimSocket } from 'websim-socket';
import { PARTYKIT_HOST } from './env.js';

const app = document.getElementById('app');

// -----------------------------------------------------------------------------
// Utility helpers
// -----------------------------------------------------------------------------
function makeQuaternionFromForward(forwardVec) {
  const forward = new THREE.Vector3(
    forwardVec.x,
    forwardVec.y,
    forwardVec.z
  ).normalize();
  const up = new THREE.Vector3(0, 1, 0);
  const side = new THREE.Vector3().crossVectors(up, forward).normalize();

  const m = new THREE.Matrix4();
  m.makeBasis(side, up, forward); // X=side, Y=up, Z=forward

  const q = new THREE.Quaternion();
  q.setFromRotationMatrix(m);
  return q;
}

function computeRenderBufferSize(w, h, maxDim = 1024) {
  const max = Math.max(w, h);
  const scale = max > maxDim ? maxDim / max : 1;
  return {
    rw: w * scale,
    rh: h * scale
  };
}

function createGradientSkyTexture(
  renderer,
  topColor = new THREE.Color(0x7fd5ff),
  bottomColor = new THREE.Color(0x021527)
) {
  const size = 512;
  const renderTarget = new THREE.WebGLRenderTarget(size, size, {
    depthBuffer: false,
    stencilBuffer: false
  });

  const sceneBG = new THREE.Scene();
  const cameraBG = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const material = new THREE.ShaderMaterial({
    uniforms: {
      topColor: { value: topColor.clone() },
      bottomColor: { value: bottomColor.clone() },
      offset: { value: 0.0 },
      exponent: { value: 1.2 }
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 topColor;
      uniform vec3 bottomColor;
      uniform float offset;
      uniform float exponent;
      varying vec2 vUv;
      void main() {
        float h = clamp(offset + vUv.y, 0.0, 1.0);
        h = pow(h, exponent);
        vec3 color = mix(bottomColor, topColor, h);
        gl_FragColor = vec4(color, 1.0);
      }
    `,
    depthWrite: false,
    depthTest: false
  });

  const geometry = new THREE.PlaneGeometry(2, 2);
  const quad = new THREE.Mesh(geometry, material);
  sceneBG.add(quad);

  const prevAutoClear = renderer.autoClear;
  const prevTarget = renderer.getRenderTarget();
  const prevClearColor = new THREE.Color();
  const prevClearAlpha = renderer.getClearAlpha();
  renderer.getClearColor(prevClearColor);

  renderer.autoClear = true;
  renderer.setRenderTarget(renderTarget);
  renderer.setClearColor(0x000000, 1.0);
  renderer.clear();
  renderer.render(sceneBG, cameraBG);

  renderer.setRenderTarget(prevTarget);
  renderer.setClearColor(prevClearColor, prevClearAlpha);
  renderer.autoClear = prevAutoClear;

  geometry.dispose();
  material.dispose();

  const texture = renderTarget.texture;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

function formatTime(ms) {
  const totalSeconds = ms / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const centis = Math.floor((ms % 1000) / 10); // two decimal digits

  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  const cc = String(centis).padStart(2, '0');
  return `${mm}:${ss}.${cc}`;
}

function randomHexChannel() {
  const v = Math.floor(Math.random() * 256);
  return v.toString(16).padStart(2, '0');
}

function randomBodyColor() {
  // Bright-ish, saturated body color
  const r = 80 + Math.floor(Math.random() * 160);
  const g = 80 + Math.floor(Math.random() * 160);
  const b = 80 + Math.floor(Math.random() * 160);
  return `#${r.toString(16).padStart(2, '0')}${g
    .toString(16)
    .padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

function randomGlassColor() {
  // Darker glass / window color
  const base = 8 + Math.floor(Math.random() * 56); // 0x08 - 0x40
  const hex = base.toString(16).padStart(2, '0');
  return `#${hex}${hex}${hex}`;
}

// -----------------------------------------------------------------------------
// Renderer + scene setup
// -----------------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(1);

// Initial buffer size capped at 1024
{
  const w = window.innerWidth;
  const h = window.innerHeight;
  const { rw, rh } = computeRenderBufferSize(w, h, 1024);
  renderer.setSize(rw, rh, false);
  renderer.domElement.style.width = `${w}px`;
  renderer.domElement.style.height = `${h}px`;
}

// Modern color management: ensure proper sRGB output
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ReinhardToneMapping;
renderer.toneMappingExposure = 1.6;

app.appendChild(renderer.domElement);

const scene = new THREE.Scene();

 // ---------------------------------------------------------------------------
 // Multiplayer state
 // -----------------------------------------------------------------------------
 let gameFrozen = false;
 let room = null;
 let roomReady = false;
 let clientId = null;
 const ghostCars = new Map();

let currentHostId = null;
let isHost = false;
let currentRound = null;
let currentRoundId = null;

let localBodyColor = randomBodyColor();
let localGlassColor = randomGlassColor();

 // Bot car is now a purely visual "fake" car with no physics or collisions.
 // The host (or offline game) animates it along the track center, and other
 // clients just render its replicated transform.
let botVisual = null;
let botPathParam = 0;
let botLateralPhase = 0;
let botGhost = null;
let botGhostTarget = null;
let botGhostLastUpdate = 0;
// Previous frame position for computing actual movement direction
let botPrevPos = null;



const HEARTBEAT_INTERVAL_MS = 1000;
const HEARTBEAT_TIMEOUT_MS = 5000;
const ROUND_DURATION_MS = 180000;
const ROUND_PRE_MS = 5000;
const ROUND_END_MS = 5000;

// -----------------------------------------------------------------------------
// Sky + environment
// -----------------------------------------------------------------------------
let skyTopColor = new THREE.Color(0x7fd5ff);
let skyBottomColor = new THREE.Color(0x021527);
let skyTexture = createGradientSkyTexture(renderer, skyTopColor, skyBottomColor);
scene.background = skyTexture;

// Camera
const baseFov = 60;
const maxFov = 80;
const camera = new THREE.PerspectiveCamera(
  baseFov,
  window.innerWidth / window.innerHeight,
  0.1,
  500
);
camera.position.set(0, 6, -10);
scene.add(camera);

// Physics world
const world = createWorld();

// Lighting
const hemiLight = new THREE.HemisphereLight(0xf0f0ff, 0x202020, 1.4);
scene.add(hemiLight);

const ambient = new THREE.AmbientLight(0x5fa8ff, 1.1);
scene.add(ambient);

const dirLight = new THREE.DirectionalLight(0xfff5e0, 2.0);
dirLight.position.set(20, 30, -15);
dirLight.castShadow = true;
dirLight.shadow.mapSize.set(2048, 2048);
dirLight.shadow.camera.near = 1;
dirLight.shadow.camera.far = 120;
dirLight.shadow.camera.left = -60;
dirLight.shadow.camera.right = 60;
dirLight.shadow.camera.top = 60;
dirLight.shadow.camera.bottom = -60;
scene.add(dirLight);

// Track + car
let track = null;
let checkpoints = [];
let trackWidth = 10;
let startPosition = new THREE.Vector3(0, 1, 0);
let startDirection = new THREE.Vector3(0, 0, 1);
let pathPoints = [];

// initial placeholder track; will be replaced once round sync arrives
track = createTrack(scene, world, Math.floor(Math.random() * 1e9));
({ startPosition, startDirection, checkpoints, trackWidth, pathPoints } = track);

const car = createCar(scene, world, startPosition, startDirection, null);
car.setColors(localBodyColor, localGlassColor);

// -----------------------------------------------------------------------------
// Environment map (spacecraft panorama)
// -----------------------------------------------------------------------------
const pmremGenerator = new THREE.PMREMGenerator(renderer);
pmremGenerator.compileEquirectangularShader();

new TextureLoader().load(
  '/a-panorama-of-a-space-craft-factory.jpg',
  (tex) => {
    tex.mapping = THREE.EquirectangularReflectionMapping;
    const envRT = pmremGenerator.fromEquirectangular(tex);
    const envMap = envRT.texture;

    scene.environment = envMap;

    if (car && typeof car.setEnvMap === 'function') {
      car.setEnvMap(envMap);
    }

    tex.dispose();
    pmremGenerator.dispose();

    scene.traverse((obj) => {
      if (!obj.isMesh || !obj.material) return;
      const materials = Array.isArray(obj.material) ? obj.material : [obj.material];

      materials.forEach((mat) => {
        if (!mat || (!mat.isMeshStandardMaterial && !mat.isMeshPhysicalMaterial)) return;
        mat.envMap = envMap;
        if ('envMapIntensity' in mat) {
          if (mat.color && mat.color.getHSL({}).l > 0.5) {
            mat.envMapIntensity = 1.0;
          } else {
            mat.envMapIntensity = 1.4;
          }
        }
        mat.needsUpdate = true;
      });
    });
  }
);

 // ---------------------------------------------------------------------------
 // Lap / checkpoint state has been moved into lapSystem.js
 // removed inline lap/checkpoint logic in main.js
 let lastInputState = { forward: 0, steer: 0, brake: false };

 const lapSystem = createLapSystem(
   scene,
   car,
   checkpoints,
   trackWidth,
   makeQuaternionFromForward,
   formatTime
 );

 // -----------------------------------------------------------------------------
 // Controls / debug
 // -----------------------------------------------------------------------------
 const controls = new OrbitControls(camera, renderer.domElement);
 controls.enabled = false;

 const input = new InputController(document.getElementById('joystick-zone'));

 // removed tmpVec3 helper - now lives inside lapSystem.js
 const cameraController = createCameraController(camera, car, baseFov, maxFov);

 let debugEnabled = false;
 const applyDebug = () => {
   const enabled = debugEnabled;
   if (track && typeof track.setDebugVisible === 'function') {
     track.setDebugVisible(enabled, enabled);
   }
   car.setDebugVisible({
     chassisWire: enabled,
     wheelWire: enabled,
     axes: enabled
   });
 };

 window.addEventListener('keydown', (e) => {
   if (e.code === 'F8') {
     debugEnabled = !debugEnabled;
     applyDebug();
   }
 });

 // initialise with debug off
 applyDebug();

 // -----------------------------------------------------------------------------
 // Round UI
 // -----------------------------------------------------------------------------
 let lastTime = performance.now();

 const roundStatusEl = document.getElementById('countdown-overlay');

 // Ranking UI
 const rankingEl = document.getElementById('ranking');
 const currentRankEl = document.getElementById('current-rank');

 // Color picker UI
 const bodyColorInput = document.getElementById('body-color');
 const glassColorInput = document.getElementById('glass-color');

 // Multiplayer UI
 const mpModal = document.getElementById('mp-modal');
 const mpJoinBtn = document.getElementById('mp-join-btn');
 const mpJoinConfirmBtn = document.getElementById('mp-join-confirm');
 const mpJoinSkipBtn = document.getElementById('mp-join-skip');

 function hideMultiplayerModal() {
   if (mpModal) {
     mpModal.style.display = 'none';
   }
 }

 function showMultiplayerModal() {
   if (mpModal) {
     mpModal.style.display = 'flex';
   }
 }

function toOrdinal(n) {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

function updateRanking(presence) {
  if (!roomReady || !room) return;

  const entriesAll = [];
  for (const id in presence) {
    if (!Object.prototype.hasOwnProperty.call(presence, id)) continue;
    const p = presence[id];
    if (!p || !p.car) continue;
    const bestLapRaw = p.car.bestLapMs;
    const bestLap = (typeof bestLapRaw === 'number' && Number.isFinite(bestLapRaw))
      ? bestLapRaw
      : Infinity;

    const peer = room.peers[id];
    const name = peer && peer.username ? peer.username : 'Player';
    entriesAll.push({ id, name, bestLap });
  }

  const entriesWithTime = entriesAll.filter((e) => Number.isFinite(e.bestLap));
  entriesWithTime.sort((a, b) => a.bestLap - b.bestLap);

  // Update list on the bottom-right (only players with times)
  if (rankingEl) {
    if (entriesWithTime.length === 0) {
      rankingEl.textContent = 'No record';
    } else {
      const lines = entriesWithTime.slice(0, 5).map((e, idx) => {
        const timeStr = formatTime(e.bestLap);
        return `${idx + 1}. ${e.name}: ${timeStr}`;
      });
      rankingEl.textContent = lines.join('\n');
    }
  }

  // Update big current rank on the top-left, including players without lap records
  if (currentRankEl && clientId && entriesAll.length > 0) {
    if (entriesWithTime.length === 0) {
      currentRankEl.textContent = 'No record';
    } else {
      const rankedAll = [...entriesAll].sort((a, b) => a.bestLap - b.bestLap);
      const myIndex = rankedAll.findIndex((e) => e.id === clientId);
      if (myIndex === -1) {
        currentRankEl.textContent = 'No record';
      } else {
        const pos = myIndex + 1;
        currentRankEl.textContent = toOrdinal(pos);
      }
    }
  }
}

// removed inline checkpoint indicator & timing logic - now handled by lapSystem.update()

// removed function updateCamera() {} – camera follow is now in cameraController.js

function updateRoundUI(nowMs) {
  if (!roomReady || !currentRound || !roundStatusEl) return;

  const startTime = currentRound.startTime || 0;
  const durationMs = currentRound.durationMs || ROUND_DURATION_MS;
  const preCountdownMs = currentRound.preCountdownMs || ROUND_PRE_MS;
  const endCountdownMs = currentRound.endCountdownMs || ROUND_END_MS;

  const roundEnd = startTime + durationMs;
  const finalEnd = roundEnd + endCountdownMs;

  if (nowMs < startTime) {
    const remaining = Math.max(0, Math.ceil((startTime - nowMs) / 1000));
    roundStatusEl.textContent = `Round starts in ${remaining}s`;
  } else if (nowMs >= startTime && nowMs < roundEnd) {
    const remaining = Math.max(0, Math.ceil((roundEnd - nowMs) / 1000));
    roundStatusEl.textContent = `Time left: ${remaining}s`;
  } else if (nowMs >= roundEnd && nowMs < finalEnd) {
    const remaining = Math.max(0, Math.ceil((finalEnd - nowMs) / 1000));
    roundStatusEl.textContent = `Round ending in ${remaining}s`;
  } else {
    roundStatusEl.textContent = '';
  }
}

function isDrivingEnabled(nowMs) {
  // If the race online modal is visible, lock the car position / disable controls
  if (mpModal && mpModal.style.display !== 'none') {
    return false;
  }

  // Offline / no room: always allow driving (except when modal is shown)
  if (!roomReady || !currentRound) return true;

  const startTime = currentRound.startTime || 0;
  // Lock controls and position until the round start time
  if (nowMs < startTime) return false;

  return true;
}

 // Visual-only "fake" bot that follows the track center line smoothly.
function updateFakeBot(dt) {
  // Only the online host drives the visual bot; offline sessions have no bot.
  if (!roomReady || !isHost) return;
  if (!pathPoints || pathPoints.length === 0) return;

  // Ensure visual bot exists for the local driver (host or offline)
  if (!botVisual) {
    const visual = createCarVisual(scene, scene.environment || null);
    botVisual = visual.group;
    botVisual.userData.visual = visual;
    // Slightly transparent so it reads like an AI/ghost
    botVisual.traverse((obj) => {
      if (obj.isMesh && obj.material) {
        obj.material.transparent = true;
        obj.material.opacity = 0.75;
      }
    });
    // Start at the first path point
    botPathParam = 0;
    const p0 = pathPoints[0];
    const p1 = pathPoints[1] || p0;
    const forward = new THREE.Vector3().subVectors(p1, p0).setY(0).normalize();
    const q0 = makeQuaternionFromForward(forward);

    // Place bot slightly above the track so wheels don't intersect
    botVisual.position.set(p0.x, p0.y + 0.5, p0.z);
    botVisual.quaternion.copy(q0);
  }

  const n = pathPoints.length;
  if (n < 2) return;

  // Indices along the path for current segment and a lookahead segment
  const i0 = Math.floor(botPathParam) % n;
  const i1 = (i0 + 1) % n;
  const i2 = (i1 + 1) % n;

  const cp0 = pathPoints[i0];
  const cp1 = pathPoints[i1];
  const cp2 = pathPoints[i2];

  // Forward vectors for current and next segments (in XZ plane)
  const forwardNow = new THREE.Vector3().subVectors(cp1, cp0).setY(0);
  const forwardNext = new THREE.Vector3().subVectors(cp2, cp1).setY(0);

  if (forwardNow.lengthSq() < 1e-4) forwardNow.set(0, 0, 1);
  if (forwardNext.lengthSq() < 1e-4) forwardNext.copy(forwardNow);

  forwardNow.normalize();
  forwardNext.normalize();

  // Turn factor based on angle between current and next segment
  let turnFactor = 0;
  const dot = THREE.MathUtils.clamp(forwardNow.dot(forwardNext), -1, 1);
  const angle = Math.acos(dot); // 0 = straight, pi = hairpin
  turnFactor = angle / Math.PI; // 0..1

  // Higher base speed, with extra speed when turning a lot
  const baseSpeed = 2.4;
  const turnSpeedBoost = 1.4;
  const speedNoiseScale = 0.3;

  const botSpeed =
    baseSpeed +
    turnFactor * turnSpeedBoost +
    Math.sin(botLateralPhase * 0.5) * speedNoiseScale * turnFactor;

  botPathParam = (botPathParam + botSpeed * dt) % n;

  const t = botPathParam - Math.floor(botPathParam);
  const pos = new THREE.Vector3().lerpVectors(cp0, cp1, t);

  // Side vector for lateral wandering
  const up = new THREE.Vector3(0, 1, 0);
  const side = new THREE.Vector3().crossVectors(up, forwardNow).normalize();

  // Lateral noise: very small on straights, stronger in corners
  const width = trackWidth || 10;
  const lateralBase = width * 0.05;     // minimal wandering when going straight
  const lateralTurn = width * 0.20;     // extra wandering in corners
  const lateralAmplitude = lateralBase + lateralTurn * turnFactor;
  const lateralFrequency = 0.4;

  botLateralPhase += dt * lateralFrequency;
  const lateralOffset = Math.sin(botLateralPhase) * lateralAmplitude;

  pos.addScaledVector(side, lateralOffset);

  // Lift the bot slightly above the track so wheels don't intersect
  pos.y += 0.5;

  // Use a blended track tangent for orientation so it follows the curve smoothly
  const forwardBlend = new THREE.Vector3()
    .copy(forwardNow)
    .lerp(forwardNext, 0.5)
    .setY(0);

  if (forwardBlend.lengthSq() < 1e-4) {
    forwardBlend.copy(forwardNow);
  }
  forwardBlend.normalize();

  const targetQuat = makeQuaternionFromForward(forwardBlend);

  // Smooth orientation changes (smaller factor to avoid visible flips)
  botVisual.position.copy(pos);
  botVisual.quaternion.slerp(targetQuat, 0.06);
}

// -----------------------------------------------------------------------------
// Multiplayer helpers
// -----------------------------------------------------------------------------
function createGhostCar(bodyColor, glassColor) {
  const visual = createCarVisual(scene, scene.environment || null);
  const group = visual.group;

  // Slightly reduce opacity so remote cars read as "ghosts"
  const meshes = [];
  group.traverse((obj) => {
    if (obj.isMesh && obj.material) {
      meshes.push(obj);
    }
  });
  meshes.forEach((m) => {
    if ('transparent' in m.material) {
      m.material.transparent = true;
      m.material.opacity = 0.7;
    }
  });

  // Apply initial colors if provided
  if (visual.setColors) {
    visual.setColors(bodyColor || '#1f7aff', glassColor || '#181818');
  }

  group.userData.visual = visual;
  return group;
}

function handlePresence(presence) {
  if (!roomReady || !room) return;

  const activeIds = new Set();
  const now = Date.now();

  for (const id in presence) {
    if (!Object.prototype.hasOwnProperty.call(presence, id)) continue;
    if (id === clientId) continue;

    const p = presence[id];
    if (!p || !p.car) continue;

    const hb = typeof p.heartbeat === 'number' ? p.heartbeat : 0;
    // Skip unhealthy clients (treat as disconnected for ghost rendering)
    if (now - hb >= HEARTBEAT_TIMEOUT_MS) continue;

    activeIds.add(id);

    let ghost = ghostCars.get(id);
    if (!ghost) {
      ghost = createGhostCar(p.car.colorBody, p.car.colorGlass);
      scene.add(ghost);
      ghostCars.set(id, ghost);
    }

    // Lift ghost cars slightly so their wheels don't clip into the track
    ghost.position.set(p.car.x, p.car.y + 0.2, p.car.z);
    ghost.quaternion.set(p.car.qx, p.car.qy, p.car.qz, p.car.qw);

    const bodyColor = p.car.colorBody;
    const glassColor = p.car.colorGlass;
    const visual = ghost.userData.visual;
    if (visual && visual.setColors) {
      visual.setColors(bodyColor, glassColor);
    }
  }

  for (const [id, ghost] of ghostCars.entries()) {
    if (!activeIds.has(id)) {
      scene.remove(ghost);
      ghostCars.delete(id);
    }
  }

  updateRanking(presence);
}

function applyRoundState(round) {
  if (!round || !round.roundId) return;
  if (currentRoundId === round.roundId) {
    currentRound = round;
    return;
  }

  currentRound = round;
  currentRoundId = round.roundId;

  if (track && typeof track.dispose === 'function') {
    track.dispose();
  }
  const seed =
    typeof round.seed === 'number'
      ? round.seed
      : Math.floor(Math.random() * 1e9);
  track = createTrack(scene, world, seed);
  ({ startPosition, startDirection, checkpoints, trackWidth, pathPoints } = track);

  // ensure debug visibility matches current debug toggle
  track.setDebugVisible(debugEnabled, debugEnabled);

  // notify lap system that the track and checkpoints have changed
  lapSystem.handleTrackChange(checkpoints, trackWidth, performance.now());

  // Reset bot path parameter for the new track center line
  botPathParam = 0;

  if (car && typeof car.setRespawn === 'function') {
    car.setRespawn(startPosition, startDirection);
  }

  // Reposition visual bot (if it already exists) onto the new track
  if (botVisual && pathPoints && pathPoints.length > 0) {
    const p0 = pathPoints[0];
    const p1 = pathPoints[1] || p0;
    botVisual.position.set(p0.x, p0.y + 0.5, p0.z);
    const forward = new THREE.Vector3().subVectors(p1, p0).setY(0).normalize();
    const q0 = makeQuaternionFromForward(forward);
    botVisual.quaternion.copy(q0);
    // Reset previous position so motion direction is correct on new track
    botPrevPos = botVisual.position.clone();
  }

  if (round.topColor && round.bottomColor) {
    skyTopColor = new THREE.Color(round.topColor);
    skyBottomColor = new THREE.Color(round.bottomColor);
    skyTexture = createGradientSkyTexture(renderer, skyTopColor, skyBottomColor);
    scene.background = skyTexture;
  }
}

function ensureBotCar() {
  // Deprecated: physics-based bot removed. Kept only to avoid runtime errors
  // if referenced somewhere unexpectedly.
}

function electHostAndManageRounds() {
  if (!roomReady || !room) return;
  const now = Date.now();

  const healthyIds = [];
  const presence = room.presence || {};
  for (const id in presence) {
    if (!Object.prototype.hasOwnProperty.call(presence, id)) continue;
    const p = presence[id];
    const hb = p && typeof p.heartbeat === 'number' ? p.heartbeat : 0;
    if (now - hb < HEARTBEAT_TIMEOUT_MS) {
      healthyIds.push(id);
    }
  }

  if (!healthyIds.includes(clientId)) {
    healthyIds.push(clientId);
  }

  healthyIds.sort();
  const newHostId = healthyIds.length > 0 ? healthyIds[0] : null;

  const previousIsHost = isHost;

  if (newHostId !== currentHostId) {
    currentHostId = newHostId;
    isHost = currentHostId === clientId;

    // If we just lost host status, remove our locally driven visual bot;
    // from now on we only render the replicated botGhost.
    if (previousIsHost && !isHost && botVisual) {
      scene.remove(botVisual);
      botVisual = null;
    }
  }

  // Host handles round creation; bot movement/replication happens in the main loop.

  if (!isHost) return;

  const state = room.roomState || {};
  const existingRound = state.round;

  const nowMs = now;
  let needNewRound = false;

  if (!existingRound || !existingRound.roundId || !existingRound.startTime) {
    needNewRound = true;
  } else {
    const startTime = existingRound.startTime;
    const roundEnd = startTime + ROUND_DURATION_MS;
    const finalEnd = roundEnd + ROUND_END_MS;
    if (nowMs > finalEnd + 1000) {
      needNewRound = true;
    }
  }

  if (!needNewRound) return;

  const roundId =
    existingRound && existingRound.roundId ? existingRound.roundId + 1 : 1;

  const seed = Math.floor(Math.random() * 1e9);

  const top = new THREE.Color().setHSL(
    Math.random(),
    0.5 + Math.random() * 0.4,
    0.5 + Math.random() * 0.3
  );
  const bottom = new THREE.Color().setHSL(
    Math.random(),
    0.4 + Math.random() * 0.3,
    0.25 + Math.random() * 0.25
  );

  const startTime = nowMs + ROUND_PRE_MS;

  const newRound = {
    roundId,
    seed,
    startTime,
    durationMs: ROUND_DURATION_MS,
    preCountdownMs: ROUND_PRE_MS,
    endCountdownMs: ROUND_END_MS,
    topColor: top.getHex(),
    bottomColor: bottom.getHex(),
    hostId: clientId
  };

  room.updateRoomState({
    round: newRound
  });
}

let initializingMultiplayer = false;

// Initialize multiplayer asynchronously when the player opts in
async function initMultiplayer() {
  if (roomReady || initializingMultiplayer) return;
  initializingMultiplayer = true;

  if (!room) {
    room = new WebsimSocket({
      host: PARTYKIT_HOST,
      room: 'kart-lobby'
    });
  }

  if (mpJoinBtn) {
    mpJoinBtn.disabled = true;
    mpJoinBtn.textContent = 'Connecting...';
  }

  try {
    await room.initialize();
    roomReady = true;
    clientId = room.clientId;

    room.subscribePresence(handlePresence);

    room.subscribeRoomState((state) => {
      handleRoomState(state);
    });

    if (mpJoinBtn) {
      mpJoinBtn.textContent = 'Online';
      mpJoinBtn.disabled = true;
      mpJoinBtn.classList.add('connected');
    }
  } catch (e) {
    console.error('Failed to initialize multiplayer', e);
    if (mpJoinBtn) {
      mpJoinBtn.textContent = 'Join Online';
      mpJoinBtn.disabled = false;
    }
  } finally {
    initializingMultiplayer = false;
  }
}

// Handle room-wide state (round info + bot car replication)
function handleRoomState(state) {
  if (!state) return;

  // Round / track info
  if (state.round) {
    applyRoundState(state.round);
  }

  // Bot replication: non-host clients render the bot from shared state
  const botState = state.botCar;
  if (!botState) {
    if (botGhost) {
      scene.remove(botGhost);
      botGhost = null;
    }
    botGhostTarget = null;
    return;
  }

  // Host already drives a local visual bot; ensure any old ghost is removed
  if (isHost) {
    if (botGhost) {
      scene.remove(botGhost);
      botGhost = null;
    }
    botGhostTarget = null;
    return;
  }

  if (!botGhost) {
    const visual = createCarVisual(scene, scene.environment || null);
    botGhost = visual.group;
    botGhost.userData.visual = visual;
    // Slight transparency for ghost bot
    botGhost.traverse((obj) => {
      if (obj.isMesh && obj.material) {
        obj.material.transparent = true;
        obj.material.opacity = 0.75;
      }
    });
    botGhost.userData.initialized = false;
  }

  const targetPos = new THREE.Vector3(botState.x, botState.y, botState.z);
  const targetQuat = new THREE.Quaternion(
    botState.qx,
    botState.qy,
    botState.qz,
    botState.qw
  );

  // On first update, snap to the correct transform so we don't lerp from origin
  if (!botGhost.userData.initialized) {
    botGhost.position.copy(targetPos);
    botGhost.quaternion.copy(targetQuat);
    botGhost.userData.initialized = true;
  }

  botGhostTarget = {
    position: targetPos,
    quaternion: targetQuat
  };
  botGhostLastUpdate = performance.now();
}

// Wire up multiplayer UI
if (mpJoinConfirmBtn) {
  mpJoinConfirmBtn.addEventListener('click', () => {
    hideMultiplayerModal();
    initMultiplayer();
  });
}

if (mpJoinSkipBtn) {
  mpJoinSkipBtn.addEventListener('click', () => {
    hideMultiplayerModal();
  });
}

if (mpJoinBtn) {
  mpJoinBtn.addEventListener('click', () => {
    // If not yet connected, allow joining from the sidebar button
    if (!roomReady && !initializingMultiplayer) {
      initMultiplayer();
    }
  });
}

// Color picker wiring
if (bodyColorInput) {
  // Sync initial random body color into the picker
  bodyColorInput.value = localBodyColor;
  bodyColorInput.addEventListener('input', (e) => {
    const value = e.target.value;
    localBodyColor = value;
    if (car && typeof car.setColors === 'function') {
      car.setColors(localBodyColor, localGlassColor);
    }
  });
}

if (glassColorInput) {
  // Sync initial random glass color into the picker
  glassColorInput.value = localGlassColor;
  glassColorInput.addEventListener('input', (e) => {
    const value = e.target.value;
    localGlassColor = value;
    if (car && typeof car.setColors === 'function') {
      car.setColors(localBodyColor, localGlassColor);
    }
  });
}

// Show the initial multiplayer prompt at startup
showMultiplayerModal();

 // Heartbeat + host/round management tick
 setInterval(() => {
   if (!roomReady || !room) return;
   const now = Date.now();

   room.updatePresence({
     heartbeat: now
   });

   electHostAndManageRounds();
 }, HEARTBEAT_INTERVAL_MS);

// -----------------------------------------------------------------------------
// Main loop + resize
// -----------------------------------------------------------------------------
function loop() {
  const now = performance.now();

  const dt = Math.min((now - lastTime) / 1000, 1 / 30);
  lastTime = now;

  const nowMsWall = Date.now();

  const canDrive = isDrivingEnabled(nowMsWall);
  car.setControlsEnabled(canDrive);

  const inputState = input.getState();
  lastInputState = inputState;
  car.update(inputState, dt);

  // Only the online host drives the visual-only bot; non-hosts just
  // render the replicated botGhost.
  if (roomReady && isHost) {
    updateFakeBot(dt);
  }

  // Smoothly interpolate replicated bot ghost toward latest network state
  if (!isHost && botGhost && botGhostTarget) {
    const lerpFactor = 0.18;
    botGhost.position.lerp(botGhostTarget.position, lerpFactor);
    botGhost.quaternion.slerp(botGhostTarget.quaternion, lerpFactor);
  }

  // Use a few more substeps so fast-moving cars resolve contact with the track
  // more reliably and are less likely to tunnel through.
  world.step(1 / 60, dt, 5);

  if (roomReady && room) {
    const carPos = car.getPosition();
    const carQuat = car.getQuaternion();
    const bestLap = lapSystem.getBestLap();
    room.updatePresence({
      car: {
        x: carPos.x,
        y: carPos.y,
        z: carPos.z,
        qx: carQuat.x,
        qy: carQuat.y,
        qz: carQuat.z,
        qw: carQuat.w,
        lap: lapSystem.getLapCount(),
        bestLapMs: typeof bestLap === 'number' ? bestLap : undefined,
        colorBody: localBodyColor,
        colorGlass: localGlassColor
      }
    });

    // Host shares the visual-only bot transform with all clients via room state
    if (isHost && botVisual) {
      const botPos = botVisual.position;
      const botQuat = botVisual.quaternion;
      room.updateRoomState({
        botCar: {
          x: botPos.x,
          y: botPos.y,
          z: botPos.z,
          qx: botQuat.x,
          qy: botQuat.y,
          qz: botQuat.z,
          qw: botQuat.w
        }
      });
    }
  }

  cameraController.update(lastInputState);
  lapSystem.update(now);
  updateRoundUI(nowMsWall);

  renderer.render(scene, camera);
  requestAnimationFrame(loop);
}

window.addEventListener('resize', () => {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const { rw, rh } = computeRenderBufferSize(w, h, 1024);

  camera.aspect = w / h;
  camera.updateProjectionMatrix();

  renderer.setSize(rw, rh, false);
  renderer.domElement.style.width = `${w}px`;
  renderer.domElement.style.height = `${h}px`;
});

loop();