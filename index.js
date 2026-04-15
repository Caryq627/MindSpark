// ═══════════════════════════════════════════════════════════════
//  WARP — Multiplayer Game Server — by MindSpark
//  Node.js + Socket.io
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: ['https://mindsparkwarp.netlify.app', 'https://mindspark-fwaw.onrender.com', 'http://localhost:8787', 'http://localhost:3000', 'http://localhost:3001', 'http://127.0.0.1:8787'],
    methods: ['GET', 'POST']
  },
  pingInterval: 10000,
  pingTimeout: 5000
});

// ─── Config ───
const TICK_RATE = 30; // Server ticks per second (higher = smoother)
const WORLD = { w: 12000, h: 12000, cx: 6000, cy: 6000, radius: 5800 };
const FOOD_COUNT = 1200;
const BOT_COUNT = 15;
const START_MASS = 15;
const FOOD_MASS = 2;
const MAX_BLAST_RADIUS = 350;
const CAPTURE_TIME = 10000;
const CAPTURES_TO_WIN = 10;
const RESPAWN_DELAY = 10000;

const NAMES = ['Nebula','Quasar','Pulsar','Nova','Cosmos','Zenith','Photon','Rift','Eclipse','Voidwalker','Darkstar','Singularity','Horizon','Quantum','Spectra','Ion','Aether','Nexus','Flux','Cipher','Echo','Phantom','Drift','Blaze','Shade','Prism','Orion','Lynx','Raven','Atlas','Bolt','Crux','Dusk','Fang','Glitch','Hex','Jolt','Kira','Lux'];
const BOT_COLORS = ['#ff2d95','#ff6a00','#00ff88','#ff4444','#44aaff','#ffaa00','#ff66cc','#66ffcc','#aa66ff','#ff8844','#44ff88','#8844ff','#ff4488','#88ff44','#4488ff','#ffcc44'];

// ─── Helpers ───
function rand(a, b) { return a + Math.random() * (b - a); }
function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function massToRadius(m) { return Math.sqrt(m) * 3; }
function clamp(v, mn, mx) { return Math.max(mn, Math.min(mx, v)); }
function randomName() { return NAMES[Math.floor(Math.random() * NAMES.length)]; }
function randomColor() { return BOT_COLORS[Math.floor(Math.random() * BOT_COLORS.length)]; }

let nextId = 1;
function genId() { return 'e' + (nextId++); }

// ─── Game State ───
let entities = {};   // id -> entity
let food = [];
let events = [];     // [{type, data}] broadcast each tick then cleared
let kingName = null;
let kingColor = null;
let gameTick = 0;

// ─── Food ───
function createFood() {
  const a = Math.random() * Math.PI * 2, d = Math.random() * WORLD.radius * .95;
  return { id: genId(), x: WORLD.cx + Math.cos(a) * d, y: WORLD.cy + Math.sin(a) * d, mass: FOOD_MASS + Math.random() * 2, hue: rand(0, 360), pulse: Math.random() * Math.PI * 2 };
}

function initFood() {
  food = [];
  for (let i = 0; i < FOOD_COUNT; i++) food.push(createFood());
}

// ─── Entity ───
function createEntity(name, color, socketId) {
  const isKing = (name === kingName);
  const spawnA = Math.random() * Math.PI * 2, spawnD = Math.random() * WORLD.radius * .7;
  const id = genId();
  const e = {
    id, x: WORLD.cx + Math.cos(spawnA) * spawnD, y: WORLD.cy + Math.sin(spawnA) * spawnD,
    vx: 0, vy: 0, mass: START_MASS + (isKing ? 5 : 0),
    name, color: isKing ? '#ffd700' : color,
    isBot: !socketId, socketId: socketId || null, alive: true,
    blastShots: 3, blastMaxShots: 3, blastRechargeTimer: 0, blastRechargeRate: 2500,
    vortexActive: false, vortexTime: 0, vortexAbsorbed: 0,
    boostEnergy: 100, boosting: false,
    dislodgeCharge: 0, dislodgeCooldown: 0,
    attached: [], attachedTo: null,
    respawnsLeft: 1, isKing,
    // Input state (from client or AI)
    input: { mx: 0, my: 0, blast: false, vortexStart: false, vortexEnd: false, boost: false, space: false },
    // Bot AI
    ai: socketId ? null : { targetX: WORLD.cx, targetY: WORLD.cy, retargetTimer: 0, vortexTimer: 0, personality: Math.random() },
    glowPhase: Math.random() * Math.PI * 2, diskPhase: Math.random() * Math.PI * 2,
  };
  entities[id] = e;
  return e;
}

