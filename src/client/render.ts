import * as THREE from 'three';

import type { Box } from '../shared/types.js';

/** Цвета корпусов; сервер присылает индекс в этой палитре. */
const PALETTE = [0x4f7d5a, 0x7a5f9c, 0xa8632f, 0x3f6f96, 0x8a8f3a, 0x9c4a52, 0x3f8f88, 0x8a6a44];

const CAMERA_DISTANCE = 15;
const CAMERA_BASE_HEIGHT = 3.4;

/** Высота, на которой висит ник над центром танка. */
const LABEL_HEIGHT = 3.7;
/** Дальше этого ники не рисуем — всё равно нечитаемо, а DOM грузится. */
const LABEL_MAX_DISTANCE = 160;

export interface TankHandle {
  root: THREE.Group;
  turret: THREE.Group;
  label: HTMLElement;
  /** Размеры подписи в пикселях, замеряются один раз — текст не меняется. */
  labelHalfWidth: number;
  labelHeight: number;
  labelVisible: boolean;
}

export class Scene3D {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly tanks = new Map<number, TankHandle>();

  /** Переиспользуемые буферы — чтобы не мусорить в куче каждый кадр. */
  private readonly projected = new THREE.Vector3();
  private viewWidth = 1;
  private viewHeight = 1;

  /** Геометрии переиспользуются всеми танками — их много, а форма одна. */
  private readonly geo = {
    hull: new THREE.BoxGeometry(3, 1, 4.4),
    track: new THREE.BoxGeometry(0.78, 0.85, 4.9),
    turret: new THREE.BoxGeometry(2, 0.75, 2.3),
    barrel: new THREE.CylinderGeometry(0.14, 0.16, 3, 12),
    cupola: new THREE.CylinderGeometry(0.34, 0.34, 0.3, 12),
  };

  private readonly trackMaterial = new THREE.MeshStandardMaterial({
    color: 0x23262b,
    roughness: 0.95,
  });
  private readonly metalMaterial = new THREE.MeshStandardMaterial({
    color: 0x3a3f47,
    roughness: 0.6,
    metalness: 0.25,
  });

  private readonly cameraTarget = new THREE.Vector3();
  private cameraReady = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly labelContainer: HTMLElement,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;

    this.camera = new THREE.PerspectiveCamera(62, 1, 0.5, 600);
    this.camera.position.set(0, 20, -30);

    this.scene.background = new THREE.Color(0x121822);
    this.scene.fog = new THREE.Fog(0x121822, 90, 320);

