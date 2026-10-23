// SCRAM switch in 3D: a glass flip cover over a missile toggle, with NORMAL and FANS FULL lamps.
// Lift the cover, flip the switch up = SCRAM. Closing the cover knocks the switch back off and
// returns the fans to the mode they were in. The cover shuts itself after 8 s if nothing is flipped.
// Talks to app.js through window.ReactorScram; app.js calls window.Scram3D.sync() on every update.
// The camera never moves; only the cover, the switch and the lamps do. Renders only while something moves.
import * as THREE from './vendor/three.module.min.js';

const bridge = window.ReactorScram;
const wrap = document.getElementById('scram3d');
const canvas = wrap?.querySelector('canvas');
const note = document.getElementById('scramNote');
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const TAU = Math.PI * 2;

/* ---------- sound: short synthesised mechanical clicks, only when the app's sound is on ---------- */
let ac;
function noise(freq, dur, gain) {
  if (!bridge?.soundOn()) return;
  try {
    ac ||= new AudioContext();
    const buf = ac.createBuffer(1, Math.ceil(ac.sampleRate * dur), ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 4);
    const src = ac.createBufferSource(); src.buffer = buf;
    const f = ac.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = 1.3;
    const g = ac.createGain(); g.gain.value = gain;
    src.connect(f).connect(g).connect(ac.destination); src.start();
  } catch { /* no audio is fine */ }
}
const sfx = {
  click: () => noise(2400, .03, .35),
  snap: () => { noise(1500, .05, .5); noise(4000, .02, .25); },
  clunk: () => noise(700, .08, .6),
};

/* ---------- tweens ---------- */
const easeInCubic = p => p * p * p;
const easeOutBack = p => { const c = 1.6; return 1 + (c + 1) * Math.pow(p - 1, 3) + c * Math.pow(p - 1, 2); };
const easeOutBounce = p => {
  const n = 7.5625, d = 2.75;
  if (p < 1 / d) return n * p * p;
  if (p < 2 / d) return n * (p -= 1.5 / d) * p + .75;
  if (p < 2.5 / d) return n * (p -= 2.25 / d) * p + .9375;
  return n * (p -= 2.625 / d) * p + .984375;
};
let tweens = [];
function tween(o, k, to, dur, ease, done) {
  tweens.forEach(t => { if (t.o === o && t.k === k) t.dead = true; });
  if (reduce) { o[k] = to; done?.(); invalidate(); return; }
  tweens.push({ o, k, from: o[k], to, dur, ease, t: 0, done });
  invalidate();
}
function runTweens(dt) {
  for (const t of tweens) {
    if (t.dead) continue;
    t.t += dt;
    const p = Math.min(1, t.t / t.dur);
    t.o[t.k] = t.from + (t.to - t.from) * t.ease(p);
    if (p >= 1) { t.dead = true; t.done?.(); }
  }
  tweens = tweens.filter(t => !t.dead);
}

/* ---------- textures ---------- */
function canvasTex(w, h, draw) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}
function grime(c, w, h, amount = 1) {
  for (let i = 0; i < 260 * amount; i++) {
    c.fillStyle = `rgba(20,18,12,${Math.random() * .08})`;
    c.beginPath(); c.arc(Math.random() * w, Math.random() * h, Math.random() * w * .02, 0, TAU); c.fill();
  }
  const g = c.createRadialGradient(w / 2, h / 2, Math.min(w, h) * .3, w / 2, h / 2, Math.max(w, h) * .75);
  g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, `rgba(25,20,10,${.35 * amount})`);
  c.fillStyle = g; c.fillRect(0, 0, w, h);
}
function stripes(c, w, h, band) {
  c.fillStyle = '#e3b33b'; c.fillRect(0, 0, w, h); c.fillStyle = '#1c1a15';
  for (let x = -h; x < w + h; x += band * 2) {
    c.beginPath(); c.moveTo(x, 0); c.lineTo(x + band, 0); c.lineTo(x + band - h, h); c.lineTo(x - h, h); c.closePath(); c.fill();
  }
}
function text(c, s, x, y, size, color) {
  c.font = `${size}px "Share Tech Mono", monospace`; c.fillStyle = color;
  c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(s, x, y);
}
function paintTex() {
  const t = canvasTex(512, 512, (c, w, h) => {
    c.fillStyle = '#3a403b'; c.fillRect(0, 0, w, h);
    for (let i = 0; i < 9000; i++) {
      c.fillStyle = Math.random() > .5 ? `rgba(200,205,190,${Math.random() * .05})` : `rgba(0,0,0,${Math.random() * .09})`;
      c.fillRect(Math.random() * w, Math.random() * h, 2, 2);
    }
    c.strokeStyle = 'rgba(190,195,175,.18)'; c.lineWidth = 1;
    for (let i = 0; i < 22; i++) {
      const x = Math.random() * w, y = Math.random() * h, a = Math.random() * TAU, l = 10 + Math.random() * 60;
      c.beginPath(); c.moveTo(x, y); c.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); c.stroke();
    }
    grime(c, w, h, .8);
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(.17, .38); t.offset.set(.5, .5);
  return t;
}
// A flat label lying on the panel; the canvas top faces away from the viewer.
function decal(tex, w, h) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({
    map: tex, transparent: true, roughness: .75, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2,
  }));
  m.rotation.x = -Math.PI / 2; m.receiveShadow = true;
  return m;
}