function initBots() {
  for (let i = 0; i < BOT_COUNT; i++) createEntity(randomName(), randomColor(), null);
}

// ─── Bot AI ───
function updateBotAI(bot, dt) {
  if (!bot.alive || bot.attachedTo) return;
  const ai = bot.ai, r = massToRadius(bot.mass);
  ai.retargetTimer -= dt;

  const allE = Object.values(entities);
  let nearThreat = null, tDist = Infinity, nearPrey = null, pDist = Infinity, nearFood = null, fDist = Infinity;

  allE.forEach(p => {
    if (p === bot || !p.alive || p.attachedTo) return;
    const d = dist(bot, p);
    if (p.mass > bot.mass * 1.2 && d < 400 + massToRadius(p.mass) * 3 && d < tDist) { tDist = d; nearThreat = p; }
    if (bot.mass > p.mass * 1.2 && d < 350 && d < pDist) { pDist = d; nearPrey = p; }
  });
  food.forEach(f => { const d = dist(bot, f); if (d < fDist) { fDist = d; nearFood = f; } });

  if (nearThreat && tDist < 300 + massToRadius(nearThreat.mass) * 2) {
    const dx = bot.x - nearThreat.x, dy = bot.y - nearThreat.y, d = Math.hypot(dx, dy) + 1;
    ai.targetX = bot.x + (dx / d) * 300; ai.targetY = bot.y + (dy / d) * 300;
    if (bot.boostEnergy > 30) bot.boosting = true;
  } else if (nearPrey && ai.personality > .4) {
    ai.targetX = nearPrey.x; ai.targetY = nearPrey.y;
    if (pDist < r * 3 + massToRadius(nearPrey.mass) && !bot.vortexActive && Math.random() < .04) {
      bot.vortexActive = true; bot.vortexTime = 0; bot.vortexAbsorbed = 0;
      ai.vortexTimer = 2000 + Math.min(nearPrey.mass / bot.mass, 1) * 3000 + Math.random() * 1500;
    }
    if (pDist < 200) bot.boosting = bot.boostEnergy > 40;
  } else if (!bot.vortexActive && nearFood && fDist < 150 && Math.random() < .008 && bot.mass > 12) {
    bot.vortexActive = true; bot.vortexTime = 0; bot.vortexAbsorbed = 0;
    ai.vortexTimer = 2500 + Math.random() * 2000;
    ai.targetX = nearFood.x; ai.targetY = nearFood.y;
  } else if (nearFood && ai.retargetTimer <= 0) {
    ai.targetX = nearFood.x; ai.targetY = nearFood.y; ai.retargetTimer = 500 + Math.random() * 1000;
  } else if (ai.retargetTimer <= 0) {
    const wa = Math.random() * Math.PI * 2, wd = Math.random() * WORLD.radius * .8;
    ai.targetX = WORLD.cx + Math.cos(wa) * wd; ai.targetY = WORLD.cy + Math.sin(wa) * wd;
    ai.retargetTimer = 2000 + Math.random() * 3000;
  }

  // Vortex release
  if (bot.vortexActive) {
    ai.vortexTimer -= dt * 1000;
    const absorbRate = bot.vortexAbsorbed / (bot.vortexTime / 1000 + .1);
    const shouldRelease = ai.vortexTimer <= 0 || bot.vortexAbsorbed > 12 || (bot.vortexTime > 2000 && absorbRate < .5 && bot.vortexAbsorbed < 2);
    if (shouldRelease) {
      bot.vortexActive = false;
      if (bot.vortexAbsorbed > 2) {
        doSupernovaDamage(bot);
        events.push({ type: 'supernova', x: bot.x, y: bot.y, absorbed: bot.vortexAbsorbed, holdTime: bot.vortexTime });
      }
      bot.vortexAbsorbed = 0;
    }
  }

  // Blast
  if (bot.blastShots > 0 && Math.random() < .004 && bot.mass > 20) {
    bot.blastShots--; bot.blastRechargeTimer = bot.blastRechargeRate;
    doBlastDamage(bot);
    events.push({ type: 'blast', x: bot.x, y: bot.y, mass: bot.mass });
  }

  // Move toward target
  const dx = ai.targetX - bot.x, dy = ai.targetY - bot.y, d = Math.hypot(dx, dy) + 1;
  const speed = Math.max(1500 / Math.sqrt(bot.mass), 350) * (bot.boosting ? 2.5 : 1);
  bot.vx += (dx / d) * speed * dt; bot.vy += (dy / d) * speed * dt;
  if (bot.boostEnergy < 10) bot.boosting = false;
}

