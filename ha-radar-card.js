class HaRadarCard extends HTMLElement {
  // --- 静态常量 ---
  static SCAN_PERIOD = 4000;           // 扫描周期 (ms)
  static HIGHLIGHT_LIFETIME = 4000;    // 高亮持续时间 (ms)
  static ANGLE_TOLERANCE = 3 * Math.PI / 180; // 角度容差 (弧度)
  static CANVAS_SIZE = 800;
  static RADIUS = 330;
  static STAR_COUNT = 300;
  static CONSTELLATION_THRESHOLD = 50;
  static CONNECTION_PROB = 0.015;
  static DIR_NAMES = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                      'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

  constructor() {
    super();
    this._config = null;
    this._hass = null;
    this._targets = [];
    this._home = { lat: 0, lon: 0 };
    this._scanAngle = 0;
    this._highlights = [];
    this._cacheHistory = [];
    this._animId = null;
    this._lastTimestamp = 0;
    this._bgMode = 'solid';
    this._maxDistance = 15;
    this._minDistance = 1;
    this._currentMaxDist = 15;
    this._lastCacheTime = 0;
    this._rotationAngle = 0;
    this._rotationPeriod = 60;
    this._stars = [];
    this._constellationLines = [];
    this._cx = HaRadarCard.CANVAS_SIZE / 2;
    this._cy = HaRadarCard.CANVAS_SIZE / 2;
    this._radius = HaRadarCard.RADIUS;
  }

  _extractCoordinates(state) {
    let lat = NaN, lon = NaN;
    if (state) {
      lat = parseFloat(state.attributes?.latitude ?? state.attributes?.lat);
      lon = parseFloat(state.attributes?.longitude ?? state.attributes?.lon);
      if (isNaN(lat) || isNaN(lon)) {
        const loc = state.attributes?.Location;
        if (Array.isArray(loc) && loc.length >= 2) {
          lat = parseFloat(loc[0]);
          lon = parseFloat(loc[1]);
        }
      }
      if (isNaN(lat) || isNaN(lon)) {
        const stateVal = state.state;
        if (stateVal && typeof stateVal === 'string') {
          const parts = stateVal.split(',');
          if (parts.length === 2) {
            lat = parseFloat(parts[0]);
            lon = parseFloat(parts[1]);
          }
        }
      }
    }
    return { lat, lon };
  }

  _extractAddress(attributes) {
    const addrParts = [];
    const keyMap = [
      'Country', 'country',
      'Administrative Area', 'administrative_area',
      'Locality', 'locality',
      'Sub Locality', 'sub_locality',
      'Thoroughfare', 'thoroughfare',
      'Street', 'street',
      'Address', 'address',
      'City', 'city',
      'State', 'state',
      'Region', 'region'
    ];
    for (const key of keyMap) {
      const val = attributes?.[key];
      if (val && typeof val === 'string' && val.trim()) {
        addrParts.push(val.trim());
      }
    }
    if (addrParts.length === 0 && attributes?.['Areas Of Interest'] && Array.isArray(attributes['Areas Of Interest'])) {
      addrParts.push(attributes['Areas Of Interest'].join('、'));
    }
    return addrParts.join('') || null;
  }

  setConfig(config) {
    this._config = config;
    this._bgMode = config.background || 'solid';
    this._maxDistance = config.max_distance || 15;
    this._minDistance = config.min_distance || 1;
    
    if (this._bgMode === 'star') {
      this._rotationPeriod = config.star_rotation_period || 60;
    }
    
    this._cacheHistory = [];

    if (config.persons && Array.isArray(config.persons)) {
      this._targets = config.persons.map((p, idx) => {
        const color = p.color || '#FFFFFF';
        const rgb = this._hexToRgb(color);
        return {
          id: idx,
          name: p.name || p.entity,
          entity: p.entity,
          color: color,
          rgb: rgb,
          x: 0,
          y: 0,
          active: false,
          distance: 0,
          address: '',
        };
      });
    }

    this._highlights = this._targets.map((t) => ({
      ...t,
      triggerTime: 0,
      active: false,
    }));

    this._createCanvas();

    if (this._animId) cancelAnimationFrame(this._animId);
    this._lastTimestamp = 0;
    this._animId = requestAnimationFrame((t) => this._animate(t));
  }

  set hass(hass) {
    this._hass = hass;

    const homeEntity = this._config?.home_entity;
    if (homeEntity && hass.states[homeEntity]) {
      const st = hass.states[homeEntity];
      const { lat, lon } = this._extractCoordinates(st);
      if (!isNaN(lat) && !isNaN(lon)) {
        this._home.lat = lat;
        this._home.lon = lon;
      }
    } else if (this._config?.home_lat !== undefined) {
      this._home.lat = this._config.home_lat;
      this._home.lon = this._config.home_lon;
    }

    this._targets.forEach((t, idx) => {
      const state = hass.states[t.entity];
      if (state) {
        const { lat, lon } = this._extractCoordinates(state);
        if (!isNaN(lat) && !isNaN(lon)) {
          const dx = (lon - this._home.lon) * 111;
          const dy = (lat - this._home.lat) * 111;
          t.x = dx;
          t.y = dy;
          t.distance = Math.sqrt(dx * dx + dy * dy);
        }

        const address = this._extractAddress(state.attributes);
        t.address = address || `${t.x.toFixed(4)}, ${t.y.toFixed(4)}`;
      }
    });

    this._autoAdjustScale();

    this._highlights.forEach((hl, idx) => {
      const t = this._targets[idx];
      if (t) {
        hl.address = t.address;
        hl.name = t.name;
        hl.rgb = t.rgb;
        hl.color = t.color;
        hl.x = t.x;
        hl.y = t.y;
        hl.distance = t.distance;
      }
    });

    this._checkHighlights();
    this._drawRadar();
  }

  _autoAdjustScale() {
    let maxDist = 0;
    for (const t of this._targets) {
      if (t.distance > maxDist) maxDist = t.distance;
    }
    if (maxDist < 0.1) {
      this._currentMaxDist = this._maxDistance;
      return;
    }
    this._currentMaxDist = Math.max(this._minDistance, Math.min(this._maxDistance, maxDist * 1.2));
  }

  _hexToRgb(hex) {
    const r = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return r ? { r: parseInt(r[1], 16), g: parseInt(r[2], 16), b: parseInt(r[3], 16) } : { r: 255, g: 255, b: 255 };
  }

  _createCanvas() {
    if (!this._canvas) {
      const wrapper = document.createElement('div');
      wrapper.style.cssText = 'position:relative;width:100%;max-width:800px;margin:0 auto;';

      this._canvas = document.createElement('canvas');
      this._canvas.width = HaRadarCard.CANVAS_SIZE;
      this._canvas.height = HaRadarCard.CANVAS_SIZE;
      this._canvas.style.cssText = 'width:100%;display:block;border-radius:16px;background:#0a120a;';

      wrapper.appendChild(this._canvas);

      this._infoPanel = document.createElement('div');
      this._infoPanel.style.cssText = `
        padding: 10px 14px;
        background: #0a1a0a;
        border-radius: 8px;
        margin-top: 10px;
        color: #33cc33;
        font-family: 'Courier New', monospace;
        font-size: 13px;
        border: 1px solid #1a4a1a;
        line-height: 1.6;
        max-height: 200px;
        overflow-y: auto;
      `;
      wrapper.appendChild(this._infoPanel);

      this.appendChild(wrapper);
    }
  }

  _drawRadar() {
    if (!this._canvas) return;
    const ctx = this._canvas.getContext('2d');
    const W = HaRadarCard.CANVAS_SIZE, H = HaRadarCard.CANVAS_SIZE;
    const cx = this._cx, cy = this._cy, RADIUS = this._radius;

    ctx.clearRect(0, 0, W, H);

    this._drawBackground(ctx, cx, cy, RADIUS);
    this._drawGrid(ctx, cx, cy, RADIUS);
    this._drawSweep(ctx, cx, cy, RADIUS);
    this._drawHighlights(ctx, cx, cy, RADIUS);
    this._drawHome(ctx, cx, cy);

    this._updateInfoPanel();
  }

  _generateStars(radius) {
    if (this._stars.length > 0) return;
    const count = HaRadarCard.STAR_COUNT;
    const maxR = radius * 0.95;
    this._stars = [];
    for (let i = 0; i < count; i++) {
      const r = Math.random() * maxR;
      const theta = Math.random() * 2 * Math.PI;
      const brightness = 0.3 + Math.random() * 0.7;
      const size = 1 + Math.random() * 2.5;
      this._stars.push({ r, theta, brightness, size });
    }

    this._constellationLines = [];
    const threshold = HaRadarCard.CONSTELLATION_THRESHOLD;
    const prob = HaRadarCard.CONNECTION_PROB;
    for (let i = 0; i < this._stars.length; i++) {
      for (let j = i + 1; j < this._stars.length; j++) {
        const s1 = this._stars[i];
        const s2 = this._stars[j];
        const dx = s1.r * Math.cos(s1.theta) - s2.r * Math.cos(s2.theta);
        const dy = s1.r * Math.sin(s1.theta) - s2.r * Math.sin(s2.theta);
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < threshold && Math.random() < prob) {
          this._constellationLines.push([i, j]);
        }
      }
    }
  }

  _drawStarField(ctx, cx, cy, radius) {
    this._generateStars(radius);
    const angleRad = (this._rotationAngle % 360) * Math.PI / 180;

    for (const star of this._stars) {
      const x = cx + star.r * Math.cos(star.theta + angleRad);
      const y = cy + star.r * Math.sin(star.theta + angleRad);
      const alpha = star.brightness * 0.8 + 0.2;
      ctx.beginPath();
      ctx.arc(x, y, star.size, 0, Math.PI * 2);
      const r = 20 + 60 * star.brightness;
      const g = 150 + 105 * star.brightness;
      const b = 20 + 80 * star.brightness;
      ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;
      ctx.fill();
      if (star.brightness > 0.7) {
        ctx.shadowColor = `rgba(0, 255, 100, ${alpha * 0.3})`;
        ctx.shadowBlur = 8;
        ctx.fill();
        ctx.shadowBlur = 0;
      }
    }

    ctx.strokeStyle = 'rgba(0, 200, 100, 0.3)';
    ctx.lineWidth = 0.8;
    for (const [i, j] of this._constellationLines) {
      const s1 = this._stars[i];
      const s2 = this._stars[j];
      if (!s1 || !s2) continue;
      const x1 = cx + s1.r * Math.cos(s1.theta + angleRad);
      const y1 = cy + s1.r * Math.sin(s1.theta + angleRad);
      const x2 = cx + s2.r * Math.cos(s2.theta + angleRad);
      const y2 = cy + s2.r * Math.sin(s2.theta + angleRad);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }
  }

  _drawBackground(ctx, cx, cy, RADIUS) {
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, RADIUS);
    grad.addColorStop(0, '#0a1a0a');
    grad.addColorStop(0.7, '#050f05');
    grad.addColorStop(1, '#020802');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, RADIUS, 0, Math.PI * 2);
    ctx.fill();

    if (this._bgMode === 'star') {
      this._drawStarField(ctx, cx, cy, RADIUS);
    }

    ctx.strokeStyle = 'rgba(0,180,0,0.6)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, RADIUS, 0, Math.PI * 2);
    ctx.stroke();
  }

  _drawGrid(ctx, cx, cy, RADIUS) {
    const maxR = RADIUS;
    const rings = 6;

    for (let i = 1; i <= rings; i++) {
      const ratio = i / rings;
      const r = ratio * maxR;
      if (r > RADIUS) break;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.strokeStyle = i === rings ? 'rgba(0,255,0,0.85)' : 'rgba(0,255,0,0.5)';
      ctx.lineWidth = i === rings ? 1.5 : 1.0;
      ctx.stroke();
    }

    const dirNames = HaRadarCard.DIR_NAMES;
    const angleStep = (Math.PI * 2) / 16;
    const labelRadius = RADIUS + 28;

    for (let i = 0; i < 16; i++) {
      const angle = i * angleStep - Math.PI / 2;
      const x = cx + Math.cos(angle) * labelRadius;
      const y = cy + Math.sin(angle) * labelRadius;
      ctx.fillStyle = (i % 4 === 0) ? 'rgba(255, 255, 255, 0.95)' : 'rgba(255, 255, 255, 0.8)';
      ctx.font = (i % 4 === 0) ? 'bold 15px "Courier New", monospace' : '13px "Courier New", monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(dirNames[i], x, y);
    }

    for (let i = 0; i < 16; i++) {
      const angle = i * angleStep - Math.PI / 2;
      const x = cx + Math.cos(angle) * RADIUS;
      const y = cy + Math.sin(angle) * RADIUS;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(x, y);
      ctx.strokeStyle = (i % 4 === 0) ? 'rgba(0,255,0,0.45)' : 'rgba(0,200,0,0.3)';
      ctx.lineWidth = (i % 4 === 0) ? 1.2 : 0.8;
      ctx.stroke();
    }

    ctx.strokeStyle = 'rgba(0,255,0,0.4)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 8]);
    ctx.beginPath();
    ctx.moveTo(cx - RADIUS, cy);
    ctx.lineTo(cx + RADIUS, cy);
    ctx.moveTo(cx, cy - RADIUS);
    ctx.lineTo(cx, cy + RADIUS);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  _drawSweep(ctx, cx, cy, RADIUS) {
    const half = 25 * Math.PI / 180;
    const startA = this._scanAngle - half;
    const endA = this._scanAngle + half;

    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, RADIUS);
    grad.addColorStop(0, 'rgba(0,255,0,0.10)');
    grad.addColorStop(0.5, 'rgba(0,200,0,0.06)');
    grad.addColorStop(1, 'rgba(0,150,0,0.02)');
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, RADIUS, startA, endA);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(this._scanAngle) * RADIUS, cy + Math.sin(this._scanAngle) * RADIUS);
    ctx.strokeStyle = 'rgba(0,255,0,0.40)';
    ctx.lineWidth = 2;
    ctx.shadowColor = 'rgba(0,255,0,0.3)';
    ctx.shadowBlur = 20;
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  _drawHighlights(ctx, cx, cy, RADIUS) {
    const now = Date.now();
    const LIFETIME = HaRadarCard.HIGHLIGHT_LIFETIME;
    const displayMaxKm = this._currentMaxDist || 15;

    for (const hl of this._highlights) {
      if (!hl.active) continue;
      const age = now - hl.triggerTime;
      if (age > LIFETIME) {
        hl.active = false;
        continue;
      }
      const alpha = 1 - age / LIFETIME;
      if (alpha <= 0.01) continue;

      const dx = hl.x;
      const dy = hl.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const ratio = dist / displayMaxKm;
      const displayR = Math.min(ratio, 1.0) * RADIUS;
      if (displayR < 1) continue;

      const angle = Math.atan2(dy, dx);
      const px = cx + Math.cos(angle) * displayR;
      const py = cy - Math.sin(angle) * displayR;

      const r = hl.rgb.r, g = hl.rgb.g, b = hl.rgb.b;

      const glowSize = 30 + 20 * alpha;
      const glow = ctx.createRadialGradient(px, py, 0, px, py, glowSize);
      glow.addColorStop(0, `rgba(${r},${g},${b},${0.35 * alpha})`);
      glow.addColorStop(0.4, `rgba(${r},${g},${b},${0.15 * alpha})`);
      glow.addColorStop(1, `rgba(${r},${g},${b},0)`);
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(px, py, glowSize, 0, Math.PI * 2);
      ctx.fill();

      const coreSize = 8 + 6 * alpha;
      ctx.shadowColor = `rgba(${r},${g},${b},${0.8 * alpha})`;
      ctx.shadowBlur = 25 * alpha;
      ctx.beginPath();
      ctx.arc(px, py, coreSize, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${r},${g},${b},${0.9 * alpha})`;
      ctx.fill();
      ctx.shadowBlur = 0;

      const text = `${hl.name} ${hl.distance.toFixed(1)}km`;
      ctx.font = 'bold 12px "Courier New", monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const metrics = ctx.measureText(text);
      const tw = metrics.width + 8;
      const th = 18;
      const tx = px - tw / 2;
      const ty = py + 18;
      ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
      ctx.shadowBlur = 0;
      ctx.beginPath();
      ctx.roundRect(tx, ty, tw, th, 4);
      ctx.fill();
      ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
      ctx.shadowColor = 'rgba(0,0,0,0.8)';
      ctx.shadowBlur = 6;
      ctx.fillText(text, px, py + 20);
      ctx.shadowBlur = 0;

      const angleDeg = (angle * 180 / Math.PI) % 360;
      const azimuth = (90 - angleDeg + 360) % 360;
      const dirIdx = Math.round(azimuth / 22.5) % 16;
      ctx.fillStyle = `rgba(255,255,255,0.25)`;
      ctx.font = '9px "Courier New", monospace';
      ctx.fillText(HaRadarCard.DIR_NAMES[dirIdx], px, py - 22);
    }
  }

  _drawHome(ctx, cx, cy) {
    const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, 25);
    glow.addColorStop(0, 'rgba(0,255,0,0.15)');
    glow.addColorStop(1, 'rgba(0,255,0,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(cx, cy, 25, 0, Math.PI * 2);
    ctx.fill();

    ctx.beginPath();
    ctx.arc(cx, cy, 6, 0, Math.PI * 2);
    ctx.fillStyle = '#33ff33';
    ctx.shadowColor = 'rgba(0,255,0,0.6)';
    ctx.shadowBlur = 20;
    ctx.fill();
    ctx.shadowBlur = 0;

    const cross = 12;
    ctx.strokeStyle = 'rgba(0,255,0,0.5)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx - cross, cy);
    ctx.lineTo(cx + cross, cy);
    ctx.moveTo(cx, cy - cross);
    ctx.lineTo(cx, cy + cross);
    ctx.stroke();

    ctx.fillStyle = 'rgba(0,255,0,0.5)';
    ctx.font = '11px "Courier New", monospace';
    ctx.textAlign = 'center';
    ctx.fillText('🏠 家', cx, cy + 30);
  }

  _updateInfoPanel() {
    if (!this._infoPanel) return;

    const deg = ((this._scanAngle * 180 / Math.PI) % 360 + 360) % 360;
    const degFormatted = deg.toFixed(1).padStart(5, '0');
    const cacheCount = this._cacheHistory.length;
    const activeList = this._highlights.filter(h => h.active);
    const activeCount = activeList.length;
    const maxDist = this._currentMaxDist.toFixed(1);

    let html = `
      <div style="display:flex;flex-wrap:wrap;gap:8px 16px;margin-bottom:8px;font-size:13px;">
        <span>🔄 扫描角度: ${degFormatted}°</span>
        <span>📦 缓存记录: ${cacheCount}</span>
        <span>✨ 活跃亮点: ${activeCount}</span>
        <span>📏 扫描范围: ${maxDist} km</span>
      </div>
    `;

    if (activeCount > 0) {
      html += `<div style="border-top:1px solid #1a4a1a;padding-top:6px;margin-top:4px;">`;
      for (const hl of activeList) {
        const addr = hl.address || '未知地址';
        html += `
          <div style="display:flex;align-items:flex-start;gap:6px;font-size:12px;padding:3px 0;">
            <span style="color:#33ff33;flex-shrink:0;">●</span>
            <span style="flex-shrink:0;font-weight:bold;color:#ccffcc;">${hl.name}</span>
            <span style="flex:1;word-break:break-word;color:#88dd88;text-align:left;">${addr}</span>
          </div>
        `;
      }
      html += `</div>`;
    }

    this._infoPanel.innerHTML = html;
  }

  _checkHighlights() {
    const now = Date.now();
    const TOLERANCE = HaRadarCard.ANGLE_TOLERANCE;
    const LIFETIME = HaRadarCard.HIGHLIGHT_LIFETIME;

    if (this._cacheHistory.length > 0 && this._cacheHistory[0].points.length !== this._targets.length) {
      this._cacheHistory = [];
    }

    if (!this._lastCacheTime || (now - this._lastCacheTime) > 1000) {
      const pts = this._targets.map(t => ({ x: t.x, y: t.y }));
      this._cacheHistory.push({ time: now, points: pts });
      if (this._cacheHistory.length > 4) this._cacheHistory.shift();
      this._lastCacheTime = now;
    }

    if (this._cacheHistory.length === 0 || this._targets.length === 0) return;

    for (let i = 0; i < this._targets.length; i++) {
      const t = this._targets[i];
      if (!t) continue;
      let matched = false;

      for (let idx = this._cacheHistory.length - 1; idx >= 0; idx--) {
        const record = this._cacheHistory[idx];
        const p = record.points[i];
        if (!p) continue;
        const dist = Math.sqrt(p.x * p.x + p.y * p.y);
        if (dist < 0.05) continue;

        const angle = Math.atan2(-p.y, p.x);
        let diff = angle - this._scanAngle;
        while (diff > Math.PI) diff -= 2 * Math.PI;
        while (diff < -Math.PI) diff += 2 * Math.PI;

        if (Math.abs(diff) <= TOLERANCE) {
          const hl = this._highlights[i];
          if (hl) {
            hl.x = p.x;
            hl.y = p.y;
            hl.triggerTime = now;
            hl.active = true;
            const target = this._targets[i];
            if (target) {
              hl.address = target.address;
              hl.name = target.name;
              hl.rgb = target.rgb;
              hl.color = target.color;
            }
            matched = true;
          }
          break;
        }
      }
    }

    for (const hl of this._highlights) {
      if (hl.active) {
        const age = now - hl.triggerTime;
        if (age > LIFETIME) {
          hl.active = false;
        }
      }
    }
  }

  _animate(timestamp) {
    if (!this._lastTimestamp) this._lastTimestamp = timestamp;
    const delta = timestamp - this._lastTimestamp;
    this._lastTimestamp = timestamp;

    const angleStep = (delta / HaRadarCard.SCAN_PERIOD) * 2 * Math.PI;
    this._scanAngle += angleStep;
    if (this._scanAngle > 2 * Math.PI) {
      this._scanAngle -= 2 * Math.PI;
    }

    if (this._bgMode === 'star') {
      const periodMs = this._rotationPeriod * 1000;
      this._rotationAngle += (delta / periodMs) * 360;
      this._rotationAngle %= 360;
    }

    this._checkHighlights();
    this._drawRadar();
    this._animId = requestAnimationFrame((t) => this._animate(t));
  }

  connectedCallback() { }

  disconnectedCallback() {
    if (this._animId) cancelAnimationFrame(this._animId);
  }
}

if (!CanvasRenderingContext2D.prototype.roundRect) {
  CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {
    if (r > w / 2) r = w / 2;
    if (r > h / 2) r = h / 2;
    this.moveTo(x + r, y);
    this.lineTo(x + w - r, y);
    this.quadraticCurveTo(x + w, y, x + w, y + r);
    this.lineTo(x + w, y + h - r);
    this.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    this.lineTo(x + r, y + h);
    this.quadraticCurveTo(x, y + h, x, y + h - r);
    this.lineTo(x, y + r);
    this.quadraticCurveTo(x, y, x + r, y);
    return this;
  };
}

customElements.define('ha-radar-card', HaRadarCard);