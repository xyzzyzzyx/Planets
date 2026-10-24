import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { Subscription } from 'rxjs';
import * as THREE from 'three';

import { MAX_ECCENTRICITY, trueAnomalyAt, trueAnomalyFromEccentric } from '../../shared/orbital';
import { CelestialBody, OrbitingBody, RingConfig, SIMULATION_CONSTANTS, StarConfig } from '../galaxy/celestial.model';
import { BlackHole } from '../galaxy/black-hole';
import { Comet } from '../galaxy/comet.model';
import { GALAXY_ORIENTATION, GalacticOrbit } from '../galaxy/galactic-orbit';
import { GALAXY_SCALE, GalaxyFactory } from '../galaxy/galaxy.factory';
import { Galaxy } from '../galaxy/galaxy.model';
import { Moon } from '../galaxy/moon.model';
import { SatelliteConfig, StarFactory, keplerianRingAngle } from '../galaxy/star.factory';
import { Star } from '../galaxy/star.model';
import { BodyData, PlanetsSnapshot, ServerMessage, TransitionReason } from '../utils/protocol';
import { SseService } from '../utils/sse.service';
import { SIM_SPEED_MIN } from '../utils/speed';
import { WebSocketService } from '../utils/websocket.service';
import { removeAndDispose } from './dispose';
import { HeliocentricControls } from './heliocentric.controls';
import { Grid } from './tools/grid';
import { Spectrometer } from './tools/spectrometer';
import { Tracer } from './tools/tracer';
import {
  BodySnapshot,
  CameraInfo,
  CameraView,
  ICelestialRenderer,
  NavigationMode,
  NavigationRoute,
  SystemSnapshot,
} from './webgl.interface';

export { CameraView, NavigationMode } from './webgl.interface';
export type { BodySnapshot, CameraInfo, NavigationRoute, NavigationWaypoint, SystemSnapshot } from './webgl.interface';

/** Keys used to persist view preferences in localStorage. */
export const STORAGE_KEYS = {
  camera: 'helio_cam',
  navMode: 'helio_navMode',
  planetOrbits: 'helio_planetOrbits',
  moonOrbits: 'helio_moonOrbits',
  cometOrbits: 'helio_cometOrbits',
  coordinateGrids: 'helio_coordinateGrids',
  magneticFields: 'helio_magneticFields',
  graphMode: 'helio_graphMode',
  spectroscopyMode: 'helio_spectroscopyMode',
  verifyMode: 'helio_verifyMode',
  tracers: 'helio_tracers',
} as const;

/** The `+` key doubles the speed up to this value (the slider goes much higher). */
export const MAX_KEYBOARD_SIM_SPEED = 10_000;
/** Largest simulated time step (ms) applied to ring rotation per frame. */
export const MAX_RING_STEP_MS = 500;

const OUTER_AU = 30.07;
const OUTER_SCENE = OUTER_AU * SIMULATION_CONSTANTS.SCALE_UNITS_PER_AU;

export const CAMERA_PRESETS: Readonly<Record<CameraView, { pos: THREE.Vector3; up: THREE.Vector3 }>> = {
  [CameraView.OVERVIEW]: { pos: new THREE.Vector3(0, OUTER_SCENE * 2, OUTER_SCENE * 2), up: new THREE.Vector3(0, 1, 0) },
  [CameraView.ECLIPTIC]: { pos: new THREE.Vector3(OUTER_SCENE * 2.4, OUTER_SCENE * 0.15, 0), up: new THREE.Vector3(0, 0, 1) },
  [CameraView.CINEMATIC]: { pos: new THREE.Vector3(OUTER_SCENE * 0.8, OUTER_SCENE * 0.6, OUTER_SCENE * 2.0), up: new THREE.Vector3(0, 1, 0) },
};

function safeStorage(kind: 'localStorage' | 'sessionStorage'): Storage | null {
  try { return globalThis[kind] ?? null; } catch { return null; }
}
function readBool(key: string): boolean {
  try { return safeStorage('localStorage')?.getItem(key) === 'true'; } catch { return false; }
}
function writeValue(key: string, value: string, kind: 'localStorage' | 'sessionStorage' = 'localStorage'): void {
  try { safeStorage(kind)?.setItem(key, value); } catch { /* quota / privacy mode */ }
}

/** Centroid and radius of the smallest centroid-centred sphere containing every point. */
export function boundingSphere(positions: readonly THREE.Vector3[]): { centroid: THREE.Vector3; maxRadius: number } {
  const centroid = new THREE.Vector3();
  if (positions.length === 0) return { centroid, maxRadius: 0 };
  for (const p of positions) centroid.add(p);
  centroid.divideScalar(positions.length);
  let maxRadius = 0;
  for (const p of positions) maxRadius = Math.max(maxRadius, centroid.distanceTo(p));
  return { centroid, maxRadius };
}

/** Find the celestial body an Object3D belongs to by walking up to its body group. */
export function resolveBody(object: THREE.Object3D | null | undefined): CelestialBody | null {
  for (let obj = object ?? null; obj; obj = obj.parent) {
    const body = obj.userData?.['body'];
    if (body instanceof CelestialBody) return body;
  }
  return null;
}

/** Ease-in-out quadratic. */
export const easeInOutQuad = (t: number): number => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
/** Ease-out cubic. */
export const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);

/** True when a keyboard event targets a text-entry element (shortcuts should not fire). */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}

interface CameraAnimation {
  fromPos: THREE.Vector3; toPos: THREE.Vector3;
  lookAt: THREE.Vector3;
  fromUp: THREE.Vector3; toUp: THREE.Vector3;
  startMs: number; durationMs: number;
}

/**
 * Owns the three.js scene: builds the solar system from server snapshots,
 * applies orbital updates, and drives camera navigation.
 */
@Injectable({ providedIn: 'root' })
export class WebGl implements ICelestialRenderer {
  private readonly galaxyFactory = inject(GalaxyFactory);
  private readonly starFactory = inject(StarFactory);
  private readonly sseService = inject(SseService);
  private readonly wsService = inject(WebSocketService);

  readonly scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera | undefined;
  renderer: THREE.WebGLRenderer | undefined;
  galaxy: Galaxy | null = null;
  star: Star | null = null;
  /**
   * Frame anchored at the galactic core (the black hole at the centre of the
   * spiral). The active star stays at the scene origin so cameras, the minimap
   * and orbit lines remain star-relative; its revolution around the core is
   * shown by moving this frame (and the galaxy backdrop) the opposite way.
   */
  readonly galacticFrame = new THREE.Group();
  readonly galacticOrbit = new GalacticOrbit();
  blackHole: BlackHole | null = null;
  selectable: THREE.Object3D[] = [];
  active = false;

  selectedNames = new Set<string>();
  onSelectionChanged?: (names: Set<string>) => void;

