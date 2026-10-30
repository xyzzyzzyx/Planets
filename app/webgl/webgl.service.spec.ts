import { TestBed } from '@angular/core/testing';
import * as THREE from 'three';
import { J2000_MS, computeTrueAnomalies } from '../../shared/orbital';
import { APP_CONFIG } from '../app.config';
import { CelestialBody, OrbitingBody } from '../galaxy/celestial.model';
import { Comet } from '../galaxy/comet.model';
import { GALACTIC_AXES, GALACTIC_YEAR_MS, GALAXY_ORIENTATION } from '../galaxy/galactic-orbit';
import { GALAXY_SCALE, GalaxyFactory } from '../galaxy/galaxy.factory';
import { keplerianRingAngle } from '../galaxy/star.factory';
import { Planet } from '../galaxy/planet.model';
import { FakeEventSource, FakeWebSocket, createRendererStub, fakeTextureLoader, randomSnapshot, snapshot } from '../testing/fakes';
import { PlanetsSnapshot } from '../utils/protocol';
import { SseService } from '../utils/sse.service';
import { WebSocketService } from '../utils/websocket.service';
import { AssetTextureService } from './asset-texture.service';
import {
  CAMERA_PRESETS,
  CameraView,
  MAX_RING_STEP_MS,
  NavigationMode,
  STORAGE_KEYS,
  WebGl,
  boundingSphere,
  easeInOutQuad,
  easeOutCubic,
  isTypingTarget,
  resolveBody,
} from './webgl.service';

const W = 1000;
const H = 800;

function setup() {
  FakeWebSocket.instances = [];
  FakeEventSource.instances = [];
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  TestBed.configureTestingModule({ providers: [{ provide: APP_CONFIG, useValue: { wsUrl: '/ws', sseUrl: '/event' } }] });

  const ws = TestBed.inject(WebSocketService);
  ws.socketFactory = (url) => new FakeWebSocket(url) as unknown as WebSocket;
  const sse = TestBed.inject(SseService);
  sse.sourceFactory = (url) => new FakeEventSource(url) as unknown as EventSource;
  TestBed.inject(AssetTextureService).loader = fakeTextureLoader();
  const galaxyFactory = TestBed.inject(GalaxyFactory);
  const build = galaxyFactory.build.bind(galaxyFactory);
  vi.spyOn(galaxyFactory, 'build').mockImplementation((cfg) => build({ ...cfg, starsCount: 500 }));

  const webGl = TestBed.inject(WebGl);
  const renderer = createRendererStub();
  webGl.createRenderer = () => renderer;
  vi.spyOn(renderer.domElement, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: W, height: H, right: W, bottom: H, x: 0, y: 0, toJSON: () => ({}) });
  Object.defineProperty(renderer.domElement, 'clientWidth', { value: W });
  Object.defineProperty(renderer.domElement, 'clientHeight', { value: H });
  return { webGl, ws, renderer, socket: () => FakeWebSocket.instances.at(-1)!, sse: () => FakeEventSource.instances.at(-1)! };
}

async function loaded(webGl: WebGl, data: PlanetsSnapshot = snapshot()) {
  webGl.init(H, W);
  await webGl.loadSystem(data, null);
  webGl.star!.group.updateMatrixWorld(true);
  return webGl.star!;
}

const sent = (socket: FakeWebSocket) => socket.sentJson() as { type: string; [k: string]: unknown }[];

