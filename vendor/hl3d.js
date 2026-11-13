// Hometown leagues: broadcast 3D match renderer (three.js). Realistic rigged athletes with
// motion-captured animation, team kits, arena, shadows, bloom and goal replays.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as skClone } from 'three/addons/utils/SkeletonUtils.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const T = THREE;
const V = (x, y, z) => new T.Vector3(x, z, -y);          // rink feet (x along, y across, z up) -> three
const hashS = s => { let h = 2166136261; s = String(s); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
const MODELS = ['remy', 'ben', 'brian'];
let ASSETS = null, LOADING = null;

export function loadAssets(base) {
  if (ASSETS) return Promise.resolve(ASSETS);
  if (LOADING) return LOADING;
  const ld = new GLTFLoader();
  LOADING = Promise.all(MODELS.map(n => ld.loadAsync(base + n + '.glb'))).then(gs => {
    ASSETS = gs.map((g, i) => {
      g.scene.updateMatrixWorld(true);
      const hipsY = g.scene.getObjectByName('mixamorigHips').getWorldPosition(new T.Vector3()).y;
      const clips = {}; g.animations.forEach(a => clips[a.name] = a);
      g.scene.traverse(c => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = false; c.frustumCulled = false; } });
      return { name: MODELS[i], scene: g.scene, clips, hipsY };
    });
    return ASSETS;
  });
  return LOADING;
}

