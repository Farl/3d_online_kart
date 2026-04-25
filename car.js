import * as THREE from 'three';
import * as CANNON from 'cannon-es';

// Collision groups: keep in sync with track.js and physics.js
const GROUP_GROUND = 1;

function createTireTexture() {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  // Base dark rubber (darker for higher contrast)
  ctx.fillStyle = '#050505';
  ctx.fillRect(0, 0, size, size);

  // Sidewall ring (brighter against dark base)
  ctx.strokeStyle = '#505050';
  ctx.lineWidth = size * 0.08;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size * 0.38, 0, Math.PI * 2);
  ctx.stroke();

  // Inner edge ring (slightly brighter again)
  ctx.strokeStyle = '#777777';
  ctx.lineWidth = size * 0.06;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size * 0.28, 0, Math.PI * 2);
  ctx.stroke();

  // Simple diagonal tread pattern with high contrast so rotation is visible
  ctx.strokeStyle = '#bbbbbb';
  ctx.lineWidth = 3;
  const step = size * 0.08;
  for (let i = -size; i < size * 2; i += step) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i - size * 0.4, size);
    ctx.stroke();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

export function createCarVisual(scene, envMap = null) {
  const carWidth = 1;
  const carHeight = 0.6;
  const carLength = 2;

  // Root group for car visuals
  const carGroup = new THREE.Group();
  const visualGroup = new THREE.Group();
  carGroup.add(visualGroup);
  scene.add(carGroup);

  // Chassis visual (aligned so +Z is forward, Y is up)
  const bodyRadius = carHeight / 2; // 0.3
  const bodyCenterLength = carLength - 2 * bodyRadius; // 1.4 so total = 2.0
  const bodyGeom = new THREE.CapsuleGeometry(bodyRadius, bodyCenterLength, 8, 16);
  bodyGeom.rotateX(Math.PI / 2);

  const bodyMat = new THREE.MeshPhysicalMaterial({
    color: 0x1f7aff,
    metalness: 0.7,
    roughness: 0.08,
    clearcoat: 1.0,
    clearcoatRoughness: 0.03,
    envMap: envMap || null,
    envMapIntensity: 1.5
  });
  const bodyMesh = new THREE.Mesh(bodyGeom, bodyMat);
  bodyMesh.castShadow = true;
  bodyMesh.receiveShadow = true;
  const bodyWidthScale = carWidth / (bodyRadius * 2);
  bodyMesh.scale.set(bodyWidthScale, 1, 1);
  bodyMesh.position.y = 0.3;
  visualGroup.add(bodyMesh);

  // Rounded cabin
  const cabinWidth = 0.7;
  const cabinHeight = 0.4;
  const cabinLength = 0.9;
  const cabinRadius = cabinHeight / 2;
  const cabinCenterLength = cabinLength - 2 * cabinRadius;
  const cabinGeom = new THREE.CapsuleGeometry(cabinRadius, cabinCenterLength, 8, 16);
  cabinGeom.rotateX(Math.PI / 2);

  const cabinMat = new THREE.MeshStandardMaterial({
    color: 0x181818,
    metalness: 0.6,
    roughness: 0.3
  });
  const cabinMesh = new THREE.Mesh(cabinGeom, cabinMat);
  const cabinWidthScale = cabinWidth / (cabinRadius * 2);
  cabinMesh.scale.set(cabinWidthScale, 1, 1);
  cabinMesh.position.set(0, 0.7, -0.1);
  cabinMesh.castShadow = true;
  visualGroup.add(cabinMesh);

  // Wheels (static placement, no physics)
  const tireTexture = createTireTexture();
  tireTexture.wrapS = THREE.RepeatWrapping;
  tireTexture.wrapT = THREE.RepeatWrapping;
  tireTexture.repeat.set(1, 1);

  const wheelGeom = new THREE.CylinderGeometry(0.5, 0.5, 0.2, 20);
  wheelGeom.rotateZ(Math.PI / 2);

  const wheelMat = new THREE.MeshStandardMaterial({
    map: tireTexture,
    color: 0x444444,
    metalness: 0.5,
    roughness: 0.35,
    emissive: 0x050505,
    emissiveIntensity: 0.4
  });

  const halfW = carWidth / 2 + 0.15;
  const halfL = carLength / 2 - 0.3;
  const connectionHeight = -0.15;

  const wheelPositions = [
    [ halfW, connectionHeight,  halfL], // front-right
    [-halfW, connectionHeight,  halfL], // front-left
    [ halfW, connectionHeight, -halfL], // rear-right
    [-halfW, connectionHeight, -halfL]  // rear-left
  ];

  for (const [x, y, z] of wheelPositions) {
    const wheelMesh = new THREE.Mesh(wheelGeom, wheelMat);
    wheelMesh.castShadow = true;
    wheelMesh.receiveShadow = true;
    wheelMesh.position.set(x, y, z);
    visualGroup.add(wheelMesh);
  }

  function setColors(bodyHex, glassHex) {
    if (bodyHex) {
      try {
        bodyMat.color.set(bodyHex);
      } catch {}
    }
    if (glassHex) {
      try {
        cabinMat.color.set(glassHex);
      } catch {}
    }
  }

  return {
    group: carGroup,
    bodyMesh,
    cabinMesh,
    setColors
  };
}