/* ---------- parts ---------- */
const chrome = () => new THREE.MeshStandardMaterial({ color: 0xd9dcd6, metalness: 1, roughness: .2 });
const steel = () => new THREE.MeshStandardMaterial({ color: 0x8d918a, metalness: .9, roughness: .42 });
function roundedRect(w, h, r) {
  const s = new THREE.Shape(), x = -w / 2, y = -h / 2;
  s.moveTo(x + r, y); s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r); s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h); s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
  return s;
}
const shadowed = (m) => { m.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } }); return m; };
function box(w, h, d, mat, x = 0, y = 0, z = 0) { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.position.set(x, y, z); return m; }
function cyl(rt, rb, h, mat, seg = 40) { return new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), mat); }

function makePlate(group, w, d) {
  const g = new THREE.ExtrudeGeometry(roundedRect(w, d, .2), { depth: .14, bevelEnabled: true, bevelSize: .04, bevelThickness: .04, bevelSegments: 4, curveSegments: 10 });
  g.rotateX(-Math.PI / 2);
  const p = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ map: paintTex(), roughness: .66, metalness: .35 }));
  p.position.y = -.18; p.receiveShadow = true; group.add(p);
  const sx = w / 2 - .22, sz = d / 2 - .22;
  for (const [x, z] of [[-sx, -sz], [sx, -sz], [-sx, sz], [sx, sz]]) {
    const s = cyl(.075, .085, .05, steel(), 24); s.position.set(x, .02, z);
    const slot = box(.13, .02, .02, new THREE.MeshStandardMaterial({ color: 0x161917 }), 0, .02, 0);
    slot.rotation.y = Math.random() * Math.PI; s.add(slot);
    group.add(shadowed(s));
  }
}
function makeLamp(color) {
  const g = new THREE.Group();
  const base = cyl(.26, .29, .1, chrome(), 40); base.position.y = .05; g.add(shadowed(base));
  const mat = new THREE.MeshPhysicalMaterial({ color, roughness: .18, clearcoat: 1, transmission: .25, emissive: color, emissiveIntensity: .05 });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(.2, 40, 20, 0, TAU, 0, Math.PI / 2), mat);
  dome.position.y = .1; g.add(dome);
  const light = new THREE.PointLight(color, 0, 2.2, 1.6); light.position.y = .35; g.add(light);
  return { group: g, set(on, t) { const v = on ? 2.2 + (reduce ? 0 : Math.sin(t * 6) * .6) : .05; mat.emissiveIntensity = v; light.intensity = on ? v * .9 : 0; } };
}
function envFor(renderer) {
  const s = new THREE.Scene();
  s.add(new THREE.Mesh(new THREE.BoxGeometry(12, 12, 12), new THREE.MeshBasicMaterial({ color: 0x23272a, side: THREE.BackSide })));
  const panel = (w, h, pos, rot, c) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: c, side: THREE.DoubleSide }));
    m.position.set(...pos); m.rotation.set(...rot); s.add(m);
  };
  panel(7, 1.4, [0, 5.8, 0], [Math.PI / 2, 0, 0], new THREE.Color(7, 6.6, 6));
  panel(2.5, 4, [-5.8, 2, 1], [0, Math.PI / 2, 0], new THREE.Color(3, 3.1, 2.8));
  panel(2, 3, [5.8, 1.5, -1], [0, -Math.PI / 2, 0], new THREE.Color(.8, 1.4, 1));
  panel(5, 1, [0, 1.5, 5.8], [0, Math.PI, 0], new THREE.Color(1.6, 1.5, 1.3));
  const pm = new THREE.PMREMGenerator(renderer);
  const tex = pm.fromScene(s, .04).texture; pm.dispose();
  return tex;
}

