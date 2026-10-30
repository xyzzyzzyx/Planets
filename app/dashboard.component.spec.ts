import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { APP_CONFIG } from './app.config';
import { DashboardComponent, MINIMAP_SIZE, minimapToWorld, worldToMinimap } from './dashboard.component';
import { GalaxyFactory } from './galaxy/galaxy.factory';
import { LayoutService } from './layout.service';
import { FakeEventSource, FakeWebSocket, createRendererStub, fakeTextureLoader, installCanvasStub, snapshot } from './testing/fakes';
import { SseService } from './utils/sse.service';
import { CAM_SPEED_DEFAULT, CAM_SPEED_MAX } from './utils/speed';
import { WebSocketService } from './utils/websocket.service';
import { AssetTextureService } from './webgl/asset-texture.service';
import { NavigationMode, WebGl } from './webgl/webgl.service';

describe('minimap coordinate helpers', () => {
  it('round-trip between pixels and ecliptic coordinates', () => {
    for (const [x, z] of [[0, 0], [1496, -2992], [-30000, 12345]]) {
      const p = worldToMinimap(x, z);
      const w = minimapToWorld(p.x, p.y);
      expect(w.x).toBeCloseTo(x, 6);
      expect(w.z).toBeCloseTo(z, 6);
    }
    expect(worldToMinimap(0, 0)).toEqual({ x: MINIMAP_SIZE / 2, y: MINIMAP_SIZE / 2 });
    expect(worldToMinimap(0, -1000).y).toBeLessThan(MINIMAP_SIZE / 2); // −Z (ecliptic λ 90°) is drawn "up"
  });
});