  // ── Reactive UI state ─────────────────────────────────────────────────────
  readonly isReady = signal(false);
  readonly loadingStage = signal('Connecting to server…');
  readonly loadingOverlay = signal(false);
  readonly simulationSpeed = signal(1);
  readonly lastServerUpdate = signal(0);
  /** Largest client-vs-server position discrepancy (scene units) while verify mode is on. */
  readonly maxVerificationError = signal(0);

  private _simulationTime = Date.now();
  get simulationTime(): number { return this._simulationTime; }
  set simulationTime(v: number) {
    if (!Number.isFinite(v)) return;
    this._simulationTime = v;
  }

  get simulationDate(): Date {
    const date = new Date(this._simulationTime);
    return Number.isNaN(date.getTime()) ? new Date() : date;
  }

  get selectedPlanetName(): string | null {
    return this.selectedNames.size > 0 ? [...this.selectedNames][this.selectedNames.size - 1] : null;
  }

  // ── Display toggles (persisted) ───────────────────────────────────────────
  showPlanetOrbits = readBool(STORAGE_KEYS.planetOrbits);
  showMoonOrbits = readBool(STORAGE_KEYS.moonOrbits);
  showCometOrbits = readBool(STORAGE_KEYS.cometOrbits);
  showCoordinateGrids = readBool(STORAGE_KEYS.coordinateGrids);
  showMagneticFields = readBool(STORAGE_KEYS.magneticFields);
  graphMode = readBool(STORAGE_KEYS.graphMode);
  spectroscopyMode = readBool(STORAGE_KEYS.spectroscopyMode);
  verifyMode = readBool(STORAGE_KEYS.verifyMode);
  showTracers = readBool(STORAGE_KEYS.tracers);
  readonly verificationErrors = new Map<string, number>();

  navMode: NavigationMode;

  readonly navRoute: NavigationRoute = { waypoints: [], loop: false, active: false, currentIndex: 0, progress: 0, orbitRemaining: 0 };

  private grid: Grid | null = null;
  private spectrometer: Spectrometer | null = null;
  private tracer: Tracer | null = null;
  private readonly starGalacticPos = new THREE.Vector3();
  private navPathLine: THREE.Line | null = null;
  private readonly navRouteFromPos = new THREE.Vector3();
  private readonly navRouteTravelSpeed = 2000;
  private navOrbitAngle = 0;
  private navOrbitRadius = 0;
  private readonly navOrbitCenter = new THREE.Vector3();

  private currentBodyIndex = -1;
  private currentMoonIndex = -1;
  private currentRingIndex = -1;

  private readonly timer = new THREE.Timer();
  private _controls: HeliocentricControls | undefined;
  private readonly planetOrbitLines = new Map<string, THREE.LineLoop>();
  private readonly moonOrbitLines = new Map<string, THREE.LineLoop>();
  private readonly cometOrbitLines = new Map<string, THREE.LineLoop>();

  private lastSimTime: number | undefined;
  private cameraAnim: CameraAnimation | null = null;
  private cinematicFollow = { active: false, bodyName: '', worldOffset: new THREE.Vector3() };
  private cinematicTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSaveMs = 0;
  private rafId = 0;
  private buildToken = 0;
  private pendingTransition: TransitionReason | null = null;
  private readonly subscriptions = new Subscription();
  private readonly raycaster = new THREE.Raycaster();
  private readonly onWheel = (e: WheelEvent): void => {
    if (this.navMode === NavigationMode.CINEMATIC && this.cinematicFollow.active) {
      this.cinematicFollow.worldOffset.multiplyScalar(e.deltaY > 0 ? 1.1 : 0.9);
      e.preventDefault();
    }
  };

  /** Renderer factory seam (tests substitute a stub; WebGL is unavailable in jsdom). */
  createRenderer: () => THREE.WebGLRenderer = () => new THREE.WebGLRenderer({ antialias: true });

  constructor() {
    const saved = safeStorage('localStorage')?.getItem(STORAGE_KEYS.navMode) as NavigationMode | null;
    this.navMode = saved && Object.values(NavigationMode).includes(saved) ? saved : NavigationMode.DISCOVERY;
    inject(DestroyRef).onDestroy(() => this.dispose());
  }

