import { DatePipe, DecimalPipe } from '@angular/common';
import {
  AfterViewInit,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
  viewChildren,
} from '@angular/core';
import { CelestialBody, SIMULATION_CONSTANTS } from './galaxy/celestial.model';
import { LayoutService } from './layout.service';
import { parseDateTimeLocalValue, parseFlexibleDate, toDateTimeLocalValue } from './utils/dates';
import {
  CAM_SPEED_DEFAULT, CAM_SPEED_MAX, CAM_SPEED_MIN, SIM_SPEED_MAX, SIM_SPEED_MIN,
  formatSpeed, logSliderToValue, snapSimSpeed, valueToLogSlider,
} from './utils/speed';
import { NavigationMode, WebGl } from './webgl/webgl.service';

export interface Milestone { name: string; dateMs: number; desc: string; }

/** Minimap scale: fits ~30.5 AU into 45% of the canvas width. */
export const MINIMAP_SIZE = 200;
export const MINIMAP_OUTER_AU = 30.5;
export const MINIMAP_SCALE = (MINIMAP_SIZE * 0.45) / (MINIMAP_OUTER_AU * SIMULATION_CONSTANTS.SCALE_UNITS_PER_AU);

/** Convert a minimap pixel to ecliptic world coordinates (x, z). */
export function minimapToWorld(px: number, py: number): { x: number; z: number } {
  const c = MINIMAP_SIZE / 2;
  return { x: (px - c) / MINIMAP_SCALE, z: (py - c) / MINIMAP_SCALE };
}

/** Convert ecliptic world coordinates (x, z) to a minimap pixel. */
export function worldToMinimap(x: number, z: number): { x: number; y: number } {
  const c = MINIMAP_SIZE / 2;
  return { x: c + x * MINIMAP_SCALE, y: c + z * MINIMAP_SCALE };
}

const HUD_SELECTOR = '.planet-panel, .sliders-panel, .minimap-wrap, .orbit-controls, .info-panel, .nav-mode-bar, .nav-panel, .date-panel, .help-panel, .selection-bar';
const HUD_REFRESH_MS = 80;