describe('WebGl helpers', () => {
  it('boundingSphere returns centroid and max radius', () => {
    const { centroid, maxRadius } = boundingSphere([new THREE.Vector3(-2, 0, 0), new THREE.Vector3(2, 0, 0), new THREE.Vector3(0, 0, 0)]);
    expect(centroid.toArray()).toEqual([0, 0, 0]);
    expect(maxRadius).toBe(2);
    expect(boundingSphere([])).toEqual({ centroid: new THREE.Vector3(), maxRadius: 0 });
  });

  it('isTypingTarget recognises form fields', () => {
    expect(isTypingTarget(document.createElement('input'))).toBe(true);
    expect(isTypingTarget(document.createElement('textarea'))).toBe(true);
    expect(isTypingTarget(document.createElement('div'))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });

  it('easing functions run from 0 to 1', () => {
    for (const ease of [easeInOutQuad, easeOutCubic]) {
      expect(ease(0)).toBe(0);
      expect(ease(1)).toBe(1);
      expect(ease(0.5)).toBeGreaterThan(0.4);
    }
  });

  it('resolveBody walks up to the owning body', () => {
    const planet = new Planet({ name: 'X', type: 'planet', diameter: 1 });
    const mesh = new THREE.Mesh();
    planet.orbitalGroup.add(mesh);
    expect(resolveBody(mesh)).toBe(planet);
    expect(resolveBody(new THREE.Object3D())).toBeNull();
  });
});

describe('WebGl', () => {
  let ctx: ReturnType<typeof setup>;
  let webGl: WebGl;

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    ctx = setup();
    webGl = ctx.webGl;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('construction & init', () => {
    it('restores toggles from storage, each from its own key (verify used the planet-orbit key)', () => {
      TestBed.resetTestingModule();
      localStorage.setItem(STORAGE_KEYS.planetOrbits, 'true');
      localStorage.setItem(STORAGE_KEYS.navMode, NavigationMode.CINEMATIC);
      const fresh = setup().webGl;
      expect(fresh.showPlanetOrbits).toBe(true);
      expect(fresh.verifyMode).toBe(false);
      expect(fresh.navMode).toBe(NavigationMode.CINEMATIC);
    });

    it('falls back to discovery for an unknown saved mode', () => {
      TestBed.resetTestingModule();
      localStorage.setItem(STORAGE_KEYS.navMode, 'warp');
      expect(setup().webGl.navMode).toBe(NavigationMode.DISCOVERY);
    });

    it('does not create a WebGL renderer until init()', () => {
      expect(webGl.renderer).toBeUndefined();
      webGl.init(H, W);
      expect(webGl.renderer).toBe(ctx.renderer);
      expect(webGl.camera?.aspect).toBeCloseTo(W / H);
      expect(webGl.controls).toBeDefined();
      webGl.init(1, 1);
      expect(ctx.renderer.setSize).toHaveBeenCalledTimes(1);
    });

    it('restores a saved camera pose and ignores corrupt ones', () => {
      sessionStorage.setItem(STORAGE_KEYS.camera, JSON.stringify({ px: 1, py: 2, pz: 3, qx: 0, qy: 0, qz: 0, qw: 1 }));
      webGl.init(H, W);
      expect(webGl.camera!.position.toArray()).toEqual([1, 2, 3]);

      TestBed.resetTestingModule();
      sessionStorage.setItem(STORAGE_KEYS.camera, '{"px":"x"}');
      const other = setup().webGl;
      other.init(H, W);
      expect(other.camera!.position.equals(CAMERA_PRESETS[CameraView.OVERVIEW].pos)).toBe(true);
    });

    it('resize() updates renderer and camera, ignoring zero sizes', () => {
      webGl.init(H, W);
      webGl.resize(400, 800);
      expect(webGl.camera!.aspect).toBe(2);
      webGl.resize(0, 800);
      expect(webGl.camera!.aspect).toBe(2);
    });
  });

  describe('loading a system', () => {
    it('loads from SSE on start(), once', async () => {
      webGl.init(H, W);
      webGl.start();
      webGl.start();
      expect(FakeEventSource.instances).toHaveLength(1);
      ctx.sse().emit('planets', snapshot());
      await vi.waitFor(() => expect(webGl.isReady()).toBe(true));
      expect(webGl.star!.name).toBe('Sun');
      expect(webGl.loadingStage()).toBe('Ready');
      expect(webGl.simulationTime).toBe(snapshot().simulationTime);
    });

    it('falls back to the WebSocket when SSE is silent for 2 s', async () => {
      vi.useFakeTimers();
      webGl.init(H, W);
      webGl.start();
      ctx.socket().open();
      vi.advanceTimersByTime(2000);
      expect(sent(ctx.socket())).toContainEqual({ type: 'getPlanets' });
    });

    it('places bodies on their orbits for the snapshot time right away', async () => {
      const star = await loaded(webGl);
      for (const name of ['Earth', 'Saturn', 'Halley', 'Moon']) {
        expect(star.findBody(name)!.getWorldPosition().length(), name).toBeGreaterThan(10);
      }
    });

    it('builds planets, moons, comets, orbit lines and selectable highlights', async () => {
      const star = await loaded(webGl);
      expect(star.satellites.map((s) => s.name)).toEqual(['Earth', 'Saturn', 'Halley']);
      expect(star.satellites[2]).toBeInstanceOf(Comet);
      expect(star.findBody('Moon')).not.toBeNull();
      expect(webGl.selectable).toHaveLength(5); // Sun, Earth, Moon, Saturn, Halley
      const orbitLines: string[] = [];
      star.group.traverse((o) => { if (o.name.endsWith('_orbit')) orbitLines.push(o.name); });
      expect(orbitLines.sort()).toEqual(['Earth_orbit', 'Halley_orbit', 'Moon_orbit', 'Saturn_orbit']);
      expect(webGl.scene.children).toContain(star.group);
      expect(webGl.galaxy).not.toBeNull();
    });

    it('builds a random system without treating its star or comets as planets', async () => {
      const star = await loaded(webGl, randomSnapshot());
      expect(star.name).toBe('Star-2A');
      expect(star.satellites.map((s) => s.constructor.name)).toEqual(['Planet', 'Comet']);
      // Star stays at the origin; the galaxy backdrop is shifted instead.
      expect(star.group.position.length()).toBe(0);
      // At the galactic epoch the backdrop sits at the star's galaxy position (plus the Sun's height above the disk).
      webGl.simulationTime = J2000_MS;
      webGl.updateGalacticFrame();
      const expected = new THREE.Vector3(-10000, 0, 5000).applyQuaternion(GALAXY_ORIENTATION);
      const p = webGl.galaxy!.points.position.clone();
      const h = p.dot(GALACTIC_AXES.northPole) - expected.dot(GALACTIC_AXES.northPole);
      expect(p.addScaledVector(GALACTIC_AXES.northPole, -h).distanceTo(expected)).toBeLessThan(1e-6);
      expect(Math.abs(h)).toBeLessThan(200);
    });

    it('builds the galaxy only once across systems', async () => {
      await loaded(webGl);
      await webGl.loadSystem(randomSnapshot(), 'travel');
      expect(TestBed.inject(GalaxyFactory).build).toHaveBeenCalledTimes(1);
      expect(webGl.scene.children.filter((c) => c.name === 'galaxy')).toHaveLength(1);
    });

    it('discards a stale build when a newer snapshot arrives mid-build', async () => {
      webGl.init(H, W);
      const first = webGl.loadSystem(snapshot(), null);
      const second = webGl.loadSystem(randomSnapshot(), null);
      await Promise.all([first, second]);
      expect(webGl.star!.name).toBe('Star-2A');
      expect(webGl.scene.children.filter((c) => c.name.endsWith('_group'))).toHaveLength(1);
    });

    it('warns and stays unready when no star is present', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      webGl.init(H, W);
      await webGl.loadSystem({ planets: [], simulationTime: 0, simulationSpeed: 1 }, null);
      expect(webGl.isReady()).toBe(false);
      expect(warn).toHaveBeenCalled();
    });

    it('clearSolarSystem disposes the old system and forgets rings and selection', async () => {
      const star = await loaded(webGl);
      webGl.selectBodies(['Earth'], false);
      const dispose = vi.spyOn(star, 'dispose');
      webGl.clearSolarSystem();
      expect(dispose).toHaveBeenCalled();
      expect(webGl.star).toBeNull();
      expect(webGl.selectable).toEqual([]);
      expect(webGl.selectedNames.size).toBe(0);
      expect(webGl.isReady()).toBe(false);
    });
  });

  describe('server messages', () => {
    it('orbitUpdate moves bodies to the reported anomalies and tracks speed', async () => {
      const star = await loaded(webGl);
      webGl.handleServerMessage({ type: 'orbitUpdate', simulationTime: 123, simulationSpeed: 8, trueAnomalies: { Earth: Math.PI / 2, Bogus: 1, Saturn: NaN } });
      const earth = star.findBody('Earth') as OrbitingBody;
      expect(earth.currentAngle).toBeCloseTo(Math.PI / 2);
      expect(webGl.simulationTime).toBe(123);
      expect(webGl.simulationSpeed()).toBe(8);
      expect(webGl.lastServerUpdate()).toBeGreaterThan(0);
    });

    it('ignores non-finite times', () => {
      webGl.simulationTime = 5;
      webGl.simulationTime = NaN;
      expect(webGl.simulationTime).toBe(5);
    });

    it('universeTransition clears the scene and shows the overlay; planetsData rebuilds it', async () => {
      await loaded(webGl);
      webGl.handleServerMessage({ type: 'universeTransition', reason: 'travel', simulationTime: 0 });
      expect(webGl.star).toBeNull();
      expect(webGl.loadingOverlay()).toBe(true);
      expect(webGl.loadingStage()).toMatch(/new star/);
      const camBefore = webGl.camera!.position.clone();
      webGl.handleServerMessage({ type: 'planetsData', ...randomSnapshot() });
      await vi.waitFor(() => expect(webGl.isReady()).toBe(true));
      expect(webGl.star!.name).toBe('Star-2A');
      expect(webGl.loadingOverlay()).toBe(false);
      expect(webGl.camera!.position.equals(camBefore)).toBe(false); // travel randomises the camera
    });

    it('a date jump keeps the camera and does not force the speed back to 1×', async () => {
      await loaded(webGl);
      webGl.init(H, W);
      ctx.ws.connect();
      ctx.socket().open();
      const cam = webGl.camera!.position.clone();
      webGl.handleServerMessage({ type: 'universeTransition', reason: 'jump', simulationTime: 0 });
      webGl.handleServerMessage({ type: 'planetsData', ...snapshot({ simulationSpeed: 50 }) });
      await vi.waitFor(() => expect(webGl.isReady()).toBe(true));
      expect(webGl.camera!.position.equals(cam)).toBe(true);
      expect(webGl.simulationSpeed()).toBe(50);
      expect(sent(ctx.socket()).filter((m) => m.type === 'setSpeed')).toEqual([]);
    });

    it('universeTransition abandons a build that is still in flight', async () => {
      webGl.init(H, W);
      const stale = webGl.loadSystem(snapshot(), null); // still awaiting textures
      webGl.handleServerMessage({ type: 'universeTransition', reason: 'travel', simulationTime: 0 });
      await stale;
      expect(webGl.star).toBeNull();
      expect(webGl.scene.children.some((c) => c.name === 'Sun_group')).toBe(false);
      webGl.handleServerMessage({ type: 'planetsData', ...randomSnapshot() });
      await vi.waitFor(() => expect(webGl.isReady()).toBe(true));
      expect(webGl.star!.name).toBe('Star-2A');
    });

    it('server errors hide the overlay', () => {
      webGl.loadingOverlay.set(true);
      webGl.handleServerMessage({ type: 'error', message: 'x' });
      expect(webGl.loadingOverlay()).toBe(false);
    });

    it('verify mode compares client-side Kepler predictions with server anomalies', async () => {
      const star = await loaded(webGl);
      webGl.toggleVerifyMode();
      const t = Date.UTC(2031, 0, 1);
      webGl.simulationTime = t;
      const raw = snapshot().planets.find((p) => p.type === 'star')!;
      const angles = computeTrueAnomalies({ ...raw, planets: snapshot().planets.filter((p) => p.type === 'planet'), comets: snapshot().planets.filter((p) => p.type === 'comet') }, t);
      webGl.applyTrueAnomalies(angles);
      expect(webGl.verificationErrors.has('Earth')).toBe(true);
      expect(webGl.maxVerificationError()).toBeLessThan(1e-6);
      expect(star).toBeTruthy();
    });
  });

  describe('simulation controls', () => {
    beforeEach(() => {
      ctx.ws.connect();
      ctx.socket().open();
    });

    it('sends speed, reset, jump and travel requests', () => {
      webGl.setSimulationSpeed(16);
      webGl.setSimulationSpeed(NaN);
      webGl.resetSimulation();
      webGl.jumpToDate(Date.UTC(1986, 1, 9));
      webGl.jumpToDate(NaN);
      webGl.jumpToRandomStar();
      expect(sent(ctx.socket()).map((m) => m.type)).toEqual(['setSpeed', 'resetSimulation', 'jumpToDate', 'travelToRandom']);
      expect(webGl.simulationSpeed()).toBe(16);
      expect(webGl.loadingOverlay()).toBe(true);
    });

    it('+/- keys double and halve the current speed (previously always sent 2× / 0.5×)', () => {
      webGl.init(H, W);
      webGl.simulationSpeed.set(8);
      webGl.keyDown(new KeyboardEvent('keydown', { code: 'Equal' }));
      expect(webGl.simulationSpeed()).toBe(16);
      webGl.keyDown(new KeyboardEvent('keydown', { code: 'Minus' }));
      webGl.keyDown(new KeyboardEvent('keydown', { code: 'NumpadSubtract' }));
      expect(webGl.simulationSpeed()).toBe(4);
      webGl.simulationSpeed.set(0.25);
      webGl.keyDown(new KeyboardEvent('keydown', { code: 'Minus' }));
      expect(webGl.simulationSpeed()).toBe(0.25);
      webGl.simulationSpeed.set(9000);
      webGl.keyDown(new KeyboardEvent('keydown', { code: 'NumpadAdd' }));
      expect(webGl.simulationSpeed()).toBe(10_000);
      expect(sent(ctx.socket()).map((m) => m['speed'])).toEqual([16, 8, 4, 0.25, 10_000]);
    });

    it('+ never lowers a speed above the keyboard cap that was set with the slider', () => {
      webGl.init(H, W);
      webGl.simulationSpeed.set(1e9);
      webGl.keyDown(new KeyboardEvent('keydown', { code: 'Equal' }));
      expect(webGl.simulationSpeed()).toBe(1e9);
      webGl.keyDown(new KeyboardEvent('keydown', { code: 'Minus' }));
      expect(webGl.simulationSpeed()).toBe(5e8);
      expect(sent(ctx.socket()).map((m) => m['speed'])).toEqual([5e8]);
    });

    it('ignores shortcuts while typing in a form field', () => {
      webGl.init(H, W);
      const input = document.createElement('input');
      const event = new KeyboardEvent('keydown', { code: 'Equal' });
      Object.defineProperty(event, 'target', { value: input });
      webGl.keyDown(event);
      expect(sent(ctx.socket())).toEqual([]);
    });
  });

  describe('selection', () => {
    let star: Awaited<ReturnType<typeof loaded>>;
    let changes: Set<string>[];

    beforeEach(async () => {
      star = await loaded(webGl);
      changes = [];
      webGl.onSelectionChanged = (names) => changes.push(names);
    });

    it('selectBodies highlights known bodies only and reports the change', () => {
      webGl.selectBodies(['Earth', 'Nope', 'moon'], false);
      expect([...webGl.selectedNames]).toEqual(['Earth', 'moon']);
      expect(star.findBody('Earth')!.highlight.visible).toBe(true);
      expect(star.findBody('Moon')!.highlight.visible).toBe(true);
      expect(changes.at(-1)).toEqual(new Set(['Earth', 'moon']));
      expect(webGl.selectedPlanetName).toBe('moon');
    });

    it('toggleSelection and clearSelection', () => {
      webGl.toggleSelection('Saturn');
      webGl.toggleSelection('Earth');
      webGl.toggleSelection('Saturn');
      expect([...webGl.selectedNames]).toEqual(['Earth']);
      webGl.clearSelection();
      expect(webGl.selectedNames.size).toBe(0);
      expect(star.findBody('Earth')!.highlight.visible).toBe(false);
    });

    it('getSelectionHierarchyLabels orders by distance and indents moons', () => {
      webGl.selectBodies(['Saturn', 'Moon', 'Sun', 'Earth'], false);
      expect(webGl.getSelectionHierarchyLabels()).toEqual(['Sun', 'Earth', '↳ Moon', 'Saturn']);
    });

    it('handleCanvasClick raycasts highlight shells; clicking empty space clears', () => {
      const camera = webGl.camera!;
      camera.position.set(0, 0, 5000);
      camera.up.set(0, 1, 0);
      camera.lookAt(0, 0, 0);
      camera.updateMatrixWorld(true);
      webGl.handleCanvasClick({ clientX: W / 2, clientY: H / 2 });
      expect([...webGl.selectedNames]).toEqual(['Sun']);
      webGl.handleCanvasClick({ clientX: 1, clientY: 1 });
      expect(webGl.selectedNames.size).toBe(0);
    });

    it('selectInRect selects bodies projected inside the rectangle', () => {
      const camera = webGl.camera!;
      camera.position.set(0, 50_000, 0.001);
      camera.up.set(0, 0, -1);
      camera.lookAt(0, 0, 0);
      camera.updateMatrixWorld(true);
      webGl.navMode = NavigationMode.FASTEST_TRAVEL; // avoid camera moves
      webGl.selectInRect({ x: W / 2 - 5, y: H / 2 - 5 }, { x: W / 2 + 5, y: H / 2 + 5 }, false);
      expect([...webGl.selectedNames]).toEqual(['Sun']);
      webGl.selectInRect({ x: 0, y: 0 }, { x: W, y: H }, true);
      expect(webGl.selectedNames.has('Earth')).toBe(true);
    });

    it('Tab / Ctrl+Tab / Ctrl+Alt+Tab cycle bodies, moons and rings', () => {
      const tab = (init: KeyboardEventInit = {}) => webGl.keyDown(new KeyboardEvent('keydown', { code: 'Tab', key: 'Tab', ...init }));
      tab();
      expect([...webGl.selectedNames]).toEqual(['Earth']);
      tab();
      expect([...webGl.selectedNames]).toEqual(['Saturn']);
      tab({ ctrlKey: true });
      expect([...webGl.selectedNames]).toEqual(['Moon']);
      tab({ ctrlKey: true, altKey: true });
      expect(webGl.selectedNames.size).toBe(1); // ring found and its owner selected (used to find none)
      expect(webGl.selectNextRing()).toMatch(/^ring_/);
    });
  });

  describe('display toggles', () => {
    let star: Awaited<ReturnType<typeof loaded>>;
    beforeEach(async () => { star = await loaded(webGl); });

    const orbit = (name: string) => {
      let line: THREE.Object3D | undefined;
      star.group.traverse((o) => { if (o.name === `${name}_orbit`) line = o; });
      return line!;
    };

    it.each([
      ['toggleShowPlanetOrbits', STORAGE_KEYS.planetOrbits, 'Earth'],
      ['toggleShowMoonOrbits', STORAGE_KEYS.moonOrbits, 'Moon'],
      ['toggleShowCometOrbits', STORAGE_KEYS.cometOrbits, 'Halley'],
    ] as const)('%s toggles the right lines and persists', (method, key, body) => {
      expect(orbit(body).visible).toBe(false);
      webGl[method]();
      expect(orbit(body).visible).toBe(true);
      expect(localStorage.getItem(key)).toBe('true');
      webGl[method]();
      expect(orbit(body).visible).toBe(false);
    });

    it('coordinate grids and magnetic fields apply to every body', () => {
      webGl.toggleShowCoordinateGrids();
      webGl.toggleShowMagneticFields();
      for (const b of star.descendants()) expect(b.latLongGroup?.visible ?? true).toBe(true);
      expect(star.magneticFieldGroup?.visible).toBe(true);
      expect(localStorage.getItem(STORAGE_KEYS.magneticFields)).toBe('true');
    });

    it('graph and spectroscopy modes toggle their overlays', () => {
      webGl.toggleGraphMode();
      webGl.toggleSpectroscopyMode();
      expect(localStorage.getItem(STORAGE_KEYS.graphMode)).toBe('true');
      expect(localStorage.getItem(STORAGE_KEYS.spectroscopyMode)).toBe('true');
      webGl.renderFrame(0.016);
      expect(ctx.renderer.render).toHaveBeenCalled();
    });

    it('verify mode persists under its own key and resets errors', () => {
      webGl.verificationErrors.set('x', 1);
      webGl.toggleVerifyMode();
      expect(localStorage.getItem(STORAGE_KEYS.verifyMode)).toBe('true');
      expect(webGl.verificationErrors.size).toBe(0);
    });
  });

  describe('camera & navigation', () => {
    beforeEach(async () => { await loaded(webGl); });

    it('moveCameraTo animates and finishes at the target', () => {
      const now = vi.spyOn(performance, 'now');
      now.mockReturnValue(0);
      webGl.moveCameraTo(new THREE.Vector3(100, 0, 0), new THREE.Vector3(), undefined, 1000);
      expect(webGl.isCameraAnimating).toBe(true);
      now.mockReturnValue(1000);
      webGl.renderFrame(0.016);
      expect(webGl.camera!.position.distanceTo(new THREE.Vector3(100, 0, 0))).toBeLessThan(1e-6);
      expect(webGl.isCameraAnimating).toBe(false);
    });

    it('zero-duration moves apply immediately', () => {
      webGl.moveCameraTo(new THREE.Vector3(7, 8, 9), new THREE.Vector3(), undefined, 0);
      expect(webGl.camera!.position.toArray()).toEqual([7, 8, 9]);
    });

    it('setCameraView uses presets', () => {
      webGl.setCameraView(CameraView.ECLIPTIC, 0);
      expect(webGl.camera!.position.distanceTo(CAMERA_PRESETS[CameraView.ECLIPTIC].pos)).toBeLessThan(1e-6);
    });

    it('cinematic navigation starts following the body after the flight', () => {
      vi.useFakeTimers();
      webGl.setNavigationMode(NavigationMode.CINEMATIC);
      webGl.navigateToPlanet('Earth', 0);
      vi.advanceTimersByTime(60);
      const earth = webGl.findBodyByName('Earth') as Planet;
      earth.setAngle(1);
      webGl.star!.group.updateMatrixWorld(true);
      webGl.renderFrame(0.016);
      const look = webGl.camera!.getWorldDirection(new THREE.Vector3());
      const toEarth = earth.getWorldPosition().sub(webGl.camera!.position).normalize();
      expect(look.dot(toEarth)).toBeGreaterThan(0.999);
    });

    it('navigation in route mode adds a waypoint instead of flying', () => {
      webGl.setNavigationMode(NavigationMode.FASTEST_TRAVEL);
      webGl.navigateToPlanet('Saturn');
      expect(webGl.navRoute.waypoints.map((w) => w.bodyName)).toEqual(['Saturn']);
    });

    it('navigateToSelection frames several bodies', () => {
      webGl.setNavigationMode(NavigationMode.DISCOVERY);
      webGl.selectBodies(['Earth', 'Saturn'], true);
      expect(webGl.isCameraAnimating).toBe(true);
    });

    it('getSystemSnapshot uses the star\'s name and an ecliptic (x, z) projection', () => {
      const earth = webGl.findBodyByName('Earth') as Planet;
      earth.setAngle(Math.PI / 2);
      webGl.star!.group.updateMatrixWorld(true);
      webGl.camera!.position.set(1, 2, 3);
      const snap = webGl.getSystemSnapshot();
      expect(snap.bodies[0]).toMatchObject({ name: 'Sun', isStar: true });
      const e = snap.bodies.find((b) => b.name === 'Earth')!;
      expect(e.y).toBeCloseTo(earth.getWorldPosition().z);
      expect(snap.camera).toEqual({ x: 1, y: 3, z: 2 });
    });

    it('getCameraAzimuth: 0 when looking along −Z, π/2 along +X', () => {
      const cam = webGl.camera!;
      cam.position.set(0, 0, 0);
      cam.up.set(0, 1, 0);
      cam.lookAt(0, 0, -10);
      expect(webGl.getCameraAzimuth()).toBeCloseTo(0);
      cam.lookAt(10, 0, 0);
      expect(webGl.getCameraAzimuth()).toBeCloseTo(Math.PI / 2);
    });

    it('getBodyPhaseAngle is 0 for non-orbiting or unknown bodies', () => {
      expect(webGl.getBodyPhaseAngle('Sun')).toBe(0);
      expect(webGl.getBodyPhaseAngle('Nope')).toBe(0);
      expect(Math.abs(webGl.getBodyPhaseAngle('Earth'))).toBeLessThanOrEqual(Math.PI);
    });
  });

  describe('navigation route', () => {
    beforeEach(async () => {
      await loaded(webGl);
      webGl.setNavigationMode(NavigationMode.FASTEST_TRAVEL);
    });

    it('adds body waypoints once and coordinate waypoints on the ecliptic plane', () => {
      webGl.addNavWaypointBody('Earth');
      webGl.addNavWaypointBody('Earth');
      webGl.addNavWaypointCoordinate(100, -200, 3);
      expect(webGl.navRoute.waypoints).toHaveLength(2);
      expect(webGl.navRoute.waypoints[1].position!.toArray()).toEqual([100, 0, -200]);
      expect(webGl.navRoute.waypoints[1].label).toBe('Point 2 (100, -200)');
    });

    it('validates edits and clears', () => {
      webGl.addNavWaypointBody('Earth');
      webGl.updateNavWaypointDuration(0, -5);
      webGl.updateNavWaypointDuration(0, NaN);
      webGl.updateNavWaypointDuration(9, 5);
      expect(webGl.navRoute.waypoints[0].durationSec).toBe(10);
      webGl.updateNavWaypointDuration(0, 2);
      expect(webGl.navRoute.waypoints[0].durationSec).toBe(2);
      webGl.removeNavWaypoint(5);
      expect(webGl.navRoute.waypoints).toHaveLength(1);
      webGl.setNavRouteLoop(true);
      webGl.clearNavWaypoints();
      expect(webGl.navRoute).toMatchObject({ waypoints: [], active: false, currentIndex: 0 });
    });

    it('flies to each waypoint, orbits for its duration, then stops (or loops)', () => {
      webGl.addNavWaypointBody('Earth', 1);
      webGl.addNavWaypointCoordinate(0, 3000, 1);
      webGl.engageNavRoute();
      expect(webGl.navRoute.active).toBe(true);
      let guard = 0;
      while (webGl.navRoute.progress < 1 && guard++ < 10_000) webGl.renderFrame(0.1);
      expect(webGl.navRoute.progress).toBe(1);
      webGl.renderFrame(0.5);
      expect(webGl.navRoute.orbitRemaining).toBeCloseTo(0.5);
      webGl.renderFrame(0.6);
      expect(webGl.navRoute.currentIndex).toBe(1);
      for (let i = 0; i < 10_000 && webGl.navRoute.active; i++) webGl.renderFrame(0.1);
      expect(webGl.navRoute.active).toBe(false);

      webGl.setNavRouteLoop(true);
      webGl.engageNavRoute();
      for (let i = 0; i < 20_000 && webGl.navRoute.currentIndex !== 1; i++) webGl.renderFrame(0.1);
      for (let i = 0; i < 20_000 && webGl.navRoute.currentIndex !== 0; i++) webGl.renderFrame(0.1);
      expect(webGl.navRoute.active).toBe(true);
    });

    it('skips waypoints whose body no longer exists (used to crash)', () => {
      webGl.addNavWaypointBody('Vulcan');
      webGl.addNavWaypointBody('Earth');
      webGl.engageNavRoute();
      expect(() => webGl.renderFrame(0.1)).not.toThrow();
      expect(webGl.navRoute.currentIndex).toBe(1);
    });

    it('Escape disengages an active route', () => {
      webGl.addNavWaypointBody('Earth');
      webGl.engageNavRoute();
      webGl.keyDown(new KeyboardEvent('keydown', { code: 'Escape' }));
      expect(webGl.navRoute.active).toBe(false);
    });
  });

  describe('render loop', () => {
    it('rotates animated rings by at most MAX_RING_STEP_MS of simulated time per frame', async () => {
      const star = await loaded(webGl);
      const saturn = star.findBody('Saturn') as CelestialBody;
      const ring = saturn.ringGroup!.children[0] as THREE.Mesh;
      webGl.renderFrame(0.016); // establishes lastSimTime
      const before = ring.quaternion.clone();
      webGl.simulationTime += 10 * 86_400_000;
      webGl.renderFrame(0.016);
      const speed = (ring.userData as { angularSpeedRadPerMs: number }).angularSpeedRadPerMs;
      expect(ring.quaternion.angleTo(before)).toBeCloseTo(speed * MAX_RING_STEP_MS, 9);
      expect(((ring as THREE.Mesh).material as THREE.ShaderMaterial).uniforms['uTime'].value).toBeGreaterThan(0);
    });

    it('keeps Keplerian star belts moving at their orbital rate, even across large time steps', async () => {
      const star = await loaded(webGl);
      const zones = star.ringGroup!.children.filter((c) => c.name.startsWith('ring_AsteroidBelt')) as THREE.InstancedMesh[];
      expect(zones).toHaveLength(3);
      webGl.renderFrame(0.016);
      const before = zones.map((z) => z.quaternion.clone());
      const days = 40;
      webGl.simulationTime += days * 86_400_000; // far more than MAX_RING_STEP_MS
      webGl.renderFrame(0.016);
      zones.forEach((zone, i) => {
        const speed = (zone.userData as { angularSpeedRadPerMs: number }).angularSpeedRadPerMs;
        expect(zone.quaternion.angleTo(before[i])).toBeCloseTo(speed * days * 86_400_000, 6);
      });
      // Prograde: a particle's motion turns about ecliptic north (+Y), like the planets.
      const probe = new THREE.Vector3(1000, 0, 0);
      const p0 = probe.clone().applyQuaternion(before[0]);
      const p1 = probe.clone().applyQuaternion(zones[0].quaternion);
      expect(p0.clone().cross(p1).normalize().y).toBeGreaterThan(0.99);
      // Inner zones orbit faster than outer ones.
      const speeds = zones.map((z) => (z.userData as { angularSpeedRadPerMs: number }).angularSpeedRadPerMs);
      expect(speeds[0]).toBeGreaterThan(speeds[2]);
      expect(keplerianRingAngle(speeds[0], webGl.simulationTime)).toBeGreaterThanOrEqual(0);
    });

    it('revolves the system around the black hole at the centre of the galaxy', async () => {
      await loaded(webGl);
      expect(webGl.blackHole?.group.parent).toBe(webGl.galacticFrame);
      webGl.renderFrame(0.016);
      const inPlane = (v: THREE.Vector3) => v.clone().addScaledVector(GALACTIC_AXES.northPole, -v.dot(GALACTIC_AXES.northPole));
      const core0 = webGl.getGalacticCorePosition();
      const radius = 10 * GALAXY_SCALE;
      expect(inPlane(core0).length()).toBeCloseTo(radius, 3);
      // The galaxy backdrop moves and turns with the core (its geometry has the core at (−sunDistance, 0, 0)).
      const galaxyCore = new THREE.Vector3(-radius, 0, 0).applyQuaternion(webGl.galaxy!.points.quaternion).add(webGl.galaxy!.points.position);
      expect(galaxyCore.distanceTo(core0)).toBeLessThan(1e-6);

      webGl.simulationTime += GALACTIC_YEAR_MS / 4;
      webGl.renderFrame(0.016);
      const core1 = webGl.getGalacticCorePosition();
      expect(inPlane(core1).length()).toBeCloseTo(radius, 3);
      expect(inPlane(core1).angleTo(inPlane(core0))).toBeCloseTo(Math.PI / 2, 4);
      // The star itself stays at the origin.
      expect(webGl.star!.getWorldPosition().length()).toBe(0);
    });

    it('starts random systems from their place in the galaxy', async () => {
      await loaded(webGl, randomSnapshot());
      const expected = GALACTIC_AXES.center.clone().multiplyScalar(-10 * GALAXY_SCALE)
        .add(new THREE.Vector3(10000, 0, -5000).applyQuaternion(GALAXY_ORIENTATION));
      expect(webGl.galacticOrbit.epochOffset.distanceTo(expected)).toBeLessThan(200); // + the Sun's height above the disk
    });

    it('Tracer toggles (button or T), persists, and draws a trail per body', async () => {
      await loaded(webGl);
      localStorage.removeItem(STORAGE_KEYS.tracers);
      const wasOn = webGl.showTracers;
      if (wasOn) webGl.toggleTracers();
      webGl.keyDown(new KeyboardEvent('keydown', { code: 'KeyT' }));
      expect(webGl.showTracers).toBe(true);
      expect(localStorage.getItem(STORAGE_KEYS.tracers)).toBe('true');
      const tracer = webGl.tracers!;
      expect(tracer.group.parent).toBe(webGl.galacticFrame);
      expect(tracer.trailCount).toBe([...webGl.star!.descendants()].length);
      webGl.renderFrame(0.016);
      expect(tracer.sampleCount('Earth')).toBeGreaterThan(0);
      expect(tracer.lineFor('Earth')!.geometry.drawRange.count).toBeGreaterThan(1);
      // Moon trails follow the Moons orbit toggle.
      if (webGl.showMoonOrbits) webGl.toggleShowMoonOrbits();
      expect(tracer.includeMoons).toBe(false);
      webGl.toggleShowMoonOrbits();
      expect(tracer.includeMoons).toBe(true);
      webGl.renderFrame(0.016);
      expect(tracer.sampleCount('Moon')).toBeGreaterThan(0);
      webGl.toggleShowMoonOrbits();

      webGl.toggleTracers();
      expect(webGl.showTracers).toBe(false);
      expect(tracer.visible).toBe(false);
      webGl.keyDown(new KeyboardEvent('keydown', { code: 'KeyT', ctrlKey: true }));
      expect(webGl.showTracers).toBe(false);

      webGl.clearSolarSystem();
      expect(tracer.trailCount).toBe(0);
    });

    it('does nothing before init', () => {
      expect(() => webGl.renderFrame(0.016)).not.toThrow();
    });

    it('dispose() stops everything and releases the renderer', async () => {
      await loaded(webGl);
      webGl.start();
      webGl.dispose();
      expect(ctx.renderer.dispose).toHaveBeenCalled();
      expect(webGl.star).toBeNull();
      expect(webGl.galaxy).toBeNull();
      expect(webGl.active).toBe(false);
    });
  });
});
