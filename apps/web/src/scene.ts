/**
 * The background: a field of gold motes across the whole screen, and the BNB mark drawn in particles.
 *
 * Left alone it is never still. The motes rise, sway and twinkle; the mark breathes, ripples like a surface,
 * catches a passing band of light, sends a ring out from its middle every few seconds, and is stirred by a slow
 * disturbance that wanders through it. A pointer sweeping across the screen parts the motes and the mark,
 * swirls them, and drags them along in its wake; they close in again behind it.
 *
 * It moves for every visitor. Windows reports "reduce motion" whenever its Animation effects switch is off,
 * which many people turn off for speed, and a background that froze for all of them was not what this page is
 * meant to be. That setting skips only the opening fly-in. The background is decoration: it moves no content.
 *
 * All particle motion runs in the vertex shaders, so a frame is two draw calls whatever the particle count.
 * Loaded after first paint, so the page is usable before three.js arrives.
 */
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Group,
  PerspectiveCamera,
  Points,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";

type Point = readonly [number, number];

// The five pieces of the mark, in a 126.61-unit square with y pointing down.
const PIECES: ReadonlyArray<ReadonlyArray<Point>> = [
  [[38.73, 53.2], [63.32, 28.62], [87.92, 53.22], [102.22, 38.91], [63.32, 0], [24.42, 38.9]], // top chevron
  [[38.73, 73.41], [63.32, 98], [87.92, 73.4], [102.23, 87.69], [63.33, 126.6], [24.42, 87.72]], // bottom chevron
  [[0, 63.31], [14.3, 49], [28.61, 63.31], [14.3, 77.61]], // left diamond
  [[98, 63.31], [112.3, 49], [126.61, 63.3], [112.3, 77.62]], // right diamond
  [[63.32, 48.78], [77.83, 63.3], [63.32, 77.8], [48.81, 63.31]], // centre diamond
];
const HALF = 63.305;
/** Half the thickness of the mark, in the units of its outline once that is scaled to -1..1. */
const DEPTH = 0.11;
const PARTICLES_WIDE = 9000;
const PARTICLES_NARROW = 5000;
/** Motes floating across the whole screen. */
const MOTES_WIDE = 1600;
const MOTES_NARROW = 700;
/** How far behind and in front of the mark's plane the motes float, in world units. */
const FIELD_BACK = 3;
const FIELD_FRONT = 1;
/** Width of one particle in world units. */
const PARTICLE_SIZE = 0.021;
/** How long the particles take to assemble into the mark, in seconds. */
const FORM_SECONDS = 2.4;
/** After this long without pointer movement the scene goes back to its own animation, in milliseconds. */
const IDLE_AFTER = 2500;