// ─── Blast / Supernova ───
function doBlastDamage(attacker) {
  const r = massToRadius(attacker.mass);
  const pushR = r + 80 + Math.min(r * 1.5, 500);
  const allE = Object.values(entities);
  allE.forEach(p => {
    if (p === attacker || !p.alive || p.attachedTo) return;
    const d = dist(attacker, p);
    if (d < pushR) {
      p.mass = Math.max(5, p.mass * .5);
      const dx = p.x - attacker.x, dy = p.y - attacker.y, dd = Math.hypot(dx, dy) + 1;
      p.vx += (dx / dd) * 35; p.vy += (dy / dd) * 35;
      events.push({ type: 'hit', x: p.x, y: p.y, id: p.id });
      if (p.mass <= 5) killEntity(attacker, p);
    }
  });
}

function doSupernovaDamage(attacker) {
  const ar = massToRadius(attacker.mass);
  const blastR = ar + 100 + attacker.vortexAbsorbed * 10 + Math.min(ar * 1.5, 500);
  const allE = Object.values(entities);
  allE.forEach(p => {
    if (p === attacker || !p.alive || p.attachedTo) return;
    const d = dist(attacker, p);
    if (d < blastR) {
      p.mass = Math.max(5, p.mass * .5);
      const dx = p.x - attacker.x, dy = p.y - attacker.y, dd = Math.hypot(dx, dy) + 1;
      const power = clamp(1 + Math.min(attacker.vortexTime / 2000, 3) * Math.min(attacker.vortexAbsorbed / 15, 4), 1, 12);
      p.vx += (dx / dd) * (15 + power * 2); p.vy += (dy / dd) * (15 + power * 2);
      if (p.mass <= 5) killEntity(attacker, p);
    }
  });
}

// ─── Kill / Attach / Dislodge ───
function killEntity(killer, victim) {
  victim.alive = false;
  if (victim.attachedTo) {
    const idx = victim.attachedTo.attached.findIndex(a => a.ref === victim.id);
    if (idx >= 0) victim.attachedTo.attached.splice(idx, 1);
    victim.attachedTo = null;
  }
  victim.attached.forEach(a => {
    const ref = entities[a.ref];
    if (ref) { ref.attachedTo = null; ref.alive = true; ref.x = victim.x + Math.cos(a.angle) * 50; ref.y = victim.y + Math.sin(a.angle) * 50; }
  });
  victim.attached = [];
  events.push({ type: 'kill', killer: killer.name, victim: victim.name, x: victim.x, y: victim.y, mass: victim.mass });

  if (victim.isBot) victim._respawnTimer = RESPAWN_DELAY;
  if (victim.socketId) {
    io.to(victim.socketId).emit('died', { killer: killer.name, peakMass: victim._peakMass || victim.mass });
  }
}

function attachWarp(captor, victim) {
  if (captor.attached.length >= CAPTURES_TO_WIN) return;
  victim.attachedTo = captor;
  captor.attached.push({
    name: victim.name, color: victim.color, mass: victim.mass,
    angle: Math.random() * Math.PI * 2, timer: CAPTURE_TIME, maxTimer: CAPTURE_TIME,
    ref: victim.id
  });
  captor.mass += victim.mass * .3;
  events.push({ type: 'capture', captor: captor.name, victim: victim.name });

  if (captor.attached.length >= CAPTURES_TO_WIN) {
    triggerVictory(captor, 'captured ' + CAPTURES_TO_WIN + ' warps');
  }
}

