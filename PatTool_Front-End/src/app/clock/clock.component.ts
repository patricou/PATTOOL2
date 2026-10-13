import { AfterViewInit, ChangeDetectorRef, Component, ElementRef, HostListener, NgZone, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { environment } from '../../environments/environment';
import { CLOCK_MOTIFS, MotifEl, NO_MOTIF } from './clock-motifs';
import { KeycloakService } from '../keycloak/keycloak.service';

type ClockMode = 'clock' | 'chrono' | 'alarm' | 'timer';
type AlarmChannel = 'ring' | 'email';

interface ClockFace {
  id: string;
  labelKey: string;
}

interface ClockAlarm {
  id: string;
  hour: number;
  minute: number;
  label: string;
  channel: AlarmChannel;
  enabled: boolean;
  lastFiredDate: string;
}

interface ClockTimer {
  id: string;
  label: string;
  durationMs: number;
  remainingMs: number;
  running: boolean;
  endsAt: number | null;
  done: boolean;
}

interface ClockPrefs {
  faceId?: string;
  timeZone?: string;
  notifyEmail?: string;
  alarms?: ClockAlarm[];
  contrast?: number;
  brightness?: number;
  reflection?: number;
  intensity?: number;
  brilliance?: number;
}

type LookKey = 'contrast' | 'brightness' | 'reflection' | 'intensity' | 'brilliance';

interface ClockLook {
  contrast: number;
  brightness: number;
  reflection: number;
  intensity: number;
  brilliance: number;
}

interface Numeral {
  text: string;
  x: number;
  y: number;
}

interface LcdToken {
  kind: 'd' | 'c';
  ch: string;
}

interface ZonedParts {
  h: number;
  m: number;
  s: number;
  day: string;
}

const FACES: ClockFace[] = [
  { id: 'classic', labelKey: 'CLOCK.FACE_CLASSIC' },
  { id: 'roman', labelKey: 'CLOCK.FACE_ROMAN' },
  { id: 'noir', labelKey: 'CLOCK.FACE_NOIR' },
  { id: 'gold', labelKey: 'CLOCK.FACE_GOLD' },
  { id: 'sport', labelKey: 'CLOCK.FACE_SPORT' },
  { id: 'minimal', labelKey: 'CLOCK.FACE_MINIMAL' },
  { id: 'aurora', labelKey: 'CLOCK.FACE_AURORA' },
  { id: 'skeleton', labelKey: 'CLOCK.FACE_SKELETON' },
  { id: 'deco', labelKey: 'CLOCK.FACE_DECO' },
  { id: 'constellation', labelKey: 'CLOCK.FACE_STARS' },
  { id: 'regulator', labelKey: 'CLOCK.FACE_REGULATOR' },
  { id: 'bauhaus', labelKey: 'CLOCK.FACE_BAUHAUS' },
  { id: 'guilloche', labelKey: 'CLOCK.FACE_GUILLOCHE' },
  { id: 'marine', labelKey: 'CLOCK.FACE_MARINE' },
  { id: 'rail', labelKey: 'CLOCK.FACE_RAIL' },
  { id: 'metro', labelKey: 'CLOCK.FACE_METRO' },
  { id: 'obsidian', labelKey: 'CLOCK.FACE_OBSIDIAN' },
  { id: 'sakura', labelKey: 'CLOCK.FACE_SAKURA' },
  { id: 'desert', labelKey: 'CLOCK.FACE_DESERT' },
  { id: 'abyss', labelKey: 'CLOCK.FACE_ABYSS' },
  { id: 'arcade', labelKey: 'CLOCK.FACE_ARCADE' },
  { id: 'cathedral', labelKey: 'CLOCK.FACE_CATHEDRAL' },
  { id: 'radar', labelKey: 'CLOCK.FACE_RADAR' },
  { id: 'marble', labelKey: 'CLOCK.FACE_MARBLE' },
  { id: 'ink', labelKey: 'CLOCK.FACE_INK' },
  { id: 'circuit', labelKey: 'CLOCK.FACE_CIRCUIT' },
  { id: 'lunar', labelKey: 'CLOCK.FACE_LUNAR' },
  { id: 'flame', labelKey: 'CLOCK.FACE_FLAME' },
  { id: 'prism', labelKey: 'CLOCK.FACE_PRISM' },
  { id: 'aviator', labelKey: 'CLOCK.FACE_AVIATOR' },
  { id: 'forest', labelKey: 'CLOCK.FACE_FOREST' },
  { id: 'chess', labelKey: 'CLOCK.FACE_CHESS' },
  { id: 'orbit', labelKey: 'CLOCK.FACE_ORBIT' },
  { id: 'ripple', labelKey: 'CLOCK.FACE_RIPPLE' },
  { id: 'gears', labelKey: 'CLOCK.FACE_GEARS' },
  { id: 'compass', labelKey: 'CLOCK.FACE_COMPASS' },
  { id: 'vinyl', labelKey: 'CLOCK.FACE_VINYL' },
  { id: 'eclipse', labelKey: 'CLOCK.FACE_ECLIPSE' },
  { id: 'ecg', labelKey: 'CLOCK.FACE_ECG' },
  { id: 'fan', labelKey: 'CLOCK.FACE_FAN' },
  { id: 'labyrinth', labelKey: 'CLOCK.FACE_LABYRINTH' },
  { id: 'burst-silver', labelKey: 'CLOCK.FACE_BURST_SILVER' },
  { id: 'burst-green', labelKey: 'CLOCK.FACE_BURST_GREEN' },
  { id: 'burst-blue', labelKey: 'CLOCK.FACE_BURST_BLUE' },
  { id: 'burst-sand', labelKey: 'CLOCK.FACE_BURST_SAND' },
  { id: 'burst-ink', labelKey: 'CLOCK.FACE_BURST_INK' },
  { id: 'chrono-green', labelKey: 'CLOCK.FACE_CHRONO_GREEN' },
  { id: 'chrono-silver', labelKey: 'CLOCK.FACE_CHRONO_SILVER' },
  { id: 'gousset', labelKey: 'CLOCK.FACE_GOUSSET' },
  { id: 'diver-blue', labelKey: 'CLOCK.FACE_DIVER_BLUE' },
  { id: 'chrono-gold', labelKey: 'CLOCK.FACE_CHRONO_GOLD' },
  { id: 'field-cream', labelKey: 'CLOCK.FACE_FIELD_CREAM' },
  { id: 'chrono-slate', labelKey: 'CLOCK.FACE_CHRONO_SLATE' },
  { id: 'chrono-blue', labelKey: 'CLOCK.FACE_CHRONO_BLUE' },
  { id: 'dress-navy', labelKey: 'CLOCK.FACE_DRESS_NAVY' },
  { id: 'chrono-black', labelKey: 'CLOCK.FACE_CHRONO_BLACK' },
  { id: 'lcd-led', labelKey: 'CLOCK.FACE_LCD_LED' },
  { id: 'lcd-module', labelKey: 'CLOCK.FACE_LCD_MODULE' },
  { id: 'lcd-dive', labelKey: 'CLOCK.FACE_LCD_DIVE' },
  { id: 'lcd-resin', labelKey: 'CLOCK.FACE_LCD_RESIN' },
  { id: 'lcd-round', labelKey: 'CLOCK.FACE_LCD_ROUND' },
  { id: 'board-green', labelKey: 'CLOCK.FACE_BOARD_GREEN' },
  { id: 'board-amber', labelKey: 'CLOCK.FACE_BOARD_AMBER' },
  { id: 'board-blue', labelKey: 'CLOCK.FACE_BOARD_BLUE' },
  { id: 'board-light', labelKey: 'CLOCK.FACE_BOARD_LIGHT' },
  { id: 'smart-oled', labelKey: 'CLOCK.FACE_SMART_OLED' },
  { id: 'smart-sport', labelKey: 'CLOCK.FACE_SMART_SPORT' },
  { id: 'smart-sand', labelKey: 'CLOCK.FACE_SMART_SAND' },
  { id: 'smart-night', labelKey: 'CLOCK.FACE_SMART_NIGHT' },
  { id: 'ultra-orange', labelKey: 'CLOCK.FACE_ULTRA_ORANGE' },
  { id: 'hybrid-green', labelKey: 'CLOCK.FACE_HYBRID_GREEN' },
  { id: 'hybrid-night', labelKey: 'CLOCK.FACE_HYBRID_NIGHT' },
  { id: 'hybrid-chrono', labelKey: 'CLOCK.FACE_HYBRID_CHRONO' },
  { id: 'hybrid-radar', labelKey: 'CLOCK.FACE_HYBRID_RADAR' },
  { id: 'hybrid-sakura', labelKey: 'CLOCK.FACE_HYBRID_SAKURA' },
  { id: 'hybrid-orbit', labelKey: 'CLOCK.FACE_HYBRID_ORBIT' },
  { id: 'hybrid-deco', labelKey: 'CLOCK.FACE_HYBRID_DECO' },
  { id: 'hybrid-amber', labelKey: 'CLOCK.FACE_HYBRID_AMBER' },
  { id: 'hybrid-blue', labelKey: 'CLOCK.FACE_HYBRID_BLUE' },
  { id: 'lcd-green', labelKey: 'CLOCK.FACE_LCD_GREEN' },
  { id: 'lcd-amber', labelKey: 'CLOCK.FACE_LCD_AMBER' },
  { id: 'lcd-blue', labelKey: 'CLOCK.FACE_LCD_BLUE' },
  { id: 'lcd-light', labelKey: 'CLOCK.FACE_LCD_LIGHT' },
  { id: 'lcd-red', labelKey: 'CLOCK.FACE_LCD_RED' },
  { id: 'lcd-white', labelKey: 'CLOCK.FACE_LCD_WHITE' },
  { id: 'lcd-pink', labelKey: 'CLOCK.FACE_LCD_PINK' },
  { id: 'lcd-sharp', labelKey: 'CLOCK.FACE_LCD_SHARP' },
  { id: 'lcd-sharp-black', labelKey: 'CLOCK.FACE_LCD_SHARP_BLACK' },
  { id: 'sharp-silver', labelKey: 'CLOCK.FACE_SHARP_SILVER' },
  { id: 'sharp-gold', labelKey: 'CLOCK.FACE_SHARP_GOLD' },
  { id: 'sharp-black', labelKey: 'CLOCK.FACE_SHARP_BLACK' },
  { id: 'hybrid-sharp', labelKey: 'CLOCK.FACE_HYBRID_SHARP' },
  { id: 'quartz', labelKey: 'CLOCK.FACE_QUARTZ' },
  { id: 'quartz-date', labelKey: 'CLOCK.FACE_QUARTZ_DATE' },
  { id: 'quartz-black', labelKey: 'CLOCK.FACE_QUARTZ_BLACK' },
  { id: 'quartz-gold', labelKey: 'CLOCK.FACE_QUARTZ_GOLD' },
  { id: 'quartz-field', labelKey: 'CLOCK.FACE_QUARTZ_FIELD' },
  { id: 'quartz-serif', labelKey: 'CLOCK.FACE_QUARTZ_SERIF' },
  { id: 'quartz-mono', labelKey: 'CLOCK.FACE_QUARTZ_MONO' },
  { id: 'quartz-script', labelKey: 'CLOCK.FACE_QUARTZ_SCRIPT' },
  { id: 'quartz-narrow', labelKey: 'CLOCK.FACE_QUARTZ_NARROW' },
  { id: 'quartz-gothic', labelKey: 'CLOCK.FACE_QUARTZ_GOTHIC' },
  { id: 'quartz-heavy', labelKey: 'CLOCK.FACE_QUARTZ_HEAVY' },
  { id: 'cobalt', labelKey: 'CLOCK.FACE_COBALT' },
  { id: 'ruby', labelKey: 'CLOCK.FACE_RUBY' },
  { id: 'emerald', labelKey: 'CLOCK.FACE_EMERALD' },
  { id: 'copper', labelKey: 'CLOCK.FACE_COPPER' },
  { id: 'indigo', labelKey: 'CLOCK.FACE_INDIGO' },
  { id: 'olive', labelKey: 'CLOCK.FACE_OLIVE' },
  { id: 'wine', labelKey: 'CLOCK.FACE_WINE' },
  { id: 'petrol', labelKey: 'CLOCK.FACE_PETROL' },
  { id: 'plum', labelKey: 'CLOCK.FACE_PLUM' },
  { id: 'lava', labelKey: 'CLOCK.FACE_LAVA' },
  { id: 'pine', labelKey: 'CLOCK.FACE_PINE' },
  { id: 'graphite', labelKey: 'CLOCK.FACE_GRAPHITE' },
  { id: 'brass', labelKey: 'CLOCK.FACE_BRASS' },
  { id: 'saffron', labelKey: 'CLOCK.FACE_SAFFRON' },
  { id: 'navy-ink', labelKey: 'CLOCK.FACE_NAVY_INK' },
  { id: 'moss', labelKey: 'CLOCK.FACE_MOSS' },
  { id: 'rust', labelKey: 'CLOCK.FACE_RUST' },
  { id: 'lagoon', labelKey: 'CLOCK.FACE_LAGOON' },
  { id: 'onyx', labelKey: 'CLOCK.FACE_ONYX' },
  { id: 'garnet', labelKey: 'CLOCK.FACE_GARNET' },
  { id: 'nixie', labelKey: 'CLOCK.FACE_NIXIE' }
];

const FACE_IDS = new Set(FACES.map((f) => f.id));

const TYPED_QUARTZ = new Set([
  'quartz-serif', 'quartz-mono', 'quartz-script', 'quartz-narrow', 'quartz-gothic', 'quartz-heavy'
]);

const MINI_ANGLES = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330];