function kitMaterial(src, k) {
  const m = src.clone(); const mask = src.emissiveMap; m.emissiveMap = null; m.emissive = new T.Color(0);
  const U = { kMask: { value: mask }, kShirt: { value: new T.Color(k.shirt) }, kShorts: { value: new T.Color(k.shorts) }, kSocks: { value: new T.Color(k.socks) }, kGlove: { value: new T.Color(k.glove) } };
  m.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, U);
    sh.fragmentShader = 'uniform sampler2D kMask; uniform vec3 kShirt, kShorts, kSocks, kGlove;\n' + sh.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
      vec3 km = texture2D(kMask, vMapUv).rgb; vec3 kc = vec3(1.0); float kw = 0.0;
      if (km.r > 0.5 && km.g > 0.5) { kc = kGlove; kw = 1.0; } else if (km.r > 0.5) { kc = kShirt; kw = 1.0; } else if (km.g > 0.5) { kc = kShorts; kw = 1.0; } else if (km.b > 0.5) { kc = kSocks; kw = 1.0; }
      diffuseColor.rgb = mix(diffuseColor.rgb, min(diffuseColor.rgb * kc * 3.4, vec3(0.92)), kw);`);
  };
  m.customProgramCacheKey = () => 'hlkit';
  return m;
}

function canvasTex(cv, srgb = true) { const t = new T.CanvasTexture(cv); if (srgb) t.colorSpace = T.SRGBColorSpace; t.anisotropy = 8; return t; }

// strip of quads around the rounded rink outline, from height z0 to z1 (u runs along the perimeter)
function stripGeo(pts, z0, z1, uScale, skip) {
  const P = [], N = [], UV = [], I = []; let acc = 0; const n = pts.length;
  for (let i = 0; i <= n; i++) {
    const a = pts[i % n], b = pts[(i + 1) % n], pv = pts[(i - 1 + n) % n];
    const tx = b[0] - pv[0], ty = b[1] - pv[1]; const l = Math.hypot(tx, ty) || 1; const nx = -ty / l, ny = tx / l;
    const p0 = V(a[0], a[1], z0), p1 = V(a[0], a[1], z1); P.push(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z);
    const nn = V(nx, ny, 0); N.push(nn.x, nn.y, nn.z, nn.x, nn.y, nn.z);
    UV.push(-acc / uScale, 0, -acc / uScale, 1); acc += Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (i < n && !(skip && skip(a, b))) { const k = i * 2; I.push(k, k + 2, k + 1, k + 1, k + 2, k + 3); }
  }
  const g = new T.BufferGeometry(); g.setAttribute('position', new T.Float32BufferAttribute(P, 3)); g.setAttribute('normal', new T.Float32BufferAttribute(N, 3)); g.setAttribute('uv', new T.Float32BufferAttribute(UV, 2)); g.setIndex(I); return g;
}

export function createView(o) {
  const lax = o.sport === 'lax';
  const W = o.W || 1000, H = o.H || 470;
  const lowEnd = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) || (navigator.hardwareConcurrency || 8) < 4;
  const renderer = new T.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', preserveDrawingBuffer: true });
  const dpr = Math.min(o.dpr || 1, lowEnd ? 1.25 : 2);
  renderer.setPixelRatio(dpr); renderer.setSize(W, H, false);
  renderer.outputColorSpace = T.SRGBColorSpace; renderer.toneMapping = T.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = T.PCFSoftShadowMap;
  const scene = new T.Scene(); scene.background = new T.Color('#06080c'); scene.fog = new T.Fog('#06080c', 180, 420);
  const pmrem = new T.PMREMGenerator(renderer); scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture; scene.environmentIntensity = 0.35;
  const camera = new T.PerspectiveCamera(23, W / H, 1, 900);
  const rt = new T.WebGLRenderTarget(W * dpr, H * dpr, { type: T.HalfFloatType, samples: lowEnd ? 0 : 4 });
  const composer = new EffectComposer(renderer, rt); composer.setPixelRatio(dpr); composer.setSize(W, H);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new T.Vector2(W, H), 0.3, 0.5, 0.97); composer.addPass(bloom);
  composer.addPass(new OutputPass());

  // ---- lights
  scene.add(new T.HemisphereLight('#e8eefc', '#20242c', 0.35));
  const key = new T.DirectionalLight('#fff4e2', 2.6); key.position.copy(V(118, -55, 120)); key.target.position.copy(V(100, 42.5, 0)); scene.add(key, key.target);
  key.castShadow = true; key.shadow.mapSize.set(lowEnd ? 1024 : 2048, lowEnd ? 1024 : 2048); const sc = key.shadow.camera; sc.left = -125; sc.right = 125; sc.top = 75; sc.bottom = -75; sc.near = 20; sc.far = 420; key.shadow.bias = -0.0004; key.shadow.normalBias = 0.6; key.shadow.radius = 3;
  const fill = new T.DirectionalLight('#cfe0ff', 0.9); fill.position.copy(V(60, 140, 90)); scene.add(fill);
  const rim = new T.DirectionalLight('#ffffff', 0.7); rim.position.copy(V(-80, 40, 70)); scene.add(rim);

  // ---- floor
  const cvs = o.cvs;
  const floorTex = canvasTex(cvs.floor); floorTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const floor = new T.Mesh(new T.PlaneGeometry(200, 85), new T.MeshStandardMaterial({ map: floorTex, roughness: lax ? 0.55 : 0.9, metalness: 0, envMapIntensity: 0.5 }));
  floor.rotation.x = -Math.PI / 2; floor.position.copy(V(100, 42.5, 0)); floor.receiveShadow = true; scene.add(floor);
  const apron = new T.Mesh(new T.PlaneGeometry(700, 500), new T.MeshStandardMaterial({ color: '#15181e', roughness: 0.95 })); apron.rotation.x = -Math.PI / 2; apron.position.copy(V(100, 42.5, -0.05)); apron.receiveShadow = true; scene.add(apron);

  // ---- boards, rail, glass, posts
  const rp = o.rpts;
  const adTex = canvasTex(cvs.adTex); adTex.wrapS = T.RepeatWrapping;
  const boards = new T.Mesh(stripGeo(rp, 0, 3.7, 132), new T.MeshStandardMaterial({ map: adTex, roughness: 0.4, metalness: 0, emissive: '#ffffff', emissiveMap: adTex, emissiveIntensity: 0.18, side: T.DoubleSide })); boards.receiveShadow = true; scene.add(boards);
  const rail = new T.Mesh(stripGeo(rp, 3.7, 4.0, 999), new T.MeshStandardMaterial({ color: '#eef1f5', roughness: 0.35, side: T.DoubleSide })); scene.add(rail);
  const nearSide = (a, b) => a[1] < 30 && b[1] < 30;
  const glass = new T.Mesh(stripGeo(rp, 4.0, 12, 999, nearSide), new T.MeshStandardMaterial({ color: '#9fb8d0', roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.06, depthWrite: false, side: T.DoubleSide, envMapIntensity: 1.6 })); scene.add(glass);
  { const g = new T.BoxGeometry(0.12, 8, 0.12); const m = new T.MeshStandardMaterial({ color: '#c9d0d8', roughness: 0.4, metalness: 0.6 }); const per = []; let acc = 0; for (let i = 0; i < rp.length; i++) { const a = rp[i], b = rp[(i + 1) % rp.length]; const L = Math.hypot(b[0] - a[0], b[1] - a[1]); for (let s = (Math.ceil(acc / 9) * 9) - acc; s < L; s += 9) if (a[1] > 30 || b[1] > 30) per.push([a[0] + (b[0] - a[0]) * s / L, a[1] + (b[1] - a[1]) * s / L]); acc += L; } const im = new T.InstancedMesh(g, m, per.length); const M = new T.Matrix4(); per.forEach((p, i) => { M.setPosition(V(p[0], p[1], 8)); im.setMatrixAt(i, M); }); scene.add(im); }

  // ---- stands with an instanced crowd
  const standMat = new T.MeshStandardMaterial({ color: '#12151b', roughness: 0.9 });
  const fans = []; const rows = 18;
  const addStand = (x0, x1, y0, dir, axis) => { // axis 'x' = rows run along x (far/near side), 'y' = along y (ends)
    for (let r = 0; r < rows; r++) {
      const off = 6 + r * 3.1, z = 3 + r * 2.4;
      const len = axis === 'x' ? x1 - x0 : 120; const step = new T.Mesh(new T.BoxGeometry(axis === 'x' ? len : 3.1, 2.4, axis === 'x' ? 3.1 : len), standMat);
      const c = axis === 'x' ? V((x0 + x1) / 2, y0 + dir * off, z - 1.2) : V(y0 + dir * off, 42.5, z - 1.2); step.position.copy(c); step.receiveShadow = false; scene.add(step);
      const n = Math.floor(len / 2.25);
      for (let i = 0; i < n; i++) { const h = hashS('f' + axis + dir + r + ':' + i); if (h % 9 === 0) continue; const t = i * 2.25 + (h % 7) * 0.08 + (r % 2) * 1.1; const x = axis === 'x' ? x0 + t : y0 + dir * off; const y = axis === 'x' ? y0 + dir * off : -17.5 + t; fans.push({ x, y, z, h, ph: (h % 1000) / 159 }); }
    }
  };
  addStand(-40, 240, 85, 1, 'x'); addStand(0, 0, 0, -1, 'y'); addStand(0, 0, 200, 1, 'y');
  const fanBody = new T.InstancedMesh(new T.CapsuleGeometry(0.62, 1.3, 3, 8), new T.MeshStandardMaterial({ roughness: 0.85 }), fans.length);
  const fanHead = new T.InstancedMesh(new T.SphereGeometry(0.42, 10, 8), new T.MeshStandardMaterial({ roughness: 0.7, color: '#9a9a9a' }), fans.length);
  const skinC = ['#e0bfa0', '#c99a78', '#8d5f42', '#f0d2b8', '#5e3d2a', '#b07f5a'].map(c => new T.Color(c)); const crowdC = (cvs.crowdCols || ['#888']).map(c => new T.Color(c).multiplyScalar(0.55));
  fans.forEach((f, i) => { fanBody.setColorAt(i, crowdC[f.h % crowdC.length]); fanHead.setColorAt(i, skinC[(f.h >>> 4) % skinC.length]); });
  scene.add(fanBody, fanHead);
  const M4 = new T.Matrix4(), Q = new T.Quaternion(), S1 = new T.Vector3(1, 1, 1);
  const updateFans = (t, excite) => { for (let i = 0; i < fans.length; i++) { const f = fans[i]; const b = Math.max(0, Math.sin(t * 7 + f.ph)) * excite * 1.3; M4.compose(V(f.x, f.y, f.z + 1.2 + b), Q, S1); fanBody.setMatrixAt(i, M4); M4.compose(V(f.x, f.y, f.z + 2.65 + b), Q, S1); fanHead.setMatrixAt(i, M4); } fanBody.instanceMatrix.needsUpdate = true; fanHead.instanceMatrix.needsUpdate = true; };
  updateFans(0, 0);
  // LED ribbon on the far stands + light rigs
  const ribTex = canvasTex(cvs.rib); ribTex.wrapS = T.RepeatWrapping; ribTex.repeat.set(3, 1);
  const rib = new T.Mesh(new T.PlaneGeometry(300, 2.6), new T.MeshBasicMaterial({ map: ribTex, toneMapped: false, color: '#c8c8c8' })); rib.position.copy(V(100, 85 + 6 + 9 * 3.1, 3 + 9 * 2.4 + 1.6)); rib.rotation.x = -0.3; scene.add(rib);
  for (let i = 0; i < 7; i++) { const lb = new T.Mesh(new T.BoxGeometry(14, 1, 3), new T.MeshBasicMaterial({ color: '#fff6e0', toneMapped: false })); lb.position.copy(V(10 + i * 30, 42.5 + (i % 2 ? 22 : -22), 78)); scene.add(lb); }
  // benches with sponsor backdrops
  (cvs.bench || []).forEach((bc, sd) => { const x0 = sd === 0 ? 66 : 108; const bt = canvasTex(bc); const bd = new T.Mesh(new T.PlaneGeometry(26, 3.2), new T.MeshStandardMaterial({ map: bt, emissive: '#ffffff', emissiveMap: bt, emissiveIntensity: 0.25, roughness: 0.5 })); bd.position.copy(V(x0 + 13, 90, 5.2)); scene.add(bd); const bench = new T.Mesh(new T.BoxGeometry(28, 1.8, 2.2), new T.MeshStandardMaterial({ color: '#2a2f38', roughness: 0.7 })); bench.position.copy(V(x0 + 13, 88.6, 0.9)); scene.add(bench); });

  // ---- goals
  const gw = lax ? [40.2, 44.8] : [36.5, 48.5], gh = lax ? 4.1 : 6.5, gd = lax ? 3.3 : 3.2;
  const postMat = new T.MeshStandardMaterial({ color: lax ? '#ff5a1a' : '#f4f6f8', roughness: 0.3, metalness: 0.2 });
  const netTex = canvasTex(cvs.net, false); netTex.wrapS = netTex.wrapT = T.RepeatWrapping; netTex.repeat.set(lax ? 3 : 7, lax ? 3 : 4);
  const netMat = new T.MeshStandardMaterial({ map: netTex, alphaMap: netTex, transparent: true, alphaTest: 0.25, side: T.DoubleSide, roughness: 0.8, color: '#ffffff', depthWrite: false });
  const nets = [];
  for (const gx of o.goalX) {
    const d = gx < 100 ? -1 : 1; const grp = new T.Group(); const r = lax ? 0.17 : 0.2;
    const tube = (a, b, rr) => { const pa = V(...a), pb = V(...b); const len = pa.distanceTo(pb); const m = new T.Mesh(new T.CylinderGeometry(rr, rr, len, 12), postMat); m.position.copy(pa).add(pb).multiplyScalar(0.5); m.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), pb.clone().sub(pa).normalize()); m.castShadow = true; grp.add(m); };
    const back = gx + d * gd;
    tube([gx, gw[0], 0], [gx, gw[0], gh], r); tube([gx, gw[1], 0], [gx, gw[1], gh], r); tube([gx, gw[0], gh], [gx, gw[1], gh], r);
    tube([gx, gw[0], 0.1], [back, gw[0], 0.1], r * 0.7); tube([gx, gw[1], 0.1], [back, gw[1], 0.1], r * 0.7); tube([back, gw[0], 0.1], [back, gw[1], 0.1], r * 0.7);
    // net: back slope + sides + roof, built as one bendable mesh
    const ng = new T.PlaneGeometry(1, 1, 10, 8); const pos = ng.attributes.position; const base = [];
    for (let i = 0; i < pos.count; i++) { const u = pos.getX(i) + 0.5, v = pos.getY(i) + 0.5; const yy = gw[0] + (gw[1] - gw[0]) * u; const xx = gx + d * gd * (1 - v * 0.75); const zz = gh * v; const p = V(xx, yy, zz); pos.setXYZ(i, p.x, p.y, p.z); base.push(p.clone()); }
    const net = new T.Mesh(ng, netMat); grp.add(net);
    for (const yy of gw) { const sg = new T.PlaneGeometry(gd, gh); const sm = new T.Mesh(sg, netMat); sm.position.copy(V(gx + d * gd / 2, yy, gh / 2)); sm.rotation.y = 0; scene.add(sm); }
    const roof = new T.Mesh(new T.PlaneGeometry(gd * 0.3, gw[1] - gw[0]), netMat); roof.rotation.x = -Math.PI / 2; roof.position.copy(V(gx + d * gd * 0.15, (gw[0] + gw[1]) / 2, gh)); grp.add(roof);
    scene.add(grp); nets.push({ gx, net, base, bulge: 0, by: 42.5, bz: gh / 2 });
  }

  // ---- ball
  const ballR = lax ? 0.26 : 0.36;
  const ballMat = lax ? new T.MeshStandardMaterial({ color: '#ffb02e', roughness: 0.45, emissive: '#5a3000', emissiveIntensity: 0.25 }) : new T.MeshStandardMaterial({ map: cvs.ballT ? canvasTex(cvs.ballT) : null, color: '#ffffff', roughness: 0.4 });
  const ball = new T.Mesh(new T.SphereGeometry(ballR, 24, 16), ballMat); ball.castShadow = true; scene.add(ball);
  const trailPts = []; const trail = new T.Mesh(new T.BufferGeometry(), new T.MeshBasicMaterial({ color: lax ? '#ffd27a' : '#ffffff', transparent: true, opacity: 0.35, depthWrite: false, toneMapped: false })); scene.add(trail);

  // ---- players
  const players = new Map(); const matCache = new Map();
  const numTex = (num, k) => { const c = document.createElement('canvas'); c.width = c.height = 128; const x = c.getContext('2d'); x.font = '700 92px Oswald, "Arial Narrow", sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.lineWidth = 9; x.strokeStyle = k.numOutline || '#000000'; x.strokeText(String(num), 64, 68); x.fillStyle = k.num; x.fillText(String(num), 64, 68); const t = new T.CanvasTexture(c); t.colorSpace = T.SRGBColorSpace; return t; };
  const attach = (bone, obj, worldPos, worldQuat, sizeFt) => { // attach obj to bone keeping a world-space rest placement
    bone.updateMatrixWorld(true); const inv = bone.matrixWorld.clone().invert(); const bs = new T.Vector3(); bone.getWorldScale(bs);
    obj.position.copy(worldPos).applyMatrix4(inv); const bq = bone.getWorldQuaternion(new T.Quaternion()); obj.quaternion.copy(bq.invert().multiply(worldQuat)); obj.scale.setScalar(sizeFt / bs.x); bone.add(obj);
  };
  const helmetGeo = new T.SphereGeometry(0.62, 18, 12, 0, Math.PI * 2, 0, Math.PI * 0.62);
  const cageMat = new T.MeshStandardMaterial({ color: '#d7dde4', roughness: 0.3, metalness: 0.8, wireframe: true });
  function makePlayer(id, info) {
    const A = ASSETS[hashS(id) % ASSETS.length]; const root = skClone(A.scene); const k = info.kit;
    const ck = A.name + ':' + info.side + ':' + (info.gk ? 1 : 0);
    if (!matCache.has(ck)) matCache.set(ck, new Map());
    root.traverse(c => { if (c.isMesh && c.material && c.material.name === 'kit') { const mc = matCache.get(ck); if (!mc.has(c.material)) mc.set(c.material, kitMaterial(c.material, k)); c.material = mc.get(c.material); } if (c.isMesh) c.castShadow = true; });
    const s = 3.15 / A.hipsY * (info.gk ? 1.04 : 1) * (0.96 + (hashS(id + 'h') % 9) / 100); root.scale.setScalar(s); root.updateMatrixWorld(true);
    const bone = n => root.getObjectByName('mixamorig' + n);
    // jersey number on the back
    const sp = bone('Spine2'); const sw = sp.getWorldPosition(new T.Vector3()); const back = sw.clone().add(new T.Vector3(0, 0.12, -0.58));
    const num = new T.Mesh(new T.PlaneGeometry(1, 1), new T.MeshStandardMaterial({ map: numTex(info.num, k), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, roughness: 0.7 }));
    attach(sp, num, back, new T.Quaternion().setFromAxisAngle(new T.Vector3(0, 1, 0), Math.PI), 0.95);
    const p = { id, root, A, mixer: new T.AnimationMixer(root), cur: null, curKey: '', oneShot: null, bone, info, hand: bone('RightHand'), hand2: bone('LeftHand'), head: bone('Head'), lastAct: '', seen: 0 };
    if (lax) {
      const hw = bone('Head').getWorldPosition(new T.Vector3()); const hm = new T.Group();
      const shell = new T.Mesh(helmetGeo, new T.MeshStandardMaterial({ color: k.helmet, roughness: 0.25, metalness: 0.1, envMapIntensity: 1.2 })); shell.position.y = 0.05; shell.castShadow = true; hm.add(shell);
      const cage = new T.Mesh(new T.CylinderGeometry(0.6, 0.5, 0.62, 14, 4, true, -1.0, 2.0), cageMat); cage.position.set(0, -0.2, 0.04); hm.add(cage);
      attach(bone('Head'), hm, hw.add(new T.Vector3(0, 0.36, 0.02)), new T.Quaternion(), 1);
      // stick: shaft + head, held in the right hand
      const stick = new T.Group(); const shaft = new T.Mesh(new T.CylinderGeometry(0.045, 0.045, 3.6, 8), new T.MeshStandardMaterial({ color: '#c9d1da', metalness: 0.85, roughness: 0.3 })); shaft.position.y = 0.9; stick.add(shaft);
      const headG = new T.TorusGeometry(0.32, 0.04, 6, 18); headG.scale(1, 1.5, 1); const shead = new T.Mesh(headG, new T.MeshStandardMaterial({ color: '#f4f4f4', roughness: 0.4 })); shead.position.y = 3.05; stick.add(shead);
      const mesh = new T.Mesh(new T.CircleGeometry(0.3, 12), new T.MeshStandardMaterial({ color: k.shirt, roughness: 0.9, side: T.DoubleSide, transparent: true, opacity: 0.85 })); mesh.scale.y = 1.5; mesh.position.y = 3.05; stick.add(mesh);
      stick.traverse(c => { if (c.isMesh) c.castShadow = true; }); p.stick = stick; p.stickHead = shead; scene.add(stick);
    }
    scene.add(root); players.set(id, p); return p;
  }
  const clipKey = (p, act, spd, fwd, lat) => {
    const gk = p.info.gk;
    if (gk) { if (act === 'save') return p.saveKey || 'gkBlock'; if (act === 'pass') return 'gkThrow'; if (spd > 3 && Math.abs(lat) > Math.abs(fwd)) return 'gkSide'; return 'gkIdle'; }
    if (lax) {
      const one = { shot: 'lShot', wind: 'lShot', pass: 'lPass', xcheck: 'xcheck', check: 'xcheck', scoop: 'scoop', cheer: 'cheer' }[act]; if (one) return one;
      if (act === 'fo') return 'fo';
      if (spd < 1.6) return act === 'def' || act === 'reach' ? 'defend' : 'cIdle';
      if (fwd < -0.5) return 'cBack'; if (Math.abs(lat) > 0.75) return lat > 0 ? 'cLeft' : 'cRight';
      return spd > 19 ? 'aimRun' : 'cradle';
    }
    const one = { shot: 'kick', pass: 'pass', head: 'header', bike: 'bike', check: 'tackle', cheer: (hashS(p.id) % 2 ? 'cheer' : 'fist') }[act]; if (one) return one;
    if (spd < 1.6) return act === 'def' || act === 'reach' ? 'defend' : 'sidle';
    if (fwd < -0.5) return 'back'; if (Math.abs(lat) > 0.75) return lat > 0 ? 'left' : 'right';
    return spd < 9 ? 'jog' : spd < 17 ? 'run' : 'sprint';
  };
  const NAT = { jog: 8.1, run: 14.5, sprint: 19.4, back: 10, left: 11.3, right: 11.8, cradle: 13.7, aimRun: 15, cBack: 8.2, cLeft: 7.4, cRight: 9.8, gkSide: 9.8, defend: 0 };
  const ONE = new Set(['lShot', 'lPass', 'xcheck', 'scoop', 'kick', 'pass', 'header', 'bike', 'tackle', 'gkBlock', 'gkDive', 'gkCatch', 'gkThrow', 'cheer', 'fist']);
  function animate(p, act, spd, fwd, lat, dt, actF) {
    let key = clipKey(p, act, spd, fwd, lat);
    if (p.oneShot && p.oneShot.isRunning() && act === p.lastAct) key = p.curKey;
    if (key !== p.curKey) {
      const clip = p.A.clips[key] || p.A.clips.idle; const a = p.mixer.clipAction(clip);
      a.enabled = true; a.setEffectiveWeight(1); a.reset();
      if (ONE.has(key)) { a.setLoop(T.LoopOnce, 1); a.clampWhenFinished = true; p.oneShot = a; if (key === 'lShot') a.time = 0.25; if (key === 'bike') a.time = 0.6; if (key === 'header') a.time = 1.2; if (key === 'kick' || key === 'pass') a.time = 0.05; } else { a.setLoop(T.LoopRepeat); p.oneShot = null; a.time = (hashS(p.id) % 100) / 100 * clip.duration; }
      a.play(); if (p.cur) p.cur.crossFadeTo(a, ONE.has(key) ? 0.12 : 0.25, false); p.cur = a; p.curKey = key;
    }
    p.lastAct = act;
    const nat = NAT[key]; if (p.cur && nat) p.cur.setEffectiveTimeScale(Math.max(0.55, Math.min(1.6, spd / nat))); else if (p.cur) p.cur.setEffectiveTimeScale(key === 'bike' ? 1.25 : 1);
    p.mixer.update(dt);
  }

  // ---- camera rig
  const cam = { x: 100, v: 0, zoom: 0, cut: null };
  const tmpV = new T.Vector3(), tmpQ = new T.Quaternion();
  const toRink = v => [v.x, -v.z, v.y];
  const replay = { buf: [], active: null, lastFlash: null };
  const view = {
    canvas: renderer.domElement, players, renderer,
    render(st) {
      const now = st.now; let frame = st; let rep = replay.active;
      if (!rep && st.flash && st.flash !== replay.lastFlash && !st.quiet) { replay.lastFlash = st.flash; const at = now + 1900; replay.active = rep = { start: at, end: at + 5200, frames: null, gx: null, side: st.flash.s }; }
      if (rep && now >= rep.start && !rep.frames) { const fr = replay.buf.filter(f => f.now >= rep.start - 1900 - 3600 && f.now <= rep.start - 1500); rep.frames = fr.length > 10 ? fr : null; if (!rep.frames) replay.active = rep = null; }
      if (rep && rep.frames && now >= rep.start) { if (now > rep.end) { replay.active = rep = null; for (const p of players.values()) { p.curKey = ''; } } else { const f = (now - rep.start) / (rep.end - rep.start); frame = rep.frames[Math.min(rep.frames.length - 1, Math.floor(f * rep.frames.length))]; } }
      const inReplay = !!(rep && rep.frames && now >= rep.start);
      if (!inReplay) { replay.buf.push(st); while (replay.buf.length && replay.buf[0].now < now - 7000) replay.buf.shift(); }
      const dt = inReplay ? (frame._dt || 0.016) * 0.5 : st.dtG;
      // players
      const live = new Set();
      for (const q of frame.players) {
        live.add(q.id); let p = players.get(q.id); if (!p) p = makePlayer(q.id, st.info(q.id));
        p.root.visible = true; const yaw = Math.atan2(Math.cos(q.face), -Math.sin(q.face));
        p.root.position.copy(V(q.x, q.y, 0)); p.root.rotation.set(0, yaw, 0);
        const spd = Math.hypot(q.vx, q.vy); const cf = Math.cos(q.face), sf = Math.sin(q.face); const fwd = spd > 0.5 ? (q.vx * cf + q.vy * sf) / spd : 1; const lat = spd > 0.5 ? (-q.vx * sf + q.vy * cf) / spd : 0;
        if (q.act === 'save' && p.lastAct !== 'save') { const b = frame.ball; const dy = b ? Math.abs(b[1] - q.y) : 0; p.saveKey = dy > 2.6 ? 'gkDive' : (b && b[2] > 3.5 ? 'gkCatch' : 'gkBlock'); }
        animate(p, q.act, spd, fwd, lat, Math.min(0.1, dt), q.actF);
      }
      for (const [id, p] of players) if (!live.has(id)) { p.root.visible = false; if (p.stick) p.stick.visible = false; }
      scene.updateMatrixWorld(true);
      // sticks follow the hands; pockets and feet feed the play engine
      const heads = st.heads;
      for (const q of frame.players) {
        const p = players.get(q.id); if (!p) continue;
        if (lax && p.stick) {
          const h1 = p.hand.getWorldPosition(new T.Vector3()), h2 = p.hand2.getWorldPosition(new T.Vector3());
          const fwd = new T.Vector3(Math.cos(q.face), 0, -Math.sin(q.face)); let dir = h1.clone().sub(h2); const two = dir.length() < 1.6 && ['cradle', 'cIdle', 'cBack', 'cLeft', 'cRight', 'lShot', 'lPass', 'xcheck', 'fo', 'aimRun'].includes(p.curKey);
          const hq = p.hand.getWorldQuaternion(tmpQ); const handUp = new T.Vector3(0, 1, 0).applyQuaternion(hq), handSide = new T.Vector3(1, 0, 0).applyQuaternion(hq);
          dir = two ? handSide.clone().multiplyScalar(-1).add(new T.Vector3(0, 0.55, 0)).normalize() : fwd.clone().multiplyScalar(0.55).add(new T.Vector3(0, 0.9, 0)).add(handUp.multiplyScalar(0.3)).normalize();
          if (p.curKey === 'scoop') dir = fwd.clone().multiplyScalar(0.9).add(new T.Vector3(0, -0.45, 0)).normalize();
          if (q.gk || p.info.gk) dir = fwd.clone().multiplyScalar(0.25).add(new T.Vector3(0, 1, 0)).normalize();
          p.stick.visible = p.root.visible; p.stick.position.copy(two ? h1.clone().lerp(h2, 0.5) : h1).addScaledVector(dir, -0.7); p.stick.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), dir);
          const hp = p.stickHead.getWorldPosition(tmpV); if (heads) heads[q.id] = toRink(hp);
        } else if (heads) {
          if (p.info.gk) { const a = p.hand.getWorldPosition(new T.Vector3()).lerp(p.hand2.getWorldPosition(new T.Vector3()), 0.5); heads[q.id] = toRink(a); }
          else { const tch = Math.hypot(q.vx, q.vy) > 2 ? 0.35 * Math.abs(Math.sin(now / 160 + q.id)) : 0.05; heads[q.id] = [q.x + Math.cos(q.face) * (1.1 + tch), q.y + Math.sin(q.face) * (1.1 + tch), 0.36]; }
        }
      }
      // ball
      let bp = null; if (frame.holder && heads && heads[frame.holder]) bp = heads[frame.holder]; else if (frame.ball) bp = frame.ball;
      ball.visible = !!bp; if (bp) { const prev = ball.position.clone(); ball.position.copy(V(bp[0], bp[1], Math.max(ballR, bp[2]))); const mv = prev.distanceTo(ball.position); if (!lax && mv > 0.001 && mv < 8) { const ax = new T.Vector3().subVectors(ball.position, prev).cross(new T.Vector3(0, 1, 0)).normalize(); ball.rotateOnWorldAxis(ax, -mv / ballR); }
        trailPts.push(ball.position.clone()); while (trailPts.length > 10) trailPts.shift(); const fast = trailPts.length > 3 && trailPts[trailPts.length - 1].distanceTo(trailPts[trailPts.length - 4]) > 4; trail.visible = fast; if (fast) { trail.geometry.dispose(); trail.geometry = new T.TubeGeometry(new T.CatmullRomCurve3(trailPts.slice(-6)), 12, ballR * 0.55, 6, false); } }
      // nets bulge when the ball is inside
      for (const n of nets) { const inside = bp && ((n.gx < 100 && bp[0] < n.gx) || (n.gx > 100 && bp[0] > n.gx)) && bp[1] > gw[0] - 1 && bp[1] < gw[1] + 1; if (inside) { n.bulge = 1; n.by = bp[1]; n.bz = bp[2]; } else n.bulge *= 0.94; const pos = n.net.geometry.attributes.position; const d = n.gx < 100 ? -1 : 1; for (let i = 0; i < pos.count; i++) { const b = n.base[i]; const ry = -b.z, rz = b.y; const w = Math.exp(-((ry - n.by) ** 2 + (rz - n.bz) ** 2) / 6) * n.bulge * 1.4; pos.setXYZ(i, b.x + d * w, b.y, b.z); } pos.needsUpdate = true; }
      // crowd
      const excite = st.flash && now < st.flash.until ? 1 : st.crunch ? 0.35 : 0.06; updateFans(now / 1000, excite);
      // camera
      const dtR = Math.min(0.1, st.dtR || 0.016); let eye, ctr, fov = 23;
      if (inReplay) { const gx = frame.attR ? o.goalX[1] : o.goalX[0]; const d = gx > 100 ? 1 : -1; const f = (now - rep.start) / (rep.end - rep.start); eye = V(gx + d * (lax ? 7 : 3), 42.5 + 16 - f * 32, 12.5); ctr = V(gx - d * 24, 42.5 + 4 - f * 8, 2.5); fov = 44; }
      else {
        const xs = frame.players.filter(q => !q.gk).map(q => q.x); const cx = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 100;
        let want = (bp ? bp[0] * 0.6 : 60) + cx * 0.4; want = Math.max(lax ? 40 : 30, Math.min(lax ? 160 : 170, want));
        if (Math.abs(want - cam.x) > 45) { cam.x = want; cam.v = 0; }
        const w0 = 2.1; const err = want - cam.x; const dz = Math.abs(err) < 5 ? err * 0.3 : err; cam.v += (w0 * w0 * dz - 2 * w0 * cam.v) * dtR; cam.x += cam.v * dtR;
        cam.zoom += ((Math.abs(cam.v) > 14 ? 1 : 0) - cam.zoom) * Math.min(1, dtR * 1.2);
        const hand = Math.sin(now / 1900) * 0.25 + Math.sin(now / 1270) * 0.15;
        if (st.flash && now > st.flash.from - 500 && now < st.flash.from + 1400 && bp) { eye = V(cam.x - cam.v * 0.1 + hand, -30, 18); ctr = V(bp[0], bp[1], 3); fov = 15; }
        else { eye = V(cam.x - cam.v * 0.1 + hand, -40 - cam.zoom * 8, 22 + cam.zoom * 4); ctr = V(cam.x + cam.v * 0.22, 46, 3 + hand * 0.3); }
      }
      camera.position.copy(eye); camera.lookAt(ctr); if (camera.fov !== fov) { camera.fov = fov; camera.updateProjectionMatrix(); }
      key.shadow.camera.updateProjectionMatrix();
      composer.render(dtR);
      return { replay: inReplay, replayFrom: rep && rep.start, pauseUntil: rep ? rep.end : 0 };
    },
    dispose() { renderer.dispose(); composer.dispose && composer.dispose(); rt.dispose(); }
  };
  return view;
}
