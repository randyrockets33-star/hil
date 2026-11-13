// Hometown leagues: broadcast 3D match renderer (three.js). Realistic rigged athletes with
// motion-captured animation, team kits, arena, shadows, bloom and goal replays.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as skClone } from 'three/addons/utils/SkeletonUtils.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { BokehPass } from 'three/addons/postprocessing/BokehPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const T = THREE;
const V = (x, y, z) => new T.Vector3(x, z, -y);          // rink feet (x along, y across, z up) -> three
const hashS = s => { let h = 2166136261; s = String(s); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
const MODELS = ['remy', 'ben', 'brian', 'brian_d', 'joe', 'joe_d', 'leonard'];
const SKIN = { remy: '#b48677', ben: '#744e37', brian: '#b0907f', brian_d: '#62402e', joe: '#af8570', joe_d: '#78523c', leonard: '#a3836e' };
let ASSETS = null, LOADING = null, ANIM = null;

// one shared motion-capture pack (world-space rotation deltas from the T-pose), retargeted per body at runtime
const stripMx = n => n.replace(/^mixamorig/, '');
const MIRN = n => /^Left/.test(n) ? 'Right' + n.slice(4) : /^Right/.test(n) ? 'Left' + n.slice(5) : n;
function prepRig(A) {
  const tb = {}; A.scene.traverse(c => { if (c.isBone) tb[stripMx(c.name)] = c; }); A.scene.updateMatrixWorld(true);
  const rw = {}; for (const n in tb) rw[n] = tb[n].getWorldQuaternion(new T.Quaternion());
  const arm = tb.Hips.parent;
  A.rt = { tb, rw, arm, armW: arm.getWorldQuaternion(new T.Quaternion()), armMinv: arm.matrixWorld.clone().invert(), hipsRest: tb.Hips.getWorldPosition(new T.Vector3()) };
  A.leftSign = Math.sign(tb.LeftHand.getWorldPosition(new T.Vector3()).x - tb.RightHand.getWorldPosition(new T.Vector3()).x) || 1;
  A.cache = {};
}
const clipMeta = k => ANIM && ANIM.meta.clips[k];
const endSpike = m => ['footR', 'handR', 'head'].some(f => m[f][0] >= m.dur - 0.07 && m[f][1] > 14);
function getClip(A, key, mirror, keepXZ) {
  const ck = key + (mirror ? '~m' : '') + (keepXZ ? '~x' : ''); if (A.cache[ck]) return A.cache[ck];
  const m = clipMeta(key); if (!m) return null;
  const bones = ANIM.meta.bones, nb = bones.length, fps = ANIM.meta.fps; const idx = {}; bones.forEach((b, j) => idx[b] = j);
  const n = endSpike(m) ? Math.max(2, m.n - 1) : m.n;
  const Q = new Int16Array(ANIM.bin, m.off, m.n * nb * 4), H = new Float32Array(ANIM.bin, m.off + m.n * nb * 8, m.n * 3);
  const { tb, rw, arm, armW, armMinv, hipsRest } = A.rt; const hy = hipsRest.y;
  const use = bones.filter(b => tb[b]); const times = new Float32Array(n); const qv = {}; use.forEach(b => qv[b] = new Float32Array(n * 4)); const pv = new Float32Array(n * 3);
  const d = new T.Quaternion(), tmp = new T.Quaternion(), w = {}, pp = new T.Vector3(); const sx = mirror ? -1 : 1;
  for (let i = 0; i < n; i++) {
    times[i] = i / fps;
    for (const b of use) {
      const j = idx[mirror ? MIRN(b) : b]; if (j === undefined) continue; const o = (i * nb + j) * 4;
      d.set(Q[o] / 32767, Q[o + 1] / 32767, Q[o + 2] / 32767, Q[o + 3] / 32767).normalize(); if (mirror) { d.y = -d.y; d.z = -d.z; }
      const W = (w[b] || (w[b] = new T.Quaternion())).copy(d).multiply(rw[b]);
      const par = tb[b].parent; const pw = par === arm ? armW : (w[stripMx(par.name)] || rw[stripMx(par.name)] || armW);
      tmp.copy(pw).invert().multiply(W).toArray(qv[b], i * 4);
    }
    const hx = keepXZ ? (H[i * 3] - H[0]) * sx : 0, hz = keepXZ ? H[i * 3 + 2] - H[2] : 0;
    pp.set(hipsRest.x + hx * hy, hipsRest.y + H[i * 3 + 1] * hy, hipsRest.z + hz * hy).applyMatrix4(armMinv).toArray(pv, i * 3);
  }
  const tracks = use.map(b => new T.QuaternionKeyframeTrack('mixamorig' + b + '.quaternion', times, qv[b]));
  tracks.push(new T.VectorKeyframeTrack('mixamorigHips.position', times, pv));
  const clip = new T.AnimationClip(key, (n - 1) / fps, tracks);
  clip.userData = { meta: m, srcDx: H[(n - 1) * 3] - H[0] };
  return (A.cache[ck] = clip);
}

export function loadAssets(base) {
  if (ASSETS) return Promise.resolve(ASSETS);
  if (LOADING) return LOADING;
  const ld = new GLTFLoader();
  const anims = Promise.all([fetch(base + 'anims.json').then(r => r.json()), fetch(base + 'anims.bin').then(r => r.arrayBuffer())]).then(([meta, bin]) => { ANIM = { meta, bin }; });
  LOADING = Promise.all([anims, ...MODELS.map(n => ld.loadAsync(base + n + '.glb'))]).then(([, ...gs]) => {
    ASSETS = gs.map((g, i) => {
      g.scene.updateMatrixWorld(true);
      const hipsY = g.scene.getObjectByName('mixamorigHips').getWorldPosition(new T.Vector3()).y;
      g.scene.traverse(c => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = false; c.frustumCulled = false; } });
      const A = { name: MODELS[i], scene: g.scene, hipsY }; prepRig(A);
      A.clips = new Proxy({}, { get: (_, k) => typeof k === 'string' ? getClip(A, k, false, false) : undefined });
      return A;
    });
    return ASSETS;
  });
  return LOADING;
}