const CLOCK_LOCALES: Record<string, string> = {
  fr: 'fr-FR',
  en: 'en-US',
  es: 'es-ES',
  de: 'de-DE',
  it: 'it-IT',
  ru: 'ru-RU',
  jp: 'ja-JP',
  cn: 'zh-CN',
  ar: 'ar-SA',
  el: 'el-GR',
  he: 'he-IL',
  in: 'hi-IN'
};

const SEGMENTS: Record<string, string> = {
  '0': 'abcdef',
  '1': 'bc',
  '2': 'abdeg',
  '3': 'abcdg',
  '4': 'bcfg',
  '5': 'acdfg',
  '6': 'acdefg',
  '7': 'abc',
  '8': 'abcdefg',
  '9': 'abcdfg'
};

const PREFS_KEY = 'pattool.clock.prefs';
const RUNTIME_KEY = 'pattool.clock.runtime';

const LOOK_RANGE: Record<LookKey, { min: number; max: number; step: number }> = {
  contrast: { min: 50, max: 170, step: 10 },
  brightness: { min: 50, max: 170, step: 10 },
  reflection: { min: 0, max: 200, step: 10 },
  intensity: { min: 0, max: 200, step: 10 },
  brilliance: { min: 0, max: 200, step: 10 }
};

function defaultLook(): ClockLook {
  return { contrast: 100, brightness: 100, reflection: 100, intensity: 100, brilliance: 100 };
}