function executeDislodge(entity) {
  if (!entity.attachedTo) return;
  const captor = entity.attachedTo;
  const idx = captor.attached.findIndex(a => a.ref === entity.id);
  if (idx >= 0) captor.attached.splice(idx, 1);
  entity.attachedTo = null;
  entity.dislodgeCharge = 0;
  entity.dislodgeCooldown = 5000;
  const dx = entity.x - captor.x, dy = entity.y - captor.y, dd = Math.hypot(dx, dy) + 1;
  entity.vx += (dx / dd) * 25; entity.vy += (dy / dd) * 25;
  captor.vx -= (dx / dd) * 8; captor.vy -= (dy / dd) * 8;
  captor.mass = Math.max(10, captor.mass * .9);
  events.push({ type: 'dislodge', name: entity.name, captor: captor.name, x: entity.x, y: entity.y });
}

function triggerVictory(winner, reason) {
  kingName = winner.name; kingColor = winner.color;
  events.push({ type: 'victory', winner: winner.name, reason, mass: Math.round(winner.mass), captured: winner.attached.length });
  // Reset game after 5 seconds
  setTimeout(resetGame, 5000);
}

function resetGame() {
  // Clear all entities except connected players
  const sockets = Object.values(entities).filter(e => e.socketId);
  entities = {};
  initFood();
  // Re-add connected players
  sockets.forEach(s => {
    const e = createEntity(s.name, s.socketId === kingName ? '#ffd700' : (s._origColor || '#00f0ff'), s.socketId);
    e._origColor = s._origColor;
    e._peakMass = 0;
  });
  // Re-add bots
  for (let i = Object.values(entities).filter(e => e.isBot).length; i < BOT_COUNT; i++) {
    createEntity(randomName(), randomColor(), null);
  }
  io.emit('reset');
}

// ─── Physics Tick ───
function updateAttached(dt) {
  Object.values(entities).forEach(e => {
    if (!e.alive) return;
    for (let i = e.attached.length - 1; i >= 0; i--) {
      const a = e.attached[i];
      a.angle += dt * (1.5 + i * .3);
      a.timer -= dt * 1000;
      const ref = entities[a.ref];
      if (ref) {
        const orbitR = massToRadius(e.mass) + 15 + i * 8;
        ref.x = e.x + Math.cos(a.angle) * orbitR;
        ref.y = e.y + Math.sin(a.angle) * orbitR;
        ref.vx = 0; ref.vy = 0;
        // Bot dislodge
        if (ref.isBot && ref.ai) {
          const timeUrgency = (1 - a.timer / a.maxTimer);
          const sizeRatio = ref.mass / (e.mass + 1);
          const personality = ref.ai.personality;
          const dislodgeChance = .002 * timeUrgency * timeUrgency * (1 + sizeRatio * 3) * (1 + personality);
          if (a.timer < 8000 && Math.random() < dislodgeChance) { executeDislodge(ref); continue; }
        }
      }
      if (a.timer <= 0) {
        e.mass += a.mass * .3;
        if (ref) {
          ref.alive = false; ref.attachedTo = null;
          if (ref.isBot) ref._respawnTimer = RESPAWN_DELAY;
          if (ref.socketId) io.to(ref.socketId).emit('died', { killer: e.name, peakMass: ref._peakMass || ref.mass });
        }
        e.attached.splice(i, 1);
      }
    }
  });
}