/* ---------- mount ---------- */
let renderer;
try { renderer = bridge && canvas ? new THREE.WebGLRenderer({ canvas, antialias: true }) : null; } catch { renderer = null; }
let invalidate = () => {};

if (renderer) {
  await Promise.race([document.fonts.load('60px "Share Tech Mono"'), new Promise(r => setTimeout(r, 2000))]);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.toneMapping = THREE.NeutralToneMapping; renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x171b18);
  scene.environment = envFor(renderer); scene.environmentIntensity = .75;
  const cam = new THREE.PerspectiveCamera(30, 1.6, .1, 60);
  const key = new THREE.DirectionalLight(0xfff0dc, 2.4);
  key.position.set(-3, 7, 4); key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024); key.shadow.radius = 5; key.shadow.bias = -.0004; key.shadow.normalBias = .02;
  Object.assign(key.shadow.camera, { left: -4, right: 4, top: 4, bottom: -4, near: 1, far: 20 });
  scene.add(key, new THREE.HemisphereLight(0xdfe8d8, 0x1a1c1a, .35));
  const root = new THREE.Group(); scene.add(root);
  makePlate(root, 5.6, 2.6);

  // hazard frame and the switch
  const frameTex = canvasTex(768, 896, (c, w, h) => { stripes(c, w, h, 46); grime(c, w, h, 1.1); c.clearRect(110, 110, w - 220, h - 220); });
  const frameDecal = decal(frameTex, 1.62, 1.9); frameDecal.position.set(0, .004, -.02); root.add(frameDecal);
  const nut = cyl(.34, .34, .14, chrome(), 6); nut.position.y = .07; root.add(shadowed(nut));
  const bush = cyl(.17, .17, .22, steel(), 32); bush.position.y = .25; root.add(shadowed(bush));
  const lever = new THREE.Group(); lever.position.y = .36; lever.rotation.x = .5; lever.userData.hit = 'lever';
  const bat = cyl(.05, .075, .6, chrome(), 24); bat.position.y = .3; lever.add(bat);
  const tip = new THREE.Mesh(new THREE.SphereGeometry(.07, 24, 12), chrome()); tip.position.y = .6; lever.add(tip);
  root.add(shadowed(lever));
  const onOff = decal(canvasTex(256, 512, (c) => { text(c, 'ON', 128, 80, 64, '#d8d2b8'); text(c, 'OFF', 128, 440, 64, '#d8d2b8'); }), .34, .68);
  onOff.position.set(.5, .006, 0); root.add(onOff);

  // lamps
  const green = makeLamp(0x3ee86a), red = makeLamp(0xff3322);
  green.group.position.set(-1.85, 0, -.15); red.group.position.set(1.85, 0, -.15); root.add(green.group, red.group);
  const tag = (s, col) => canvasTex(512, 128, (c) => text(c, s, 256, 64, 62, col));
  const gl = decal(tag('NORMAL', '#d8d2b8'), 1.4, .35); gl.position.set(-1.85, .004, .5); root.add(gl);
  const rl = decal(tag('FANS FULL', '#ffb4a6'), 1.4, .35); rl.position.set(1.85, .004, .5); root.add(rl);

  // hinged glass box: pivot on the back top edge, tall enough to clear the lever
  const W = 1.4, D = 1.5, H = 1.0;
  const pivot = new THREE.Group(); pivot.position.set(0, H + .02, -.76); pivot.userData.hit = 'cover';
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0xffe6cc, transmission: 1, roughness: .1, thickness: .3, ior: 1.5, clearcoat: 1,
    attenuationColor: 0xff8a4a, attenuationDistance: 1.6, specularIntensity: 1,
  });
  const edgeMat = new THREE.LineBasicMaterial({ color: 0xfff1de, transparent: true, opacity: .45 });
  for (const [w, h, d, x, y, z] of [[W, .05, D, 0, 0, D / 2], [.05, H, D, -W / 2 + .025, -H / 2, D / 2], [.05, H, D, W / 2 - .025, -H / 2, D / 2], [W, H, .05, 0, -H / 2, D - .025]]) {
    const m = box(w, h, d, glass, x, y, z); pivot.add(m);
    const e = new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry), edgeMat); e.position.copy(m.position); pivot.add(e);
  }
  const lift = decal(canvasTex(512, 256, (c) => text(c, 'LIFT TO ARM', 256, 128, 58, 'rgba(255,245,230,.75)')), .9, .45);
  lift.position.set(0, .03, D * .7); pivot.add(lift);
  root.add(pivot);
  const barrel = cyl(.065, .065, W + .06, chrome(), 24); barrel.rotation.z = Math.PI / 2; barrel.position.copy(pivot.position); root.add(shadowed(barrel));
  for (const x of [-.5, .5]) root.add(shadowed(box(.16, H + .02, .14, steel(), x, (H + .02) / 2, -.84)));
  const hits = [lever, pivot];

  /* ---------- behaviour ---------- */
  let open = false, on = false, interlock = false, timer = 0, quietUntil = 0;
  const say = () => {
    note.textContent = on ? 'Fans at full · close the cover to stop'
      : open ? `Cover up · flip the switch · shuts in ${Math.max(1, Math.ceil(timer))} s` : 'Cover closed · no action';
  };
  function setLever(v) { on = v; tween(lever.rotation, 'x', v ? -.5 : .5, .14, easeInCubic, () => sfx.snap()); say(); }
  function openCover() { open = true; timer = 8; sfx.snap(); tween(pivot.rotation, 'x', -2.8, .65, easeOutBack); say(); }
  function closeCover() {
    open = false; sfx.click();
    tween(pivot.rotation, 'x', 0, .5, easeOutBounce, () => sfx.clunk());
    say();
  }
  // user actions: these tell the app, then ignore the next couple of polls that may still carry the old mode
  function userFire() { setLever(true); quietUntil = performance.now() + 2500; bridge.fire(); }
  function userClose() {
    const wasOn = on;
    closeCover();
    if (wasOn) { setTimeout(() => setLever(false), reduce ? 0 : 160); quietUntil = performance.now() + 2500; bridge.release(); }
  }
  function act(hit) {
    if (hit === 'cover') return open ? userClose() : openCover();
    if (hit === 'lever' && open) return on ? userClose() : userFire();
  }

  window.Scram3D = {
    sync(s) {
      interlock = !!s.interlock;
      const scram = s.mode === 'scram';
      if (performance.now() >= quietUntil && scram !== on) {
        if (scram) { if (!open) openCover(); setLever(true); }
        else { setLever(false); if (open) closeCover(); }
      }
      invalidate();
    },
  };

  /* ---------- input ---------- */
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  function pick(e) {
    const r = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, cam);
    const hit = ray.intersectObjects(hits, true)[0];
    for (let o = hit?.object; o; o = o.parent) if (o.userData.hit) return o.userData.hit;
    return null;
  }
  canvas.addEventListener('pointermove', e => {
    const h = pick(e);
    canvas.style.cursor = h === 'cover' || (h === 'lever' && open) ? 'pointer' : 'default';
  });
  canvas.addEventListener('pointerdown', e => act(pick(e)));
  canvas.addEventListener('keydown', e => {
    if ((e.key !== ' ' && e.key !== 'Enter') || e.repeat) return;
    e.preventDefault();
    if (!open) openCover(); else if (!on) userFire(); else userClose();
  });

  /* ---------- render on demand ---------- */
  // One fixed view, framed so the cover still fits when it is flipped up.
  const look = new THREE.Vector3(0, .6, -.3);
  let raf = 0, last = 0, fit = 1, lastPulse = 0;
  invalidate = () => { if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); } };
  function frame(now) {
    raf = 0;
    const dt = Math.min(.05, (now - last) / 1000); last = now;
    runTweens(dt);
    if (open && !on) {
      const before = Math.ceil(timer); timer -= dt;
      if (timer <= 0) closeCover(); else if (Math.ceil(timer) !== before) say();
    }
    cam.position.setFromSphericalCoords(6.3 * fit, .74, 0).add(look);
    cam.lookAt(look);
    green.set(!on && !interlock, now / 1000); red.set(on || interlock, now / 1000);
    renderer.render(scene, cam);
    const moving = tweens.length || (open && !on);
    if (moving) invalidate();
    // the red lamp breathes while fans are at full: a few frames a second is plenty
    else if ((on || interlock) && !reduce) { clearTimeout(lastPulse); lastPulse = setTimeout(invalidate, 80); }
  }
  new ResizeObserver(() => {
    const w = canvas.clientWidth, h = canvas.clientHeight; if (!w || !h) return;
    renderer.setSize(w, h, false); cam.aspect = w / h; cam.updateProjectionMatrix();
    fit = cam.aspect < 2.2 ? 2.2 / cam.aspect : 1;
    invalidate();
  }).observe(canvas);

  wrap.hidden = false;
  document.getElementById('scramPanel').classList.add('has-3d');
  say();
  window.Scram3D.sync(bridge.current());
}
