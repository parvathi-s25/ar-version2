import * as THREE from 'three';

export function createRenderer(container) {
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    powerPreference: 'high-performance'
  });

  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type    = THREE.PCFSoftShadowMap;

  // Transparent background so camera fallback video shows through.
  renderer.setClearColor(0x000000, 0);

  container.appendChild(renderer.domElement);
  return renderer;
}

export function createScene() {
  const scene = new THREE.Scene();

  const ambient = new THREE.HemisphereLight(0xffffff, 0x334155, 2.2);
  scene.add(ambient);

  const directional = new THREE.DirectionalLight(0xffffff, 2.4);
  directional.position.set(1.5, 3, 2);
  directional.castShadow = true;
  directional.shadow.mapSize.set(1024, 1024);
  directional.shadow.camera.near = 0.01;
  directional.shadow.camera.far  = 8;
  scene.add(directional);

  return scene;
}

export function createCamera() {
  const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 30);
  camera.position.set(0, 0.85, 1.15);
  camera.lookAt(0, 0, 0);
  return camera;
}

export function createReticle() {
  const group = new THREE.Group();
  group.matrixAutoUpdate = false;
  group.visible = false;
  group.name = 'Reticle';

  // Outer ring.
  const outerGeo = new THREE.RingGeometry(0.078, 0.096, 36).rotateX(-Math.PI / 2);
  const outerMat = new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.95, side: THREE.DoubleSide });
  const outer = new THREE.Mesh(outerGeo, outerMat);
  group.add(outer);

  // Inner dot for precision.
  const innerGeo = new THREE.CircleGeometry(0.012, 20).rotateX(-Math.PI / 2);
  const innerMat = new THREE.MeshBasicMaterial({ color: 0x7dd3fc, transparent: true, opacity: 0.8, side: THREE.DoubleSide });
  const inner = new THREE.Mesh(innerGeo, innerMat);
  inner.position.y = 0.001;
  group.add(inner);

  // Store refs to materials so ReticleColorState can update them.
  group.userData.outerMat = outerMat;
  group.userData.innerMat = innerMat;

  return group;
}

/**
 * Update the reticle colour based on tracking state.
 * States: 'scanning' (grey), 'ready' (blue), 'locked' (hidden), 'unstable' (amber)
 */
export function setReticleState(reticle, state) {
  if (!reticle) return;
  const outer = reticle.userData.outerMat;
  const inner = reticle.userData.innerMat;
  if (!outer || !inner) return;

  switch (state) {
    case 'scanning':
      outer.color.set(0x94a3b8); inner.color.set(0xcbd5e1); break;
    case 'ready':
      outer.color.set(0x38bdf8); inner.color.set(0x7dd3fc); break;
    case 'unstable':
      outer.color.set(0xfbbf24); inner.color.set(0xfde68a); break;
    case 'locked':
    default:
      break;
  }
}

export function createDesktopGrid() {
  const group = new THREE.Group();
  group.name = 'DesktopGrid';

  const grid = new THREE.GridHelper(1.8, 18, 0x64748b, 0x334155);
  grid.position.y = -0.002;
  group.add(grid);

  // Subtle "table surface" shadow catcher.
  const planeGeo = new THREE.PlaneGeometry(1.8, 1.8).rotateX(-Math.PI / 2);
  const planeMat = new THREE.MeshStandardMaterial({ color: 0x0f172a, transparent: true, opacity: 0.3, side: THREE.DoubleSide });
  const plane = new THREE.Mesh(planeGeo, planeMat);
  plane.receiveShadow = true;
  plane.position.y = -0.003;
  group.add(plane);

  return group;
}
