import nipplejs from 'nipplejs';

export class InputController {
  constructor(joystickZone) {
    this.keys = {
      forward: false,
      back: false,
      left: false,
      right: false,
      brake: false
    };

    this.joystickState = {
      angle: 0,
      distance: 0
    };

    this.isMobile = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

    this._bindKeyboard();
    this._bindJoystick(joystickZone);
  }

  _bindKeyboard() {
    window.addEventListener('keydown', (e) => {
      switch (e.code) {
        case 'KeyW':
        case 'ArrowUp':
          this.keys.forward = true;
          break;
        case 'KeyS':
        case 'ArrowDown':
          this.keys.back = true;
          break;
        case 'KeyA':
        case 'ArrowLeft':
          this.keys.left = true;
          break;
        case 'KeyD':
        case 'ArrowRight':
          this.keys.right = true;
          break;
        case 'Space':
          this.keys.brake = true;
          break;
      }
    });

    window.addEventListener('keyup', (e) => {
      switch (e.code) {
        case 'KeyW':
        case 'ArrowUp':
          this.keys.forward = false;
          break;
        case 'KeyS':
        case 'ArrowDown':
          this.keys.back = false;
          break;
        case 'KeyA':
        case 'ArrowLeft':
          this.keys.left = false;
          break;
        case 'KeyD':
        case 'ArrowRight':
          this.keys.right = false;
          break;
        case 'Space':
          this.keys.brake = false;
          break;
      }
    });
  }

  _bindJoystick(zone) {
    if (!this.isMobile || !zone) return;

    const manager = nipplejs.create({
      zone,
      mode: 'dynamic',
      color: 'white',
      size: 100,
      restOpacity: 0.15
    });

    manager.on('move', (evt, data) => {
      if (!data || !data.angle) return;
      this.joystickState.angle = data.angle.radian;
      this.joystickState.distance = Math.min(data.distance / 40, 1);
    });

    manager.on('end', () => {
      this.joystickState.angle = 0;
      this.joystickState.distance = 0;
    });
  }

  getState() {
    let forward = 0;
    let steer = 0;
    let brake = false;

    if (this.isMobile && this.joystickState.distance > 0.05) {
      const a = this.joystickState.angle;
      const d = this.joystickState.distance;
      const forwardComponent = Math.cos(a - Math.PI / 2);
      const sideComponent = Math.sin(a - Math.PI / 2);

      forward = Math.max(-1, Math.min(1, forwardComponent * d));
      // Invert horizontal joystick component so left/right feel natural
      steer = Math.max(-1, Math.min(1, -sideComponent * d));
    } else {
      if (this.keys.forward) forward += 1;
      if (this.keys.back) forward -= 1;
      // Standard steering: A/Left = negative, D/Right = positive
      if (this.keys.left) steer -= 1;
      if (this.keys.right) steer += 1;
      brake = this.keys.brake;
    }

    return {
      forward,
      steer,
      brake
    };
  }
}