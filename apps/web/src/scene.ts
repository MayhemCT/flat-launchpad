/**
 * The background: the BNB mark as five extruded gold pieces. It drifts on its own when idle and leans toward
 * the pointer. Loaded after first paint, so the page is usable before three.js arrives.
 */
import {
  AmbientLight,
  DirectionalLight,
  ExtrudeGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  PointLight,
  Scene,
  Shape,
  WebGLRenderer,
} from "three";

// The five pieces of the mark, in a 126.61-unit square with y pointing down.
const PIECES: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
  [[38.73, 53.2], [63.32, 28.62], [87.92, 53.22], [102.22, 38.91], [63.32, 0], [24.42, 38.9]], // top chevron
  [[38.73, 73.41], [63.32, 98], [87.92, 73.4], [102.23, 87.69], [63.33, 126.6], [24.42, 87.72]], // bottom chevron
  [[0, 63.31], [14.3, 49], [28.61, 63.31], [14.3, 77.61]], // left diamond
  [[98, 63.31], [112.3, 49], [126.61, 63.3], [112.3, 77.62]], // right diamond
  [[63.32, 48.78], [77.83, 63.3], [63.32, 77.8], [48.81, 63.31]], // centre diamond
];
const HALF = 63.305;

export interface SceneHandle {
  dispose(): void;
}

export function startScene(canvas: HTMLCanvasElement): SceneHandle {
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "low-power" });
  const scene = new Scene();
  const camera = new PerspectiveCamera(35, 1, 0.1, 50);
  camera.position.set(0, 0, 7.2);

  scene.add(new AmbientLight(0xffffff, 0.55));
  const key = new DirectionalLight(0xfff1c2, 2.4);
  key.position.set(3, 4, 6);
  scene.add(key);
  const rim = new PointLight(0xf0b90b, 18, 20);
  rim.position.set(-4, -2, 3);
  scene.add(rim);

  const material = new MeshStandardMaterial({ color: 0xf0b90b, metalness: 0.82, roughness: 0.32 });
  const mark = new Group();
  const pieces: Array<{ mesh: Mesh; x: number; y: number }> = [];
  for (const outline of PIECES) {
    const shape = new Shape();
    let cx = 0;
    let cy = 0;
    for (const [x, y] of outline) {
      cx += x / outline.length;
      cy += y / outline.length;
    }
    // Each piece is drawn around its own centre, so it can move outward from the middle of the mark.
    outline.forEach(([x, y], index) => {
      const px = (x - cx) / HALF;
      const py = -(y - cy) / HALF;
      if (index === 0) shape.moveTo(px, py);
      else shape.lineTo(px, py);
    });
    shape.closePath();
    const geometry = new ExtrudeGeometry(shape, {
      depth: 0.22,
      bevelEnabled: true,
      bevelThickness: 0.035,
      bevelSize: 0.03,
      bevelSegments: 2,
    });
    geometry.translate(0, 0, -0.11);
    const mesh = new Mesh(geometry, material);
    const x = (cx - HALF) / HALF;
    const y = -(cy - HALF) / HALF;
    mesh.position.set(x, y, 0);
    mark.add(mesh);
    pieces.push({ mesh, x, y });
  }
  mark.scale.setScalar(1.45);
  scene.add(mark);

  // Pointer position in [-1, 1], and the smoothed value the mark actually follows.
  const pointer = { x: 0, y: 0 };
  const eased = { x: 0, y: 0, energy: 0 };
  let lastMove = 0;
  const onPointerMove = (event: PointerEvent) => {
    const nx = (event.clientX / window.innerWidth) * 2 - 1;
    const ny = (event.clientY / window.innerHeight) * 2 - 1;
    eased.energy = Math.min(1, eased.energy + Math.hypot(nx - pointer.x, ny - pointer.y) * 1.6);
    pointer.x = nx;
    pointer.y = ny;
    lastMove = performance.now();
  };

  let width = 0;
  let height = 0;
  const resize = () => {
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    if (width === 0 || height === 0) return;
    const narrow = width < 768;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, narrow ? 1.5 : 2));
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    // On a wide screen the mark sits to the right of the text; on a narrow one it sits behind it, centred.
    camera.position.z = narrow ? 9.5 : 7.2;
    mark.position.x = narrow ? 0 : Math.min(2.4, (width / height) * 1.15);
    mark.position.y = narrow ? 1.1 : 0.15;
    camera.updateProjectionMatrix();
    if (reducedMotion) renderer.render(scene, camera);
  };

  let frame = 0;
  let running = false;
  const render = (now: number) => {
    frame = requestAnimationFrame(render);
    const t = now / 1000;
    // When the pointer has been still for a while, ease back to the idle drift.
    const idle = now - lastMove > 2500;
    const targetX = idle ? 0 : pointer.x;
    const targetY = idle ? 0 : pointer.y;
    eased.x += (targetX - eased.x) * 0.045;
    eased.y += (targetY - eased.y) * 0.045;
    eased.energy *= 0.94;

    mark.rotation.y = Math.sin(t * 0.32) * 0.42 + eased.x * 0.55;
    mark.rotation.x = Math.sin(t * 0.21) * 0.12 + eased.y * 0.38;
    mark.rotation.z = Math.sin(t * 0.17) * 0.04;
    const spread = 1 + Math.sin(t * 0.6) * 0.035 + eased.energy * 0.22;
    pieces.forEach(({ mesh, x, y }, index) => {
      mesh.position.x = x * spread;
      mesh.position.y = y * spread;
      mesh.position.z = Math.sin(t * 0.8 + index * 1.3) * 0.05 + eased.energy * (index === 4 ? 0.3 : 0.08);
    });
    renderer.render(scene, camera);
  };

  const start = () => {
    if (running || reducedMotion || document.hidden) return;
    running = true;
    frame = requestAnimationFrame(render);
  };
  const stop = () => {
    running = false;
    cancelAnimationFrame(frame);
  };
  const onVisibility = () => (document.hidden ? stop() : start());

  resize();
  window.addEventListener("resize", resize);
  document.addEventListener("visibilitychange", onVisibility);
  if (!reducedMotion) window.addEventListener("pointermove", onPointerMove, { passive: true });
  start();

  return {
    dispose() {
      stop();
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("visibilitychange", onVisibility);
      for (const { mesh } of pieces) mesh.geometry.dispose();
      material.dispose();
      renderer.dispose();
    },
  };
}
