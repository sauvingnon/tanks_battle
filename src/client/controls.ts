import { GUN_PITCH_MAX, GUN_PITCH_MIN } from '../shared/constants.js';
import { clamp } from '../shared/sim.js';
import { aimAngle } from './topview.js';

const LOOK_SENSITIVITY = 0.0026;
const PITCH_MIN = -0.15;
const PITCH_MAX = 1.05;
/** Обычное положение камеры: чуть выше танка. Ему отвечает горизонтальный ствол. */
const PITCH_REST = 0.42;
const STICK_RADIUS = 56;

/**
 * Мёртвая зона стика наводки, px. Без неё касание правой половины экрана
 * швыряло бы башню в случайную сторону: направление от точки к ней же самой
 * не определено, и первые пиксели движения пальца дают чистый шум.
 */
const AIM_DEADZONE = 14;

/**
 * Насколько далеко надо увести стик наводки, чтобы он ещё и стрелял, в долях
 * радиуса. Лёгкое касание только доворачивает башню, уверенный вынос пальца —
 * бьёт: иначе большой палец не успевал бы уходить с наводки на кнопку огня и
 * обратно, а каждая правка прицела означала бы выстрел не туда.
 */
const AIM_FIRE_PUSH = 0.72;

/** Отдаление камеры: метры от танка, пределы и цена одного «щелчка» колеса. */
const ZOOM_DEFAULT = 15;
const ZOOM_MIN = 7;
const ZOOM_MAX = 36;
const ZOOM_PER_PIXEL = 0.02;

/**
 * Ввод игрока, приведённый к абстрактным осям. Клавиатура и тач пишут в одни и те
 * же поля, поэтому игровой логике всё равно, с чего играют.
 */
export class Controls {
  /** Куда смотрит камера. Башня доворачивается к этому углу. */
  yaw = 0;
  pitch = PITCH_REST;
  /** Насколько камера отнесена от танка, м. Крутится колесом и щипком. */
  distance = ZOOM_DEFAULT;

  throttle = 0;
  steer = 0;
  /** Огонь удерживается: перезарядку считает сервер, поэтому зажатая кнопка стреляет очередями. */
  fire = false;

  readonly isTouch = matchMedia('(hover: none) and (pointer: coarse)').matches;

  /**
   * Вертикальная наводка, рад. Ею правит та же мышь, что и высотой камеры:
   * ведёшь взгляд выше — ствол идёт выше.
   *
   * Отдельной оси для ствола взять неоткуда, а «луч камеры» на прицел не годится:
   * камера здесь смотрит на свой же танк, и её центр всегда упирается в землю
   * рядом с ним. Поэтому наводка считается прямо из положения камеры: обычное её
   * положение (PITCH_REST) — это горизонтальный ствол, а до упоров вверх и вниз
   * ствол разворачивается на весь свой ход. Обе половины считаются отдельно,
   * иначе ноль ушёл бы с обычного положения и ствол смотрел бы в землю по
   * умолчанию.
   *
   * На картах без рельефа наводка серверу не отправляется вовсе — там её нет.
   */
  get gunPitch(): number {
    if (this.pitch <= PITCH_REST) {
      return (GUN_PITCH_MAX * (PITCH_REST - this.pitch)) / (PITCH_REST - PITCH_MIN);
    }
    return (GUN_PITCH_MIN * (this.pitch - PITCH_REST)) / (PITCH_MAX - PITCH_REST);
  }

  /**
   * Вид сверху. Обзора как такового в нём нет: yaw — это не «куда смотрит
   * камера», а прямое направление наводки, и правая половина экрана вместе с
   * мышью работают на него, а не на камеру.
   */
  private top = false;

  private readonly keys = new Set<string>();

  private stickTouchId: number | null = null;
  private stickOrigin = { x: 0, y: 0 };