describe('DashboardComponent', () => {
  let webGl: WebGl;
  let layout: LayoutService;
  const socket = () => FakeWebSocket.instances.at(-1)!;

  beforeEach(async () => {
    installCanvasStub();
    FakeWebSocket.instances = [];
    FakeEventSource.instances = [];
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    await TestBed.configureTestingModule({
      imports: [DashboardComponent],
      providers: [provideRouter([]), { provide: APP_CONFIG, useValue: { wsUrl: '/ws', sseUrl: '/event' } }],
    }).compileComponents();

    TestBed.inject(WebSocketService).socketFactory = (url) => new FakeWebSocket(url) as unknown as WebSocket;
    TestBed.inject(SseService).sourceFactory = (url) => new FakeEventSource(url) as unknown as EventSource;
    TestBed.inject(AssetTextureService).loader = fakeTextureLoader();
    const galaxy = TestBed.inject(GalaxyFactory);
    const build = galaxy.build.bind(galaxy);
    vi.spyOn(galaxy, 'build').mockImplementation((c) => build({ ...c, starsCount: 100 }));
    webGl = TestBed.inject(WebGl);
    webGl.createRenderer = createRendererStub;
    layout = TestBed.inject(LayoutService);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  async function create() {
    const fixture = TestBed.createComponent(DashboardComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    return fixture;
  }

  async function loadSystem(fixture: Awaited<ReturnType<typeof create>>) {
    FakeEventSource.instances.at(-1)!.emit('planets', snapshot());
    await vi.waitFor(() => expect(webGl.isReady()).toBe(true));
    await new Promise((r) => setTimeout(r, 700)); // loader fade-out
    fixture.componentInstance.refreshHud();
    fixture.detectChanges();
    await fixture.whenStable();
  }

  it('starts the renderer, hides the navbar and shows the loader', async () => {
    const fixture = await create();
    const el: HTMLElement = fixture.nativeElement;
    expect(webGl.isActive()).toBe(true);
    expect(layout.navbarHidden()).toBe(true);
    expect(el.querySelector('.loader-overlay')).not.toBeNull();
    expect(el.querySelector('#content canvas')).toBe(webGl.renderer!.domElement);
  });

  it('lists bodies by distance and removes the loader once the scene is ready', async () => {
    const fixture = await create();
    await loadSystem(fixture);
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.loader-overlay')).toBeNull();
    const names = [...el.querySelectorAll('.planet-card .planet-name')].map((n) => n.textContent?.trim());
    expect(names).toEqual(['Sun', 'Earth', 'Saturn', 'Halley']);
    expect(el.querySelector('.minimap-label')?.textContent).toContain('Sun');
  });

  it('does not get stuck on the loader when revisiting an already-built scene', async () => {
    const first = await create();
    await loadSystem(first);
    first.destroy();
    expect(layout.navbarHidden()).toBe(false);
    expect(webGl.renderer!.domElement.isConnected).toBe(false);

    const second = await create();
    await new Promise((r) => setTimeout(r, 700));
    second.detectChanges();
    expect((second.nativeElement as HTMLElement).querySelector('.loader-overlay')).toBeNull();
    expect(second.componentInstance.planets().length).toBe(4);
    expect(FakeEventSource.instances).toHaveLength(1); // no second start()
  });

  it('clicking a body card selects it and shows the selection bar', async () => {
    const fixture = await create();
    await loadSystem(fixture);
    const card = [...(fixture.nativeElement as HTMLElement).querySelectorAll<HTMLElement>('.planet-card')].find((c) => c.textContent?.includes('Saturn'))!;
    card.click();
    fixture.detectChanges();
    expect(webGl.selectedNames.has('Saturn')).toBe(true);
    expect((fixture.nativeElement as HTMLElement).querySelector('.selection-bar')?.textContent).toContain('Saturn');
    card.dispatchEvent(new MouseEvent('click', { ctrlKey: true, bubbles: true }));
    expect(webGl.selectedNames.has('Saturn')).toBe(false);
  });

  it('outside Navigate mode the minimap ignores clicks', async () => {
    const fixture = await create();
    await loadSystem(fixture);
    fixture.componentInstance.setNavMode(NavigationMode.DISCOVERY);
    const minimap = (fixture.nativeElement as HTMLElement).querySelector<HTMLCanvasElement>('canvas.minimap')!;
    vi.spyOn(minimap, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0 } as DOMRect);
    minimap.dispatchEvent(new MouseEvent('click', { clientX: 10, clientY: 10, bubbles: true }));
    expect(webGl.navRoute.waypoints).toEqual([]);
  });

  it('in Navigate mode, cards and the minimap add waypoints', async () => {
    const fixture = await create();
    await loadSystem(fixture);
    const cmp = fixture.componentInstance;
    cmp.setNavMode(NavigationMode.FASTEST_TRAVEL);
    fixture.detectChanges();
    const card = (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>('.planet-card')!;
    card.click();
    const minimap = (fixture.nativeElement as HTMLElement).querySelector<HTMLCanvasElement>('canvas.minimap')!;
    vi.spyOn(minimap, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0 } as DOMRect);
    minimap.dispatchEvent(new MouseEvent('click', { clientX: MINIMAP_SIZE / 2, clientY: 0, bubbles: true }));
    fixture.detectChanges();
    expect(webGl.navRoute.waypoints.map((w) => w.type)).toEqual(['body', 'coordinate']);
    expect(webGl.navRoute.waypoints[1].position!.z).toBeLessThan(0); // top of the minimap = −Z
    expect((fixture.nativeElement as HTMLElement).querySelectorAll('.waypoint-item')).toHaveLength(2);
    expect(cmp.isWaypoint('Sun')).toBe(true);
  });

  it('jumps to the date typed in local time and to milestones', async () => {
    const fixture = await create();
    socket().open();
    const input = (fixture.nativeElement as HTMLElement).querySelector<HTMLInputElement>('#dateSelector')!;
    input.value = '2061-07-28T09:30';
    fixture.componentInstance.jumpToDate();
    fixture.componentInstance.jumpToMilestone(Date.UTC(1986, 1, 9));
    input.value = 'garbage';
    fixture.componentInstance.jumpToDate();
    const jumps = socket().sentJson().filter((m) => (m as { type: string }).type === 'jumpToDate') as { date: number }[];
    expect(jumps.map((j) => j.date)).toEqual([new Date(2061, 6, 28, 9, 30).getTime(), Date.UTC(1986, 1, 9)]);
    expect(webGl.loadingOverlay()).toBe(true);
  });

  it('speed sliders map consistently and debounce simulation-speed updates', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fixture = await create();
    socket().open();
    const cmp = fixture.componentInstance;
    expect(cmp.camBaseSpeed()).toBe(CAM_SPEED_DEFAULT);
    cmp.onCamSpeedSlider({ target: { value: '100' } } as unknown as Event);
    expect(cmp.camBaseSpeed()).toBeCloseTo(CAM_SPEED_MAX);
    expect(webGl.controls!.baseMovementSpeed).toBeCloseTo(CAM_SPEED_MAX);
    expect(cmp.camSpeedSlider()).toBeCloseTo(100);

    cmp.onSimSpeedSlider({ target: { value: '30' } } as unknown as Event);
    cmp.onSimSpeedSlider({ target: { value: '40' } } as unknown as Event);
    vi.advanceTimersByTime(60);
    const speeds = socket().sentJson().filter((m) => (m as { type: string }).type === 'setSpeed');
    expect(speeds).toHaveLength(1);
    expect(cmp.simSpeed()).toBe((speeds[0] as { speed: number }).speed);
    vi.useRealTimers();
  });

  it('reset restores default camera and simulation speeds', async () => {
    const fixture = await create();
    socket().open();
    const cmp = fixture.componentInstance;
    cmp.setCamSpeed(10);
    webGl.simulationSpeed.set(500);
    cmp.resetSimulation();
    expect(cmp.camBaseSpeed()).toBe(CAM_SPEED_DEFAULT);
    expect(webGl.simulationSpeed()).toBe(1);
    expect(socket().sentJson()).toContainEqual({ type: 'resetSimulation' });
  });

  it('isSimulationDatePast compares against flexible date formats', async () => {
    const fixture = await create();
    webGl.simulationTime = Date.UTC(2000, 5, 1);
    const cmp = fixture.componentInstance;
    expect(cmp.isSimulationDatePast(1974)).toBe(true);
    expect(cmp.isSimulationDatePast(2050)).toBe(false);
    expect(cmp.isSimulationDatePast(20000101)).toBe(true);
    expect(cmp.isSimulationDatePast()).toBe(false);
  });

  it('opens external links without giving the new page access to this one', async () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    const fixture = await create();
    fixture.componentInstance.openExternalLink('https://example.com');
    expect(open).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener,noreferrer');
  });

  it('the menu button toggles the navbar and the help panel can be closed', async () => {
    const fixture = await create();
    fixture.componentInstance.toggleMenu();
    expect(layout.navbarHidden()).toBe(false);
    fixture.componentInstance.showHelpPanel.set(false);
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('.help-panel')).toBeNull();
  });

  it('refreshHud copies camera info and staleness into the HUD', async () => {
    const fixture = await create();
    webGl.camera!.position.set(1, 2, 3);
    fixture.componentInstance.refreshHud();
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('.camera-info')?.textContent).toContain('1, 2, 3');
  });

  it('right-drag selection rectangle selects and cleans up its listeners', async () => {
    const fixture = await create();
    await loadSystem(fixture);
    const canvas = webGl.renderer!.domElement;
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 100, height: 100 } as DOMRect);
    const selectInRect = vi.spyOn(webGl, 'selectInRect');
    const cmp = fixture.componentInstance;
    cmp.onCanvasMouseDown(new MouseEvent('mousedown', { button: 2, clientX: 10, clientY: 10 }));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 50, clientY: 40 }));
    const rect = (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>('.selection-rect')!;
    expect(rect.style.width).toBe('40px');
    window.dispatchEvent(new MouseEvent('mouseup', { clientX: 50, clientY: 40 }));
    expect(selectInRect).toHaveBeenCalledWith({ x: 10, y: 10 }, { x: 50, y: 40 }, false);
    window.dispatchEvent(new MouseEvent('mouseup', { clientX: 50, clientY: 40 }));
    expect(selectInRect).toHaveBeenCalledTimes(1);
    expect(rect.style.display).toBe('none');
  });

  it('ignores clicks on HUD panels', async () => {
    const fixture = await create();
    const click = vi.spyOn(webGl, 'handleCanvasClick');
    const hud = (fixture.nativeElement as HTMLElement).querySelector('.orbit-controls')!;
    fixture.componentInstance.onCanvasMouseDown({ button: 0, target: hud } as unknown as MouseEvent);
    expect(click).not.toHaveBeenCalled();
  });

  it('draws the minimap (orbits, bodies, camera, route) and the direction indicators', async () => {
    const fixture = await create();
    await loadSystem(fixture);
    const cmp = fixture.componentInstance;
    cmp.setNavMode(NavigationMode.FASTEST_TRAVEL);
    webGl.addNavWaypointBody('Earth');
    webGl.addNavWaypointCoordinate(1000, 2000);
    webGl.setNavRouteLoop(true);
    webGl.engageNavRoute();
    webGl.selectBodies(['Saturn'], false);
    fixture.detectChanges();

    const minimap = (fixture.nativeElement as HTMLElement).querySelector<HTMLCanvasElement>('canvas.minimap')!;
    const ctx = minimap.getContext('2d') as unknown as { calls: string[] };
    (cmp as unknown as { minimapCtx: unknown }).minimapCtx = ctx;
    (cmp as unknown as { drawMiniMap(): void }).drawMiniMap();
    expect(ctx.calls.filter((c) => c === 'arc').length).toBeGreaterThan(8);
    expect(ctx.calls).toContain('setLineDash');
    expect(ctx.calls).toContain('fillText');
    expect(ctx.calls).toContain('rotate');

    cmp.refreshHud(); // draws a triangle per body card
    const indicator = (fixture.nativeElement as HTMLElement).querySelector<HTMLCanvasElement>('canvas.indicator-canvas')!;
    expect(indicator.dataset['planet']).toBe('Sun');
  });

  it('keyboard and wheel events are forwarded while flying', async () => {
    const fixture = await create();
    const keyDown = vi.spyOn(webGl, 'keyDown');
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyX' }));
    expect(keyDown).toHaveBeenCalled();
    const cmp = fixture.componentInstance;
    const before = cmp.camBaseSpeed();
    Object.defineProperty(webGl.controls!, 'locked', { get: () => true });
    const wheel = new WheelEvent('wheel', { deltaY: -100, cancelable: true });
    cmp.onMouseWheel(wheel);
    expect(wheel.defaultPrevented).toBe(true);
    expect(cmp.camBaseSpeed()).toBeGreaterThan(before);
  });

  it('waypoint list edits go through the renderer', async () => {
    const fixture = await create();
    await loadSystem(fixture);
    const cmp = fixture.componentInstance;
    webGl.addNavWaypointBody('Earth');
    webGl.addNavWaypointBody('Saturn');
    cmp.onWpDurationChange(0, { target: { value: '42' } } as unknown as Event);
    cmp.onWpDurationChange(0, { target: { value: 'x' } } as unknown as Event);
    expect(webGl.navRoute.waypoints[0].durationSec).toBe(42);
    cmp.toggleNavLoop();
    expect(webGl.navRoute.loop).toBe(true);
    cmp.engageRoute();
    expect(webGl.navRoute.active).toBe(true);
    cmp.disengageRoute();
    expect(webGl.navRoute.active).toBe(false);
    cmp.removeWaypoint(0);
    expect(webGl.navRoute.waypoints.map((w) => w.bodyName)).toEqual(['Saturn']);
    cmp.clearNavWaypoints();
    expect(webGl.navRoute.waypoints).toEqual([]);
  });

  it('jumpToRandomStar shows the loader and asks the server for a new system', async () => {
    const fixture = await create();
    await loadSystem(fixture);
    socket().open();
    fixture.componentInstance.jumpToRandomStar();
    expect(fixture.componentInstance.isLoading()).toBe(true);
    expect(socket().sentJson().map((m) => (m as { type: string }).type)).toContain('travelToRandom');
  });
});

