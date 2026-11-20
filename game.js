import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/* ==========================================================================
   AI Hoops Lab: 5-on-5 basketball played by AI agents, coached by you.
   1) Simulation: pure JS, no drawing (can run headless with ?sim=N)
   2) 3D view: Three.js
   3) Coach UI
   Court units are meters. x runs along the court, z across it, y is up.
   ========================================================================== */

// ---------- court & rules (FIBA-sized court) ----------
const HALF_L = 14, HALF_W = 7.5, HX = 12.425, RIM_Y = 3.05, R3 = 6.75, CORNER_Z = 6.6;
const QLEN = 180;            // seconds per quarter (3 minutes)
const OT_LEN = 60;

// ---------- small math helpers ----------
const rand = Math.random;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const sub = (a, b) => ({ x: a.x - b.x, z: a.z - b.z });
const add = (a, b) => ({ x: a.x + b.x, z: a.z + b.z });
const mul = (a, s) => ({ x: a.x * s, z: a.z * s });
const len = a => Math.hypot(a.x, a.z);
const norm = a => { const l = len(a) || 1; return { x: a.x / l, z: a.z / l }; };
const randn = () => (rand() + rand() + rand() - 1.5) * 1.15;
function segDist(p, a, b) {
  const ab = sub(b, a), ap = sub(p, a), l2 = ab.x * ab.x + ab.z * ab.z || 1e-6;
  const t = clamp((ap.x * ab.x + ap.z * ab.z) / l2, 0, 1);
  return { d: dist(p, { x: a.x + ab.x * t, z: a.z + ab.z * t }), t };
}
const fmtClock = s => { s = Math.max(0, Math.ceil(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

// ---------- teams, roles, skills ----------
const ROLES = ['PG', 'SG', 'SF', 'PF', 'C'];
const ROLE_NAME = { PG: 'Point guard', SG: 'Shooting guard', SF: 'Small forward', PF: 'Power forward', C: 'Center' };
const ATTRS = [
  ['speed', 'Speed'], ['inside', 'Inside scoring'], ['three', '3-point shooting'], ['passing', 'Passing'],
  ['defense', 'Defense'], ['rebound', 'Rebounding'], ['iq', 'Basketball IQ'],
];
const ROLE_ATTR = {
  PG: { speed: .82, inside: .50, three: .62, passing: .86, defense: .55, rebound: .28, iq: .80 },
  SG: { speed: .76, inside: .55, three: .74, passing: .60, defense: .55, rebound: .35, iq: .66 },
  SF: { speed: .66, inside: .64, three: .58, passing: .55, defense: .64, rebound: .50, iq: .62 },
  PF: { speed: .56, inside: .70, three: .40, passing: .46, defense: .64, rebound: .70, iq: .56 },
  C:  { speed: .46, inside: .80, three: .18, passing: .40, defense: .70, rebound: .86, iq: .56 },
};
const HEIGHT = { PG: .94, SG: .97, SF: 1.0, PF: 1.04, C: 1.08 };
const TEAMDEF = [
  { name: 'Volts', color: 0x3d8bff, css: '#3d8bff', short: 'VOL', names: ['Ari', 'Bo', 'Cyd', 'Dax', 'Eno'], nums: [3, 11, 7, 21, 34] },
  { name: 'Embers', color: 0xff4d5e, css: '#ff4d5e', short: 'EMB', names: ['Fitz', 'Gio', 'Hux', 'Ivo', 'Jett'], nums: [1, 8, 23, 15, 44] },
];
const PRESETS = {
  balanced: { name: 'Balanced', pace: .5, three: .5, pass: .5, defense: 'man', pressure: .5 },
  run:      { name: 'Run & gun', pace: .92, three: .8, pass: .45, defense: 'man', pressure: .35 },
  grind:    { name: 'Inside grind', pace: .18, three: .12, pass: .5, defense: 'man', pressure: .8 },
  share:    { name: 'Pass-first', pace: .5, three: .55, pass: .92, defense: 'man', pressure: .5 },
  zone:     { name: 'Zone wall', pace: .35, three: .45, pass: .6, defense: 'zone', pressure: .4 },
};

// Offensive spots, as [distance out from the hoop, sideways], plus a label
const FORMATIONS = {
  fiveOut: [[7.6, 0, 'Spacing at the top'], [5.3, 5.4, 'Spacing on the wing'], [5.3, -5.4, 'Spacing on the wing'], [0.6, 6.6, 'Spacing in the corner'], [0.6, -6.6, 'Spacing in the corner']],
  fourOut: [[7.6, 0, 'Spacing at the top'], [5.3, 5.4, 'Spacing on the wing'], [0.6, -6.6, 'Spacing in the corner'], [5.3, -5.4, 'Spacing on the wing'], [1.7, 2.2, 'Posting up']],
  inside:  [[7.3, 1.4, 'Spacing at the top'], [5.4, 5.4, 'Spacing on the wing'], [0.8, -6.6, 'Spacing in the corner'], [2.0, -2.2, 'Posting up'], [1.6, 2.2, 'Posting up']],
};
const ZONE = [[5.4, 1.9], [5.4, -1.9], [2.0, 4.3], [2.0, -4.3], [1.2, 0]];

// ---------- game state ----------
const G = { teams: [], players: [], ball: null, offense: 0, phase: 'tip', shotClock: 24, clock: QLEN, quarter: 1,
  over: false, deadT: 0, breakT: 0, log: [], elapsed: 0, possessions: [0, 0], help: null, onEvent: null };

function makeTeams() {
  G.teams = []; G.players = [];
  TEAMDEF.forEach((d, id) => {
    const t = { id, ...d, dir: id === 0 ? 1 : -1, score: 0, strat: { ...PRESETS.balanced }, preset: 'balanced', players: [] };
    ROLES.forEach((r, i) => {
      const attr = {};
      for (const [k] of ATTRS) attr[k] = Math.round(clamp(ROLE_ATTR[r][k] + randn() * .06, .05, 1) * 100) / 100;
      const p = { id: id * 5 + i, team: t, role: r, idx: i, name: d.names[i], num: d.nums[i], attr, height: HEIGHT[r],
        pos: { x: 0, z: 0 }, vel: { x: 0, z: 0 }, face: { x: t.dir, z: 0 }, target: { x: 0, z: 0 }, speedMul: 1,
        goal: '', why: '', decideT: 0, catchT: 0, drive: 0, driveTo: null, offT: rand() * 2, offMode: 'spot', jit: { x: 0, z: 0 },
        cutTo: null, jump: 0, jumpT: 0, freeze: 0, opts: null, choice: null, phase: rand() * 6, stats: null };
      t.players.push(p); G.players.push(p);
    });
    G.teams.push(t);
  });
}
const other = t => G.teams[1 - t.id];
const attackHoop = t => ({ x: t.dir * HX, z: 0 });
const defendHoop = t => ({ x: -t.dir * HX, z: 0 });
const fromHoop = (t, a, b) => ({ x: t.dir * HX - t.dir * a, z: b });          // spot near the hoop t attacks
const fromDefHoop = (t, a, b) => ({ x: -t.dir * HX + t.dir * a, z: b });      // spot near the hoop t defends
const isThree = (pos, hoop) => Math.abs(pos.z) >= CORNER_Z || dist(pos, hoop) >= R3;
function formation(t) {
  const s = t.strat.three;
  const f = s > .62 ? FORMATIONS.fiveOut : s < .35 ? FORMATIONS.inside : FORMATIONS.fourOut;
  return f.map(([a, b, label]) => ({ pos: fromHoop(t, a, b), label }));
}

function newGame() {
  for (const t of G.teams) t.score = 0;
  for (const p of G.players) { p.stats = { pts: 0, fgm: 0, fga: 0, tpm: 0, tpa: 0, ast: 0, reb: 0, stl: 0, tov: 0 }; p.opts = null; p.drive = 0; p.jump = 0; p.freeze = 0; }
  G.ball = { state: 'loose', holder: null, pos: { x: 0, y: 2.4, z: 0 }, vel: { x: 0, y: 0, z: 0 }, from: null, to: null, t: 0, dur: 0, h: 0,
    target: null, passer: null, intercept: false, lastTouch: null, lastPass: null, noGrab: 0, made: false, shooter: null, pts: 0, info: null, reboundable: false };
  Object.assign(G, { possT: 0, offense: 0, shotClock: 24, clock: QLEN, quarter: 1, over: false, deadT: 0, breakT: 0, log: [], elapsed: 0, possessions: [0, 0] });
  setupTip();
  emit('new');
}
function setupTip() {
  G.phase = 'tip';
  for (const t of G.teams) {
    const s = -t.dir;
    const spots = { PG: [4.6, -4.2], SG: [4.6, 4.2], SF: [2.4, -2.8], PF: [2.4, 2.8], C: [.55, 0] };
    for (const p of t.players) { const [a, b] = spots[p.role]; p.pos = { x: s * a, z: b * t.dir }; p.vel = { x: 0, z: 0 }; p.target = { ...p.pos }; }
  }
  const b = G.ball;
  Object.assign(b, { state: 'loose', holder: null, pos: { x: 0, y: 2.3, z: 0 }, vel: { x: (rand() - .5) * .5, y: 5.4, z: (rand() - .5) * .5 }, noGrab: .6, reboundable: false, lastTouch: null });
}

function log(txt, team, big) {
  G.log.unshift({ txt, team: team ? team.id : -1, q: G.quarter, t: fmtClock(G.clock), big: !!big });
  if (G.log.length > 60) G.log.pop();
  emit('log');
}
function emit(type, data) { if (G.onEvent) G.onEvent(type, data); }

// ---------- shot & pass evaluation (the "thinking") ----------
function shotInfo(p, pos) {
  const t = p.team, hoop = attackHoop(t), d = dist(pos, hoop), three = isThree(pos, hoop), pts = three ? 3 : 2;
  let base;
  if (d < 1.3) base = .7;
  else if (d < 3) base = lerp(.7, .48, (d - 1.3) / 1.7);
  else if (!three) base = lerp(.48, .42, clamp((d - 3) / 3.75, 0, 1));
  else base = Math.max(.03, .36 - Math.max(0, d - 7.2) * .06);
  const skill = d < 3 ? p.attr.inside : three ? p.attr.three : (p.attr.inside + p.attr.three) / 2;
  let prob = base * (.55 + .9 * skill);
  let c = 99, cd = null;
  for (const q of other(t).players) { const dd = dist(q.pos, pos); if (dd < c) { c = dd; cd = q; } }
  let f = c < .7 ? .58 : c < 1.5 ? lerp(.58, .9, (c - .7) / .8) : c < 2.5 ? lerp(.9, 1, c - 1.5) : 1;
  if (cd) f = 1 - (1 - f) * (.6 + .8 * cd.attr.defense);
  prob = clamp(prob * f, .02, .92);
  return { prob, pts, d, c, three, defender: cd };
}
function laneRisk(p, mate) {
  const d = dist(p.pos, mate.pos); let r = 0;
  for (const q of other(p.team).players) {
    const s = segDist(q.pos, p.pos, mate.pos);
    if (s.d < 1.3 && s.t > .05) r += (1.3 - s.d) / 1.3 * (.3 + .45 * q.attr.defense) * (.7 + d / 20);
  }
  r *= 1.25 - .5 * p.attr.passing;
  if (d > 14) r += .15;
  return clamp(r, 0, .95);
}
const threeMult = S => .7 + .6 * S.three;
const twoMult = S => 1.15 - .3 * S.three;

function evaluate(p) {
  const t = p.team, S = t.strat, opts = [], tr = G.phase === 'transition';
  const lateness = 1 - G.shotClock / 24;
  let hold = 1.05 - S.pace * .3 - lateness * .85 + (tr && S.pace < .55 ? .45 : 0);
  if (G.possT < 8 - 6 * S.pace) hold += .3;                                         // run the offense before settling for a shot
  opts.push({ type: 'hold', u: hold, label: tr ? 'Bring it up & set up' : 'Hold & reset' });

  const si = shotInfo(p, p.pos);
  let su = si.prob * si.pts * (si.pts === 3 ? threeMult(S) : twoMult(S));
  if (G.shotClock < 3) su += .8;
  opts.push({ type: 'shoot', u: su, label: `Shoot a ${si.pts} · ${Math.round(si.prob * 100)}% chance`, info: si });

  const lp = G.ball.lastPass;
  for (const m of t.players) {
    if (m === p) continue;
    const mi = shotInfo(m, m.pos), risk = laneRisk(p, m);
    let u = (mi.prob * mi.pts * (mi.pts === 3 ? threeMult(S) : twoMult(S)) * .9 + (S.pass - .5) * .35 + (p.attr.passing - .5) * .15) * (1 - risk) - risk * .8;
    if (tr && m.role === 'PG' && p.role !== 'PG') u += .35;                          // outlet to the point guard
    if (lp && lp.passer === m && G.elapsed - lp.time < 1.5) u -= .25;               // don't just pass it straight back
    if (G.shotClock < 2) u -= .5;
    opts.push({ type: 'pass', u, mate: m, risk, label: `Pass to ${m.name} (${m.role}) · ${Math.round(risk * 100)}% risky`, info: mi });
  }

  const hoop = attackHoop(t), d = dist(p.pos, hoop);
  if (d > 1.6) {
    const to = add(p.pos, mul(norm(sub(hoop, p.pos)), Math.min(3.2, d - .9)));
    let block = 0;
    for (const q of other(t).players) { const s = segDist(q.pos, p.pos, to); if (s.d < 1.2) block += (1.2 - s.d) / 1.2 * (.4 + .6 * q.attr.defense); }
    block = Math.min(.95, block);
    const di = shotInfo(p, to);
    const u = di.prob * di.pts * .92 * (1 - block) * (.75 + .5 * p.attr.speed) * twoMult(S);
    opts.push({ type: 'drive', u, to, block, label: `Drive to the rim · lane ${Math.round((1 - block) * 100)}% open`, info: di });
  }
  const noise = (1 - p.attr.iq) * .35;
  for (const o of opts) o.score = o.u + randn() * noise;
  return opts;
}

// ---------- actions ----------
function handPos(p) {
  const jy = jumpY(p), f = p.face;
  const holding = G.ball.holder === p;
  let y;
  if (p.jump > 0 && G.ball.shooter === p && G.ball.state === 'held') y = 2.3 * p.height + jy;
  else if (holding && p.catchT <= 0) y = .18 + Math.abs(Math.sin(G.elapsed * 8.5 + p.id)) * .85 * p.height;   // dribbling
  else y = 1.3 * p.height + jy;
  return { x: p.pos.x + f.x * .34 + f.z * .12, y, z: p.pos.z + f.z * .34 - f.x * .12 };
}
const jumpY = p => p.jump > 0 ? Math.sin(Math.PI * clamp(p.jumpT / p.jump, 0, 1)) * .5 : 0;

function doShot(p, info) {
  const b = G.ball, t = p.team, hoop = attackHoop(t), made = rand() < info.prob;
  const from = handPos(p); from.y = 2.25 * p.height;
  const to = { x: hoop.x, y: RIM_Y + .05, z: hoop.z };
  if (!made) { const a = rand() * Math.PI * 2; to.x += Math.cos(a) * .24; to.z += Math.sin(a) * .24; }
  Object.assign(b, { state: 'shot', holder: null, from, to, t: 0, dur: .55 + info.d * .055, h: .9 + info.d * .16, made, shooter: p, pts: info.pts, info, lastTouch: t });
  p.stats.fga++; if (info.pts === 3) p.stats.tpa++;
  p.jump = .55; p.jumpT = 0; p.freeze = .65;
  emit('shot', p);
}
function doPass(p, mate, risk) {
  const b = G.ball, d = dist(p.pos, mate.pos), dur = .16 + d / 14;
  const lead = add(mate.pos, mul(mate.vel, dur * .8));
  let to = { x: lead.x, y: 1.3 * mate.height, z: lead.z }, target = mate, intercept = false, tf = 1;
  if (rand() < risk * .55) {
    let best = null, bd = 9, bt = 1;
    for (const q of other(p.team).players) { const s = segDist(q.pos, p.pos, lead); if (s.d < bd) { bd = s.d; best = q; bt = s.t; } }
    if (best && bd < 2) { target = best; intercept = true; tf = Math.max(.25, bt); const q = add(p.pos, mul(sub(lead, p.pos), tf)); to = { x: q.x, y: 1.25, z: q.z }; }
  }
  Object.assign(b, { state: 'pass', holder: null, from: handPos(p), to, t: 0, dur: dur * tf, h: .2 + d * .03, target, intercept, passer: p, lastTouch: p.team });
}
function gain(p, how) {
  const b = G.ball, prevOff = G.offense, t = p.team;
  Object.assign(b, { state: 'held', holder: p, lastTouch: t, reboundable: false, shooter: null });
  p.catchT = how === 'pass' ? .32 : .5; p.decideT = 0; p.drive = 0; p.opts = null;
  if (how === 'tip') { log(`${p.name} wins the tip for the ${t.name}`, t); }
  if (how === 'rebound') {
    p.stats.reb++;
    if (t.id === prevOff) { G.shotClock = 14; log(`${p.name} grabs the offensive rebound`, t); }
    else log(`${p.name} pulls down the rebound`, t);
  }
  if (t.id !== prevOff || how === 'tip') { G.offense = t.id; G.phase = 'transition'; G.shotClock = 24; G.possT = 0; G.possessions[t.id]++; b.lastPass = null; }
  if (how === 'pass') b.lastPass = { passer: b.passer, recv: p, time: G.elapsed };
}
function giveInbound(t, spot) {
  let best = null, bd = 1e9;
  for (const p of t.players) { const d = dist(p.pos, spot); if (d < bd) { bd = d; best = p; } }
  const b = G.ball;
  Object.assign(b, { state: 'held', holder: best, lastTouch: t, lastPass: null, reboundable: false, shooter: null });
  best.catchT = .6; best.decideT = 0; best.drive = 0; best.opts = null;
  G.offense = t.id; G.phase = 'transition'; G.shotClock = 24; G.possT = 0; G.possessions[t.id]++;
}
function turnover(p, why) {
  p.stats.tov++;
  log(why, p.team);
  const o = other(p.team);
  giveInbound(o, p.pos);
}

// ---------- the agents ----------
function handlerAI(p, dt) {
  const t = p.team, S = t.strat, f = formation(t);
  p.catchT -= dt; p.decideT -= dt;
  if (G.phase === 'transition' && t.dir * p.pos.x > 2.5) G.phase = 'halfcourt';
  if (p.drive > 0) {
    p.drive -= dt; p.target = p.driveTo; p.speedMul = 1; p.goal = 'Driving to the basket'; p.why = 'The lane looked open.';
  } else {
    const spot = f[p.idx].pos;
    if (G.phase === 'transition') { p.target = spot; p.speedMul = .72 + .28 * S.pace; p.goal = 'Bringing the ball up the court'; p.why = S.pace > .6 ? 'Game plan: push the pace.' : 'Game plan: walk it up and set up the offense.'; }
    else { p.target = add(spot, { x: Math.sin(G.elapsed * .9 + p.id) * .8, z: Math.cos(G.elapsed * .7 + p.id) * 1.2 }); p.speedMul = .5; p.goal = 'Reading the defense'; p.why = 'Dribbling and looking for the best option.'; }
  }
  if (p.catchT > 0 || p.decideT > 0 || p.freeze > 0) return;
  const opts = evaluate(p);
  let pick = opts[0];
  for (const o of opts) if (o.score > pick.score) pick = o;
  p.opts = opts.slice().sort((a, b) => b.u - a.u); p.choice = pick;
  p.decideT = .32;
  if (pick.type === 'shoot') { doShot(p, pick.info); p.goal = 'Shooting!'; }
  else if (pick.type === 'pass') { doPass(p, pick.mate, pick.risk); p.goal = `Passing to ${pick.mate.name}`; }
  else if (pick.type === 'drive') { p.drive = .9; p.driveTo = pick.to; }
}
function offBallAI(p, dt) {
  const t = p.team, f = formation(t), spot = f[p.idx];
  if (G.phase !== 'halfcourt') {
    p.target = spot.pos; p.speedMul = .8 + .25 * t.strat.pace; p.goal = 'Running the floor'; p.why = spot.label === 'Posting up' ? 'Heading to the post, near the basket.' : `Heading to my spot ${spot.label.replace('Spacing ', '')}.`; return;
  }
  p.offT -= dt;
  const myDef = other(t).players[p.idx];
  if (p.offT <= 0) {
    const watching = myDef && dist(myDef.pos, p.pos) > 2.2;
    if (p.role !== 'C' && rand() < .18 + .4 * p.attr.iq * (watching ? 1 : .35)) {
      p.offMode = 'cut'; p.offT = 1.3; p.cutTo = fromHoop(t, 1.0, (spot.pos.z >= 0 ? 1 : -1) * 1.0);
      p.cutWhy = watching ? `${myDef.name} was watching the ball, so cut behind.` : 'Cutting to pull the defense.';
    } else { p.offMode = 'spot'; p.offT = 1.6 + rand() * 2.4; p.jit = { x: randn() * .6, z: randn() * .6 }; }
  }
  if (p.offMode === 'cut') { p.target = p.cutTo; p.speedMul = 1; p.goal = 'Cutting to the basket'; p.why = p.cutWhy; }
  else { p.target = add(spot.pos, p.jit); p.speedMul = .55; p.goal = spot.label; p.why = 'Spreading the floor so the ball handler has room.'; }
}
function manTarget(man, hoop, hasBall, pressure) {
  const bp = G.ball.pos, toHoop = norm(sub(hoop, man.pos));
  const gap = hasBall ? 1.3 - pressure * .7 : 1.3 + Math.min(dist(man.pos, bp), 14) * .1 * (1.25 - pressure * .7);
  let tg = add(man.pos, mul(toHoop, Math.min(gap, dist(man.pos, hoop) * .6)));
  if (!hasBall) tg = add(tg, mul(sub({ x: bp.x, z: bp.z }, tg), .12 * (1 - pressure * .5)));
  return tg;
}
function defenseAI(p, dt) {
  const t = p.team, off = other(t), hoop = defendHoop(t), b = G.ball, S = t.strat;
  const handler = b.state === 'held' ? b.holder : null, man = off.players[p.idx];
  p.speedMul = 1;
  if (G.help && G.help.p === p) { p.target = G.help.spot; p.goal = 'Helping on the drive'; p.why = `${G.help.h.name} is driving, so step in his path.`; }
  else if (S.defense === 'zone' && G.phase === 'halfcourt') {
    const bp = b.pos, ba = Math.abs(bp.x - hoop.x);
    let [a, bz] = ZONE[p.idx];
    bz += clamp(bp.z * .35, -1.8, 1.8); a += clamp((ba - 5) * .12, -.6, 1.2);
    let spot = fromDefHoop(t, a, bz), near = null, nd = 2.4;
    for (const q of off.players) { const d = dist(q.pos, spot); if (d < nd) { nd = d; near = q; } }
    if (near && near === handler) { p.target = manTarget(near, hoop, true, S.pressure); p.goal = `Zone: closing out on ${near.name}`; p.why = 'The ball came into my area.'; }
    else if (near) { p.target = add(spot, mul(sub(manTarget(near, hoop, false, .5), spot), .5)); p.goal = `Zone: covering ${near.name}`; p.why = `${near.name} is in my area of the zone.`; }
    else { p.target = spot; p.goal = 'Zone: holding my area'; p.why = 'Guarding a space, not a player. Shifting with the ball.'; }
  } else {
    const hb = man === handler;
    p.target = manTarget(man, hoop, hb, S.pressure);
    p.goal = hb ? `Guarding ${man.name} (has the ball)` : G.phase !== 'halfcourt' ? `Sprinting back to guard ${man.name}` : `Guarding ${man.name}`;
    p.why = hb ? (S.pressure > .6 ? 'Game plan: pressure the ball.' : 'Staying between him and the basket.') : 'Between my player and the basket, one eye on the ball.';
  }
  // on-ball steal attempt
  if (handler && handler.catchT <= 0 && dist(p.pos, handler.pos) < .95) {
    const ch = .03 * p.attr.defense * (.5 + S.pressure) * (1.3 - handler.attr.passing * .6);
    if (rand() < ch * dt) { p.stats.stl++; handler.stats.tov++; log(`${p.name} strips ${handler.name}. Steal!`, t, true); gain(p, 'steal'); }
  }
}
function looseAI() {
  const b = G.ball, pred = { x: b.pos.x + b.vel.x * .35, z: b.pos.z + b.vel.z * .35 };
  for (const t of G.teams) {
    const chasers = G.phase === 'tip' ? t.players.filter(p => p.role === 'C') : [...t.players].sort((a, c) => dist(a.pos, pred) - dist(c.pos, pred)).slice(0, 2);
    for (const p of t.players) {
      if (chasers.includes(p)) { p.target = pred; p.speedMul = 1; p.goal = G.phase === 'tip' ? 'Jumping for the tip' : 'Chasing the rebound'; p.why = 'Closest to where the ball will land.'; }
      else if (G.phase === 'tip') { p.target = { ...p.pos }; p.goal = 'Waiting for the tip'; p.why = ''; }
      else if (t.id === G.offense) { p.target = formation(t)[p.idx].pos; p.speedMul = .7; p.goal = 'Spacing out for the rebound'; p.why = 'Ready for a kick-out pass.'; }
      else { p.target = manTarget(other(t).players[p.idx], defendHoop(t), false, .9); p.speedMul = 1; p.goal = 'Boxing out'; p.why = 'Keeping my player away from the ball.'; }
    }
  }
}
function shotAirAI() {
  const off = G.teams[G.offense], def = other(off);
  for (const p of off.players) {
    if (p === G.ball.shooter) { p.target = { ...p.pos }; p.goal = 'Watching the shot'; p.why = ''; continue; }
    if (p.role === 'C' || p.role === 'PF') { p.target = fromHoop(off, 1.5, p.role === 'C' ? 1.4 : -1.4); p.speedMul = 1; p.goal = 'Crashing the boards'; p.why = 'Bigs go for offensive rebounds.'; }
    else { p.speedMul = .5; p.goal = 'Waiting for the shot'; p.why = ''; }
  }
  for (const p of def.players) { p.target = manTarget(off.players[p.idx], defendHoop(def), false, .95); p.speedMul = 1; p.goal = 'Boxing out'; p.why = 'A shot is up: get between my player and the rim.'; }
}

function think(dt) {
  const b = G.ball, off = G.teams[G.offense], def = other(off);
  G.help = null;
  if (b.state === 'loose') { looseAI(); return; }
  if (b.state === 'shot') { shotAirAI(); return; }
  if (b.state === 'held' && b.holder.drive > 0 && def.strat.defense === 'man') {
    const h = b.holder, hoop = attackHoop(off);
    if (dist(h.pos, hoop) < 5.5) {
      const spot = add(h.pos, mul(sub(hoop, h.pos), .45));
      let best = null, bd = 4.5;
      for (const q of def.players) { if (q.idx === h.idx) continue; const d = dist(q.pos, spot); if (d < bd) { bd = d; best = q; } }
      if (best) G.help = { p: best, spot, h };
    }
  }
  for (const p of off.players) {
    if (b.state === 'held' && b.holder === p) handlerAI(p, dt);
    else if (b.state === 'pass' && b.target === p) { p.target = { x: b.to.x, z: b.to.z }; p.speedMul = 1; p.goal = 'Catching the pass'; p.why = `From ${b.passer.name}.`; }
    else offBallAI(p, dt);
  }
  for (const p of def.players) {
    if (b.state === 'pass' && b.target === p) { p.target = { x: b.to.x, z: b.to.z }; p.speedMul = 1; p.goal = 'Jumping the passing lane!'; p.why = 'Read the pass early.'; }
    else defenseAI(p, dt);
  }
}

function move(p, dt) {
  if (p.freeze > 0) p.freeze -= dt;
  if (p.jump > 0) { p.jumpT += dt; if (p.jumpT >= p.jump) { p.jump = 0; p.jumpT = 0; } }
  const maxS = (4.2 + p.attr.speed * 3.2) * (p.freeze > 0 ? 0 : p.speedMul);
  const to = sub(p.target, p.pos), d = len(to);
  let des = d < .05 ? { x: 0, z: 0 } : mul(norm(to), Math.min(maxS, d * 2.5));
  for (const q of G.players) {
    if (q === p) continue;
    const dd = dist(p.pos, q.pos);
    if (dd < .75 && dd > 1e-4) des = add(des, mul(norm(sub(p.pos, q.pos)), (.75 - dd) * 6));
  }
  const k = Math.min(1, dt * 7);
  p.vel.x += (des.x - p.vel.x) * k; p.vel.z += (des.z - p.vel.z) * k;
  p.pos.x = clamp(p.pos.x + p.vel.x * dt, -HALF_L - .3, HALF_L + .3);
  p.pos.z = clamp(p.pos.z + p.vel.z * dt, -HALF_W - .3, HALF_W + .3);
  // facing
  const b = G.ball, onDef = p.team.id !== G.offense;
  let look;
  if (b.holder === p) look = attackHoop(p.team);
  else if (!onDef && len(p.vel) > 2.5) look = add(p.pos, p.vel);
  else look = { x: b.pos.x, z: b.pos.z };
  if (look) { const v = sub(look, p.pos); if (len(v) > .05) p.face = norm(v); }
}

function stepBall(dt) {
  const b = G.ball;
  if (b.state === 'held') { b.pos = handPos(b.holder); return; }
  if (b.state === 'pass' || b.state === 'shot') {
    b.t += dt; const s = Math.min(1, b.t / b.dur);
    b.pos = { x: lerp(b.from.x, b.to.x, s), z: lerp(b.from.z, b.to.z, s), y: lerp(b.from.y, b.to.y, s) + 4 * b.h * s * (1 - s) };
    if (s < 1) return;
    if (b.state === 'pass') {
      const r = b.target;
      if (b.intercept) { r.stats.stl++; b.passer.stats.tov++; log(`${r.name} intercepts ${b.passer.name}'s pass!`, r.team, true); gain(r, 'steal'); }
      else gain(r, 'pass');
    } else resolveShot();
    return;
  }
  if (b.state === 'made') {
    b.vel.y -= 9.8 * dt; b.pos.y += b.vel.y * dt;
    if (b.pos.y < .12) { b.pos.y = .12; b.vel.y = Math.abs(b.vel.y) * .5; }
    G.deadT -= dt;
    if (G.deadT <= 0) { const t = G.teams[G.offense]; giveInbound(t, defendHoop(t)); }
    return;
  }
  // loose ball physics
  b.noGrab -= dt;
  b.vel.y -= 9.8 * dt;
  b.pos.x += b.vel.x * dt; b.pos.y += b.vel.y * dt; b.pos.z += b.vel.z * dt;
  if (b.pos.y < .12) { b.pos.y = .12; b.vel.y = Math.abs(b.vel.y) > .6 ? -b.vel.y * .62 : 0; b.vel.x *= .9; b.vel.z *= .9; }
  if (b.pos.y <= .13) { b.vel.x *= 1 - 1.2 * dt; b.vel.z *= 1 - 1.2 * dt; }
  if ((Math.abs(b.pos.x) > HALF_L + .05 || Math.abs(b.pos.z) > HALF_W + .05) && b.pos.y < 1.5) {
    const t = b.lastTouch ? other(b.lastTouch) : G.teams[0];
    log(`Out of bounds. ${t.name} ball`, t);
    giveInbound(t, { x: clamp(b.pos.x, -13.3, 13.3), z: clamp(b.pos.z, -7, 7) });
    return;
  }
  if (b.noGrab > 0) return;
  let best = null, bs = -1e9;
  for (const p of G.players) {
    const hd = dist(p.pos, b.pos), reach = 2.45 * p.height + .35 * p.attr.rebound, rad = .45 + .35 * p.attr.rebound;
    if (hd < rad && b.pos.y < reach) { const sc = rand() * (.5 + p.attr.rebound) - hd; if (sc > bs) { bs = sc; best = p; } }
  }
  if (best) {
    if (b.pos.y > 1.6) { best.jump = .45; best.jumpT = 0; }
    gain(best, G.phase === 'tip' ? 'tip' : b.reboundable ? 'rebound' : 'loose');
  }
}
function resolveShot() {
  const b = G.ball, sh = b.shooter, t = sh.team, o = other(t), hoop = attackHoop(t);
  if (b.made) {
    t.score += b.pts; sh.stats.pts += b.pts; sh.stats.fgm++; if (b.pts === 3) sh.stats.tpm++;
    let ast = '';
    const lp = b.lastPass;
    if (lp && lp.recv === sh && lp.passer.team === t && G.elapsed - lp.time < 5) { lp.passer.stats.ast++; ast = ` (assist: ${lp.passer.name})`; }
    const what = b.pts === 3 ? 'drains a three' : b.info.d < 1.6 ? 'scores at the rim' : 'hits a jumper';
    log(`${sh.name} ${what}${ast}`, t, true);
    Object.assign(b, { state: 'made', pos: { x: hoop.x, y: RIM_Y - .05, z: 0 }, vel: { x: 0, y: -1.5, z: 0 }, lastPass: null });
    G.deadT = 1.1; G.offense = o.id; G.phase = 'inbound';
    emit('score', t);
  } else {
    log(`${sh.name} misses${b.pts === 3 ? ' from three' : ''}`, t);
    const ang = (rand() - .5) * 2.4, hs = 1.2 + rand() * 3.4;
    Object.assign(b, { state: 'loose', pos: { ...b.to }, vel: { x: Math.cos(ang) * -t.dir * hs, y: 1.8 + rand() * 2.4, z: Math.sin(ang) * hs }, noGrab: .25, reboundable: true, lastPass: null });
  }
}
function endQuarter() {
  const [a, c] = G.teams;
  if (G.quarter >= 4 && a.score !== c.score) {
    G.over = true;
    const w = a.score > c.score ? a : c;
    log(`Final: ${w.name} win ${Math.max(a.score, c.score)}–${Math.min(a.score, c.score)}`, w, true);
    emit('final'); return;
  }
  log(`End of ${G.quarter <= 4 ? 'Q' + G.quarter : 'overtime'}`, null);
  G.quarter++; G.clock = G.quarter > 4 ? OT_LEN : QLEN; G.breakT = 2;
  emit('break', G.quarter > 4 ? 'OVERTIME' : `END OF Q${G.quarter - 1}`);
}
function startQuarter() {
  const t = G.teams[(G.quarter + 1) % 2];
  giveInbound(t, { x: -t.dir * 6, z: 0 });
  emit('break', null);
}
function step(dt) {
  if (G.over) return;
  if (G.breakT > 0) { G.breakT -= dt; if (G.breakT <= 0) startQuarter(); return; }
  G.elapsed += dt; G.possT += dt;
  const b = G.ball;
  if (G.phase !== 'tip') { G.clock -= dt; if (G.clock <= 0) { G.clock = 0; endQuarter(); return; } }
  if (b.state === 'held' || b.state === 'pass') {
    G.shotClock -= dt;
    if (G.shotClock <= 0 && b.state === 'held') { G.shotClock = 0; turnover(b.holder, `Shot clock violation on the ${b.holder.team.name}`); return; }
  }
  think(dt);
  for (const p of G.players) move(p, dt);
  stepBall(dt);
}

// ---------- headless balance test: ?sim=N ----------
makeTeams();
const params = new URLSearchParams(location.search);
if (params.has('sim')) {
  const n = +params.get('sim') || 10, rows = [];
  for (let g = 0; g < n; g++) {
    newGame(); let guard = 0;
    while (!G.over && guard++ < 400000) step(1 / 30);
    const tot = k => G.players.reduce((s, p) => s + p.stats[k], 0);
    rows.push({ score: G.teams.map(t => t.score).join('-'), poss: G.possessions.join('/'), fg: (tot('fgm') / tot('fga')).toFixed(3), tpa: (tot('tpa') / tot('fga')).toFixed(2),
      tp: (tot('tpm') / Math.max(1, tot('tpa'))).toFixed(3), ast: tot('ast'), reb: tot('reb'), stl: tot('stl'), tov: tot('tov') });
  }
  const pre = document.createElement('pre'); pre.id = 'simout'; pre.textContent = JSON.stringify(rows, null, 1); document.body.prepend(pre);
} else {
  startView();
}

/* ==========================================================================
   3D VIEW
   ========================================================================== */
function startView() {
  const $ = s => document.querySelector(s);
  const canvas = $('#gl'), stage = $('#stage');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let paused = false, speed = 1, camMode = 'tv', showThink = true, sel = null, coachTeam = 0;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x06080c);
  scene.fog = new THREE.Fog(0x06080c, 60, 130);
  const camera = new THREE.PerspectiveCamera(42, 1, .1, 200);
  camera.position.set(0, 10.5, 18.5);
  const controls = new OrbitControls(camera, canvas);
  controls.maxPolarAngle = Math.PI / 2.08; controls.minDistance = 4; controls.maxDistance = 45;

  scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x1a1f2b, .85));
  const sun = new THREE.DirectionalLight(0xffffff, 1.7);
  sun.position.set(5, 22, 9); sun.castShadow = true;
  Object.assign(sun.shadow.camera, { left: -17, right: 17, top: 11, bottom: -11, near: 1, far: 50 });
  sun.shadow.mapSize.set(2048, 2048); sun.shadow.bias = -.0004;
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0x9fb6ff, .35); fill.position.set(-8, 10, -12); scene.add(fill);

  // court
  function courtTexture() {
    const S = 80, cw = 31 * S, ch = 18 * S, c = document.createElement('canvas'); c.width = cw; c.height = ch;
    const g = c.getContext('2d'), X = x => (x + 15.5) * S, Z = z => (z + 9) * S;
    g.fillStyle = '#141925'; g.fillRect(0, 0, cw, ch);
    g.fillStyle = '#c48b52'; g.fillRect(X(-14), Z(-7.5), 28 * S, 15 * S);
    let seed = 3; const r = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let z = -7.5; z < 7.5; z += .19) for (let x = -14; x < 14;) {
      const l = 1.4 + r() * 2.6;
      g.fillStyle = `hsl(${27 + r() * 7},${46 + r() * 12}%,${50 + r() * 10}%)`; g.globalAlpha = .55;
      g.fillRect(X(x), Z(z), Math.min(l, 14 - x) * S, .19 * S - 1); x += l;
    }
    g.globalAlpha = 1;
    // painted keys in each defending team's color
    for (const side of [-1, 1]) {
      const t = G.teams.find(t => -t.dir === side);
      g.fillStyle = t.css; g.globalAlpha = .5;
      const x0 = side > 0 ? X(14 - 5.8) : X(-14);
      g.fillRect(x0, Z(-2.45), 5.8 * S, 4.9 * S); g.globalAlpha = 1;
    }
    g.fillStyle = 'rgba(10,12,18,.55)'; g.beginPath(); g.arc(X(0), Z(0), 1.8 * S, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#f5efe4'; g.lineWidth = .05 * S;
    g.strokeRect(X(-14), Z(-7.5), 28 * S, 15 * S);
    g.beginPath(); g.moveTo(X(0), Z(-7.5)); g.lineTo(X(0), Z(7.5)); g.stroke();
    g.beginPath(); g.arc(X(0), Z(0), 1.8 * S, 0, Math.PI * 2); g.stroke();
    const a3 = Math.asin(CORNER_Z / R3), dx = Math.sqrt(R3 * R3 - CORNER_Z * CORNER_Z);
    for (const side of [-1, 1]) {
      const hx = side * HX, base = side * 14, ft = side * (14 - 5.8);
      g.strokeRect(side > 0 ? X(ft) : X(-14), Z(-2.45), 5.8 * S, 4.9 * S);
      g.beginPath(); g.arc(X(ft), Z(0), 1.8 * S, 0, Math.PI * 2); g.stroke();
      for (const zz of [-CORNER_Z, CORNER_Z]) { g.beginPath(); g.moveTo(X(base), Z(zz)); g.lineTo(X(hx - side * dx), Z(zz)); g.stroke(); }
      g.beginPath();
      if (side > 0) g.arc(X(hx), Z(0), R3 * S, Math.PI - a3, Math.PI + a3); else g.arc(X(hx), Z(0), R3 * S, -a3, a3);
      g.stroke();
      g.beginPath();
      if (side > 0) g.arc(X(hx), Z(0), 1.25 * S, Math.PI / 2, Math.PI * 1.5); else g.arc(X(hx), Z(0), 1.25 * S, -Math.PI / 2, Math.PI / 2);
      g.stroke();
      // team name in the apron behind each baseline
      const t = G.teams.find(t => -t.dir === side);
      g.save(); g.translate(X(side * 14.75), Z(0)); g.rotate(side * -Math.PI / 2);
      g.fillStyle = t.css; g.font = `800 ${.9 * S}px "Barlow Condensed", sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(t.name.toUpperCase(), 0, 0); g.restore();
    }
    g.fillStyle = '#f5efe4'; g.font = `800 ${.62 * S}px "Barlow Condensed", sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('AI HOOPS', X(0), Z(-.28)); g.font = `700 ${.38 * S}px "Barlow Condensed", sans-serif`; g.fillText('LAB', X(0), Z(.38));
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    return tex;
  }
  const floorMat = new THREE.MeshStandardMaterial({ roughness: .5, metalness: 0 });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(31, 18), floorMat);
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; scene.add(floor);
  floorMat.map = courtTexture();
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(140, 140), new THREE.MeshStandardMaterial({ color: 0x0b0e15, roughness: 1 }));
  ground.rotation.x = -Math.PI / 2; ground.position.y = -.01; scene.add(ground);

  // stands + crowd
  (function stands() {
    const tierMat = new THREE.MeshStandardMaterial({ color: 0x1a202c, roughness: .9 });
    const crowdGeo = new THREE.BoxGeometry(.38, .55, .32);
    const crowd = new THREE.InstancedMesh(crowdGeo, new THREE.MeshStandardMaterial({ roughness: .8 }), 2400);
    const m = new THREE.Matrix4(), col = new THREE.Color(); let n = 0;
    const palette = [0x3d8bff, 0xff4d5e, 0xe8e8e8, 0x2a2f3a, 0x6b7280, 0xffd23f, 0x3d8bff, 0xff4d5e];
    const tier = (cx, cz, lenA, along, i) => {
      const h = .45 + i * .55, depth = .95;
      const box = new THREE.Mesh(new THREE.BoxGeometry(along === 'x' ? lenA : depth, h, along === 'x' ? depth : lenA), tierMat);
      box.position.set(cx, h / 2, cz); box.receiveShadow = true; scene.add(box);
      for (let s = -lenA / 2 + .4; s < lenA / 2 - .3 && n < 2400; s += .5 + rand() * .25) {
        if (rand() < .12) continue;
        m.makeTranslation(along === 'x' ? cx + s : cx, h + .27, along === 'x' ? cz : cz + s);
        crowd.setMatrixAt(n, m); crowd.setColorAt(n, col.setHex(palette[(rand() * palette.length) | 0]).multiplyScalar(.55 + rand() * .45)); n++;
      }
    };
    for (let i = 0; i < 6; i++) {
      tier(0, -10 - i * .95, 34, 'x', i);                 // far side only, so the TV camera sees over it
      tier(17.6 + i * .95, 0, 18, 'z', i); tier(-17.6 - i * .95, 0, 18, 'z', i);
    }
    crowd.count = n; crowd.instanceMatrix.needsUpdate = true; scene.add(crowd);
    const lightMat = new THREE.MeshBasicMaterial({ color: 0xfff6dd });
    for (const x of [-9, -3, 3, 9]) for (const z of [-4, 4]) { const l = new THREE.Mesh(new THREE.BoxGeometry(2, .15, .6), lightMat); l.position.set(x, 19, z); scene.add(l); }
  })();

  // hoops
  function hoop(side) {
    const g = new THREE.Group(), hx = side * HX;
    const board = new THREE.Mesh(new THREE.BoxGeometry(.05, 1.05, 1.8), new THREE.MeshPhysicalMaterial({ color: 0xffffff, transparent: true, opacity: .28, roughness: .05 }));
    board.position.set(side * (HALF_L - 1.2), 3.425, 0); g.add(board);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(board.geometry), new THREE.LineBasicMaterial({ color: 0xffffff }));
    edges.position.copy(board.position); g.add(edges);
    const sq = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(.01, .45, .59)), new THREE.LineBasicMaterial({ color: 0xffffff }));
    sq.position.set(side * (HALF_L - 1.225), 3.2, 0); g.add(sq);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(.225, .018, 8, 32), new THREE.MeshStandardMaterial({ color: 0xff5a1f, roughness: .4, metalness: .3 }));
    rim.rotation.x = Math.PI / 2; rim.position.set(hx, RIM_Y, 0); rim.castShadow = true; g.add(rim);
    const net = new THREE.Mesh(new THREE.CylinderGeometry(.225, .14, .42, 14, 3, true), new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, transparent: true, opacity: .75 }));
    net.position.set(hx, RIM_Y - .21, 0); g.add(net);
    const metal = new THREE.MeshStandardMaterial({ color: 0x2b3240, roughness: .6, metalness: .4 });
    const arm = new THREE.Mesh(new THREE.BoxGeometry(2.0, .12, .12), metal); arm.position.set(side * (HALF_L + -.2), 3.3, 0); g.add(arm);
    const pole = new THREE.Mesh(new THREE.BoxGeometry(.35, 3.4, .35), metal); pole.position.set(side * (HALF_L + .8), 1.7, 0); pole.castShadow = true; g.add(pole);
    const t = G.teams.find(t => -t.dir === side);
    const pad = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.0, 1.4), new THREE.MeshStandardMaterial({ color: t.color, roughness: .7 })); pad.position.set(side * (HALF_L + .9), .5, 0); pad.castShadow = true; g.add(pad);
    scene.add(g);
    return { net };
  }
  const hoops = [hoop(-1), hoop(1)];

  // players
  const SKIN = [0x8d5524, 0xc68642, 0xe0ac69, 0x6b3e1f, 0xf1c27d, 0x4a2c17];
  const pickables = [];
  function numberTexture(num, color) {
    const c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.font = '800 92px "Barlow Condensed", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineWidth = 6; g.strokeStyle = color; g.strokeText(num, 64, 70); g.fillText(num, 64, 70);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  }
  function plateTexture(p) {
    const c = document.createElement('canvas'); c.width = 256; c.height = 72; const g = c.getContext('2d');
    g.fillStyle = 'rgba(8,10,14,.82)'; g.beginPath(); g.roundRect(2, 2, 252, 68, 14); g.fill();
    g.fillStyle = p.team.css; g.beginPath(); g.roundRect(2, 2, 72, 68, [14, 0, 0, 14]); g.fill();
    g.fillStyle = '#fff'; g.font = '800 48px "Barlow Condensed", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(p.num, 38, 38);
    g.textAlign = 'left'; g.font = '700 40px "Barlow Condensed", sans-serif'; g.fillText(p.name.toUpperCase(), 86, 32);
    g.fillStyle = '#9aa4b5'; g.font = '600 22px Inter, sans-serif'; g.fillText(p.role, 88, 58);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  }
  function buildPlayer(p) {
    const t = p.team, root = new THREE.Group(), body = new THREE.Group(); root.add(body);
    body.scale.setScalar(p.height);
    const jersey = new THREE.MeshStandardMaterial({ color: t.color, roughness: .65 });
    const shortsM = new THREE.MeshStandardMaterial({ color: new THREE.Color(t.color).multiplyScalar(.6), roughness: .7 });
    const skin = new THREE.MeshStandardMaterial({ color: SKIN[p.id % SKIN.length], roughness: .7 });
    const shoe = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: .5 });
    const legs = [];
    for (const s of [-1, 1]) {
      const hip = new THREE.Group(); hip.position.set(s * .11, .95, 0);
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(.075, .065, .88, 8), skin); leg.position.y = -.44; leg.castShadow = true; hip.add(leg);
      const sh = new THREE.Mesh(new THREE.BoxGeometry(.13, .09, .27), shoe); sh.position.set(0, -.88, .05); sh.castShadow = true; hip.add(sh);
      body.add(hip); legs.push(hip);
    }
    const shorts = new THREE.Mesh(new THREE.CylinderGeometry(.24, .26, .34, 12), shortsM); shorts.position.y = .9; shorts.castShadow = true; body.add(shorts);
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(.23, .42, 4, 12), jersey); torso.position.y = 1.33; torso.scale.z = .68; torso.castShadow = true; body.add(torso);
    const ntex = numberTexture(p.num, t.css);
    const numMat = new THREE.MeshBasicMaterial({ map: ntex, transparent: true });
    for (const s of [1, -1]) {
      const pl = new THREE.Mesh(new THREE.PlaneGeometry(.26, .26), numMat);
      pl.position.set(0, 1.36, s * .162); if (s < 0) pl.rotation.y = Math.PI; body.add(pl);
    }
    const head = new THREE.Mesh(new THREE.SphereGeometry(.125, 16, 12), skin); head.position.y = 1.86; head.castShadow = true; body.add(head);
    const arms = [];
    for (const s of [-1, 1]) {
      const sh = new THREE.Group(); sh.position.set(s * .29, 1.58, 0);
      const arm = new THREE.Mesh(new THREE.CylinderGeometry(.055, .045, .72, 8), skin); arm.position.y = -.36; arm.castShadow = true; sh.add(arm);
      body.add(sh); arms.push(sh);
    }
    const plate = new THREE.Sprite(new THREE.SpriteMaterial({ map: plateTexture(p), depthTest: false, transparent: true }));
    plate.scale.set(.95, .27, 1); plate.position.y = 2.42 * p.height; plate.renderOrder = 10; root.add(plate);
    const ring = new THREE.Mesh(new THREE.RingGeometry(.48, .6, 40), new THREE.MeshBasicMaterial({ color: 0xffd23f, transparent: true, opacity: .95 }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = .02; ring.visible = false; root.add(ring);
    const hit = new THREE.Mesh(new THREE.CylinderGeometry(.45, .45, 2.3, 8), new THREE.MeshBasicMaterial({ visible: false }));
    hit.position.y = 1.15; hit.userData.p = p; root.add(hit); pickables.push(hit);
    scene.add(root);
    p.mesh = { root, body, legs, arms, ring, plate, numMat };
  }
  for (const p of G.players) buildPlayer(p);
  // redraw lettering once the web fonts have loaded
  document.fonts.ready.then(() => {
    floorMat.map.dispose(); floorMat.map = courtTexture(); floorMat.needsUpdate = true;
    for (const p of G.players) {
      const m = p.mesh; m.plate.material.map.dispose(); m.plate.material.map = plateTexture(p); m.plate.material.needsUpdate = true;
      m.numMat.map.dispose(); m.numMat.map = numberTexture(p.num, p.team.css); m.numMat.needsUpdate = true;
    }
  });

  // ball
  const ballTex = (() => {
    const c = document.createElement('canvas'); c.width = 256; c.height = 128; const g = c.getContext('2d');
    g.fillStyle = '#e2661f'; g.fillRect(0, 0, 256, 128);
    g.strokeStyle = '#2a1206'; g.lineWidth = 4;
    g.beginPath(); g.moveTo(0, 64); g.lineTo(256, 64); g.stroke();
    for (const x of [64, 192]) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 128); g.stroke(); }
    g.beginPath(); g.ellipse(128, 64, 40, 64, 0, 0, Math.PI * 2); g.stroke();
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  })();
  const ball = new THREE.Mesh(new THREE.SphereGeometry(.12, 24, 16), new THREE.MeshStandardMaterial({ map: ballTex, roughness: .6 }));
  ball.castShadow = true; scene.add(ball);

  // thinking lines + labels
  const lines = [];
  for (let i = 0; i < 6; i++) {
    const geo = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    const ln = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: .6, depthTest: false }));
    ln.renderOrder = 9; ln.visible = false; scene.add(ln); lines.push(ln);
  }
  const labelLayer = $('#labels'), labels = [];
  for (let i = 0; i < 6; i++) { const d = document.createElement('div'); d.className = 'tl'; d.hidden = true; labelLayer.appendChild(d); labels.push(d); }
  const v3 = new THREE.Vector3();
  function placeLabel(el, x, y, z, html, best) {
    v3.set(x, y, z).project(camera);
    if (v3.z > 1) { el.hidden = true; return; }
    const w = canvas.clientWidth, h = canvas.clientHeight;
    el.style.left = ((v3.x + 1) / 2 * w) + 'px'; el.style.top = ((1 - v3.y) / 2 * h) + 'px';
    el.innerHTML = html; el.classList.toggle('best', !!best); el.hidden = false;
  }
  function drawThinking() {
    const b = G.ball, h = b.state === 'held' ? b.holder : null;
    lines.forEach(l => l.visible = false); labels.forEach(l => l.hidden = true);
    if (!showThink || !h || !h.opts || !h.mesh) return;
    const best = h.opts[0];
    let li = 0;
    const setLine = (ax, ay, az, bx, by, bz, color, op) => {
      const ln = lines[li++]; const a = ln.geometry.attributes.position.array;
      a[0] = ax; a[1] = ay; a[2] = az; a[3] = bx; a[4] = by; a[5] = bz; ln.geometry.attributes.position.needsUpdate = true;
      ln.material.color.set(color); ln.material.opacity = op; ln.visible = true;
    };
    let lab = 0;
    for (const o of h.opts) {
      if (o.type === 'pass') {
        const m = o.mate, isBest = o === best;
        setLine(h.pos.x, 1.2, h.pos.z, m.pos.x, 1.2, m.pos.z, isBest ? 0xffd23f : o.risk > .35 ? 0xff4d5e : 0xbfc8d6, isBest ? .95 : .35);
        placeLabel(labels[lab++], m.pos.x, 2.85 * m.height, m.pos.z, `pass <b>${o.u.toFixed(2)}</b>`, isBest);
      }
    }
    const sh = h.opts.find(o => o.type === 'shoot'), dr = h.opts.find(o => o.type === 'drive');
    if (dr && li < 6) setLine(h.pos.x, .05, h.pos.z, dr.to.x, .05, dr.to.z, dr === best ? 0xffd23f : 0x4fd18b, dr === best ? .95 : .5);
    let txt = `shoot <b>${Math.round(sh.info.prob * 100)}%</b> → ${sh.u.toFixed(2)}`;
    if (dr) txt += ` · drive ${dr.u.toFixed(2)}`;
    txt += ` · hold ${h.opts.find(o => o.type === 'hold').u.toFixed(2)}`;
    placeLabel(labels[lab++], h.pos.x, 2.9 * h.height, h.pos.z, txt, best.type === 'shoot' || best.type === 'drive' || best.type === 'hold');
  }

  // camera
  const camLook = new THREE.Vector3(0, 1, 0), goalPos = new THREE.Vector3(), goalLook = new THREE.Vector3();
  function updateCam(dt) {
    if (camMode === 'free') { controls.update(); return; }
    const b = G.ball.pos, aspect = camera.aspect, far = Math.max(1, 1.3 / aspect), off = G.teams[G.offense];
    if (camMode === 'tv') { goalPos.set(b.x * .55, 11 * far, 15.5 * far); goalLook.set(b.x * .75, .8, b.z * .25); }
    else if (camMode === 'follow') { goalPos.set(b.x - off.dir * 8.5, 6.2, b.z * .4 + 6 * far); goalLook.set(b.x + off.dir * 3, 1.2, b.z * .5); }
    else if (camMode === 'base') { goalPos.set(off.dir * 21.5, 6.8, 0); goalLook.set(off.dir * 4, 1, 0); }
    else { goalPos.set(0, 27 * Math.max(1, .9 / aspect), .01); goalLook.set(0, 0, 0); }
    const k = reduce ? 1 : 1 - Math.exp(-dt * 2.6);
    camera.position.lerp(goalPos, k); camLook.lerp(goalLook, k);
    camera.lookAt(camLook); controls.target.copy(camLook);
  }
  let pointerDown = null;
  controls.addEventListener('change', () => { if (camMode !== 'free' && pointerDown && pointerDown.moved) setCam('free'); });
  canvas.addEventListener('pointerdown', e => { pointerDown = { x: e.clientX, y: e.clientY, moved: false }; });
  canvas.addEventListener('pointermove', e => { if (pointerDown && Math.hypot(e.clientX - pointerDown.x, e.clientY - pointerDown.y) > 6) pointerDown.moved = true; });
  canvas.addEventListener('pointerup', e => {
    if (pointerDown && !pointerDown.moved) {
      const r = canvas.getBoundingClientRect(), ray = new THREE.Raycaster();
      ray.setFromCamera(new THREE.Vector2((e.clientX - r.left) / r.width * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
      const hit = ray.intersectObjects(pickables)[0];
      if (hit) select(hit.object.userData.p);
    }
    pointerDown = null;
  });
  function setCam(m) { camMode = m; document.querySelectorAll('#cams button').forEach(b => b.classList.toggle('on', b.dataset.c === m)); }

  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(canvas); resize();

  // animate players
  function angLerp(a, b, t) { let d = b - a; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2; return a + d * t; }
  function animPlayers(dt) {
    const b = G.ball;
    for (const p of G.players) {
      const m = p.mesh; if (!m) continue;
      m.root.position.set(p.pos.x, jumpY(p), p.pos.z);
      m.body.rotation.y = angLerp(m.body.rotation.y, Math.atan2(p.face.x, p.face.z), 1 - Math.exp(-dt * 12));
      const sp = len(p.vel); p.phase += sp * dt * speed * 2.6;
      const sw = Math.sin(p.phase) * .65 * Math.min(1, sp / 3);
      m.legs[0].rotation.x = sw; m.legs[1].rotation.x = -sw;
      let la = -sw * .8, ra = sw * .8, lz = 0, rz = 0;
      const shooting = p.jump > 0 && (b.shooter === p);
      if (shooting) { la = ra = -2.9; }
      else if (p.jump > 0) { la = ra = -2.7; }
      else if (b.holder === p) { ra = p.catchT > 0 ? -1.1 : -.55 + Math.sin(G.elapsed * 8.5 + p.id) * .3; la = p.catchT > 0 ? -1.1 : la; }
      else if (p.team.id !== G.offense && b.state === 'held' && dist(p.pos, b.holder.pos) < 1.6) { la = ra = -.4; lz = -.9; rz = .9; }
      m.arms[0].rotation.x = la; m.arms[1].rotation.x = ra; m.arms[0].rotation.z = lz; m.arms[1].rotation.z = rz;
      m.ring.visible = sel === p;
    }
  }

  // ---------- UI ----------
  const tick = $('#ticker');
  G.onEvent = (type, data) => {
    if (type === 'log' || type === 'new') {
      tick.innerHTML = G.log.slice(0, 5).map(e => `<li style="--c:${e.team >= 0 ? G.teams[e.team].css : '#666'}"><span class="tm">Q${Math.min(e.q, 5) > 4 ? 'OT' : e.q} ${e.t}</span>${e.txt}</li>`).join('');
    }
    if (type === 'score') { const el = $('#s' + data.id); el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
    if (type === 'break') { const bn = $('#banner'); bn.hidden = !data; if (data) bn.textContent = data; }
    if (type === 'final') showFinal();
    if (type === 'new') { $('#final').hidden = true; $('#banner').hidden = true; }
  };
  function updateBoard() {
    $('#s0').textContent = G.teams[0].score; $('#s1').textContent = G.teams[1].score;
    $('#qtr').textContent = G.quarter > 4 ? 'OT' : 'Q' + G.quarter;
    $('#clk').textContent = fmtClock(G.clock);
    const sc = $('#shc'); sc.textContent = Math.ceil(G.shotClock); sc.classList.toggle('low', G.shotClock < 5);
    document.querySelector('#sb .t0').classList.toggle('poss', G.offense === 0);
    document.querySelector('#sb .t1').classList.toggle('poss', G.offense === 1);
  }

  // coach panel
  const slider = (key, label, lo, hi) => `<div class="sl"><div class="top"><span>${label}</span><span id="v-${key}"></span></div>
    <input type="range" min="0" max="100" data-k="${key}" aria-label="${label}"><div class="ends"><span>${lo}</span><span>${hi}</span></div></div>`;
  function renderCoach() {
    const t = G.teams[coachTeam];
    $('#teamTabs').innerHTML = G.teams.map(x => `<button role="tab" style="--c:${x.css}" aria-selected="${x.id === coachTeam}" data-t="${x.id}">${x.name.toUpperCase()}</button>`).join('');
    $('#coachBody').innerHTML = `
      <div class="lbl">Game plan</div>
      <div class="chips">${Object.entries(PRESETS).map(([k, v]) => `<button data-p="${k}" class="${t.preset === k ? 'on' : ''}">${v.name}</button>`).join('')}</div>
      ${slider('pace', 'Pace', 'Slow & patient', 'Fast break')}
      ${slider('three', 'Shot choice', 'Attack the rim', 'Fire threes')}
      ${slider('pass', 'Ball movement', 'One-on-one', 'Pass-first')}
      <div class="lbl">Defense</div>
      <div class="seg"><button data-d="man">Man-to-man</button><button data-d="zone">2-3 zone</button></div>
      ${slider('pressure', 'Defensive pressure', 'Sag off', 'Pressure')}
      <div class="lbl">Roster: click a player</div>
      <div class="roster">${t.players.map(p => `<button data-pid="${p.id}" style="--c:${t.css}"><span class="num">${p.num}</span><span>${p.name}<br><span class="role">${ROLE_NAME[p.role]}</span></span><span class="pts" id="rp-${p.id}"></span></button>`).join('')}</div>`;
    syncCoach();
  }
  function syncCoach() {
    const t = G.teams[coachTeam];
    for (const k of ['pace', 'three', 'pass', 'pressure']) {
      const inp = document.querySelector(`#coachBody input[data-k="${k}"]`); inp.value = Math.round(t.strat[k] * 100);
      $('#v-' + k).textContent = Math.round(t.strat[k] * 100);
    }
    document.querySelectorAll('#coachBody [data-d]').forEach(b => b.classList.toggle('on', b.dataset.d === t.strat.defense));
    document.querySelectorAll('#coachBody [data-p]').forEach(b => b.classList.toggle('on', b.dataset.p === t.preset));
    document.querySelectorAll('.roster button').forEach(b => b.classList.toggle('on', !!sel && +b.dataset.pid === sel.id));
  }
  $('#teamTabs').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { coachTeam = +b.dataset.t; renderCoach(); } });
  $('#coachBody').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    const t = G.teams[coachTeam];
    if (b.dataset.p) { const { name, ...s } = PRESETS[b.dataset.p]; Object.assign(t.strat, s); t.preset = b.dataset.p; log(`${t.name} switch to "${name}"`, t); syncCoach(); }
    if (b.dataset.d) { t.strat.defense = b.dataset.d; t.preset = null; log(`${t.name} switch to ${b.dataset.d === 'man' ? 'man-to-man' : 'a 2-3 zone'}`, t); syncCoach(); }
    if (b.dataset.pid) select(G.players[+b.dataset.pid]);
  });
  $('#coachBody').addEventListener('input', e => {
    const k = e.target.dataset.k; if (!k) return;
    const t = G.teams[coachTeam]; t.strat[k] = e.target.value / 100; t.preset = null; $('#v-' + k).textContent = e.target.value; syncCoach();
  });

  // player card
  const card = $('#card');
  function intro() {
    card.innerHTML = `<div class="intro"><h2>Click any player</h2>
      <p>Click a player on the court or in the roster to see what that agent is thinking right now, change its skills, and follow its stats.</p>
      <p>With <b>Show AI thinking</b> on, the player with the ball shows its options above the court. Lines go to each teammate it could pass to: <span style="color:var(--hi)">gold</span> is its top choice, red is a risky pass, and green is a drive to the rim.</p>
      <p>Try it: give the Volts <b>Fire threes</b> and the Embers a <b>2-3 zone</b>, then watch who wins.</p></div>`;
  }
  function select(p) {
    sel = p;
    if (!p) { intro(); syncCoach(); return; }
    if (coachTeam !== p.team.id) { coachTeam = p.team.id; renderCoach(); } else syncCoach();
    card.innerHTML = `<div class="ph" style="--c:${p.team.css}"><span class="bigno">${p.num}</span><div><h2>${p.name.toUpperCase()}</h2><small>${ROLE_NAME[p.role]} · ${p.team.name}</small></div><button class="x" aria-label="Close player card">✕</button></div>
      <div class="think" id="thk"></div>
      <div class="lbl">Stats this game</div><div class="stats" id="pst"></div>
      <div class="lbl">Skills (drag to change)</div>
      ${ATTRS.map(([k, l]) => `<div class="sl"><div class="top"><span>${l}</span><span id="a-${k}">${Math.round(p.attr[k] * 100)}</span></div><input type="range" min="5" max="100" value="${Math.round(p.attr[k] * 100)}" data-a="${k}" aria-label="${l}"></div>`).join('')}`;
    card.querySelector('.x').onclick = () => select(null);
    card.querySelectorAll('input[data-a]').forEach(inp => inp.oninput = () => { p.attr[inp.dataset.a] = inp.value / 100; $('#a-' + inp.dataset.a).textContent = inp.value; });
    updateCard();
  }
  function updateCard() {
    for (const p of G.players) { const el = document.getElementById('rp-' + p.id); if (el) el.textContent = p.stats ? `${p.stats.pts} pts` : ''; }
    if (!sel) return;
    const p = sel, b = G.ball, st = p.stats;
    let html = `<div class="goal">${p.goal || '…'}</div><div class="why">${p.why || ''}</div>`;
    if (b.holder === p && p.opts) {
      const max = Math.max(1.6, ...p.opts.map(o => o.u));
      html += `<div class="lbl" style="margin-top:10px">Options it scored (expected points)</div>` + p.opts.map(o =>
        `<div class="opt ${o === p.choice ? 'pick' : ''}"><span>${o.label}</span><span>${o.u.toFixed(2)}</span><div class="bar"><i style="width:${clamp(o.u / max, 0, 1) * 100}%"></i></div></div>`).join('') +
        `<div class="note">Gold = what it chose. ${p.attr.iq < .6 ? 'Low IQ: it sometimes picks a worse option.' : 'High IQ: it usually picks the top option.'}</div>`;
    }
    $('#thk').innerHTML = html;
    $('#pst').innerHTML = [['pts', 'Points'], ['reb', 'Reb'], ['ast', 'Ast'], ['stl', 'Stl']].map(([k, l]) => `<div><b>${st[k]}</b><span>${l}</span></div>`).join('') +
      `<div><b>${st.fgm}/${st.fga}</b><span>FG</span></div><div><b>${st.tpm}/${st.tpa}</b><span>3PT</span></div><div><b>${st.tov}</b><span>TO</span></div><div><b>${Math.round(p.attr.iq * 100)}</b><span>IQ</span></div>`;
  }
  function showFinal() {
    const [a, c] = G.teams, w = a.score > c.score ? a : c;
    const table = t => `<div><h3 style="color:${t.css};margin:10px 0 0;font-family:'Barlow Condensed';font-size:22px">${t.name.toUpperCase()} ${t.score}</h3><table><tr><th>Player</th><th>PTS</th><th>FG</th><th>3PT</th><th>REB</th><th>AST</th><th>STL</th><th>TO</th></tr>${t.players.map(p => { const s = p.stats; return `<tr><td>${p.num} ${p.name}</td><td>${s.pts}</td><td>${s.fgm}/${s.fga}</td><td>${s.tpm}/${s.tpa}</td><td>${s.reb}</td><td>${s.ast}</td><td>${s.stl}</td><td>${s.tov}</td></tr>`; }).join('')}</table></div>`;
    const f = $('#final');
    f.innerHTML = `<div class="box"><p class="lbl" style="margin:0">Final</p><h2 style="color:${w.css}">${w.name.toUpperCase()} WIN ${Math.max(a.score, c.score)}–${Math.min(a.score, c.score)}</h2>
      <div class="cols2">${table(a)}${table(c)}</div><p style="margin:14px 0 0"><button class="btn" id="again">Play again</button> <span style="color:var(--muted);font-size:12px">Strategies and skills stay as you set them.</span></p></div>`;
    f.hidden = false; f.querySelector('#again').onclick = () => newGame();
  }

  // controls
  $('#play').onclick = () => { paused = !paused; $('#play').textContent = paused ? 'Play' : 'Pause'; };
  $('#spd').onclick = e => { const b = e.target.closest('button'); if (!b) return; speed = +b.dataset.s; document.querySelectorAll('#spd button').forEach(x => x.classList.toggle('on', x === b)); };
  $('#cams').onclick = e => { const b = e.target.closest('button'); if (b) setCam(b.dataset.c); };
  $('#think').onchange = e => { showThink = e.target.checked; };
  $('#newg').onclick = () => newGame();
  addEventListener('keydown', e => { if (e.key === ' ' && e.target === document.body) { e.preventDefault(); $('#play').click(); } });

  // loop
  newGame(); renderCoach(); intro();
  // test hooks: ?ff=seconds fast-forwards, ?pick=id selects a player
  if (params.has('ff')) { for (let i = 0, n = +params.get('ff') * 60; i < n; i++) step(1 / 60); }
  if (params.has('pick')) select(G.players[+params.get('pick')]);
  let last = performance.now(), uiT = 0;
  function frame(now) {
    const dt = clamp((now - last) / 1000, 0, .05); last = now;
    if (!paused) { let simDt = dt * speed; while (simDt > 1e-6) { const h = Math.min(simDt, 1 / 60); step(h); simDt -= h; } }
    if (G.ball.state === 'held' && G.ball.holder) { const hp = handPos(G.ball.holder); ball.position.set(hp.x, hp.y, hp.z); }
    else ball.position.set(G.ball.pos.x, G.ball.pos.y, G.ball.pos.z);
    if (!paused) { ball.rotation.x += dt * 6 * speed; ball.rotation.z += dt * 2 * speed; }
    animPlayers(paused ? 0 : dt);
    updateCam(dt);
    renderer.render(scene, camera);
    drawThinking();
    uiT -= dt; if (uiT <= 0) { uiT = .2; updateBoard(); updateCard(); }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  window.hoops = { G, step, newGame, select: id => select(G.players[id]), setCam, pause: v => { paused = v; } };
}