function tick() {
  const dt = 1 / TICK_RATE;
  gameTick++;
  const allE = Object.values(entities);

  // Update bots
  allE.forEach(e => { if (e.isBot && e.alive && !e.attachedTo) updateBotAI(e, dt); });

  // Process player inputs
  allE.forEach(e => {
    if (!e.alive || e.attachedTo || !e.socketId) return;
    const inp = e.input;
    // Movement
    const dx = inp.mx - e.x, dy = inp.my - e.y, d = Math.hypot(dx, dy) + 1;
    const speed = Math.max(1800 / Math.sqrt(e.mass), 400) * (e.boosting && e.boostEnergy > 0 ? 2.5 : 1);
    if (d > 5) { e.vx += (dx / d) * speed * dt; e.vy += (dy / d) * speed * dt; }
    e.boosting = inp.boost;
    // Blast
    if (inp.blast && e.blastShots > 0) {
      e.blastShots--; e.blastRechargeTimer = e.blastRechargeRate;
      doBlastDamage(e);
      if (e.mass > START_MASS + 3) e.mass -= 2;
      events.push({ type: 'blast', x: e.x, y: e.y, mass: e.mass });
      inp.blast = false;
    }
    // Vortex start
    if (inp.vortexStart && !e.vortexActive) {
      e.vortexActive = true; e.vortexTime = 0; e.vortexAbsorbed = 0;
      inp.vortexStart = false;
    }
    // Vortex end
    if (inp.vortexEnd && e.vortexActive) {
      e.vortexActive = false;
      if (e.vortexAbsorbed > 2) {
        doSupernovaDamage(e);
        events.push({ type: 'supernova', x: e.x, y: e.y, absorbed: e.vortexAbsorbed, holdTime: e.vortexTime });
      }
      e.vortexAbsorbed = 0;
      inp.vortexEnd = false;
    }
  });

  // Dislodge for attached players
  allE.forEach(e => {
    if (!e.alive || !e.attachedTo || !e.socketId) return;
    e.dislodgeCooldown = Math.max(0, e.dislodgeCooldown - dt * 1000);
    if (e.input.space && e.dislodgeCooldown <= 0) {
      e.dislodgeCharge += dt * 200;
      if (e.dislodgeCharge >= 1000) executeDislodge(e);
    } else if (!e.input.space) {
      e.dislodgeCharge = Math.max(0, e.dislodgeCharge - dt * 300);
    }
  });

  // Physics for all alive non-attached entities
  allE.forEach(e => {
    if (!e.alive || e.attachedTo) return;
    const r = massToRadius(e.mass);
    // Boost
    if (e.boosting && e.boostEnergy > 0) { e.boostEnergy -= dt * 25; if (e.mass > START_MASS + 2) e.mass -= dt * 2; }
    else { e.boostEnergy = Math.min(100, e.boostEnergy + dt * 6); e.boosting = false; }
    // Blast recharge
    if (e.blastShots < e.blastMaxShots) { e.blastRechargeTimer -= dt * 1000; if (e.blastRechargeTimer <= 0) { e.blastShots++; e.blastRechargeTimer = e.blastRechargeRate; } }
    // Velocity
    e.vx *= Math.pow(.985, dt * 60); e.vy *= Math.pow(.985, dt * 60);
    e.x += e.vx; e.y += e.vy;
    // Circular wrap
    const dxc = e.x - WORLD.cx, dyc = e.y - WORLD.cy, dc = Math.hypot(dxc, dyc);
    if (dc > WORLD.radius) {
      const ang = Math.atan2(dyc, dxc);
      const overshoot = dc - WORLD.radius;
      e.x = WORLD.cx - Math.cos(ang) * (WORLD.radius - overshoot - r);
      e.y = WORLD.cy - Math.sin(ang) * (WORLD.radius - overshoot - r);
    }
    e.glowPhase += dt * 2; e.diskPhase += dt * (1 + e.mass * .01);
    // Eat food
    for (let fi = food.length - 1; fi >= 0; fi--) {
      const f = food[fi];
      const d = dist(e, f);
      if (d < r + 8) { e.mass += f.mass * .5; food.splice(fi, 1); continue; }
      if (d < r * 6 + 80) { const force = (e.mass * .001) / (d * .008 + 1); const fdx = e.x - f.x, fdy = e.y - f.y, fdd = Math.hypot(fdx, fdy) + 1; f.x += fdx / fdd * force; f.y += fdy / fdd * force; }
    }
    // Vortex pull
    if (e.vortexActive) {
      e.vortexTime += dt * 1000;
      const intensity = Math.min(e.vortexTime / 3000, 1);
      const suckR = 100 + intensity * 200 + e.vortexAbsorbed * 5 + r;
      food.forEach(f => { const d = dist(e, f); if (d < suckR) { const force = (1 - d / suckR) * (8 + intensity * 25); const fdx = e.x - f.x, fdy = e.y - f.y, fdd = Math.hypot(fdx, fdy) + 1; f.x += fdx / fdd * force; f.y += fdy / fdd * force; } });
      allE.forEach(p => {
        if (p === e || !p.alive || p.attachedTo) return;
        if (p.mass < e.mass * .8) { const d = dist(e, p); if (d < suckR * .6) { const force = (1 - d / (suckR * .6)) * (2 + intensity * 5); p.vx += (e.x - p.x) / (d + 1) * force * .3; p.vy += (e.y - p.y) / (d + 1) * force * .3; } }
      });
      // Vortex food absorption
      for (let fi = food.length - 1; fi >= 0; fi--) {
        const f = food[fi];
        if (dist(e, f) < r + 5) { e.vortexAbsorbed++; e.mass += f.mass * .3; food.splice(fi, 1); }
      }
    }
    // Mass decay
    if (e.mass > 50) e.mass -= dt * (e.mass - 50) * .003;
    // Track peak
    if (e._peakMass === undefined) e._peakMass = e.mass;
    if (e.mass > e._peakMass) e._peakMass = e.mass;
  });

  // Collision / attach
  const alive = allE.filter(e => e.alive && !e.attachedTo);
  for (let i = 0; i < alive.length; i++) {
    for (let j = i + 1; j < alive.length; j++) {
      const a = alive[i], b = alive[j];
      const d = dist(a, b), ra = massToRadius(a.mass), rb = massToRadius(b.mass);
      if (d < ra * .7 && a.mass > b.mass * 1.3) { attachWarp(a, b); }
      else if (d < rb * .7 && b.mass > a.mass * 1.3) { attachWarp(b, a); }
      else if (d < ra + rb) {
        const overlap = ra + rb - d; const dx = b.x - a.x, dy = b.y - a.y, dd = Math.hypot(dx, dy) + 1;
        const push = overlap * .2; const tm = a.mass + b.mass;
        a.vx -= (dx / dd) * push * (b.mass / tm); a.vy -= (dy / dd) * push * (b.mass / tm);
        b.vx += (dx / dd) * push * (a.mass / tm); b.vy += (dy / dd) * push * (a.mass / tm);
        if (d < (ra + rb) * .7) {
          if (a.mass > b.mass * 1.15 && !b.attachedTo && !a.attachedTo) attachWarp(a, b);
          else if (b.mass > a.mass * 1.15 && !a.attachedTo && !b.attachedTo) attachWarp(b, a);
        }
      }
    }
  }

  updateAttached(dt);

  // Respawn food
  while (food.length < FOOD_COUNT) food.push(createFood());
  // Wrap food
  food.forEach(f => { const fd = Math.hypot(f.x - WORLD.cx, f.y - WORLD.cy); if (fd > WORLD.radius) { const fa = Math.atan2(f.y - WORLD.cy, f.x - WORLD.cx); f.x = WORLD.cx - Math.cos(fa) * (WORLD.radius - 20); f.y = WORLD.cy - Math.sin(fa) * (WORLD.radius - 20); } });
  food.forEach(f => { f.pulse += .03; });

  // Respawn dead bots
  allE.forEach(e => {
    if (!e.alive && e.isBot && !e.attachedTo) {
      if (e._respawnTimer === undefined) e._respawnTimer = RESPAWN_DELAY;
      e._respawnTimer -= dt * 1000;
      if (e._respawnTimer <= 0 && e.respawnsLeft > 0) {
        e.respawnsLeft--;
        delete entities[e.id];
        createEntity(randomName(), randomColor(), null);
      }
    }
  });

  // Win check: last standing
  const freeAlive = Object.values(entities).filter(e => e.alive && !e.attachedTo);
  if (freeAlive.length === 1 && Object.keys(entities).length > 3) {
    const deadCount = Object.keys(entities).length - freeAlive.length;
    if (deadCount >= 3) triggerVictory(freeAlive[0], 'last warp standing');
  }

  // Death from mass depletion
  allE.forEach(e => {
    if (e.alive && !e.attachedTo && e.mass < 3) {
      e.alive = false;
      if (e.socketId) io.to(e.socketId).emit('died', { killer: 'the void', peakMass: e._peakMass || e.mass });
      if (e.isBot) e._respawnTimer = RESPAWN_DELAY;
    }
  });

  // ─── Broadcast State ───
  // Build compact state
  const entityList = Object.values(entities).map(e => ({
    id: e.id, x: Math.round(e.x), y: Math.round(e.y),
    vx: Math.round(e.vx * 10) / 10, vy: Math.round(e.vy * 10) / 10,
    mass: Math.round(e.mass * 10) / 10, name: e.name, color: e.color,
    alive: e.alive, isKing: e.isKing, isBot: e.isBot,
    vortexActive: e.vortexActive, vortexTime: e.vortexTime || 0,
    boosting: e.boosting,
    attached: e.attached.map(a => ({ name: a.name, color: a.color, angle: Math.round(a.angle * 100) / 100, timer: Math.round(a.timer), maxTimer: a.maxTimer, ref: a.ref })),
    attachedTo: e.attachedTo ? e.attachedTo.id : null,
    blastShots: e.blastShots, boostEnergy: Math.round(e.boostEnergy),
    dislodgeCharge: Math.round(e.dislodgeCharge), dislodgeCooldown: Math.round(e.dislodgeCooldown),
    glowPhase: Math.round(e.glowPhase * 100) / 100, diskPhase: Math.round(e.diskPhase * 100) / 100,
  }));

  // Send nearby food only (within 2000px of each player) to save bandwidth
  const connectedSockets = Object.values(entities).filter(e => e.socketId && e.alive);
  connectedSockets.forEach(p => {
    const nearFood = food.filter(f => Math.abs(f.x - p.x) < 2000 && Math.abs(f.y - p.y) < 2000)
      .map(f => ({ x: Math.round(f.x), y: Math.round(f.y), mass: Math.round(f.mass * 10) / 10, hue: Math.round(f.hue), pulse: Math.round(f.pulse * 100) / 100 }));
    io.to(p.socketId).emit('state', { entities: entityList, food: nearFood, events, tick: gameTick, you: p.id });
  });

  // Also broadcast to spectators (dead players)
  const deadSockets = Object.values(entities).filter(e => e.socketId && !e.alive);
  deadSockets.forEach(p => {
    io.to(p.socketId).emit('state', { entities: entityList, food: [], events, tick: gameTick, you: p.id });
  });

  events = [];
}