@Component({
  selector: 'app-clock',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule],
  templateUrl: './clock.component.html',
  styleUrls: ['./clock.component.css'],
  host: {
    '[attr.data-face]': 'faceId'
  }
})
export class ClockComponent implements OnInit, AfterViewInit, OnDestroy {
  readonly faces = FACES;
  readonly lookKeys: LookKey[] = ['contrast', 'brightness', 'reflection', 'intensity', 'brilliance'];
  readonly sunRays = Array.from({ length: 72 }, (_, i) => i * 5);
  readonly subTicks = [0, 90, 180, 270];
  readonly ringLength = 289;
  readonly diveMarks = [
    { n: '10', deg: 60 },
    { n: '20', deg: 120 },
    { n: '30', deg: 180 },
    { n: '40', deg: 240 },
    { n: '50', deg: 300 }
  ];
  readonly miniAngles = MINI_ANGLES;
  readonly ticks = Array.from({ length: 60 }, (_, i) => i);
  readonly guillocheRadii = [22, 30, 38, 46, 54, 62, 70, 78];
  readonly hourMarks = Array.from({ length: 12 }, (_, i) => {
    const ang = ((i * 30 - 90) * Math.PI) / 180;
    return {
      i,
      deg: i * 30,
      x: +(100 + 72 * Math.cos(ang)).toFixed(2),
      y: +(100 + 72 * Math.sin(ang)).toFixed(2)
    };
  });
  readonly fieldStars: ReadonlyArray<{ x: number; y: number; r: number }> = [
    { x: 48, y: 44, r: 0.7 }, { x: 64, y: 36, r: 0.4 }, { x: 132, y: 40, r: 0.55 },
    { x: 154, y: 58, r: 0.8 }, { x: 42, y: 96, r: 0.45 }, { x: 158, y: 112, r: 0.5 },
    { x: 70, y: 150, r: 0.65 }, { x: 128, y: 156, r: 0.4 }, { x: 88, y: 42, r: 0.35 },
    { x: 116, y: 78, r: 0.4 }
  ];
  readonly segPaths: ReadonlyArray<{ id: string; d: string }> = [
    { id: 'a', d: 'M4,2 H16 L18,4 L16,6 H4 L2,4 Z' },
    { id: 'b', d: 'M17,5 L19,7 V16 L17,18 L15,16 V7 Z' },
    { id: 'c', d: 'M17,20 L19,22 V31 L17,33 L15,31 V22 Z' },
    { id: 'd', d: 'M4,32 H16 L18,34 L16,36 H4 L2,34 Z' },
    { id: 'e', d: 'M3,20 L5,22 V31 L3,33 L1,31 V22 Z' },
    { id: 'f', d: 'M3,5 L5,7 V16 L3,18 L1,16 V7 Z' },
    { id: 'g', d: 'M4,17 H16 L18,19 L16,21 H4 L2,19 Z' }
  ];

  faceId = 'classic';
  look: ClockLook = defaultLook();
  /** Empty string follows the browser zone and is not stored as a fixed zone. */
  timeZoneChoice = '';
  browserZone = 'UTC';
  zones: string[] = [];
  mode: ClockMode = 'clock';
  alarms: ClockAlarm[] = [];
  timers: ClockTimer[] = [];
  notifyEmail = '';
  loggedIn = false;

  hourAngle = 0;
  minuteAngle = 0;
  secondAngle = 0;
  dateNum = '';
  dateLabel = '';
  shortDate = '';
  weekShort = '';
  moduleDate = '';
  readout = '00:00:00';
  fraction = '';
  colonOn = true;
  lcdTokens: LcdToken[] = [];
  numerals: Numeral[] = [];

  ringing = false;
  ringMessage = '';
  emailNotice = '';

  alarmDraft = '07:00';
  alarmLabel = '';
  alarmChannel: AlarmChannel = 'ring';
  timerH = 0;
  timerM = 5;
  timerS = 0;
  timerLabel = '';
  focusTimerId = '';
  laps: number[] = [];
  chronoRunning = false;
  fillScreen = false;

  private swipeStartX = 0;
  private swipeStartY = 0;
  private swipeActive = false;
  private chronoAccumulated = 0;
  private chronoStartedAt = 0;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private frame = 0;
  private alive = true;
  private dateKey = '';
  private dateLang = '';
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private emailTimer: ReturnType<typeof setTimeout> | null = null;
  private chimeTimer: ReturnType<typeof setInterval> | null = null;
  private audioCtx: AudioContext | null = null;
  private saveGen = 0;
  private dirty = false;
  private numeralFace = '';
  private readonly emailSeen = new Set<string>();
  private readonly prefsUrl = `${environment.API_URL}external/clock/preferences`;

  constructor(
    private readonly http: HttpClient,
    private readonly translate: TranslateService,
    private readonly keycloak: KeycloakService,
    private readonly hostEl: ElementRef<HTMLElement>,
    private readonly zone: NgZone,
    private readonly cdr: ChangeDetectorRef
  ) {}

  ngOnInit(): void {
    this.browserZone = this.readBrowserZone();
    this.zones = this.loadZones();
    this.loggedIn = this.keycloak.isLoggedIn();
    this.restoreLocal();
    this.refreshNumerals();
    this.tick();
    this.tickTimer = setInterval(() => this.pollEvents(), 250);
    this.zone.runOutsideAngular(() => this.paint());
    queueMicrotask(() => this.syncPageBg());
    if (this.loggedIn) {
      this.http.get<ClockPrefs>(this.prefsUrl).subscribe({
        next: (prefs) => this.applyRemote(prefs),
        error: () => { /* keep the local face and zone */ }
      });
    }
  }

  ngAfterViewInit(): void {
    this.syncPageBg();
  }

  ngOnDestroy(): void {
    this.alive = false;
    if (this.frame) {
      cancelAnimationFrame(this.frame);
    }
    document.body.classList.remove('clock-fill');
    document.documentElement.style.removeProperty('--clock-html-bg');
    if (this.tickTimer != null) {
      clearInterval(this.tickTimer);
    }
    if (this.saveTimer != null) {
      clearTimeout(this.saveTimer);
    }
    if (this.emailTimer != null) {
      clearTimeout(this.emailTimer);
    }
    this.stopChime();
    this.writeRuntime();
    this.audioCtx?.close().catch(() => undefined);
  }

  @HostListener('pointerdown')
  unlockAudio(): void {
    this.ensureAudio();
  }

  get effectiveZone(): string {
    return this.timeZoneChoice || this.browserZone;
  }

