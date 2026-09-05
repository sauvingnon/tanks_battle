import { clamp } from '../shared/sim.js';

const LOOK_SENSITIVITY = 0.0026;
const PITCH_MIN = -0.15;
const PITCH_MAX = 1.05;
const STICK_RADIUS = 56;

/**
 * Ввод игрока, приведённый к абстрактным осям. Клавиатура и тач пишут в одни и те
 * же поля, поэтому игровой логике всё равно, с чего играют.
 */
export class Controls {
  /** Куда смотрит камера. Башня доворачивается к этому углу. */
  yaw = 0;
  pitch = 0.42;

  throttle = 0;
  steer = 0;

  readonly isTouch = matchMedia('(hover: none) and (pointer: coarse)').matches;

  private readonly keys = new Set<string>();

  private stickTouchId: number | null = null;
  private stickOrigin = { x: 0, y: 0 };

  private lookTouchId: number | null = null;
  private lookPrev = { x: 0, y: 0 };

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly stick: HTMLElement,
    private readonly knob: HTMLElement,
  ) {}

  attach(): void {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);

    this.canvas.addEventListener('click', this.onCanvasClick);
    window.addEventListener('mousemove', this.onMouseMove);

    this.canvas.addEventListener('touchstart', this.onTouchStart, { passive: false });
    this.canvas.addEventListener('touchmove', this.onTouchMove, { passive: false });
    this.canvas.addEventListener('touchend', this.onTouchEnd);
    this.canvas.addEventListener('touchcancel', this.onTouchEnd);
  }

  /** Пересчитывает оси из состояния клавиш. Пока держат тач-стик — не трогаем. */
  update(): void {
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
  };

  private onCanvasClick = () => {
    if (this.isTouch) return;
    if (document.pointerLockElement !== this.canvas) {
      void this.canvas.requestPointerLock();
    }
  };

  private onMouseMove = (e: MouseEvent) => {
    if (document.pointerLockElement !== this.canvas) return;
    this.applyLook(e.movementX, e.movementY);
  };

  private applyLook(dx: number, dy: number): void {
    // Вправо по экрану = -X в мире, поэтому yaw уменьшается.
    this.yaw -= dx * LOOK_SENSITIVITY;
    this.pitch = clamp(this.pitch + dy * LOOK_SENSITIVITY, PITCH_MIN, PITCH_MAX);
  }

  // --- Тач: левая половина экрана — джойстик, правая — обзор ---

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
        this.applyLook(touch.clientX - this.lookPrev.x, touch.clientY - this.lookPrev.y);
        this.lookPrev = { x: touch.clientX, y: touch.clientY };
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
      }
    }
  };
}
