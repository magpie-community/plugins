// The office: a voxel space-station room drawn on a canvas, in isometric 3D
// or a flat top-down 2D, with one little worker per agent session. Where a
// worker is shows what it is doing: at a desk while it thinks, runs tools or
// replies; in the purple square when it needs you; on the sofa when it is
// done (asleep once it has been done a while); at the broken console on an
// error. A classic script: it sets globalThis.AgentOfficeScene.
(() => {
  const ROOM = { w: 16, d: 12, wall: 3.1 }

  // ---- colours ---------------------------------------------------------
  function rgb(c) {
    if (c.startsWith("hsl")) {
      const [h, s, l] = c.match(/[\d.]+/g).map(Number)
      const a = (s / 100) * Math.min(l / 100, 1 - l / 100)
      const f = (n) => { const k = (n + h / 30) % 12; return Math.round(255 * (l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))) }
      return [f(0), f(8), f(4)]
    }
    const h = c.replace("#", "")
    const n = parseInt(h.length === 3 ? h.replace(/./g, "$&$&") : h, 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  }
  const shadeCache = new Map()
  function shade(c, f) {
    const k = c + f
    let v = shadeCache.get(k)
    if (v) return v
    const [r, g, b] = rgb(c)
    const m = (x) => Math.max(0, Math.min(255, Math.round(f < 0 ? x * (1 + f) : x + (255 - x) * f)))
    v = `rgb(${m(r)},${m(g)},${m(b)})`
    shadeCache.set(k, v)
    return v
  }

  const SKIN = ["#f2c7a5", "#e8b48a", "#c98d62", "#8d5a3b", "#f5d6bf"]
  const HAIR = ["#2b2118", "#5a3825", "#a0522d", "#1f2937", "#d4a24c", "#7c2d12", "#111111", "#c2410c"]
  const PANTS = ["#334155", "#1e3a8a", "#374151", "#3f3f46", "#78350f"]

  // ---- the room's furniture and where workers go ---------------------
  // A seat is where a worker sits; `face` is the way they look — toward
  // the desk, away from the sofa's back, into the room. The monitor, the
  // chair's back and the head all follow from it (FACE below).
  const DESKS = [
    { x: 3.2, y: 0.55, w: 1.7, d: 0.9, seat: [4.05, 1.95], face: "n" },
    { x: 5.9, y: 0.55, w: 1.7, d: 0.9, seat: [6.75, 1.95], face: "n" },
    { x: 8.6, y: 0.55, w: 1.7, d: 0.9, seat: [9.45, 1.95], face: "n" },
    { x: 11.3, y: 0.55, w: 1.7, d: 0.9, seat: [12.15, 1.95], face: "n" },
    // the island: two desks back to back, the sitters facing each other
    { x: 10.6, y: 4.6, w: 1.6, d: 0.8, seat: [11.4, 4.0], face: "s", island: true },
    { x: 12.4, y: 4.6, w: 1.6, d: 0.8, seat: [13.2, 4.0], face: "s", island: true },
    { x: 10.6, y: 5.4, w: 1.6, d: 0.8, seat: [11.4, 6.75], face: "n", island: true },
    { x: 12.4, y: 5.4, w: 1.6, d: 0.8, seat: [13.2, 6.75], face: "n", island: true },
  ]
  const SOFA = [[1.1, 4.84], [1.1, 5.72], [1.1, 6.6], [1.1, 7.48], [1.1, 8.36], [3.1, 10.95], [4.3, 10.95]]
  // Its backrest is to the west of the left sofa and to the south of the
  // front one, so a sitter looks east and north respectively.
  const SOFA_FACE = ["e", "e", "e", "e", "e", "n", "n"]
  // a direction as a vector; the camera looks from +y, +x
  const FACE = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0] }
  // Entry/exit points are on the aisle side, never behind a backrest.
  const SOFA_APPROACH = SOFA.map(([x, y], i) => i < 5 ? [2.05, y] : [x, 10.0])
  const ZONE = { x: 4.2, y: 7.2, w: 4.4, d: 3.4 }
  const ZONE_SPOTS = []
  for (let j = 0; j < 3; j++) for (let i = 0; i < 4; i++) ZONE_SPOTS.push([ZONE.x + 0.6 + i * 1.05 + (j % 2) * 0.3, ZONE.y + 0.6 + j * 1.05])
  const ERROR_SPOTS = [[12.3, 9.6], [14.5, 8.6], [12.9, 10.45], [14.6, 10.3]]
  const WANDER = [[7.0, 4.4], [8.6, 5.7], [6.0, 5.8], [9.0, 8.0], [10.2, 9.0], [4.9, 4.8], [5.0, 3.4], [9.6, 2.9], [2.4, 6.0]]
  const DOOR = [0.6, 2.6]

  // ---- activity venues -------------------------------------------------
  // A finished worker doesn't only sleep on the sofa any more: it drifts
  // to a venue, lingers a while, then drifts on. Each venue has a front
  // approach on the side the camera sees (south or east) and a facing that
  // looks at the furniture, so a reader can tell what it is doing.
  const ACTIVITIES = [
    { id: "bookshelf", label: "READING", x: 1.45, y: 0.5, w: 1.6, d: 0.55, ax: 2.25, ay: 1.65, face: "n", lz: 2.4, color: "#fcd34d" },
    { id: "arcade", label: "ARCADE", x: 2.5, y: 3.2, w: 0.9, d: 0.7, ax: 3.95, ay: 3.55, face: "w", lz: 1.95, color: "#38bdf8" },
    { id: "meeting", label: "HUDDLE", x: 6.9, y: 2.55, w: 1.7, d: 0.95, ax: 7.75, ay: 3.95, face: "n", lz: 2.05, color: "#a78bfa" },
    { id: "pingpong", label: "PING-PONG", x: 9.55, y: 7.15, w: 1.9, d: 1.05, ax: 10.5, ay: 8.85, face: "n", lz: 1.15, color: "#34d399" },
    { id: "coffee", label: "COFFEE", x: 14.35, y: 2.15, w: 1.35, d: 0.85, ax: 14.9, ay: 3.4, face: "n", lz: 1.55, color: "#fb923c" },
  ]
  const POIS = ACTIVITIES
  const POI_APPROACHES = ACTIVITIES.map((a) => [a.ax, a.ay, a.face])
  // The sofa seats are venues too: a worker that has finished for a while
  // may curl up there instead of standing at a table.
  const ACTIVITY_SPOTS = [
    ...ACTIVITIES.map((a) => [a.ax, a.ay, a.face]),
    ...SOFA.map(([x, y], i) => [x, y, SOFA_FACE[i]]),
  ]

  // What stands on the floor and can't be walked through, and the places a
  // worker goes, which are free even inside a piece of furniture (a seat).
  const BLOCKERS = [
    ...ACTIVITIES.map((a) => [a.x, a.y, a.w, a.d]),
    ...DESKS.map((d) => [d.x, d.y, d.w, d.d]),
    [0, 4.1, 1.5, 5.0], // full sofa and the gap behind its backrest
    [2.5, 10.55, 2.4, 1.45], // full sofa and rear wall gap
    [6.3, 5.2, 1.6, 1.6], // the holo table
    [1.85, 9.65, 0.9, 0.9], // drums
    [8.4, 10.5, 1.35, 1.25], // crates
    [12.65, 8.85, 1.2, 1.2], // the reactor
    [14.3, 6.6, 1.2, 1.6], // the broken console
    [14.0, 0.5, 1.6, 1.0], // the console on the far wall
  ]
  const FREE = [...DESKS.map((d) => d.seat), ...SOFA_APPROACH, ...ZONE_SPOTS, ...ERROR_SPOTS, ...WANDER, ...ACTIVITIES.map((a) => [a.ax, a.ay]), DOOR]

  // A coarse grid of where a worker may walk, and the shortest way across
  // it: eight neighbours, diagonals only when both sides are free, then
  // the corners are cut away so the walk looks like a person's.
  const CELL = 0.3
  const NAV = (() => {
    const w = Math.ceil(ROOM.w / CELL), h = Math.ceil(ROOM.d / CELL)
    const blocked = new Uint8Array(w * h)
    const R = 0.17 // half a worker's breadth: keeps them off the furniture's edge
    const near = (x, y, x0, y0, x1, y1, pad) => x >= x0 - pad && x <= x1 + pad && y >= y0 - pad && y <= y1 + pad
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const x = i * CELL + CELL / 2, y = j * CELL + CELL / 2
        let b = x < 0.42 + R || y < 0.42 + R || x > ROOM.w - 0.42 - R || y > ROOM.d - 0.42 - R ? 1 : 0
        for (const [bx, by, bw, bd] of BLOCKERS) if (near(x, y, bx, by, bx + bw, by + bd, R)) b = 1
        // a seat is standable even when it sits on a piece of furniture
        for (const [fx, fy] of FREE) if (near(x, y, fx, fy, fx, fy, 0.2)) b = 0
        blocked[j * w + i] = b
      }
    }
    const inside = (i, j) => i >= 0 && j >= 0 && i < w && j < h
    const free = (i, j) => inside(i, j) && !blocked[j * w + i]
    const freeAt = (x, y) => free(Math.floor(x / CELL), Math.floor(y / CELL))
    // the nearest free cell to a point that is in one
    function open(x, y) {
      const i0 = Math.floor(x / CELL), j0 = Math.floor(y / CELL)
      if (free(i0, j0)) return [i0, j0]
      for (let r = 1; r < 30; r++) {
        for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue
          if (free(i0 + di, j0 + dj)) return [i0 + di, j0 + dj]
        }
      }
      return [i0, j0]
    }
    // Visit every crossed grid cell, including both sides of a corner.
    // Coarse distance sampling can miss a tiny slice of an obstacle.
    const clear = (a, b) => {
      const dx = b[0] - a[0], dy = b[1] - a[1]
      const cuts = [0, 1]
      for (const [start, delta] of [[a[0], dx], [a[1], dy]]) {
        if (Math.abs(delta) < 1e-10) continue
        const lo = Math.min(start, start + delta), hi = Math.max(start, start + delta)
        for (let n = Math.floor(lo / CELL) + 1; n * CELL < hi; n++) {
          cuts.push((n * CELL - start) / delta)
        }
      }
      cuts.sort((x, y) => x - y)
      let previous = null
      for (let k = 0; k < cuts.length - 1; k++) {
        if (cuts[k + 1] - cuts[k] < 1e-10) continue
        const t = (cuts[k] + cuts[k + 1]) / 2
        const i = Math.floor((a[0] + dx * t) / CELL), j = Math.floor((a[1] + dy * t) / CELL)
        if (!free(i, j)) return false
        if (previous && i !== previous[0] && j !== previous[1] &&
            (!free(i, previous[1]) || !free(previous[0], j))) return false
        previous = [i, j]
      }
      return freeAt(...a) && freeAt(...b)
    }
    // from one point to another, as the corners to walk by
    function corridor(from, to) {
      if (!freeAt(...from) || !freeAt(...to)) return []
      const [si, sj] = open(from[0], from[1])
      const [gi, gj] = open(to[0], to[1])
      const start = sj * w + si, goal = gj * w + gi
      if (start === goal) return [[to[0], to[1]]]
      const prev = new Int32Array(w * h).fill(-1)
      prev[start] = start
      const q = [start]
      for (let head = 0; head < q.length; head++) {
        const c = q[head]
        if (c === goal) break
        const ci = c % w, cj = (c - ci) / w
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue
          const ni = ci + di, nj = cj + dj
          if (!free(ni, nj)) continue
          // no slipping between two pieces that touch at a corner
          if (di && dj && (!free(ci + di, cj) || !free(ci, cj + dj))) continue
          const n = nj * w + ni
          if (prev[n] !== -1) continue
          prev[n] = c
          q.push(n)
        }
      }
      if (prev[goal] === -1) return [] // never fall back to walking through furniture
      const cells = []
      for (let c = goal; c !== start; c = prev[c]) cells.push(c)
      cells.push(start)
      cells.reverse()
      const pts = cells.map((c) => { const i = c % w; return [i * CELL + CELL / 2, ((c - i) / w) * CELL + CELL / 2] })
      pts[0] = [from[0], from[1]]
      pts[pts.length - 1] = [to[0], to[1]]
      // cut the corners: keep a point only when the way past it isn't clear
      const out = []
      let i = 0
      while (i < pts.length - 1) {
        let j = pts.length - 1
        while (j > i + 1 && !clear(pts[i], pts[j])) j--
        out.push(pts[j])
        i = j
      }
      if (!out.length) out.push(pts[pts.length - 1])
      return out
    }
    const seatAt = p => SOFA.findIndex(q => Math.hypot(q[0] - p[0], q[1] - p[1]) < 0.04)
    function path(from, to, transit = null) {
      if (Math.hypot(to[0] - from[0], to[1] - from[1]) < 0.001) return []
      const entry = seatAt(to)
      const exit = Number.isInteger(transit) ? transit : seatAt(from)
      const a = exit >= 0 ? SOFA_APPROACH[exit] : from
      const b = entry >= 0 ? SOFA_APPROACH[entry] : to
      const middle = corridor(a, b)
      if (!middle.length) return []
      // Third coordinate identifies a controlled boarding/alighting segment.
      return [...(exit >= 0 ? [[...a, exit]] : []), ...middle,
        ...(entry >= 0 ? [[...to, entry]] : [])]
    }
    return { w, h, CELL, blocked, free, freeAt, path, open, clear }

  })()

  function rnd(seed, i) {
    let x = (seed ^ Math.imul(i + 1, 0x9e3779b1)) >>> 0
    x ^= x >>> 16; x = Math.imul(x, 0x85ebca6b) >>> 0; x ^= x >>> 13
    return (x >>> 0) / 4294967296
  }

  function idlePose(w, time, reduced = false) {
    const neutral = { kind: "rest", amount: 0, phase: 0 }
    if (reduced || w.walking || w.a.status !== "done") return neutral
    const seed = w.a.seed || 0
    const cycle = Math.floor((time + (seed % 19)) / 22)
    const phase = ((time + (seed % 19)) % 22 + 22) % 22
    if (phase >= 4) return neutral
    return { kind: ["stretch", "look", "swing", "doze"][(seed + cycle) % 4],
      amount: Math.sin(Math.PI * phase / 4), phase }
  }

  // ---- local time of day ------------------------------------------------
  // The office follows the viewer's clock: dawn warms the glass, day is a
  // cool blue, dusk goes pink, night is the dark space station again. Pure:
  // an hour or a Date in, a palette out (the tests use it directly).
  const SKY_PHASES = {
    night: { sky: ["#05070f", "#0b1020"], star: 1, glass: "rgba(120,170,255,.09)", ambient: "rgba(10,16,32,.16)", planet: 1, label: "night" },
    dawn: { sky: ["#17162e", "#3a2438"], star: 0.35, glass: "rgba(251,146,60,.15)", ambient: "rgba(251,146,60,.06)", planet: 0.85, label: "dawn" },
    day: { sky: ["#0d1b2e", "#1e3a5f"], star: 0.06, glass: "rgba(147,197,253,.22)", ambient: "rgba(147,197,253,.05)", planet: 0.7, label: "day" },
    dusk: { sky: ["#21132b", "#4a2440"], star: 0.45, glass: "rgba(244,114,182,.17)", ambient: "rgba(244,114,182,.05)", planet: 0.9, label: "dusk" },
  }
  function phaseOfHour(hour) {
    const h = ((Number.isFinite(hour) ? hour : 12) % 24 + 24) % 24
    if (h >= 5 && h < 7.5) return "dawn"
    if (h >= 7.5 && h < 17) return "day"
    if (h >= 17 && h < 19.5) return "dusk"
    return "night"
  }
  function dayPhase(when) {
    let hour
    if (when instanceof Date) hour = when.getHours() + when.getMinutes() / 60
    else if (typeof when === "number" && Number.isFinite(when)) hour = when
    else { const d = new Date(); hour = d.getHours() + d.getMinutes() / 60 }
    const phase = phaseOfHour(hour)
    return { phase, hour: ((hour % 24) + 24) % 24, ...SKY_PHASES[phase] }
  }

  // a finished worker lingers 8–30 s at a venue before drifting to another
  function activityDwell(seed) {
    return Math.round((8 + rnd(seed >>> 0, 71) * 22) * 10) / 10
  }

  // how far the camera may zoom and pan; pan is a fraction of the canvas so
  // a corner can be inspected but the office can never be lost
  const CAMERA = { minZoom: 1, maxZoom: 4, panMargin: 0.12, smooth: 0.18 }

  class Scene {
    constructor(canvas, opts = {}) {
      this.c = canvas
      this.g = canvas.getContext("2d")
      this.dim = opts.dim === "2d" ? "2d" : "3d"
      this.onFrame = opts.onFrame || (() => {})
      this.workers = new Map()
      this.t = 0
      this.last = 0
      this.running = false
      this.first = true
      this.cam = { x: 0, y: 0, z: 1 }
      this.roomBox = null
      this.dayState = null
      this.phaseOverride = null
      this.cat = opts.cat === false ? null : { seed: 0 }
      this.reducedMotion = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches || false
      this.stars = Array.from({ length: 140 }, (_, i) => [rnd(7, i), rnd(11, i), rnd(13, i)])
      this.resize()
      this.bindInput()
    }

    // ---- geometry ----------------------------------------------------
    // rawP is the fitted room projected with no camera; P adds pan and zoom
    // about the canvas centre, so every anchor, bubble and hit test follows.
    rawP(x, y, z = 0) {
      if (this.dim === "3d") return [this.ox + (x - y) * this.s * 0.866, this.oy + (x + y) * this.s * 0.5 - z * this.s]
      return [this.ox + x * this.s, this.oy + y * this.s * 0.82 - z * this.s * 0.5]
    }
    P(x, y, z = 0) {
      const p = this.rawP(x, y, z)
      const cam = this.cam
      if (!cam || !this.W || !this.H) return p
      const zf = Number.isFinite(cam.z) && cam.z > 0 ? cam.z : 1
      const cx = this.W / 2, cy = this.H / 2
      return [cx + (p[0] - cx) * zf + (cam.x || 0), cy + (p[1] - cy) * zf + (cam.y || 0)]
    }
    depth(x, y, z = 0) {
      return this.dim === "3d" ? x + y + z * 0.001 : y + z * 0.001
    }

    resize() {
      const r = this.c.getBoundingClientRect()
      const dpr = Math.min(2, globalThis.devicePixelRatio || 1)
      this.W = Math.max(200, r.width)
      this.H = Math.max(160, r.height)
      this.c.width = Math.round(this.W * dpr)
      this.c.height = Math.round(this.H * dpr)
      this.g.setTransform(dpr, 0, 0, dpr, 0, 0)
      this.fit()
    }

    fit() {
      // the room's corners at scale 1, then scale and centre it
      this.s = 1; this.ox = 0; this.oy = 0
      const pts = this.roomOutline().map(([x, y, z]) => this.rawP(x, y, z))
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1])
      const bw = Math.max(...xs) - Math.min(...xs), bh = Math.max(...ys) - Math.min(...ys)
      const pad = this.dim === "3d" ? 0.04 : 0.06
      this.s = Math.min((this.W * (1 - pad * 2)) / bw, (this.H * (1 - pad * 2)) / bh)
      this.ox = (this.W - bw * this.s) / 2 - Math.min(...xs) * this.s
      this.oy = (this.H - bh * this.s) / 2 - Math.min(...ys) * this.s + (this.dim === "3d" ? this.H * 0.02 : 0)
      // remember the fitted room so pan and zoom can be clamped around it
      const screen = this.roomOutline().map(([x, y, z]) => this.rawP(x, y, z))
      const sx = screen.map((p) => p[0]), sy = screen.map((p) => p[1])
      this.roomBox = { minX: Math.min(...sx), maxX: Math.max(...sx), minY: Math.min(...sy), maxY: Math.max(...sy) }
      this.clampCamera()
    }

    roomOutline() {
      const pts = []
      for (const [x, y] of [[0, 0], [ROOM.w, 0], [0, ROOM.d], [ROOM.w, ROOM.d]]) {
        pts.push([x, y, 0])
        if (x === 0 || y === 0) pts.push([x, y, this.dim === "3d" ? ROOM.wall : 0.9])
      }
      return pts
    }

    setDim(dim) {
      this.dim = dim === "2d" ? "2d" : "3d"
      this.fit()
    }

    // ---- camera: drag to pan, wheel or two fingers to zoom -------------
    clampCamera() {
      const cam = this.cam
      if (!cam) return
      const z = Number.isFinite(cam.z) ? Math.min(CAMERA.maxZoom, Math.max(CAMERA.minZoom, cam.z)) : 1
      cam.z = z
      cam.x = Number.isFinite(cam.x) ? cam.x : 0
      cam.y = Number.isFinite(cam.y) ? cam.y : 0
      if (!this.roomBox || !this.W || !this.H) return
      const b = this.roomBox
      const mx = Math.max(0, ((b.maxX - b.minX) * z - this.W) / 2) + this.W * CAMERA.panMargin
      const my = Math.max(0, ((b.maxY - b.minY) * z - this.H) / 2) + this.H * CAMERA.panMargin
      cam.x = Math.max(-mx, Math.min(mx, cam.x))
      cam.y = Math.max(-my, Math.min(my, cam.y))
    }

    panBy(dx, dy) {
      const cam = this.cam
      if (!cam) return this
      cam.x = (cam.x || 0) + (Number(dx) || 0)
      cam.y = (cam.y || 0) + (Number(dy) || 0)
      this.clampCamera()
      return this
    }

    // zoom about a point of the canvas, keeping that point under the pointer
    zoomAt(px, py, factor) {
      const cam = this.cam
      if (!cam) return this
      const f = Number(factor)
      if (!Number.isFinite(f) || f <= 0) return this
      const z0 = Number.isFinite(cam.z) && cam.z > 0 ? cam.z : 1
      const z1 = Math.min(CAMERA.maxZoom, Math.max(CAMERA.minZoom, z0 * f))
      if (Math.abs(z1 - z0) < 1e-6) return this
      const cx = this.W / 2, cy = this.H / 2
      const ox = (Number.isFinite(px) ? px : cx) - cx
      const oy = (Number.isFinite(py) ? py : cy) - cy
      const r = z1 / z0
      cam.x = ox - (ox - (cam.x || 0)) * r
      cam.y = oy - (oy - (cam.y || 0)) * r
      cam.z = z1
      this.clampCamera()
      return this
    }

    resetCamera() {
      this.cam = { x: 0, y: 0, z: 1 }
      return this
    }

    bindInput() {
      const c = this.c
      if (!c?.addEventListener) return
      this._ptrs = new Map()
      this._drag = null
      this._pinch = null
      this._suppressClick = false
      if (c.style) c.style.touchAction = "none" // two fingers must zoom, not scroll the page
      const point = (e) => {
        const r = c.getBoundingClientRect?.() || { left: 0, top: 0 }
        return [e.clientX - r.left, e.clientY - r.top]
      }
      const down = (e) => {
        if (e.pointerType === "mouse" && e.button !== 0) return
        c.focus?.({ preventScroll: true })
        const [x, y] = point(e)
        this._ptrs.set(e.pointerId, { x, y })
        c.setPointerCapture?.(e.pointerId)
        this._suppressClick = false
        if (this._ptrs.size >= 2) {
          const [a, b] = [...this._ptrs.values()]
          this._pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 }
          this._drag = null
        } else {
          this._drag = { x, y, sx: x, sy: y, moved: false }
        }
      }
      const move = (e) => {
        if (!this._ptrs.has(e.pointerId)) return
        const [x, y] = point(e)
        this._ptrs.set(e.pointerId, { x, y })
        if (this._ptrs.size >= 2 && this._pinch) {
          const [a, b] = [...this._ptrs.values()]
          const d = Math.hypot(a.x - b.x, a.y - b.y)
          const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2
          if (this._pinch.d > 1) this.zoomAt(mx, my, d / this._pinch.d)
          this.panBy(mx - this._pinch.mx, my - this._pinch.my)
          this._pinch = { d, mx, my }
          this._suppressClick = true
          e.preventDefault?.()
          return
        }
        const drag = this._drag
        if (!drag) return
        if (!drag.moved && Math.hypot(x - drag.sx, y - drag.sy) > 3) drag.moved = true
        if (drag.moved) {
          this.panBy(x - drag.x, y - drag.y)
          this._suppressClick = true
          if (c.style) c.style.cursor = "grabbing"
          e.preventDefault?.()
        }
        drag.x = x; drag.y = y
      }
      const up = (e) => {
        this._ptrs.delete(e.pointerId)
        if (this._ptrs.size < 2) this._pinch = null
        if (!this._ptrs.size) {
          this._drag = null
          if (c.style) c.style.cursor = ""
          // the click that follows a drag must not open the panel
          if (this._suppressClick) setTimeout(() => { this._suppressClick = false }, 0)
        }
      }
      c.addEventListener("pointerdown", down)
      c.addEventListener("pointermove", move)
      c.addEventListener("pointerup", up)
      c.addEventListener("pointercancel", up)
      c.addEventListener("wheel", (e) => {
        const before = this.cam.z
        const [x, y] = point(e)
        this.zoomAt(x, y, Math.exp(-(Number(e.deltaY) || 0) * 0.0018))
        if (this.cam.z !== before) e.preventDefault?.()
      }, { passive: false })
      // registered before the page's click handler, so a drag stays a drag
      c.addEventListener("click", (e) => {
        if (!this._suppressClick) return
        this._suppressClick = false
        e.stopImmediatePropagation?.()
        e.preventDefault?.()
      }, true)
      // 0 or Home brings the office back to its fitted view
      this._onKey = (e) => {
        if (e.defaultPrevented || !this.running || c.hidden || c.getClientRects?.().length === 0) return
        if (e.target !== c) return
        const tag = e.target?.tagName
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || e.target?.isContentEditable) return
        if (e.key === "0" || e.key === "Home") { this.resetCamera(); e.preventDefault?.() }
      }
      globalThis.document?.addEventListener?.("keydown", this._onKey)
    }

    dispose() {
      globalThis.document?.removeEventListener?.("keydown", this._onKey)
    }

    // ---- drawing primitives ----------------------------------------
    poly(pts, fill, stroke) {
      const g = this.g
      g.beginPath()
      pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)))
      g.closePath()
      if (fill) { g.fillStyle = fill; g.fill() }
      if (stroke) { g.strokeStyle = stroke; g.lineWidth = 1; g.stroke() }
    }

    box(x, y, z, w, d, h, color, o = {}) {
      const P = (a, b, c) => this.P(a, b, c)
      const top = [P(x, y, z + h), P(x + w, y, z + h), P(x + w, y + d, z + h), P(x, y + d, z + h)]
      const line = o.line === false ? null : "rgba(0,0,0,.18)"
      if (this.dim === "3d") {
        this.poly([P(x, y + d, z), P(x + w, y + d, z), P(x + w, y + d, z + h), P(x, y + d, z + h)], o.left || shade(color, -0.18), line)
        this.poly([P(x + w, y, z), P(x + w, y + d, z), P(x + w, y + d, z + h), P(x + w, y, z + h)], o.right || shade(color, -0.36), line)
      } else {
        this.poly([P(x, y + d, z), P(x + w, y + d, z), P(x + w, y + d, z + h), P(x, y + d, z + h)], o.left || shade(color, -0.28), line)
      }
      this.poly(top, o.top || color, line)
    }

    // the face of a box one looks at (the +y face): a rectangle on it, u
    // across 0–1, v up 0–1
    onFront(x, y, z, w, d, h, u0, v0, u1, v1, color) {
      const P = (a, c) => this.P(x + a * w, y + d, z + c * h)
      this.poly([P(u0, v0), P(u1, v0), P(u1, v1), P(u0, v1)], color)
    }
    onBack(x, y, z, w, d, h, u0, v0, u1, v1, color) {
      const P = (a, c) => this.P(x + a * w, y, z + c * h)
      this.poly([P(u0, v0), P(u1, v0), P(u1, v1), P(u0, v1)], color)
    }
    onLeft(x, y, z, w, d, h, u0, v0, u1, v1, color) {
      if (this.dim !== "3d") return
      const P = (a, c) => this.P(x, y + a * d, z + c * h)
      this.poly([P(u0, v0), P(u1, v0), P(u1, v1), P(u0, v1)], color)
    }
    onRight(x, y, z, w, d, h, u0, v0, u1, v1, color) {
      if (this.dim !== "3d") return
      const P = (a, c) => this.P(x + w, y + a * d, z + c * h)
      this.poly([P(u0, v0), P(u1, v0), P(u1, v1), P(u0, v1)], color)
    }

    text(s, x, y, size, color, font = "600", align = "center") {
      const g = this.g
      g.font = `${font} ${size}px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`
      g.textAlign = align
      g.textBaseline = "middle"
      g.fillStyle = color
      g.fillText(s, x, y)
    }

    // the day/night palette, re-read every half minute (or overridden)
    currentPhase() {
      if (this.phaseOverride != null) return dayPhase(this.phaseOverride)
      const now = Date.now()
      if (!this._day || !this._dayAt || now - this._dayAt > 30000) {
        this._dayAt = now
        this._day = dayPhase(new Date(now))
      }
      return this._day
    }

    // ---- the room ----------------------------------------------------
    background() {
      const g = this.g
      const day = this.dayState || dayPhase()
      const sky = g.createLinearGradient(0, 0, 0, this.H)
      sky.addColorStop(0, day.sky[0])
      sky.addColorStop(1, day.sky[1])
      g.fillStyle = sky
      g.fillRect(0, 0, this.W, this.H)
      if (day.star > 0.02) for (const [a, b, c] of this.stars) {
        const tw = 0.5 + 0.5 * Math.sin(this.t * (0.6 + c) + a * 40)
        const alpha = (0.15 + 0.55 * c * tw) * day.star
        if (alpha < 0.02) continue
        g.fillStyle = `rgba(255,255,255,${alpha})`
        g.fillRect(a * this.W, b * this.H, c > 0.8 ? 2 : 1, c > 0.8 ? 2 : 1)
      }
      if (this.dim !== "3d") return
      // the planet, behind the far wall's windows
      const R = this.s * 5.6
      const [px, py] = this.P(ROOM.w * 0.86, -2.6, 4.6)
      g.save()
      g.beginPath()
      g.arc(px, py, R, 0, Math.PI * 2)
      g.clip()
      const base = g.createRadialGradient(px - R * 0.35, py - R * 0.35, R * 0.1, px, py, R)
      base.addColorStop(0, "#f2a35e")
      base.addColorStop(1, "#b34e1f")
      g.fillStyle = base
      g.fillRect(px - R, py - R, R * 2, R * 2)
      // dawn and dusk tint the planet's lit limb the way the room is lit
      if (day.planet < 1) {
        g.fillStyle = day.ambient
        g.fillRect(px - R, py - R, R * 2, R * 2)
      }
      const bands = ["#f6c48b", "#d9773b", "#fbe0b8", "#c85f29", "#efae6c", "#a8441b"]
      g.translate(px, py)
      g.rotate(-0.28)
      for (let i = 0; i < 9; i++) {
        g.fillStyle = bands[i % bands.length]
        g.globalAlpha = 0.55
        const yb = -R + (i + 0.3) * (R * 2) / 9 + Math.sin(i * 1.7 + this.t * 0.05) * 3
        g.fillRect(-R * 1.2, yb, R * 2.4, R * (0.07 + (i % 3) * 0.04))
      }
      g.globalAlpha = 1
      g.rotate(0.28)
      const shadow = g.createRadialGradient(R * 0.45, R * 0.45, R * 0.2, 0, 0, R * 1.05)
      shadow.addColorStop(0, "rgba(0,0,0,0)")
      shadow.addColorStop(0.55, "rgba(0,0,0,0)")
      shadow.addColorStop(1, "rgba(5,7,15,.75)")
      g.fillStyle = shadow
      g.fillRect(-R, -R, R * 2, R * 2)
      g.restore()
    }

    floor() {
      const dark = "#262932", light = "#2d313b"
      for (let x = 0; x < ROOM.w; x++) for (let y = 0; y < ROOM.d; y++) {
        const P = (a, b) => this.P(a, b, 0)
        this.poly([P(x, y), P(x + 1, y), P(x + 1, y + 1), P(x, y + 1)], (x + y) % 2 ? dark : light)
      }
      // the room's edge
      if (this.dim === "3d") {
        const t = 0.25
        this.poly([this.P(0, ROOM.d, 0), this.P(ROOM.w, ROOM.d, 0), this.P(ROOM.w, ROOM.d, -t), this.P(0, ROOM.d, -t)], "#1b1d24")
        this.poly([this.P(ROOM.w, 0, 0), this.P(ROOM.w, ROOM.d, 0), this.P(ROOM.w, ROOM.d, -t), this.P(ROOM.w, 0, -t)], "#14161b")
      }
      // the glowing guide lines
      const g = this.g
      g.save()
      g.strokeStyle = "rgba(125, 211, 252, .55)"
      g.shadowColor = "rgba(125, 211, 252, .9)"
      g.shadowBlur = 8
      g.lineWidth = 2
      g.beginPath()
      let [a, b] = this.P(2.6, 3.2, 0.01); g.moveTo(a, b)
      ;[a, b] = this.P(9.6, 3.2, 0.01); g.lineTo(a, b)
      ;[a, b] = this.P(9.6, 10.1, 0.01); g.lineTo(a, b)
      g.stroke()
      g.restore()
      // the square where an agent waits for you
      g.save()
      const pulse = 0.55 + 0.25 * Math.sin(this.t * 2.2)
      g.strokeStyle = `rgba(192, 132, 252, ${pulse})`
      g.shadowColor = "rgba(192, 132, 252, .9)"
      g.shadowBlur = 10
      g.lineWidth = 2.5
      const z = ZONE
      this.poly([this.P(z.x, z.y, 0.01), this.P(z.x + z.w, z.y, 0.01), this.P(z.x + z.w, z.y + z.d, 0.01), this.P(z.x, z.y + z.d, 0.01)], "rgba(192,132,252,.07)")
      g.beginPath()
      ;[[z.x, z.y], [z.x + z.w, z.y], [z.x + z.w, z.y + z.d], [z.x, z.y + z.d], [z.x, z.y]].forEach(([x, y], i) => {
        const [sx, sy] = this.P(x, y, 0.01)
        i ? g.lineTo(sx, sy) : g.moveTo(sx, sy)
      })
      g.stroke()
      g.restore()
      // each venue's front approach: a soft ring where a worker stands
      for (const a of ACTIVITIES) {
        const [mx, my] = this.P(a.ax, a.ay, 0.012)
        const [r, gg, b] = rgb(a.color)
        const glow = 0.32 + 0.18 * Math.sin(this.t * 1.3 + a.ax * 3)
        g.save()
        g.strokeStyle = `rgba(${r},${gg},${b},${glow})`
        g.lineWidth = 1.5
        g.setLineDash([4, 4])
        g.beginPath()
        g.ellipse(mx, my, Math.max(4, this.s * 0.19), Math.max(3, this.s * 0.11), 0, 0, Math.PI * 2)
        g.stroke()
        g.restore()
      }
    }

    walls() {
      const H = ROOM.wall
      const day = this.dayState || dayPhase()
      if (this.dim !== "3d") {
        this.box(-0.35, -0.35, 0, ROOM.w + 0.35, 0.35, 0.9, "#9aa1ad")
        this.box(-0.35, 0, 0, 0.35, ROOM.d, 0.9, "#8a919c")
        return
      }
      const g = this.g
      // the far wall (y = 0) with its big windows onto the planet
      const far = (x0, x1, z0, z1) => [this.P(x0, 0, z0), this.P(x1, 0, z0), this.P(x1, 0, z1), this.P(x0, 0, z1)]
      g.save()
      g.beginPath()
      far(0, ROOM.w, 0, H).forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)))
      g.closePath()
      const wins = []
      for (let x = 1.6; x < ROOM.w - 1; x += 2.35) wins.push([x, x + 1.9])
      for (const [a, b] of wins) {
        const pts = far(a, b, 1.05, H - 0.35)
        g.moveTo(pts[0][0], pts[0][1])
        for (const p of pts.slice(1)) g.lineTo(p[0], p[1])
        g.closePath()
      }
      g.fillStyle = "#c9ccd3"
      g.fill("evenodd")
      g.restore()
      for (const [a, b] of wins) {
        // glass and frame: the glass carries the local time's tint
        this.poly(far(a, b, 1.05, H - 0.35), day.glass, "#7d838f")
        this.poly(far((a + b) / 2 - 0.04, (a + b) / 2 + 0.04, 1.05, H - 0.35), "#7d838f")
      }
      this.poly(far(0, ROOM.w, 0, 0.32), "#9097a3")
      this.poly([this.P(0, -0.25, H), this.P(ROOM.w, -0.25, H), this.P(ROOM.w, 0, H), this.P(0, 0, H)], "#e6e8ec")
      // the left wall (x = 0): the airlock and small portholes
      const left = (y0, y1, z0, z1) => [this.P(0, y0, z0), this.P(0, y1, z0), this.P(0, y1, z1), this.P(0, y0, z1)]
      this.poly(left(0, ROOM.d, 0, H), "#a9aeb8")
      this.poly(left(0, ROOM.d, 0, 0.32), "#80868f")
      this.poly([this.P(-0.25, 0, H), this.P(0, 0, H), this.P(0, ROOM.d, H), this.P(-0.25, ROOM.d, H)], "#d7d9de")
      // airlock door
      this.poly(left(1.7, 3.5, 0, 2.3), "#4b5563")
      this.poly(left(1.82, 2.58, 0.05, 2.18), "#6b7280")
      this.poly(left(2.62, 3.38, 0.05, 2.18), "#6b7280")
      this.poly(left(1.7, 3.5, 2.38, 2.74), "#1f2937")
      this.signText("AIRLOCK", 0, 2.6, 2.56, "left", "#f6c453")
      for (const y0 of [5.2, 8.0]) {
        this.poly(left(y0, y0 + 1.6, 1.25, 2.35), "#0b1020", "#6b7280")
        for (const [a, b, c] of this.stars.slice(0, 10)) {
          const [sx, sy] = this.P(0, y0 + 0.1 + a * 1.4, 1.35 + b * 0.9)
          g.fillStyle = `rgba(255,255,255,${0.3 + c * 0.6})`
          g.fillRect(sx, sy, 1, 1)
        }
      }
      // the station's name on the far wall
      const [nx, ny] = this.P(ROOM.w - 2.2, 0, 2.55)
      g.save()
      g.translate(nx, ny)
      g.transform(1, 0.577, 0, 1, 0, 0)
      g.fillStyle = "#1f2937"
      g.fillRect(-this.s * 1.5, -this.s * 0.24, this.s * 3, this.s * 0.48)
      this.text(globalThis.AgentOfficeModel?.text(this.lang)?.stationSign || "ORBITAL STATION 7", 0, 0, Math.max(7, this.s * 0.26), "#e5e7eb", "800")
      g.restore()
    }

    signText(s, x, y, z, side, color) {
      const g = this.g
      const [sx, sy] = this.P(x, y, z)
      g.save()
      g.translate(sx, sy)
      if (side === "left") g.transform(1, -0.577, 0, 1, 0, 0)
      this.text(s, 0, 0, Math.max(7, this.s * 0.22), color, "800")
      g.restore()
    }

    // a thin wash over the room so dawn/day/dusk/night reads on the floor
    // and walls too; the workers themselves stay fully readable
    ambient() {
      const day = this.dayState || dayPhase()
      const g = this.g
      const wash = g.createLinearGradient(0, 0, 0, this.H)
      wash.addColorStop(0, day.ambient)
      wash.addColorStop(1, "rgba(0,0,0,0)")
      g.fillStyle = wash
      g.fillRect(0, 0, this.W, this.H)
    }

    // ---- furniture: each a drawable with a depth -------------------
    props() {
      const out = []
      const add = (x, y, w, d, fn) => out.push({ k: this.depth(x + w / 2, y + d), fn })
      const S = this
      const glow = (c) => shade(c, 0.1 + 0.08 * Math.sin(this.t * 3))
      for (const [i, dk] of DESKS.entries()) {
        const who = this.atSeat?.[i]
        add(dk.x, dk.y, dk.w, dk.d, () => {
          // desk
          S.box(dk.x, dk.y, 0, dk.w, dk.d, 0.62, "#e5e7eb")
          S.box(dk.x + 0.06, dk.y + 0.06, 0.62, dk.w - 0.12, dk.d - 0.12, 0.05, "#f6c453")
          // The monitor stands on the desk's far edge and its screen faces
          // the sitter: a north-facing sitter reads the +y face, a
          // south-facing one the -y face.
          const south = dk.face === "s"
          const my = south ? dk.y + dk.d - 0.25 : dk.y + 0.12
          const screen = who ? glow(who.color) : "#1f2937"
          S.box(dk.x + dk.w / 2 - 0.08, my + 0.05, 0.67, 0.16, 0.1, 0.22, "#4b5563")
          S.box(dk.x + 0.25, my, 0.85, dk.w - 0.5, 0.12, 0.5, "#374151")
          const face = south ? "onBack" : "onFront"
          S[face](dk.x + 0.25, my, 0.85, dk.w - 0.5, 0.12, 0.5, 0.06, 0.1, 0.94, 0.9, screen)
          if (who) {
            // lines of code scrolling on the screen
            for (let l = 0; l < 3; l++) {
              const u = 0.12 + 0.15 * ((l + Math.floor(this.t * 3)) % 3)
              S[face](dk.x + 0.25, my, 0.85, dk.w - 0.5, 0.12, 0.5, 0.12, 0.25 + l * 0.2, 0.12 + u * 3, 0.32 + l * 0.2, "rgba(255,255,255,.55)")
            }
          }
        })
        // the chair, its own drawable so the worker sits in it; its back
        // stands behind the sitter, opposite the way they look
        const [cx, cy] = dk.seat
        out.push({ k: this.depth(cx, cy) - 0.05, fn: () => {
          S.box(cx - 0.28, cy - 0.28, 0, 0.56, 0.56, 0.36, "#9ca3af")
        } })
        const backY = dk.face === "s" ? cy - 0.32 : cy + 0.22
        out.push({ k: this.depth(cx, backY + 0.06), fn: () => S.box(cx - 0.28, backY, 0.36, 0.56, 0.1, 0.5, "#6b7280") })
      }
      // A sofa and its seated occupants are one compositing group. Sorting
      // cushions and people independently lets the next cushion/armrest
      // paint over a neighbour's torso, even after splitting the backrest.
      out.push(this.sofaLayer(false), this.sofaLayer(true))

      // the holo table with its planet
      add(6.3, 5.2, 1.6, 1.6, () => {
        S.box(6.3, 5.2, 0, 1.6, 1.6, 0.25, "#6b7280")
        S.box(6.55, 5.45, 0.25, 1.1, 1.1, 0.5, "#9ca3af")
        S.box(6.75, 5.65, 0.75, 0.7, 0.7, 0.08, "#e5e7eb")
        const [hx, hy] = S.P(7.1, 6.0, 1.45 + Math.sin(this.t * 1.5) * 0.06)
        const g = S.g
        const r = S.s * 0.32
        g.save()
        g.globalAlpha = 0.85
        const beam = g.createLinearGradient(hx, hy, hx, hy + S.s * 0.7)
        beam.addColorStop(0, "rgba(147,197,253,.0)")
        beam.addColorStop(1, "rgba(147,197,253,.35)")
        g.fillStyle = beam
        g.beginPath(); g.moveTo(hx - r * 1.1, hy); g.lineTo(hx + r * 1.1, hy); g.lineTo(hx + r * 0.5, hy + S.s * 0.68); g.lineTo(hx - r * 0.5, hy + S.s * 0.68); g.fill()
        g.fillStyle = "#93c5fd"
        g.beginPath(); g.arc(hx, hy, r, 0, Math.PI * 2); g.fill()
        g.strokeStyle = "#dbeafe"; g.lineWidth = 2
        g.beginPath(); g.ellipse(hx, hy, r * 1.7, r * 0.45, -0.2 + Math.sin(this.t) * 0.05, 0, Math.PI * 2); g.stroke()
        g.restore()
      })
      // a stack of drums
      add(1.8, 9.6, 1.0, 1.0, () => {
        S.box(1.85, 9.65, 0, 0.9, 0.9, 0.45, "#e0a52a")
        S.box(1.85, 9.65, 0.45, 0.9, 0.9, 0.12, "#9ca3af")
        S.box(1.85, 9.65, 0.57, 0.9, 0.9, 0.45, "#f2b630")
        S.box(1.95, 9.75, 1.02, 0.7, 0.7, 0.08, "#9ca3af")
      })
      // crates
      add(8.4, 10.5, 1.4, 1.2, () => {
        for (const [x, y, z] of [[8.4, 10.5, 0], [9.1, 10.5, 0], [8.4, 11.15, 0], [9.1, 11.15, 0], [8.75, 10.8, 0.55]]) {
          S.box(x, y, z, 0.6, 0.6, 0.55, "#1f2937", { top: "#111827" })
          S.box(x + 0.15, y + 0.15, z + 0.55, 0.3, 0.3, 0.01, "#f6c453", { line: false })
        }
      })
      // the robot dog, pacing its own open pocket by the crates
      const rx = 11.3 + Math.sin(this.t * 0.4) * 0.8
      add(rx, 10.9, 0.8, 0.5, () => {
        S.box(rx, 10.9, 0.15, 0.7, 0.45, 0.3, "#3f3f46")
        S.box(rx + 0.55, 10.95, 0.4, 0.3, 0.35, 0.25, "#27272a")
        S.box(rx + 0.05, 10.9, 0, 0.1, 0.1, 0.15, "#18181b")
        S.box(rx + 0.55, 11.25, 0, 0.1, 0.1, 0.15, "#18181b")
        S.box(rx + 0.8, 11.0, 0.5, 0.06, 0.08, 0.06, "#f6c453", { line: false })
      })
      // the reactor, and the console that throws errors
      add(12.6, 8.8, 1.3, 1.3, () => {
        S.box(12.65, 8.85, 0, 1.2, 1.2, 0.35, "#27272a")
        S.box(12.8, 9.0, 0.35, 0.9, 0.9, 0.55, "#e0a52a")
        S.box(12.95, 9.15, 0.9, 0.6, 0.6, 0.2, "#d4d4d8")
      })
      const broken = this.errors > 0
      add(14.3, 6.6, 1.2, 1.6, () => {
        S.box(14.3, 6.6, 0, 1.2, 1.6, 0.75, "#3f3f46")
        S.box(14.4, 6.7, 0.75, 0.9, 1.4, 0.55, "#52525b")
        S.onRight(14.4, 6.7, 0.75, 0.9, 1.4, 0.55, 0.1, 0.15, 0.9, 0.85, broken ? (Math.sin(this.t * 8) > 0 ? "#ef4444" : "#7f1d1d") : "#0ea5e9")
        S.box(14.75, 7.25, 1.3, 0.2, 0.2, 0.2, broken ? "#ef4444" : "#22c55e", { line: false })
      })
      // a console on the far wall's right
      add(14.0, 0.5, 1.6, 1.0, () => {
        S.box(14.0, 0.5, 0, 1.6, 1.0, 0.8, "#4b5563")
        S.box(14.1, 0.5, 0.8, 1.4, 0.35, 0.6, "#374151")
        S.onFront(14.1, 0.5, 0.8, 1.4, 0.35, 0.6, 0.1, 0.15, 0.9, 0.85, glow("#f59e0b"))
      })
      // the activity venues: coffee counter, table tennis, reading shelf,
      // whiteboard huddle, arcade cabinet, and the office cat on the shelf
      out.push(...this.activityProps())
      return out
    }

    activityProps() {
      const out = []
      const S = this
      const add = (x, y, w, d, fn) => out.push({ k: this.depth(x + w / 2, y + d), fn })
      const glow = (c) => shade(c, 0.08 + 0.07 * Math.sin(this.t * 3))
      const by = (id) => ACTIVITIES.find((a) => a.id === id)

      // reading nook: a tall shelf of book spines
      const shelf = by("bookshelf")
      add(shelf.x, shelf.y, shelf.w, shelf.d, () => {
        S.box(shelf.x, shelf.y, 0, shelf.w, shelf.d, 0.16, "#4a2f1b")
        S.box(shelf.x, shelf.y, 0.16, shelf.w, shelf.d, 1.62, "#6b4426")
        for (const z of [0.56, 1.02, 1.48]) S.box(shelf.x, shelf.y + shelf.d - 0.03, z, shelf.w, 0.03, 0.05, "#8a5a32", { line: false })
        const books = ["#ef4444", "#3b82f6", "#22c55e", "#f59e0b", "#a78bfa", "#ec4899", "#14b8a6", "#e5e7eb"]
        for (let i = 0; i < 8; i++) {
          const x = shelf.x + 0.07 + i * 0.185
          S.onFront(x, shelf.y, 0.28, 0.145, shelf.d, 1.1, 0.08, 0.05, 0.92, 0.62, books[i])
          S.onFront(x, shelf.y, 0.28, 0.145, shelf.d, 1.1, 0.08, 0.66, 0.92, 0.95, books[(i + 3) % books.length])
        }
        // the shelf's led
        S.box(shelf.x + 0.05, shelf.y + shelf.d - 0.06, 1.78, shelf.w - 0.1, 0.06, 0.03, glow("#fcd34d"), { line: false })
      })
      // the cat: one slow, capped animation on top of the shelf
      if (this.cat) {
        const base = this.depth(shelf.x + shelf.w / 2, shelf.y + shelf.d) + 0.05
        out.push({ k: base, fn: () => S.catOnShelf() })
      }

      // arcade: a cabinet whose lit screen faces the worker (east)
      const arc = by("arcade")
      add(arc.x, arc.y, arc.w, arc.d, () => {
        S.box(arc.x, arc.y, 0, arc.w, arc.d, 1.52, "#1e293b")
        S.box(arc.x, arc.y, 1.52, arc.w, arc.d, 0.1, "#0f172a")
        // marquee
        S.onRight(arc.x, arc.y, 1.18, arc.w, arc.d, 0.28, 0.08, 0.08, 0.92, 0.92, glow("#38bdf8"))
        // screen and controls on the east face
        S.onRight(arc.x, arc.y, 0.5, arc.w, arc.d, 0.55, 0.12, 0.12, 0.88, 0.88, glow("#0ea5e9"))
        S.onRight(arc.x, arc.y, 0.18, arc.w, arc.d, 0.12, 0.1, 0.1, 0.9, 0.9, "#0f172a")
        S.box(arc.x + 0.1, arc.y + 0.12, 0.1, 0.18, 0.1, 0.12, "#f43f5e", { line: false })
        S.box(arc.x + 0.52, arc.y + 0.12, 0.1, 0.18, 0.1, 0.12, "#22d3ee", { line: false })
        // a glowing top panel keeps the cabinet readable in the 2D view
        S.box(arc.x + 0.16, arc.y + 0.14, 1.52, 0.58, 0.42, 0.05, glow("#38bdf8"), { line: false })
      })

      // whiteboard huddle: a low table and a lit whiteboard facing south
      const meet = by("meeting")
      add(meet.x, meet.y, meet.w, meet.d, () => {
        S.box(meet.x, meet.y, 0, meet.w, meet.d, 0.14, "#52525b")
        S.box(meet.x + 0.12, meet.y + 0.28, 0, 0.1, 0.1, 0.64, "#71717a", { line: false })
        S.box(meet.x + meet.w - 0.22, meet.y + 0.28, 0, 0.1, 0.1, 0.64, "#71717a", { line: false })
        S.box(meet.x, meet.y + 0.18, 0.62, meet.w, meet.d - 0.34, 0.1, "#d6d3d1")
        // the board stands on the north edge; its face looks south
        S.box(meet.x + 0.12, meet.y + 0.03, 0.1, meet.w - 0.24, 0.07, 1.28, "#e5e7eb")
        S.box(meet.x + 0.02, meet.y + 0.0, 0, meet.w - 0.04, 0.13, 0.14, "#64748b")
        S.onFront(meet.x + 0.18, meet.y + 0.03, 0.3, meet.w - 0.36, 0.07, 0.9, 0.1, 0.72, 0.52, 0.79, "#c4b5fd")
        S.onFront(meet.x + 0.18, meet.y + 0.03, 0.3, meet.w - 0.36, 0.07, 0.9, 0.16, 0.58, 0.78, 0.65, "#7dd3fc")
        S.onFront(meet.x + 0.18, meet.y + 0.03, 0.3, meet.w - 0.36, 0.07, 0.9, 0.1, 0.44, 0.44, 0.51, "#fca5a5")
        S.onFront(meet.x + 0.18, meet.y + 0.03, 0.3, meet.w - 0.36, 0.07, 0.9, 0.52, 0.3, 0.86, 0.37, "#86efac")
        // mugs and notes on the table
        for (const [mx, my, mc] of [[0.35, 0.72, "#f472b6"], [0.95, 0.74, "#fbbf24"], [1.35, 0.7, "#34d399"]]) {
          S.box(meet.x + mx, meet.y + my, 0.72, 0.09, 0.09, 0.1, mc, { line: false })
        }
      })

      // ping-pong: green table, white net, paddles and a ball, legs and all
      const pp = by("pingpong")
      add(pp.x, pp.y, pp.w, pp.d, () => {
        for (const [lx, ly] of [[0.1, 0.1], [pp.w - 0.18, 0.1], [0.1, pp.d - 0.18], [pp.w - 0.18, pp.d - 0.18]]) {
          S.box(pp.x + lx, pp.y + ly, 0, 0.1, 0.1, 0.66, "#475569", { line: false })
        }
        S.box(pp.x, pp.y, 0.66, pp.w, pp.d, 0.09, "#1f7a4d")
        S.box(pp.x + 0.02, pp.y + 0.02, 0.75, pp.w - 0.04, pp.d - 0.04, 0.02, "#2fa96a", { line: false })
        // net across the width, dividing the two ends
        S.box(pp.x - 0.03, pp.y + pp.d / 2 - 0.03, 0.75, pp.w + 0.06, 0.06, 0.2, "#f8fafc")
        S.box(pp.x + 0.12, pp.y + pp.d / 2 - 0.015, 0.77, pp.w - 0.24, 0.03, 0.015, "#e2e8f0", { line: false })
        // paddles and a ball
        S.box(pp.x + 0.28, pp.y + 0.3, 0.78, 0.2, 0.14, 0.03, "#ef4444")
        S.box(pp.x + 1.42, pp.y + 0.62, 0.78, 0.2, 0.14, 0.03, "#3b82f6")
        S.box(pp.x + 0.95, pp.y + 0.42, 0.8, 0.05, 0.05, 0.05, "#fef08a", { line: false })
      })

      // coffee / pantry: counter, machine, cups and a warm glow
      const cof = by("coffee")
      add(cof.x, cof.y, cof.w, cof.d, () => {
        S.box(cof.x, cof.y, 0, cof.w, cof.d, 0.92, "#8b5e3c")
        S.box(cof.x + 0.04, cof.y + 0.04, 0.92, cof.w - 0.08, cof.d - 0.08, 0.06, "#f5e6d3")
        S.box(cof.x + 0.14, cof.y + 0.1, 0.98, 0.46, 0.34, 0.5, "#334155")
        S.box(cof.x + 0.2, cof.y + 0.1, 1.14, 0.34, 0.02, 0.2, glow("#fb923c"), { line: false })
        S.box(cof.x + 0.26, cof.y + 0.58, 0.88, 0.14, 0.14, 0.1, "#e5e7eb", { line: false })
        for (let i = 0; i < 3; i++) S.box(cof.x + 0.86 + i * 0.14, cof.y + 0.34, 0.98, 0.09, 0.09, 0.13, ["#f8fafc", "#fcd34d", "#f472b6"][i], { line: false })
        // a jar shelf above the counter
        S.box(cof.x + 0.06, cof.y + 0.02, 1.7, cof.w - 0.12, 0.16, 0.06, "#6b4426")
        for (let i = 0; i < 4; i++) S.box(cof.x + 0.16 + i * 0.26, cof.y + 0.05, 1.76, 0.16, 0.12, 0.18, ["#ef4444", "#22c55e", "#f59e0b", "#3b82f6"][i], { line: false })
      })
      return out
    }

    // one calm cat: a slow pace along the shelf, a tail flick, a blink
    catAt() {
      const shelf = ACTIVITIES.find((a) => a.id === "bookshelf")
      const t = this.reducedMotion ? 0 : this.t
      const pace = 0.5 + 0.5 * Math.sin(t * 0.22 + (this.cat?.seed || 0))
      const x = shelf.x + 0.34 + pace * (shelf.w - 0.68)
      const y = shelf.y + shelf.d / 2
      const awake = !this.reducedMotion && Math.sin(t * 0.31) > -0.35
      return { x, y, z: 1.81, awake, tail: Math.sin(t * (awake ? 1.5 : 0.4)), pace }
    }

    catOnShelf() {
      const cat = this.catAt()
      const { x, y, z } = cat
      // a bright cushion makes the cat readable on the dark shelf in both views
      this.box(x - 0.27, y - 0.17, z - 0.03, 0.54, 0.34, 0.05, "#f472b6")
      this.box(x - 0.21, y - 0.12, z + 0.01, 0.42, 0.24, 0.02, "#fda4af", { line: false })
      this.box(x - 0.17, y - 0.1, z, 0.34, 0.2, 0.12, "#fef3c7")
      this.box(x + 0.12, y - 0.07, z + 0.06, 0.17, 0.15, 0.13, "#fff7ed")
      this.box(x + 0.15, y - 0.05, z + 0.19, 0.04, 0.04, 0.07, "#f59e0b", { line: false })
      this.box(x + 0.25, y - 0.05, z + 0.19, 0.04, 0.04, 0.07, "#f59e0b", { line: false })
      // tabby stripes and a flicking tail
      this.box(x - 0.12, y - 0.1, z + 0.1, 0.06, 0.2, 0.025, "#f59e0b", { line: false })
      this.box(x - 0.02, y - 0.1, z + 0.1, 0.05, 0.2, 0.025, "#f59e0b", { line: false })
      this.box(x - 0.28, y + 0.02 + cat.tail * 0.04, z + 0.05, 0.13, 0.05, 0.05, "#f59e0b", { line: false })
      // closed eyes while dozing, dark slits while awake
      this.onFront(x + 0.15, y - 0.07, z + 0.06, 0.1, 0.14, 0.13, 0.2, cat.awake ? 0.42 : 0.44, 0.36, cat.awake ? 0.56 : 0.46, "#1f2937")
      this.onFront(x + 0.15, y - 0.07, z + 0.06, 0.1, 0.14, 0.13, 0.64, cat.awake ? 0.42 : 0.44, 0.8, cat.awake ? 0.56 : 0.46, "#1f2937")
    }

    // the venues' names, in their own colours, above the furniture
    labels() {
      for (const a of ACTIVITIES) {
        const [x, y] = this.P(a.x + a.w / 2, a.y + a.d / 2, a.lz)
        this.text(globalThis.AgentOfficeModel?.text(this.lang)?.[({bookshelf:"venueReading",arcade:"venueArcade",meeting:"venueMeeting",pingpong:"venuePingpong",coffee:"venueCoffee"})[a.id]] || a.label, x, y, Math.max(7, this.s * 0.14), a.color, "800")
      }
    }

    sofaLayer(front) {
      return { k: front ? this.depth(3.7, 11.7) : this.depth(1.1, 9.1), fn: () => {
        if (front) {
          for (let i = 0; i < 2; i++) {
            const x = 2.5 + i * 1.2
            this.box(x, 11.35, 0, 1.2, 0.35, 0.95, "#d99a1e")
            this.box(x, 10.55, 0, 1.2, 0.8, 0.42, "#f2b630")
          }
          this.box(2.5, 10.55, 0, 0.12, 1.15, 0.7, "#d99a1e")
        } else {
          for (let i = 0; i < 5; i++) {
            const y = 4.4 + i * 0.88
            this.box(0.35, y, 0, 0.4, 0.88, 0.95, "#d99a1e")
            this.box(0.7, y, 0, 0.8, 0.88, 0.42, "#f2b630")
          }
          this.box(0.7, 4.1, 0, 0.8, 0.3, 0.7, "#d99a1e")
          this.box(0.7, 8.8, 0, 0.8, 0.3, 0.7, "#d99a1e")
        }
        const seated = [...this.workers.values()].filter(w =>
          this.sofaGroup(w) === (front ? 1 : 0))
        seated.sort((a, b) => this.depth(a.x, a.y) - this.depth(b.x, b.y))
        for (const w of seated) this.worker(w)
      } }
    }

    // a worker's sofa slot, wherever its place came from: the old sofa kind
    // or an activity slot that happens to be a sofa seat
    sofaSlot(w) {
      if (w.kind === "sofa") return w.slot
      if (w.kind === "activity" && w.slot >= ACTIVITIES.length) return w.slot - ACTIVITIES.length
      return -1
    }

    sofaGroup(w) {
      if (Number.isInteger(w.transit)) return w.transit >= 5 ? 1 : 0
      const slot = this.sofaSlot(w)
      if (slot >= 0 && !w.walking) return slot >= 5 ? 1 : 0
      // The aisle is in front: a distant backrest must not cover its walkers.
      if (w.x >= 1.5 && w.x <= 2.5 && w.y >= 4.1 && w.y <= 9.1) return 0
      if (w.x >= 2.5 && w.x <= 4.9 && w.y >= 9.8 && w.y <= 10.55) return 1
      return -1
    }

    // ---- workers -------------------------------------------------------
    setAgents(list) {
      const seen = new Set()
      const used = { seat: new Set(), sofa: new Set(), zone: new Set(), err: new Set(), activity: new Set(), wander: new Set() }
      const kindOf = (a) => (a.status === "waiting" ? "zone" : a.status === "error" ? "err" : a.status === "done" ? "activity" : "seat")
      const spots = {
        seat: DESKS.map((d) => [d.seat[0], d.seat[1], d.face || "n"]),
        sofa: SOFA.map(([x, y], i) => [x, y, SOFA_FACE[i]]),
        zone: ZONE_SPOTS.map(([x, y]) => [x, y, "s"]),
        err: ERROR_SPOTS.map(([x, y]) => [x, y, "s"]),
        activity: ACTIVITY_SPOTS,
        wander: WANDER.map(([x, y]) => [x, y, "s"]),
      }
      // the ones whose place is still theirs keep it
      for (const a of list) {
        const w = this.workers.get(a.key)
        if (w && w.kind === kindOf(a) && w.slot >= 0) used[w.kind].add(w.slot)
      }
      for (const a of list) {
        seen.add(a.key)
        let w = this.workers.get(a.key)
        if (!w) {
          const sk = SKIN[a.seed % SKIN.length], hr = HAIR[(a.seed >>> 5) % HAIR.length]
          // its own place in the doorway, so a crowd doesn't stand in one spot
          const [sx, sy] = this.first ? [null, null] : [DOOR[0], DOOR[1] + (((a.seed >>> 3) % 7) - 3) * 0.3]
          w = { key: a.key, x: sx, y: sy, skin: sk, hair: hr, pants: PANTS[(a.seed >>> 9) % PANTS.length], long: (a.seed >>> 13) % 3 === 0, kind: "", slot: -1, phase: rnd(a.seed, 3) * 6 }
          this.workers.set(a.key, w)
        }
        w.a = a
        w.color = a.brand.color
        let kind = kindOf(a)
        if (w.kind !== kind || w.slot < 0) {
          const n = spots[kind].length
          let slot = -1
          for (let i = 0; i < n; i++) {
            const j = (a.seed + i) % n
            if (!used[kind].has(j)) { slot = j; break }
          }
          if (slot < 0) {
            // no room left there: stand about
            kind = "wander"
            for (let i = 0; i < WANDER.length; i++) {
              const j = (a.seed + i) % WANDER.length
              if (!used.wander.has(j)) { slot = j; break }
            }
            if (slot < 0) slot = a.seed % WANDER.length
          }
          used[kind].add(slot)
          w.kind = kind
          w.slot = slot
          w.lingerUntil = 0
        }
        const [tx, ty, facing] = spots[w.kind][w.slot]
        const to = tx + "," + ty
        if (w.pathTo !== to) { w.pathTo = to; w.path = null }
        w.tx = tx; w.ty = ty
        w.facing = facing || "s"
        if (w.x == null) { w.x = tx; w.y = ty }
      }
      for (const k of [...this.workers.keys()]) if (!seen.has(k)) this.workers.delete(k)
      // finished workers linger 8–30 s at a venue, then drift to another
      // free one; the timer is wall-clock so it only ticks in a live page
      const now = Date.now()
      for (const w of this.workers.values()) {
        if (w.kind !== "activity" || w.walking) continue
        if (!w.lingerUntil) {
          // start counting only once it has actually arrived at the venue
          if (Math.hypot(w.x - w.tx, w.y - w.ty) > 0.05) continue
          w.lingerUntil = now + activityDwell(w.a.seed || 0) * 1000
          continue
        }
        if (now < w.lingerUntil) continue
        const n = ACTIVITY_SPOTS.length
        let target = -1
        for (let i = 1; i <= n; i++) {
          const j = (w.slot + i) % n
          if (!used.activity.has(j)) { target = j; break }
        }
        if (target < 0) { w.lingerUntil = now + 4000; continue }
        used.activity.delete(w.slot)
        used.activity.add(target)
        w.slot = target
        const [tx, ty, facing] = ACTIVITY_SPOTS[target]
        w.tx = tx; w.ty = ty; w.facing = facing || "s"
        w.pathTo = tx + "," + ty
        w.path = null
        w.transit = null
        w.lingerUntil = 0
      }
      this.first = false
      this.atSeat = {}
      for (const w of this.workers.values()) if (w.kind === "seat") this.atSeat[w.slot] = w
      this.errors = list.filter((a) => a.status === "error").length
    }

    step(dt) {
      const v = 2.6 * dt
      for (const w of this.workers.values()) {
        if (!w.path) w.path = NAV.path([w.x, w.y], [w.tx, w.ty], w.transit)
        w.transit = w.path[0]?.[2] ?? null
        let left = v
        while (left > 1e-6 && w.path.length) {
          w.transit = w.path[0][2] ?? null
          const [px, py] = w.path[0]
          const dx = px - w.x, dy = py - w.y
          const d = Math.hypot(dx, dy)
          if (d <= left) { w.x = px; w.y = py; w.path.shift(); left -= d }
          else {
            w.x += (dx / d) * left
            w.y += (dy / d) * left
            w.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "x" : "-x") : (dy > 0 ? "y" : "-y")
            left = 0
          }
        }
        w.walking = w.path.length > 0
        if (!w.walking) w.transit = null
      }
      this.spread()
    }

    // nobody stands inside anybody: the ones on the move give way, and a
    // pair that meet both step aside, as long as the floor is free there
    spread() {
      const ws = [...this.workers.values()].filter((w) => w.x != null)
      const min = 0.34
      for (let i = 0; i < ws.length; i++) {
        for (let j = i + 1; j < ws.length; j++) {
          const a = ws[i], b = ws[j]
          if (!a.walking && !b.walking) continue
          if (Number.isInteger(a.transit) || Number.isInteger(b.transit)) continue
          let dx = b.x - a.x, dy = b.y - a.y
          let d = Math.hypot(dx, dy)
          if (d >= min) continue
          if (d < 1e-4) { dx = (i % 2 ? 1 : -1) * 0.01; dy = 0.004; d = 0.011 }
          const push = ((min - d) / 2) * 1.05
          const ux = dx / d, uy = dy / d
          const ax = a.x - ux * push, ay = a.y - uy * push
          const bx = b.x + ux * push, by = b.y + uy * push
          if (a.walking && NAV.clear([a.x, a.y], [ax, ay]) && NAV.freeAt(ax, ay)) { a.x = ax; a.y = ay }
          if (b.walking && NAV.clear([b.x, b.y], [bx, by]) && NAV.freeAt(bx, by)) { b.x = bx; b.y = by }
        }
      }
    }

    worker(w) {
      const S = this, t = this.t + w.phase, a = w.a
      const st = a.status
      const sitting = !w.walking && (w.kind === "seat" || this.sofaSlot(w) >= 0)
      const pose = idlePose(w, this.t, this.reducedMotion)
      const sleeping = sitting && this.sofaSlot(w) >= 0 && (a.idle || pose.kind === "doze")
      const f0 = w.walking ? "s" : (w.facing || "s")
      let { x, y } = w
      let z = 0
      if (w.walking) z = Math.abs(Math.sin(t * 9)) * 0.06
      else if (st === "waiting") z = Math.max(0, Math.sin(t * 5)) * 0.18
      const bw = 0.44, bd = 0.3
      const bx = x - bw / 2, by = y - bd / 2
      // shadow, and a ring when it is the one picked or pointed at
      const [shx, shy] = S.P(x, y, 0)
      const ry = this.dim === "3d" ? 0.16 : 0.12
      S.g.fillStyle = "rgba(0,0,0,.28)"
      S.g.beginPath()
      S.g.ellipse(shx, shy, S.s * 0.3, S.s * ry, 0, 0, Math.PI * 2)
      S.g.fill()
      if (this.selected === w.key || this.highlight === w.key) {
        S.g.save()
        S.g.strokeStyle = this.selected === w.key ? "rgba(255,255,255,.95)" : "rgba(255,255,255,.55)"
        S.g.lineWidth = this.selected === w.key ? 2.5 : 1.5
        S.g.beginPath()
        S.g.ellipse(shx, shy, S.s * 0.46, S.s * ry * 1.5, 0, 0, Math.PI * 2)
        S.g.stroke()
        S.g.restore()
      }
      let hip = 0.34
      const dir = FACE[w.facing] || FACE.s
      const swing = pose.kind === "swing" ? Math.sin(pose.phase * 5) * pose.amount * 0.09 : 0
      if (sitting) {
        hip = 0.4
        const thigh = 0.4, legW = 0.16
        if (dir[1] !== 0) {
          // thighs out along y, shins down at their far end
          const ty = dir[1] > 0 ? by + bd - 0.1 : by - thigh + 0.1
          S.box(bx + 0.04, ty, hip - 0.02, legW, thigh, 0.13, w.pants)
          S.box(bx + bw - legW - 0.04, ty, hip - 0.02, legW, thigh, 0.13, w.pants)
          const sy = dir[1] > 0 ? ty + thigh - 0.14 : ty
          S.box(bx + 0.04, sy + swing, 0, legW, 0.14, hip, w.pants)
          S.box(bx + bw - legW - 0.04, sy - swing, 0, legW, 0.14, hip, w.pants)
        } else {
          // thighs out along x, shins down at their far end
          const tx = dir[0] > 0 ? bx + bw - 0.1 : bx - thigh + 0.1
          S.box(tx, by + 0.05, hip - 0.02, thigh, 0.16, 0.13, w.pants)
          S.box(tx, by + bd - 0.21, hip - 0.02, thigh, 0.16, 0.13, w.pants)
          const sx = dir[0] > 0 ? tx + thigh - 0.14 : tx
          S.box(sx, by + 0.05 + swing, 0, 0.14, 0.16, hip, w.pants)
          S.box(sx, by + bd - 0.21 - swing, 0, 0.14, 0.16, hip, w.pants)
        }
      } else {
        const step = w.walking ? Math.sin(t * 9) * 0.08 : 0
        S.box(bx + 0.04, by + 0.07 + step, z, 0.16, 0.16, hip, w.pants)
        S.box(bx + bw - 0.2, by + 0.07 - step, z, 0.16, 0.16, hip, w.pants)
      }
      const stretch = pose.kind === "stretch" ? pose.amount : 0
      const zb = (sitting ? hip + 0.08 : hip) + z + stretch * 0.07
      const sleepTilt = sleeping ? 0.06 : 0
      // body
      S.box(bx, by, zb, bw, bd, 0.42, w.color)
      if (f0 === "s") S.onFront(bx, by, zb, bw, bd, 0.42, 0.38, 0.55, 0.62, 0.95, "rgba(255,255,255,.85)")
      else if (f0 === "e") S.onRight(bx, by, zb, bw, bd, 0.42, 0.38, 0.55, 0.62, 0.95, "rgba(255,255,255,.85)")
      // arms
      let armUp = 0
      if (st === "waiting" && !w.walking) armUp = 1
      const typing = sitting && w.kind === "seat" && (st === "executing" || st === "replying")
      const ay = typing ? Math.sin(t * 18) * 0.03 : 0
      S.box(bx - 0.12 - stretch * 0.06, by + 0.06 + ay, zb + 0.08 + stretch * 0.42, 0.12, 0.16, 0.32, shade(w.color, -0.1))
      if (armUp) {
        const wave = Math.sin(t * 10) * 0.08
        S.box(bx + bw, by + 0.06 + wave, zb + 0.32, 0.12, 0.14, 0.42, shade(w.color, -0.1))
        S.box(bx + bw, by + 0.06 + wave, zb + 0.74, 0.12, 0.14, 0.12, w.skin)
      } else {
        S.box(bx + bw + stretch * 0.06, by + 0.06 - ay, zb + 0.08 + stretch * 0.42, 0.12, 0.16, 0.32, shade(w.color, -0.1))
      }
      // head: a sitter facing the camera shows a face, one facing away the
      // back of the head, one facing east a profile. A flat (2D) view can
      // only show the +y face, so east/west are drawn as a face there.
      const hs = 0.46
      const glance = pose.kind === "look" ? Math.sin(pose.phase * 2.2) * pose.amount * 0.07 : 0
      const hx = x - hs / 2 + sleepTilt + glance, hy = y - hs / 2 + (sleeping ? 0.04 : 0)
      const hz = zb + 0.42 - (sleeping ? 0.06 : 0) - (pose.kind === "doze" ? pose.amount * 0.07 : 0)
      S.box(hx, hy, hz, hs, hs, hs, w.skin)
      const f = this.dim === "2d" && (w.facing === "e" || w.facing === "w") ? "s" : (w.facing || "s")
      const eyes = (cols) => {
        const draw = f === "s" ? "onFront" : "onRight"
        if (f !== "s" && f !== "e") return
        if (sleeping) {
          S[draw](hx, hy, hz, hs, hs, hs, cols[0], 0.5, cols[0] + 0.2, 0.55, "#1f2937")
          S[draw](hx, hy, hz, hs, hs, hs, cols[1], 0.5, cols[1] + 0.2, 0.55, "#1f2937")
          return
        }
        const blink = (Math.sin(t * 1.3) > 0.97) ? 0.03 : 0.14
        S[draw](hx, hy, hz, hs, hs, hs, cols[0], 0.45, cols[0] + 0.12, 0.45 + blink, "#1f2937")
        S[draw](hx, hy, hz, hs, hs, hs, cols[1], 0.45, cols[1] + 0.12, 0.45 + blink, "#1f2937")
      }
      if (f === "s") {
        S.onFront(hx, hy, hz, hs, hs, hs, 0, 0.78, 1, 1, w.hair) // fringe
        S.onRight(hx, hy, hz, hs, hs, hs, 0, 0.45, 1, 1, w.hair)
        eyes([0.22, 0.66])
        if (!sleeping) {
          S.onFront(hx, hy, hz, hs, hs, hs, 0.12, 0.3, 0.26, 0.38, "rgba(244,114,182,.45)")
          S.onFront(hx, hy, hz, hs, hs, hs, 0.74, 0.3, 0.88, 0.38, "rgba(244,114,182,.45)")
        }
      } else if (f === "e") {
        // looking east: the camera sees the right side of the head
        S.onFront(hx, hy, hz, hs, hs, hs, 0, 0.2, 1, 1, w.hair)
        S.onRight(hx, hy, hz, hs, hs, hs, 0, 0.72, 1, 1, w.hair)
        eyes([0.3, 0.62])
      } else {
        // facing away: hair on both faces the camera can see
        S.onFront(hx, hy, hz, hs, hs, hs, 0, 0.15, 1, 1, w.hair)
        S.onRight(hx, hy, hz, hs, hs, hs, 0, 0.15, 1, 1, w.hair)
      }
      if (w.long) S.onRight(hx, hy, hz, hs, hs, hs, 0, 0, 1, 0.5, w.hair)
      // hair on top
      S.box(hx - 0.03, hy - 0.03, hz + hs, hs + 0.06, hs + 0.06, 0.1, w.hair)
      const top = S.P(x, y, (sitting ? 0.48 : 0.34) + 0.42 + hs + 0.1)
      w.screen = { x: top[0], y: top[1], r: S.s * 0.5, foot: S.P(x, y, 0) }
    }

    // the little sign over a worker's head
    bubble(w) {
      const a = w.a, g = this.g
      if (!w.screen) return
      const { x, y } = w.screen
      const r = Math.max(7, this.s * 0.2)
      const bx = x + this.s * 0.42, by = y - this.s * 0.1
      const t = this.t + w.phase
      const pill = (fill, draw) => {
        g.save()
        g.fillStyle = fill
        g.shadowColor = "rgba(0,0,0,.3)"; g.shadowBlur = 4
        g.beginPath(); g.arc(bx, by, r, 0, Math.PI * 2); g.fill()
        g.restore()
        draw()
      }
      if (a.status === "waiting") {
        const s = 1 + 0.12 * Math.sin(t * 6)
        g.save(); g.translate(bx, by); g.scale(s, s); g.translate(-bx, -by)
        pill("#f59e0b", () => this.text("!", bx, by + 0.5, r * 1.4, "#fff", "900"))
        g.restore()
      } else if (a.status === "error") {
        pill("#ef4444", () => this.text("×", bx, by, r * 1.5, "#fff", "900"))
      } else if (a.status === "thinking") {
        pill("rgba(255,255,255,.95)", () => {
          for (let i = 0; i < 3; i++) {
            g.fillStyle = `rgba(139,108,246,${0.35 + 0.65 * (Math.floor(t * 3) % 3 === i ? 1 : 0)})`
            g.beginPath(); g.arc(bx - r * 0.45 + i * r * 0.45, by, r * 0.16, 0, Math.PI * 2); g.fill()
          }
        })
      } else if (a.status === "executing") {
        pill("rgba(255,255,255,.95)", () => {
          g.save(); g.translate(bx, by); g.rotate(t * 3)
          g.strokeStyle = "#3b82f6"; g.lineWidth = Math.max(1.5, r * 0.22)
          g.beginPath(); g.arc(0, 0, r * 0.5, 0, Math.PI * 1.4); g.stroke()
          g.restore()
        })
      } else if (a.status === "replying") {
        pill("rgba(255,255,255,.95)", () => {
          g.fillStyle = "#10b981"
          for (let i = 0; i < 3; i++) {
            const len = 0.5 + 0.4 * Math.abs(Math.sin(t * 4 + i))
            g.fillRect(bx - r * 0.55, by - r * 0.4 + i * r * 0.33, r * 1.1 * len, Math.max(1.2, r * 0.15))
          }
        })
      } else if (a.idle) {
        for (let i = 0; i < 2; i++) {
          const p = ((t * 0.6 + i * 0.5) % 1)
          this.text("z", x + this.s * (0.2 + p * 0.35), y - this.s * (0.1 + p * 0.6), Math.max(8, this.s * (0.2 + 0.1 * i)), `rgba(226,232,240,${1 - p})`, "800")
        }
      }
    }

    frame(now) {
      if (!this.running) return
      const dt = Math.min(0.05, (now - (this.last || now)) / 1000)
      this.last = now
      this.t += dt
      this.step(dt)
      this.draw()
      this.raf = requestAnimationFrame((n) => this.frame(n))
    }

    draw() {
      const g = this.g
      this.dayState = this.currentPhase()
      g.clearRect(0, 0, this.W, this.H)
      this.background()
      this.floor()
      this.walls()
      this.ambient()
      const items = this.props()
      // a person sitting is ordered by the seat's front edge, not their
      // middle, so their legs are over the cushion and not inside it
      for (const w of this.workers.values()) {
        if (this.sofaGroup(w) >= 0) continue // boarding, seated, or alighting
        const sits = !w.walking && (w.kind === "seat" || this.sofaSlot(w) >= 0)
        items.push({ k: this.depth(w.x, w.y + (sits ? 0.34 : 0)) + 0.02, fn: () => this.worker(w) })
      }
      items.sort((a, b) => a.k - b.k)
      for (const it of items) it.fn()
      this.labels()
      for (const w of this.workers.values()) this.bubble(w)
      const anchors = []
      const zoom = Number.isFinite(this.cam?.z) && this.cam.z > 0 ? this.cam.z : 1
      for (const w of this.workers.values()) if (w.screen) anchors.push({
        key: w.key,
        x: w.screen.x,
        y: w.screen.y - this.s * 0.25 * zoom,
        r: w.screen.r * zoom,
        fx: w.screen.foot[0],
        fy: w.screen.foot[1],
      })
      this.onFrame(anchors)
    }

    start() {
      if (this.running) return
      this.running = true
      this.last = 0
      this.raf = requestAnimationFrame((n) => this.frame(n))
    }
    stop() {
      this.running = false
      cancelAnimationFrame(this.raf)
    }

    // the worker under a point of the canvas, or ""
    hit(px, py) {
      let best = "", bd = Infinity
      for (const w of this.workers.values()) {
        if (!w.screen) continue
        const cx = w.screen.x, cy = (w.screen.y + w.screen.foot[1]) / 2
        const h = (w.screen.foot[1] - w.screen.y) / 2 + 4
        const dx = Math.abs(px - cx), dy = Math.abs(py - cy)
        if (dx < this.s * 0.45 && dy < h) {
          const d = dx + dy
          if (d < bd) { bd = d; best = w.key }
        }
      }
      return best
    }
  }

  globalThis.AgentOfficeScene = {
    Scene, ROOM, DESKS, SOFA, ZONE, ZONE_SPOTS, NAV, BLOCKERS, SOFA_APPROACH, SOFA_FACE, DESKS, idlePose,
    // activity venues and the new clock/camera helpers
    ACTIVITIES, POIS, POI_APPROACHES, ACTIVITY_SPOTS, SKY_PHASES, CAMERA,
    dayPhase, phaseOfHour, activityDwell,
  }
})()