@Component({
  selector: 'dashboard',
  imports: [DatePipe, DecimalPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './dashboard.component.css',
  host: {
    '(window:keydown)': 'onKeyDown($event)',
    '(window:resize)': 'onResize()',
    '(contextmenu)': '$event.preventDefault()',
    '(wheel)': 'onMouseWheel($event)',
  },
  templateUrl: './dashboard.component.html',
})
/**
 * Full-screen 3-D view and HUD. The WebGl engine is a root singleton, so it is
 * created and started once and survives route changes; this component only
 * attaches its canvas, drives the HUD/minimap, and detaches on destroy.
 */
export class DashboardComponent implements AfterViewInit {
  protected readonly webGl = inject(WebGl);
  private readonly layout = inject(LayoutService);
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly NavMode = NavigationMode;
  protected readonly formatSpeed = formatSpeed;

  private readonly content = viewChild.required<ElementRef<HTMLDivElement>>('content');
  private readonly minimapRef = viewChild.required<ElementRef<HTMLCanvasElement>>('minimap');
  private readonly dateInput = viewChild<ElementRef<HTMLInputElement>>('dateSelector');
  private readonly indicators = viewChildren<ElementRef<HTMLCanvasElement>>('indicator');

  // ── Loader ────────────────────────────────────────────────────────────────
  readonly isLoading = signal(true);
  readonly fadingOut = signal(false);
  readonly busy = computed(() => !this.webGl.isReady() || this.webGl.loadingOverlay());

  // ── HUD state ─────────────────────────────────────────────────────────────
  readonly planets = signal<CelestialBody[]>([]);
  readonly selectedNames = signal<ReadonlySet<string>>(new Set());
  readonly selectionHierarchyDisplay = computed(() => {
    const names = this.selectedNames();
    return this.webGl.getSelectionHierarchyLabels().join('  ·  ') || [...names].join(', ');
  });

  cameraPos = { x: 0, y: 0, z: 0 };
  cameraDir = { x: 0, y: 0, z: 0 };
  cameraSpeed = 0;
  latencyMs = 0;
  readonly maxLatencyMs = 500;
  dateOffsetDays = 0;

  readonly simSpeed = computed(() => this.webGl.simulationSpeed());
  readonly simSpeedSlider = computed(() => valueToLogSlider(this.simSpeed(), SIM_SPEED_MIN, SIM_SPEED_MAX));
  readonly camBaseSpeed = signal(CAM_SPEED_DEFAULT);
  readonly camSpeedSlider = computed(() => valueToLogSlider(this.camBaseSpeed(), CAM_SPEED_MIN, CAM_SPEED_MAX));

  selectedDateStr = toDateTimeLocalValue(new Date());
  readonly milestones: readonly Milestone[] = [
    { name: 'Halley 1986 Perihelion', dateMs: Date.UTC(1986, 1, 9), desc: 'Famous comet close approach' },
    { name: 'J2000 Epoch', dateMs: Date.UTC(2000, 0, 1, 12), desc: 'Standard reference' },
    { name: 'Halley 2061 Return', dateMs: Date.UTC(2061, 6, 28), desc: 'Next Halley passage' },
    { name: '2100 Century Marker', dateMs: Date.UTC(2100, 0, 1), desc: '22nd century start' },
  ];
  readonly helpLinks = [
    { label: 'NASA Solar System', url: 'https://science.nasa.gov/solar-system/' },
    { label: 'Kepler’s Laws', url: 'https://en.wikipedia.org/wiki/Kepler%27s_laws_of_planetary_motion' },
    { label: 'Halley’s Comet', url: 'https://en.wikipedia.org/wiki/Halley%27s_Comet' },
  ] as const;
  readonly showHelpPanel = signal(true);
  readonly wpDefaultDuration = 10;

  private minimapCtx: CanvasRenderingContext2D | null = null;
  private minimapRaf = 0;
  private hudTimer: ReturnType<typeof setInterval> | undefined;
  private loaderTimer: ReturnType<typeof setTimeout> | undefined;
  private speedUpdateTimeout: ReturnType<typeof setTimeout> | undefined;

  private selectionRectActive = false;
  private selectionStart = { x: 0, y: 0 };
  private rectDiv: HTMLDivElement | null = null;

  constructor() {
    this.layout.setNavbarHidden(true);

    // Fade the loader out whenever the scene becomes ready — including revisits,
    // where the scene already exists and no new "ready" event will fire.
    effect(() => {
      const busy = this.busy();
      untracked(() => {
        clearTimeout(this.loaderTimer);
        if (busy) {
          this.isLoading.set(true);
          this.fadingOut.set(false);
          return;
        }
        this.populatePlanetList();
        if (!this.isLoading()) return;
        this.fadingOut.set(true);
        this.loaderTimer = setTimeout(() => {
          this.isLoading.set(false);
          this.fadingOut.set(false);
        }, 620);
      });
    });

    this.destroyRef.onDestroy(() => {
      this.layout.setNavbarHidden(false);
      cancelAnimationFrame(this.minimapRaf);
      clearInterval(this.hudTimer);
      clearTimeout(this.loaderTimer);
      clearTimeout(this.speedUpdateTimeout);
      this.stopSelectionRect();
      this.rectDiv?.remove();
      this.webGl.onSelectionChanged = undefined;
      this.webGl.controls?.exitFlight();
      // Keep the renderer alive for the next visit, but detach its canvas.
      this.webGl.getRenderer()?.domElement.remove();
    });
  }

  ngAfterViewInit(): void {
    const container = this.content().nativeElement;
    if (!this.webGl.isActive()) {
      this.webGl.init(container.clientHeight, container.clientWidth);
      this.webGl.start();
    }
    const canvas = this.webGl.getRenderer()?.domElement;
    if (canvas) {
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      container.prepend(canvas);
    }
    this.onResize();

    this.webGl.onSelectionChanged = (names) => this.selectedNames.set(new Set(names));
    this.selectedNames.set(new Set(this.webGl.selectedNames));
    this.camBaseSpeed.set(this.webGl.controls?.baseMovementSpeed ?? CAM_SPEED_DEFAULT);

    this.minimapCtx = this.minimapRef().nativeElement.getContext('2d');
    const draw = () => {
      this.drawMiniMap();
      this.minimapRaf = requestAnimationFrame(draw);
    };
    this.minimapRaf = requestAnimationFrame(draw);

    this.hudTimer = setInterval(() => this.refreshHud(), HUD_REFRESH_MS);
  }

  /** Poll fast-changing renderer state into the HUD (zoneless: mark for check explicitly). */
  refreshHud(): void {
    const info = this.webGl.getCameraInfo();
    this.cameraPos = { x: info.position.x, y: info.position.y, z: info.position.z };
    this.cameraDir = { x: info.direction.x, y: info.direction.y, z: info.direction.z };
    this.cameraSpeed = info.velocity;
    const last = this.webGl.lastServerUpdate();
    this.latencyMs = last ? Math.max(0, performance.now() - last) : 0;
    this.dateOffsetDays = (this.webGl.simulationTime - Date.now()) / 86_400_000;
    this.updateTriangleIndicators();
    this.cdr.markForCheck();
  }

  get simulationDate(): Date {
    return this.webGl.simulationDate;
  }

  /** True when the simulated date is after the date encoded by `value` (see {@link parseFlexibleDate}). */
  isSimulationDatePast(value?: number): boolean {
    const threshold = value === undefined ? new Date() : parseFlexibleDate(value);
    return this.simulationDate.getTime() > threshold.getTime();
  }

  // ── Host events ───────────────────────────────────────────────────────────

  onKeyDown(e: KeyboardEvent): void {
    this.webGl.keyDown(e);
  }

  onResize(): void {
    const c = this.content().nativeElement;
    this.webGl.resize(c.clientHeight, c.clientWidth);
  }

  onMouseWheel(event: WheelEvent): void {
    if (!this.webGl.controls?.locked) return;
    event.preventDefault();
    this.nudgeCamSpeed(-Math.sign(event.deltaY));
  }

  toggleMenu(): void {
    this.layout.toggleNavbar();
  }

  // ── Simulation controls ───────────────────────────────────────────────────

  jumpToRandomStar(): void {
    this.isLoading.set(true);
    this.fadingOut.set(false);
    this.webGl.jumpToRandomStar();
  }

  jumpToDate(): void {
    const ms = parseDateTimeLocalValue(this.dateInput()?.nativeElement.value ?? '');
    if (ms === null) return;
    this.selectedDateStr = toDateTimeLocalValue(new Date(ms));
    this.webGl.jumpToDate(ms);
  }

  jumpToMilestone(dateMs: number): void {
    this.selectedDateStr = toDateTimeLocalValue(new Date(dateMs));
    this.webGl.jumpToDate(dateMs);
  }

  openExternalLink(url: string): void {
    globalThis.open?.(url, '_blank', 'noopener,noreferrer');
  }

  onSimSpeedSlider(event: Event): void {
    const position = parseFloat((event.target as HTMLInputElement).value);
    if (Number.isNaN(position)) return;
    this.sendSpeed(snapSimSpeed(logSliderToValue(position, SIM_SPEED_MIN, SIM_SPEED_MAX)));
  }

  private sendSpeed(speed: number): void {
    clearTimeout(this.speedUpdateTimeout);
    this.speedUpdateTimeout = setTimeout(() => this.webGl.setSimulationSpeed(speed), 50);
  }

  setCamSpeed(speed: number): void {
    const clamped = Math.min(CAM_SPEED_MAX, Math.max(CAM_SPEED_MIN, speed));
    this.camBaseSpeed.set(clamped);
    this.webGl.setCameraBaseSpeed(clamped);
  }

  onCamSpeedSlider(event: Event): void {
    const position = parseFloat((event.target as HTMLInputElement).value);
    if (!Number.isNaN(position)) this.setCamSpeed(logSliderToValue(position, CAM_SPEED_MIN, CAM_SPEED_MAX));
  }

  private nudgeCamSpeed(direction: number): void {
    const next = Math.min(100, Math.max(0, this.camSpeedSlider() + direction * 2));
    this.setCamSpeed(logSliderToValue(next, CAM_SPEED_MIN, CAM_SPEED_MAX));
  }

  resetSimulation(): void {
    this.webGl.resetSimulation();
    clearTimeout(this.speedUpdateTimeout);
    this.webGl.simulationSpeed.set(1);
    this.setCamSpeed(CAM_SPEED_DEFAULT);
    this.dateOffsetDays = 0;
  }

  // ── Selection & navigation ────────────────────────────────────────────────

  private isHud(target: EventTarget | null): boolean {
    return !!(target as HTMLElement | null)?.closest?.(HUD_SELECTOR);
  }

  onContentClick(event: MouseEvent): void {
    if (this.isHud(event.target)) return;
    if (!this.webGl.controls?.locked) this.webGl.controls?.enterFlight();
  }

  /** Right button starts a box selection; left button picks a body (when not in flight mode). */
  onCanvasMouseDown(event: MouseEvent): void {
    if (this.isHud(event.target)) return;
    const canvas = this.webGl.getRenderer()?.domElement;
    if (!canvas) return;

    if (event.button === 2) {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      this.selectionStart = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      this.selectionRectActive = true;
      this.ensureRectDiv();
      window.addEventListener('mousemove', this.onSelectionMouseMove);
      window.addEventListener('mouseup', this.onSelectionMouseUp);
      return;
    }
    if (this.webGl.controls?.locked) return;
    this.webGl.handleCanvasClick(event, event.ctrlKey || event.metaKey);
  }

  private readonly onSelectionMouseMove = (e: MouseEvent): void => {
    const canvas = this.webGl.getRenderer()?.domElement;
    if (!this.selectionRectActive || !this.rectDiv || !canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    Object.assign(this.rectDiv.style, {
      left: `${Math.min(this.selectionStart.x, x)}px`,
      top: `${Math.min(this.selectionStart.y, y)}px`,
      width: `${Math.abs(x - this.selectionStart.x)}px`,
      height: `${Math.abs(y - this.selectionStart.y)}px`,
      display: 'block',
    });
  };

  private readonly onSelectionMouseUp = (e: MouseEvent): void => {
    const canvas = this.webGl.getRenderer()?.domElement;
    if (!this.selectionRectActive || !canvas) return;
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    this.webGl.selectInRect(this.selectionStart, { x: e.clientX - rect.left, y: e.clientY - rect.top }, e.ctrlKey || e.metaKey);
    this.stopSelectionRect();
  };

  private stopSelectionRect(): void {
    this.selectionRectActive = false;
    if (this.rectDiv) this.rectDiv.style.display = 'none';
    window.removeEventListener('mousemove', this.onSelectionMouseMove);
    window.removeEventListener('mouseup', this.onSelectionMouseUp);
  }

  private ensureRectDiv(): void {
    if (this.rectDiv) return;
    this.rectDiv = document.createElement('div');
    this.rectDiv.className = 'selection-rect';
    this.rectDiv.style.position = 'absolute';
    this.rectDiv.style.display = 'none';
    this.content().nativeElement.appendChild(this.rectDiv);
  }

  /** In navigation mode a minimap click adds a coordinate waypoint on the ecliptic. */
  onMinimapClick(event: MouseEvent): void {
    if (this.webGl.navMode !== NavigationMode.FASTEST_TRAVEL) return;
    event.stopPropagation();
    const r = this.minimapRef().nativeElement.getBoundingClientRect();
    const { x, z } = minimapToWorld(event.clientX - r.left, event.clientY - r.top);
    this.webGl.addNavWaypointCoordinate(x, z, this.wpDefaultDuration);
  }

  setNavMode(mode: NavigationMode): void {
    this.webGl.setNavigationMode(mode);
  }

  /** Body-list click: add a waypoint (navigation mode), toggle (Ctrl/⌘) or select and fly to the body. */
  onPlanetCardClick(planet: CelestialBody, event: MouseEvent): void {
    event.stopPropagation();
    if (this.webGl.navMode === NavigationMode.FASTEST_TRAVEL) {
      this.webGl.addNavWaypointBody(planet.name, this.wpDefaultDuration);
      return;
    }
    if (event.ctrlKey || event.metaKey) {
      this.webGl.toggleSelection(planet.name);
      this.webGl.navigateToSelection();
    } else {
      this.webGl.selectBodies([planet.name], true);
    }
  }

  isWaypoint(name: string): boolean {
    return this.webGl.navRoute.waypoints.some((w) => w.type === 'body' && w.bodyName === name);
  }

  auOf(body: CelestialBody): number {
    return (body.config as { au?: number }).au ?? 0;
  }

  removeWaypoint(index: number): void { this.webGl.removeNavWaypoint(index); }
  clearNavWaypoints(): void { this.webGl.clearNavWaypoints(); }
  toggleNavLoop(): void { this.webGl.setNavRouteLoop(!this.webGl.navRoute.loop); }
  engageRoute(): void { this.webGl.engageNavRoute(); }
  disengageRoute(): void { this.webGl.disengageNavRoute(); }

  onWpDurationChange(index: number, event: Event): void {
    const val = parseFloat((event.target as HTMLInputElement).value);
    if (!Number.isNaN(val) && val >= 0) this.webGl.updateNavWaypointDuration(index, val);
  }

  // ── Drawing ───────────────────────────────────────────────────────────────

  private populatePlanetList(): void {
    const star = this.webGl.star;
    this.planets.set(star ? [star, ...star.satellites].sort((a, b) => this.auOf(a) - this.auOf(b)) : []);
  }

  private updateTriangleIndicators(): void {
    for (const ref of this.indicators()) {
      const canvas = ref.nativeElement;
      const name = canvas.dataset['planet'];
      if (name) this.drawTriangle(canvas, this.webGl.getBodyPhaseAngle(name));
    }
  }

  private drawTriangle(canvas: HTMLCanvasElement, angleRad: number): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const { width: w, height: h } = canvas;
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2;
    ctx.fillStyle = this.webGl.navMode === NavigationMode.FASTEST_TRAVEL ? '#00ffcc' : '#ffaa44';
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(angleRad) * 10, cy + Math.sin(angleRad) * 10);
    ctx.lineTo(cx + Math.cos(angleRad + 2) * 6, cy + Math.sin(angleRad + 2) * 6);
    ctx.lineTo(cx + Math.cos(angleRad - 2) * 6, cy + Math.sin(angleRad - 2) * 6);
    ctx.fill();
  }

  /** Top-down ecliptic map: orbits, bodies, route and a camera arrow (redrawn every animation frame). */
  private drawMiniMap(): void {
    const ctx = this.minimapCtx;
    if (!ctx || !this.webGl.camera) return;
    const W = MINIMAP_SIZE, H = MINIMAP_SIZE, cx = W / 2, cy = H / 2;
    const AU = SIMULATION_CONSTANTS.SCALE_UNITS_PER_AU;

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(0,4,18,0.9)';
    ctx.fillRect(0, 0, W, H);

    const snap = this.webGl.getSystemSnapshot();
    const selected = this.selectedNames();

    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    for (const body of snap.bodies) {
      if (body.isStar || body.au <= 0) continue;
      ctx.beginPath();
      ctx.arc(cx, cy, body.au * AU * MINIMAP_SCALE, 0, Math.PI * 2);
      ctx.stroke();
    }

    if (this.webGl.navMode === NavigationMode.FASTEST_TRAVEL && this.webGl.navRoute.waypoints.length > 0) {
      this.drawNavPathOnMinimap(ctx, snap);
    }

    for (const body of snap.bodies) {
      const p = worldToMinimap(body.x, body.y);
      ctx.beginPath();
      ctx.arc(p.x, p.y, body.isStar ? 5 : 2.5, 0, Math.PI * 2);
      ctx.fillStyle = body.color || '#aaaaff';
      if (selected.has(body.name)) { ctx.shadowColor = '#88ccff'; ctx.shadowBlur = 8; }
      if (this.isWaypoint(body.name)) { ctx.shadowColor = '#00ffcc'; ctx.shadowBlur = 10; }
      ctx.fill();
      ctx.shadowBlur = 0;
      if (!body.isStar && body.au <= MINIMAP_OUTER_AU) {
        ctx.fillStyle = 'rgba(200,210,255,0.65)';
        ctx.font = '7px monospace';
        ctx.fillText(body.name.slice(0, 3), p.x + 3.5, p.y - 2);
      }
    }

    const cam = worldToMinimap(snap.camera.x, snap.camera.y);
    const camX = Math.max(8, Math.min(W - 8, cam.x));
    const camY = Math.max(8, Math.min(H - 8, cam.y));
    ctx.save();
    ctx.translate(camX, camY);
    ctx.rotate(this.webGl.getCameraAzimuth());
    ctx.beginPath();
    ctx.moveTo(0, -7);
    ctx.lineTo(-4, 5);
    ctx.lineTo(4, 5);
    ctx.fillStyle = this.webGl.navRoute.active ? '#00ffaa' : '#00ff88';
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = '#00ff88';
    ctx.font = '7px monospace';
    ctx.fillText('CAM', camX + 8, camY + 4);
  }

  private drawNavPathOnMinimap(ctx: CanvasRenderingContext2D, snap: ReturnType<WebGl['getSystemSnapshot']>): void {
    const route = this.webGl.navRoute;
    const points = [worldToMinimap(snap.camera.x, snap.camera.y)];
    for (const wp of route.waypoints) {
      if (wp.type === 'body' && wp.bodyName) {
        const body = snap.bodies.find((b) => b.name === wp.bodyName);
        if (body) points.push(worldToMinimap(body.x, body.y));
      } else if (wp.type === 'coordinate' && wp.position) {
        points.push(worldToMinimap(wp.position.x, wp.position.z));
      }
    }
    if (route.loop && points.length > 2) points.push(points[1]);

    ctx.save();
    ctx.setLineDash([3, 4]);
    ctx.strokeStyle = 'rgba(0,255,200,0.6)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.stroke();
    ctx.setLineDash([]);
    for (let i = 1; i < points.length; i++) {
      ctx.beginPath();
      ctx.arc(points[i].x, points[i].y, 3, 0, Math.PI * 2);
      ctx.fillStyle = i - 1 === route.currentIndex && route.active ? '#00ffaa' : 'rgba(0,255,200,0.6)';
      ctx.fill();
      ctx.fillStyle = 'rgba(0,255,200,0.8)';
      ctx.font = '6px monospace';
      ctx.fillText(String(i), points[i].x + 4, points[i].y - 2);
    }
    ctx.restore();
  }
}