const MARK_VERTEX_SHADER = /* glsl */ `
uniform float uTime;
uniform float uForm;
uniform float uSize;
uniform float uEnergy;
uniform float uPointerStrength;
uniform vec2 uPointer;
uniform vec2 uSweep;

attribute vec2 aCentre;
attribute vec4 aSeed;
attribute vec3 aScatter;
attribute float aAmbient;

varying float vGlow;
varying float vTint;
varying float vAlpha;

void main() {
  vec3 home = position;

  // Breathing: each piece of the mark moves out from the middle and back; pointer movement opens it further.
  home.xy += aCentre * (sin(uTime * 0.6) * 0.05 + uEnergy * 0.16);

  // The surface ripples: a slow swell runs through the mark and carries its particles with it.
  float swell = sin(home.x * 2.6 + uTime * 0.9) * cos(home.y * 2.2 - uTime * 0.7);
  home.z += swell * 0.075;
  home.xy += vec2(cos(uTime * 0.6 + home.y * 3.0), sin(uTime * 0.5 + home.x * 3.0)) * 0.014;

  // A band of light crosses the mark diagonally and lifts the particles it passes.
  float crest = smoothstep(0.93, 1.0, sin((home.x + home.y) * 1.5 - uTime * 0.8));
  home.z += crest * 0.09;

  // Every few seconds a ring travels out from the middle of the mark and nudges what it passes.
  float radius = length(home.xy);
  float ringAt = fract(uTime / 7.0) * 2.4;
  float ring = exp(-(radius - ringAt) * (radius - ringAt) / 0.012) * (1.0 - ringAt / 2.4);
  home.xy += (home.xy / max(radius, 0.0001)) * ring * 0.07;

  // Every particle circles its own place; the loose ones around the mark wander further.
  float phase = aSeed.x * 6.2832;
  float reach = mix(0.016 + aSeed.y * 0.026, 0.12 + aSeed.y * 0.16, aAmbient);
  vec3 drift = vec3(
    sin(uTime * 0.9 + phase),
    cos(uTime * 0.7 + phase * 1.7),
    sin(uTime * 0.5 + phase * 2.3)
  ) * reach;

  // The pointer: particles move out of its way, swirl around it, and are dragged along in its wake.
  vec2 away = home.xy - uPointer;
  float dist = length(away);
  float push = uPointerStrength * exp(-dist * dist / (0.07 + uEnergy * 0.10));
  vec2 dir = away / max(dist, 0.0001);
  home.xy += dir * push * (0.24 + aSeed.z * 0.22) + vec2(-dir.y, dir.x) * push * 0.14 + uSweep * push * (0.25 + aSeed.w * 0.3);
  home.z += push * (aSeed.w - 0.5) * 0.9;

  // Arrival: each particle leaves a scattered cloud for its place, the ones nearest the middle first.
  float arrive = clamp(uForm * 1.7 - aSeed.x * 0.45 - length(position.xy) * 0.18, 0.0, 1.0);
  arrive = arrive * arrive * (3.0 - 2.0 * arrive);
  vec3 place = mix(aScatter, home + drift, arrive);

  vec4 viewPosition = modelViewMatrix * vec4(place, 1.0);
  gl_Position = projectionMatrix * viewPosition;
  float twinkle = 0.85 + 0.15 * sin(uTime * (1.2 + aSeed.z * 2.0) + phase);
  gl_PointSize = uSize * (0.55 + aSeed.y * 0.95) * twinkle * (1.0 + crest * 0.7 + ring * 0.6 + push * 1.3) / -viewPosition.z;

  vGlow = clamp(crest * 0.55 + ring * 0.5 + push * 0.8, 0.0, 1.0);
  vTint = aSeed.w;
  vAlpha = mix(1.0, 0.45, aAmbient) * (0.25 + 0.75 * arrive);
}
`;

const FIELD_VERTEX_SHADER = /* glsl */ `
uniform float uTime;
uniform float uForm;
uniform float uSize;
uniform float uEnergy;
uniform float uPointerStrength;
uniform vec2 uPointer;
uniform vec2 uSweep;
uniform vec2 uBounds;

attribute vec4 aSeed;

varying float vGlow;
varying float vTint;
varying float vAlpha;

void main() {
  // Each mote rises and sways along its own path, and comes round again at the edges of the field.
  vec3 place = vec3(position.xy * uBounds, position.z);
  float phase = aSeed.x * 6.2832;
  place.y += uTime * (0.05 + aSeed.y * 0.10);
  place.x += sin(uTime * (0.16 + aSeed.z * 0.26) + phase) * (0.14 + aSeed.w * 0.30) + uTime * 0.03 * (aSeed.z - 0.5);
  place.xy = mod(place.xy + uBounds, 2.0 * uBounds) - uBounds;
  place.z += sin(uTime * 0.3 + phase * 1.3) * 0.25;

  // The pointer parts the motes, swirls them, and drags them along in its wake.
  vec2 away = place.xy - uPointer;
  float dist = length(away);
  float push = uPointerStrength * exp(-dist * dist / (0.30 + uEnergy * 0.55));
  vec2 dir = away / max(dist, 0.0001);
  place.xy += dir * push * (0.30 + aSeed.z * 0.25) + vec2(-dir.y, dir.x) * push * 0.22 + uSweep * push * (0.35 + aSeed.w * 0.4);
  place.z += push * (aSeed.w - 0.5) * 0.8;

  vec4 viewPosition = modelViewMatrix * vec4(place, 1.0);
  gl_Position = projectionMatrix * viewPosition;
  float twinkle = 0.55 + 0.45 * sin(uTime * (0.7 + aSeed.x * 1.5) + aSeed.w * 6.2832);
  gl_PointSize = uSize * (0.5 + aSeed.y * 1.0) * (1.0 + push * 1.6) / -viewPosition.z;

  vGlow = clamp(push, 0.0, 1.0);
  vTint = aSeed.w;
  vAlpha = (0.18 + 0.36 * twinkle) * uForm * (1.0 + push);
}
`;