    this.setupLights();
    this.resize();
    window.addEventListener('resize', this.resize);
  }

  private setupLights(): void {
    this.scene.add(new THREE.HemisphereLight(0x9fb8d8, 0x2b2f26, 1.1));

    const sun = new THREE.DirectionalLight(0xffe6bd, 2.1);
    sun.position.set(60, 95, 40);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -110;
    sun.shadow.camera.right = 110;
    sun.shadow.camera.top = 110;
    sun.shadow.camera.bottom = -110;
    sun.shadow.camera.near = 10;
    sun.shadow.camera.far = 260;
    sun.shadow.bias = -0.0006;
    this.scene.add(sun);
  }

  /** Строит землю, стены по периметру и препятствия, присланные сервером. */
  buildWorld(half: number, obstacles: Box[]): void {
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(half * 6, half * 6),
      new THREE.MeshStandardMaterial({ color: 0x39412f, roughness: 1 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);

    const grid = new THREE.GridHelper(half * 2, half / 2.5, 0x5c6b52, 0x475040);
    grid.position.y = 0.02;
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.35;
    this.scene.add(grid);

    const wallMaterial = new THREE.MeshStandardMaterial({ color: 0x4a5160, roughness: 0.9 });
    const wallHeight = 4;
    const thickness = 2;
    const span = half * 2 + thickness * 2;
    const walls: Array<[number, number, number, number]> = [
      [0, half + thickness / 2, span, thickness],
      [0, -half - thickness / 2, span, thickness],
      [half + thickness / 2, 0, thickness, span],
      [-half - thickness / 2, 0, thickness, span],
    ];
    for (const [x, z, w, d] of walls) {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(w, wallHeight, d), wallMaterial);
      wall.position.set(x, wallHeight / 2, z);
      wall.castShadow = true;
      wall.receiveShadow = true;
      this.scene.add(wall);
    }

    const boxMaterial = new THREE.MeshStandardMaterial({ color: 0x6d6357, roughness: 0.85 });
    for (const box of obstacles) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(box.w, box.h, box.d), boxMaterial);
      mesh.position.set(box.x, box.h / 2, box.z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.scene.add(mesh);
    }
  }

  addTank(id: number, name: string, colorIndex: number, isSelf: boolean): TankHandle {
    const existing = this.tanks.get(id);
    if (existing) return existing;

    const root = new THREE.Group();
    const bodyMaterial = new THREE.MeshStandardMaterial({
      color: PALETTE[colorIndex % PALETTE.length],
      roughness: 0.72,
      metalness: 0.15,
    });

    const hull = new THREE.Mesh(this.geo.hull, bodyMaterial);
    hull.position.y = 1.15;
    hull.castShadow = true;
    hull.receiveShadow = true;
    root.add(hull);

    for (const side of [-1, 1]) {
      const track = new THREE.Mesh(this.geo.track, this.trackMaterial);
      track.position.set(side * 1.45, 0.5, 0);
      track.castShadow = true;
      track.receiveShadow = true;
      root.add(track);
    }

    const turret = new THREE.Group();
    turret.position.y = 1.78;

    const turretBody = new THREE.Mesh(this.geo.turret, bodyMaterial);
    turretBody.position.y = 0.32;
    turretBody.castShadow = true;
    turret.add(turretBody);

    const cupola = new THREE.Mesh(this.geo.cupola, this.metalMaterial);
    cupola.position.set(0.55, 0.82, -0.3);
    cupola.castShadow = true;
    turret.add(cupola);

    const barrel = new THREE.Mesh(this.geo.barrel, this.metalMaterial);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.36, 2.3);
    barrel.castShadow = true;
    turret.add(barrel);

    root.add(turret);

    this.scene.add(root);

    const label = document.createElement('div');
    label.className = isSelf ? 'nameplate is-self' : 'nameplate';
    label.textContent = name;
    this.labelContainer.appendChild(label);

    const handle: TankHandle = {
      root,
      turret,
      label,
      // Читаем размеры один раз: offsetWidth каждый кадр заставлял бы браузер
      // пересчитывать раскладку на все подписи сразу.
      labelHalfWidth: Math.round(label.offsetWidth / 2),
      labelHeight: label.offsetHeight,
      labelVisible: true,
    };
    this.tanks.set(id, handle);
    return handle;
  }

  removeTank(id: number): void {
    const handle = this.tanks.get(id);
    if (!handle) return;
    handle.label.remove();
    this.scene.remove(handle.root);
    this.tanks.delete(id);
  }

  updateTank(id: number, x: number, z: number, angle: number, turret: number): void {
    const handle = this.tanks.get(id);
    if (!handle) return;
    handle.root.position.set(x, 0, z);
    handle.root.rotation.y = angle;
    // Башня хранится в мировых углах, а её узел — потомок корпуса.
    handle.turret.rotation.y = turret - angle;
  }

  /** Камера летит за танком: позиция задаётся углами обзора, а не поворотом корпуса. */
  updateCamera(x: number, z: number, yaw: number, pitch: number, dt: number): void {
    const distance = CAMERA_DISTANCE * Math.cos(pitch) + 2;
    const height = CAMERA_BASE_HEIGHT + Math.sin(pitch) * CAMERA_DISTANCE;

    const desiredX = x - Math.sin(yaw) * distance;
    const desiredZ = z - Math.cos(yaw) * distance;

    if (!this.cameraReady) {
      this.camera.position.set(desiredX, height, desiredZ);
      this.cameraReady = true;
    } else {
      // Экспоненциальное сглаживание — не зависит от частоты кадров.
      const k = 1 - Math.exp(-dt * 14);
      this.camera.position.x += (desiredX - this.camera.position.x) * k;
      this.camera.position.y += (height - this.camera.position.y) * k;
      this.camera.position.z += (desiredZ - this.camera.position.z) * k;
    }

    this.cameraTarget.set(x, 2.2, z);
    this.camera.lookAt(this.cameraTarget);
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
    this.updateLabels();
  }

  /**
   * Ники позиционируем сами, а не через CSS2DRenderer: тот ставит дробные
   * пиксели, из-за чего текст на ходу становится мыльным и дрожит.
   */
  private updateLabels(): void {
    this.camera.updateMatrixWorld();

    for (const handle of this.tanks.values()) {
      this.projected.set(
        handle.root.position.x,
        LABEL_HEIGHT,
        handle.root.position.z,
      );
      const distance = this.projected.distanceTo(this.camera.position);
      this.projected.project(this.camera);

      // z вне [-1, 1] значит «за камерой или за дальней плоскостью».
      const visible =
        distance < LABEL_MAX_DISTANCE && this.projected.z > -1 && this.projected.z < 1;

      if (visible !== handle.labelVisible) {
        handle.label.style.display = visible ? '' : 'none';
        handle.labelVisible = visible;
      }
      if (!visible) continue;

      const x = Math.round((this.projected.x * 0.5 + 0.5) * this.viewWidth) - handle.labelHalfWidth;
      const y =
        Math.round((-this.projected.y * 0.5 + 0.5) * this.viewHeight) - handle.labelHeight;
      handle.label.style.transform = `translate(${x}px, ${y}px)`;
    }
  }

  private resize = () => {
    const width = this.canvas.clientWidth || window.innerWidth;
    const height = this.canvas.clientHeight || window.innerHeight;
    this.viewWidth = width;
    this.viewHeight = height;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  };
}
