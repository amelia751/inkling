// A rung-4 sandboxed viewer (todo10 Phase 5) for PLY point clouds, a format the Studio has no
// viewer for. anywidget shape: render({ model, el, signal, host }). It runs in the MCP Apps
// sandbox: no network, no Studio DOM; bytes come from host.readAsset, labels from the model, and
// annotations go back as typed geometries through host.annotations.propose.
// Packed into ui/contributions.json (`config.module`) when the plugin is built.

function parsePly(bytes) {
  const head = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 4096)));
  const end = head.indexOf("end_header");
  if (!head.startsWith("ply") || end < 0) throw new Error("not a PLY file");
  const lines = head.slice(0, end).split(/\r?\n/);
  const format = (lines.find((l) => l.startsWith("format ")) || "").split(" ")[1];
  let count = 0, inVertex = false;
  const props = [];
  for (const l of lines) {
    const t = l.trim().split(/\s+/);
    if (t[0] === "element") { inVertex = t[1] === "vertex"; if (inVertex) count = +t[2]; }
    else if (t[0] === "property" && inVertex) props.push({ type: t[1], name: t[2] });
  }
  const body = head.indexOf("\n", end) + 1;
  const ix = (n) => props.findIndex((p) => p.name === n);
  const [xi, yi, zi, ri, gi, bi] = ["x", "y", "z", "red", "green", "blue"].map(ix);
  if (xi < 0 || yi < 0 || zi < 0) throw new Error("no x/y/z vertex properties");
  const xyz = new Float32Array(count * 3), rgb = ri >= 0 ? new Uint8Array(count * 3) : null;
  if (format === "ascii") {
    const rows = new TextDecoder().decode(bytes.subarray(body)).split(/\r?\n/);
    for (let i = 0; i < count; i++) {
      const v = rows[i].trim().split(/\s+/).map(Number);
      xyz.set([v[xi], v[yi], v[zi]], i * 3);
      if (rgb) rgb.set([v[ri], v[gi], v[bi]], i * 3);
    }
  } else if (format === "binary_little_endian") {
    const size = { char: 1, uchar: 1, int8: 1, uint8: 1, short: 2, ushort: 2, int16: 2, uint16: 2, int: 4, uint: 4, int32: 4, uint32: 4, float: 4, float32: 4, double: 8, float64: 8 };
    const offs = []; let stride = 0;
    for (const p of props) { offs.push(stride); stride += size[p.type]; }
    const dv = new DataView(bytes.buffer, bytes.byteOffset + body);
    const read = (o, t) => (t.startsWith("float") ? (t === "float64" ? dv.getFloat64(o, true) : dv.getFloat32(o, true)) : t === "double" ? dv.getFloat64(o, true) : dv.getUint8(o));
    for (let i = 0; i < count; i++) {
      const base = i * stride;
      xyz.set([read(base + offs[xi], props[xi].type), read(base + offs[yi], props[yi].type), read(base + offs[zi], props[zi].type)], i * 3);
      if (rgb) rgb.set([dv.getUint8(base + offs[ri]), dv.getUint8(base + offs[gi]), dv.getUint8(base + offs[bi])], i * 3);
    }
  } else throw new Error("unsupported PLY format " + format);
  return { count, xyz, rgb };
}

function bounds(xyz) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < xyz.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], xyz[i + k]); hi[k] = Math.max(hi[k], xyz[i + k]); }
  return { lo, hi };
}

export default {
  async render({ model, el, signal, host }) {
    const item = model.get("item");
    const asset = item.assets[0];
    el.innerHTML = `<div style="display:flex;flex-direction:column;height:100vh">
      <div id="bar" style="display:flex;gap:6px;align-items:center;padding:6px 8px;border-bottom:1px solid #ddd;flex-wrap:wrap">
        <strong id="name"></strong><span id="info" style="color:#666"></span><span style="flex:1"></span><span id="classes"></span><span id="status" role="status" style="color:#666"></span>
      </div>
      <canvas id="ply-canvas" style="flex:1;min-height:200px;width:100%;cursor:grab;background:#111"></canvas></div>`;
    el.querySelector("#name").textContent = item.name;
    const canvas = el.querySelector("#ply-canvas");
    const status = el.querySelector("#status");
    const cloud = parsePly(await host.readAsset(asset.path));
    if (signal.aborted) return;
    const { lo, hi } = bounds(cloud.xyz);
    const center = lo.map((l, k) => (l + hi[k]) / 2);
    const radius = Math.max(...hi.map((h, k) => h - lo[k])) / 2 || 1;
    el.querySelector("#info").textContent = `${cloud.count.toLocaleString()} points`;
    canvas.dataset.points = String(cloud.count);
    await host.runtime.publish("viewer.pointCloud", { points: cloud.count, bounds: { min: lo, max: hi } });

    let yaw = 0.6, pitch = 0.4;
    function draw() {
      const w = (canvas.width = canvas.clientWidth * devicePixelRatio), h = (canvas.height = canvas.clientHeight * devicePixelRatio);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#111"; ctx.fillRect(0, 0, w, h);
      const s = (Math.min(w, h) / 2.4) / radius, cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
      const px = Math.max(1, devicePixelRatio);
      for (let i = 0; i < cloud.count; i++) {
        const x = cloud.xyz[i * 3] - center[0], y = cloud.xyz[i * 3 + 1] - center[1], z = cloud.xyz[i * 3 + 2] - center[2];
        const x1 = cy * x + sy * z, z1 = -sy * x + cy * z, y1 = cp * y - sp * z1;
        if (cloud.rgb) ctx.fillStyle = `rgb(${cloud.rgb[i * 3]},${cloud.rgb[i * 3 + 1]},${cloud.rgb[i * 3 + 2]})`;
        else { const t = (z - lo[2] + center[2]) / (hi[2] - lo[2] || 1); ctx.fillStyle = `hsl(${240 - 240 * t},80%,60%)`; }
        ctx.fillRect(w / 2 + x1 * s, h / 2 - y1 * s, px, px);
      }
    }
    let drag = null;
    canvas.addEventListener("pointerdown", (e) => { drag = { x: e.clientX, y: e.clientY, yaw, pitch }; canvas.setPointerCapture(e.pointerId); }, { signal });
    canvas.addEventListener("pointermove", (e) => { if (!drag) return; yaw = drag.yaw + (e.clientX - drag.x) / 150; pitch = drag.pitch + (e.clientY - drag.y) / 150; draw(); }, { signal });
    canvas.addEventListener("pointerup", () => { drag = null; }, { signal });
    const ro = new ResizeObserver(draw); ro.observe(canvas);
    signal.addEventListener("abort", () => ro.disconnect());

    // Item-level classes through the typed geometry API (geometry { type: "class" }).
    const classes = el.querySelector("#classes");
    const accepts = model.get("geometries") || [];
    if (accepts.includes("class")) for (const l of model.get("labels") || []) {
      const b = document.createElement("button");
      b.textContent = l.name; b.dataset.label = l.name;
      b.style.cssText = `border:1px solid ${l.color || "#999"};border-radius:4px;background:transparent;padding:2px 8px;cursor:pointer`;
      b.addEventListener("click", async () => {
        const r = await host.annotations.propose([{ label: l.name, geometry: { type: "class" }, attributes: { points: cloud.count } }]);
        status.textContent = r.added ? `suggested ${l.name}` : `rejected: ${r.rejected.join("; ")}`;
      }, { signal });
      classes.appendChild(b);
    }
    draw();
  },
};