const FRAGMENT_SHADER = /* glsl */ `
varying float vGlow;
varying float vTint;
varying float vAlpha;

void main() {
  vec2 fromCentre = gl_PointCoord - 0.5;
  float falloff = 1.0 - smoothstep(0.0, 0.25, dot(fromCentre, fromCentre));
  if (falloff <= 0.0) discard;
  vec3 gold = vec3(0.941, 0.725, 0.043);
  vec3 pale = vec3(1.0, 0.86, 0.42);
  vec3 colour = mix(gold, pale, clamp(vGlow + vTint * 0.22, 0.0, 1.0));
  gl_FragColor = vec4(colour, falloff * vAlpha * (0.62 + vGlow * 0.3));
}
`;

/** A small seeded generator: the same particles in the same places on every visit. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Piece {
  outline: Point[];
  centre: Point;
  area: number;
  perimeter: number;
  box: { minX: number; minY: number; maxX: number; maxY: number };
}

/** The pieces with the mark centred on the origin, y pointing up, spanning -1..1. */
const MARK: ReadonlyArray<Piece> = PIECES.map((source) => {
  const outline = source.map(([x, y]): Point => [(x - HALF) / HALF, -(y - HALF) / HALF]);
  let area = 0;
  let perimeter = 0;
  let cx = 0;
  let cy = 0;
  const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  outline.forEach(([x, y], index) => {
    const [nx, ny] = outline[(index + 1) % outline.length]!;
    area += x * ny - nx * y;
    perimeter += Math.hypot(nx - x, ny - y);
    cx += x / outline.length;
    cy += y / outline.length;
    box.minX = Math.min(box.minX, x);
    box.minY = Math.min(box.minY, y);
    box.maxX = Math.max(box.maxX, x);
    box.maxY = Math.max(box.maxY, y);
  });
  return { outline, centre: [cx, cy], area: Math.abs(area) / 2, perimeter, box };
});

