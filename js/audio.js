// Процедурный звук на Web Audio: двигатель с коробкой передач, шины, ветер, дождь,
// удары с металлическим звоном, бьющееся стекло, взрыв, клаксон, фоновый гул города.

const GEARS = [0.17, 0.31, 0.48, 0.68, 0.88, 1.06]; // доля максималки, на которой включается следующая
const IDLE = 850, REDLINE = 6800;

export function createAudio() {
  let ac = null, master, comp, noiseBuf, muted = false;
  const N = {}; // постоянные узлы
  let gear = 0, shiftT = 0, rpm = IDLE;

  function noiseSource() {
    const s = ac.createBufferSource();
    s.buffer = noiseBuf; s.loop = true;
    s.loopStart = Math.random(); s.loopEnd = 1.9;
    s.start(0, Math.random() * 1.5);
    return s;
  }
  function filter(type, f, q = 0.7) { const b = ac.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b; }
  function gain(v = 0) { const g = ac.createGain(); g.gain.value = v; return g; }
  function shaper(k) {
    const ws = ac.createWaveShaper();
    const n = 1024, c = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(x * k) / Math.tanh(k); }
    ws.curve = c; ws.oversample = '2x';
    return ws;
  }
  const chain = (...nodes) => { for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]); return nodes[nodes.length - 1]; };

  function build() {
    master = gain(0.9);
    comp = ac.createDynamicsCompressor();
    comp.threshold.value = -16; comp.ratio.value = 4; comp.attack.value = 0.004; comp.release.value = 0.2;
    chain(master, comp, ac.destination);
    // буфер «розоватого» шума
    const len = ac.sampleRate * 2;
    noiseBuf = ac.createBuffer(1, len, ac.sampleRate);
    const d = noiseBuf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + w * 0.099; b1 = 0.963 * b1 + w * 0.2965; b2 = 0.57 * b2 + w * 1.0526;
      d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.25;
    }

    // ---- двигатель: гармоники частоты вспышек + шум сгорания с амплитудной модуляцией
    N.eng = gain(0);
    N.engLP = filter('lowpass', 600, 1.2);
    N.engShape = shaper(2.2);
    N.engMix = gain(0.5);
    N.o1 = ac.createOscillator(); N.o1.type = 'sawtooth';
    N.o2 = ac.createOscillator(); N.o2.type = 'sawtooth'; N.o2.detune.value = 7;
    N.o3 = ac.createOscillator(); N.o3.type = 'triangle';
    N.o4 = ac.createOscillator(); N.o4.type = 'square';
    const g1 = gain(0.5), g2 = gain(0.25), g3 = gain(0.6), g4 = gain(0.08);
    N.o1.connect(g1); N.o2.connect(g2); N.o3.connect(g3); N.o4.connect(g4);
    for (const g of [g1, g2, g3, g4]) g.connect(N.engMix);
    // шум сгорания, модулированный частотой вспышек
    const cn = noiseSource();
    N.combBP = filter('bandpass', 400, 0.9);
    N.combAM = gain(0.0);
    N.amOsc = ac.createOscillator(); N.amOsc.type = 'sine';
    N.amDepth = gain(0.5);
    N.amOsc.connect(N.amDepth); N.amDepth.connect(N.combAM.gain);
    chain(cn, N.combBP, N.combAM, N.engMix);
    chain(N.engMix, N.engShape, N.engLP, N.eng, master);
    // впуск/выхлоп: шипение под нагрузкой
    const inn = noiseSource();
    N.intakeBP = filter('bandpass', 1200, 0.6);
    N.intake = gain(0);
    chain(inn, N.intakeBP, N.intake, master);
    for (const o of [N.o1, N.o2, N.o3, N.o4, N.amOsc]) o.start();

    // ---- шины
    const tn = noiseSource();
    N.tireBP1 = filter('bandpass', 1100, 7); N.tireBP2 = filter('bandpass', 2300, 9);
    N.tire = gain(0);
    tn.connect(N.tireBP1); tn.connect(N.tireBP2);
    N.tireBP1.connect(N.tire); N.tireBP2.connect(N.tire);
    N.tire.connect(master);
    // шорох колёс по асфальту
    const rn = noiseSource();
    N.roll = gain(0);
    chain(rn, filter('lowpass', 380, 0.5), N.roll, master);

    // ---- ветер
    const wn = noiseSource();
    N.windF = filter('bandpass', 500, 0.4);
    N.wind = gain(0);
    chain(wn, N.windF, N.wind, master);

    // ---- дождь: шелест + капли
    const ran = noiseSource();
    N.rain = gain(0);
    chain(ran, filter('highpass', 700, 0.5), filter('lowpass', 7500, 0.5), N.rain, master);
    const ran2 = noiseSource();
    N.rainLow = gain(0);
    chain(ran2, filter('lowpass', 260, 0.5), N.rainLow, master);

    // ---- город
    const cityN = noiseSource();
    N.city = gain(0.035);
    chain(cityN, filter('lowpass', 160, 0.5), N.city, master);

    // ---- сирена полиции: «вой» с медленной модуляцией
    N.siren = gain(0);
    const so = ac.createOscillator(); so.type = 'square'; so.frequency.value = 950;
    const lfo = ac.createOscillator(); lfo.frequency.value = 0.45;
    const lfoG = gain(330);
    chain(lfo, lfoG); lfoG.connect(so.frequency);
    const so2 = ac.createOscillator(); so2.type = 'triangle'; so2.frequency.value = 1900;
    const lfo2G = gain(660); lfo.connect(lfo2G); lfo2G.connect(so2.frequency);
    const sMix = gain(0.5);
    so.connect(sMix); so2.connect(sMix);
    chain(sMix, filter('bandpass', 1300, 0.8), N.siren, master);
    for (const o of [so, so2, lfo]) o.start();

    // ---- клаксон: два тона, искажение, «рупор»
    N.horn = gain(0);
    const hShape = shaper(3);
    const hBP = filter('bandpass', 900, 1.1);
    for (const f of [370, 466]) { const o = ac.createOscillator(); o.type = 'square'; o.frequency.value = f; o.connect(hShape); o.start(); }
    chain(hShape, hBP, N.horn, master);
  }

  function env(g, t, peak, attack, decay) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }
  function burst(type, f, q, peak, attack, decay, when = 0) {
    const t = ac.currentTime + when;
    const s = ac.createBufferSource(); s.buffer = noiseBuf;
    const fl = filter(type, f, q), g = gain(0);
    chain(s, fl, g, master);
    env(g, t, peak, attack, decay);
    s.start(t, Math.random()); s.stop(t + attack + decay + 0.05);
    return fl;
  }
  function ping(f, peak, decay, when = 0, type = 'sine') {
    const t = ac.currentTime + when;
    const o = ac.createOscillator(); o.type = type; o.frequency.value = f;
    const g = gain(0);
    chain(o, g, master);
    env(g, t, peak, 0.002, decay);
    o.start(t); o.stop(t + decay + 0.05);
    return o;
  }
  function thump(f0, f1, peak, decay) {
    const t = ac.currentTime;
    const o = ac.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + decay);
    const g = gain(0);
    chain(o, g, master);
    env(g, t, peak, 0.004, decay);
    o.start(t); o.stop(t + decay + 0.05);
  }

  return {
    start() {
      if (ac) { if (ac.state === 'suspended') ac.resume(); return; }
      try { ac = new (window.AudioContext || window.webkitAudioContext)(); build(); } catch (e) { ac = null; }
    },
    // speed — ед/с, maxV — максималка, throttle 0/1, skid — скорость бокового скольжения
    update(dt, speed, maxV, throttle, skid, rainK, dead) {
      if (!ac) return;
      const t = ac.currentTime;
      const v = Math.abs(speed) / maxV;
      // коробка передач
      if (gear < GEARS.length - 1 && v > GEARS[gear] * 0.97) { gear++; shiftT = 0.18; }
      else if (gear > 0 && v < GEARS[gear - 1] * 0.72) { gear--; shiftT = 0.1; }
      const lo = gear ? GEARS[gear - 1] * 0.72 : 0, hi = GEARS[gear];
      let target = IDLE + Math.max(0, (v - lo * 0.55) / (hi - lo * 0.55)) * (REDLINE - IDLE) * 0.92;
      if (v < 0.03) target = IDLE + (throttle ? 1800 : 0);
      if (shiftT > 0) { shiftT -= dt; target *= 0.82; }
      if (dead) target = 0;
      rpm += (target - rpm) * Math.min(1, dt * (throttle ? 9 : 5));
      const fire = Math.max(1, rpm / 30); // 4 цилиндра: вспышки = об/мин / 30
      const load = throttle && shiftT <= 0 ? 1 : 0.35;
      const k = 0.04;
      N.o1.frequency.setTargetAtTime(fire, t, k);
      N.o2.frequency.setTargetAtTime(fire * 2, t, k);
      N.o3.frequency.setTargetAtTime(fire * 0.5, t, k);
      N.o4.frequency.setTargetAtTime(fire * 3.01, t, k);
      N.amOsc.frequency.setTargetAtTime(fire, t, k);
      N.combBP.frequency.setTargetAtTime(300 + fire * 3, t, k);
      N.engLP.frequency.setTargetAtTime(250 + rpm * 0.18 + load * 900, t, 0.06);
      N.eng.gain.setTargetAtTime(dead || muted ? 0 : 0.16 + load * 0.12 + (rpm / REDLINE) * 0.08, t, 0.06);
      N.combAM.gain.setTargetAtTime(0.4 + load * 0.5, t, 0.05);
      N.intakeBP.frequency.setTargetAtTime(600 + rpm * 0.25, t, 0.05);
      N.intake.gain.setTargetAtTime(muted || dead ? 0 : load * (rpm / REDLINE) * 0.06, t, 0.08);
      // шины, качение, ветер
      const sk = Math.min(1, Math.max(0, (skid - 50) / 160)) * Math.min(1, Math.abs(speed) / 120);
      N.tire.gain.setTargetAtTime(muted ? 0 : sk * 0.22, t, 0.04);
      N.tireBP1.frequency.setTargetAtTime(950 + sk * 400 + Math.random() * 60, t, 0.03);
      N.roll.gain.setTargetAtTime(muted ? 0 : Math.min(1, v * 1.5) * 0.12, t, 0.1);
      N.windF.frequency.setTargetAtTime(300 + v * 900, t, 0.2);
      N.wind.gain.setTargetAtTime(muted ? 0 : v * v * 0.16, t, 0.2);
      N.rain.gain.setTargetAtTime(muted ? 0 : rainK * 0.07, t, 0.4);
      N.rainLow.gain.setTargetAtTime(muted ? 0 : rainK * 0.06, t, 0.4);
      N.city.gain.setTargetAtTime(muted ? 0 : 0.035, t, 0.5);
      // редкие крупные капли по крыше
      if (!muted && rainK > 0.1 && Math.random() < rainK * dt * 25) ping(2500 + Math.random() * 3500, 0.012 * rainK, 0.03);
    },
    crash(power) {
      if (!ac || muted) return;
      const k = Math.min(1, power / 450);
      thump(110, 38, 0.35 + k * 0.5, 0.25 + k * 0.2);
      burst('lowpass', 1800 + k * 2500, 0.8, 0.3 + k * 0.5, 0.003, 0.12 + k * 0.2);
      burst('bandpass', 700, 1.5, 0.15 + k * 0.3, 0.005, 0.3 + k * 0.3, 0.02);
      // металлический звон: неглубокие негармонические призвуки
      const n = 2 + Math.round(k * 4);
      for (let i = 0; i < n; i++) ping(300 + Math.random() * 1900, 0.03 + k * 0.05, 0.25 + Math.random() * 0.5, Math.random() * 0.05, 'triangle');
      if (k > 0.55) this.glass(k * 0.7);
    },
    glass(k = 1) {
      if (!ac || muted) return;
      burst('highpass', 3200, 0.7, 0.18 * k + 0.05, 0.002, 0.18);
      const n = 8 + Math.round(k * 10);
      for (let i = 0; i < n; i++) ping(2600 + Math.random() * 4800, 0.02 + Math.random() * 0.04 * k, 0.04 + Math.random() * 0.12, Math.random() * 0.45);
    },
    lampHit() {
      if (!ac || muted) return;
      thump(140, 60, 0.4, 0.2);
      // гудящий удар по металлической трубе
      ping(196, 0.12, 1.2, 0, 'triangle'); ping(523, 0.06, 0.9, 0, 'triangle'); ping(1170, 0.03, 0.6);
      this.glass(0.9);
      // треск проводки
      for (let i = 0; i < 5; i++) burst('bandpass', 4000, 4, 0.06, 0.001, 0.02, 0.05 + Math.random() * 0.4);
    },
    thud(k) {
      if (!ac || muted) return;
      thump(160, 70, 0.25 * k + 0.1, 0.12);
      burst('lowpass', 500, 0.7, 0.2 * k + 0.05, 0.004, 0.1);
    },
    explode() {
      if (!ac || muted) return;
      thump(80, 25, 0.9, 1.1);
      const f = burst('lowpass', 2500, 0.5, 0.9, 0.005, 1.8);
      f.frequency.setValueAtTime(2500, ac.currentTime);
      f.frequency.exponentialRampToValueAtTime(180, ac.currentTime + 1.6);
      for (let i = 0; i < 6; i++) burst('bandpass', 300 + Math.random() * 800, 1, 0.15, 0.002, 0.3, 0.1 + Math.random() * 0.8);
      this.glass(1);
    },
    siren(level) { if (ac) N.siren.gain.setTargetAtTime(muted ? 0 : level * level * 0.07, ac.currentTime, 0.2); },
    horn(on) { if (ac) N.horn.gain.setTargetAtTime(on && !muted ? 0.09 : 0, ac.currentTime, 0.015); },
    toggle() { muted = !muted; return muted; },
  };
}
