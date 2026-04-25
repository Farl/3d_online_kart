import * as THREE from 'three';

/**
 * Simple chase camera controller that follows the car and adjusts FOV with speed.
 */
export function createCameraController(camera, car, baseFov = 60, maxFov = 80) {
  const carPos = new THREE.Vector3();
  const carDir = new THREE.Vector3();
  const behind = new THREE.Vector3();
  const upOffset = new THREE.Vector3(0, 4, 0);
  const lookTarget = new THREE.Vector3();

  function update(lastInputState) {
    const pos = car.getPosition();
    const dir = car.getDirection();

    carPos.copy(pos);
    carDir.copy(dir);

    behind.copy(carDir).multiplyScalar(-8);
    const targetPos = carPos.clone().add(behind).add(upOffset);

    camera.position.lerp(targetPos, 0.1);
    lookTarget.set(carPos.x, carPos.y + 1, carPos.z);
    camera.lookAt(lookTarget);

    const throttle = THREE.MathUtils.clamp((lastInputState?.forward) || 0, -1, 1);
    const targetFov =
      throttle > 0
        ? THREE.MathUtils.lerp(baseFov, maxFov, throttle)
        : baseFov;

    const newFov = THREE.MathUtils.lerp(camera.fov, targetFov, 0.1);
    if (Math.abs(newFov - camera.fov) > 0.01) {
      camera.fov = newFov;
      camera.updateProjectionMatrix();
    }
  }

  return {
    update
  };
}