/**
 * The hero's sorting band: a cloud of raw samples drifts right into a labelling gate; each one
 * leaves as a tile in its label's lane, and the lane's count goes up when the tile reaches the end.
 */

type Lane = { name: string; fill: string; stroke: string; count: number; last: number };
type Sample = { x: number; y: number; vx: number; r: number; shade: number; seed: number; lane: number; sorted: boolean; t0: number; y0: number };
type Flash = { y0: number; y1: number; t: number };

const INK = "rgb(5,43,66)";
const SPEED = 92;
const TILE = 14;
const SPACING = 24;
const SAMPLES = 170;
const WARM_UP = 14;

export class Sorter {
  private lanes: Lane[] = [
    { name: "Normal", fill: "rgb(224,255,79)", stroke: INK, count: 312, last: -1 },
    { name: "Pneumonia", fill: "rgb(97,78,250)", stroke: "rgb(97,78,250)", count: 148, last: -1 },
    { name: "Effusion", fill: "rgb(58,142,245)", stroke: "rgb(58,142,245)", count: 96, last: -1 },
    { name: "Nodule", fill: INK, stroke: INK, count: 61, last: -1 },
    { name: "Other", fill: "rgb(223,226,255)", stroke: "rgb(97,78,250)", count: 203, last: -1 },
  ];
  private samples: Sample[] = [];
  private flashes: Flash[] = [];
  private time = 0;
  private gateX: number;
  private endX: number;
  private top: number;
  private laneH: number;
  private chips: boolean;

  constructor(private w: number, private h: number) {
    this.chips = w >= 640;
    this.gateX = Math.round(w * (this.chips ? 0.44 : 0.36));
    this.endX = this.chips ? w - 190 : w + TILE;
    this.laneH = Math.min(44, (h - 72) / this.lanes.length);
    this.top = (h - this.laneH * this.lanes.length) / 2 + 16;
    for (let i = 0; i < SAMPLES; i++) this.samples.push(this.raw(Math.random() * this.gateX * 1.1 - w * 0.1));
    for (let t = 0; t < WARM_UP; t += 1 / 30) this.step(1 / 30);
  }

  private laneY = (i: number) => this.top + this.laneH * (i + 0.5);

  private raw(x: number): Sample {
    // Lanes are uneven on purpose: real label distributions are.
    const pick = Math.random();
    const lane = pick < 0.3 ? 0 : pick < 0.52 ? 1 : pick < 0.7 ? 2 : pick < 0.82 ? 3 : 4;
    const g = (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;
    return {
      x,
      y: this.h / 2 + g * this.h * 0.55,
      vx: 26 + Math.random() * 50,
      r: 1.4 + Math.random() * 3.4,
      shade: Math.random(),
      seed: Math.random() * 100,
      lane,
      sorted: false,
      t0: 0,
      y0: 0,
    };
  }

  step(dt: number) {
    this.time += dt;
    const t = this.time;
    const gap = SPACING / SPEED;
    for (let i = 0; i < this.samples.length; i++) {
      const s = this.samples[i];
      if (!s.sorted) {
        s.x += s.vx * dt;
        s.y += Math.sin(t * 1.4 + s.seed) * 14 * dt;
        // Near the gate the cloud funnels toward the band.
        const pull = Math.max(0, (s.x - this.gateX * 0.55) / (this.gateX * 0.45));
        s.y += (this.h / 2 - s.y) * pull * 0.9 * dt;
        if (s.x >= this.gateX) {
          const lane = this.lanes[s.lane];
          if (t - lane.last >= gap * (1 + Math.random() * 0.8)) {
            lane.last = t;
            s.sorted = true;
            s.t0 = t;
            s.y0 = s.y;
            s.x = this.gateX;
            this.flashes.push({ y0: s.y, y1: this.laneY(s.lane), t });
          } else s.x = this.gateX - 1 - Math.random() * 3;
        }
      } else {
        s.x += SPEED * dt;
        const k = Math.min(1, (t - s.t0) / 0.55);
        s.y = s.y0 + (this.laneY(s.lane) - s.y0) * (1 - Math.pow(1 - k, 3));
        if (s.x > this.endX) {
          this.lanes[s.lane].count++;
          this.samples[i] = this.raw(-20 - Math.random() * 60);
        }
      }
    }
    this.flashes = this.flashes.filter((f) => t - f.t < 0.7);
  }

  draw(ctx: CanvasRenderingContext2D) {
    const { w, h, gateX, endX, time: t } = this;
    ctx.clearRect(0, 0, w, h);

    ctx.strokeStyle = "rgba(5,43,66,0.07)";
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 6]);
    for (let i = 0; i < this.lanes.length; i++) {
      ctx.beginPath();
      ctx.moveTo(gateX, this.laneY(i));
      ctx.lineTo(endX, this.laneY(i));
      ctx.stroke();
    }
    ctx.setLineDash([]);