function inside(outline: ReadonlyArray<Point>, x: number, y: number): boolean {
  let hit = false;
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    const [xi, yi] = outline[i]!;
    const [xj, yj] = outline[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** Picks a piece with a chance in proportion to `weight`. */
function pick(random: () => number, weight: (piece: Piece) => number): Piece {
  const total = MARK.reduce((sum, piece) => sum + weight(piece), 0);
  let at = random() * total;
  for (const piece of MARK) {
    at -= weight(piece);
    if (at <= 0) return piece;
  }
  return MARK[MARK.length - 1]!;
}

function pointInPiece(random: () => number, piece: Piece): Point {
  const { minX, minY, maxX, maxY } = piece.box;
  for (;;) {
    const x = minX + random() * (maxX - minX);
    const y = minY + random() * (maxY - minY);
    if (inside(piece.outline, x, y)) return [x, y];
  }
}

function pointOnOutline(random: () => number, piece: Piece): Point {
  let at = random() * piece.perimeter;
  for (let index = 0; index < piece.outline.length; index++) {
    const [x, y] = piece.outline[index]!;
    const [nx, ny] = piece.outline[(index + 1) % piece.outline.length]!;
    const length = Math.hypot(nx - x, ny - y);
    if (at <= length) return [x + ((nx - x) * at) / length, y + ((ny - y) * at) / length];
    at -= length;
  }
  return piece.outline[0]!;
}

/**
 * The mark's particles: half fill its two faces, the rest trace its outline on both faces and down its
 * sides, so it reads as a solid when it turns. A few more float loose around it.
 */
function buildMark(count: number): BufferGeometry {
  const random = seeded(0xb1b);
  const loose = Math.round(count * 0.08);
  const total = count + loose;
  const position = new Float32Array(total * 3);
  const centre = new Float32Array(total * 2);
  const seed = new Float32Array(total * 4);
  const scatter = new Float32Array(total * 3);
  const ambient = new Float32Array(total);

  for (let index = 0; index < total; index++) {
    let x: number;
    let y: number;
    let z: number;
    if (index < count) {
      const kind = random();
      const face = random() < 0.5 ? -DEPTH : DEPTH;
      if (kind < 0.5) {
        const piece = pick(random, (candidate) => candidate.area);
        [x, y] = pointInPiece(random, piece);
        z = face;
        centre.set(piece.centre, index * 2);
      } else {
        const piece = pick(random, (candidate) => candidate.perimeter);
        [x, y] = pointOnOutline(random, piece);
        z = kind < 0.8 ? face : (random() * 2 - 1) * DEPTH;
        centre.set(piece.centre, index * 2);
      }
    } else {
      // Loose particles: a wide, shallow ring around the mark.
      const angle = random() * Math.PI * 2;
      const radius = 1.25 + random() * 1.9;
      x = Math.cos(angle) * radius;
      y = Math.sin(angle) * radius * 0.8;
      z = (random() * 2 - 1) * 1.1;
      ambient[index] = 1;
    }
    position.set([x, y, z], index * 3);
    seed.set([random(), random(), random(), random()], index * 4);

    // Where the particle starts before it flies in: a wide cloud around the mark.
    const angle = random() * Math.PI * 2;
    const radius = 2.2 + random() * 3.2;
    scatter.set([Math.cos(angle) * radius, Math.sin(angle) * radius, (random() * 2 - 1) * 3], index * 3);
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(position, 3));
  geometry.setAttribute("aCentre", new BufferAttribute(centre, 2));
  geometry.setAttribute("aSeed", new BufferAttribute(seed, 4));
  geometry.setAttribute("aScatter", new BufferAttribute(scatter, 3));
  geometry.setAttribute("aAmbient", new BufferAttribute(ambient, 1));
  return geometry;
}

/** The motes: spread evenly over a -1..1 square that the shader stretches to cover the screen, at mixed depths. */
function buildField(count: number): BufferGeometry {
  const random = seeded(0xf1e1d);
  const position = new Float32Array(count * 3);
  const seed = new Float32Array(count * 4);
  for (let index = 0; index < count; index++) {
    position.set([random() * 2 - 1, random() * 2 - 1, -FIELD_BACK + random() * (FIELD_BACK + FIELD_FRONT)], index * 3);
    seed.set([random(), random(), random(), random()], index * 4);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(position, 3));
  geometry.setAttribute("aSeed", new BufferAttribute(seed, 4));
  return geometry;
}

export interface SceneHandle {
  dispose(): void;
}

export function startScene(canvas: HTMLCanvasElement): SceneHandle {
  // With "reduce motion" set, the mark is already formed when it appears; everything else runs as usual.
  const formed = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const renderer = new WebGLRenderer({ canvas, antialias: false, alpha: true, powerPreference: "low-power" });
  const scene = new Scene();
  const camera = new PerspectiveCamera(35, 1, 0.1, 50);
  camera.position.set(0, 0, 7.2);

  // Time, particle size and pointer energy are the same for both layers, so both materials share them.
  const shared = {
    uTime: { value: 0 },
    uForm: { value: formed ? 1 : 0 },
    uSize: { value: 1 },
    uEnergy: { value: 0 },
  };
  const markUniforms = { ...shared, uPointerStrength: { value: 0 }, uPointer: { value: new Vector2() }, uSweep: { value: new Vector2() } };
  const fieldUniforms = {
    ...shared,
    uPointerStrength: { value: 0 },
    uPointer: { value: new Vector2() },
    uSweep: { value: new Vector2() },
    uBounds: { value: new Vector2(1, 1) },
  };
  const layer = { fragmentShader: FRAGMENT_SHADER, transparent: true, depthTest: false, depthWrite: false, blending: AdditiveBlending };
  const markMaterial = new ShaderMaterial({ ...layer, uniforms: markUniforms, vertexShader: MARK_VERTEX_SHADER });
  const fieldMaterial = new ShaderMaterial({ ...layer, uniforms: fieldUniforms, vertexShader: FIELD_VERTEX_SHADER });

  const mark = new Group();
  mark.scale.setScalar(1.45);
  scene.add(mark);
  let markPoints: Points | undefined;
  let fieldPoints: Points | undefined;
  let narrowBuilt: boolean | undefined;
  const build = (narrow: boolean) => {
    if (narrow === narrowBuilt) return;
    narrowBuilt = narrow;
    if (markPoints) {
      mark.remove(markPoints);
      markPoints.geometry.dispose();
    }
    if (fieldPoints) {
      scene.remove(fieldPoints);
      fieldPoints.geometry.dispose();
    }
    fieldPoints = new Points(buildField(narrow ? MOTES_NARROW : MOTES_WIDE), fieldMaterial);
    markPoints = new Points(buildMark(narrow ? PARTICLES_NARROW : PARTICLES_WIDE), markMaterial);
    // The shaders move every particle, so the geometry's own bounds say nothing about what is on screen.
    fieldPoints.frustumCulled = false;
    markPoints.frustumCulled = false;
    scene.add(fieldPoints);
    mark.add(markPoints);
  };

  // Pointer position in [-1, 1] across the viewport, and the smoothed values the scene actually follows.
  const pointer = { x: 0, y: 0 };
  const eased = { x: 0, y: 0, energy: 0 };
  let lastMove = -Infinity;
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
    const narrow = width < 1024;
    build(narrow);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, narrow ? 1.5 : 2));
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    // On a wide screen the mark sits to the right of the text; on a narrow one it sits behind it, centred.
    camera.position.z = narrow ? 9.5 : 7.2;
    mark.position.x = narrow ? 0 : Math.min(2.4, (width / height) * 1.15);
    mark.position.y = narrow ? 1.1 : 0.15;
    camera.updateProjectionMatrix();
    const slope = Math.tan((camera.fov * Math.PI) / 360);
    // Particle size in drawing-buffer pixels at distance 1; the shaders divide by each particle's distance.
    shared.uSize.value = (PARTICLE_SIZE * renderer.domElement.height) / (2 * slope);
    // The field is as wide as the view is at its farthest mote, so motes that wrap do so off-screen.
    const reach = slope * (camera.position.z + FIELD_BACK) * 1.06;
    fieldUniforms.uBounds.value.set(reach * camera.aspect, reach);
  };

  const world = new Vector3();
  const local = new Vector3();
  let frame = 0;
  let running = false;
  let startedAt = 0;
  let previous = 0;
  /** Eases `value` toward `target` and writes how far behind it still is into `sweep`: the pointer's wake. */
  const follow = (value: Vector2, sweep: Vector2, targetX: number, targetY: number, rate: number, wake: number) => {
    value.x += (targetX - value.x) * rate;
    value.y += (targetY - value.y) * rate;
    sweep.set(targetX - value.x, targetY - value.y).multiplyScalar(wake).clampLength(0, 1.2);
  };
  const render = (now: number) => {
    frame = requestAnimationFrame(render);
    if (startedAt === 0) startedAt = previous = now;
    const t = (now - startedAt) / 1000;
    const dt = Math.min(0.05, (now - previous) / 1000);
    previous = now;

    // When the pointer has been still for a while, the scene goes back to its own motion.
    const idle = now - lastMove > IDLE_AFTER;
    const lean = 1 - Math.exp(-dt * 2.8);
    eased.x += ((idle ? 0 : pointer.x) - eased.x) * lean;
    eased.y += ((idle ? 0 : pointer.y) - eased.y) * lean;
    eased.energy *= Math.exp(-dt * 3.2);

    mark.rotation.y = Math.sin(t * 0.32) * 0.42 + eased.x * 0.5;
    mark.rotation.x = Math.sin(t * 0.21) * 0.12 + eased.y * 0.34;
    mark.rotation.z = Math.sin(t * 0.17) * 0.04;
    mark.updateMatrixWorld();

    // Where the pointer is on the plane the mark lies in: in world coordinates for the motes, and in the
    // mark's own coordinates for the mark.
    const halfHeight = Math.tan((camera.fov * Math.PI) / 360) * camera.position.z;
    world.set(pointer.x * halfHeight * camera.aspect, -pointer.y * halfHeight, 0);
    if (idle) {
      // Nobody is steering: a soft disturbance wanders through the mark on its own.
      local.set(Math.sin(t * 0.37) * 0.8, Math.sin(t * 0.53 + 1.3) * 0.8, 0);
    } else {
      mark.worldToLocal(local.copy(world));
    }
    const rate = 1 - Math.exp(-dt * (idle ? 1.6 : 7));
    const settle = 1 - Math.exp(-dt * 2.5);
    follow(markUniforms.uPointer.value, markUniforms.uSweep.value, local.x, local.y, rate, idle ? 0 : 1.4);
    follow(fieldUniforms.uPointer.value, fieldUniforms.uSweep.value, world.x, world.y, 1 - Math.exp(-dt * 7), idle ? 0 : 1);
    markUniforms.uPointerStrength.value += ((idle ? 0.45 : 1) - markUniforms.uPointerStrength.value) * settle;
    fieldUniforms.uPointerStrength.value += ((idle ? 0 : 1) - fieldUniforms.uPointerStrength.value) * settle;
    shared.uEnergy.value = eased.energy;
    shared.uTime.value = t;
    shared.uForm.value = formed ? 1 : Math.min(1, t / FORM_SECONDS);
    renderer.render(scene, camera);
  };

  const start = () => {
    if (running || document.hidden) return;
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
  window.addEventListener("pointermove", onPointerMove, { passive: true });
  start();

  return {
    dispose() {
      stop();
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("visibilitychange", onVisibility);
      markPoints?.geometry.dispose();
      fieldPoints?.geometry.dispose();
      markMaterial.dispose();
      fieldMaterial.dispose();
      renderer.dispose();
    },
  };
}