  /**
   * Палец на правой половине. В виде от третьего лица он крутит камеру, в виде
   * сверху — наводит башню; в обоих случаях это один и тот же палец, поэтому и
   * щипок зума вторым пальцем считается одинаково.
   */
  private lookTouchId: number | null = null;
  private lookPrev = { x: 0, y: 0 };
  /** Откуда стик наводки считает направление: точка первого касания. */
  private aimOrigin = { x: 0, y: 0 };
  /** Стик наводки уведён достаточно далеко, чтобы стрелять. */
  private aimFire = false;

  /** Второй палец на правой половине: вместе с lookTouchId даёт щипок зума. */
  private pinchTouchId: number | null = null;
  private pinchPoint = { x: 0, y: 0 };
  private pinchGap = 0;

  private fireTouchId: number | null = null;
  private mouseFire = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly stick: HTMLElement,
    private readonly knob: HTMLElement,
    private readonly fireButton: HTMLElement,
    private readonly aimStick: HTMLElement,
    private readonly aimKnob: HTMLElement,
  ) {}

  /** Смена вида. Курсор и недоведённые касания с прошлого вида не переносим. */
  setTopView(on: boolean): void {
    if (this.top === on) return;
    this.top = on;
    this.lookTouchId = null;
    this.pinchTouchId = null;
    this.aimFire = false;
    this.mouseFire = false;
    this.hideAim();
    // Вид сверху целится курсором — держать его захваченным незачем.
    if (on && document.pointerLockElement === this.canvas) document.exitPointerLock();
  }

  attach(): void {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);

    this.canvas.addEventListener('click', this.onCanvasClick);
    // passive: false — иначе браузер не даст отменить прокрутку и масштаб страницы.
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    // Правая кнопка не должна открывать меню поверх игры.
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    this.fireButton.addEventListener('touchstart', this.onFireStart, { passive: false });
    this.fireButton.addEventListener('touchend', this.onFireEnd);
    this.fireButton.addEventListener('touchcancel', this.onFireEnd);

    this.canvas.addEventListener('touchstart', this.onTouchStart, { passive: false });
    this.canvas.addEventListener('touchmove', this.onTouchMove, { passive: false });
    this.canvas.addEventListener('touchend', this.onTouchEnd);
    this.canvas.addEventListener('touchcancel', this.onTouchEnd);
  }

  /** Пересчитывает оси из состояния клавиш. Пока держат тач-стик — не трогаем. */
  update(): void {
    this.fire =
      this.mouseFire || this.fireTouchId !== null || this.aimFire || this.keys.has('Space');
    if (this.stickTouchId !== null) return;

    const forward = this.pressed('KeyW', 'ArrowUp');
    const back = this.pressed('KeyS', 'ArrowDown');
    const left = this.pressed('KeyA', 'ArrowLeft');
    const right = this.pressed('KeyD', 'ArrowRight');

    this.throttle = (forward ? 1 : 0) - (back ? 1 : 0);
    // +1 = влево: поворот против часовой стрелки, как и рост угла в симуляции.
    this.steer = (left ? 1 : 0) - (right ? 1 : 0);
  }

  private pressed(...codes: string[]): boolean {
    return codes.some((code) => this.keys.has(code));
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement) return;
    this.keys.add(e.code);
    if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
  };

  private onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code);
  };

  /** При потере фокуса окна клавиши «залипают» — сбрасываем. */
  private onBlur = () => {
    this.keys.clear();
    this.throttle = 0;
    this.steer = 0;
    this.mouseFire = false;
    this.aimFire = false;
    this.fire = false;
  };

  private onCanvasClick = () => {
    // В виде сверху курсор — это прицел: захватывать его нельзя, иначе целиться
    // станет нечем.
    if (this.isTouch || this.top) return;
    if (document.pointerLockElement !== this.canvas) {
      void this.canvas.requestPointerLock();
    }
  };

  private onMouseDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    if (this.top) {
      // Курсор в виде сверху не захвачен, и по экрану разложены кнопки. Стреляет
      // только клик по самой карте, иначе выбор карты в настройках был бы залпом.
      if (e.target === this.canvas) this.mouseFire = true;
      return;
    }
    // Пока курсор не захвачен, клик — это просьба захватить его, а не выстрел.
    if (document.pointerLockElement !== this.canvas) return;
    this.mouseFire = true;
  };

  private onMouseUp = (e: MouseEvent) => {
    if (e.button === 0) this.mouseFire = false;
  };

  private onFireStart = (e: TouchEvent) => {
    e.preventDefault();
    if (this.fireTouchId === null) this.fireTouchId = e.changedTouches[0].identifier;
  };

  private onFireEnd = (e: TouchEvent) => {
    for (const touch of Array.from(e.changedTouches)) {
      if (touch.identifier === this.fireTouchId) this.fireTouchId = null;
    }
  };

  /** Колесо отдаляет и приближает камеру. */
  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    // deltaMode: 0 — пиксели, 1 — строки (Firefox), 2 — страницы. Приводим к пикселям.
    const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1;
    this.zoomBy(e.deltaY * scale * ZOOM_PER_PIXEL);
  };

  private zoomBy(delta: number): void {
    this.distance = clamp(this.distance + delta, ZOOM_MIN, ZOOM_MAX);
  }

  /** Пальцы разъехались — приближаем, сошлись — отдаляем. */
  private applyPinch(): void {
    if (this.pinchTouchId === null || this.lookTouchId === null) return;
    const gap = Math.hypot(this.pinchPoint.x - this.lookPrev.x, this.pinchPoint.y - this.lookPrev.y);
    if (this.pinchGap > 0) this.zoomBy((this.pinchGap - gap) * ZOOM_PER_PIXEL);
    this.pinchGap = gap;
  }

  private onMouseMove = (e: MouseEvent) => {
    if (this.top) {
      // В виде сверху танк всегда в центре кадра, так что направление наводки —
      // это направление от центра экрана к курсору.
      this.aimAt(
        e.clientX - this.canvas.clientWidth / 2,
        e.clientY - this.canvas.clientHeight / 2,
      );
      return;
    }
    if (document.pointerLockElement !== this.canvas) return;
    this.applyLook(e.movementX, e.movementY);
  };

  private applyLook(dx: number, dy: number): void {
    // Вправо по экрану = -X в мире, поэтому yaw уменьшается.
    this.yaw -= dx * LOOK_SENSITIVITY;
    this.pitch = clamp(this.pitch + dy * LOOK_SENSITIVITY, PITCH_MIN, PITCH_MAX);
  }

  /** Направление наводки по смещению от танка на экране, в пикселях. */
  private aimAt(dx: number, dy: number): void {
    if (Math.hypot(dx, dy) < AIM_DEADZONE) return;
    this.yaw = aimAngle(dx, dy);
  }

  // --- Тач: левая половина экрана — джойстик, правая — обзор или наводка ---

  /** Стик наводки встаёт туда, где палец лёг на экран. */
  private showAim(x: number, y: number): void {
    this.aimOrigin = { x, y };
    this.aimStick.style.left = `${x - STICK_RADIUS - 10}px`;
    this.aimStick.style.top = `${y - STICK_RADIUS - 10}px`;
    this.aimStick.style.opacity = '1';
    this.aimKnob.style.transform = '';
  }

  private hideAim(): void {
    this.aimStick.style.opacity = '0';
    this.aimKnob.style.transform = '';
  }

  /** Палец на стике наводки: направление башни и, если увели далеко, огонь. */
  private applyAim(x: number, y: number): void {
    const dx = x - this.aimOrigin.x;
    const dy = y - this.aimOrigin.y;
    this.aimAt(dx, dy);
    this.aimFire = Math.hypot(dx, dy) >= STICK_RADIUS * AIM_FIRE_PUSH;
    const kx = clamp(dx, -STICK_RADIUS, STICK_RADIUS);
    const ky = clamp(dy, -STICK_RADIUS, STICK_RADIUS);
    this.aimKnob.style.transform = `translate(${kx}px, ${ky}px)`;
    this.aimStick.classList.toggle('is-firing', this.aimFire);
  }

  private onTouchStart = (e: TouchEvent) => {
    e.preventDefault();
    for (const touch of Array.from(e.changedTouches)) {
      const isLeftHalf = touch.clientX < window.innerWidth / 2;
      if (isLeftHalf && this.stickTouchId === null) {
        this.stickTouchId = touch.identifier;
        this.stickOrigin = { x: touch.clientX, y: touch.clientY };
        // Джойстик появляется там, где палец коснулся экрана.
        this.stick.style.left = `${touch.clientX - STICK_RADIUS - 10}px`;
        this.stick.style.top = `${touch.clientY - STICK_RADIUS - 10}px`;
        this.stick.style.bottom = 'auto';
        this.stick.style.opacity = '1';
      } else if (!isLeftHalf && this.lookTouchId === null) {
        this.lookTouchId = touch.identifier;
        this.lookPrev = { x: touch.clientX, y: touch.clientY };
        if (this.top) this.showAim(touch.clientX, touch.clientY);
      } else if (!isLeftHalf && this.pinchTouchId === null) {
        // Второй палец на правой половине — щипок зума вместо обзора.
        this.pinchTouchId = touch.identifier;
        this.pinchPoint = { x: touch.clientX, y: touch.clientY };
        this.pinchGap = Math.hypot(
          this.pinchPoint.x - this.lookPrev.x,
          this.pinchPoint.y - this.lookPrev.y,
        );
      }
    }
  };

  private onTouchMove = (e: TouchEvent) => {
    e.preventDefault();
    for (const touch of Array.from(e.changedTouches)) {
      if (touch.identifier === this.stickTouchId) {
        const dx = touch.clientX - this.stickOrigin.x;
        const dy = touch.clientY - this.stickOrigin.y;
        this.steer = clamp(-dx / STICK_RADIUS, -1, 1);
        this.throttle = clamp(-dy / STICK_RADIUS, -1, 1);
        const kx = clamp(dx, -STICK_RADIUS, STICK_RADIUS);
        const ky = clamp(dy, -STICK_RADIUS, STICK_RADIUS);
        this.knob.style.transform = `translate(${kx}px, ${ky}px)`;
      } else if (touch.identifier === this.lookTouchId) {
        // Пока идёт щипок, тот же палец не крутит камеру и не наводит — иначе
        // при каждом зуме башня уезжала бы вслед за разъезжающимися пальцами.
        if (this.pinchTouchId === null) {
          if (this.top) this.applyAim(touch.clientX, touch.clientY);
          else this.applyLook(touch.clientX - this.lookPrev.x, touch.clientY - this.lookPrev.y);
        }
        this.lookPrev = { x: touch.clientX, y: touch.clientY };
        this.applyPinch();
      } else if (touch.identifier === this.pinchTouchId) {
        this.pinchPoint = { x: touch.clientX, y: touch.clientY };
        this.applyPinch();
      }
    }
  };

  private onTouchEnd = (e: TouchEvent) => {
    for (const touch of Array.from(e.changedTouches)) {
      if (touch.identifier === this.stickTouchId) {
        this.stickTouchId = null;
        this.throttle = 0;
        this.steer = 0;
        this.knob.style.transform = '';
        this.stick.style.opacity = '0.35';
      } else if (touch.identifier === this.lookTouchId) {
        this.lookTouchId = null;
        // Башня остаётся там, куда её довели: направление держится само, и
        // палец нужен только чтобы его сменить.
        this.aimFire = false;
        this.aimStick.classList.remove('is-firing');
        this.hideAim();
      } else if (touch.identifier === this.pinchTouchId) {
        this.pinchTouchId = null;
      }
    }
  };
}