    for (const s of this.samples) {
      if (s.sorted) continue;
      const fade = Math.min(1, (s.x + 20) / 120);
      ctx.fillStyle = `rgba(5,43,66,${(0.12 + 0.38 * s.shade) * fade})`;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }

    // The gate: a lime bar with a soft glow and a breathing core.
    const g0 = this.top - this.laneH * 0.6;
    const g1 = this.top + this.laneH * (this.lanes.length + 0.6);
    ctx.save();
    ctx.shadowColor = "rgb(224,255,79)";
    ctx.shadowBlur = 18 + 8 * Math.sin(t * 2.2);
    ctx.fillStyle = "rgb(196,236,24)";
    ctx.beginPath();
    ctx.roundRect(gateX - 1.5, g0, 3, g1 - g0, 2);
    ctx.fill();
    ctx.fill();
    ctx.restore();

    ctx.lineWidth = 1.5;
    for (const f of this.flashes) {
      const a = (t - f.t) / 0.7;
      ctx.strokeStyle = `rgba(5,43,66,${0.35 * (1 - a)})`;
      ctx.beginPath();
      ctx.moveTo(gateX, f.y0);
      ctx.bezierCurveTo(gateX + 24, f.y0, gateX + 24, f.y1, gateX + 52, f.y1);
      ctx.stroke();
      ctx.strokeStyle = `rgba(150,190,0,${1 - a})`;
      ctx.beginPath();
      ctx.arc(gateX, f.y0, 3 + a * 12, 0, Math.PI * 2);
      ctx.stroke();
    }

    for (const s of this.samples) {
      if (!s.sorted) continue;
      const lane = this.lanes[s.lane];
      const k = Math.min(1, (t - s.t0) / 0.35);
      const size = s.r * 2 + (TILE - s.r * 2) * k;
      ctx.globalAlpha = Math.min(1, (endX - s.x) / 60);
      ctx.fillStyle = lane.fill;
      ctx.strokeStyle = lane.stroke;
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      ctx.roundRect(s.x - size / 2, s.y - size / 2, size, size, 3 + (1 - k) * size);
      ctx.fill();
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    ctx.font = "600 11px 'Inter Variable', sans-serif";
    ctx.textBaseline = "middle";
    ctx.fillStyle = INK;
    const label = "labelling";
    const lw = ctx.measureText(label).width + 16;
    ctx.beginPath();
    ctx.roundRect(gateX - lw / 2, g0 - 26, lw, 20, 10);
    ctx.fill();
    ctx.fillStyle = "white";
    ctx.fillText(label, gateX - lw / 2 + 8, g0 - 16);

    if (!this.chips) return;
    ctx.font = "500 13px 'Inter Variable', sans-serif";
    for (let i = 0; i < this.lanes.length; i++) {
      const lane = this.lanes[i];
      const y = this.laneY(i);
      const x = endX + 14;
      ctx.fillStyle = "rgba(5,43,66,0.05)";
      ctx.beginPath();
      ctx.roundRect(x, y - 13, 166, 26, 13);
      ctx.fill();
      ctx.fillStyle = lane.fill;
      ctx.strokeStyle = lane.stroke;
      ctx.beginPath();
      ctx.roundRect(x + 9, y - 5, 10, 10, 2.5);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = INK;
      ctx.textAlign = "left";
      ctx.fillText(lane.name, x + 27, y + 0.5);
      ctx.textAlign = "right";
      ctx.fillStyle = "rgba(5,43,66,0.55)";
      ctx.fillText(lane.count.toLocaleString("en-US"), x + 154, y + 0.5);
    }
    ctx.textAlign = "left";
  }

  fits(w: number, h: number) {
    return w === this.w && h === this.h;
  }
}
