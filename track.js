import * as THREE from 'three';
import * as CANNON from 'cannon-es';

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createTrack(scene, world, seed = Math.floor(Math.random() * 1e9)) {
  const rng = mulberry32(seed);
  // Random base values for this run so the track changes on reload
  const baseRadius = 40; // base loop radius
  const halfWidth = 5.0;

  // Use a minimal number of control points to define the whole loop
  const controlPointCount = 20;
  const controlPoints = [];
  for (let i = 0; i < controlPointCount; i++) {
    const theta = (i / controlPointCount) * Math.PI * 2;

    // Create several large sweeping "big bend" corners by modulating radius
    // with a low-frequency sine wave, plus a little noise.
    const bendFrequency = 2; // 2 full waves around the loop => 4 big bends
    const bendAmplitude = 12; // how strong the radius change is
    const smoothBend = Math.sin(theta * bendFrequency) * bendAmplitude;

    const noise = (rng() - 0.5) * 3; // small random variation
    const r = baseRadius + smoothBend + noise;

    const x = Math.cos(theta) * r;
    const z = Math.sin(theta) * r;
    const y = (rng() - 0.5) * 2; // small vertical variation

    controlPoints.push(new THREE.Vector3(x, y, z));
  }

  // Closed Catmull-Rom spline: smooth track using only a few control points
  const curve = new THREE.CatmullRomCurve3(controlPoints, true, 'catmullrom', 0.5);

  // Visualize all sampled points along the final curve (including the wrapped end)
  const debugSegmentCount = 160;
  const debugPointsArray = [];
  for (let i = 0; i <= debugSegmentCount; i++) {
    const t = i === debugSegmentCount ? 0 : i / debugSegmentCount;
    debugPointsArray.push(curve.getPoint(t));
  }
  const debugGeom = new THREE.BufferGeometry().setFromPoints(debugPointsArray);
  const debugMat = new THREE.PointsMaterial({
    color: 0x00ffff,
    size: 0.2
  });
  const debugPoints = new THREE.Points(debugGeom, debugMat);
  debugPoints.visible = false;
  scene.add(debugPoints);

  // Build a ribbon geometry along the curve with proper normals
  // Use segmentCount+1 rings (t from 0 to 1 inclusive) so the seam is
  // position/tangent/curvature continuous (C2) at the loop closure).
  const segmentCount = 80; // sampling resolution along curve (reduced from 160)
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];

  const tmpUp = new THREE.Vector3(0, 1, 0);

  // Generate segmentCount + 1 rings; force the last ring to reuse t=0 exactly
  // so position/tangent/normal match perfectly at the seam.
  for (let i = 0; i <= segmentCount; i++) {
    const t = i === segmentCount ? 0 : i / segmentCount;
    const center = curve.getPoint(t);
    const tangent = curve.getTangent(t).normalize();

    // Project forward direction onto XZ for "left/right" of road
    const forwardXZ = new THREE.Vector3(tangent.x, 0, tangent.z);
    if (forwardXZ.lengthSq() < 1e-4) {
      forwardXZ.set(1, 0, 0);
    }
    forwardXZ.normalize();

    // Side vector is perpendicular in the horizontal plane
    const side = new THREE.Vector3().crossVectors(tmpUp, forwardXZ).normalize();

    // Road vertices
    const left = center.clone().add(side.clone().multiplyScalar(halfWidth));
    const right = center.clone().add(side.clone().multiplyScalar(-halfWidth));

    // Approximate surface normal (side x tangent)
    const normal = new THREE.Vector3().crossVectors(side, tangent).normalize();

    // Left vertex
    positions.push(left.x, left.y, left.z);
    normals.push(normal.x, normal.y, normal.z);
    // Stretch texture along the V axis (fewer repeats over the full loop)
    uvs.push(0, t * 4);

    // Right vertex
    positions.push(right.x, right.y, right.z);
    normals.push(normal.x, normal.y, normal.z);
    uvs.push(1, t * 4);
  }

  // Connect segments without wrapping indices; the last ring overlaps the first
  for (let i = 0; i < segmentCount; i++) {
    const next = i + 1;

    const a = i * 2;
    const b = a + 1;
    const c = next * 2;
    const d = c + 1;

    indices.push(a, b, c);
    indices.push(b, d, c);
  }

  const trackGeom = new THREE.BufferGeometry();
  trackGeom.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(positions, 3)
  );
  trackGeom.setAttribute(
    'normal',
    new THREE.Float32BufferAttribute(normals, 3)
  );
  trackGeom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  trackGeom.setIndex(indices);
  trackGeom.computeBoundingSphere();

  // Create a small set of checkpoints procedurally along the closed curve.
  // Checkpoint 0 acts as the start/finish line at t = 0.
  const checkpointCount = 8;
  const checkpoints = [];
  for (let i = 0; i < checkpointCount; i++) {
    const t = i / checkpointCount;
    const center = curve.getPoint(t);
    const tangent = curve.getTangent(t).normalize();
    // Approximate "forward" along the surface as tangent projected to XZ
    const forwardXZ = new THREE.Vector3(tangent.x, 0, tangent.z);
    if (forwardXZ.lengthSq() < 1e-4) forwardXZ.set(0, 0, 1);
    forwardXZ.normalize();

    checkpoints.push({
      index: i,
      t,
      position: center.clone(),
      forward: forwardXZ
    });
  }

  // Procedural road texture (no external image)
  const trackTex = createProceduralRoadTexture();
  trackTex.wrapS = THREE.RepeatWrapping;
  trackTex.wrapT = THREE.RepeatWrapping;
  // Use a neutral repeat; V scaling is mostly handled in the UVs now
  trackTex.repeat.set(1, 1);
  trackTex.anisotropy = 8;

  const trackMat = new THREE.MeshStandardMaterial({
    map: trackTex,
    color: 0xb5b5b5,
    metalness: 0.08,
    roughness: 0.55,
    emissive: 0x161616,
    emissiveIntensity: 0.55,
    side: THREE.DoubleSide
  });

  const trackMesh = new THREE.Mesh(trackGeom, trackMat);
  trackMesh.receiveShadow = true;
  trackMesh.castShadow = false;
  scene.add(trackMesh);

  // Physics: use a single mesh collider that matches the visual track
  const { wireMesh: trackWireMesh, body: trackBody } = addTrackPhysicsMesh(scene, world, trackGeom);

  // Starting transform: position slightly behind the first curve point,
  // facing along the curve direction
  const startPos = curve.getPoint(0).clone();
  const startTangent = curve.getTangent(0).clone().normalize();
  const startForward = new THREE.Vector3(startTangent.x, 0, startTangent.z).normalize();
  const offsetBack = startForward.clone().multiplyScalar(-4);
  startPos.add(offsetBack);
  startPos.y += 1.0;

  function setDebugVisible(showPoints, showWire) {
    debugPoints.visible = !!showPoints;
    if (trackWireMesh) trackWireMesh.visible = !!showWire;
  }

  function dispose() {
    scene.remove(debugPoints);
    debugGeom.dispose();
    debugMat.dispose();

    scene.remove(trackMesh);
    trackGeom.dispose();
    trackMat.dispose();
    trackTex.dispose();

    if (trackWireMesh) {
      scene.remove(trackWireMesh);
      trackWireMesh.geometry.dispose();
      trackWireMesh.material.dispose();
    }
    if (trackBody) {
      world.removeBody(trackBody);
    }
  }

  return {
    startPosition: startPos,
    startDirection: startForward,
    checkpoints,
    trackWidth: halfWidth * 2,
    // Dense center-line points (including the wrapped end) for AI/bot usage
    pathPoints: debugPointsArray,
    setDebugVisible,
    dispose
  };
}