  get isLcd(): boolean {
    return this.faceId.startsWith('lcd');
  }

  get isQuartz(): boolean {
    return this.faceId.startsWith('quartz');
  }

  get isNixie(): boolean {
    return this.faceId === 'nixie';
  }

  get isHybrid(): boolean {
    return this.faceId.startsWith('hybrid');
  }

  get isSharpLcd(): boolean {
    return this.faceId.startsWith('lcd-sharp');
  }

  get isSharpAnalog(): boolean {
    return this.faceId.startsWith('sharp-');
  }

  get isSmart(): boolean {
    return this.faceId.startsWith('smart-');
  }

  get isBoard(): boolean {
    return this.faceId.startsWith('board-');
  }

  get isUltra(): boolean {
    return this.faceId === 'ultra-orange';
  }

  get showAnalog(): boolean {
    return !this.isLcd && !this.isNixie && !this.isSmart && !this.isBoard && !this.isUltra;
  }

  get smartHourMinute(): string {
    return this.readout.length >= 5 ? this.readout.slice(0, 5) : this.readout;
  }

  get smartSeconds(): string {
    return this.readout.length >= 8 ? this.readout.slice(6, 8) : '';
  }

  get hour12Label(): string {
    const hm = this.smartHourMinute;
    if (hm.length < 5) {
      return hm;
    }
    const hour = Number(hm.slice(0, 2));
    if (Number.isNaN(hour)) {
      return hm;
    }
    return `${this.pad(hour % 12 || 12)}:${hm.slice(3, 5)}`;
  }

  get isResin(): boolean {
    return this.faceId === 'lcd-resin';
  }

  get isRoundDig(): boolean {
    return this.faceId === 'lcd-round';
  }

  get zoneCity(): string {
    const zone = this.effectiveZone;
    const cut = zone.lastIndexOf('/');
    return (cut >= 0 ? zone.slice(cut + 1) : zone).replace(/_/g, ' ');
  }

  get ringOffset(): number {
    return this.ringLength * (1 - (this.secondAngle % 360) / 360);
  }

  get motif(): MotifEl[] {
    return CLOCK_MOTIFS[this.faceId] ?? NO_MOTIF;
  }

  get showLineTicks(): boolean {
    return this.showAnalog && ![
      'aurora', 'skeleton', 'deco', 'constellation', 'bauhaus', 'regulator', 'guilloche',
      'marine', 'rail', 'metro', 'sakura', 'desert', 'abyss', 'arcade', 'cathedral', 'radar',
      'ink', 'circuit', 'flame', 'prism', 'aviator', 'forest', 'chess', 'orbit',
      'quartz-serif', 'quartz-mono', 'quartz-script', 'quartz-narrow', 'quartz-gothic', 'quartz-heavy',
      'ripple', 'gears', 'compass', 'vinyl', 'eclipse', 'ecg', 'fan', 'labyrinth',
      'hybrid-night', 'hybrid-chrono', 'hybrid-radar', 'hybrid-sakura', 'hybrid-orbit', 'hybrid-deco',
      'burst-silver', 'burst-green', 'burst-blue', 'burst-sand', 'burst-ink', 'chrono-green', 'chrono-silver',
      'diver-blue', 'chrono-gold', 'chrono-slate', 'chrono-blue', 'dress-navy', 'chrono-black'
    ].includes(this.faceId);
  }

  get serifFace(): boolean {
    return this.faceId === 'roman' || this.faceId === 'gold' || this.faceId === 'deco'
      || this.faceId === 'guilloche' || this.faceId === 'marine' || this.faceId === 'cathedral'
      || this.faceId === 'marble' || this.faceId === 'gousset';
  }

  get numeralSize(): number {
    if (this.faceId === 'regulator') {
      return 4.6;
    }
    if (this.faceId === 'cathedral') {
      return 5;
    }
    if (this.faceId === 'marine' || this.faceId === 'marble') {
      return 6.2;
    }
    if (this.faceId === 'quartz-mono' || this.faceId === 'quartz-narrow') {
      return 6.4;
    }
    if (this.faceId === 'quartz-script') {
      return 9;
    }
    if (this.faceId === 'quartz-heavy') {
      return 8.4;
    }
    if (this.faceId === 'gousset' || this.faceId === 'chrono-silver') {
      return 6.2;
    }
    return this.serifFace || TYPED_QUARTZ.has(this.faceId) ? 8 : 7;
  }

  get numeralFont(): string {
    switch (this.faceId) {
      case 'quartz-serif':
        return 'Georgia, "Palatino Linotype", Palatino, serif';
      case 'quartz-mono':
        return 'Consolas, "Cascadia Mono", ui-monospace, monospace';
      case 'quartz-script':
        return '"Segoe Script", "Segoe Print", "Lucida Handwriting", cursive';
      case 'quartz-narrow':
        return 'Bahnschrift, "Arial Narrow", "Franklin Gothic Medium", sans-serif';
      case 'quartz-gothic':
        return '"Century Gothic", "Trebuchet MS", "Segoe UI", sans-serif';
      case 'quartz-heavy':
        return 'Impact, "Arial Black", sans-serif';
      default:
        break;
    }
    if (this.faceId === 'regulator') {
      return 'ui-monospace, monospace';
    }
    if (this.serifFace) {
      return 'Times New Roman, Times, serif';
    }
    return 'system-ui, sans-serif';
  }

  isTypedQuartz(id: string): boolean {
    return TYPED_QUARTZ.has(id);
  }

  get isSunburst(): boolean {
    return this.isSunburstId(this.faceId);
  }

  get hasDialWash(): boolean {
    return this.hasWashId(this.faceId);
  }

  get isDiver(): boolean {
    return this.faceId.startsWith('diver-');
  }

  get hasDateWindow(): boolean {
    return this.isDiver || this.faceId === 'dress-navy';
  }

  get hasDiveBezel(): boolean {
    return this.isDiver || this.faceId === 'chrono-black';
  }

  get isLed(): boolean {
    return this.faceId === 'lcd-led';
  }

  get isModule(): boolean {
    return this.faceId === 'lcd-module' || this.faceId === 'lcd-dive';
  }

  get chronoMark(): string {
    return this.faceId === 'chrono-green' || this.faceId === 'chrono-silver' ? 'AUTOMATIC' : 'QUARTZ';
  }

  get moduleClockTokens(): LcdToken[] {
    if (this.isModule && this.lcdTokens.length >= 8 && this.lcdTokens[5]?.kind === 'c') {
      return this.lcdTokens.slice(0, 5);
    }
    return this.lcdTokens;
  }

  get moduleSeconds(): string {
    if (!this.isModule || this.lcdTokens.length < 8 || this.lcdTokens[5]?.kind !== 'c') {
      return '';
    }
    return this.lcdTokens.slice(6).filter((tok) => tok.kind === 'd').map((tok) => tok.ch).join('');
  }

  get isChrono(): boolean {
    return this.faceId.startsWith('chrono-');
  }

  get hasSmallSeconds(): boolean {
    return this.faceId === 'gousset' || this.faceId === 'burst-sand';
  }

  get constellationPath(): string {
    return [0, 2, 4, 7, 9, 0].map((i) => `${this.hourMarks[i].x},${this.hourMarks[i].y}`).join(' ');
  }

