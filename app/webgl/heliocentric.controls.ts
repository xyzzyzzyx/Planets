import * as THREE from 'three';
import type { CelestialBody } from '../galaxy/celestial.model';
import type { Star } from '../galaxy/star.model';
import { CAM_SPEED_DEFAULT, CAM_SPEED_MAX, CAM_SPEED_MIN } from '../utils/speed';

/** Camera speed limits (scene units / s); shared with the dashboard slider. */
export const MIN_MOVEMENT_SPEED = CAM_SPEED_MIN;
export const MAX_MOVEMENT_SPEED = CAM_SPEED_MAX;

/**
 * First-person "flight" controls using pointer lock: WASD/arrows to move,
 * R/F up/down, Shift for 10× boost, mouse to look. Movement slows near
 * massive bodies.
 */
export class HeliocentricControls {
  baseMovementSpeed = CAM_SPEED_DEFAULT;
  movementSpeed = CAM_SPEED_DEFAULT;
  lookSpeed = 0.002;
  velocity = 0;

  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly keys: Record<string, boolean> = {};
  private isLocked = false;
  private readonly lastPos = new THREE.Vector3();
  private lastTime = 0;
  private starRef: Star | null = null;

  private readonly onMouseMove = (e: MouseEvent): void => {
    if (this.isLocked) this.applyLookDelta(e.movementX, e.movementY);
  };
  private readonly onLockChange = (): void => {
    this.isLocked = this.doc.pointerLockElement === this.domElement;
    if (!this.isLocked) this.releaseKeys();
  };
  private readonly onKeyDown = (e: KeyboardEvent): void => { this.keys[e.code] = true; };
  private readonly onKeyUp = (e: KeyboardEvent): void => { this.keys[e.code] = false; };
  private readonly onBlur = (): void => this.releaseKeys();

  constructor(
    private readonly camera: THREE.Camera,
    private readonly domElement: HTMLElement,
    private readonly doc: Document = domElement.ownerDocument ?? document,
  ) {
    this.euler.setFromQuaternion(camera.quaternion);
    this.doc.addEventListener('pointerlockchange', this.onLockChange);
    this.doc.addEventListener('mousemove', this.onMouseMove);
    this.doc.addEventListener('keydown', this.onKeyDown);
    this.doc.addEventListener('keyup', this.onKeyUp);
    this.doc.defaultView?.addEventListener('blur', this.onBlur);
    this.domElement.tabIndex = 0;
    this.domElement.style.outline = 'none';
    this.lastPos.copy(camera.position);
    this.lastTime = performance.now();
  }

  setStar(star: Star | null): void { this.starRef = star; }
  get locked(): boolean { return this.isLocked; }

  enterFlight(): void {
    if (this.isLocked) return;
    this.domElement.focus();
    try {
      const result = this.domElement.requestPointerLock?.() as unknown;
      if (result instanceof Promise) result.catch(() => console.warn('Pointer lock not allowed right now.'));
    } catch {
      console.warn('Pointer lock not allowed right now.');
    }
  }

  exitFlight(): void {
    if (this.doc.pointerLockElement) this.doc.exitPointerLock();
  }

  toggle(): void {
    if (this.isLocked) this.exitFlight();
    else this.enterFlight();
  }

  /** Multiply the base speed by (1 + delta), clamped to the allowed range. */
  adjustMovementSpeed(delta: number): void {
    this.baseMovementSpeed = Math.max(MIN_MOVEMENT_SPEED, Math.min(MAX_MOVEMENT_SPEED, this.baseMovementSpeed * (1 + delta)));
    this.updateSpeedScale();
  }

  /** Movement slows down (to 20%) near heavy bodies so they can be approached. */
  updateSpeedScale(): void {
    this.movementSpeed = this.baseMovementSpeed;
    if (!this.starRef) return;
    const camPos = this.camera.position;
    const pos = new THREE.Vector3();
    let nearestMass = 0;
    let nearestDistSq = Infinity;
    for (const body of this.starRef.descendants() as Iterable<CelestialBody>) {
      if (body === this.starRef) continue;
      const d2 = camPos.distanceToSquared(body.getWorldPosition(pos));
      if (d2 < nearestDistSq) {
        nearestDistSq = d2;
        nearestMass = body.mass || 0;
      }
    }
    this.movementSpeed = this.baseMovementSpeed * Math.max(0.2, Math.min(1, 1 / (1 + nearestMass / 1e24)));
  }

  update(delta: number): void {
    const now = performance.now();
    if (this.isLocked) {
      this.updateSpeedScale();
      const boost = this.keys['ShiftLeft'] || this.keys['ShiftRight'] ? 10 : 1;
      const dir = new THREE.Vector3(
        (this.keys['KeyD'] || this.keys['ArrowRight'] ? 1 : 0) - (this.keys['KeyA'] || this.keys['ArrowLeft'] ? 1 : 0),
        (this.keys['KeyR'] ? 1 : 0) - (this.keys['KeyF'] ? 1 : 0),
        (this.keys['KeyS'] || this.keys['ArrowDown'] ? 1 : 0) - (this.keys['KeyW'] || this.keys['ArrowUp'] ? 1 : 0),
      );
      if (dir.lengthSq() > 0) {
        dir.normalize().multiplyScalar(this.movementSpeed * boost * delta);
        this.camera.translateX(dir.x);
        this.camera.translateY(dir.y);
        this.camera.translateZ(dir.z);
      }
    }
    // Velocity is measured for every kind of camera motion (flight, animations, routes).
    const dt = Math.max(0.001, (now - this.lastTime) / 1000);
    this.velocity = this.camera.position.distanceTo(this.lastPos) / dt;
    this.lastPos.copy(this.camera.position);
    this.lastTime = now;
  }

  syncEuler(): void { this.euler.setFromQuaternion(this.camera.quaternion); }

  applyLookDelta(dx: number, dy: number): void {
    this.euler.y -= dx * this.lookSpeed;
    this.euler.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.euler.x - dy * this.lookSpeed));
    this.camera.quaternion.setFromEuler(this.euler);
  }

  isPressed(code: string): boolean {
    return !!this.keys[code];
  }

  private releaseKeys(): void {
    for (const k of Object.keys(this.keys)) this.keys[k] = false;
  }

  dispose(): void {
    this.doc.removeEventListener('pointerlockchange', this.onLockChange);
    this.doc.removeEventListener('mousemove', this.onMouseMove);
    this.doc.removeEventListener('keydown', this.onKeyDown);
    this.doc.removeEventListener('keyup', this.onKeyUp);
    this.doc.defaultView?.removeEventListener('blur', this.onBlur);
  }
}
