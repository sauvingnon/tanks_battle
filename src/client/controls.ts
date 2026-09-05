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
  /** Огонь удерживается: перезарядку считает сервер, поэтому зажатая кнопка стреляет очередями. */
  fire = false;

  readonly isTouch = matchMedia('(hover: none) and (pointer: coarse)').matches;

  private readonly keys = new Set<string>();

  private stickTouchId: number | null = null;
  private stickOrigin = { x: 0, y: 0 };

  private lookTouchId: number | null = null;
  private lookPrev = { x: 0, y: 0 };

  private fireTouchId: number | null = null;
  private mouseFire = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly stick: HTMLElement,
    private readonly knob: HTMLElement,
    private readonly fireButton: HTMLElement,
  ) {}

  attach(): void {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);

    this.canvas.addEventListener('click', this.onCanvasClick);
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
    this.fire = this.mouseFire || this.fireTouchId !== null || this.keys.has('Space');
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
    this.fire = false;
  };

  private onCanvasClick = () => {
    if (this.isTouch) return;
    if (document.pointerLockElement !== this.canvas) {
      void this.canvas.requestPointerLock();
    }
  };

  private onMouseDown = (e: MouseEvent) => {
    // Пока курсор не захвачен, клик — это просьба захватить его, а не выстрел.
    if (document.pointerLockElement !== this.canvas) return;
    if (e.button === 0) this.mouseFire = true;
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