function createProceduralRoadTexture() {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  // Base asphalt color
  ctx.fillStyle = '#303030';
  ctx.fillRect(0, 0, size, size);

  // Subtle noise for asphalt texture
  const imageData = ctx.getImageData(0, 0, size, size);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const n = 20 + Math.random() * 20; // small brightness variation
    data[i] = 48 + n;     // R
    data[i + 1] = 48 + n; // G
    data[i + 2] = 48 + n; // B
    // alpha stays 255
  }
  ctx.putImageData(imageData, 0, 0);

  // Slight darker edges to suggest track border
  const edgeWidth = Math.floor(size * 0.12);
  const innerWidth = size - edgeWidth * 2;

  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  // Left edge
  ctx.fillRect(0, 0, edgeWidth, size);
  // Right edge
  ctx.fillRect(size - edgeWidth, 0, edgeWidth, size);

  // Center lane dashed line (vertical, along V direction)
  ctx.lineWidth = Math.floor(size * 0.04);
  ctx.strokeStyle = '#f5f5f5';

  const centerX = size / 2;
  const dashLength = Math.floor(size * 0.12);
  const gapLength = Math.floor(size * 0.10);
  let y = -dashLength * 0.5; // start slightly before to tile nicely

  while (y < size + dashLength) {
    ctx.beginPath();
    ctx.moveTo(centerX, y);
    ctx.lineTo(centerX, y + dashLength);
    ctx.stroke();
    y += dashLength + gapLength;
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

function createTrimeshFromGeometry(geometry) {
  const positionAttr = geometry.attributes.position;
  const indexAttr = geometry.index;

  const vertices = [];
  for (let i = 0; i < positionAttr.count; i++) {
    vertices.push(
      positionAttr.getX(i),
      positionAttr.getY(i),
      positionAttr.getZ(i)
    );
  }

  const indices = [];
  // Make the trimesh effectively double‑sided by adding each triangle
  // twice: once with its original winding order and once reversed.
  for (let i = 0; i < indexAttr.count; i += 3) {
    const i0 = indexAttr.getX(i);
    const i1 = indexAttr.getX(i + 1);
    const i2 = indexAttr.getX(i + 2);

    // Original triangle
    indices.push(i0, i1, i2);
    // Reversed triangle (opposite normal)
    indices.push(i0, i2, i1);
  }

  return new CANNON.Trimesh(vertices, indices);
}

function addTrackPhysicsMesh(scene, world, trackGeom) {
  const shape = createTrimeshFromGeometry(trackGeom);
  const body = new CANNON.Body({ mass: 0 });
  body.addShape(shape);

  // Track is static ground: put it on group 1 and let it collide with all car
  // groups (2 = player cars, 4 = bot cars). Cars themselves are configured
  // to only collide with group 1, so they will never hit each other, only
  // the track.
  body.collisionFilterGroup = 1;
  body.collisionFilterMask = 2 | 4;

  world.addBody(body);

  // Debug wireframe that matches the mesh collider
  const wireGeom = new THREE.WireframeGeometry(trackGeom);
  const wireMat = new THREE.LineBasicMaterial({
    color: 0x00ff00,
    transparent: true,
    opacity: 0.3
  });
  const wireMesh = new THREE.LineSegments(wireGeom, wireMat);
  wireMesh.visible = false;
  scene.add(wireMesh);
  return { wireMesh, body };
}