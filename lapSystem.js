import * as THREE from 'three';

/**
 * Encapsulates lap timing, checkpoints, and visual indicators.
 */
export function createLapSystem(
  scene,
  car,
  initialCheckpoints,
  initialTrackWidth,
  makeQuaternionFromForward,
  formatTime
) {
  let checkpoints = initialCheckpoints || [];
  let trackWidth = initialTrackWidth || 10;

  let totalCheckpoints = checkpoints.length;
  let currentCheckpointIndex = 0;
  let lapCount = 1;
  let lapStartTime = performance.now();
  let bestLapMs = Infinity;

  // UI elements for timing
  const lapCountEl = document.getElementById('lap-count');
  const lapTimeEl = document.getElementById('lap-time');

  // Visual indicator for "next checkpoint"
  let checkpointIndicator = null;
  let startGate = null;

  const tmpVec3 = new THREE.Vector3();

  function resetLapAndCheckpointState(nowMs) {
    totalCheckpoints = checkpoints ? checkpoints.length : 0;
    currentCheckpointIndex = 0;
    lapCount = 1;
    lapStartTime = nowMs;
    bestLapMs = Infinity;
    if (lapCountEl) lapCountEl.textContent = '1';
    if (lapTimeEl) lapTimeEl.textContent = formatTime(0);
  }

  function disposeCheckpointVisuals() {
    if (checkpointIndicator) {
      scene.remove(checkpointIndicator);
      checkpointIndicator.geometry.dispose();
      checkpointIndicator.material.dispose();
      checkpointIndicator = null;
    }
    if (startGate) {
      startGate.traverse((obj) => {
        if (obj.isMesh) {
          obj.geometry.dispose();
          obj.material.dispose();
        }
      });
      scene.remove(startGate);
      startGate = null;
    }
  }

  function rebuildCheckpointVisuals() {
    disposeCheckpointVisuals();

    if (!checkpoints || checkpoints.length === 0) return;

    const halfTrack = trackWidth ? trackWidth * 0.5 : 5;

    const ringRadius = halfTrack * 1.1;
    const ringGeom = new THREE.TorusGeometry(ringRadius, 0.15, 14, 48);
    const ringMat = new THREE.MeshStandardMaterial({
      color: 0xffcc00,
      emissive: 0xffaa00,
      emissiveIntensity: 1.2,
      metalness: 0.1,
      roughness: 0.4
    });
    checkpointIndicator = new THREE.Mesh(ringGeom, ringMat);
    checkpointIndicator.castShadow = false;
    checkpointIndicator.receiveShadow = false;

    const firstCp = checkpoints[0];
    checkpointIndicator.quaternion.copy(makeQuaternionFromForward(firstCp.forward));
    scene.add(checkpointIndicator);

    const startCp = checkpoints[0];
    const gateGroup = new THREE.Group();

    const gateHeight = 4;
    const gateWidth = halfTrack * 2.4;
    const gateThickness = 0.3;

    const gateMat = new THREE.MeshStandardMaterial({
      color: 0x00d0ff,
      emissive: 0x0077ff,
      emissiveIntensity: 1.1,
      metalness: 0.1,
      roughness: 0.35
    });

    const basePos = new THREE.Vector3(
      startCp.position.x,
      startCp.position.y,
      startCp.position.z
    );
    gateGroup.position.copy(basePos);
    gateGroup.quaternion.copy(makeQuaternionFromForward(startCp.forward));

    const halfWidth = gateWidth * 0.5;

    const pillarGeom = new THREE.BoxGeometry(gateThickness, gateHeight, gateThickness);
    const leftPillar = new THREE.Mesh(pillarGeom, gateMat);
    const rightPillar = new THREE.Mesh(pillarGeom, gateMat);

    leftPillar.position.set(-halfWidth, gateHeight * 0.5, 0);
    rightPillar.position.set(halfWidth, gateHeight * 0.5, 0);

    leftPillar.castShadow = true;
    leftPillar.receiveShadow = true;
    rightPillar.castShadow = true;
    rightPillar.receiveShadow = true;

    gateGroup.add(leftPillar);
    gateGroup.add(rightPillar);

    const topGeom = new THREE.BoxGeometry(gateWidth + gateThickness, gateThickness, gateThickness);
    const topBar = new THREE.Mesh(topGeom, gateMat);
    topBar.position.set(0, gateHeight + gateThickness * 0.5, 0);
    topBar.castShadow = true;
    topBar.receiveShadow = true;
    gateGroup.add(topBar);

    scene.add(gateGroup);
    startGate = gateGroup;
  }

  function updateCheckpointIndicator() {
    if (!checkpointIndicator || !checkpoints || checkpoints.length === 0) return;
    const cp = checkpoints[currentCheckpointIndex];
    const pos = cp.position;
    checkpointIndicator.position.set(pos.x, pos.y + 1.2, pos.z);
    checkpointIndicator.quaternion.copy(makeQuaternionFromForward(cp.forward));
  }

  function update(now) {
    if (!checkpoints || checkpoints.length === 0) return;

    const lapElapsedMs = now - lapStartTime;
    if (lapTimeEl) lapTimeEl.textContent = formatTime(lapElapsedMs);

    updateCheckpointIndicator();

    const carPos = car.getPosition();
    const cp = checkpoints[currentCheckpointIndex];
    tmpVec3.set(cp.position.x, cp.position.y, cp.position.z);
    const distSq = carPos.distanceToSquared(tmpVec3);
    const triggerRadius = 4.0;
    if (distSq > triggerRadius * triggerRadius) return;

    currentCheckpointIndex = (currentCheckpointIndex + 1) % totalCheckpoints;

    if (currentCheckpointIndex === 0) {
      const lapEndTime = now;
      const thisLapMs = lapEndTime - lapStartTime;
      lapStartTime = lapEndTime;

      // Update best lap for this round
      if (thisLapMs > 0 && thisLapMs < bestLapMs) {
        bestLapMs = thisLapMs;
      }

      lapCount += 1;
      if (lapCountEl) lapCountEl.textContent = String(lapCount);
      if (lapTimeEl) lapTimeEl.textContent = formatTime(thisLapMs);
    }

    updateCheckpointIndicator();
  }

  function handleTrackChange(newCheckpoints, newTrackWidth, nowMs) {
    checkpoints = newCheckpoints || [];
    trackWidth = newTrackWidth || 10;
    totalCheckpoints = checkpoints.length;
    resetLapAndCheckpointState(nowMs);
    rebuildCheckpointVisuals();
  }

  function getLapCount() {
    return lapCount;
  }

  function getBestLap() {
    return Number.isFinite(bestLapMs) ? bestLapMs : null;
  }

  // Initial setup
  if (checkpoints && checkpoints.length > 0) {
    resetLapAndCheckpointState(performance.now());
    rebuildCheckpointVisuals();
  }

  return {
    update,
    handleTrackChange,
    getLapCount,
    getBestLap
  };
}