// ─── Socket.io Connections ───
io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);

  socket.on('join', (data) => {
    const name = (data.name || 'WRP').substring(0, 16);
    const color = data.color || '#00f0ff';
    const entity = createEntity(name, color, socket.id);
    entity._origColor = color;
    entity._peakMass = entity.mass;
    console.log(`${name} joined (${socket.id})`);
    socket.emit('joined', { id: entity.id, world: WORLD, capturesWin: CAPTURES_TO_WIN });
  });

  socket.on('input', (data) => {
    const entity = Object.values(entities).find(e => e.socketId === socket.id);
    if (!entity || !entity.alive) return;
    if (data.mx !== undefined) entity.input.mx = data.mx;
    if (data.my !== undefined) entity.input.my = data.my;
    if (data.blast) entity.input.blast = true;
    if (data.vortexStart) entity.input.vortexStart = true;
    if (data.vortexEnd) entity.input.vortexEnd = true;
    entity.input.boost = !!data.boost;
    entity.input.space = !!data.space;
  });

  socket.on('respawn', () => {
    const entity = Object.values(entities).find(e => e.socketId === socket.id);
    if (entity && !entity.alive && entity.respawnsLeft > 0) {
      entity.respawnsLeft--;
      delete entities[entity.id];
      const newE = createEntity(entity.name, entity._origColor || '#00f0ff', socket.id);
      newE._origColor = entity._origColor;
      newE.respawnsLeft = 0;
      socket.emit('joined', { id: newE.id, world: WORLD, capturesWin: CAPTURES_TO_WIN });
    }
  });

  socket.on('disconnect', () => {
    const entity = Object.values(entities).find(e => e.socketId === socket.id);
    if (entity) {
      // Release attached warps
      entity.attached.forEach(a => { const ref = entities[a.ref]; if (ref) { ref.attachedTo = null; ref.alive = true; } });
      entity.attached = [];
      if (entity.attachedTo) {
        const idx = entity.attachedTo.attached.findIndex(a => a.ref === entity.id);
        if (idx >= 0) entity.attachedTo.attached.splice(idx, 1);
      }
      delete entities[entity.id];
      console.log(`Player disconnected: ${entity.name} (${socket.id})`);
    }
  });
});

// ─── Health endpoint for Render ───
app.get('/', (req, res) => res.json({ status: 'WARP server running', players: Object.values(entities).filter(e => e.socketId).length, bots: Object.values(entities).filter(e => e.isBot).length }));
app.get('/health', (req, res) => res.json({ ok: true }));

// ─── Start ───
initFood();
initBots();
setInterval(tick, 1000 / TICK_RATE);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`WARP server listening on port ${PORT}`));