function kitMaterial(src, k) {
  const m = src.clone(); const mask = src.emissiveMap; m.emissiveMap = null; m.emissive = new T.Color(0);
  const U = { kMask: { value: mask }, kShirt: { value: new T.Color(k.shirt) }, kShorts: { value: new T.Color(k.shorts) }, kSocks: { value: new T.Color(k.socks) }, kGlove: { value: new T.Color(k.glove) }, kBoots: { value: new T.Color(k.boots || '#202226') } };
  m.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, U);
    sh.fragmentShader = 'uniform sampler2D kMask; uniform vec3 kShirt, kShorts, kSocks, kGlove, kBoots;\n' + sh.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
      vec3 km = texture2D(kMask, vMapUv).rgb; vec3 kc = vec3(1.0); float kw = 0.0;
      if (km.r > 0.5 && km.g > 0.5) { kc = kGlove; kw = 1.0; } else if (km.r > 0.5) { kc = kShirt; kw = 1.0; } else if (km.g > 0.5 && km.b > 0.5) { kc = kBoots; kw = 1.0; } else if (km.g > 0.5) { kc = kShorts; kw = 1.0; } else if (km.b > 0.5) { kc = kSocks; kw = 1.0; }
      diffuseColor.rgb = mix(diffuseColor.rgb, min(diffuseColor.rgb * kc * 3.4, vec3(0.92)), kw);`);
  };
  m.customProgramCacheKey = () => 'hlkit2';
  return m;
}
const CREST = new Map();
function crestTex(team) { // round club crest: primary disc, secondary ring, club code
  const key = team.code + team.p + team.s; if (CREST.has(key)) return CREST.get(key);
  const c = document.createElement('canvas'); c.width = c.height = 128; const x = c.getContext('2d');
  x.beginPath(); x.arc(64, 64, 58, 0, 7); x.fillStyle = team.p; x.fill(); x.lineWidth = 9; x.strokeStyle = team.s; x.stroke();
  x.fillStyle = team.s; x.textAlign = 'center'; x.textBaseline = 'middle'; x.font = `700 ${team.code.length > 2 ? 44 : 56}px Oswald, "Arial Narrow", sans-serif`; x.fillText(team.code, 64, 67);
  const t = new T.CanvasTexture(c); t.colorSpace = T.SRGBColorSpace; t.anisotropy = 4; CREST.set(key, t); return t;
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
  const hi = !lowEnd; const QL = { dof: hi, shafts: hi, grade: true };
  const dof = hi ? new BokehPass(scene, camera, { focus: 60, aperture: 0.00012, maxblur: 0.006 }) : null; if (dof) { dof.enabled = false; composer.addPass(dof); }
  const bloom = new UnrealBloomPass(new T.Vector2(W, H), 0.3, 0.5, 0.97); composer.addPass(bloom);
  composer.addPass(new OutputPass());
  const grade = new ShaderPass({ uniforms: { tDiffuse: { value: null }, sat: { value: 1.08 }, con: { value: 1.06 } }, vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'uniform sampler2D tDiffuse; uniform float sat, con; varying vec2 vUv; void main(){ vec4 c = texture2D(tDiffuse, vUv); float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722)); vec3 g = mix(vec3(l), c.rgb, sat); g = (g - 0.5) * con + 0.5; gl_FragColor = vec4(clamp(g, 0.0, 1.0), c.a); }' });
  composer.addPass(grade);
  const perf = { n: 0, t: 0 };

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
  // the crowd: real fans, rendered once from the athlete bodies (team-coloured shirts; standing, clapping, arms-up), drawn as camera-facing cards
  const cc0 = cvs.crowdCols || []; const crowdCols = [...new Set([cc0[0] || '#8a2020', cc0[1] || '#d0d0d0', cc0[6] || '#203a8a'])].concat(['#e8e8ea', '#26282e']); const COLW = [0, 0, 0, 1, 1, 2, 3, 4].map(i => Math.min(i, crowdCols.length - 1));
  const atlas = (() => {
    const CW = 64, CH = 128, POSES = ['sidle', 'clap', 'cheer'], AC = 16; const cells = ASSETS.length * crowdCols.length * POSES.length; const AR = Math.ceil(cells / AC);
    const rtA = new T.WebGLRenderTarget(CW * AC, CH * AR, { samples: 0 }); const sc = new T.Scene(); sc.add(new T.HemisphereLight('#ffffff', '#3a4250', 1.5)); const dl = new T.DirectionalLight('#ffffff', 1.8); dl.position.set(1.5, 3, 4); sc.add(dl);
    const cam = new T.OrthographicCamera(-1.55, 1.55, 3.1, -3.1, 0.1, 40); cam.position.set(0, 3.0, 12); cam.lookAt(0, 3.0, 0);
    const prevRT = renderer.getRenderTarget(), prevCol = renderer.getClearColor(new T.Color()), prevA = renderer.getClearAlpha(), prevSh = renderer.shadowMap.enabled;
    renderer.shadowMap.enabled = false; renderer.setRenderTarget(rtA); renderer.setClearColor(0x000000, 0); renderer.clear(); rtA.scissorTest = true;
    let ci = 0;
    ASSETS.forEach((A, ai) => {
      const best = {}; // representative moment of each pose
      for (const pk of POSES) { const clip = getClip(A, pk); if (!clip) continue; const tmp = skClone(A.scene); const mx = new T.AnimationMixer(tmp); mx.clipAction(clip).play(); let bt = 0, bv = -1e9; for (let s = 0; s <= 10; s++) { const t = clip.duration * s / 10; mx.setTime(t); tmp.updateMatrixWorld(true); const l = tmp.getObjectByName('mixamorigLeftHand').getWorldPosition(new T.Vector3()), r = tmp.getObjectByName('mixamorigRightHand').getWorldPosition(new T.Vector3()); const v = pk === 'cheer' ? l.y + r.y : pk === 'clap' ? -l.distanceTo(r) : 0; if (v > bv) { bv = v; bt = t; } } best[pk] = bt; }
      crowdCols.forEach(col => POSES.forEach(pk => {
        const root = skClone(A.scene); const k = { shirt: col, shorts: '#2b3140', socks: '#2b3140', glove: SKIN[A.name] || '#c99a78', boots: '#1a1a1a' };
        root.traverse(c => { if (c.isMesh && c.material && c.material.name === 'kit') c.material = kitMaterial(c.material, k); });
        root.scale.setScalar(3.15 / A.hipsY); const mx = new T.AnimationMixer(root); const clip = getClip(A, pk); if (clip) { mx.clipAction(clip).play(); mx.setTime(best[pk] || 0); }
        sc.add(root); root.updateMatrixWorld(true); const cx = (ci % AC) * CW, cy = Math.floor(ci / AC) * CH; rtA.viewport.set(cx, cy, CW, CH); rtA.scissor.set(cx, cy, CW, CH); renderer.setRenderTarget(rtA); renderer.render(sc, cam); sc.remove(root); ci++;
      }));
    });
    rtA.scissorTest = false; rtA.viewport.set(0, 0, CW * AC, CH * AR); renderer.setRenderTarget(prevRT); renderer.setClearColor(prevCol, prevA); renderer.shadowMap.enabled = prevSh;
    return { tex: rtA.texture, AC, AR, nPose: POSES.length, nCol: crowdCols.length };
  })();
  const fanGeo = new T.PlaneGeometry(3.1, 6.2); fanGeo.translate(0, 3.1, 0);
  const iCell = new Float32Array(fans.length), iPh = new Float32Array(fans.length);
  fans.forEach((f, i) => { const body = f.h % ASSETS.length, col = COLW[(f.h >>> 5) % COLW.length]; iCell[i] = (body * atlas.nCol + col) * atlas.nPose; iPh[i] = f.ph; });
  fanGeo.setAttribute('iCell', new T.InstancedBufferAttribute(iCell, 1)); fanGeo.setAttribute('iPh', new T.InstancedBufferAttribute(iPh, 1));
  const fanU = { uAtlas: { value: atlas.tex }, uTime: { value: 0 }, uExcite: { value: 0 }, uGrid: { value: new T.Vector2(atlas.AC, atlas.AR) }, fogColor: { value: scene.fog.color }, fogNear: { value: scene.fog.near }, fogFar: { value: scene.fog.far } };
  const fanMat = new T.ShaderMaterial({ uniforms: fanU, transparent: false, fog: false,
    vertexShader: `attribute float iCell; attribute float iPh; uniform float uTime, uExcite; uniform vec2 uGrid; varying vec2 vUv; varying float vShade; varying float vFog;
      void main(){
        float act = uExcite > 0.6 ? 2.0 : (uExcite > 0.25 ? 1.0 : 0.0);
        float on = step(0.0, sin(uTime * (act > 1.5 ? 7.0 : 4.0) + iPh * 3.0));
        float pose = act > 0.5 ? (on > 0.5 ? act : (act > 1.5 ? 1.0 : 0.0)) : (fract(iPh * 7.3) > 0.93 ? 1.0 : 0.0);
        float cell = iCell + pose; vec2 c = vec2(mod(cell, uGrid.x), floor(cell / uGrid.x));
        vUv = (c + uv) / uGrid;
        vec3 wp = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        vec3 toCam = cameraPosition - wp; toCam.y = 0.0; vec3 fwd = normalize(toCam); vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), fwd));
        float bob = act > 1.5 ? max(0.0, sin(uTime * 7.0 + iPh * 3.0)) * 0.9 : 0.0;
        wp += right * position.x + vec3(0.0, position.y + bob, 0.0);
        vShade = 0.5 + 0.12 * fract(iPh * 3.7);
        vec4 mv = viewMatrix * vec4(wp, 1.0); vFog = -mv.z; gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `uniform sampler2D uAtlas; uniform vec3 fogColor; uniform float fogNear, fogFar; varying vec2 vUv; varying float vShade; varying float vFog;
      void main(){ vec4 c = texture2D(uAtlas, vUv); if (c.a < 0.5) discard; vec3 col = c.rgb * vShade; col = mix(col, fogColor, smoothstep(fogNear, fogFar, vFog)); gl_FragColor = vec4(col, 1.0); }` });
  const fanMesh = new T.InstancedMesh(fanGeo, fanMat, fans.length); fanMesh.frustumCulled = false;
  { const M = new T.Matrix4(); fans.forEach((f, i) => { M.makeTranslation(V(f.x, f.y, f.z)); fanMesh.setMatrixAt(i, M); }); }
  scene.add(fanMesh);
  const updateFans = (t, excite) => { fanU.uTime.value = t; fanU.uExcite.value += (excite - fanU.uExcite.value) * 0.08; };
  // LED ribbon on the far stands + light rigs
  const ribTex = canvasTex(cvs.rib); ribTex.wrapS = T.RepeatWrapping; ribTex.repeat.set(3, 1);
  const ribGoal = (team) => { const c = document.createElement('canvas'); c.width = 2048; c.height = 64; const x = c.getContext('2d'); x.fillStyle = team.p; x.fillRect(0, 0, 2048, 64); x.font = '800 46px Oswald, "Arial Narrow", sans-serif'; x.textBaseline = 'middle'; for (let i = 0; i < 8; i++) { x.fillStyle = i % 2 ? team.s : '#ffffff'; x.fillText(i % 2 ? (team.code + ' GOAL') : 'GOAL!', 30 + i * 256, 34); } const t = canvasTex(c); t.wrapS = T.RepeatWrapping; t.repeat.set(3, 1); return t; };
  const rib = new T.Mesh(new T.PlaneGeometry(300, 2.6), new T.MeshBasicMaterial({ map: ribTex, toneMapped: false, color: '#c8c8c8' })); rib.position.copy(V(100, 85 + 6 + 9 * 3.1, 3 + 9 * 2.4 + 1.6)); rib.rotation.x = -0.3; scene.add(rib);
  for (let i = 0; i < 7; i++) { const lb = new T.Mesh(new T.BoxGeometry(14, 1, 3), new T.MeshBasicMaterial({ color: '#fff6e0', toneMapped: false })); lb.position.copy(V(10 + i * 30, 42.5 + (i % 2 ? 22 : -22), 78)); scene.add(lb); }
  const shafts = new T.Group(); if (QL.shafts) {
    const c = document.createElement('canvas'); c.width = 4; c.height = 128; const x = c.getContext('2d'); const g = x.createLinearGradient(0, 0, 0, 128); g.addColorStop(0, '#ffffff'); g.addColorStop(0.55, '#ffffff55'); g.addColorStop(1, '#ffffff00'); x.fillStyle = g; x.fillRect(0, 0, 4, 128);
    const st = new T.CanvasTexture(c); const sm = new T.MeshBasicMaterial({ map: st, color: '#fff2d8', transparent: true, opacity: 0.045, blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide, toneMapped: false, fog: false });
    for (let i = 0; i < 7; i++) { const top = V(10 + i * 30, 42.5 + (i % 2 ? 22 : -22), 77), bot = V(10 + i * 30 + 6, 42.5 + (i % 2 ? 10 : -10), 0); const len = top.distanceTo(bot); const cone = new T.Mesh(new T.CylinderGeometry(4, 26, len, 20, 1, true), sm); cone.position.copy(top).add(bot).multiplyScalar(0.5); cone.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), top.clone().sub(bot).normalize()); shafts.add(cone); }
    scene.add(shafts);
  }
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

  // ---- soft contact shadows under every athlete (and the ball): grounds them the way a broadcast picture does
  const blobTex = (() => { const c = document.createElement('canvas'); c.width = c.height = 64; const x = c.getContext('2d'); const g = x.createRadialGradient(32, 32, 0, 32, 32, 32); g.addColorStop(0, '#000000d0'); g.addColorStop(0.45, '#00000080'); g.addColorStop(1, '#00000000'); x.fillStyle = g; x.fillRect(0, 0, 64, 64); return new T.CanvasTexture(c); })();
  const blobs = new T.InstancedMesh(new T.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), new T.MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false, opacity: 0.6, polygonOffset: true, polygonOffsetFactor: -4, toneMapped: false }), 48); blobs.count = 0; blobs.renderOrder = 1; scene.add(blobs);
  const _bm = new T.Matrix4(), _bq = new T.Quaternion(), _bs = new T.Vector3(), _bp = new T.Vector3();
  // ---- players
  const players = new Map(); const matCache = new Map();
  const numTex = (num, k) => { const c = document.createElement('canvas'); c.width = c.height = 128; const x = c.getContext('2d'); x.font = '700 92px Oswald, "Arial Narrow", sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.lineWidth = 9; x.strokeStyle = k.numOutline || '#000000'; x.strokeText(String(num), 64, 68); x.fillStyle = k.num; x.fillText(String(num), 64, 68); const t = new T.CanvasTexture(c); t.colorSpace = T.SRGBColorSpace; return t; };
  const attach = (bone, obj, worldPos, worldQuat, sizeFt) => { // attach obj to bone keeping a world-space rest placement
    bone.updateMatrixWorld(true); const inv = bone.matrixWorld.clone().invert(); const bs = new T.Vector3(); bone.getWorldScale(bs);
    obj.position.copy(worldPos).applyMatrix4(inv); const bq = bone.getWorldQuaternion(new T.Quaternion()); obj.quaternion.copy(bq.invert().multiply(worldQuat)); obj.scale.setScalar(sizeFt / bs.x); bone.add(obj);
  };
  const helmetGeo = new T.SphereGeometry(0.62, 18, 12, 0, Math.PI * 2, 0, Math.PI * 0.62);
  const cageMat = new T.MeshStandardMaterial({ color: '#d7dde4', roughness: 0.3, metalness: 0.8, wireframe: true });
  const nameTex = (name, k) => { const c = document.createElement('canvas'); c.width = 512; c.height = 96; const x = c.getContext('2d'); const s = String(name || '').toUpperCase(); let fs = 78; x.font = `700 ${fs}px Oswald, "Arial Narrow", sans-serif`; while (x.measureText(s).width > 480 && fs > 30) { fs -= 4; x.font = `700 ${fs}px Oswald, "Arial Narrow", sans-serif`; } x.textAlign = 'center'; x.textBaseline = 'middle'; x.lineWidth = 8; x.strokeStyle = k.numOutline || '#000'; x.strokeText(s, 256, 52); x.fillStyle = k.num; x.fillText(s, 256, 52); const t = new T.CanvasTexture(c); t.colorSpace = T.SRGBColorSpace; t.anisotropy = 4; return t; };
  const HAIR = [null, null, null, '#8a6a4a', '#4a3424', '#231a14', '#2e2420'];
  const BOOTS = ['#16181c', '#f1f2f4', null];
  const decal = (tex, size) => new T.Mesh(new T.PlaneGeometry(1, 1), new T.MeshStandardMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, roughness: 0.6 }));
  function makePlayer(id, info) {
    const A = ASSETS[hashS(id + 'body') % ASSETS.length]; const root = skClone(A.scene); const k = Object.assign({}, info.kit);
    if (!k.glove) k.glove = SKIN[A.name] || '#c99a78';
    if (!k.boots) { const b = BOOTS[hashS((info.team && info.team.code) || k.shirt) % BOOTS.length]; k.boots = b || k.shorts; }
    const ck = A.name + ':' + info.side + ':' + (info.gk ? 1 : 0) + ':' + k.boots + ':' + k.glove;
    if (!matCache.has(ck)) matCache.set(ck, new Map());
    const hairC = HAIR[hashS(id + 'hair') % HAIR.length];
    root.traverse(c => {
      if (c.isMesh && c.material && c.material.name === 'kit') { const mc = matCache.get(ck); if (!mc.has(c.material)) mc.set(c.material, kitMaterial(c.material, k)); c.material = mc.get(c.material); }
      else if (c.isMesh && c.material && c.material.name === 'hair' && hairC) { const hk = c.material.uuid + hairC; if (!matCache.has(hk)) { const hm = c.material.clone(); hm.color = new T.Color(hairC).multiplyScalar(2.2); matCache.set(hk, hm); } c.material = matCache.get(hk); }
      if (c.isMesh) c.castShadow = true;
    });
    // body variety: height and build from a stable per-player seed
    const hf = (info.gk ? 1.04 : 1) * (0.94 + (hashS(id + 'h') % 13) / 100), wf = 1;
    const s = 3.15 / A.hipsY * hf; root.scale.setScalar(s); root.updateMatrixWorld(true);
    const bone = n => root.getObjectByName('mixamorig' + n);
    // jersey number + surname on the back, crest on the chest and shorts
    const sp = bone('Spine2'); const sw = sp.getWorldPosition(new T.Vector3()); const back = sw.clone().add(new T.Vector3(0, -0.06, -0.58 * wf));
    const turn = new T.Quaternion().setFromAxisAngle(new T.Vector3(0, 1, 0), Math.PI);
    const num = new T.Mesh(new T.PlaneGeometry(1, 1), new T.MeshStandardMaterial({ map: numTex(info.num, k), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, roughness: 0.7 }));
    attach(sp, num, back, turn, 0.95);
    if (info.name) { const nm = decal(nameTex(info.name, k)); attach(sp, nm, back.clone().add(new T.Vector3(0, 0.47, -0.04)), turn, 1.3); nm.scale.y *= 96 / 512 * 1.15; }
    if (info.team) {
      const ct = crestTex(info.team);
      const chest = decal(ct); attach(sp, chest, sw.clone().add(new T.Vector3(0.24 * A.leftSign, 0.32, 0.55 * wf)), new T.Quaternion(), 0.26);
      const ul = bone('LeftUpLeg'); if (ul) { const uw = ul.getWorldPosition(new T.Vector3()); const sh = decal(ct); attach(ul, sh, uw.add(new T.Vector3(0.1 * A.leftSign, -0.3, 0.37 * wf)), new T.Quaternion(), 0.2); }
    }
    const p = { id, root, A, mixer: new T.AnimationMixer(root), cur: null, curKey: '', oneShot: null, bone, info, hf, hand: bone('RightHand'), hand2: bone('LeftHand'), head: bone('Head'), neck: bone('Neck'), lastAct: '', seen: 0, lookW: 0 };
    { const hq = p.head.getWorldQuaternion(new T.Quaternion()).invert(); p.headFwd = new T.Vector3(0, 0, 1).applyQuaternion(hq); }
    if (lax) {
      const hw = bone('Head').getWorldPosition(new T.Vector3()); const hm = new T.Group();
      const shell = new T.Mesh(helmetGeo, new T.MeshStandardMaterial({ color: k.helmet, roughness: 0.25, metalness: 0.1, envMapIntensity: 1.2 })); shell.position.y = 0.05; shell.castShadow = true; hm.add(shell);
      const cage = new T.Mesh(new T.CylinderGeometry(0.6, 0.5, 0.62, 14, 4, true, -1.0, 2.0), cageMat); cage.position.set(0, -0.2, 0.04); hm.add(cage);
      if (info.team) { const ct = crestTex(info.team); for (const sd of [-1, 1]) { const dc = decal(ct); dc.position.set(sd * 0.6, 0.18, -0.05); dc.rotation.y = sd * Math.PI / 2; dc.scale.setScalar(0.34); hm.add(dc); } }
      attach(bone('Head'), hm, hw.add(new T.Vector3(0, 0.36, 0.02)), new T.Quaternion(), 1);
      // stick: shaft + head, held in the right hand
      const stick = new T.Group(); const shaft = new T.Mesh(new T.CylinderGeometry(0.045, 0.045, 3.6, 8), new T.MeshStandardMaterial({ color: '#c9d1da', metalness: 0.85, roughness: 0.3 })); shaft.position.y = 0.9; stick.add(shaft);
      const headG = new T.TorusGeometry(0.32, 0.04, 6, 18); headG.scale(1, 1.5, 1); const shead = new T.Mesh(headG, new T.MeshStandardMaterial({ color: '#f4f4f4', roughness: 0.4 })); shead.position.y = 3.05; stick.add(shead);
      const mesh = new T.Mesh(new T.CircleGeometry(0.3, 12), new T.MeshStandardMaterial({ color: k.shirt, roughness: 0.9, side: T.DoubleSide, transparent: true, opacity: 0.85 })); mesh.scale.y = 1.5; mesh.position.y = 3.05; stick.add(mesh);
      stick.traverse(c => { if (c.isMesh) c.castShadow = true; }); p.stick = stick; p.stickHead = shead; scene.add(stick);
    }
    scene.add(root); players.set(id, p); return p;
  }
  const pick = (p, salt, arr) => arr[hashS(p.id + salt) % arr.length];
  const clipKey = (p, act, spd, fwd, lat) => {
    const gk = p.info.gk;
    if (p.ovr) return p.ovr.key;
    if (gk) { if (act === 'save') return p.saveKey || 'gkBlock'; if (act === 'pass') return 'gkThrow'; if (spd > 3 && Math.abs(lat) > Math.abs(fwd)) return 'gkSide'; return spd < 1.2 && hashS(p.id) % 3 === 0 ? 'gkDirect' : 'gkIdle'; }
    if (lax) {
      const one = { shot: 'lShot', wind: 'lShot', pass: 'lPass', xcheck: 'xcheck', check: 'xcheck', scoop: 'scoop', cheer: pick(p, 'c', ['cheer', 'fist', 'v3']) }[act]; if (one) return one;
      if (act === 'fo') return 'fo';
      if (spd < 1.6) return act === 'def' || act === 'reach' ? 'defend' : 'cIdle';
      if (fwd < -0.5) return 'cBack'; if (Math.abs(lat) > 0.75) return lat > 0 ? 'cLeft' : 'cRight';
      return spd > 19 ? 'aimRun' : 'cradle';
    }
    const one = { shot: pick(p, 'k', ['kick', 'kick', 'kick2']), pass: 'pass', head: 'header', bike: 'bike', check: pick(p, 't', ['tackle', 'tackle2']), cheer: pick(p, 'c', ['cheer', 'fist', 'v3', 'clap']) }[act]; if (one) return one;
    if (spd < 1.6) return act === 'def' || act === 'reach' ? 'defend' : 'sidle';
    if (fwd < -0.5) return 'back'; if (Math.abs(lat) > 0.75) return lat > 0 ? 'left' : 'right';
    return spd < 9 ? 'jog' : spd < 17 ? 'run' : 'sprint';
  };
  // locomotion clips advance at the speed their planted foot sweeps the floor (measured from the capture), so feet don't skate
  const LOCO = new Set(['jog', 'run', 'sprint', 'back', 'left', 'right', 'cradle', 'aimRun', 'cBack', 'cLeft', 'cRight', 'gkSide']);
  const natOf = (p, key) => { const m = clipMeta(key); return m && LOCO.has(key) ? m.nat * 3.15 * p.hf : 0; };
  const ONE = new Set(['lShot', 'lPass', 'xcheck', 'scoop', 'kick', 'kick2', 'pass', 'header', 'bike', 'tackle', 'tackle2', 'gkBlock', 'gkDive', 'gkDive2', 'gkCatch', 'gkCatch2', 'gkScoop', 'gkMiss', 'gkThrow', 'cheer', 'fist', 'v2', 'v3', 'v4', 'excited', 'happyJump', 'clap', 'pointUp', 'guns', 'kneelPt', 'defeat', 'disap', 'hitF', 'hitB', 'sweep', 'shFall', 'stumble']);
  const SYNC = { kick: 'footR', kick2: 'footR', lShot: 'handR', header: 'head' };   // contact moment lines up with the ball release
  const DIVES = new Set(['gkDive', 'gkDive2']);
  function animate(p, act, spd, fwd, lat, dt, actF) {
    if (p.ovr && p.ovr.until < p.clock) p.ovr = null;
    let key = clipKey(p, act, spd, fwd, lat);
    if (!p.ovr && p.oneShot && p.oneShot.isRunning() && act === p.lastAct) key = p.baseKey;
    const mir = DIVES.has(key) ? !!p.diveMirror : false; const fullKey = key + (mir ? '~m' : '');
    if (fullKey !== p.curKey) {
      const clip = getClip(p.A, key, mir, DIVES.has(key)) || getClip(p.A, 'idle'); const a = p.mixer.clipAction(clip);
      a.enabled = true; a.setEffectiveWeight(1); a.reset();
      const prevLoco = p.cur && LOCO.has(p.curKey) && LOCO.has(key) ? (p.cur.time / p.cur.getClip().duration) % 1 : null;
      if (ONE.has(key)) {
        a.setLoop(T.LoopOnce, 1); a.clampWhenFinished = true; p.oneShot = a;
        const m = clipMeta(key);
        if (key === 'bike') a.time = 0.6; else if (key === 'pass' || key === 'lPass') a.time = Math.max(0, (m ? m[key === 'pass' ? 'footR' : 'handR'][0] : 0.4) - 0.35); else if (p.ovr && p.ovr.t0) a.time = p.ovr.t0;
      } else { a.setLoop(T.LoopRepeat); p.oneShot = null; a.time = (prevLoco != null ? prevLoco : (hashS(p.id) % 100) / 100) * clip.duration; }
      a.play(); if (p.cur) p.cur.crossFadeTo(a, ONE.has(key) ? 0.12 : 0.22, false); p.cur = a; p.curKey = fullKey; p.baseKey = key;
    }
    p.lastAct = act;
    const nat = natOf(p, key);
    if (p.cur && SYNC[key] && (act === 'wind' || (actF != null && isFinite(actF) && (act === 'shot' || act === 'head')))) {   // scrub so foot/stick/head meets the ball exactly at release
      const m = clipMeta(key); const ct = m[SYNC[key]][0]; const f = act === 'wind' ? 0 : Math.max(0, Math.min(1, actF)); p.cur.paused = false; p.cur.setEffectiveTimeScale(0); p.cur.time = Math.max(0, Math.min(p.cur.getClip().duration, ct - (1 - f) * 0.75));
    } else if (p.cur && nat) p.cur.setEffectiveTimeScale(Math.max(0.5, Math.min(1.7, spd / nat)));
    else if (p.cur) p.cur.setEffectiveTimeScale(key === 'bike' ? 1.25 : 1);
    p.mixer.update(dt);
  }
  // head and neck turn toward the ball (clamped, eased), layered over the capture
  const _v1 = new T.Vector3(), _v2 = new T.Vector3(), _q1 = new T.Quaternion(), _q2 = new T.Quaternion(), _q3 = new T.Quaternion(), _I = new T.Quaternion();
  const applyWorldRot = (b, dq) => { b.parent.getWorldQuaternion(_q2); b.getWorldQuaternion(_q3); b.quaternion.copy(_q2.invert().multiply(_q1.copy(dq).multiply(_q3))); b.updateMatrixWorld(true); };
  function lookAtBall(p, target, want, dt) {
    p.lookW += (want - p.lookW) * Math.min(1, dt * 6); if (p.lookW < 0.02 || !target || !p.neck) return;
    p.head.getWorldPosition(_v1); _v2.copy(target).sub(_v1); if (_v2.lengthSq() < 0.5) return; _v2.normalize();
    const fwd = p.headFwd.clone().applyQuaternion(p.head.getWorldQuaternion(_q3)); const q = new T.Quaternion().setFromUnitVectors(fwd, _v2);
    const ang = 2 * Math.acos(Math.min(1, Math.abs(q.w))); const f = Math.min(1, 1.15 / Math.max(ang, 1e-4)) * p.lookW;
    const part = s => _I.clone().slerp(q, f * s);
    applyWorldRot(p.neck, part(0.4)); applyWorldRot(p.head, part(0.6));
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
      replay.goals = replay.goals || []; replay.hlIdx = replay.hlIdx || 0;
      if (!rep && st.flash && st.flash !== replay.lastFlash && !st.quiet) { replay.lastFlash = st.flash; const at = now + 4300; replay.active = rep = { det: now, start: at, end: at + 8400, frames: null, two: true }; }
      if (!rep && st.ended && replay.hlIdx < replay.goals.length) { const g = replay.goals[replay.hlIdx++]; replay.active = rep = { start: now + (replay.hlIdx === 1 ? 1500 : 500), end: 0, frames: g.frames, hl: true, n: replay.hlIdx, alt: replay.hlIdx % 2 }; rep.end = rep.start + 4600; }
      if (rep && now >= rep.start && !rep.frames) { const fr = replay.buf.filter(f => f.now >= rep.det - 3600 && f.now <= rep.det + 400); rep.frames = fr.length > 10 ? fr : null; if (!rep.frames) replay.active = rep = null; else replay.goals.push({ frames: rep.frames }); }
      let phase = 0;
      if (rep && rep.frames && now >= rep.start) {
        if (now > rep.end) { replay.active = rep = null; for (const p of players.values()) { p.curKey = ''; } }
        else { const f = (now - rep.start) / (rep.end - rep.start); let fi;
          if (rep.two) { phase = f < 0.5 ? 0 : 1; fi = phase === 0 ? f / 0.5 : 0.35 + 0.65 * (f - 0.5) / 0.5; if (phase !== rep.lastPhase) { rep.lastPhase = phase; for (const p of players.values()) p.curKey = ''; } }
          else { phase = rep.alt ? 1 : 0; fi = rep.alt ? 0.3 + 0.7 * f : f; }
          frame = rep.frames[Math.min(rep.frames.length - 1, Math.floor(fi * rep.frames.length))]; }
      }
      const inReplay = !!(rep && rep.frames && now >= rep.start);
      if (!inReplay && !st.ended) { replay.buf.push(st); while (replay.buf.length && replay.buf[0].now < now - 7000) replay.buf.shift(); }
      const dt = inReplay ? (frame._dt || 0.016) * 0.5 : (st.dtG > 0 ? st.dtG : Math.min(0.05, st.dtR || 0.016));
      // players
      const live = new Set();
      for (const q of frame.players) { live.add(q.id); let p = players.get(q.id); if (!p) p = makePlayer(q.id, st.info(q.id)); p.clock = now; p.root.visible = true; p.root.position.copy(V(q.x, q.y, 0)); p.root.rotation.set(0, Math.atan2(Math.cos(q.face), -Math.sin(q.face)), 0); }
      const durMs = k => { const m = clipMeta(k); return m ? m.dur * 1000 : 1500; };
      const setOvr = (p, key, maxSpd, delay) => { p.ovr = { key, until: now + (delay || 0) + durMs(key) - 120, maxSpd: maxSpd == null ? 4.5 : maxSpd, from: now + (delay || 0) }; };
      // goal: scorer's signature celebration, teammates react, the beaten side drops its heads
      if (!inReplay && st.flash && st.flash !== replay.celeb && st.flash.p != null && players.get(st.flash.p)) {
        replay.celeb = st.flash; const sc = players.get(st.flash.p); const sSide = sc.info.side; const sPos = sc.root.position;
        setOvr(sc, pick(sc, 'cel', lax ? ['v2', 'v3', 'v4', 'excited', 'happyJump', 'guns', 'pointUp'] : ['v2', 'v3', 'v4', 'excited', 'happyJump', 'guns', 'pointUp', 'kneelPt']), 6);
        for (const q of frame.players) { const p = players.get(q.id); if (!p || p === sc) continue; const r = hashS(p.id + ':' + now) % 100;
          if (p.info.side === sSide) { if (!p.info.gk && p.root.position.distanceTo(sPos) < 45) setOvr(p, pick(p, 'tm' + now, ['cheer', 'fist', 'clap', 'happyJump', 'pointUp']), 6, (r % 5) * 90); }
          else if (p.info.gk) setOvr(p, 'gkMiss', 3, 150); else if (r < 45) setOvr(p, 'disap', 3, r * 8); else if (r < 70) setOvr(p, 'defeat', 3, r * 6); }
      }
      for (const q of frame.players) {
        const p = players.get(q.id); const frozen = !inReplay && !st.dtG;
        const spd = frozen ? 0 : Math.hypot(q.vx, q.vy); const cf = Math.cos(q.face), sf = Math.sin(q.face); const fwd = spd > 0.5 ? (q.vx * cf + q.vy * sf) / spd : 1; const lat = spd > 0.5 ? (-q.vx * sf + q.vy * cf) / spd : 0;
        if (p.ovr && (inReplay || spd > p.ovr.maxSpd || now < p.ovr.from)) { if (inReplay || spd > p.ovr.maxSpd) p.ovr = null; }
        if (q.act === 'save' && p.lastAct !== 'save') {
          const b = frame.ball; const dy = b ? Math.abs(b[1] - q.y) : 0; const bz = b ? b[2] : 2;
          p.saveKey = dy > 2.6 ? pick(p, 'dv' + now, ['gkDive', 'gkDive2']) : bz > 3.5 ? pick(p, 'ct' + now, ['gkCatch', 'gkCatch2']) : bz < 1 && !lax ? 'gkScoop' : 'gkBlock';
          if (DIVES.has(p.saveKey) && b) { const left = new T.Vector3(p.A.leftSign, 0, 0).applyQuaternion(p.root.quaternion); const ballLeft = V(b[0], b[1], 0).sub(p.root.position).dot(left) > 0; const c = getClip(p.A, p.saveKey, false, true); const clipLeft = c && c.userData.srcDx * p.A.leftSign > 0; p.diveMirror = ballLeft !== clipLeft; }
        }
        // body contact: the player being checked or tackled reacts
        if (!inReplay && (q.act === 'check' || q.act === 'xcheck') && p.lastAct !== q.act) {
          let best = null, bd = 5.5; for (const o of frame.players) { const op = players.get(o.id); if (!op || op.info.side === p.info.side || op.info.gk) continue; const dd = Math.hypot(o.x - q.x, o.y - q.y); if (dd < bd) { bd = dd; best = op; } }
          if (best) { const r = hashS(best.id + ':' + now) % 100; const behind = new T.Vector3(0, 0, 1).applyQuaternion(best.root.quaternion).dot(new T.Vector3().subVectors(p.root.position, best.root.position)) < 0;
            const key2 = lax ? (q.act === 'xcheck' ? (r < 25 ? 'shFall' : behind ? 'hitB' : 'hitF') : (r < 15 ? 'shFall' : behind ? 'hitB' : 'hitF')) : (r < 35 ? 'sweep' : behind ? 'hitB' : 'hitF');
            setOvr(best, key2, 99, lax ? 120 : 260); }
        }
        if (p.ovr && now < p.ovr.from) { const keep = p.ovr; p.ovr = null; animate(p, q.act, spd, fwd, lat, Math.min(0.1, dt), q.actF); p.ovr = keep; }
        else animate(p, q.act, spd, fwd, lat, Math.min(0.1, dt), q.actF);
      }
      for (const [id, p] of players) if (!live.has(id)) { p.root.visible = false; if (p.stick) p.stick.visible = false; }
      scene.updateMatrixWorld(true);
      { const tgt = ball.visible ? ball.position : null; const dtl = Math.min(0.1, dt || 0.016);
        for (const q of frame.players) { const p = players.get(q.id); if (!p) continue; const busy = p.ovr || (p.oneShot && p.oneShot.isRunning()) || p.baseKey === 'fo'; lookAtBall(p, tgt, busy ? 0 : (p.info.gk ? 0.9 : 0.75), dtl); } }
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
      { const goalOn = st.flash && now > st.flash.from && now < st.flash.until && !inReplay; const sp = goalOn && st.flash.p != null && players.get(st.flash.p);
        if (goalOn && sp && sp.info.team && replay.ribFor !== st.flash) { replay.ribFor = st.flash; if (replay.ribT) replay.ribT.dispose(); replay.ribT = ribGoal(sp.info.team); }
        const want = goalOn && replay.ribT ? replay.ribT : ribTex; if (rib.material.map !== want) { rib.material.map = want; rib.material.needsUpdate = true; }
        want.offset.x = (now / 1000) * (want === ribTex ? 0.012 : 0.09) % 1; rib.material.color.set(goalOn && Math.floor(now / 250) % 2 ? '#ffffff' : '#c8c8c8'); }
      // camera
      const dtR = Math.min(0.1, st.dtR || 0.016); let eye, ctr, fov = 23;
      if (inReplay) { const gx = frame.attR ? o.goalX[1] : o.goalX[0]; const d = gx > 100 ? 1 : -1; const f = (now - rep.start) / (rep.end - rep.start); const pf = rep.two ? (phase === 0 ? f / 0.5 : (f - 0.5) / 0.5) : f;
        if (phase === 0) { eye = V(gx + d * (lax ? 7 : 3), 42.5 + 16 - pf * 32, 12.5); ctr = V(gx - d * 24, 42.5 + 4 - pf * 8, 2.5); fov = 44; }
        else { const b = bp || [gx - d * 20, 42.5, 1]; const rc = replay.rc || (replay.rc = { x: b[0], y: b[1] }); if (pf < 0.02) { rc.x = b[0]; rc.y = b[1]; } rc.x += (b[0] - rc.x) * Math.min(1, dtR * 3); rc.y += (b[1] - rc.y) * Math.min(1, dtR * 3);
          eye = V(rc.x - d * 9, 82, 6.5); ctr = V(rc.x + d * 2, rc.y, 2.6); fov = 27; } }
      else if (st.intro && !replay.introDone) { if (!replay.introStart) replay.introStart = now; const f = Math.min(1, (now - replay.introStart) / 5200); if (f >= 1) replay.introDone = true; const e2 = f * f * (3 - 2 * f); const a = -1.15 + e2 * 1.0; eye = V(100 + Math.sin(a) * 150, 42.5 - Math.cos(a) * 150, 75 - e2 * 45); ctr = V(100, 42.5, 2); fov = 34 - e2 * 8; }
      else {
        const xs = frame.players.filter(q => !q.gk).map(q => q.x); const cx = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 100;
        let want = (bp ? bp[0] * 0.6 : 60) + cx * 0.4; want = Math.max(lax ? 40 : 30, Math.min(lax ? 160 : 170, want));
        if (Math.abs(want - cam.x) > 45) { cam.x = want; cam.v = 0; }
        const w0 = 2.1; const err = want - cam.x; const dz = Math.abs(err) < 5 ? err * 0.3 : err; cam.v += (w0 * w0 * dz - 2 * w0 * cam.v) * dtR; cam.x += cam.v * dtR;
        cam.zoom += ((Math.abs(cam.v) > 14 ? 1 : 0) - cam.zoom) * Math.min(1, dtR * 1.2);
        const hand = Math.sin(now / 1900) * 0.25 + Math.sin(now / 1270) * 0.15;
        const scP = st.flash && st.flash.p != null && players.get(st.flash.p); const celebOn = scP && rep && now > st.flash.from + 1100 && now < rep.start;
        const foP = frame.players.filter(q => q.act === 'fo' && Math.hypot(q.x - 100, q.y - 42.5) < 14); if (foP.length && !replay.foOn) { replay.foOn = now; } if (!foP.length) replay.foOn = 0;
        if (replay.foOn && foP.length >= 2 && now - replay.foOn < 2300 && !celebOn) { eye = V(100 + hand, 42.5 - 30, 11); ctr = V(100, 42.5, 2.4); fov = 26; }
        else if (celebOn) { const sp = toRink(scP.root.position); const side = sp[1] > 42.5 ? -1 : 1; const ft = Math.min(1, (now - st.flash.from - 1100) / 2600); eye = V(sp[0] + (sp[0] > 100 ? -11 : 11) * (1 - ft * 0.25), sp[1] + side * 13, 6.2 - ft * 0.8); ctr = V(sp[0], sp[1], 3.6); fov = 30; }
        else if (st.flash && now > st.flash.from - 500 && now < st.flash.from + 1400 && bp) { eye = V(cam.x - cam.v * 0.1 + hand, -30, 18); ctr = V(bp[0], bp[1], 3); fov = 15; }
        else { eye = V(cam.x - cam.v * 0.1 + hand, -40 - cam.zoom * 8, 22 + cam.zoom * 4); ctr = V(cam.x + cam.v * 0.22, 46, 3 + hand * 0.3); }
      }
      if (view.camOv) { const c = typeof view.camOv === 'function' ? view.camOv(frame, players) : view.camOv; if (c) { eye = V(...c.eye); ctr = V(...c.ctr); fov = c.fov || fov; } }
      camera.position.copy(eye); camera.lookAt(ctr); if (camera.fov !== fov) { camera.fov = fov; camera.updateProjectionMatrix(); }
      { let nb = 0; for (const q of frame.players) { const p = players.get(q.id); if (!p || !p.root.visible || nb >= 47) continue; const hp = p.bone('Hips').getWorldPosition(_bp); const air = Math.max(0, hp.y - 3.2 * p.hf); const sz = 2.7 * p.hf * (1 + air * 0.08); _bs.set(sz, 1, sz * 0.8); _bm.compose(_bp.set(hp.x, 0.03, hp.z), _bq.setFromAxisAngle(new T.Vector3(0, 1, 0), p.root.rotation.y), _bs); blobs.setMatrixAt(nb++, _bm); }
        if (ball.visible) { const bz = ball.position.y; const sz = Math.max(0.5, 1.1 - bz * 0.04); _bs.set(sz, 1, sz); _bm.compose(_bp.set(ball.position.x, 0.03, ball.position.z), _bq.identity(), _bs); blobs.setMatrixAt(nb++, _bm); }
        blobs.count = nb; blobs.instanceMatrix.needsUpdate = true; }
      if (dof) { dof.enabled = QL.dof && inReplay; if (dof.enabled) { const fp = ball.visible ? ball.position : ctr; dof.uniforms.focus.value = camera.position.distanceTo(fp); } }
      key.shadow.camera.updateProjectionMatrix();
      composer.render(dtR);
      perf.t += dtR * 1000; if (++perf.n === 120) { if (!view.noAuto && perf.t / perf.n > 36) { QL.dof = false; QL.shafts = false; shafts.visible = false; } perf.n = 0; perf.t = 0; }
      const introHold = st.intro && !replay.introDone ? (replay.introStart || now) + 5300 : 0;
      return { replay: inReplay && !rep.hl, highlight: inReplay && rep.hl ? rep.n : 0, highlights: replay.goals.length, replayFrom: rep && rep.start, pauseUntil: Math.max(rep && !rep.hl ? rep.end : 0, introHold) };
    },
    dispose() { renderer.dispose(); composer.dispose && composer.dispose(); rt.dispose(); }
  };
  return view;
}
