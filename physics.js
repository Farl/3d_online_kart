import * as CANNON from 'cannon-es';

export function createWorld() {
  const world = new CANNON.World({
    gravity: new CANNON.Vec3(0, -9.82, 0)
  });

  // Use SAP broadphase for better performance on many static bodies (like the track)
  world.broadphase = new CANNON.SAPBroadphase(world);
  world.allowSleep = true;

  // Make the solver a bit more accurate to reduce tunneling through the track
  if (world.solver) {
    world.solver.iterations = 20;
    world.solver.tolerance = 0.001;
  }

  const defaultMaterial = new CANNON.Material('default');
  const contact = new CANNON.ContactMaterial(defaultMaterial, defaultMaterial, {
    friction: 0.8,
    restitution: 0.0
  });

  world.defaultContactMaterial = contact;
  world.addContactMaterial(contact);

  // Extra safety: explicitly disable contacts between car bodies so they can
  // never physically push each other around, even if some shape uses a
  // different collision filter by mistake. Use beginContact so we disable
  // the contact as soon as it is created.
  world.addEventListener('beginContact', (event) => {
    const bodyA = event.bodyA;
    const bodyB = event.bodyB;

    if (bodyA && bodyB && bodyA.isCar && bodyB.isCar) {
      const contact = event.contact;
      if (contact) {
        contact.enabled = false;
      }
    }
  });

  return world;
}