  get dateY(): number {
    if (this.isChrono || this.hasSmallSeconds) {
      return 70;
    }
    if (this.hasDateWindow) {
      return 150;
    }
    if (this.faceId === 'hybrid-night') {
      return 154;
    }
    if (this.faceId === 'hybrid-radar' || this.faceId === 'hybrid-orbit') {
      return 156;
    }
    if (this.faceId === 'hybrid-sharp') {
      return 78;
    }
    if (this.isHybrid) {
      return 76;
    }
    if (this.isSharpAnalog) {
      return 150;
    }
    return 142;
  }

  get emailNeedsZone(): boolean {
    return !this.timeZoneChoice && this.alarms.some((a) => a.enabled && a.channel === 'email');
  }

  get showFraction(): boolean {
    return this.mode === 'chrono';
  }

  get chronoMs(): number {
    return this.chronoElapsed();
  }

  isSunburstId(id: string): boolean {
    return id.startsWith('burst-') || id.startsWith('chrono-') || id.startsWith('diver-')
      || id.startsWith('dress-') || id === 'gousset';
  }

  hasWashId(id: string): boolean {
    return !id.startsWith('lcd') && !id.startsWith('smart-') && !id.startsWith('board-')
      && id !== 'nixie' && id !== 'ultra-orange';
  }

  showBurstIndex(hourIndex: number): boolean {
    if (this.isDiver) {
      return false;
    }
    if (this.faceId === 'dress-navy' && hourIndex === 3) {
      return false;
    }
    if (this.isChrono && hourIndex % 3 === 0 && hourIndex !== 0) {
      return false;
    }
    return !(this.faceId === 'burst-sand' && hourIndex === 6);
  }

  miniKind(id: string): 'lcd' | 'nixie' | 'hybrid' | 'analog' | 'smart' | 'board' | 'resin' | 'round' | 'ultra' {
    if (id === 'ultra-orange') {
      return 'ultra';
    }
    if (id === 'lcd-resin') {
      return 'resin';
    }
    if (id === 'lcd-round') {
      return 'round';
    }
    if (id.startsWith('lcd')) {
      return 'lcd';
    }
    if (id === 'nixie') {
      return 'nixie';
    }
    if (id.startsWith('hybrid')) {
      return 'hybrid';
    }
    if (id.startsWith('smart-')) {
      return 'smart';
    }
    if (id.startsWith('board-')) {
      return 'board';
    }
    return 'analog';
  }

  lookScale(value: number): number {
    return value / 100;
  }

  lookBound(key: LookKey): { min: number; max: number } {
    return LOOK_RANGE[key];
  }

  stepLook(key: LookKey, dir: number): void {
    const range = LOOK_RANGE[key];
    const sign = dir < 0 ? -1 : 1;
    const next = this.clamp(this.look[key] + sign * range.step, range.min, range.max);
    if (next === this.look[key]) {
      return;
    }
    this.look = { ...this.look, [key]: next };
    this.scheduleSave();
  }

  resetLook(): void {
    this.look = defaultLook();
    this.scheduleSave();
  }

  setFace(id: string): void {
    if (!FACE_IDS.has(id) || id === this.faceId) {
      return;
    }
    this.faceId = id;
    this.refreshNumerals();
    this.scheduleSave();
    queueMicrotask(() => this.syncPageBg());
  }

  toggleFill(): void {
    this.fillScreen = !this.fillScreen;
    document.body.classList.toggle('clock-fill', this.fillScreen);
  }

  private syncPageBg(): void {
    const bg = getComputedStyle(this.hostEl.nativeElement).backgroundColor;
    if (bg) {
      document.documentElement.style.setProperty('--clock-html-bg', bg);
    }
  }

  @HostListener('document:keydown', ['$event'])
  onFaceArrow(event: KeyboardEvent): void {
    const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown';
    const backward = event.key === 'ArrowLeft' || event.key === 'ArrowUp';
    if (!forward && !backward) {
      return;
    }
    const target = event.target as HTMLElement | null;
    if (target?.closest('input, textarea, select, [contenteditable="true"]')) {
      return;
    }
    event.preventDefault();
    this.stepFace(forward ? 1 : -1);
  }

  @HostListener('touchstart', ['$event'])
  onFaceSwipeStart(event: TouchEvent): void {
    if (event.touches.length !== 1) {
      this.swipeActive = false;
      return;
    }
    const target = event.target as HTMLElement | null;
    if (target?.closest('button, a, input, textarea, select, .dock')) {
      this.swipeActive = false;
      return;
    }
    this.swipeActive = true;
    this.swipeStartX = event.touches[0].clientX;
    this.swipeStartY = event.touches[0].clientY;
  }

  @HostListener('touchend', ['$event'])
  onFaceSwipeEnd(event: TouchEvent): void {
    if (!this.swipeActive) {
      return;
    }
    this.swipeActive = false;
    const touch = event.changedTouches[0];
    if (!touch) {
      return;
    }
    const dx = touch.clientX - this.swipeStartX;
    const dy = touch.clientY - this.swipeStartY;
    if (Math.abs(dx) < 48 || Math.abs(dx) < Math.abs(dy)) {
      return;
    }
    this.stepFace(dx < 0 ? 1 : -1);
  }

  @HostListener('touchcancel')
  onFaceSwipeCancel(): void {
    this.swipeActive = false;
  }