  get controls(): HeliocentricControls | undefined { return this._controls; }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  init(height: number, width: number): void {
    if (this.renderer) return;
    const renderer = this.createRenderer();
    this.renderer = renderer;
    renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2));
    renderer.setSize(width, height);
    renderer.setClearColor(0x000011, 1);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap; // PCFSoftShadowMap was removed in r18x
    renderer.domElement.addEventListener('wheel', this.onWheel, { passive: false });

    this.camera = new THREE.PerspectiveCamera(45, width / Math.max(1, height), 0.1, 2_000_000);
    const overview = CAMERA_PRESETS[CameraView.OVERVIEW];
    this.camera.position.copy(overview.pos);
    this.camera.up.copy(overview.up);
    this.camera.lookAt(0, 0, 0);
    this.restoreCameraState();
    this.scene.add(this.camera);

    this._controls = new HeliocentricControls(this.camera, renderer.domElement);
    this.scene.add(new THREE.AmbientLight(0xaaaaaa, 0.6));

    const skyUrls = ['galaxy_rit.png', 'galaxy_lft.png', 'galaxy_top.png', 'galaxy_btm.png', 'galaxy_frn.png', 'galaxy_bak.png']
      .map((f) => `/images/skybox/${f}`);
    new THREE.CubeTextureLoader().load(skyUrls, (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      this.scene.background = tex;
    });

    this.grid = new Grid(this.scene);
    this.spectrometer = new Spectrometer(this.scene);
    this.grid.setVisible(this.graphMode);
    this.spectrometer.setVisible(this.spectroscopyMode);

    this.galacticFrame.name = 'galacticFrame';
    this.scene.add(this.galacticFrame);
    this.tracer = new Tracer(
      this.galacticFrame,
      (t, target) => this.galacticOrbit.starPositionAt(t, target),
      () => this.galacticOrbit.periodMs,
    );
    this.tracer.setVisible(this.showTracers);
    this.tracer.setIncludeMoons(this.showMoonOrbits);
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.loadPlanets();
    this.observePlanets();
    this.timer.reset();
    this.rafId = requestAnimationFrame(this.animate);
  }

  /** Stop rendering and release all GPU resources. */
  dispose(): void {
    cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    if (this.cinematicTimer) clearTimeout(this.cinematicTimer);
    this.subscriptions.unsubscribe();
    this.clearSolarSystem();
    if (this.galaxy) removeAndDispose(this.galaxy.points);
    this.galaxy = null;
    this.blackHole?.dispose();
    this.blackHole = null;
    this.tracer?.dispose();
    this.tracer = null;
    this.galacticFrame.removeFromParent();
    this.grid?.dispose();
    this.spectrometer?.dispose();
    removeAndDispose(this.navPathLine);
    this.navPathLine = null;
    this._controls?.dispose();
    this.renderer?.domElement.removeEventListener('wheel', this.onWheel);
    this.renderer?.dispose();
    this.active = false;
  }

  isActive(): boolean { return this.active; }
  getRenderer(): THREE.WebGLRenderer | undefined { return this.renderer; }
  getCamera(): THREE.PerspectiveCamera | undefined { return this.camera; }

  resize(height: number, width: number): void {
    if (!this.renderer || !this.camera || height <= 0 || width <= 0) return;
    this.renderer.setSize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  // ── Queries ───────────────────────────────────────────────────────────────

  findBodyByName(name: string | null | undefined): CelestialBody | null {
    return name && this.star ? this.star.findBody(name) : null;
  }

  getWorldPos(body: CelestialBody | null | undefined, target = new THREE.Vector3()): THREE.Vector3 {
    return body ? body.getWorldPosition(target) : target.set(0, 0, 0);
  }

  getCameraInfo(): CameraInfo {
    return {
      position: this.camera?.position.clone() ?? new THREE.Vector3(),
      direction: this.camera?.getWorldDirection(new THREE.Vector3()) ?? new THREE.Vector3(0, 0, -1),
      velocity: this._controls?.velocity ?? 0,
    };
  }

  getSystemSnapshot(): SystemSnapshot {
    const bodies: BodySnapshot[] = [];
    if (this.star) {
      bodies.push({ name: this.star.name, x: 0, y: 0, color: this.star.config.color || '#ffcc44', au: 0, isStar: true });
      const pos = new THREE.Vector3();
      for (const body of this.star.satellites) {
        body.getWorldPosition(pos);
        bodies.push({
          name: body.name, x: pos.x, y: pos.z,
          color: body.config.color || '#aaaaff',
          au: (body.config as { au?: number }).au ?? 0,
          isStar: false,
        });
      }
    }
    // Ecliptic projection: snapshot "y" is world Z for bodies and camera alike.
    const cam = this.camera?.position ?? new THREE.Vector3();
    return { bodies, camera: { x: cam.x, y: cam.z, z: cam.y } };
  }

  /** Signed angle (radians) between camera and body as seen from the star, for HUD indicators. */
  getBodyPhaseAngle(bodyName: string): number {
    const body = this.findBodyByName(bodyName);
    if (!body || !this.camera || !(body instanceof OrbitingBody)) return 0;
    const bodyPos = body.getWorldPosition();
    const camPos = this.camera.position;
    let diff = Math.atan2(camPos.z, camPos.x) - Math.atan2(bodyPos.z, bodyPos.x);
    diff = ((diff % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    return diff > Math.PI ? diff - 2 * Math.PI : diff;
  }

  /**
   * Heading of the camera projected onto the ecliptic, as a clockwise canvas
   * rotation for the minimap arrow (0 = +Z, which the minimap draws "up").
   */
  getCameraAzimuth(): number {
    if (!this.camera) return 0;
    const dir = this.camera.getWorldDirection(new THREE.Vector3());
    return Math.atan2(dir.x, dir.z);
  }

  getSelectionHierarchyLabels(): string[] {
    if (!this.star || this.selectedNames.size === 0) return [];
    const result: string[] = [];
    if (this.selectedNames.has(this.star.name)) result.push(this.star.name);
    const sorted = [...this.star.satellites].sort((a, b) => ((a.config as { au?: number }).au ?? 0) - ((b.config as { au?: number }).au ?? 0));
    for (const planet of sorted) {
      if (this.selectedNames.has(planet.name)) result.push(planet.name);
      for (const moon of planet.satellites) if (this.selectedNames.has(moon.name)) result.push(`↳ ${moon.name}`);
    }
    return result;
  }

  // ── Simulation control ────────────────────────────────────────────────────

  setSimulationSpeed(speed: number): void {
    if (!Number.isFinite(speed)) return;
    this.simulationSpeed.set(speed);
    this.wsService.sendSpeed(speed);
  }

  resetSimulation(): void {
    this.wsService.sendReset();
    this.lastSimTime = undefined;
  }

  jumpToDate(targetMs: number): void {
    if (!Number.isFinite(targetMs)) return;
    this.loadingOverlay.set(true);
    this.loadingStage.set('Jumping to exact date…');
    this.wsService.sendJumpToDate(targetMs);
  }

  jumpToRandomStar(): void {
    this.loadingOverlay.set(true);
    this.loadingStage.set('Generating new star system…');
    this.wsService.sendTravelToRandom();
  }

  // ── Selection ─────────────────────────────────────────────────────────────

  private emitSelection(): void {
    this.onSelectionChanged?.(new Set(this.selectedNames));
  }

  setHighlight(name: string, visible: boolean): void {
    const body = this.findBodyByName(name);
    if (body?.highlight) body.highlight.visible = visible;
  }

  selectBodies(names: readonly string[], navigate = true): void {
    for (const prev of this.selectedNames) this.setHighlight(prev, false);
    this.selectedNames.clear();
    for (const name of names) {
      if (!this.findBodyByName(name)) continue;
      this.selectedNames.add(name);
      this.setHighlight(name, true);
    }
    if (navigate && this.selectedNames.size > 0) {
      if (this.selectedNames.size === 1) this.navigateToPlanet([...this.selectedNames][0]);
      else this.navigateToSelection();
    }
    this.emitSelection();
  }

  toggleSelection(name: string): void {
    if (this.selectedNames.has(name)) {
      this.selectedNames.delete(name);
      this.setHighlight(name, false);
    } else if (this.findBodyByName(name)) {
      this.selectedNames.add(name);
      this.setHighlight(name, true);
    }
    this.emitSelection();
  }

  clearSelection(): void {
    for (const name of this.selectedNames) this.setHighlight(name, false);
    this.selectedNames.clear();
    this.cinematicFollow.active = false;
    this.emitSelection();
  }

  handleCanvasClick(event: Pick<MouseEvent, 'clientX' | 'clientY'>, multiselect = false): void {
    if (!this.camera || !this.renderer || this.selectable.length === 0) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const mouse = new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(mouse, this.camera);
    const hit = this.raycaster.intersectObjects(this.selectable, false)[0];
    if (!hit) {
      if (!multiselect) this.clearSelection();
      return;
    }
    const body = resolveBody(hit.object);
    if (!body) return;

    if (multiselect) {
      this.toggleSelection(body.name);
      if (this.selectedNames.size > 1) this.navigateToSelection();
    } else {
      this.selectBodies([body.name], this.navMode === NavigationMode.CINEMATIC);
    }
  }

  selectInRect(start: { x: number; y: number }, end: { x: number; y: number }, additive: boolean): void {
    if (!this.camera || !this.renderer || !this.star) return;
    const minX = Math.min(start.x, end.x), maxX = Math.max(start.x, end.x);
    const minY = Math.min(start.y, end.y), maxY = Math.max(start.y, end.y);
    const W = this.renderer.domElement.clientWidth;
    const H = this.renderer.domElement.clientHeight;

    const inside: string[] = [];
    const pos = new THREE.Vector3();
    for (const body of this.star.descendants()) {
      body.getWorldPosition(pos).project(this.camera);
      if (pos.z > 1) continue; // behind the camera
      const x = ((pos.x + 1) / 2) * W;
      const y = (1 - (pos.y + 1) / 2) * H;
      if (x >= minX && x <= maxX && y >= minY && y <= maxY) inside.push(body.name);
    }

    if (!additive) {
      for (const name of this.selectedNames) this.setHighlight(name, false);
      this.selectedNames.clear();
    }
    for (const name of inside) {
      this.selectedNames.add(name);
      this.setHighlight(name, true);
    }
    this.emitSelection();
    if (this.selectedNames.size > 0) this.navigateToSelection();
  }

  selectNextBody(): void {
    const bodies = this.star?.satellites ?? [];
    if (bodies.length === 0) return;
    this.currentBodyIndex = (this.currentBodyIndex + 1) % bodies.length;
    this.selectBodies([bodies[this.currentBodyIndex].name], true);
  }

  selectNextMoon(): void {
    const moons = this.star?.satellites.flatMap((p) => p.satellites) ?? [];
    if (moons.length === 0) return;
    this.currentMoonIndex = (this.currentMoonIndex + 1) % moons.length;
    this.selectBodies([moons[this.currentMoonIndex].name], true);
  }

  /** Cycle through rings/belts, flying to the body that owns each. */
  selectNextRing(): string | null {
    const rings: THREE.Object3D[] = [];
    this.star?.group.traverse((obj) => { if (obj.name.startsWith('ring_')) rings.push(obj); });
    if (rings.length === 0) return null;
    this.currentRingIndex = (this.currentRingIndex + 1) % rings.length;
    const ring = rings[this.currentRingIndex];
    const owner = resolveBody(ring);
    if (owner) this.selectBodies([owner.name], true);
    return ring.name;
  }

  // ── Display toggles ───────────────────────────────────────────────────────

  toggleShowPlanetOrbits(): void {
    this.showPlanetOrbits = !this.showPlanetOrbits;
    writeValue(STORAGE_KEYS.planetOrbits, String(this.showPlanetOrbits));
    for (const line of this.planetOrbitLines.values()) line.visible = this.showPlanetOrbits;
  }

  toggleShowCometOrbits(): void {
    this.showCometOrbits = !this.showCometOrbits;
    writeValue(STORAGE_KEYS.cometOrbits, String(this.showCometOrbits));
    for (const line of this.cometOrbitLines.values()) line.visible = this.showCometOrbits;
  }

  toggleShowMoonOrbits(): void {
    this.showMoonOrbits = !this.showMoonOrbits;
    writeValue(STORAGE_KEYS.moonOrbits, String(this.showMoonOrbits));
    for (const line of this.moonOrbitLines.values()) line.visible = this.showMoonOrbits;
    this.tracer?.setIncludeMoons(this.showMoonOrbits); // moon trails follow the Moons toggle
  }

  toggleGraphMode(): void {
    this.graphMode = !this.graphMode;
    writeValue(STORAGE_KEYS.graphMode, String(this.graphMode));
    this.grid?.setVisible(this.graphMode);
  }

  toggleSpectroscopyMode(): void {
    this.spectroscopyMode = !this.spectroscopyMode;
    writeValue(STORAGE_KEYS.spectroscopyMode, String(this.spectroscopyMode));
    this.spectrometer?.setVisible(this.spectroscopyMode);
  }

  toggleShowCoordinateGrids(): void {
    this.showCoordinateGrids = !this.showCoordinateGrids;
    writeValue(STORAGE_KEYS.coordinateGrids, String(this.showCoordinateGrids));
    this.applyBodyOverlays();
  }

  toggleShowMagneticFields(): void {
    this.showMagneticFields = !this.showMagneticFields;
    writeValue(STORAGE_KEYS.magneticFields, String(this.showMagneticFields));
    this.applyBodyOverlays();
  }

  /** Tracer: fading trails behind every body as it travels around the galactic core. */
  toggleTracers(): void {
    this.showTracers = !this.showTracers;
    writeValue(STORAGE_KEYS.tracers, String(this.showTracers));
    this.tracer?.setVisible(this.showTracers);
    if (this.showTracers) this.tracer?.update(this.simulationTime);
  }

  /** The active tracer (null before init). */
  get tracers(): Tracer | null {
    return this.tracer;
  }

  /** World position of the galactic core / black hole. */
  getGalacticCorePosition(target = new THREE.Vector3()): THREE.Vector3 {
    return target.copy(this.galacticFrame.position);
  }

  toggleVerifyMode(): void {
    this.verifyMode = !this.verifyMode;
    writeValue(STORAGE_KEYS.verifyMode, String(this.verifyMode));
    this.verificationErrors.clear();
    this.maxVerificationError.set(0);
  }

  private applyBodyOverlays(): void {
    if (!this.star) return;
    for (const body of this.star.descendants()) {
      if (body.latLongGroup) body.latLongGroup.visible = this.showCoordinateGrids;
      if (body.magneticFieldGroup) body.magneticFieldGroup.visible = this.showMagneticFields;
    }
  }

  // ── Camera ────────────────────────────────────────────────────────────────

  setNavigationMode(mode: NavigationMode): void {
    this.navMode = mode;
    this.cinematicFollow.active = false;
    writeValue(STORAGE_KEYS.navMode, mode);

    switch (mode) {
      case NavigationMode.DISCOVERY:
        this.moveCameraTo(CAMERA_PRESETS[CameraView.OVERVIEW].pos, new THREE.Vector3(), new THREE.Vector3(0, 1, 0), 2000);
        break;
      case NavigationMode.CINEMATIC:
        if (this.selectedPlanetName) this.navigateToPlanet(this.selectedPlanetName, 2000);
        else this.moveCameraTo(CAMERA_PRESETS[CameraView.CINEMATIC].pos, new THREE.Vector3(), new THREE.Vector3(0, 1, 0), 2000);
        break;
      case NavigationMode.FASTEST_TRAVEL:
        this.updateNavPathLine();
        break;
      default:
        break;
    }
    if (mode !== NavigationMode.FASTEST_TRAVEL && this.navPathLine) this.navPathLine.visible = false;
  }

  moveCameraTo(toPos: THREE.Vector3, lookAt = new THREE.Vector3(), toUp = new THREE.Vector3(0, 1, 0), durationMs = 1800): void {
    if (!this.camera) return;
    this.cameraAnim = {
      fromPos: this.camera.position.clone(), toPos: toPos.clone(),
      lookAt: lookAt.clone(),
      fromUp: this.camera.up.clone(), toUp: toUp.clone(),
      startMs: performance.now(), durationMs: Math.max(0, durationMs),
    };
    if (durationMs <= 0) this.tickCameraAnim();
  }

  setCameraView(view: CameraView, durationMs = 2000): void {
    const preset = CAMERA_PRESETS[view];
    this.cinematicFollow.active = false;
    this.moveCameraTo(preset.pos, new THREE.Vector3(), preset.up, durationMs);
  }

  navigateToPlanet(bodyName: string, durationMs = 2200): void {
    if (this.navMode === NavigationMode.FASTEST_TRAVEL) {
      this.addNavWaypointBody(bodyName);
      return;
    }
    const target = this.findBodyByName(bodyName);
    if (!target || !this.camera) return;

    const targetPos = target.getWorldPosition();
    const diameter = target.config.diameter ?? 2;
    const { centroid, maxRadius } = boundingSphere([targetPos, ...target.satellites.map((m) => m.getWorldPosition())]);
    this.cinematicFollow.active = false;
    if (this.cinematicTimer) clearTimeout(this.cinematicTimer);

    if (this.navMode === NavigationMode.CINEMATIC) {
      const radial = targetPos.clone();
      if (radial.lengthSq() < 0.001) radial.set(1, 0, 0);
      radial.normalize();
      const viewDist = Math.max(maxRadius * 4.0, diameter * 50, 1000);
      const camPos = centroid.clone().addScaledVector(radial, viewDist * 0.4).add(new THREE.Vector3(0, viewDist * 0.3, viewDist * 0.7));
      this.moveCameraTo(camPos, centroid, new THREE.Vector3(0, 1, 0), durationMs);
      this.cinematicTimer = setTimeout(() => {
        this.cinematicTimer = null;
        if (this.navMode !== NavigationMode.CINEMATIC || !this.camera) return;
        const fresh = this.findBodyByName(bodyName);
        if (!fresh) return;
        this.cinematicFollow = { active: true, bodyName, worldOffset: this.camera.position.clone().sub(fresh.getWorldPosition()) };
      }, durationMs + 50);
      return;
    }

    const altitude = Math.max(maxRadius * 3.5, diameter * 40, 800);
    this.moveCameraTo(centroid.clone().add(new THREE.Vector3(0, 0, altitude)), centroid, new THREE.Vector3(0, 1, 0), durationMs);
  }

  navigateToSelection(durationMs = 2200): void {
    if (!this.star || this.selectedNames.size === 0) return;
    if (this.selectedNames.size === 1) {
      this.navigateToPlanet([...this.selectedNames][0], durationMs);
      return;
    }
    const positions: THREE.Vector3[] = [];
    for (const name of this.selectedNames) {
      const body = this.findBodyByName(name);
      if (!body) continue;
      positions.push(body.getWorldPosition(), ...body.satellites.map((m) => m.getWorldPosition()));
    }
    if (positions.length === 0) return;

    const { centroid, maxRadius } = boundingSphere(positions);
    this.cinematicFollow.active = false;
    const camPos = this.navMode === NavigationMode.DISCOVERY
      ? centroid.clone().add(new THREE.Vector3(0, 0, Math.max(maxRadius * 3.5, 1500)))
      : (() => { const d = Math.max(maxRadius * 3.0, 1500); return centroid.clone().add(new THREE.Vector3(0, d * 0.45, d)); })();
    this.moveCameraTo(camPos, centroid, new THREE.Vector3(0, 1, 0), durationMs);
  }

  setCameraBaseSpeed(speed: number): void {
    if (this._controls) this._controls.baseMovementSpeed = speed;
  }

  // ── Navigation route ──────────────────────────────────────────────────────

  addNavWaypointBody(bodyName: string, durationSec = 10): void {
    if (this.navRoute.waypoints.some((w) => w.type === 'body' && w.bodyName === bodyName)) return;
    this.navRoute.waypoints.push({ type: 'body', bodyName, durationSec, label: bodyName });
    this.updateNavPathLine();
  }

  addNavWaypointCoordinate(worldX: number, worldZ: number, durationSec = 5): void {
    const idx = this.navRoute.waypoints.length + 1;
    // Minimap coordinates are on the ecliptic (XZ) plane.
    this.navRoute.waypoints.push({
      type: 'coordinate', position: new THREE.Vector3(worldX, 0, worldZ), durationSec,
      label: `Point ${idx} (${worldX.toFixed(0)}, ${worldZ.toFixed(0)})`,
    });
    this.updateNavPathLine();
  }

  removeNavWaypoint(index: number): void {
    if (index < 0 || index >= this.navRoute.waypoints.length) return;
    this.navRoute.waypoints.splice(index, 1);
    if (this.navRoute.currentIndex >= this.navRoute.waypoints.length) this.navRoute.currentIndex = 0;
    if (this.navRoute.waypoints.length === 0) this.navRoute.active = false;
    this.updateNavPathLine();
  }

  updateNavWaypointDuration(index: number, durationSec: number): void {
    const wp = this.navRoute.waypoints[index];
    if (wp && Number.isFinite(durationSec) && durationSec >= 0) wp.durationSec = durationSec;
  }

  clearNavWaypoints(): void {
    Object.assign(this.navRoute, { waypoints: [], active: false, currentIndex: 0, progress: 0, orbitRemaining: 0 });
    this.updateNavPathLine();
  }

  setNavRouteLoop(loop: boolean): void {
    this.navRoute.loop = loop;
    this.updateNavPathLine();
  }

  engageNavRoute(): void {
    if (this.navRoute.waypoints.length === 0 || !this.camera) return;
    Object.assign(this.navRoute, { active: true, currentIndex: 0, progress: 0, orbitRemaining: 0 });
    this.navRouteFromPos.copy(this.camera.position);
    this.cameraAnim = null;
  }

  disengageNavRoute(): void {
    this.navRoute.active = false;
  }

  private waypointPosition(index: number): THREE.Vector3 | null {
    const wp = this.navRoute.waypoints[index];
    if (!wp) return null;
    if (wp.type === 'body') {
      const body = this.findBodyByName(wp.bodyName);
      return body ? body.getWorldPosition() : null;
    }
    return wp.position?.clone() ?? null;
  }

  private updateNavPathLine(): void {
    const points: THREE.Vector3[] = [this.camera?.position.clone() ?? new THREE.Vector3()];
    this.navRoute.waypoints.forEach((_, i) => {
      const p = this.waypointPosition(i);
      if (p) points.push(p);
    });
    if (this.navRoute.loop && points.length > 2) points.push(points[1].clone());

    if (points.length < 2) {
      if (this.navPathLine) this.navPathLine.visible = false;
      return;
    }
    if (!this.navPathLine) {
      this.navPathLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x00ffcc, transparent: true, opacity: 0.7 }));
      this.navPathLine.renderOrder = 10;
      this.navPathLine.frustumCulled = false;
      this.scene.add(this.navPathLine);
    }
    const geometry = this.navPathLine.geometry;
    const attr = geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (attr && attr.count >= points.length) {
      points.forEach((p, i) => attr.setXYZ(i, p.x, p.y, p.z));
      attr.needsUpdate = true;
    } else {
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(Math.max(points.length, 8) * 2 * 3), 3));
      const fresh = geometry.getAttribute('position') as THREE.BufferAttribute;
      points.forEach((p, i) => fresh.setXYZ(i, p.x, p.y, p.z));
    }
    geometry.setDrawRange(0, points.length);
    this.navPathLine.visible = this.navMode === NavigationMode.FASTEST_TRAVEL;
  }

  /** Route autopilot: fly to the current waypoint, then circle it for its duration. */
  private tickNavRoute(delta: number): void {
    const camera = this.camera;
    const wps = this.navRoute.waypoints;
    if (!camera || wps.length === 0) return;
    const idx = Math.min(this.navRoute.currentIndex, wps.length - 1);
    const wp = wps[idx];
    const targetPos = this.waypointPosition(idx);
    if (!targetPos) {
      this.advanceWaypoint(idx); // body vanished (e.g. after a jump) — skip it
      return;
    }

    if (this.navRoute.progress < 1) {
      const dist = this.navRouteFromPos.distanceTo(targetPos);
      this.navRoute.progress = Math.min(1, this.navRoute.progress + (this.navRouteTravelSpeed * delta) / Math.max(1, dist));
      const camTarget = targetPos.clone().add(new THREE.Vector3(0, 0, 400));
      camera.position.lerpVectors(this.navRouteFromPos, camTarget, easeInOutQuad(this.navRoute.progress));
      const currentLook = camera.getWorldDirection(new THREE.Vector3()).add(camera.position);
      camera.lookAt(currentLook.lerp(targetPos, 0.02));
      this._controls?.syncEuler();
      return;
    }

    if (this.navRoute.orbitRemaining <= 0) {
      this.navRoute.orbitRemaining = wp.durationSec;
      this.navOrbitAngle = 0;
      this.navOrbitRadius = 400;
    }
    this.navRoute.orbitRemaining -= delta;
    this.navOrbitAngle += delta * 0.3;
    this.navOrbitCenter.copy(targetPos);
    camera.position.set(
      this.navOrbitCenter.x + Math.cos(this.navOrbitAngle) * this.navOrbitRadius,
      this.navOrbitCenter.y + 200,
      this.navOrbitCenter.z + Math.sin(this.navOrbitAngle) * this.navOrbitRadius,
    );
    camera.lookAt(this.navOrbitCenter);
    this._controls?.syncEuler();
    if (this.navRoute.orbitRemaining <= 0) this.advanceWaypoint(idx);
  }

  private advanceWaypoint(idx: number): void {
    const next = idx + 1;
    if (next >= this.navRoute.waypoints.length) {
      if (!this.navRoute.loop) {
        this.navRoute.active = false;
        return;
      }
      this.navRoute.currentIndex = 0;
    } else {
      this.navRoute.currentIndex = next;
    }
    if (this.camera) this.navRouteFromPos.copy(this.camera.position);
    this.navRoute.progress = 0;
    this.navRoute.orbitRemaining = 0;
  }

  // ── Keyboard ──────────────────────────────────────────────────────────────

  /** Global keyboard shortcuts (see README → Controls). Ignored while typing in form fields. */
  keyDown(event: KeyboardEvent): void {
    if (isTypingTarget(event.target)) return;
    switch (event.code) {
      case 'Space':
        event.preventDefault();
        this._controls?.toggle();
        return;
      case 'Escape':
        if (this.navRoute.active) this.disengageNavRoute();
        return;
      case 'Equal':
      case 'NumpadAdd': {
        event.preventDefault();
        // Double up to the keyboard cap, but never *lower* a faster speed set with the slider.
        const current = Math.max(SIM_SPEED_MIN, this.simulationSpeed());
        if (current < MAX_KEYBOARD_SIM_SPEED) this.setSimulationSpeed(Math.min(MAX_KEYBOARD_SIM_SPEED, current * 2));
        return;
      }
      case 'Minus':
      case 'NumpadSubtract':
        event.preventDefault();
        this.setSimulationSpeed(Math.max(SIM_SPEED_MIN, this.simulationSpeed() / 2));
        return;
      case 'BracketLeft':
        event.preventDefault();
        this._controls?.adjustMovementSpeed(-0.1);
        return;
      case 'BracketRight':
        event.preventDefault();
        this._controls?.adjustMovementSpeed(0.1);
        return;
      case 'KeyT':
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        event.preventDefault();
        this.toggleTracers();
        return;
      case 'Tab':
        event.preventDefault();
        if (event.ctrlKey && event.altKey) this.selectNextRing();
        else if (event.ctrlKey) this.selectNextMoon();
        else this.selectNextBody();
        return;
      default:
        return;
    }
  }

  // ── Server data ───────────────────────────────────────────────────────────

  /** Initial load via SSE, falling back to the WebSocket after 2 s. */
  loadPlanets(): void {
    let received = false;
    const fallback = setTimeout(() => {
      if (!received) {
        console.warn('[WebGl] SSE timeout – requesting planets via WebSocket');
        this.wsService.sendGetPlanets();
      }
    }, 2000);

    this.subscriptions.add(this.sseService.on<PlanetsSnapshot>('planets').subscribe({
      next: (snapshot) => {
        clearTimeout(fallback);
        if (received || !snapshot) return;
        received = true;
        void this.loadSystem(snapshot, null);
      },
      error: (err: unknown) => {
        clearTimeout(fallback);
        if (received) return;
        console.error('[WebGl] SSE error – falling back to WebSocket', err);
        this.wsService.sendGetPlanets();
      },
    }));
    this.subscriptions.add(() => clearTimeout(fallback));
  }

  observePlanets(): void {
    this.subscriptions.add(this.wsService.messages$.subscribe((message) => this.handleServerMessage(message)));
    this.wsService.connect();
  }

  /** Apply one WebSocket message: positions, a full rebuild, or the start of a universe transition. */
  handleServerMessage(message: ServerMessage): void {
    switch (message.type) {
      case 'orbitSync':
      case 'orbitUpdate':
        this.simulationTime = message.simulationTime;
        if (Number.isFinite(message.simulationSpeed)) this.simulationSpeed.set(message.simulationSpeed!);
        this.lastServerUpdate.set(performance.now());
        this.applyTrueAnomalies(message.trueAnomalies);
        break;
      case 'planetsData':
        void this.loadSystem(message, this.pendingTransition);
        this.pendingTransition = null;
        break;
      case 'universeTransition':
        this.buildToken++; // abandon any build still in flight; it describes the old universe
        this.pendingTransition = message.reason;
        this.loadingOverlay.set(true);
        this.loadingStage.set(
          message.reason === 'travel' ? 'Jumping to new star…' : message.reason === 'jump' ? 'Jumping to exact date…' : 'Resetting universe…',
        );
        this.clearSolarSystem();
        break;
      case 'error':
        this.loadingOverlay.set(false);
        break;
    }
  }

  /** Tear down any current system and build the one described by `snapshot`. */
  async loadSystem(snapshot: PlanetsSnapshot, reason: TransitionReason | null): Promise<void> {
    const token = ++this.buildToken;
    this.clearSolarSystem();
    if (Number.isFinite(snapshot.simulationTime)) this.simulationTime = snapshot.simulationTime;
    if (Number.isFinite(snapshot.simulationSpeed)) this.simulationSpeed.set(snapshot.simulationSpeed);
    const star = await this.createSolarSystem(snapshot.planets ?? [], token);
    if (!star || token !== this.buildToken) return;
    if (reason === 'travel') this.randomizeCamera();
    this.loadingOverlay.set(false);
  }

  private async createSolarSystem(bodies: readonly BodyData[], token: number): Promise<Star | null> {
    const starData = bodies.find((d) => d.type === 'star') as unknown as StarConfig | undefined;
    if (!starData) {
      console.warn('[WebGl] No star in payload.');
      this.loadingStage.set('No star system received');
      return null;
    }

    this.isReady.set(false);
    this.loadingStage.set('Building star…');
    const star = await this.starFactory.build(starData);
    if (token !== this.buildToken) { star.dispose(); return null; }

    this.loadingStage.set('Loading celestial bodies…');
    const satellites = bodies.filter((d) => d.type !== 'star') as unknown as SatelliteConfig[];
    await this.starFactory.attachSatellites(star, satellites);
    if (token !== this.buildToken) { star.dispose(); return null; }

    this.loadingStage.set('Assembling rings & belts…');
    const rings: RingConfig[] = Array.isArray(starData.rings) ? starData.rings : [];
    await this.starFactory.attachRings(star, rings);
    if (token !== this.buildToken) { star.dispose(); return null; }

    this.star = star;
    this._controls?.setStar(star);
    this.scene.add(star.group);
    this.placeBodiesAt(this.simulationTime); // don't leave every body at the origin until the first orbitUpdate
    star.updateHierarchy(this.simulationTime);

    this.loadingStage.set('Drawing orbital paths…');
    for (const body of star.satellites) this.buildOrbitLines(body, star.group, false);

    this.loadingStage.set('Registering celestial bodies…');
    this.selectable = [...star.descendants()].map((b) => b.highlight).filter(Boolean);

    this.loadingStage.set('Layering galaxy…');
    if (!this.galaxy) {
      // Radius is in galaxy units (×GALAXY_SCALE); 900000 here flattened every star onto four thin spiral lines.
      this.galaxy = this.galaxyFactory.build({ starsCount: 300_000, arms: 4 });
      this.scene.add(this.galaxy.points);
    }
    if (!this.blackHole) {
      this.blackHole = new BlackHole();
      this.blackHole.group.quaternion.copy(GALAXY_ORIENTATION); // accretion disk in the galactic plane
      this.galacticFrame.add(this.blackHole.group);
    }
    // The star orbits the black hole at the spiral's centre, starting from its
    // place in the galaxy (random systems are offset from the home star).
    this.galacticOrbit.setStart(this.galaxy.config.sunDistance ?? 10, starData.galaxyPosition);
    this.updateGalacticFrame();
    this.tracer?.attach(star);

    this.applyBodyOverlays();
    this.lastSimTime = undefined;
    this.loadingStage.set('Ready');
    this.isReady.set(true);
    return star;
  }

  /** Orbit ellipse for a body, sampled uniformly in eccentric anomaly. */
  static orbitPoints(body: OrbitingBody, steps = 256): THREE.Vector3[] {
    // Uniform steps in E (not ν) keep points dense near aphelion of eccentric comet orbits.
    const e = Math.min(body.config.eccentricity ?? 0, MAX_ECCENTRICITY);
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i < steps; i++) {
      pts.push(body.positionForAngle(trueAnomalyFromEccentric((i / steps) * 2 * Math.PI, e)));
    }
    return pts;
  }

  private buildOrbitLines(body: CelestialBody, parent: THREE.Object3D, isMoon: boolean): void {
    if (!(body instanceof OrbitingBody)) return;
    const line = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(WebGl.orbitPoints(body)),
      new THREE.LineBasicMaterial({ color: body.config.color || (isMoon ? '#aaaadd' : '#ffffff'), transparent: true, opacity: isMoon ? 0.5 : 0.75 }),
    );
    line.name = `${body.name}_orbit`;

    if (body instanceof Comet) {
      this.cometOrbitLines.set(body.name, line);
      line.visible = this.showCometOrbits;
    } else if (isMoon || body instanceof Moon) {
      this.moonOrbitLines.set(body.name, line);
      line.visible = this.showMoonOrbits;
    } else {
      this.planetOrbitLines.set(body.name, line);
      line.visible = this.showPlanetOrbits;
    }
    parent.add(line);
    // A moon's group carries its orbit orientation (reference plane, node, inclination), so its line lives there.
    for (const sat of body.satellites) this.buildOrbitLines(sat, sat.group, true);
  }

  /**
   * Place the galactic core (black hole, tracer trails) and the galaxy backdrop
   * for the current simulation time. Moving them opposite to the star's
   * position on its galactic orbit is equivalent to the star revolving around
   * the core with the camera riding along.
   */
  updateGalacticFrame(): void {
    const starPos = this.galacticOrbit.starPositionAt(this.simulationTime, this.starGalacticPos);
    this.galacticFrame.position.copy(starPos).negate();
    if (this.galaxy) {
      // The galaxy model is built in its own frame with the core at (−sunDistance, 0, 0); turn it into the
      // real orientation (galactic plane 60° to the ecliptic) and put its core at the galactic frame's origin.
      const points = this.galaxy.points;
      points.quaternion.copy(GALAXY_ORIENTATION);
      points.position.set((this.galaxy.config.sunDistance ?? 10) * GALAXY_SCALE, 0, 0).applyQuaternion(GALAXY_ORIENTATION);
      points.position.add(this.galacticFrame.position);
    }
  }

  /** Remove the current system and free all of its GPU resources. */
  clearSolarSystem(): void {
    if (this.star) {
      this.star.dispose(); // disposes orbit lines too (they live under the star group)
      this.star = null;
    }
    this._controls?.setStar(null);
    this.tracer?.detach();
    this.starFactory.clearRings();
    this.planetOrbitLines.clear();
    this.moonOrbitLines.clear();
    this.cometOrbitLines.clear();
    this.selectable = [];
    if (this.selectedNames.size) {
      this.selectedNames.clear();
      this.emitSelection();
    }
    this.cinematicFollow.active = false;
    this.verificationErrors.clear();
    this.isReady.set(false);
  }

  private randomizeCamera(): void {
    const distance = 5000 + Math.random() * 15000;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    this.moveCameraTo(
      new THREE.Vector3(distance * Math.sin(phi) * Math.cos(theta), distance * Math.sin(phi) * Math.sin(theta), distance * Math.cos(phi)),
      new THREE.Vector3(), new THREE.Vector3(0, 1, 0), 0,
    );
  }

  /** Position every orbiting body for a timestamp using the shared Kepler model. */
  placeBodiesAt(timeMs: number): void {
    if (!this.star) return;
    for (const body of this.star.descendants()) {
      if (body instanceof OrbitingBody && (body.config.period ?? 0) > 0) body.setAngle(trueAnomalyAt(body.config, timeMs));
    }
    this.star.group.updateMatrixWorld(true);
  }

  /**
   * Move bodies to the server's true anomalies. In verify mode the client's own
   * Kepler prediction is compared with the server position to surface drift.
   */
  applyTrueAnomalies(angles: Record<string, number> | null | undefined): void {
    if (!this.star || !angles) return;
    const verify = this.verifyMode;
    let maxError = 0;
    const predicted = new THREE.Vector3();
    for (const body of this.star.descendants()) {
      if (!(body instanceof OrbitingBody)) continue;
      const angle = angles[body.name];
      if (angle === undefined || !Number.isFinite(angle)) continue;
      body.setAngle(angle);
      if (verify && (body.config.period ?? 0) > 0) {
        predicted.copy(body.calculatePositionAt(this.simulationTime));
        const error = predicted.distanceTo(body.orbitalGroup.position);
        this.verificationErrors.set(body.name, error);
        maxError = Math.max(maxError, error);
      }
    }
    if (verify) this.maxVerificationError.set(maxError);
  }

  // ── Render loop ───────────────────────────────────────────────────────────

  private readonly animate = (timestamp: number): void => {
    this.rafId = requestAnimationFrame(this.animate);
    this.timer.update(timestamp);
    this.renderFrame(Math.min(this.timer.getDelta(), 0.25));
  };

  /** Advance animations by `delta` seconds and render one frame. */
  renderFrame(delta: number): void {
    const camera = this.camera;
    if (!camera) return;
    const elapsedMs = this.timer.getElapsed() * 1000;

    if (this.lastSimTime === undefined) this.lastSimTime = this.simulationTime;
    const deltaSimMs = Math.max(-MAX_RING_STEP_MS, Math.min(MAX_RING_STEP_MS, this.simulationTime - this.lastSimTime));
    this.lastSimTime = this.simulationTime;

    this.updateGalacticFrame();
    this.tracer?.update(this.simulationTime);
    this.blackHole?.update(elapsedMs / 1000, camera);

    if (this.star) {
      this.star.updateHierarchy(this.simulationTime); // spins, axial orientation and precessing moon orbits follow the clock
      const sunPos = this.star.getWorldPosition();
      for (const body of this.star.satellites) if (body instanceof Comet) body.updateTail(sunPos);
      if (this.spectroscopyMode) this.spectrometer?.update(this.star);
    }

    if (this.cinematicFollow.active && this.navMode === NavigationMode.CINEMATIC && !this.cameraAnim) {
      const body = this.findBodyByName(this.cinematicFollow.bodyName);
      if (body) {
        const bodyPos = body.getWorldPosition();
        camera.position.copy(bodyPos).add(this.cinematicFollow.worldOffset);
        camera.lookAt(bodyPos);
        this._controls?.syncEuler();
      }
    }

    const shaderTime = performance.now() / 1000;
    for (const ring of this.starFactory.keplerianRings) {
      const ud = ring.userData;
      if (ud.keplerian && ud.baseQuaternion && ud.angularSpeedRadPerMs) {
        // Star belts orbit at their Keplerian rate, set from the clock so they keep moving with the planets at any speed.
        ring.quaternion.copy(ud.baseQuaternion);
        ring.rotateY(keplerianRingAngle(ud.angularSpeedRadPerMs, this.simulationTime));
      } else if (ud.rotate && ud.angularSpeedRadPerMs) {
        ring.rotateY(ud.angularSpeedRadPerMs * deltaSimMs);
      }
      const uniforms = (ring.material as THREE.ShaderMaterial).uniforms;
      if (uniforms?.['uTime']) uniforms['uTime'].value = shaderTime;
    }

    this.tickCameraAnim();
    if (this.navRoute.active && this.navRoute.waypoints.length > 0) this.tickNavRoute(delta);
    this._controls?.update(delta);
    if (this.navMode === NavigationMode.FASTEST_TRAVEL && this.navPathLine) this.updateNavPathLine();

    if (elapsedMs - this.lastSaveMs >= 2000) {
      this.saveCameraState();
      this.lastSaveMs = elapsedMs;
    }
    this.renderer?.render(this.scene, camera);
  }

  private tickCameraAnim(): void {
    const anim = this.cameraAnim;
    const camera = this.camera;
    if (!anim || !camera || this.navRoute.active) return;
    const t = anim.durationMs > 0 ? Math.min((performance.now() - anim.startMs) / anim.durationMs, 1) : 1;
    const eased = easeOutCubic(t);
    camera.position.lerpVectors(anim.fromPos, anim.toPos, eased);
    camera.up.lerpVectors(anim.fromUp, anim.toUp, eased).normalize();
    camera.lookAt(anim.lookAt);
    this._controls?.syncEuler();
    if (t >= 1) this.cameraAnim = null;
  }

  get isCameraAnimating(): boolean {
    return this.cameraAnim !== null;
  }

  private restoreCameraState(): void {
    try {
      const raw = safeStorage('sessionStorage')?.getItem(STORAGE_KEYS.camera);
      if (!raw || !this.camera) return;
      const s = JSON.parse(raw) as Record<string, number>;
      const values = [s['px'], s['py'], s['pz'], s['qx'], s['qy'], s['qz'], s['qw']];
      if (values.every(Number.isFinite)) {
        this.camera.position.set(s['px'], s['py'], s['pz']);
        this.camera.quaternion.set(s['qx'], s['qy'], s['qz'], s['qw']).normalize();
      }
    } catch { /* ignore corrupt state */ }
  }

  private saveCameraState(): void {
    const c = this.camera;
    if (!c) return;
    writeValue(STORAGE_KEYS.camera, JSON.stringify({
      px: c.position.x, py: c.position.y, pz: c.position.z,
      qx: c.quaternion.x, qy: c.quaternion.y, qz: c.quaternion.z, qw: c.quaternion.w,
    }), 'sessionStorage');
  }
}

