// game.js - Car dodger with touch-follow control (drag to move)
// Change: car is moved up by CAR_VERTICAL_OFFSET (60px) in reset()
// Replace your existing game.js with this file (this is the previous dynamic version
// with touch-follow support added and the vertical offset change).
(() => {
  const canvas = document.getElementById('gameCanvas');
  const ctx = canvas.getContext('2d');
  const scoreEl = document.getElementById('score');
  const overlay = document.getElementById('overlay');
  const startScreen = document.getElementById('startScreen');
  const gameOverScreen = document.getElementById('gameOverScreen');
  const finalScore = document.getElementById('finalScore');
  const startBtn = document.getElementById('startBtn');
  const restartBtn = document.getElementById('restartBtn');
  const leftBtn = document.getElementById('leftBtn');
  const rightBtn = document.getElementById('rightBtn');
  const loadingEl = document.getElementById('loading');

  // ---------- CONFIG ----------
  const TOUCH_FOLLOW_ENABLED = true; // true = follow finger x-position; false = older left/right touch
  // Vertical offset to move the car upward (px)
  const CAR_VERTICAL_OFFSET = 60; // <-- moved car up by 60px

  // other tuning constants kept from previous version
  const LANE_COUNT = 3;
  const LANE_OBS_WIDTH_RATIO = 0.52;
  const LANE_SIDE_PADDING = 10;
  const MIN_VERTICAL_GAP_BASE = 160;
  const MIN_VERTICAL_GAP_SPEED_FACTOR = 9;
  const SECOND_OBS_PROB = 0.14;
  const AVOID_ADJACENT_SECOND = true;
  const SPAWN_RETRY_BACKOFF = 220;
  const MOVE_SPEED_BASE = 12;
  const CAR_TILT_MAX = 12;
  const CAR_BOB_AMPLITUDE = 3;
  const CAR_BOB_SPEED = 0.006;
  const SKID_THRESHOLD = 14;
  const EXHAUST_RATE = 60;
  const PARTICLE_LIFETIME = 600;
  const PARTICLE_MAX = 120;
  const SPRITE_ANIM_FPS = 12;
  // ----------------------------

  // assets (optional)
  const ASSETS = {
    images: {
      carSheet: 'assets/carSheet.png',
      obstacleSheet: 'assets/obstacleSheet.png',
      exhaust: 'assets/exhaust.png'
    },
    audio: {
      music: 'assets/background.mp3',
      hit: 'assets/hit.wav'
    }
  };

  let width = 400, height = 700;
  let dpr = Math.max(1, window.devicePixelRatio || 1);

  // update --vh if present (index.html already installed updateVhVar)
  function resize() {
    const maxWidth = Math.min(window.innerWidth - 32, 480);
    const maxHeight = Math.min(window.innerHeight - 120, 800);
    width = maxWidth;
    height = maxHeight;
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    ctx.setTransform(dpr,0,0,dpr,0,0);
  }
  window.addEventListener('resize', resize);
  resize();

  // game state & assets
  let running = false;
  let score = 0;
  let speed = 2.2;
  let car = { w: 48, h: 40, x: 0, y: 0, vx: 0, tilt: 0, bobPhase: 0, _lastBobTs: 0 };
  let obstacles = [];
  let lastSpawn = 0;
  let spawnInterval = 1000;
  let lastTime = 0;
  let keys = { left:false, right:false };
  // Legacy touchSide (left/right half screen) kept for fallback
  let touchSide = null;

  // Touch-follow specific
  let touchFollowActive = false;
  let touchPointerId = null;
  let touchClientX = 0;
  let touchTargetX = null; // desired car.x (left) such that car centered under finger
  let allowPointerMove = true; // flag used for pointermove

  const assetsLoaded = { images: {}, audio: {} };
  const spriteMeta = { car: { img: null, frames: 1, frameW: 0, frameH: 0 }, obstacle: { img: null, frames: 1, frameW: 0, frameH: 0 }, exhaustImg: null };
  const particles = [];
  let lastExhaustAt = 0;

  // simple loaders
  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Image failed: ' + src));
      img.src = src;
    });
  }
  function loadAudio(src) {
    return new Promise((resolve, reject) => {
      const audio = new Audio();
      audio.oncanplaythrough = () => resolve(audio);
      audio.onerror = () => reject(new Error('Audio failed: ' + src));
      audio.src = src;
      audio.load();
    });
  }

  async function loadAssets() {
    loadingEl.textContent = 'Đang tải tài nguyên...';
    const imagePromises = Object.entries(ASSETS.images).map(([k, src]) =>
      loadImage(src).then(img => ({ k, img })).catch(() => ({ k, img: null }))
    );
    const audioPromises = Object.entries(ASSETS.audio).map(([k, src]) =>
      loadAudio(src).then(a => ({ k, a })).catch(() => ({ k, a: null }))
    );

    const images = await Promise.all(imagePromises);
    images.forEach(({k, img}) => { assetsLoaded.images[k] = img; });

    const audios = await Promise.all(audioPromises);
    audios.forEach(({k, a}) => { assetsLoaded.audio[k] = a; });

    if (assetsLoaded.images.carSheet) {
      spriteMeta.car.img = assetsLoaded.images.carSheet;
      spriteMeta.car.frameH = assetsLoaded.images.carSheet.height;
      spriteMeta.car.frames = Math.max(1, Math.floor(assetsLoaded.images.carSheet.width / spriteMeta.car.frameH));
      spriteMeta.car.frameW = Math.floor(assetsLoaded.images.carSheet.width / spriteMeta.car.frames);
    }
    if (assetsLoaded.images.obstacleSheet) {
      spriteMeta.obstacle.img = assetsLoaded.images.obstacleSheet;
      spriteMeta.obstacle.frameH = assetsLoaded.images.obstacleSheet.height;
      spriteMeta.obstacle.frames = Math.max(1, Math.floor(assetsLoaded.images.obstacleSheet.width / spriteMeta.obstacle.frameH));
      spriteMeta.obstacle.frameW = Math.floor(assetsLoaded.images.obstacleSheet.width / spriteMeta.obstacle.frames);
    }
    if (assetsLoaded.images.exhaust) spriteMeta.exhaustImg = assetsLoaded.images.exhaust;

    if (assetsLoaded.audio.music) {
      assetsLoaded.audio.music.loop = true;
      assetsLoaded.audio.music.volume = 0.35;
    }
    if (assetsLoaded.audio.hit) assetsLoaded.audio.hit.volume = 0.9;

    const imgNames = Object.keys(assetsLoaded.images).filter(k => assetsLoaded.images[k]);
    const audNames = Object.keys(assetsLoaded.audio).filter(k => assetsLoaded.audio[k]);
    loadingEl.textContent = `Ảnh: ${imgNames.length}/${Object.keys(ASSETS.images).length}, Âm thanh: ${audNames.length}/${Object.keys(ASSETS.audio).length}`;
    setTimeout(() => { loadingEl.textContent = ''; }, 900);
  }

  function reset() {
    obstacles = [];
    particles.length = 0;
    score = 0;
    speed = 2.2;
    lastSpawn = 0;
    spawnInterval = 1000;
    car.w = Math.min(64, width * 0.12);
    car.h = Math.min(100, height * 0.16) * 0.5; // 50% shorter height as requested earlier
    // Move car up by CAR_VERTICAL_OFFSET so it's higher on screen
    car.x = (width - car.w) / 2;
    car.y = height - car.h - 28 - CAR_VERTICAL_OFFSET;
    car.vx = 0;
    car.tilt = 0;
    car.bobPhase = 0;
    lastExhaustAt = 0;
    // clear touch follow
    touchFollowActive = false;
    touchPointerId = null;
    touchClientX = 0;
    touchTargetX = null;
  }

  // helpers
  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
  function laneInfo() {
    const roadW = width * 0.7;
    const roadLeft = (width - roadW) / 2;
    const laneWidth = roadW / LANE_COUNT;
    const centers = [];
    for (let i=0;i<LANE_COUNT;i++) centers.push(roadLeft + i*laneWidth + laneWidth/2);
    return { roadW, roadLeft, laneWidth, centers };
  }

  // obstacle creation & spawn logic (kept same as previous)
  function createObstacleInLane(lane, w, h) {
    const { roadLeft, laneWidth } = laneInfo();
    const obsW = Math.min(w, Math.max(12, laneWidth - LANE_SIDE_PADDING*2));
    const x = roadLeft + lane*laneWidth + (laneWidth - obsW)/2;
    const spawnY = -h - 8;
    const r = Math.random();
    let type = 'static', params = {};
    if (r < 0.18) {
      type = 'sine';
      params = { amplitude: Math.min(laneWidth*0.28, 24 + Math.random()*28), phase: Math.random()*Math.PI*2, freq: 0.0015 + Math.random()*0.0025 };
    } else if (r < 0.34) {
      type = 'patrol';
      const otherLane = Math.max(0, Math.min(LANE_COUNT-1, lane + (Math.random()<0.5? -1:1)));
      const x2base = roadLeft + otherLane*laneWidth + (laneWidth - obsW)/2;
      params = { x1: x, x2: x2base, speed: 0.03 + Math.random()*0.06 };
    } else {
      type = 'static';
      params = {};
    }
    return { lane, x, y: spawnY - h, w: obsW, h, type, params, passed:false, anim:{ t:0 } };
  }

  function spawnObstacle() {
    const { roadLeft, laneWidth } = laneInfo();
    const spawnY = -10;
    const h = 28 + Math.random()*48;
    const baseW = laneWidth * (0.46 + Math.random()*0.12);
    const minVerticalGap = Math.max(Math.floor(car.h * 1.2), MIN_VERTICAL_GAP_BASE) + Math.min(200, Math.floor(speed * MIN_VERTICAL_GAP_SPEED_FACTOR));
    const lanes = shuffle([...Array(LANE_COUNT).keys()]);
    const safeLanes = [];
    for (const lane of lanes) {
      let nearest = Infinity;
      for (const ob of obstacles) {
        if (ob.lane === lane) {
          const dist = ob.y - spawnY;
          if (dist < nearest) nearest = dist;
        }
      }
      if (nearest === Infinity || nearest >= minVerticalGap) safeLanes.push(lane);
    }
    if (safeLanes.length === 0) return false;
    const lane1 = safeLanes[Math.floor(Math.random()*safeLanes.length)];
    obstacles.push(createObstacleInLane(lane1, baseW, h));
    if (Math.random() < SECOND_OBS_PROB && safeLanes.length > 1) {
      const others = safeLanes.filter(l => l !== lane1);
      shuffle(others);
      for (const cand of others) {
        if (AVOID_ADJACENT_SECOND && Math.abs(cand - lane1) === 1) {
          const wouldBlock = obstacles.some(ob => ob.lane !== lane1 && ob.lane !== cand && Math.abs(ob.y - spawnY) < minVerticalGap*0.9);
          if (wouldBlock) continue;
        }
        obstacles.push(createObstacleInLane(cand, baseW, h));
        break;
      }
    }
    return true;
  }

  // particles
  function spawnParticle(x,y,vx,vy,size,life,color) {
    if (particles.length > PARTICLE_MAX) return;
    particles.push({ x, y, vx, vy, size, life, birth: performance.now(), color, alpha:1 });
  }
  function updateParticles(dt) {
    const now = performance.now();
    for (let i = particles.length-1; i>=0; i--) {
      const p = particles[i];
      p.vy += 0.0006 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const t = now - p.birth;
      p.alpha = Math.max(0, 1 - t / p.life);
      if (t > p.life) particles.splice(i,1);
    }
  }
  function drawParticles() {
    for (const p of particles) {
      ctx.globalAlpha = p.alpha * 0.9;
      if (spriteMeta.exhaustImg) {
        const s = Math.max(6, p.size);
        ctx.drawImage(spriteMeta.exhaustImg, p.x - s/2, p.y - s/2, s, s);
      } else {
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(1, p.size/2), 0, Math.PI*2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
  }

  function rectsIntersect(a,b) {
    return !(a.x + a.w < b.x || a.x > b.x + b.w || a.y + a.h < b.y || a.y > b.y + b.h);
  }

  function drawShadow(x,y,w) {
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    ctx.ellipse(x + w/2, y, w*0.52, 8, 0, 0, Math.PI*2);
    ctx.fill();
    ctx.restore();
  }

  function drawCarFrame(ts) {
    car.bobPhase += CAR_BOB_SPEED * (ts - (car._lastBobTs || ts));
    car._lastBobTs = ts;
    const bob = Math.sin(car.bobPhase) * CAR_BOB_AMPLITUDE;
    car.tilt += (car._targetTilt || 0) - car.tilt;
    const tiltRad = (car.tilt * Math.PI) / 180;
    drawShadow(car.x, car.y + car.h + 6, car.w);
    ctx.save();
    ctx.translate(car.x + car.w/2, car.y + car.h/2 + bob);
    ctx.rotate(tiltRad);
    if (spriteMeta.car.img && spriteMeta.car.frames > 0) {
      const frameIndex = Math.floor((ts / (1000 / SPRITE_ANIM_FPS)) % spriteMeta.car.frames);
      const sx = frameIndex * spriteMeta.car.frameW;
      ctx.drawImage(spriteMeta.car.img, sx, 0, spriteMeta.car.frameW, spriteMeta.car.frameH, -car.w/2, -car.h/2, car.w, car.h);
    } else {
      ctx.fillStyle = '#ff4d6d';
      roundRect(ctx, -car.w/2, -car.h/2, car.w, car.h, 8);
      ctx.fill();
      ctx.fillStyle = '#ffffff66';
      ctx.fillRect(-car.w*0.18, -car.h*0.24, car.w*0.36, car.h*0.22);
      ctx.fillStyle = '#111';
      const rw = car.w*0.16, rh = car.h*0.18;
      ctx.fillRect(-car.w/2 - 2, -car.h/4, rw, rh);
      ctx.fillRect(car.w/2 - rw + 2, -car.h/4, rw, rh);
      ctx.fillRect(-car.w/2 - 2, car.h/8, rw, rh);
      ctx.fillRect(car.w/2 - rw + 2, car.h/8, rw, rh);
    }
    ctx.restore();
  }

  function drawObstacle(ob, ts) {
    if (ob.type === 'sine') {
      const amp = ob.params.amplitude;
      const dx = Math.sin((ts * ob.params.freq) + ob.params.phase) * amp;
      ob.xRender = ob.x + dx;
    } else if (ob.type === 'patrol') {
      if (!ob.params.dir) ob.params.dir = 1;
      ob.params.t = (ob.params.t || 0) + ob.params.speed * (ts - (ob._lastTS || ts));
      const span = ob.params.x2 - ob.params.x1;
      const prog = (Math.sin(ob.params.t) + 1) / 2;
      ob.xRender = ob.params.x1 + span * prog;
      ob._lastTS = ts;
    } else {
      ob.xRender = ob.x;
    }
    const distToCar = ob.y - car.y;
    const pulse = Math.max(0, Math.min(1, 1 - (distToCar / 220)));
    drawShadow(ob.xRender, ob.y + ob.h + 6, ob.w);
    if (spriteMeta.obstacle.img && spriteMeta.obstacle.frames > 0) {
      const frameIndex = Math.floor((ts / (1000 / SPRITE_ANIM_FPS)) % spriteMeta.obstacle.frames);
      const sx = frameIndex * spriteMeta.obstacle.frameW;
      ctx.globalAlpha = 1;
      ctx.drawImage(spriteMeta.obstacle.img, sx, 0, spriteMeta.obstacle.frameW, spriteMeta.obstacle.frameH, ob.xRender, ob.y, ob.w, ob.h);
      ctx.globalAlpha = 1;
    } else {
      ctx.save();
      ctx.fillStyle = '#6c757d';
      roundRect(ctx, ob.xRender, ob.y, ob.w, ob.h, 6);
      ctx.fill();
      ctx.fillStyle = `rgba(255,255,255,${0.06 + pulse*0.14})`;
      ctx.fillRect(ob.xRender + ob.w*0.12, ob.y + ob.h*0.25, ob.w*0.76, Math.max(3, ob.h*0.18));
      ctx.restore();
    }
  }

  function roundRect(ctx, x, y, w, h, r) {
    if (w < 2 * r) r = w / 2;
    if (h < 2 * r) r = h / 2;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function update(dt, ts) {
    speed += dt * 0.00005;
    spawnInterval = Math.max(520, 1100 - score * 4 - Math.floor(speed * 18));
    lastSpawn += dt;
    if (lastSpawn > spawnInterval) {
      const spawned = spawnObstacle();
      if (spawned) lastSpawn = 0;
      else lastSpawn = spawnInterval - SPAWN_RETRY_BACKOFF;
    }

    // MOVE: integrate keyboard, touch-follow and legacy touchSide
    const moveSpeed = MOVE_SPEED_BASE + Math.round(speed * 2.2);

    // compute targetVx from inputs:
    let targetVx = 0;

    // Keyboard left/right or on-screen buttons produce ±moveSpeed
    if (keys.left) targetVx -= moveSpeed;
    if (keys.right) targetVx += moveSpeed;

    // Legacy half-screen touch (fallback)
    if (!TOUCH_FOLLOW_ENABLED && touchSide === 'left') targetVx -= moveSpeed;
    if (!TOUCH_FOLLOW_ENABLED && touchSide === 'right') targetVx += moveSpeed;

    // Touch-follow: convert targetX (desired car.x) into a velocity
    if (TOUCH_FOLLOW_ENABLED && touchFollowActive && (touchTargetX !== null)) {
      // error margin (px) to stop jittering
      const dx = touchTargetX - car.x;
      // proportional controller to move toward target smoothly
      const k = 0.18; // responsiveness factor (increase to make following snappier)
      const derivedVx = dx * k;
      // clamp derivedVx to reasonable bounds
      const maxDerived = moveSpeed * 1.6;
      targetVx = Math.max(-maxDerived, Math.min(maxDerived, derivedVx));
    }

    // Smooth car.vx towards targetVx
    car.vx += (targetVx - car.vx) * 0.22;
    car.x += car.vx;

    // tilt target based on vx
    car._targetTilt = (-car.vx / (MOVE_SPEED_BASE + 8)) * CAR_TILT_MAX;

    // exhaust particles
    if (ts - lastExhaustAt > EXHAUST_RATE) {
      const exX = car.x + car.w/2 + (Math.random()-0.5)*6;
      const exY = car.y + car.h + 6;
      spawnParticle(exX, exY, (Math.random()-0.5)*0.03, 0.02, 6 + Math.random()*6, PARTICLE_LIFETIME, 'rgba(120,120,120,0.9)');
      lastExhaustAt = ts;
    }

  // skid particles
    if (Math.abs(car.vx) > SKID_THRESHOLD) {
      const skX = car.x + (car.vx > 0 ? 6 : car.w - 6);
      const skY = car.y + car.h - 6;
      if (Math.random() < 0.22) {
        spawnParticle(skX, skY, (Math.random()-0.5)*0.12, -0.02, 4 + Math.random()*4, 420 + Math.random()*240, 'rgba(60,60,60,0.85)');
      }
    }

    // confine to road
    const { roadLeft, laneWidth } = laneInfo();
    const roadRight = roadLeft + laneWidth * LANE_COUNT;
    if (car.x < roadLeft + 6) { car.x = roadLeft + 6; car.vx = 0; }
    if (car.x + car.w > roadRight - 6) { car.x = roadRight - 6 - car.w; car.vx = 0; }

    // update obstacles
    for (let i = obstacles.length-1; i>=0; i--) {
      const ob = obstacles[i];
      ob.y += speed * (1 + dt * 0.0015);
      if (ob.type === 'patrol') {
        ob.params.t = (ob.params.t || 0) + ob.params.speed * dt;
      }
      if (!ob.passed && ob.y > car.y + car.h) { ob.passed = true; score += 10; }
      if (ob.y > height + 240) obstacles.splice(i,1);
    }

    // update particles
    updateParticles(dt);

    // collision detection using ob.xRender approximation
    for (const ob of obstacles) {
      let obX = ob.x;
      if (ob.type === 'sine') {
        const amp = ob.params.amplitude;
        obX = ob.x + Math.sin((ts * ob.params.freq) + ob.params.phase) * amp;
      } else if (ob.type === 'patrol') {
        const span = ob.params.x2 - ob.params.x1;
        const prog = (Math.sin(ob.params.t || 0) + 1) / 2;
        obX = ob.params.x1 + span * prog;
      }
      const obRect = { x: obX, y: ob.y, w: ob.w, h: ob.h };
      if (rectsIntersect(car, obRect)) {
        running = false;
        for (let p = 0; p < 28; p++) {
          const ang = Math.random() * Math.PI*2;
          const mag = 0.06 + Math.random()*0.28;
          spawnParticle(car.x + car.w/2, car.y + car.h/2, Math.cos(ang)*mag, Math.sin(ang)*mag, 6 + Math.random()*6, 600 + Math.random()*600, 'rgba(220,80,80,0.95)');
        }
        if (assetsLoaded.audio && assetsLoaded.audio.hit) {
          try { assetsLoaded.audio.hit.currentTime = 0; assetsLoaded.audio.hit.play(); } catch(e){}
        }
        if (assetsLoaded.audio && assetsLoaded.audio.music) {
          try { assetsLoaded.audio.music.pause(); } catch(e){}
        }
        gameOver();
        break;
      }
    }
  }

  function render(ts) {
    ctx.clearRect(0,0,width,height);
    drawRoad();
    for (const ob of obstacles) drawObstacle(ob, ts);
    drawParticles();
    drawCarFrame(ts);
  }

  function loop(ts) {
    if (!lastTime) lastTime = ts;
    const dt = ts - lastTime;
    lastTime = ts;
    if (running) {
      update(dt, ts);
      render(ts);
      scoreEl.textContent = 'Điểm: ' + score;
      requestAnimationFrame(loop);
    } else {
      render(ts);
    }
  }

  // DRAW helpers (unchanged)
  function drawRoad() {
    const roadW = width * 0.7;
    const roadLeft = (width - roadW) / 2;
    ctx.fillStyle = '#222831';
    ctx.fillRect(roadLeft, 0, roadW, height);
    ctx.fillStyle = '#111418';
    ctx.fillRect(roadLeft - 10, 0, 10, height);
    ctx.fillRect(roadLeft + roadW, 0, 10, height);
    ctx.strokeStyle = '#ffffff22';
    ctx.lineWidth = 6;
    ctx.setLineDash([30,20]);
    ctx.beginPath();
    ctx.moveTo(width/2, 0);
    ctx.lineTo(width/2, height);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  function gameOver() {
    finalScore.textContent = 'Điểm: ' + score;
    startScreen.style.display = 'none';
    gameOverScreen.style.display = '';
    overlay.style.display = 'flex';
    scoreEl.textContent = 'Điểm: ' + score;
  }

  async function startGame() {
    try { if (assetsLoaded.audio && assetsLoaded.audio.music) await assetsLoaded.audio.music.play(); } catch(e){}
    reset();
    running = true;
    overlay.style.display = 'none';
    startScreen.style.display = 'none';
    gameOverScreen.style.display = 'none';
    lastTime = 0;
    requestAnimationFrame(loop);
  }

  // INPUT: keyboard (unchanged)
  window.addEventListener('keydown', e => {
    if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') keys.left = true;
    if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') keys.right = true;
  });
  window.addEventListener('keyup', e => {
    if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') keys.left = false;
    if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') keys.right = false;
  });

  // POINTER / TOUCH: enhanced handling
  // pointerdown: support both touch-follow and legacy half-screen touch
  canvas.addEventListener('pointerdown', (e) => {
    // if multiple pointers, only track the first for follow mode
    if (TOUCH_FOLLOW_ENABLED) {
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch (err) {}
      touchFollowActive = true;
      touchPointerId = e.pointerId;
      touchClientX = e.clientX;
      // compute targetX so car centers under finger
      const rect = canvas.getBoundingClientRect();
      const localX = touchClientX - rect.left;
      touchTargetX = localX - car.w/2;
      // clamp to road bounds
      const { roadLeft, laneWidth } = laneInfo();
      const roadRight = roadLeft + laneWidth * LANE_COUNT;
      const minX = roadLeft + 6;
      const maxX = roadRight - 6 - car.w;
      if (touchTargetX < minX) touchTargetX = minX;
      if (touchTargetX > maxX) touchTargetX = maxX;
      // disable legacy side mode
      touchSide = null;
    } else {
      // legacy: set side based on half-screen
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      touchSide = (x < rect.width / 2) ? 'left' : 'right';
    }
  });

  // pointermove: when following, update targetX
  canvas.addEventListener('pointermove', (e) => {
    if (!TOUCH_FOLLOW_ENABLED) return;
    if (!touchFollowActive) return;
    if (e.pointerId !== touchPointerId) return;
    // update clientX and targetX
    touchClientX = e.clientX;
    const rect = canvas.getBoundingClientRect();
    const localX = touchClientX - rect.left;
    touchTargetX = localX - car.w/2;
    // clamp to road immediately to avoid trying to move outside
    const { roadLeft, laneWidth } = laneInfo();
    const roadRight = roadLeft + laneWidth * LANE_COUNT;
    const minX = roadLeft + 6;
    const maxX = roadRight - 6 - car.w;
    if (touchTargetX < minX) touchTargetX = minX;
    if (touchTargetX > maxX) touchTargetX = maxX;
  });

  // pointerup / cancel: release follow and legacy flags
  window.addEventListener('pointerup', (e) => {
    if (TOUCH_FOLLOW_ENABLED) {
      if (e.pointerId === touchPointerId) {
        try { canvas.releasePointerCapture(touchPointerId); } catch(err){}
        touchFollowActive = false;
        touchPointerId = null;
        touchTargetX = null;
      }
    } else {
      touchSide = null;
    }
  });
  window.addEventListener('pointercancel', (e) => {
    if (TOUCH_FOLLOW_ENABLED) {
      if (e.pointerId === touchPointerId) {
        try { canvas.releasePointerCapture(touchPointerId); } catch(err){}
        touchFollowActive = false;
        touchPointerId = null;
        touchTargetX = null;
      }
    } else {
      touchSide = null;
    }
  });

  // Mobile on-screen controls (buttons) still work as before
  leftBtn.addEventListener('pointerdown', () => {
    if (TOUCH_FOLLOW_ENABLED) {
      // if touch-follow enabled, pressing the button will still set left key
      keys.left = true;
    } else {
      touchSide = 'left';
    }
  });
  leftBtn.addEventListener('pointerup', () => {
    keys.left = false;
    if (!TOUCH_FOLLOW_ENABLED) touchSide = null;
  });
  rightBtn.addEventListener('pointerdown', () => {
    if (TOUCH_FOLLOW_ENABLED) {
      keys.right = true;
    } else {
      touchSide = 'right';
    }
  });
  rightBtn.addEventListener('pointerup', () => {
    keys.right = false;
    if (!TOUCH_FOLLOW_ENABLED) touchSide = null;
  });
  leftBtn.addEventListener('pointerleave', () => { keys.left = false; if (!TOUCH_FOLLOW_ENABLED) touchSide = null; });
  rightBtn.addEventListener('pointerleave', () => { keys.right = false; if (!TOUCH_FOLLOW_ENABLED) touchSide = null; });

  // attach UI handlers:
  if (startBtn) {
    startBtn.addEventListener('click', async () => {
      // try fullscreen handled elsewhere (index.html version already calls tryEnterFullScreen)
      await loadAssets();
      await startGame();
    });
  }
  if (restartBtn) {
    restartBtn.addEventListener('click', () => startGame());
  }

  // initial UI
  overlay.style.display = 'flex';
  startScreen.style.display = '';
  gameOverScreen.style.display = 'none';
  scoreEl.textContent = 'Điểm: 0';

  // run resize once to ensure sizes ok
  resize();
})();