export function createCar(scene, world, startPosition, startDirection, envMap = null, options = {}) {
  const carWidth = 1;
  const carHeight = 0.6;
  const carLength = 2;
  const mass = 650;
  const isBot = options && options.isBot === true;

  let respawnPosition = startPosition.clone();
  let respawnDirection = startDirection.clone();

  // Control lock / freeze state
  let controlsEnabled = true;
  let frozen = false;
  const frozenPos = new CANNON.Vec3();
  const frozenQuat = new CANNON.Quaternion();

  // Root group for car visuals
  const carGroup = new THREE.Group();
  const visualGroup = new THREE.Group();
  carGroup.add(visualGroup);
  scene.add(carGroup);

  // Chassis visual (aligned so +Z is forward, Y is up)
  // Use a rounded capsule-based body, scaled to match the original box dimensions.
  const bodyRadius = carHeight / 2; // 0.3
  const bodyCenterLength = carLength - 2 * bodyRadius; // 1.4 so total = 2.0
  const bodyGeom = new THREE.CapsuleGeometry(bodyRadius, bodyCenterLength, 8, 16);
  // Capsule axis is along Y by default; rotate so it's along +Z (car forward)
  bodyGeom.rotateX(Math.PI / 2);

  const bodyMat = new THREE.MeshPhysicalMaterial({
    color: 0x1f7aff,
    metalness: 0.7,
    roughness: 0.08,
    clearcoat: 1.0,
    clearcoatRoughness: 0.03,
    envMap: envMap || null,
    envMapIntensity: 1.5
  });

  // Bot cars render like ghost client cars (semi-transparent)
  if (isBot) {
    bodyMat.transparent = true;
    bodyMat.opacity = 0.7;
  }

  const bodyMesh = new THREE.Mesh(bodyGeom, bodyMat);
  bodyMesh.castShadow = true;
  bodyMesh.receiveShadow = true;
  // Stretch the capsule sideways so width matches the original box (1.0)
  // while keeping height (0.6) and length (2.0) the same.
  const bodyWidthScale = carWidth / (bodyRadius * 2); // 1.0 / 0.6
  bodyMesh.scale.set(bodyWidthScale, 1, 1);
  bodyMesh.position.y = 0.3;
  visualGroup.add(bodyMesh);

  // Rounded cabin using a smaller capsule, scaled to match the original cabin box.
  const cabinWidth = 0.7;
  const cabinHeight = 0.4;
  const cabinLength = 0.9;
  const cabinRadius = cabinHeight / 2; // 0.2
  const cabinCenterLength = cabinLength - 2 * cabinRadius; // 0.5
  const cabinGeom = new THREE.CapsuleGeometry(cabinRadius, cabinCenterLength, 8, 16);
  cabinGeom.rotateX(Math.PI / 2);

  const cabinMat = new THREE.MeshStandardMaterial({
    color: 0x181818,
    metalness: 0.6,
    roughness: 0.3
  });

  if (isBot) {
    cabinMat.transparent = true;
    cabinMat.opacity = 0.7;
  }

  const cabinMesh = new THREE.Mesh(cabinGeom, cabinMat);
  // Non-uniform scale so the capsule matches the original cabin width/height
  const cabinWidthScale = cabinWidth / (cabinRadius * 2); // 0.7 / 0.4
  cabinMesh.scale.set(cabinWidthScale, 1, 1);
  cabinMesh.position.set(0, 0.7, -0.1);
  cabinMesh.castShadow = true;
  visualGroup.add(cabinMesh);

  // Debug chassis collision wireframe (matches CANNON.Box shape)
  const chassisWireGeom = new THREE.BoxGeometry(carWidth, carHeight, carLength);
  const chassisWireMat = new THREE.MeshBasicMaterial({
    color: 0x00ff00,
    wireframe: true
  });
  const chassisWireMesh = new THREE.Mesh(chassisWireGeom, chassisWireMat);
  chassisWireMesh.visible = true;
  // Attach to carGroup so it follows exact physics transform
  carGroup.add(chassisWireMesh);

  // Axes helper to see car local axes (X red, Y green, Z blue)
  const axisHelper = new THREE.AxesHelper(1.5);
  axisHelper.visible = true;
  visualGroup.add(axisHelper);

  // Physics chassis body: +Z forward, Y up (matches visuals)
  // Use a thinner collision box and place it lower than the wheel axis so
  // the chassis collider sits clearly below the wheels for more stable contact.
  const chassisShape = new CANNON.Box(
    new CANNON.Vec3(carWidth / 2, 0.2, carLength / 2)
  );
  // Extra "safety" shape slightly below the main chassis so that even if
  // the raycast wheels miss the track for a frame, the car body will still
  // collide with the track collider instead of tunneling through.
  const safetyShape = new CANNON.Box(
    new CANNON.Vec3(carWidth / 2, 0.1, carLength / 2)
  );
  const chassisBody = new CANNON.Body({
    mass,
    linearDamping: 0.2,
    angularDamping: 0.9
  });
  // Tag this body as a car so the physics world can selectively disable
  // any contacts between two car bodies (player vs bot, etc.).
  chassisBody.isCar = true;
  // Enable CCD so fast-moving cars don't tunnel through the track
  // Use a low threshold and more iterations for more robust contact.
  chassisBody.ccdSpeedThreshold = 0.1;
  chassisBody.ccdIterations = 20;

  // Use collision layers so cars never hit each other:
  // - Track stays on default group 1 (CANNON default).
  // - Player cars use group 2, mask 1: they only collide with the track.
  // - Bot cars use group 4, mask 1: they also only collide with the track.
  if (isBot) {
    chassisBody.collisionFilterGroup = 4;
    chassisBody.collisionFilterMask = 1;
  } else {
    chassisBody.collisionFilterGroup = 2;
    chassisBody.collisionFilterMask = 1;
  }
  // Lower the center of mass relative to the visual chassis
  // to make the car more stable and reduce roll-over tendency.
  // The box is also thinner (half-height 0.2) and placed well below
  // the wheel axis so the physical chassis sits lower than the wheels.
  chassisBody.addShape(chassisShape, new CANNON.Vec3(0, -0.45, 0));
  // Safety shape sits a bit lower again, purely to guarantee that the
  // chassis will hit the track when raycast wheels are momentarily not
  // hitting anything.
  chassisBody.addShape(safetyShape, new CANNON.Vec3(0, -0.75, 0));
  chassisBody.position.set(startPosition.x, startPosition.y, startPosition.z);

  // Align chassis orientation so its +Z matches startDirection (XZ-plane)
  if (startDirection && startDirection.lengthSq() > 0.0001) {
    const dir = startDirection.clone().setY(0).normalize();
    const yaw = Math.atan2(dir.x, dir.z); // rotate +Z into dir
    chassisBody.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), yaw);
  }

  world.addBody(chassisBody);

  // RaycastVehicle with Y-up, Z-forward, X-right
  const vehicle = new CANNON.RaycastVehicle({
    chassisBody,
    indexRightAxis: 0,   // X
    indexUpAxis: 1,      // Y
    indexForwardAxis: 2  // Z
  });

  // Wheel configuration (similar to demo, adapted to Y-up)
  const wheelOptions = {
    radius: 0.5,
    suspensionStiffness: 40,
    suspensionRestLength: 0.25,
    frictionSlip: 10,
    dampingRelaxation: 2.3,
    dampingCompression: 4.4,
    maxSuspensionForce: 100000,
    rollInfluence: 0.01,
    // Wheel local axes:
    //  - X: wheel axle (positive points to the car's right-hand side)
    //  - Y: suspension up (positive) / down (negative)
    //  - Z: forward/back of car
    axleLocal: new CANNON.Vec3(1, 0, 0), // axle along local +X (car right)
    directionLocal: new CANNON.Vec3(0, -1, 0), // suspension down (Y-)
    maxSuspensionTravel: 0.3,
    customSlidingRotationalSpeed: -30,
    useCustomSlidingRotationalSpeed: true
  };

  const halfW = carWidth / 2 + 0.15;
  const halfL = carLength / 2 - 0.3;
  const connectionHeight = -0.15;

  // Front-right
  wheelOptions.chassisConnectionPointLocal = new CANNON.Vec3(
    halfW,
    connectionHeight,
    halfL
  );
  vehicle.addWheel(wheelOptions);

  // Front-left
  wheelOptions.chassisConnectionPointLocal = new CANNON.Vec3(
    -halfW,
    connectionHeight,
    halfL
  );
  vehicle.addWheel(wheelOptions);

  // Rear-right
  wheelOptions.chassisConnectionPointLocal = new CANNON.Vec3(
    halfW,
    connectionHeight,
    -halfL
  );
  vehicle.addWheel(wheelOptions);

  // Rear-left
  wheelOptions.chassisConnectionPointLocal = new CANNON.Vec3(
    -halfW,
    connectionHeight,
    -halfL
  );
  vehicle.addWheel(wheelOptions);

  vehicle.addToWorld(world);

  // Reinforce collision filters after the vehicle is added, in case any
  // internal setup modified the chassis body's filter settings.
  if (isBot) {
    chassisBody.collisionFilterGroup = 4;
    chassisBody.collisionFilterMask = 1;
  } else {
    chassisBody.collisionFilterGroup = 2;
    chassisBody.collisionFilterMask = 1;
  }

  // Wheel visuals
  const wheelMeshes = [];
  const wheelWireMeshes = [];
  const wheelAxesHelpers = [];

  const tireTexture = createTireTexture();
  tireTexture.wrapS = THREE.RepeatWrapping;
  tireTexture.wrapT = THREE.RepeatWrapping;
  tireTexture.repeat.set(1, 1);

  // CylinderGeometry is Y‑axis aligned by default; rotate so axle is +Z
  const wheelGeom = new THREE.CylinderGeometry(
    wheelOptions.radius,
    wheelOptions.radius,
    0.2,
    20
  );
  // Default cylinder axis is Y; rotate so axis aligns with local +X (car right)
  wheelGeom.rotateZ(Math.PI / 2);

  const wheelMat = new THREE.MeshStandardMaterial({
    map: tireTexture,
    color: 0x444444,
    metalness: 0.5,
    roughness: 0.35,
    emissive: 0x050505,
    emissiveIntensity: 0.4
  });

  const wheelWireGeom = new THREE.CylinderGeometry(
    wheelOptions.radius,
    wheelOptions.radius,
    0.22,
    12
  );
  // Match debug wireframe orientation to visual/physics axle (+X)
  wheelWireGeom.rotateZ(Math.PI / 2);

  const wheelWireMat = new THREE.MeshBasicMaterial({
    color: 0x00ff00,
    wireframe: true
  });

  for (let i = 0; i < vehicle.wheelInfos.length; i++) {
    const wheelMesh = new THREE.Mesh(wheelGeom, wheelMat);
    wheelMesh.castShadow = true;
    wheelMesh.receiveShadow = true;

    // Local axes helper for this wheel (X red, Y green, Z blue)
    const wheelAxes = new THREE.AxesHelper(0.7);
    wheelMesh.add(wheelAxes);
    wheelAxesHelpers.push(wheelAxes);

    scene.add(wheelMesh);
    wheelMeshes.push(wheelMesh);

    // Matching debug wireframe wheel
    const wheelWire = new THREE.Mesh(wheelWireGeom, wheelWireMat);
    wheelWire.visible = true;
    scene.add(wheelWire);
    wheelWireMeshes.push(wheelWire);
  }

  // Sync chassis + wheel visuals after each physics step
  world.addEventListener('postStep', () => {
    // Chassis
    carGroup.position.set(
      chassisBody.position.x,
      chassisBody.position.y,
      chassisBody.position.z
    );
    carGroup.quaternion.set(
      chassisBody.quaternion.x,
      chassisBody.quaternion.y,
      chassisBody.quaternion.z,
      chassisBody.quaternion.w
    );

    // Wheels
    for (let i = 0; i < vehicle.wheelInfos.length; i++) {
      vehicle.updateWheelTransform(i);
      const t = vehicle.wheelInfos[i].worldTransform;

      // Solid wheel mesh
      const wheelMesh = wheelMeshes[i];
      wheelMesh.position.set(t.position.x, t.position.y, t.position.z);
      wheelMesh.quaternion.set(
        t.quaternion.x,
        t.quaternion.y,
        t.quaternion.z,
        t.quaternion.w
      );

      // Debug wireframe wheel (matches collision raycast position/orientation)
      const wheelWire = wheelWireMeshes[i];
      wheelWire.position.set(t.position.x, t.position.y, t.position.z);
      wheelWire.quaternion.set(
        t.quaternion.x,
        t.quaternion.y,
        t.quaternion.z,
        t.quaternion.w
      );
    }

    // If controls are disabled (e.g. during race countdown), hard-freeze the chassis
    // at its stored transform so it cannot roll or slide.
    if (frozen) {
      chassisBody.position.copy(frozenPos);
      chassisBody.quaternion.copy(frozenQuat);
      chassisBody.velocity.set(0, 0, 0);
      chassisBody.angularVelocity.set(0, 0, 0);
    }

    // If the car is upside down but still close to the track, use forces to help it roll back
    const bodyUp = chassisBody.quaternion.vmult(new CANNON.Vec3(0, 1, 0));
    const isUpsideDown = bodyUp.y < 0.3;
    const nearTrack = chassisBody.position.y > -2 && chassisBody.position.y < 5;

    if (isUpsideDown && nearTrack) {
      // Compute a torque that rotates the current "up" vector back toward world up
      const desiredUp = new CANNON.Vec3(0, 1, 0);
      const currentUp = bodyUp; // already in world space

      const axis = new CANNON.Vec3(
        currentUp.y * desiredUp.z - currentUp.z * desiredUp.y,
        currentUp.z * desiredUp.x - currentUp.x * desiredUp.z,
        currentUp.x * desiredUp.y - currentUp.y * desiredUp.x
      );
      const axisLen = axis.length();

      if (axisLen > 1e-3) {
        axis.scale(1 / axisLen, axis);

        const dot = Math.max(-1, Math.min(1, currentUp.dot(desiredUp)));
        const angleError = Math.acos(dot);

        const torqueStrength = 2000; // further increased for stronger upright correction
        const torqueMag = angleError * torqueStrength;

        axis.scale(torqueMag, axis);
        // Only apply a pure torque to roll the car back upright (no linear push)
        chassisBody.torque.vadd(axis, chassisBody.torque);
      }
    }

    // Simple respawn if car falls off completely
    if (chassisBody.position.y < -10) {
      chassisBody.velocity.set(0, 0, 0);
      chassisBody.angularVelocity.set(0, 0, 0);
      chassisBody.position.set(respawnPosition.x, respawnPosition.y + 1, respawnPosition.z);
      chassisBody.quaternion.set(0, 0, 0, 1);

      if (respawnDirection && respawnDirection.lengthSq() > 0.0001) {
        const dir = respawnDirection.clone().setY(0).normalize();
        const yaw = Math.atan2(dir.x, dir.z);
        chassisBody.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), yaw);
      }
    }
  });

  const tmpDir = new THREE.Vector3(0, 0, 1);
  const tmpUp = new THREE.Vector3(0, 1, 0);
  const tmpForward = new THREE.Vector3(0, 0, 1);
  const tmpRight = new THREE.Vector3();

  function update(input, dt) {
    // When controls are disabled (e.g. during start countdown), do not apply
    // any driving forces; chassis pose is handled by the postStep freeze.
    if (!controlsEnabled) {
      return;
    }

    // Input mapping: W forward, S backward, A left, D right
    const throttle = THREE.MathUtils.clamp(input.forward, -1, 1);
    const steerInput = THREE.MathUtils.clamp(input.steer, -1, 1);

    const maxEngineForce = 1300;
    const maxBrakeForce = 3000;
    const maxSteerVal = 0.5;

    // Apply engine force on rear wheels only (2,3)
    let engineForce = -maxEngineForce * throttle; // minus so positive throttle moves forward
    // When braking, cut engine drive to avoid fighting forces that can flip the car
    if (input.brake) {
      engineForce = 0;
    }
    vehicle.applyEngineForce(engineForce, 2);
    vehicle.applyEngineForce(engineForce, 3);

    // Brakes
    const braking = input.brake ? maxBrakeForce : 0;
    for (let i = 0; i < 4; i++) {
      vehicle.setBrake(braking, i);
    }

    // Steering on front wheels (0,1)
    // Same convention as demo: positive steer value turns left,
    // so we invert our steer input (A = -1, D = +1)
    const steerVal = -steerInput * maxSteerVal;
    vehicle.setSteeringValue(steerVal, 0);
    vehicle.setSteeringValue(steerVal, 1);

    // Anti-roll torque: resist chassis rolling around its forward axis
    const q = new THREE.Quaternion(
      chassisBody.quaternion.x,
      chassisBody.quaternion.y,
      chassisBody.quaternion.z,
      chassisBody.quaternion.w
    );

    // Compute chassis up and forward vectors in world space
    tmpUp.set(0, 1, 0).applyQuaternion(q);
    tmpForward.set(0, 0, 1).applyQuaternion(q);

    // Keep forward mostly horizontal for torque direction
    tmpForward.y = 0;
    if (tmpForward.lengthSq() > 1e-4) {
      tmpForward.normalize();

      // Right vector from up x forward
      tmpRight.crossVectors(tmpUp, tmpForward).normalize();

      // Tilt is up component towards right: positive means rolled to the right
      const tilt = tmpUp.dot(tmpRight);

      const antiRollStrength = 6000;
      const torqueMag = -tilt * antiRollStrength;

      const torque = new CANNON.Vec3(
        tmpForward.x * torqueMag,
        tmpForward.y * torqueMag,
        tmpForward.z * torqueMag
      );
      chassisBody.torque.vadd(torque, chassisBody.torque);
    }

    // Anti-pitch torque: resist chassis pitching around its right axis
    // (nose up / nose down) so the car stays more level over bumps and under braking.
    // tmpForward already contains the chassis forward in world space.
    if (tmpForward.lengthSq() > 1e-4) {
      // Pitch is encoded mostly in the Y component of the forward vector:
      // positive Y means nose up, negative means nose down.
      const pitch = tmpForward.y;
      const antiPitchStrength = 4000;
      const pitchTorqueMag = -pitch * antiPitchStrength;

      if (Math.abs(pitchTorqueMag) > 1e-3) {
        // Right-hand axis for pitch torque is forward x up (world).
        tmpRight.crossVectors(tmpForward, new THREE.Vector3(0, 1, 0)).normalize();

        const pitchTorque = new CANNON.Vec3(
          tmpRight.x * pitchTorqueMag,
          tmpRight.y * pitchTorqueMag,
          tmpRight.z * pitchTorqueMag
        );
        chassisBody.torque.vadd(pitchTorque, chassisBody.torque);
      }
    }
  }

  function getPosition() {
    return new THREE.Vector3(
      chassisBody.position.x,
      chassisBody.position.y,
      chassisBody.position.z
    );
  }

  function getQuaternion() {
    return new THREE.Quaternion(
      chassisBody.quaternion.x,
      chassisBody.quaternion.y,
      chassisBody.quaternion.z,
      chassisBody.quaternion.w
    );
  }

  function getDirection() {
    const quat = new THREE.Quaternion(
      chassisBody.quaternion.x,
      chassisBody.quaternion.y,
      chassisBody.quaternion.z,
      chassisBody.quaternion.w
    );
    return tmpDir.set(0, 0, 1).applyQuaternion(quat).setY(0).normalize();
  }

  function setDebugVisible(options) {
    const { axes = true, chassisWire = true, wheelWire = true } = options || {};
    axisHelper.visible = axes;
    chassisWireMesh.visible = chassisWire;
    wheelWireMeshes.forEach((w) => {
      w.visible = wheelWire;
    });
    wheelAxesHelpers.forEach((a) => {
      a.visible = axes;
    });
  }

  // Allow env map to be updated after HDR loads so reflections are guaranteed
  function setEnvMap(map) {
    if (!map) return;
    bodyMat.envMap = map;
    bodyMat.envMapIntensity = 1.5;
    bodyMat.needsUpdate = true;
  }

  function setColors(bodyHex, glassHex) {
    if (bodyHex) {
      try {
        bodyMat.color.set(bodyHex);
      } catch (e) {
        // ignore invalid colors
      }
    }
    if (glassHex) {
      try {
        cabinMat.color.set(glassHex);
      } catch (e) {
        // ignore invalid colors
      }
    }
  }

  function setRespawn(position, direction) {
    respawnPosition = position.clone();
    respawnDirection = direction.clone();

    chassisBody.velocity.set(0, 0, 0);
    chassisBody.angularVelocity.set(0, 0, 0);
    chassisBody.position.set(respawnPosition.x, respawnPosition.y + 1, respawnPosition.z);
    chassisBody.quaternion.set(0, 0, 0, 1);

    if (respawnDirection && respawnDirection.lengthSq() > 0.0001) {
      const dir = respawnDirection.clone().setY(0).normalize();
      const yaw = Math.atan2(dir.x, dir.z);
      chassisBody.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), yaw);
    }
  }

  function setControlsEnabled(enabled) {
    controlsEnabled = !!enabled;
    if (!controlsEnabled) {
      // Capture current transform and zero velocities; postStep will keep it locked.
      frozen = true;
      frozenPos.copy(chassisBody.position);
      frozenQuat.copy(chassisBody.quaternion);
      chassisBody.velocity.set(0, 0, 0);
      chassisBody.angularVelocity.set(0, 0, 0);
    } else {
      frozen = false;
    }
  }

  function dispose() {
    // Remove physics
    try {
      vehicle.removeFromWorld(world);
    } catch (e) {
      // ignore
    }
    try {
      world.removeBody(chassisBody);
    } catch (e) {
      // ignore
    }

    // Remove visuals from scene
    scene.remove(carGroup);
    wheelMeshes.forEach((m) => {
      scene.remove(m);
      if (m.geometry) m.geometry.dispose();
      if (m.material) m.material.dispose();
    });
    wheelWireMeshes.forEach((m) => {
      scene.remove(m);
      if (m.geometry) m.geometry.dispose();
      if (m.material) m.material.dispose();
    });

    // Dispose main car visuals
    if (bodyMesh.geometry) bodyMesh.geometry.dispose();
    if (bodyMesh.material) bodyMesh.material.dispose();
    if (cabinMesh.geometry) cabinMesh.geometry.dispose();
    if (cabinMesh.material) cabinMesh.material.dispose();
    chassisWireGeom.dispose();
    chassisWireMat.dispose();
    if (axisHelper.geometry) axisHelper.geometry.dispose();
  }

  return {
    update,
    getPosition,
    getQuaternion,
    getDirection,
    setDebugVisible,
    setEnvMap,
    setRespawn,
    setControlsEnabled,
    setColors,
    dispose
  };
}