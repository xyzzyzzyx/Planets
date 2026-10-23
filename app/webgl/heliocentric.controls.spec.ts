import * as THREE from 'three';
import { Planet } from '../galaxy/planet.model';
import { Star } from '../galaxy/star.model';
import { HeliocentricControls, MAX_MOVEMENT_SPEED, MIN_MOVEMENT_SPEED } from './heliocentric.controls';

describe('HeliocentricControls', () => {
  let camera: THREE.PerspectiveCamera;
  let canvas: HTMLCanvasElement;
  let controls: HeliocentricControls;

  const lock = (locked: boolean) => {
    Object.defineProperty(document, 'pointerLockElement', { configurable: true, get: () => (locked ? canvas : null) });
    document.dispatchEvent(new Event('pointerlockchange'));
  };
  const key = (type: 'keydown' | 'keyup', code: string) => document.dispatchEvent(new KeyboardEvent(type, { code }));

  beforeEach(() => {
    camera = new THREE.PerspectiveCamera();
    canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    controls = new HeliocentricControls(camera, canvas);
  });
  afterEach(() => {
    controls.dispose();
    lock(false);
    canvas.remove();
  });

  it('makes the canvas focusable', () => {
    expect(canvas.tabIndex).toBe(0);
  });

  it('tracks pointer-lock state', () => {
    expect(controls.locked).toBe(false);
    lock(true);
    expect(controls.locked).toBe(true);
    lock(false);
    expect(controls.locked).toBe(false);
  });

  it('only moves while locked, in the camera frame, scaled by speed and delta', () => {
    key('keydown', 'KeyW');
    controls.update(1);
    expect(camera.position.z).toBe(0);
    lock(true);
    controls.update(0.5);
    expect(camera.position.z).toBeCloseTo(-1500);
    key('keydown', 'ShiftLeft');
    controls.update(0.1);
    expect(camera.position.z).toBeCloseTo(-1500 - 3000);
  });

  it('combines axes and normalises diagonal movement', () => {
    lock(true);
    key('keydown', 'KeyD');
    key('keydown', 'KeyR');
    controls.update(1);
    expect(camera.position.length()).toBeCloseTo(3000);
    expect(camera.position.x).toBeGreaterThan(0);
    expect(camera.position.y).toBeGreaterThan(0);
  });

  it('releases held keys when pointer lock ends (no runaway flight)', () => {
    lock(true);
    key('keydown', 'KeyW');
    lock(false);
    lock(true);
    controls.update(1);
    expect(camera.position.z).toBe(0);
    expect(controls.isPressed('KeyW')).toBe(false);
  });

  it('applies mouse look with pitch clamped to ±90°', () => {
    lock(true);
    controls.applyLookDelta(0, -10_000);
    const euler = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
    expect(euler.x).toBeCloseTo(Math.PI / 2);
    document.dispatchEvent(new MouseEvent('mousemove', { movementX: 100 } as MouseEventInit));
  });

  it('clamps movement speed adjustments', () => {
    controls.adjustMovementSpeed(1000);
    expect(controls.baseMovementSpeed).toBe(MAX_MOVEMENT_SPEED);
    for (let i = 0; i < 200; i++) controls.adjustMovementSpeed(-0.5);
    expect(controls.baseMovementSpeed).toBe(MIN_MOVEMENT_SPEED);
  });

  it('slows down near massive bodies', () => {
    const star = new Star({ name: 'Sun', type: 'star', diameter: 10 });
    const jupiter = new Planet({ name: 'Jupiter', type: 'planet', diameter: 14, au: 1, period: 4333 });
    jupiter.mass = 1.9e27;
    star.addSatellite(jupiter);
    jupiter.setAngle(0);
    star.group.updateMatrixWorld(true);
    controls.setStar(star);
    camera.position.set(1500, 0, 0);
    controls.updateSpeedScale();
    expect(controls.movementSpeed).toBeCloseTo(controls.baseMovementSpeed * 0.2);
    controls.setStar(null);
    controls.updateSpeedScale();
    expect(controls.movementSpeed).toBe(controls.baseMovementSpeed);
  });

  it('measures velocity for any camera motion, not only flight', () => {
    vi.spyOn(performance, 'now').mockReturnValueOnce(1000).mockReturnValueOnce(2000);
    controls = new HeliocentricControls(camera, canvas);
    camera.position.set(500, 0, 0);
    controls.update(1);
    expect(controls.velocity).toBeCloseTo(500);
  });

  it('toggle()/enterFlight() request pointer lock and survive rejection', async () => {
    const request = vi.fn(() => Promise.reject(new Error('denied')));
    (canvas as unknown as { requestPointerLock: unknown }).requestPointerLock = request;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    controls.toggle();
    await Promise.resolve();
    await Promise.resolve();
    expect(request).toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it('dispose() removes document listeners', () => {
    controls.dispose();
    lock(true);
    expect(controls.locked).toBe(false);
  });
});