  private stepFace(step: number): void {
    const index = FACES.findIndex((face) => face.id === this.faceId);
    const next = FACES[(index + step + FACES.length) % FACES.length];
    if (!next) {
      return;
    }
    this.setFace(next.id);
    queueMicrotask(() => {
      this.hostEl.nativeElement.querySelector('.swatch.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  }

  @HostListener('document:keydown.escape')
  exitFill(): void {
    if (!this.fillScreen) {
      return;
    }
    this.fillScreen = false;
    document.body.classList.remove('clock-fill');
  }

  setTimeZone(zone: string): void {
    const next = zone && this.isZone(zone) ? zone : '';
    if (next === this.timeZoneChoice) {
      return;
    }
    this.timeZoneChoice = next;
    this.scheduleSave();
  }

  setMode(mode: ClockMode): void {
    this.mode = mode;
  }

  tickRotate(index: number): string {
    return `rotate(${index * 6} 100 100)`;
  }

  segOn(ch: string, id: string): boolean {
    return (SEGMENTS[ch] ?? '').includes(id);
  }

  trackAlarm(_index: number, alarm: ClockAlarm): string {
    return alarm.id;
  }

  trackTimer(_index: number, timer: ClockTimer): string {
    return timer.id;
  }

  trackLap(index: number): number {
    return index;
  }

  pad(value: number): string {
    return String(Math.max(0, Math.floor(value))).padStart(2, '0');
  }

  formatMs(ms: number, withFrac: boolean): string {
    const clamped = Math.max(0, Math.floor(ms));
    const h = Math.floor(clamped / 3600000);
    const m = Math.floor(clamped / 60000) % 60;
    const s = Math.floor(clamped / 1000) % 60;
    const base = `${this.pad(Math.min(h, 99))}:${this.pad(m)}:${this.pad(s)}`;
    if (!withFrac) {
      return base;
    }
    return `${base}.${this.pad(Math.floor((clamped % 1000) / 10))}`;
  }

  timerRemaining(timer: ClockTimer): number {
    if (timer.running && timer.endsAt != null) {
      return Math.max(0, timer.endsAt - Date.now());
    }
    return Math.max(0, timer.remainingMs);
  }

  lapLabel(ms: number): string {
    return this.formatMs(ms, true);
  }

  startChrono(): void {
    if (this.chronoRunning) {
      return;
    }
    this.chronoRunning = true;
    this.chronoStartedAt = Date.now();
    this.writeRuntime();
  }

  pauseChrono(): void {
    if (!this.chronoRunning) {
      return;
    }
    this.chronoAccumulated = this.chronoElapsed();
    this.chronoRunning = false;
    this.writeRuntime();
  }

  resetChrono(): void {
    this.chronoRunning = false;
    this.chronoAccumulated = 0;
    this.chronoStartedAt = 0;
    this.laps = [];
    this.writeRuntime();
  }

  addLap(): void {
    if (!this.chronoRunning && this.chronoAccumulated === 0) {
      return;
    }
    this.laps = [this.chronoElapsed(), ...this.laps].slice(0, 30);
    this.writeRuntime();
  }

  addPreset(minutes: number): void {
    this.timerH = 0;
    this.timerM = minutes;
    this.timerS = 0;
    this.addTimer();
  }

  addTimer(): void {
    const h = this.clamp(Number(this.timerH) || 0, 0, 23);
    const m = this.clamp(Number(this.timerM) || 0, 0, 59);
    const s = this.clamp(Number(this.timerS) || 0, 0, 59);
    const durationMs = ((h * 60 + m) * 60 + s) * 1000;
    if (durationMs <= 0 || this.timers.length >= 12) {
      return;
    }
    const timer: ClockTimer = {
      id: this.newId(),
      label: (this.timerLabel || '').trim().slice(0, 80),
      durationMs,
      remainingMs: durationMs,
      running: false,
      endsAt: null,
      done: false
    };
    this.timers = [...this.timers, timer];
    this.focusTimerId = timer.id;
    this.timerLabel = '';
    this.writeRuntime();
  }

  toggleTimer(timer: ClockTimer): void {
    this.focusTimerId = timer.id;
    if (timer.running) {
      timer.remainingMs = this.timerRemaining(timer);
      timer.running = false;
      timer.endsAt = null;
    } else {
      if (timer.remainingMs <= 0) {
        timer.remainingMs = timer.durationMs;
      }
      timer.done = false;
      timer.running = true;
      timer.endsAt = Date.now() + timer.remainingMs;
    }
    this.writeRuntime();
  }

  resetTimer(timer: ClockTimer): void {
    timer.running = false;
    timer.endsAt = null;
    timer.remainingMs = timer.durationMs;
    timer.done = false;
    this.focusTimerId = timer.id;
    this.writeRuntime();
  }

  selectTimer(timer: ClockTimer): void {
    this.focusTimerId = timer.id;
    this.writeRuntime();
  }

  removeTimer(timer: ClockTimer): void {
    this.timers = this.timers.filter((t) => t.id !== timer.id);
    if (this.focusTimerId === timer.id) {
      this.focusTimerId = this.timers[0]?.id ?? '';
    }
    this.writeRuntime();
  }

  addAlarm(): void {
    const match = /^(\d{2}):(\d{2})/.exec(this.alarmDraft || '');
    if (!match || this.alarms.length >= 24) {
      return;
    }
    const channel: AlarmChannel = this.alarmChannel === 'email' ? 'email' : 'ring';
    if (channel === 'email' && !this.timeZoneChoice) {
      this.timeZoneChoice = this.browserZone;
    }
    const alarm: ClockAlarm = {
      id: this.newId(),
      hour: Number(match[1]),
      minute: Number(match[2]),
      label: (this.alarmLabel || '').trim().slice(0, 80),
      channel,
      enabled: true,
      lastFiredDate: ''
    };
    this.alarms = [...this.alarms, alarm];
    this.alarmLabel = '';
    this.scheduleSave();
  }

  toggleAlarm(alarm: ClockAlarm): void {
    alarm.enabled = !alarm.enabled;
    if (alarm.enabled && alarm.channel === 'email' && !this.timeZoneChoice) {
      this.timeZoneChoice = this.browserZone;
    }
    this.scheduleSave();
  }

  removeAlarm(alarm: ClockAlarm): void {
    this.alarms = this.alarms.filter((a) => a.id !== alarm.id);
    this.scheduleSave();
  }

  dismissRing(): void {
    this.ringing = false;
    this.ringMessage = '';
    this.emailNotice = '';
    this.stopChime();
  }

  private tick(): void {
    this.pollEvents();
    const now = new Date();
    this.refreshDisplay(now, this.zonedParts(now, this.effectiveZone));
  }

  private paint(): void {
    if (!this.alive) {
      return;
    }
    this.frame = requestAnimationFrame(() => {
      const now = new Date();
      this.refreshDisplay(now, this.zonedParts(now, this.effectiveZone));
      this.cdr.detectChanges();
      this.paint();
    });
  }

  private pollEvents(): void {
    const now = new Date();
    const parts = this.zonedParts(now, this.effectiveZone);
    this.checkAlarms(parts.h, parts.m, parts.day);
    this.checkTimers();
  }

  private refreshDisplay(now: Date, parts: ZonedParts): void {
    const lang = this.translate.currentLang || this.translate.getDefaultLang() || 'fr';
    const dateKey = `${parts.day}|${this.effectiveZone}`;
    if (this.dateKey !== dateKey || this.dateLang !== lang) {
      this.dateKey = dateKey;
      this.dateLang = lang;
      try {
        this.dateLabel = new Intl.DateTimeFormat(lang, {
          timeZone: this.effectiveZone,
          weekday: 'long',
          day: 'numeric',
          month: 'long',
          year: 'numeric'
        }).format(now);
      } catch {
        this.dateLabel = parts.day;
      }
      this.shortDate = this.formatShortDate(now, lang);
      this.formatWatchBits(now, lang);
    }
    this.dateNum = (parts.day || '').slice(-2);
    let smoothSec: number;
    let minute: number;
    let hourTurns: number;
    let digital: string;

    if (this.mode === 'chrono') {
      const ms = this.chronoElapsed();
      digital = this.formatMs(ms, false);
      this.fraction = this.formatMs(ms, true).split('.')[1] ?? '00';
      const total = ms / 1000;
      smoothSec = total % 60;
      minute = (total / 60) % 60;
      hourTurns = (total / 3600) % 12;
    } else if (this.mode === 'timer' && this.focusTimer()) {
      const ms = this.timerRemaining(this.focusTimer()!);
      digital = this.formatMs(ms, false);
      this.fraction = '';
      const total = ms / 1000;
      smoothSec = total % 60;
      minute = (total / 60) % 60;
      hourTurns = (total / 3600) % 12;
    } else {
      smoothSec = parts.s + now.getMilliseconds() / 1000;
      minute = parts.m + smoothSec / 60;
      hourTurns = (parts.h % 12) + minute / 60;
      digital = `${this.pad(parts.h)}:${this.pad(parts.m)}:${this.pad(parts.s)}`;
      this.fraction = '';
    }

    this.hourAngle = hourTurns * 30;
    this.minuteAngle = minute * 6;
    this.secondAngle = smoothSec * 6;
    this.colonOn = Math.floor(smoothSec) % 2 === 0;
    if (this.readout !== digital) {
      this.readout = digital;
      this.lcdTokens = this.toLcd(digital);
    }
  }

  private checkAlarms(hour: number, minute: number, day: string): void {
    let ring = false;
    let mail = false;
    let changed = false;
    for (const alarm of this.alarms) {
      if (!alarm.enabled || alarm.hour !== hour || alarm.minute !== minute) {
        continue;
      }
      if (alarm.channel === 'email') {
        if (alarm.lastFiredDate === day) {
          continue;
        }
        const key = `${alarm.id}|${day}`;
        if (!this.emailSeen.has(key)) {
          this.emailSeen.add(key);
          mail = true;
        }
        continue;
      }
      if (alarm.lastFiredDate === day) {
        continue;
      }
      alarm.lastFiredDate = day;
      changed = true;
      ring = true;
      this.ringMessage = alarm.label || this.translate.instant('CLOCK.RINGING');
    }
    if (mail) {
      this.showEmailNotice();
    }
    if (ring) {
      this.ringing = true;
      this.beginChime();
    }
    if (changed) {
      this.scheduleSave();
    }
  }

  private checkTimers(): void {
    let finished = false;
    for (const timer of this.timers) {
      if (!timer.running || timer.endsAt == null) {
        continue;
      }
      if (timer.endsAt > Date.now()) {
        continue;
      }
      timer.running = false;
      timer.endsAt = null;
      timer.remainingMs = 0;
      timer.done = true;
      finished = true;
      this.ringMessage = timer.label || this.translate.instant('CLOCK.TIMER_DONE');
    }
    if (!finished) {
      return;
    }
    this.ringing = true;
    this.beginChime();
    this.writeRuntime();
  }

  private focusTimer(): ClockTimer | null {
    return this.timers.find((t) => t.id === this.focusTimerId)
      ?? this.timers.find((t) => t.running)
      ?? this.timers[0]
      ?? null;
  }

  private chronoElapsed(): number {
    if (!this.chronoRunning) {
      return this.chronoAccumulated;
    }
    return this.chronoAccumulated + Math.max(0, Date.now() - this.chronoStartedAt);
  }

  private showEmailNotice(): void {
    const email = this.notifyEmail;
    this.emailNotice = email
      ? this.translate.instant('CLOCK.EMAIL_TO', { email })
      : this.translate.instant('CLOCK.EMAIL_NOTICE');
    if (this.emailTimer != null) {
      clearTimeout(this.emailTimer);
    }
    this.emailTimer = setTimeout(() => {
      this.emailNotice = '';
    }, 15000);
  }

  private scheduleSave(): void {
    this.dirty = true;
    this.writeLocalPrefs();
    const gen = ++this.saveGen;
    if (this.saveTimer != null) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => this.putRemote(gen), 400);
  }

  private putRemote(gen: number): void {
    if (!this.keycloak.isLoggedIn()) {
      if (gen === this.saveGen) {
        this.dirty = false;
      }
      return;
    }
    this.http.put<ClockPrefs>(this.prefsUrl, this.payload()).subscribe({
      next: (prefs) => {
        if (gen !== this.saveGen) {
          return;
        }
        this.notifyEmail = (prefs?.notifyEmail || '').trim();
        this.dirty = false;
      },
      error: () => { /* local copy remains */ }
    });
  }

  private applyRemote(prefs: ClockPrefs): void {
    if (this.dirty || !prefs) {
      return;
    }
    const face = (prefs.faceId || '').trim();
    this.faceId = FACE_IDS.has(face) ? face : 'classic';
    const zone = (prefs.timeZone || '').trim();
    this.timeZoneChoice = zone && this.isZone(zone) ? zone : '';
    this.alarms = Array.isArray(prefs.alarms) ? prefs.alarms.map((a) => this.normalizeAlarm(a)) : [];
    this.notifyEmail = (prefs.notifyEmail || '').trim();
    this.look = {
      contrast: this.readLook(prefs.contrast, LOOK_RANGE.contrast),
      brightness: this.readLook(prefs.brightness, LOOK_RANGE.brightness),
      reflection: this.readLook(prefs.reflection, LOOK_RANGE.reflection),
      intensity: this.readLook(prefs.intensity, LOOK_RANGE.intensity),
      brilliance: this.readLook(prefs.brilliance, LOOK_RANGE.brilliance)
    };
    this.refreshNumerals();
    this.writeLocalPrefs();
    queueMicrotask(() => this.syncPageBg());
  }

  private payload(): ClockPrefs {
    return {
      faceId: this.faceId,
      timeZone: this.timeZoneChoice,
      contrast: this.look.contrast,
      brightness: this.look.brightness,
      reflection: this.look.reflection,
      intensity: this.look.intensity,
      brilliance: this.look.brilliance,
      alarms: this.alarms.map((a) => ({
        id: a.id,
        hour: a.hour,
        minute: a.minute,
        label: a.label,
        channel: a.channel,
        enabled: a.enabled,
        lastFiredDate: a.lastFiredDate
      }))
    };
  }

  private readLook(value: unknown, range: { min: number; max: number }): number {
    const n = Number(value);
    if (!Number.isFinite(n)) {
      return 100;
    }
    return this.clamp(Math.round(n), range.min, range.max);
  }

  private normalizeAlarm(raw: ClockAlarm): ClockAlarm {
    const channel: AlarmChannel = raw?.channel === 'email' ? 'email' : 'ring';
    return {
      id: raw?.id || this.newId(),
      hour: this.clamp(Number(raw?.hour) || 0, 0, 23),
      minute: this.clamp(Number(raw?.minute) || 0, 0, 59),
      label: (raw?.label || '').slice(0, 80),
      channel,
      enabled: raw?.enabled !== false,
      lastFiredDate: /^\d{4}-\d{2}-\d{2}$/.test(raw?.lastFiredDate || '') ? raw.lastFiredDate : ''
    };
  }

  private restoreLocal(): void {
    try {
      const raw = localStorage.getItem(PREFS_KEY);
      if (raw) {
        this.applyRemote(JSON.parse(raw) as ClockPrefs);
        this.dirty = false;
      }
    } catch {
      /* ignore broken local prefs */
    }
    try {
      const raw = localStorage.getItem(RUNTIME_KEY);
      if (!raw) {
        return;
      }
      const data = JSON.parse(raw) as {
        chronoRunning?: boolean;
        chronoAccumulated?: number;
        chronoStartedAt?: number;
        laps?: number[];
        timers?: ClockTimer[];
        focusTimerId?: string;
      };
      this.chronoRunning = !!data.chronoRunning;
      this.chronoAccumulated = Number(data.chronoAccumulated) || 0;
      this.chronoStartedAt = Number(data.chronoStartedAt) || 0;
      this.laps = Array.isArray(data.laps) ? data.laps.filter((n) => Number.isFinite(n)).slice(0, 30) : [];
      this.focusTimerId = data.focusTimerId || '';
      this.timers = Array.isArray(data.timers) ? data.timers.map((t) => this.normalizeTimer(t)) : [];
    } catch {
      /* ignore broken runtime */
    }
  }

  private normalizeTimer(raw: ClockTimer): ClockTimer {
    const timer: ClockTimer = {
      id: raw?.id || this.newId(),
      label: (raw?.label || '').slice(0, 80),
      durationMs: Math.max(0, Number(raw?.durationMs) || 0),
      remainingMs: Math.max(0, Number(raw?.remainingMs) || 0),
      running: !!raw?.running,
      endsAt: raw?.endsAt == null ? null : Number(raw.endsAt),
      done: !!raw?.done
    };
    if (timer.running && timer.endsAt != null && timer.endsAt <= Date.now()) {
      timer.running = false;
      timer.endsAt = null;
      timer.remainingMs = 0;
      timer.done = true;
    }
    return timer;
  }

  private writeLocalPrefs(): void {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(this.payload()));
    } catch {
      /* private mode */
    }
  }

  private writeRuntime(): void {
    try {
      localStorage.setItem(RUNTIME_KEY, JSON.stringify({
        chronoRunning: this.chronoRunning,
        chronoAccumulated: this.chronoRunning ? this.chronoAccumulated : this.chronoElapsed(),
        chronoStartedAt: this.chronoStartedAt,
        laps: this.laps,
        timers: this.timers,
        focusTimerId: this.focusTimerId
      }));
    } catch {
      /* private mode */
    }
  }

  private refreshNumerals(): void {
    if (this.numeralFace === this.faceId) {
      return;
    }
    this.numeralFace = this.faceId;
    this.numerals = this.buildNumerals();
  }

  private buildNumerals(): Numeral[] {
    const roman = ['XII', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI'];
    const items: Numeral[] = [];
    const sport = this.faceId === 'sport';
    for (let n = 1; n <= 12; n++) {
      let text = '';
      if (this.faceId === 'roman' || this.faceId === 'gold' || this.faceId === 'guilloche' || this.faceId === 'cathedral' || this.faceId === 'gousset') {
        text = roman[n - 1];
      } else if (this.faceId === 'chrono-silver' && (n === 12 || n % 2 === 0) && n !== 6) {
        text = String(n);
      } else if (sport || this.faceId === 'field-cream' || this.faceId === 'aviator' || TYPED_QUARTZ.has(this.faceId)) {
        text = String(n);
      } else if ((this.faceId === 'classic' || this.faceId === 'deco' || this.faceId === 'marine' || this.faceId === 'marble') && n % 3 === 0) {
        text = String(n);
      } else if (this.faceId === 'regulator') {
        text = n === 12 ? '60' : String(n * 5).padStart(2, '0');
      } else {
        continue;
      }
      const ang = ((n * 30 - 90) * Math.PI) / 180;
      const r = this.faceId === 'regulator' ? 82
        : this.faceId === 'guilloche' ? 58
          : this.faceId === 'cathedral' ? 48
            : this.faceId === 'marine' ? 54
              : this.faceId === 'gousset' || this.faceId === 'field-cream' ? 58
                : this.faceId === 'chrono-silver' ? 52
                  : sport || this.faceId === 'aviator' ? 60
                    : TYPED_QUARTZ.has(this.faceId) ? 64
                      : 68;
      items.push({
        text,
        x: 100 + r * Math.cos(ang),
        y: 100 + r * Math.sin(ang)
      });
    }
    return items;
  }

  private formatShortDate(now: Date, lang: string): string {
    const locale = CLOCK_LOCALES[lang] || lang || 'fr-FR';
    try {
      return new Intl.DateTimeFormat(locale, {
        timeZone: this.effectiveZone,
        day: 'numeric',
        month: 'short',
        year: 'numeric'
      }).format(now);
    } catch {
      return this.dateLabel;
    }
  }

  private formatWatchBits(now: Date, lang: string): void {
    const locale = CLOCK_LOCALES[lang] || lang || 'fr-FR';
    try {
      this.weekShort = new Intl.DateTimeFormat(locale, {
        timeZone: this.effectiveZone,
        weekday: 'short'
      }).format(now).replace(/\./g, '').toLocaleUpperCase(locale);
      this.moduleDate = new Intl.DateTimeFormat(locale, {
        timeZone: this.effectiveZone,
        day: '2-digit',
        month: '2-digit'
      }).format(now);
    } catch {
      this.weekShort = '';
      this.moduleDate = this.dateNum;
    }
  }

  private toLcd(digital: string): LcdToken[] {
    const tokens: LcdToken[] = [];
    for (const ch of digital) {
      tokens.push(ch === ':' ? { kind: 'c', ch } : { kind: 'd', ch });
    }
    return tokens;
  }

  private zonedParts(date: Date, timeZone: string): ZonedParts {
    try {
      const map: Record<string, string> = {};
      for (const part of new Intl.DateTimeFormat('en-GB', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      }).formatToParts(date)) {
        map[part.type] = part.value;
      }
      let h = Number(map['hour']);
      if (h === 24) {
        h = 0;
      }
      return {
        h,
        m: Number(map['minute']),
        s: Number(map['second']),
        day: `${map['year']}-${map['month']}-${map['day']}`
      };
    } catch {
      return {
        h: date.getHours(),
        m: date.getMinutes(),
        s: date.getSeconds(),
        day: `${date.getFullYear()}-${this.pad(date.getMonth() + 1)}-${this.pad(date.getDate())}`
      };
    }
  }

  private readBrowserZone(): string {
    try {
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      return zone && this.isZone(zone) ? zone : 'UTC';
    } catch {
      return 'UTC';
    }
  }

  private loadZones(): string[] {
    try {
      const intl = Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] };
      if (typeof intl.supportedValuesOf === 'function') {
        const zones = intl.supportedValuesOf('timeZone');
        if (Array.isArray(zones) && zones.length > 0) {
          return zones;
        }
      }
    } catch {
      /* older engines */
    }
    return ['UTC', 'Europe/Paris', 'Europe/London', 'America/New_York', 'Asia/Tokyo'];
  }

  private isZone(zone: string): boolean {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: zone });
      return true;
    } catch {
      return false;
    }
  }

  private beginChime(): void {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate([200, 80, 200, 80, 280]);
    }
    this.ensureAudio();
    if (this.chimeTimer != null) {
      return;
    }
    this.playBeep();
    this.chimeTimer = setInterval(() => this.playBeep(), 1600);
  }

  private stopChime(): void {
    if (this.chimeTimer != null) {
      clearInterval(this.chimeTimer);
      this.chimeTimer = null;
    }
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(0);
    }
  }

  private ensureAudio(): void {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) {
      return;
    }
    if (!this.audioCtx) {
      this.audioCtx = new Ctx();
    }
    if (this.audioCtx.state === 'suspended') {
      void this.audioCtx.resume();
    }
  }

  private playBeep(): void {
    const ctx = this.audioCtx;
    if (!ctx || ctx.state !== 'running') {
      return;
    }
    const start = ctx.currentTime + 0.02;
    this.tone(ctx, 880, start, 0.16);
    this.tone(ctx, 1175, start + 0.18, 0.22);
  }

  private tone(ctx: AudioContext, freq: number, when: number, duration: number): void {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(0.18, when + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(when);
    osc.stop(when + duration + 0.02);
  }

  private clamp(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) {
      return min;
    }
    return Math.max(min, Math.min(max, Math.round(value)));
  }

  private newId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return `a${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`;
  }
}
