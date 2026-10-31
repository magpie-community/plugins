/*!
 * Agent Office 3D — a real WebGL office scene for the magpie page.
 *
 * This file is a classic script (no modules, no bundler at runtime). It uses
 * the locally bundled three.js in page/three.min.js and exposes the global
 * `AgentOfficeScene3D` constructor.
 *
 * three.js r169 is bundled in page/three.min.js under the MIT License:
 *   Copyright © 2010-2024 three.js authors
 *   Permission is hereby granted, free of charge, to any person obtaining a
 *   copy of this software and associated documentation files (the "Software"),
 *   to deal in the Software without restriction, including without limitation
 *   the rights to use, copy, modify, merge, publish, distribute, sublicense,
 *   and/or sell copies of the Software, and to permit persons to whom the
 *   Software is furnished to do so, subject to the following conditions:
 *   The above copyright notice and this permission notice shall be included in
 *   all copies or substantial portions of the Software.
 *   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 *   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 *   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 *   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 *   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 *   FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
 *   DEALINGS IN THE SOFTWARE.
 *
 * The magpie page has connect-src 'none', so every asset here is procedural:
 * boxes, cylinders, spheres, canvas-drawn textures and bundled JS only.
 */
(function (global) {
  "use strict"

  const VERSION = "1.0.0"
  const TAU = Math.PI * 2
  const THREE = global.THREE || null
  const MAX_AGENTS = 32

  // ---------------------------------------------------------------------
  // pure helpers — safe with no THREE, no DOM and no WebGL (bun tests)
  // ---------------------------------------------------------------------

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)

  function hashKey(s) {
    let h = 2166136261
    for (const c of String(s)) h = Math.imul(h ^ c.codePointAt(0), 16777619)
    return h >>> 0
  }

  function mulberry32(seed) {
    let a = seed >>> 0
    return function () {
      a = (a + 0x6d2b79f5) >>> 0
      let t = a
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  function parseColor(input) {
    if (typeof input !== "string") return null
    const s = input.trim().toLowerCase()
    if (!s) return null
    if (s[0] === "#") {
      const h = s.slice(1)
      if (!/^[0-9a-f]+$/.test(h)) return null
      if (h.length === 3) return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16)]
      if (h.length === 6) return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
      return null
    }
    let m = s.match(/^rgba?\(([^)]+)\)$/)
    if (m) {
      const p = m[1].split(/[,\s/]+/).filter(Boolean).map((x) => x.endsWith("%") ? Number(x.slice(0, -1)) * 2.55 : Number(x))
      if (p.length < 3 || p.some((n) => !isFinite(n))) return null
      return [clamp(Math.round(p[0]), 0, 255), clamp(Math.round(p[1]), 0, 255), clamp(Math.round(p[2]), 0, 255)]
    }
    m = s.match(/^hsla?\(([^)]+)\)$/)
    if (m) {
      const p = m[1].split(/[,\s/]+/).filter(Boolean)
      const h = ((Number(p[0]) % 360) + 360) % 360
      const sat = clamp(Number(String(p[1] || "0").replace("%", "")) / 100, 0, 1)
      const lig = clamp(Number(String(p[2] || "0").replace("%", "")) / 100, 0, 1)
      if (!isFinite(h) || !isFinite(sat) || !isFinite(lig)) return null
      const a = sat * Math.min(lig, 1 - lig)
      const f = (n) => {
        const k = (n + h / 30) % 12
        return Math.round(255 * (lig - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))))
      }
      return [f(0), f(8), f(4)]
    }
    return null
  }

  function toHex(rgb) {
    const h = (n) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, "0")
    return "#" + h(rgb[0]) + h(rgb[1]) + h(rgb[2])
  }

  function colorToHex(input, fallback) {
    const rgb = parseColor(input)
    return rgb ? toHex(rgb) : (fallback || "#8a94a6")
  }

  function mixColor(a, b, t) {
    const A = parseColor(a) || [128, 128, 128]
    const B = parseColor(b) || [128, 128, 128]
    const k = clamp(Number(t) || 0, 0, 1)
    return toHex([A[0] + (B[0] - A[0]) * k, A[1] + (B[1] - A[1]) * k, A[2] + (B[2] - A[2]) * k])
  }

  function lighten(c, f) { return mixColor(c, "#ffffff", f) }
  function darken(c, f) { return mixColor(c, "#000000", f) }

  // local clock -> sky / sun / window tint. Keyframes are interpolated so the
  // office drifts from night through dawn, noon, dusk and back.
  const SKY_KEYS = [
    { h: 0, sky: "#080d1a", sun: "#9db4e8", sunI: 0.12, ambient: 0.26, day: 0.02, window: "#21305c", label: "night" },
    { h: 5, sky: "#101a32", sun: "#a8b8dc", sunI: 0.16, ambient: 0.3, day: 0.06, window: "#33406b", label: "night" },
    { h: 6.5, sky: "#e8a06a", sun: "#ffb46b", sunI: 0.9, ambient: 0.42, day: 0.35, window: "#ffcf9a", label: "dawn" },
    { h: 8.5, sky: "#8bc4ef", sun: "#ffe7c2", sunI: 1.8, ambient: 0.55, day: 0.82, window: "#d9efff", label: "morning" },
    { h: 12, sky: "#9ecdf7", sun: "#fff4dc", sunI: 2.35, ambient: 0.62, day: 1, window: "#e6f5ff", label: "noon" },
    { h: 16.5, sky: "#a8c7e8", sun: "#ffd9a0", sunI: 1.7, ambient: 0.54, day: 0.85, window: "#ffe7c4", label: "afternoon" },
    { h: 18.5, sky: "#e07a55", sun: "#ff995c", sunI: 0.85, ambient: 0.43, day: 0.42, window: "#ffab78", label: "dusk" },
    { h: 20, sky: "#333f61", sun: "#b7c4e8", sunI: 0.3, ambient: 0.33, day: 0.18, window: "#59679b", label: "evening" },
    { h: 22, sky: "#101832", sun: "#94a9d8", sunI: 0.14, ambient: 0.27, day: 0.05, window: "#2b3968", label: "night" },
    { h: 24, sky: "#080d1a", sun: "#9db4e8", sunI: 0.12, ambient: 0.26, day: 0.02, window: "#21305c", label: "night" },
  ]

  function timeOfDay(date) {
    const d = date instanceof Date && !isNaN(date.getTime()) ? date : new Date()
    const hour = d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600
    let i = 0
    while (i < SKY_KEYS.length - 2 && SKY_KEYS[i + 1].h <= hour) i++
    const a = SKY_KEYS[i], b = SKY_KEYS[i + 1]
    const span = Math.max(1e-6, b.h - a.h)
    const t = clamp((hour - a.h) / span, 0, 1)
    const lerp = (x, y) => x + (y - x) * t
    return {
      hour, minutes: d.getHours() * 60 + d.getMinutes(), phase: t < 0.5 ? a.label : b.label,
      sky: mixColor(a.sky, b.sky, t),
      sun: mixColor(a.sun, b.sun, t),
      sunIntensity: lerp(a.sunI, b.sunI),
      ambient: lerp(a.ambient, b.ambient),
      dayFactor: lerp(a.day, b.day),
      window: mixColor(a.window, b.window, t),
      label: t < 0.5 ? a.label : b.label,
    }
  }

  const clampZoom = (z) => clamp(isFinite(Number(z)) ? Number(z) : 1.05, 0.55, 3)
  const clampPolar = (p) => clamp(isFinite(Number(p)) ? Number(p) : 0.96, 0.35, 1.42)
  function wrapAzimuth(a) {
    let x = isFinite(Number(a)) ? Number(a) : 0.82
    x = ((x + Math.PI) % TAU + TAU) % TAU - Math.PI
    return x
  }

  // A fake projector can be passed in tests: {project(p) -> {x,y,z} (NDC)}.
  // Real Camera objects also work because their .project() mutates and returns
  // the vector. Returns CSS pixel coordinates and a visibility flag.
  function projectToScreen(point, projector, width, height) {
    if (!point || !projector) return { x: 0, y: 0, visible: false }
    let ndc = null
    try {
      if (typeof projector === "function") ndc = projector(point)
      else if (typeof projector.project === "function") ndc = projector.project({ x: point.x, y: point.y, z: point.z })
    } catch (err) { ndc = null }
    if (!ndc || !isFinite(ndc.x) || !isFinite(ndc.y) || !isFinite(ndc.z)) return { x: 0, y: 0, visible: false }
    const w = isFinite(width) && width > 0 ? width : 1
    const h = isFinite(height) && height > 0 ? height : 1
    const x = (ndc.x + 1) * 0.5 * w
    const y = (1 - ndc.y) * 0.5 * h
    const visible = ndc.z >= -1 && ndc.z <= 1 && ndc.x >= -1 && ndc.x <= 1 && ndc.y >= -1 && ndc.y <= 1
    return { x, y, visible }
  }

  // ---------------------------------------------------------------------
  // scene registry: palette, texture style and the props that place it
  // ---------------------------------------------------------------------

  const THEMES = {
    office: {
      id: "office", label: "Office", note: "space-station office",
      floor: "#c7aa81", floorStyle: "wood", wall: "#dfe7f1", trim: "#f8fbff", accent: "#3b82f6",
      desk: "#a4774f", chair: "#334155", metal: "#94a3b8", wood: "#8b5e3c", sofa: "#5b6ee1",
      plant: "#2f9e63", skyDay: "#9ecdf7", skyNight: "#0b1224", windowDay: "#d9efff", windowNight: "#2b3968",
      fog: "#0a1020", ambient: "#dfeaff",
      props: ["coffee", "pingpong", "bookshelf", "whiteboard", "arcade"],
    },
    station: {
      id: "station", label: "Station", note: "orbital command deck",
      floor: "#3d5069", floorStyle: "metal", wall: "#587089", trim: "#9db6cd", accent: "#22d3ee",
      desk: "#5c7288", chair: "#1e293b", metal: "#b6c5d6", wood: "#42546a", sofa: "#33708f",
      plant: "#24a58a", skyDay: "#17314b", skyNight: "#050a16", windowDay: "#8ff6ff", windowNight: "#123b62",
      fog: "#071120", ambient: "#d6f3ff",
      props: ["coffee", "bookshelf", "whiteboard", "console", "reactor", "holo"],
    },
    cafe: {
      id: "cafe", label: "Café", note: "coffee shop corner",
      floor: "#a9744f", floorStyle: "wood", wall: "#f0ddc4", trim: "#fff8ec", accent: "#d97706",
      desk: "#8d5a3b", chair: "#6b4226", metal: "#b08968", wood: "#7a4a2b", sofa: "#b45309",
      plant: "#3f8f5a", skyDay: "#ffe1b8", skyNight: "#1a1220", windowDay: "#ffe9c9", windowNight: "#59405f",
      fog: "#1b120b", ambient: "#ffe8c7",
      props: ["coffee", "cafe", "bookshelf"],
    },
    castle: {
      id: "castle", label: "Castle", note: "stone keep",
      floor: "#777167", floorStyle: "stone", wall: "#928b7e", trim: "#c9c1ae", accent: "#b08d57",
      desk: "#6b4d32", chair: "#4a3525", metal: "#8f8a80", wood: "#5d432c", sofa: "#8b2f3c",
      plant: "#5b7c4d", skyDay: "#a9c7e8", skyNight: "#0c1020", windowDay: "#cfe4ff", windowNight: "#27355c",
      fog: "#0b0c12", ambient: "#e8dfc8",
      props: ["throne", "banners", "braziers", "bookshelf"],
    },
    pirate: {
      id: "pirate", label: "Pirate", note: "ship deck",
      floor: "#7a5230", floorStyle: "plank", wall: "#6b4a2f", trim: "#c79a63", accent: "#d4a017",
      desk: "#7a4c28", chair: "#4b2f1b", metal: "#8b7355", wood: "#5a3a20", sofa: "#7c4a2d",
      plant: "#4e7a3f", skyDay: "#8fd0e8", skyNight: "#081424", windowDay: "#cfeeff", windowNight: "#1d3557",
      fog: "#0a0d14", ambient: "#ffe4b0",
      props: ["barrels", "treasure", "mast", "cannons"],
    },
    graveyard: {
      id: "graveyard", label: "Graveyard", note: "moonlit graves",
      floor: "#3d4448", floorStyle: "stone", wall: "#4e565c", trim: "#8a9298", accent: "#8b5cf6",
      desk: "#4b4a50", chair: "#2b2d33", metal: "#7c858c", wood: "#3b3530", sofa: "#4c3f63",
      plant: "#4f6b57", skyDay: "#8391a8", skyNight: "#070a12", windowDay: "#b9c6dc", windowNight: "#25345c",
      fog: "#05070b", ambient: "#cfd6e8",
      props: ["tombstones", "deadtrees", "candles", "bookshelf", "arcade"],
    },
  }

  const SCENE_IDS = ["office", "station", "cafe", "castle", "pirate", "graveyard"]
  const SCENES = {}
  for (const id of SCENE_IDS) SCENES[id] = THEMES[id]
  const themeFor = (id) => (THEMES[id] ? THEMES[id] : THEMES.office)

  // ---------------------------------------------------------------------
  // deterministic room layout, seats and activity props
  // ---------------------------------------------------------------------

  const ROOM = { w: 16, d: 12, wall: 3.2 }
  const ENTRY = [0.95, 2.6]

  // x,z is the desk's north-west corner; seat is where the worker sits.
  const DESKS = [
    { x: 3.2, z: 0.55, w: 1.7, d: 0.9, seat: [4.05, 1.95], face: "n" },
    { x: 5.9, z: 0.55, w: 1.7, d: 0.9, seat: [6.75, 1.95], face: "n" },
    { x: 8.6, z: 0.55, w: 1.7, d: 0.9, seat: [9.45, 1.95], face: "n" },
    { x: 11.3, z: 0.55, w: 1.7, d: 0.9, seat: [12.15, 1.95], face: "n" },
    { x: 10.6, z: 4.6, w: 1.6, d: 0.8, seat: [11.4, 4.0], face: "s", island: true },
    { x: 12.4, z: 4.6, w: 1.6, d: 0.8, seat: [13.2, 4.0], face: "s", island: true },
    { x: 10.6, z: 5.4, w: 1.6, d: 0.8, seat: [11.4, 6.75], face: "n", island: true },
    { x: 12.4, z: 5.4, w: 1.6, d: 0.8, seat: [13.2, 6.75], face: "n", island: true },
  ]

  const SOFA = [[1.1, 4.84], [1.1, 5.72], [1.1, 6.6], [1.1, 7.48], [1.1, 8.36], [3.1, 10.95], [4.3, 10.95]]
  const SOFA_FACE = ["e", "e", "e", "e", "e", "n", "n"]

  const ZONE = { x: 4.2, z: 7.2, w: 4.4, d: 3.4 }
  const ZONE_SPOTS = []
  for (let j = 0; j < 3; j++) for (let i = 0; i < 4; i++) {
    ZONE_SPOTS.push([ZONE.x + 0.6 + i * 1.05 + (j % 2) * 0.3, ZONE.z + 0.6 + j * 1.05])
  }
  const ERROR_SPOTS = [[12.3, 9.6], [14.3, 8.6], [12.9, 10.45], [14.3, 10.3]]
  const WANDER = [[7.0, 4.4], [8.6, 5.7], [6.0, 5.8], [9.0, 8.0], [10.2, 9.0], [2.8, 3.2], [5.0, 3.4], [9.6, 2.9], [2.4, 6.0]]
  const DOOR = [0.6, 2.6]

  const FACE = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0] }
  const faceAngle = (face) => {
    const f = FACE[face] || FACE.s
    return Math.atan2(f[0], f[1])
  }

  // Furniture that cannot be walked through. Doors/aisles are elsewhere.
  const BLOCKERS = [
    ...DESKS.map((d) => [d.x, d.z, d.w, d.d]),
    [0.0, 4.55, 2.0, 4.25],       // west sofa
    [2.55, 10.35, 2.5, 1.3],      // south sofa
    [0.55, 0.35, 2.3, 0.95],      // coffee bar
    [3.2, 3.9, 2.5, 1.5],         // ping-pong table
    [14.85, 1.25, 0.8, 2.3],      // bookshelf
    [14.65, 9.05, 0.95, 1.25],    // arcade cabinet
  ]

  const WALL_PAD = 0.22
  function blockedAt(x, z, pad, blockers) {
    const p = pad == null ? 0.15 : pad
    const bs = blockers || BLOCKERS
    if (x < WALL_PAD + p || z < WALL_PAD + p || x > ROOM.w - WALL_PAD - p || z > ROOM.d - WALL_PAD - p) return true
    for (const b of bs) {
      if (x >= b[0] - p && x <= b[0] + b[2] + p && z >= b[1] - p && z <= b[1] + b[3] + p) return true
    }
    return false
  }

  function sampleRoute(route, blockers, pad) {
    const p = pad == null ? 0.15 : pad
    for (let i = 0; i < route.length - 1; i++) {
      const a = route[i], b = route[i + 1]
      const n = Math.max(2, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.12))
      for (let k = 0; k <= n; k++) {
        const x = a[0] + ((b[0] - a[0]) * k) / n
        const z = a[1] + ((b[1] - a[1]) * k) / n
        if (blockedAt(x, z, p, blockers)) return { x, z, segment: i }
      }
    }
    return null
  }

  // the same test, but allow the last segment into a seat (sofa/desk)
  function routeBlocked(route, options) {
    const o = options || {}
    if (!Array.isArray(route) || route.length < 2) return null
    const last = o.ignoreLast ? route.length - 1 : route.length
    const hit = sampleRoute(route.slice(0, last), o.blockers, o.pad)
    return hit ? { x: hit.x, z: hit.z, segment: hit.segment } : null
  }

  const HUBS = {
    wn: [2.6, 2.9], cn: [9.4, 2.9], ws: [2.6, 6.5], cs: [9.4, 6.5], se: [9.4, 8.8],
  }
  const HUB_EDGES = [["wn", "cn"], ["wn", "ws"], ["cn", "cs"], ["ws", "cs"], ["cs", "se"]]

  function segmentClear(a, b, pad) {
    return sampleRoute([a, b], BLOCKERS, pad == null ? 0.16 : pad) === null
  }

  function nearestHub(x, z) {
    let best = null, bestD = Infinity
    for (const id of Object.keys(HUBS)) {
      const h = HUBS[id]
      const d = Math.hypot(h[0] - x, h[1] - z)
      if (d < bestD && segmentClear([x, z], h)) { bestD = d; best = id }
    }
    return best
  }

  function hubPath(a, b) {
    if (a === b) return [a]
    const prev = { [a]: null }
    const q = [a]
    while (q.length) {
      const cur = q.shift()
      for (const [x, y] of HUB_EDGES) {
        for (const [m, n] of [[x, y], [y, x]]) {
          if (cur !== m || prev[n] !== undefined) continue
          prev[n] = m
          if (n === b) {
            const out = [b]
            let k = b
            while (prev[k] != null) { k = prev[k]; out.unshift(k) }
            return out
          }
          q.push(n)
        }
      }
    }
    return [a, b]
  }

  function laneRoute(route, offset) {
    if (!offset || !Array.isArray(route) || route.length < 3) return route
    return route.map((p, i) => {
      if (i === 0 || i === route.length - 1) return [p[0], p[1]]
      const a = route[i - 1], c = route[i + 1]
      let ax = p[0] - a[0], az = p[1] - a[1], bx = c[0] - p[0], bz = c[1] - p[1]
      const la = Math.max(1e-6, Math.hypot(ax, az)), lb = Math.max(1e-6, Math.hypot(bx, bz))
      ax /= la; az /= la; bx /= lb; bz /= lb
      let nx = -(az + bz), nz = ax + bx
      const ln = Math.max(1e-6, Math.hypot(nx, nz))
      nx /= ln; nz /= ln
      return [p[0] + nx * offset, p[1] + nz * offset]
    })
  }

  function dedupeRoute(route) {
    const out = []
    for (const p of route) {
      const q = out[out.length - 1]
      if (!q || Math.hypot(q[0] - p[0], q[1] - p[1]) > 1e-6) out.push([p[0], p[1]])
    }
    return out
  }

  function connectRoute(from, targetRoute) {
    const route = Array.isArray(targetRoute) ? targetRoute : [ENTRY]
    if (!from) return dedupeRoute(route)
    let hub = nearestHub(from[0], from[1])
    if (!hub) return dedupeRoute([from, ...route])
    let targetHub = null, targetIdx = -1
    for (let i = route.length - 1; i >= 0; i--) {
      for (const id of Object.keys(HUBS)) {
        if (Math.hypot(HUBS[id][0] - route[i][0], HUBS[id][1] - route[i][1]) < 1e-6) { targetHub = id; targetIdx = i; break }
      }
      if (targetHub) break
    }
    if (!targetHub) return dedupeRoute([from, ...route])
    const ids = hubPath(hub, targetHub)
    const mids = ids.map((id) => HUBS[id])
    return dedupeRoute([from, ...mids, ...route.slice(targetIdx + 1)])
  }

  function exitRoute(from) {
    const hub = nearestHub(from[0], from[1])
    if (!hub) return dedupeRoute([from, ENTRY])
    return dedupeRoute([from, ...hubPath(hub, "wn").map((id) => HUBS[id]), ENTRY])
  }

  function deskRoute(d) {
    const [x, z] = d.seat
    if (z < 3.4) return dedupeRoute([ENTRY, HUBS.wn, [x, 2.9], [x, z]])
    if (z < 5.2) return dedupeRoute([ENTRY, HUBS.wn, HUBS.cn, [9.4, 3.4], [x, 3.4], [x, z]])
    return dedupeRoute([ENTRY, HUBS.wn, HUBS.ws, HUBS.cs, [9.4, 7.35], [x, 7.35], [x, z]])
  }

  function routeFor(kind, x, z, face) {
    if (kind === "desk") return dedupeRoute([ENTRY, HUBS.wn, [x, 2.9], [x, z]])
    if (kind === "sofa") {
      if (face === "e") return dedupeRoute([ENTRY, HUBS.wn, [2.45, 2.9], [2.45, z], [x, z]])
      return dedupeRoute([ENTRY, HUBS.wn, [2.45, 2.9], [2.45, 10.1], [x, 10.1], [x, z]])
    }
    if (kind === "zone") return dedupeRoute([ENTRY, HUBS.wn, HUBS.ws, [x, 6.5], [x, z]])
    if (kind === "error") return dedupeRoute([ENTRY, HUBS.wn, HUBS.ws, HUBS.cs, HUBS.se, [x, 8.8], [x, z]])
    // wandering: take the first candidate aisle path that is really clear
    const candidates = [
      dedupeRoute([ENTRY, HUBS.wn, [x, 2.9], [x, z]]),
      dedupeRoute([ENTRY, HUBS.wn, HUBS.ws, [x, 6.5], [x, z]]),
      dedupeRoute([ENTRY, HUBS.wn, HUBS.ws, HUBS.cs, HUBS.se, [x, 8.8], [x, z]]),
      dedupeRoute([ENTRY, HUBS.wn, [2.45, 6.5], [x, 6.5], [x, z]]),
    ]
    for (const c of candidates) if (!routeBlocked(c)) return c
    return candidates[0]
  }

  function makeSpot(kind, id, x, z, face, y, route) {
    return { id, kind, x, z, y: y == null ? 0 : y, face: face || "s", route: route || routeFor(kind, x, z, face) }
  }

  const SPOTS = {
    desk: DESKS.map((d, i) => makeSpot("desk", "desk-" + i, d.seat[0], d.seat[1], d.face, 0.46, deskRoute(d))),
    sofa: SOFA.map((s, i) => makeSpot("sofa", "sofa-" + i, s[0], s[1], SOFA_FACE[i], 0.4, routeFor("sofa", s[0], s[1], SOFA_FACE[i]))),
    zone: ZONE_SPOTS.map((s, i) => makeSpot("zone", "zone-" + i, s[0], s[1], "s", 0, null)),
    error: ERROR_SPOTS.map((s, i) => makeSpot("error", "error-" + i, s[0], s[1], "s", 0, null)),
    wander: WANDER.map((s, i) => makeSpot("wander", "wander-" + i, s[0], s[1], "s", 0, null)),
  }
  // spot routes generated before SPOTS existed are rebuilt here (no cycles)
  for (const kind of Object.keys(SPOTS)) {
    for (const spot of SPOTS[kind]) {
      spot.route = kind === "zone" ? routeFor("zone", spot.x, spot.z, spot.face)
        : kind === "error" ? routeFor("error", spot.x, spot.z, spot.face)
          : kind === "wander" ? routeFor("wander", spot.x, spot.z, spot.face) : spot.route
    }
  }
  const SPOT_BY_ID = new Map()
  for (const kind of Object.keys(SPOTS)) for (const spot of SPOTS[kind]) SPOT_BY_ID.set(spot.id, spot)

  const POOLS = {
    desk: SPOTS.desk, sofa: SPOTS.sofa, zone: SPOTS.zone, error: SPOTS.error, wander: SPOTS.wander,
  }
  const FALLBACKS = {
    desk: ["wander", "zone"], sofa: ["wander", "zone"], zone: ["wander"], error: ["zone", "wander"], wander: ["zone"],
  }

  function spotKindForStatus(status) {
    switch (String(status || "").toLowerCase()) {
      case "waiting": return "zone"
      case "error": return "error"
      case "done": return "sofa"
      case "thinking": case "executing": case "replying": case "working": return "desk"
      default: return "wander"
    }
  }

  function seatFor(key, kindOrStatus) {
    const kind = POOLS[kindOrStatus] ? kindOrStatus : spotKindForStatus(kindOrStatus)
    const pool = POOLS[kind] || SPOTS.wander
    return pool[hashKey(key) % pool.length]
  }

  function assignSeats(list) {
    const used = new Set()
    const out = {}
    const valid = (Array.isArray(list) ? list : []).filter((a) => a && typeof a === "object" && a.key != null)
      .slice().sort((a, b) => String(a.key).localeCompare(String(b.key)))
    for (const a of valid) {
      const kind = spotKindForStatus(a.status)
      const order = [kind, ...(FALLBACKS[kind] || [])]
      let found = null
      for (const k of [...new Set([...order, ...Object.keys(POOLS)])]) {
        const pool = POOLS[k]
        if (!pool) continue
        const start = hashKey(a.key) % pool.length
        for (let i = 0; i < pool.length; i++) {
          const p = pool[(start + i) % pool.length]
          if (!used.has(p.id)) { found = p; break }
        }
        if (found) break
      }
      if (found) { used.add(found.id); out[String(a.key)] = found.id }
    }
    return out
  }

  const LAYOUT = {
    ROOM, DESKS, SOFA, SOFA_FACE, ZONE, ZONE_SPOTS, ERROR_SPOTS, WANDER, DOOR, ENTRY,
    HUBS, SPOTS, SPOT_BY_ID, POOLS, BLOCKERS, assignSeats, seatFor, spotKindForStatus,
    routeFor, connectRoute, exitRoute, laneRoute, blockedAt, routeBlocked, sampleRoute,
  }

  // ---------------------------------------------------------------------
  // rendering starts here; everything below is a no-op without a canvas
  // ---------------------------------------------------------------------

  const QUALITIES = {
    low: { dpr: 1, shadow: 512 },
    medium: { dpr: 1.5, shadow: 1024 },
    high: { dpr: 2, shadow: 2048 },
  }

  const SKIN = ["#f2c7a5", "#e8b48a", "#c98d62", "#8d5a3b", "#f5d6bf"]
  const HAIR = ["#2b2118", "#5a3825", "#a0522d", "#1f2937", "#d4a24c", "#7c2d12", "#111111", "#c2410c"]
  const PANTS = ["#334155", "#1e3a8a", "#374151", "#3f3f46", "#78350f"]
  const SHOES = ["#111827", "#1f2937", "#292524"]

  function AgentOfficeScene3D(canvas, opts) {
    if (!(this instanceof AgentOfficeScene3D)) return new AgentOfficeScene3D(canvas, opts)
    const o = opts && typeof opts === "object" ? opts : {}
    this.version = VERSION
    this.canvas = canvas && typeof canvas === "object" ? canvas : null
    this.id = THEMES[o.scene] ? o.scene : "office"
    this.theme = themeFor(this.id)
    this.quality = QUALITIES[o.quality] ? o.quality : "high"
    this.dprCap = Math.min(2, Math.max(1, Number(o.dprCap) || 2))
    this.timeInfo = timeOfDay(o.now instanceof Date ? o.now : new Date())
    this.available = false
    this.disposed = false
    this.error = null
    this.width = 0
    this.height = 0
    this.zoom = clampZoom(o.zoom == null ? 1.05 : o.zoom)
    this.azimuth = clamp(wrapAzimuth(o.azimuth == null ? 0.82 : o.azimuth), 0.12, Math.PI / 2 - 0.12)
    this.polar = clampPolar(o.polar == null ? 0.96 : o.polar)
    this.selected = null
    this.agents = []
    this._pending = Array.isArray(o.agents) ? o.agents : []
    this._map = new Map()
    this._taken = new Map() // spot id -> key
    this._listeners = []
    this._raf = null
    this._last = 0
    this._frameGeneration = 0
    this._timeAcc = 0
    this._anim = 0
    this._hidden = !!(global.document && global.document.hidden)
    this._enabled = true
    this._contextLost = false
    this._sharedGeo = new Set()
    this._sharedMat = new Set()
    this._envGeo = new Set()
    this._envMat = new Set()
    this._envTex = new Set()
    this._matCache = new Map()
    this._v = THREE ? new THREE.Vector3() : null
    this.onFrame = typeof o.onFrame === "function" ? o.onFrame : null
    this.dragged = false
    if (!this.canvas || !THREE || !THREE.WebGLRenderer) return
    try {
      this._init()
      this.available = true
      if (this._pending.length) this.setAgents(this._pending)
      this._start()
    } catch (err) {
      this.error = err instanceof Error ? err : new Error(String(err))
      this.available = false
      this.dispose()
    }
  }

  AgentOfficeScene3D.prototype._init = function () {
    const T = THREE
    const canvas = this.canvas
    if (typeof canvas.getContext !== "function") throw new Error("no canvas context")
    this.renderer = new T.WebGLRenderer({
      // Context antialiasing is fixed at creation; live quality changes DPR and shadows.
      canvas, antialias: true, alpha: false, powerPreference: "high-performance",
    })
    if (!this.renderer || !this.renderer.getContext || !this.renderer.getContext()) throw new Error("no WebGL context")
    this.available = true
    this.renderer.setPixelRatio(Math.min(this.dprCap, QUALITIES[this.quality].dpr, global.devicePixelRatio || 1))
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = T.PCFSoftShadowMap
    this.renderer.outputColorSpace = T.SRGBColorSpace
    this.renderer.toneMapping = T.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.08

    this.scene = new T.Scene()
    this.workerGroup = new T.Group()
    this.workerGroup.name = "workers"
    this.scene.add(this.workerGroup)
    this.camera = new T.OrthographicCamera(-8, 8, 5, -5, 0.1, 120)
    this.target = new T.Vector3(ROOM.w / 2, 0.75, ROOM.d / 2)
    this._buildSharedGeometry()
    this._workerBatches = new Map()
    this._workerMatrix = new T.Matrix4()
    this._workerInverse = new T.Matrix4()
    this._screenMat = null
    this._buildEnvironment()
    this._bind()
    this.resize()
    this.refreshTime()
    this._applyCamera()
  }

  AgentOfficeScene3D.prototype._buildSharedGeometry = function () {
    const T = THREE
    if (this._sharedGeo.size) return
    const add = (g) => { this._sharedGeo.add(g); return g }
    this.gBox = add(new T.BoxGeometry(1, 1, 1))
    this.gCyl = add(new T.CylinderGeometry(0.5, 0.5, 1, 16))
    this.gCone = add(new T.ConeGeometry(0.5, 1, 16))
    this.gSphere = add(new T.SphereGeometry(0.5, 16, 12))
    this.gIco = add(new T.IcosahedronGeometry(0.5, 0))
    this.gPlane = add(new T.PlaneGeometry(1, 1))
    this.gTorus = add(new T.TorusGeometry(0.34, 0.025, 8, 28))
  }

  AgentOfficeScene3D.prototype._teardown = function () {
    if (this.renderer) {
      try { this.renderer.dispose() } catch (err) { /* already gone */ }
      try { if (this.renderer.forceContextLoss) this.renderer.forceContextLoss() } catch (err) { /* noop */ }
      this.renderer = null
    }
    this.scene = null
    this.camera = null
  }

  AgentOfficeScene3D.prototype._mat = function (color, opts) {
    const o = opts || {}
    const hex = colorToHex(color, "#8a94a6")
    const rough = o.rough == null ? 0.82 : o.rough
    const metal = o.metal == null ? 0.02 : o.metal
    const emissive = o.emissive ? colorToHex(o.emissive, hex) : null
    const key = [hex, rough, metal, emissive || "", o.ei == null ? 1 : o.ei, o.opacity == null ? 1 : o.opacity].join("|")
    let m = this._matCache.get(key)
    if (!m) {
      m = new THREE.MeshStandardMaterial({
        color: hex, roughness: rough, metalness: metal,
        emissive: emissive || 0x000000, emissiveIntensity: o.ei == null ? 1 : o.ei,
        transparent: o.opacity != null && o.opacity < 1,
        opacity: o.opacity == null ? 1 : o.opacity,
      })
      this._matCache.set(key, m)
      this._sharedMat.add(m)
    }
    return m
  }

  AgentOfficeScene3D.prototype._mesh = function (parent, geo, color, opts) {
    const o = opts || {}
    const m = o.mat || this._mat(color, o)
    const mesh = new THREE.Mesh(geo, m)
    mesh.position.set(o.x || 0, o.y || 0, o.z || 0)
    mesh.scale.set(o.sx || 1, o.sy || 1, o.sz || 1)
    mesh.rotation.set(o.rx || 0, o.ry || 0, o.rz || 0)
    mesh.castShadow = o.cast !== false
    mesh.receiveShadow = o.receive !== false
    if (o.name) mesh.name = o.name
    parent.add(mesh)
    return mesh
  }

  AgentOfficeScene3D.prototype._box = function (parent, color, x, y, z, w, h, d, o) {
    return this._mesh(parent, this.gBox, color, Object.assign({ x, y, z, sx: w, sy: h, sz: d }, o || {}))
  }
  AgentOfficeScene3D.prototype._cyl = function (parent, color, x, y, z, r, h, o) {
    return this._mesh(parent, this.gCyl, color, Object.assign({ x, y, z, sx: r * 2, sy: h, sz: r * 2 }, o || {}))
  }
  AgentOfficeScene3D.prototype._cone = function (parent, color, x, y, z, r, h, o) {
    return this._mesh(parent, this.gCone, color, Object.assign({ x, y, z, sx: r * 2, sy: h, sz: r * 2 }, o || {}))
  }
  AgentOfficeScene3D.prototype._sphere = function (parent, color, x, y, z, r, o) {
    return this._mesh(parent, this.gSphere, color, Object.assign({ x, y, z, sx: r * 2, sy: r * 2, sz: r * 2 }, o || {}))
  }
  AgentOfficeScene3D.prototype._ico = function (parent, color, x, y, z, r, o) {
    return this._mesh(parent, this.gIco, color, Object.assign({ x, y, z, sx: r * 2, sy: r * 2, sz: r * 2 }, o || {}))
  }

  AgentOfficeScene3D.prototype._canvas = function (w, h, draw) {
    if (typeof document === "undefined" || !document.createElement) return null
    const c = document.createElement("canvas")
    c.width = w
    c.height = h
    const ctx = c.getContext("2d")
    if (!ctx) return null
    try { draw(ctx, w, h) } catch (err) { /* a texture is optional */ }
    return c
  }

  AgentOfficeScene3D.prototype._texture = function (w, h, draw, repeat) {
    if (!THREE || typeof document === "undefined") return null
    const c = this._canvas(w, h, draw)
    if (!c) return null
    const tex = new THREE.CanvasTexture(c)
    tex.colorSpace = THREE.SRGBColorSpace
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping
    if (repeat) tex.repeat.set(repeat[0], repeat[1])
    tex.needsUpdate = true
    this._envTex.add(tex)
    return tex
  }

  AgentOfficeScene3D.prototype._envMaterial = function (opts) {
    const m = new THREE.MeshStandardMaterial(opts)
    this._envMat.add(m)
    return m
  }

  // ---------------------------------------------------------------------
  // environment: floor, walls, windows, lights, furniture and prop themes
  // ---------------------------------------------------------------------

  AgentOfficeScene3D.prototype._buildEnvironment = function () {
    const T = THREE
    if (this.env) {
      this.scene.remove(this.env)
      this._disposeEnv()
    }
    const theme = this.theme
    const env = new T.Group()
    env.name = "environment"
    this.env = env
    this.scene.add(env)
    this._textures = {}
    this._decorations = []
    this._screenMat = null
    this._windowMats = []
    this._lights = {}

    this._buildRoom(env, theme)
    this._buildWindows(env, theme)
    this._buildDesks(env, theme)
    this._buildSofa(env, theme)
    this._buildBaseProps(env, theme)
    const seen = new Set()
    for (const prop of (theme.props || [])) {
      if (seen.has(prop)) continue
      seen.add(prop)
      const fn = this._propBuilders[prop]
      if (fn) {
        const props = new T.Group()
        props.name = "props:" + prop
        env.add(props)
        fn.call(this, props, theme)
        // These fixtures already occupy the reserved furniture footprints.
        if (!["coffee", "pingpong", "bookshelf", "arcade", "whiteboard", "banners"].includes(prop)) {
          for (const object of props.children) this._placeDecoration(object)
        }
      }
    }
    this._buildLights(env, theme)
    this._applyTime()
  }

  // Decorations use the same reserved seats and aisles in every theme. Keep
  // their body-height footprint clear instead of adding invisible obstructions
  // to routes that workers already follow.
  AgentOfficeScene3D.prototype._placeDecoration = function (object) {
    this.env.updateMatrixWorld(true)
    const bounds = new THREE.Box3()
    object.traverse((mesh) => {
      if (!mesh.isMesh) return
      const b = new THREE.Box3().setFromObject(mesh)
      if (b.max.y > 0.06 && b.min.y < 1.7) bounds.union(b)
    })
    if (bounds.isEmpty()) return
    const original = object.position.clone()
    const cx = (bounds.min.x + bounds.max.x) / 2
    const cz = (bounds.min.z + bounds.max.z) / 2
    const halfX = (bounds.max.x - bounds.min.x) / 2
    const halfZ = (bounds.max.z - bounds.min.z) / 2
    const overlaps = (a, b, pad) => a[0] < b[2] + pad && a[2] > b[0] - pad && a[1] < b[3] + pad && a[3] > b[1] - pad
    const clear = (b) => {
      if (b[0] < 0.3 || b[1] < 0.3 || b[2] > ROOM.w - 0.3 || b[3] > ROOM.d - 0.3) return false
      for (const f of BLOCKERS) if (overlaps(b, [f[0], f[1], f[0] + f[2], f[1] + f[3]], 0.12)) return false
      for (const f of this._decorations) if (overlaps(b, f, 0.12)) return false
      for (const pool of Object.values(SPOTS)) for (const spot of pool) {
        const route = spot.route
        for (let i = 0; i < route.length - 1; i++) {
          const a = route[i], c = route[i + 1]
          const n = Math.max(1, Math.ceil(Math.hypot(c[0] - a[0], c[1] - a[1]) / 0.15))
          for (let j = 0; j <= n; j++) {
            const x = a[0] + (c[0] - a[0]) * j / n, z = a[1] + (c[1] - a[1]) * j / n
            if (x > b[0] - 0.32 && x < b[2] + 0.32 && z > b[1] - 0.32 && z < b[3] + 0.32) return false
          }
        }
      }
      return true
    }
    const candidates = [[cx, cz]]
    for (let z = 0.6; z < ROOM.d - 0.5; z += 0.3) for (let x = 0.6; x < ROOM.w - 0.5; x += 0.3) candidates.push([x, z])
    candidates.sort((a, b) => Math.hypot(a[0] - cx, a[1] - cz) - Math.hypot(b[0] - cx, b[1] - cz))
    for (const scale of [1, 0.85, 0.7, 0.55]) for (const [x, z] of candidates) {
      const b = [x - halfX * scale, z - halfZ * scale, x + halfX * scale, z + halfZ * scale]
      if (!clear(b)) continue
      object.scale.multiplyScalar(scale)
      object.position.x = x + (original.x - cx) * scale
      object.position.z = z + (original.z - cz) * scale
      this._decorations.push(b)
      object.userData.decoration = true
      return
    }
    // An optional ornament may be omitted when no safe footprint remains.
    object.visible = false
  }

  AgentOfficeScene3D.prototype._disposeEnv = function () {
    if (this.env) {
      this.env.traverse((o) => {
        if (o && o.isLight && o.shadow && o.shadow.map) {
          try { o.shadow.map.dispose() } catch (err) { /* noop */ }
          o.shadow.map = null
        }
      })
    }
    for (const g of this._envGeo) { try { g.dispose() } catch (err) { /* noop */ } }
    for (const m of this._envMat) { try { m.dispose() } catch (err) { /* noop */ } }
    for (const t of this._envTex) { try { t.dispose() } catch (err) { /* noop */ } }
    this._envGeo.clear()
    this._envMat.clear()
    this._envTex.clear()
  }

  AgentOfficeScene3D.prototype._buildRoom = function (env, theme) {
    const T = THREE
    const g = new T.Group()
    env.add(g)
    // floor slab and a procedurally textured top
    this._box(g, darken(theme.floor, 0.35), ROOM.w / 2, -0.16, ROOM.d / 2, ROOM.w, 0.3, ROOM.d, { receive: true })
    const rand = mulberry32(hashKey(theme.id + "-floor"))
    const tex = this._texture(256, 256, (ctx, w, h) => {
      ctx.fillStyle = theme.floor
      ctx.fillRect(0, 0, w, h)
      const style = theme.floorStyle
      if (style === "wood") {
        for (let y = 0; y < h; y += 32) {
          ctx.fillStyle = rand() > 0.5 ? lighten(theme.floor, 0.05) : darken(theme.floor, 0.06)
          ctx.fillRect(0, y, w, 30)
          ctx.strokeStyle = "rgba(50,30,15,.28)"
          ctx.lineWidth = 2
          ctx.beginPath(); ctx.moveTo(0, y + 31); ctx.lineTo(w, y + 31); ctx.stroke()
          const off = Math.floor(rand() * w)
          ctx.beginPath(); ctx.moveTo(off, y); ctx.lineTo(off, y + 31); ctx.stroke()
        }
      } else if (style === "tile" || style === "stone") {
        ctx.strokeStyle = style === "stone" ? "rgba(25,28,30,.4)" : "rgba(50,40,30,.28)"
        ctx.lineWidth = 3
        for (let i = 0; i <= 4; i++) {
          ctx.beginPath(); ctx.moveTo(i * 64, 0); ctx.lineTo(i * 64, h); ctx.stroke()
          ctx.beginPath(); ctx.moveTo(0, i * 64); ctx.lineTo(w, i * 64); ctx.stroke()
        }
        for (let i = 0; i < 14; i++) {
          ctx.fillStyle = rand() > 0.5 ? "rgba(255,255,255,.05)" : "rgba(0,0,0,.06)"
          ctx.fillRect(rand() * w, rand() * h, 30 + rand() * 50, 24 + rand() * 40)
        }
      } else if (style === "metal") {
        ctx.fillStyle = darken(theme.floor, 0.12)
        ctx.fillRect(0, 0, w, h)
        for (let y = 0; y < h; y += 64) for (let x = 0; x < w; x += 64) {
          ctx.fillStyle = (x / 64 + y / 64) % 2 ? lighten(theme.floor, 0.06) : theme.floor
          ctx.fillRect(x + 2, y + 2, 60, 60)
          ctx.fillStyle = "rgba(180,230,255,.35)"
          ctx.fillRect(x + 6, y + 6, 48, 2)
          ctx.beginPath(); ctx.arc(x + 10, y + 54, 2, 0, TAU); ctx.fill()
        }
      } else if (style === "plank") {
        for (let y = 0; y < h; y += 24) {
          ctx.fillStyle = rand() > 0.5 ? lighten(theme.floor, 0.07) : darken(theme.floor, 0.08)
          ctx.fillRect(0, y, w, 21)
          ctx.fillStyle = "rgba(20,10,0,.35)"
          ctx.fillRect(0, y + 21, w, 3)
          ctx.fillRect(rand() * w, y, 3, 21)
        }
      } else {
        for (let i = 0; i < 300; i++) {
          ctx.fillStyle = rand() > 0.5 ? "rgba(255,255,255,.04)" : "rgba(0,0,0,.07)"
          ctx.fillRect(rand() * w, rand() * h, 2 + rand() * 5, 2 + rand() * 4)
        }
      }
    }, [4, 3])
    if (tex) {
      const m = this._envMaterial({ map: tex, roughness: 0.88, metalness: theme.floorStyle === "metal" ? 0.35 : 0.04, color: "#ffffff" })
      const floorGeo = new T.PlaneGeometry(ROOM.w, ROOM.d)
      this._envGeo.add(floorGeo)
      const floor = new T.Mesh(floorGeo, m)
      floor.rotation.x = -Math.PI / 2
      floor.position.set(ROOM.w / 2, 0.005, ROOM.d / 2)
      floor.receiveShadow = true
      g.add(floor)
      this._floorMat = m
    } else {
      this._box(g, theme.floor, ROOM.w / 2, 0.01, ROOM.d / 2, ROOM.w, 0.02, ROOM.d, { receive: true })
    }

    // two far walls (north and west) and low ledges on the camera side
    this._box(g, theme.wall, ROOM.w / 2, ROOM.wall / 2, -0.12, ROOM.w + 0.3, ROOM.wall, 0.24, { cast: false })
    this._box(g, theme.wall, -0.12, ROOM.wall / 2, ROOM.d / 2, 0.24, ROOM.wall, ROOM.d, { cast: false })
    this._box(g, theme.trim, ROOM.w / 2, 0.09, -0.01, ROOM.w, 0.18, 0.08, { cast: false })
    this._box(g, theme.trim, 0.01, 0.09, ROOM.d / 2, 0.08, 0.18, ROOM.d, { cast: false })
    this._box(g, theme.trim, ROOM.w / 2, ROOM.wall - 0.08, -0.01, ROOM.w, 0.16, 0.07, { cast: false })
    this._box(g, theme.trim, 0.01, ROOM.wall - 0.08, ROOM.d / 2, 0.07, 0.16, ROOM.d, { cast: false })
    // low ledges on the open sides, so props have a base
    this._box(g, darken(theme.wall, 0.12), ROOM.w / 2, 0.16, ROOM.d + 0.06, ROOM.w, 0.32, 0.12, { cast: false })
    this._box(g, darken(theme.wall, 0.12), ROOM.w + 0.06, 0.16, ROOM.d / 2, 0.12, 0.32, ROOM.d, { cast: false })
    // door on the west wall, at the entry point
    const door = new T.Group()
    door.position.set(0.02, 0, DOOR[1])
    g.add(door)
    this._box(door, theme.trim, 0, 1.1, 0, 0.07, 2.2, 1.0)
    this._box(door, darken(theme.accent, 0.2), 0.05, 1.06, 0, 0.05, 2.0, 0.84)
    this._sphere(door, theme.accent, 0.1, 1.0, 0.3, 0.045, { cast: false })
    this._box(door, theme.accent, 0.1, 2.22, 0, 0.18, 0.1, 1.14, { cast: false })
    // a soft skirting shadow line
    this._box(g, darken(theme.wall, 0.3), ROOM.w / 2, 0.02, 0.02, ROOM.w, 0.04, 0.03, { cast: false })
  }

  AgentOfficeScene3D.prototype._buildWindows = function (env, theme) {
    for (let i = 0; i < 3; i++) {
      const x = 3.8 + i * 4.2
      const w = 2.1, h = 1.45, y = 1.75
      this._box(env, theme.trim, x, y, 0.06, w + 0.2, h + 0.2, 0.1, { cast: false })
      const mat = new THREE.MeshStandardMaterial({
        color: theme.windowDay, emissive: theme.windowDay, emissiveIntensity: 0.85,
        roughness: 0.18, metalness: 0.05,
      })
      this._envMat.add(mat)
      this._windowMats.push(mat)
      this._mesh(env, this.gPlane, null, { mat, x, y, z: 0.13, sx: w, sy: h })
      // mullions
      this._box(env, theme.trim, x, y, 0.15, 0.06, h, 0.05, { cast: false })
      this._box(env, theme.trim, x, y, 0.15, w, 0.06, 0.05, { cast: false })
      this._box(env, theme.trim, x, y - h / 2 - 0.06, 0.2, w + 0.35, 0.12, 0.3, { cast: false })
      // curtains
      this._box(env, mixColor(theme.accent, theme.wall, 0.55), x - w / 2 - 0.2, y + 0.05, 0.17, 0.22, h + 0.45, 0.12, { cast: false })
      this._box(env, mixColor(theme.accent, theme.wall, 0.55), x + w / 2 + 0.2, y + 0.05, 0.17, 0.22, h + 0.45, 0.12, { cast: false })
    }
  }

  AgentOfficeScene3D.prototype._buildLights = function (env, theme) {
    const T = THREE
    const hemi = new T.HemisphereLight(theme.ambient, darken(theme.floor, 0.55), 0.62)
    env.add(hemi)
    const amb = new T.AmbientLight("#ffffff", 0.16)
    env.add(amb)
    const sun = new T.DirectionalLight("#fff4dc", 2.1)
    sun.position.set(ROOM.w * 0.55, 21, -9)
    sun.target.position.set(ROOM.w / 2, 0, ROOM.d / 2)
    sun.castShadow = true
    sun.shadow.bias = -0.0004
    sun.shadow.normalBias = 0.025
    sun.shadow.camera.left = -12
    sun.shadow.camera.right = 12
    sun.shadow.camera.top = 12
    sun.shadow.camera.bottom = -12
    sun.shadow.camera.near = 1
    sun.shadow.camera.far = 55
    env.add(sun)
    env.add(sun.target)
    this._setShadowQuality(sun)
    const points = []
    for (const [x, z] of [[4.5, 2.8], [11.4, 5.0], [13.2, 9.0]]) {
      const p = new T.PointLight(theme.ambient, 12, 9, 2)
      p.position.set(x, 2.75, z)
      p.castShadow = false
      env.add(p)
      points.push(p)
    }
    this._lights = { hemi, amb, sun, points }
  }

  AgentOfficeScene3D.prototype._setShadowQuality = function (sun) {
    const q = QUALITIES[this.quality] || QUALITIES.high
    sun = sun || (this._lights && this._lights.sun)
    if (!sun) return
    sun.shadow.mapSize.set(q.shadow, q.shadow)
    if (sun.shadow.map) {
      sun.shadow.map.dispose()
      sun.shadow.map = null
    }
  }

  AgentOfficeScene3D.prototype._applyTime = function () {
    if (!this.scene) return
    const theme = this.theme
    const info = this.timeInfo || timeOfDay(new Date())
    const day = info.dayFactor
    const themeSkyDay = theme.skyDay || "#9ecdf7"
    const themeSkyNight = theme.skyNight || "#0b1224"
    let sky = mixColor(themeSkyNight, themeSkyDay, day)
    // keep a little scene identity: castles and graveyards stay darker
    if (theme.id === "graveyard") sky = darken(sky, 0.3)
    if (theme.id === "castle") sky = darken(sky, 0.12)
    this.scene.background = new THREE.Color(sky)
    if (this.scene.fog) this.scene.fog.color.set(sky)
    else this.scene.fog = new THREE.Fog(sky, 26, 52)
    if (this._lights) {
      const { hemi, amb, sun, points } = this._lights
      if (hemi) {
        hemi.color.set(mixColor(info.sky, theme.ambient, 0.5))
        hemi.groundColor.set(darken(theme.floor, 0.55))
        hemi.intensity = 0.3 + info.ambient * 0.75
      }
      if (amb) amb.intensity = 0.08 + info.ambient * 0.18
      if (sun) {
        sun.color.set(info.sun)
        sun.intensity = info.sunIntensity
        const angle = ((info.hour - 6) / 12) * Math.PI
        const y = Math.max(1.5, Math.sin(angle) * 23)
        sun.position.set(ROOM.w / 2 + Math.cos(angle) * 22, y, -10)
        sun.target.position.set(ROOM.w / 2, 0, ROOM.d / 2)
      }
      if (points) for (const p of points) {
        p.color.set(mixColor(theme.ambient, info.window, 0.35))
        p.intensity = 8 + (1 - day) * 11
      }
    }
    const wc = mixColor(theme.windowNight || info.window, theme.windowDay || info.window, day)
    for (const m of this._windowMats || []) {
      m.color.set(wc)
      m.emissive.set(wc)
      m.emissiveIntensity = 0.5 + (1 - day) * 1.2
    }
    if (this.renderer) {
      this.renderer.toneMappingExposure = theme.id === "graveyard" ? 1.18 : 1.08
    }
    return info
  }

  AgentOfficeScene3D.prototype.refreshTime = function (date) {
    this.timeInfo = timeOfDay(date instanceof Date ? date : new Date())
    this._applyTime()
    return this.timeInfo
  }

  // ---- desks, chairs, monitors ---------------------------------------

  AgentOfficeScene3D.prototype._buildDesks = function (env, theme) {
    for (const d of DESKS) {
      const g = new THREE.Group()
      env.add(g)
      const cx = d.x + d.w / 2
      const cz = d.z + d.d / 2
      const topY = 0.76
      this._box(g, theme.desk, cx, topY, cz, d.w, 0.08, d.d)
      this._box(g, lighten(theme.desk, 0.12), cx, topY + 0.045, cz, d.w - 0.04, 0.03, d.d - 0.04)
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        this._box(g, darken(theme.desk, 0.35), cx + sx * (d.w / 2 - 0.12), 0.36, cz + sz * (d.d / 2 - 0.12), 0.08, 0.72, 0.08)
      }
      this._box(g, darken(theme.desk, 0.22), cx, 0.34, cz + (d.seat[1] > cz ? d.d / 2 - 0.04 : -d.d / 2 + 0.04), d.w - 0.2, 0.26, 0.05)
      // monitor: sits away from the worker, screen faces the seat
      const dx = cx - d.seat[0], dz = cz - d.seat[1]
      const len = Math.max(0.001, Math.hypot(dx, dz))
      const nx = dx / len, nz = dz / len
      const mx = cx + nx * 0.18, mz = cz + nz * 0.18
      this._box(g, darken(theme.metal, 0.5), mx, topY + 0.12, mz, 0.34, 0.05, 0.22)
      this._box(g, theme.metal, mx, topY + 0.22, mz, 0.07, 0.2, 0.07)
      const screen = this._box(g, darken(theme.metal, 0.55), mx, topY + 0.4, mz, 0.62, 0.4, 0.055)
      screen.castShadow = false
      if (!this._textures.screen) this._textures.screen = this._makeScreenTexture()
      if (this._textures.screen) {
        if (!this._screenMat) {
          this._screenMat = new THREE.MeshBasicMaterial({ map: this._textures.screen, toneMapped: false })
          this._envMat.add(this._screenMat)
        }
        const s = this._mesh(g, this.gPlane, null, {
          mat: this._screenMat, x: mx - nx * 0.033, y: topY + 0.4, z: mz - nz * 0.033,
          sx: 0.56, sy: 0.32, ry: Math.atan2(-nx, -nz), cast: false, receive: false,
        })
        s.name = "monitor-screen"
      }
      // keyboard and desk clutter
      const kx = cx - nx * 0.18, kz = cz - nz * 0.18
      this._box(g, darken(theme.metal, 0.55), kx, topY + 0.06, kz, 0.46, 0.035, 0.16)
      this._cyl(g, "#e5e7eb", cx - nx * 0.18 - 0.38, topY + 0.09, cz - nz * 0.18, 0.055, 0.12, { cast: true })
      this._box(g, "#f8fafc", cx + nx * 0.2, topY + 0.06, cz + nz * 0.2, 0.24, 0.01, 0.3, { cast: false })
      this._buildChair(g, d, theme)
    }
  }

  AgentOfficeScene3D.prototype._makeScreenTexture = function () {
    return this._texture(160, 100, (ctx, w, h) => {
      ctx.fillStyle = "#0b1224"
      ctx.fillRect(0, 0, w, h)
      ctx.fillStyle = "#12213d"
      ctx.fillRect(0, 0, w, 14)
      const colors = ["#38bdf8", "#a78bfa", "#34d399", "#f59e0b", "#f472b6"]
      const rand = mulberry32(20241031)
      for (let i = 0; i < 11; i++) {
        const y = 20 + i * 7
        const x = 8 + (i % 3) * 8
        ctx.fillStyle = colors[i % colors.length]
        ctx.globalAlpha = 0.75
        ctx.fillRect(x, y, 18 + rand() * (w - x - 26), 3)
      }
      ctx.globalAlpha = 1
      ctx.fillStyle = "#38bdf8"
      ctx.fillRect(w - 24, 4, 6, 6)
    })
  }

  AgentOfficeScene3D.prototype._buildChair = function (parent, d, theme) {
    const [sx, sz] = d.seat
    const g = new THREE.Group()
    g.position.set(sx, 0, sz)
    g.rotation.y = faceAngle(d.face)
    parent.add(g)
    const chair = mixColor(theme.chair, theme.accent, 0.1)
    this._box(g, chair, 0, 0.46, 0, 0.52, 0.08, 0.5)
    this._box(g, darken(chair, 0.15), 0, 0.74, -0.23, 0.5, 0.55, 0.07)
    this._box(g, chair, 0, 0.46, 0.24, 0.46, 0.1, 0.06)
    for (const x of [-0.2, 0.2]) for (const z of [-0.2, 0.2]) {
      this._box(g, darken(theme.metal, 0.5), x, 0.22, z, 0.055, 0.44, 0.055)
    }
    this._cyl(g, darken(theme.metal, 0.4), 0, 0.06, 0.14, 0.03, 0.12)
    this._box(g, "rgba(30,41,59,.9)", 0, 0.03, 0.14, 0.35, 0.03, 0.12, { cast: false })
  }

  // ---- sofas, rug, plants, coffee, games ------------------------------

  AgentOfficeScene3D.prototype._buildSofa = function (env, theme) {
    const fabric = theme.sofa
    const cushion = lighten(fabric, 0.1)
    // west sofa: face east, against the west wall
    const ws = new THREE.Group()
    ws.position.set(1.05, 0, 6.6)
    env.add(ws)
    this._box(ws, darken(fabric, 0.3), 0, 0.2, 0, 1.45, 0.34, 4.25)
    this._box(ws, fabric, 0, 0.4, 0, 1.3, 0.18, 4.1)
    this._box(ws, darken(fabric, 0.16), -0.55, 0.65, 0, 0.3, 0.85, 4.25)
    for (const z of [-2.02, 2.02]) this._box(ws, fabric, 0.05, 0.55, z, 1.45, 0.5, 0.22)
    for (const z of [-1.6, -0.55, 0.5, 1.55]) {
      this._box(ws, cushion, 0.05, 0.52, z, 1.18, 0.14, 0.92)
      this._box(ws, mixColor(fabric, "#ffffff", 0.18), 0.24, 0.66, z, 0.12, 0.45, 0.8, { cast: false })
    }
    for (const z of [-1.7, 1.7]) this._box(ws, darken(theme.wood, 0.2), 0.4, 0.08, z, 0.2, 0.16, 0.2)
    // south sofa: faces north
    const ss = new THREE.Group()
    ss.position.set(3.8, 0, 11.05)
    env.add(ss)
    this._box(ss, darken(fabric, 0.3), 0, 0.2, 0, 2.5, 0.34, 1.3)
    this._box(ss, fabric, 0, 0.4, 0, 2.4, 0.18, 1.16)
    this._box(ss, darken(fabric, 0.16), 0, 0.65, 0.54, 2.5, 0.85, 0.28)
    for (const x of [-1.18, 1.18]) this._box(ss, fabric, x, 0.55, 0, 0.22, 0.5, 1.3)
    for (const x of [-0.62, 0.62]) {
      this._box(ss, cushion, x, 0.52, 0, 1.1, 0.14, 0.92)
      this._box(ss, mixColor(fabric, "#ffffff", 0.18), x, 0.66, -0.24, 0.8, 0.45, 0.12, { cast: false })
    }
    // rug under the lounge
    this._box(env, mixColor(theme.accent, theme.floor, 0.72), 3.5, 0.012, 7.0, 4.4, 0.02, 4.6, { cast: false })
    this._box(env, mixColor(theme.accent, theme.floor, 0.55), 3.5, 0.016, 7.0, 3.9, 0.02, 4.1, { cast: false })
    // Keep the lounge aisle clear for workers moving to the waiting area.
  }

  AgentOfficeScene3D.prototype._buildBaseProps = function (env, theme) {
    // plants in the corners and by the lounge
    const spots = [[0.7, 11.25], [15.25, 11.1], [15.2, 5.7], [0.55, 3.35], [2.8, 3.1], [13.9, 11.0]]
    for (let i = 0; i < spots.length; i++) this._buildPlant(env, theme, spots[i][0], spots[i][1], 0.65 + (i % 3) * 0.13)
    // hanging lamps
    for (const [x, z] of [[4.4, 2.6], [11.4, 5.0], [13.2, 9.0]]) {
      this._cyl(env, darken(theme.metal, 0.4), x, 2.9, z, 0.012, 0.55, { cast: false })
      this._cone(env, theme.accent, x, 2.58, z, 0.28, 0.2, { cast: false, emissive: theme.accent, ei: 0.35 })
      this._sphere(env, "#fff3d4", x, 2.47, z, 0.1, { cast: false, emissive: "#fff3d4", ei: 1.2 })
    }
    // wall clock
    this._cyl(env, theme.trim, 7.5, 2.45, 0.15, 0.22, 0.05, { rx: Math.PI / 2, cast: false })
    this._box(env, "#1f2937", 7.5, 2.47, 0.2, 0.03, 0.14, 0.015, { cast: false })
    this._box(env, "#1f2937", 7.56, 2.45, 0.2, 0.12, 0.025, 0.015, { cast: false })
  }

  AgentOfficeScene3D.prototype._buildPlant = function (parent, theme, x, z, scale) {
    const g = new THREE.Group()
    g.position.set(x, 0, z)
    g.scale.setScalar(scale)
    parent.add(g)
    this._cyl(g, mixColor(theme.wood, "#000000", 0.25), 0, 0.2, 0, 0.26, 0.4)
    this._cyl(g, darken(theme.wood, 0.15), 0, 0.42, 0, 0.22, 0.05)
    this._cyl(g, "#3d2b1f", 0, 0.68, 0, 0.035, 0.5)
    const rand = mulberry32(hashKey("plant" + x + ":" + z))
    for (let i = 0; i < 7; i++) {
      const a = rand() * TAU
      const r = 0.12 + rand() * 0.3
      const y = 0.75 + rand() * 0.5
      this._ico(g, mixColor(theme.plant, i % 2 ? "#ffffff" : "#000000", i % 2 ? 0.12 : 0.12), Math.cos(a) * r, y, Math.sin(a) * r, 0.16 + rand() * 0.12, { cast: false })
    }
    if (parent === this.env) this._placeDecoration(g)
  }

  AgentOfficeScene3D.prototype._propBuilders = {}

  AgentOfficeScene3D.prototype._propBuilders.coffee = function (env, theme) {
    const g = new THREE.Group()
    env.add(g)
    this._box(g, theme.wood, 1.65, 0.5, 0.82, 2.2, 0.9, 0.8)
    this._box(g, lighten(theme.wood, 0.25), 1.65, 0.97, 0.82, 2.3, 0.08, 0.9)
    this._box(g, darken(theme.metal, 0.55), 1.15, 1.2, 0.82, 0.5, 0.38, 0.4)
    this._box(g, "#d1d5db", 1.15, 1.4, 0.82, 0.42, 0.05, 0.32, { cast: false })
    this._cyl(g, "#111827", 1.05, 1.06, 1.0, 0.07, 0.12)
    this._cyl(g, "#111827", 1.25, 1.06, 1.0, 0.07, 0.12)
    this._cyl(g, "#f8fafc", 1.05, 0.97, 1.0, 0.055, 0.07, { cast: false })
    this._cyl(g, "#f8fafc", 1.25, 0.97, 1.0, 0.055, 0.07, { cast: false })
    // a sign and little cups
    this._box(g, darken(theme.wood, 0.2), 1.65, 1.5, 0.35, 1.2, 0.55, 0.08, { cast: false })
    this._box(g, theme.accent, 1.65, 1.5, 0.3, 1.0, 0.4, 0.02, { emissive: theme.accent, ei: 0.3, cast: false })
    for (let i = 0; i < 3; i++) this._cyl(g, ["#e5e7eb", "#f59e0b", "#38bdf8"][i], 2.2 + i * 0.24, 1.04, 1.0, 0.05, 0.11)
  }

  AgentOfficeScene3D.prototype._propBuilders.pingpong = function (env, theme) {
    const g = new THREE.Group()
    env.add(g)
    const x = 4.45, z = 4.65
    this._box(g, "#0f766e", x, 0.76, z, 2.45, 0.08, 1.4)
    this._box(g, "#f8fafc", x, 0.81, z, 2.35, 0.012, 1.3, { cast: false })
    this._box(g, "#f8fafc", x, 0.83, z, 0.035, 0.22, 1.36, { cast: false })
    this._box(g, "#f8fafc", x, 0.805, z, 2.35, 0.012, 0.035, { cast: false })
    for (const sx of [-1.05, 1.05]) for (const sz of [-0.55, 0.55]) this._box(g, darken(theme.metal, 0.4), x + sx, 0.36, z + sz, 0.07, 0.7, 0.07)
    for (const [px, pz, r] of [[x - 0.75, z - 0.2, 0.12], [x + 0.8, z + 0.22, 0.12]]) {
      this._cyl(g, "#dc2626", px, 0.84, pz, r, 0.03, { rx: 0.25, cast: false })
      this._box(g, "#7c2d12", px + 0.16, 0.84, pz, 0.18, 0.03, 0.05, { cast: false })
    }
    this._sphere(g, "#f8fafc", x - 0.3, 0.88, z + 0.1, 0.055, { cast: false })
  }

  AgentOfficeScene3D.prototype._propBuilders.bookshelf = function (env, theme) {
    const g = new THREE.Group()
    env.add(g)
    const x = 15.22, z = 2.4
    this._box(g, theme.wood, x, 1.15, z, 0.3, 2.3, 2.3)
    // the open side faces the camera (east), so the books read at a glance
    for (const zz of [-1.08, 1.08]) this._box(g, darken(theme.wood, 0.15), x + 0.1, 1.15, z + zz, 0.24, 2.24, 0.08, { cast: false })
    for (let i = 0; i < 4; i++) this._box(g, lighten(theme.wood, 0.16), x + 0.12, 0.42 + i * 0.5, z, 0.26, 0.05, 2.15, { cast: false })
    this._box(g, darken(theme.wood, 0.25), x - 0.02, 1.15, z, 0.06, 2.18, 2.18, { cast: false })
    const rand = mulberry32(hashKey(theme.id + "books"))
    const cols = [theme.accent, "#ef4444", "#f59e0b", "#10b981", "#8b5cf6", "#e2e8f0"]
    for (let row = 0; row < 4; row++) for (let i = 0; i < 9; i++) {
      if (rand() < 0.16) continue
      const h = 0.23 + rand() * 0.16
      this._box(g, cols[Math.floor(rand() * cols.length)], x + 0.22, 0.48 + row * 0.5 + h / 2, z - 0.92 + i * 0.23, 0.13, h, 0.16, { cast: false })
    }
  }

  AgentOfficeScene3D.prototype._propBuilders.whiteboard = function (env, theme) {
    const g = new THREE.Group()
    g.position.set(14.65, 0, 0.16)
    env.add(g)
    this._box(g, theme.trim, 0, 1.75, 0, 1.9, 1.2, 0.09)
    const tex = this._texture(512, 300, (ctx, w, h) => {
      ctx.fillStyle = "#f8fafc"
      ctx.fillRect(0, 0, w, h)
      ctx.strokeStyle = "#e2e8f0"
      ctx.lineWidth = 2
      for (let x = 0; x <= w; x += 32) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke() }
      for (let y = 0; y <= h; y += 32) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke() }
      ctx.fillStyle = "#1e293b"
      ctx.font = "bold 30px ui-sans-serif, system-ui, sans-serif"
      ctx.fillText("SHIP IT", 34, 52)
      ctx.fillStyle = "#2563eb"
      ctx.fillRect(36, 78, 210, 6)
      ctx.fillRect(36, 102, 160, 6)
      ctx.fillStyle = "#16a34a"
      ctx.fillRect(36, 140, 300, 5)
      ctx.fillRect(36, 164, 250, 5)
      ctx.fillStyle = "#f59e0b"
      ctx.fillRect(36, 202, 190, 5)
      ctx.fillStyle = "#dc2626"
      ctx.beginPath(); ctx.arc(390, 168, 46, 0, TAU); ctx.stroke()
      ctx.font = "bold 20px ui-sans-serif, system-ui, sans-serif"
      ctx.fillText("next", 368, 174)
    })
    if (tex) {
      const m = new THREE.MeshBasicMaterial({ map: tex })
      this._envMat.add(m)
      this._mesh(g, this.gPlane, null, { mat: m, x: 0, y: 1.75, z: 0.06, sx: 1.7, sy: 1.0 })
    }
    this._box(g, darken(theme.metal, 0.4), 0, 1.1, 0.08, 1.9, 0.06, 0.16)
    for (const x of [-0.55, 0.1, 0.7]) this._box(g, ["#2563eb", "#dc2626", "#16a34a"][Math.floor((x + 1) * 10) % 3], x, 1.16, 0.08, 0.02, 0.18, 0.02, { cast: false })
  }

  AgentOfficeScene3D.prototype._propBuilders.arcade = function (env, theme) {
    const g = new THREE.Group()
    g.position.set(15.05, 0, 9.68)
    g.rotation.y = -0.22
    env.add(g)
    this._box(g, darken(theme.accent, 0.45), 0, 0.85, 0, 0.9, 1.7, 0.72)
    this._box(g, "#111827", 0, 1.08, 0.38, 0.72, 0.52, 0.03, { cast: false })
    this._box(g, "#111827", 0, 1.6, 0.38, 0.78, 0.2, 0.05, { cast: false })
    this._box(g, theme.accent, 0, 1.62, 0.41, 0.7, 0.12, 0.01, { emissive: theme.accent, ei: 0.9, cast: false })
    this._box(g, "#0b1224", 0, 1.22, 0.42, 0.62, 0.42, 0.03, { cast: false })
    const tex = this._texture(128, 96, (ctx, w, h) => {
      ctx.fillStyle = "#0b1224"; ctx.fillRect(0, 0, w, h)
      const rand = mulberry32(77)
      for (let i = 0; i < 45; i++) {
        ctx.fillStyle = ["#22d3ee", "#f472b6", "#facc15", "#4ade80"][Math.floor(rand() * 4)]
        ctx.fillRect(Math.floor(rand() * w / 8) * 8, Math.floor(rand() * h / 8) * 8, 8, 8)
      }
      ctx.fillStyle = "#f8fafc"; ctx.font = "bold 14px ui-sans-serif, system-ui, sans-serif"; ctx.fillText("PLAY", 8, 18)
    })
    if (tex) {
      const m = new THREE.MeshBasicMaterial({ map: tex })
      this._envMat.add(m)
      this._mesh(g, this.gPlane, null, { mat: m, x: 0, y: 1.22, z: 0.44, sx: 0.55, sy: 0.36 })
    }
    this._box(g, "#1f2937", 0, 0.96, 0.55, 0.7, 0.08, 0.26, { cast: false })
    this._cyl(g, "#ef4444", -0.14, 1.04, 0.55, 0.04, 0.14)
    this._sphere(g, "#ef4444", -0.14, 1.12, 0.55, 0.055, { cast: false })
    this._cyl(g, "#22d3ee", 0.13, 1.02, 0.55, 0.03, 0.06, { cast: false })
    this._cyl(g, "#facc15", 0.24, 1.02, 0.55, 0.03, 0.06, { cast: false })
  }

  // ---- scene-specific props ------------------------------------------

  AgentOfficeScene3D.prototype._propBuilders.console = function (env, theme) {
    const g = new THREE.Group()
    g.position.set(13.1, 0, 3.3)
    env.add(g)
    this._box(g, theme.metal, 0, 0.5, 0, 1.6, 0.2, 0.9)
    this._box(g, darken(theme.metal, 0.4), 0, 0.4, 0, 1.4, 0.8, 0.2)
    for (let i = -1; i <= 1; i++) {
      this._box(g, "#0b1224", i * 0.45, 0.85, -0.1, 0.36, 0.28, 0.04, { cast: false })
      this._box(g, i === 0 ? "#22d3ee" : "#38bdf8", i * 0.45, 0.85, -0.075, 0.28, 0.16, 0.01, { emissive: "#22d3ee", ei: 0.8, cast: false })
    }
    this._box(g, theme.accent, 0, 0.62, 0.2, 1.3, 0.03, 0.2, { emissive: theme.accent, ei: 0.4, cast: false })
  }

  AgentOfficeScene3D.prototype._propBuilders.reactor = function (env, theme) {
    const g = new THREE.Group()
    g.position.set(14.45, 0, 6.9)
    env.add(g)
    this._cyl(g, darken(theme.metal, 0.45), 0, 0.3, 0, 0.65, 0.6)
    this._cyl(g, "#0b1224", 0, 1.0, 0, 0.4, 1.1)
    this._cyl(g, "#22d3ee", 0, 1.05, 0, 0.26, 0.9, { emissive: "#22d3ee", ei: 1.4, cast: false })
    this._mesh(g, this.gTorus, "#22d3ee", { x: 0, y: 1.2, z: 0, rx: Math.PI / 2, emissive: "#22d3ee", ei: 1.1, cast: false })
    this._mesh(g, this.gTorus, "#22d3ee", { x: 0, y: 0.8, z: 0, rx: Math.PI / 2, sx: 0.8, sy: 0.8, sz: 0.8, emissive: "#22d3ee", ei: 1.1, cast: false })
    const light = new THREE.PointLight("#22d3ee", 9, 6, 2)
    light.position.set(0, 1.2, 0)
    g.add(light)
  }

  AgentOfficeScene3D.prototype._propBuilders.holo = function (env, theme) {
    const g = new THREE.Group()
    g.position.set(6.7, 0, 3.35)
    env.add(g)
    this._cyl(g, darken(theme.metal, 0.4), 0, 0.25, 0, 0.7, 0.5)
    this._cyl(g, theme.accent, 0, 0.52, 0, 0.66, 0.06, { emissive: theme.accent, ei: 0.6, cast: false })
    this._ico(g, "#22d3ee", 0, 1.05, 0, 0.36, { emissive: "#22d3ee", ei: 1.1, cast: false, opacity: 0.82 })
    this._mesh(g, this.gTorus, "#22d3ee", { x: 0, y: 1.05, z: 0, rx: Math.PI / 2, sy: 0.5, emissive: "#22d3ee", ei: 0.9, cast: false })
    const light = new THREE.PointLight("#22d3ee", 6, 4.5, 2)
    light.position.set(0, 1.1, 0)
    g.add(light)
  }

  AgentOfficeScene3D.prototype._propBuilders.cafe = function (env, theme) {
    // counter and espresso bar along the east wall
    const g = new THREE.Group()
    env.add(g)
    this._box(g, theme.wood, 14.7, 0.5, 6.2, 0.9, 1.0, 2.6)
    this._box(g, lighten(theme.wood, 0.18), 14.7, 1.02, 6.2, 1.0, 0.08, 2.7)
    this._box(g, darken(theme.metal, 0.5), 14.55, 1.28, 5.8, 0.5, 0.42, 0.6)
    this._box(g, "#e5e7eb", 14.55, 1.48, 5.8, 0.44, 0.05, 0.52, { cast: false })
    for (let i = 0; i < 5; i++) this._cyl(g, ["#f59e0b", "#f8fafc", "#38bdf8", "#ef4444", "#10b981"][i], 14.5, 1.08, 5.1 + i * 0.28, 0.09, 0.1)
    // two round tables with stools
    for (const [x, z] of [[5.0, 4.45], [7.5, 5.3]]) {
      const g = new THREE.Group()
      env.add(g)
      this._cyl(g, theme.wood, x, 0.72, z, 0.55, 0.08)
      this._cyl(g, darken(theme.metal, 0.4), x, 0.36, z, 0.07, 0.72)
      this._cyl(g, darken(theme.metal, 0.4), x, 0.03, z, 0.3, 0.06)
      for (const a of [0, TAU / 3, (TAU * 2) / 3]) {
        const sx = x + Math.cos(a) * 0.85, sz = z + Math.sin(a) * 0.85
        this._cyl(g, theme.accent, sx, 0.32, sz, 0.22, 0.07)
        this._cyl(g, darken(theme.metal, 0.4), sx, 0.15, sz, 0.03, 0.3)
      }
      this._cyl(g, "#f8fafc", x + 0.12, 0.8, z - 0.08, 0.08, 0.08)
    }
    // string lights across the room
    for (let i = 0; i < 9; i++) {
      const x = 2.2 + i * 1.45
      this._sphere(env, "#ffe6a3", x, 2.65 + Math.sin(i * 1.3) * 0.08, 7.4, 0.07, { emissive: "#ffd27a", ei: 1.4, cast: false })
    }
  }

  AgentOfficeScene3D.prototype._propBuilders.throne = function (env, theme) {
    const g = new THREE.Group()
    g.position.set(7.3, 0, 11.1)
    env.add(g)
    this._box(g, darken(theme.wall, 0.2), 0, 0.12, 0, 2.2, 0.24, 1.3)
    this._box(g, darken(theme.wall, 0.3), 0, 0.28, -0.2, 1.8, 0.32, 1.0)
    this._box(g, theme.accent, 0, 0.48, -0.15, 1.0, 0.14, 0.8, { metal: 0.6, rough: 0.35 })
    this._box(g, theme.accent, 0, 1.25, 0.5, 1.4, 1.65, 0.2, { metal: 0.6, rough: 0.35 })
    this._box(g, "#7f1d1d", 0, 1.2, 0.36, 1.0, 1.15, 0.1)
    this._box(g, theme.accent, 0, 2.14, 0.5, 1.6, 0.1, 0.26, { metal: 0.7, rough: 0.3 })
    for (const x of [-0.45, 0.45]) this._sphere(g, theme.accent, x, 2.24, 0.5, 0.09, { metal: 0.8, rough: 0.3 })
    this._box(g, "#7f1d1d", 0, 0.62, 0.8, 1.6, 0.1, 0.6)
  }

  AgentOfficeScene3D.prototype._propBuilders.banners = function (env, theme) {
    for (const x of [2.2, 6.2, 11.8]) {
      this._box(env, darken(theme.accent, 0.25), x, 2.1, 0.08, 0.9, 1.5, 0.04, { cast: false })
      this._box(env, theme.trim, x, 2.1, 0.12, 0.26, 0.26, 0.02, { cast: false })
      this._cone(env, darken(theme.accent, 0.25), x, 1.28, 0.09, 0.5, 0.22, { ry: Math.PI / 2, cast: false })
    }
    const g = new THREE.Group()
    g.position.set(0.1, 0, 7.6)
    g.rotation.y = Math.PI / 2
    env.add(g)
    this._box(g, darken(theme.accent, 0.25), 0, 2.1, 0, 0.9, 1.5, 0.04, { cast: false })
    this._box(g, theme.trim, 0, 2.1, 0.06, 0.26, 0.26, 0.02, { cast: false })
  }

  AgentOfficeScene3D.prototype._propBuilders.braziers = function (env, theme) {
    for (const [x, z] of [[3.2, 10.85], [9.0, 10.85]]) {
      const g = new THREE.Group()
      g.position.set(x, 0, z)
      env.add(g)
      this._cyl(g, darken(theme.metal, 0.4), 0, 0.32, 0, 0.34, 0.64)
      this._cyl(g, theme.metal, 0, 0.72, 0, 0.42, 0.14)
      this._cone(g, "#f59e0b", 0, 0.96, 0, 0.26, 0.42, { emissive: "#f59e0b", ei: 1.3, cast: false })
      this._cone(g, "#fbbf24", 0, 1.02, 0, 0.16, 0.3, { emissive: "#fbbf24", ei: 1.5, cast: false })
      const light = new THREE.PointLight("#f59e0b", 5, 4, 2)
      light.position.set(0, 1.15, 0)
      g.add(light)
    }
  }

  AgentOfficeScene3D.prototype._propBuilders.barrels = function (env, theme) {
    const g = new THREE.Group()
    g.position.set(1.4, 0, 9.4)
    env.add(g)
    for (const [x, z, y, r] of [[0, 0, 0.38, 0.32], [0.65, 0.1, 0.38, 0.3], [0.3, 0.65, 0.38, 0.3], [0.3, 0.25, 1.0, 0.28]]) {
      this._cyl(g, theme.wood, x, y, z, r, 0.75)
      for (const yy of [-0.22, 0.22]) this._mesh(g, this.gTorus, theme.metal, { x, y: y + yy, z, rx: Math.PI / 2, sx: r / 0.34, sy: r / 0.34, sz: r / 0.34, metal: 0.5, rough: 0.5 })
    }
    this._buildPlant(g, theme, 0.6, 0.7, 0.55)
  }

  AgentOfficeScene3D.prototype._propBuilders.treasure = function (env, theme) {
    const g = new THREE.Group()
    g.position.set(12.05, 0, 10.7)
    env.add(g)
    this._box(g, "#7c2d12", 0, 0.3, 0, 1.0, 0.6, 0.7)
    this._box(g, "#b45309", 0, 0.64, -0.3, 1.0, 0.18, 0.2)
    this._box(g, theme.accent, 0, 0.5, 0.34, 0.2, 0.2, 0.08, { metal: 0.7, rough: 0.3 })
    for (let i = 0; i < 12; i++) {
      const a = i * 1.9
      this._cyl(g, i % 3 ? theme.accent : "#fde68a", 0.35 + Math.cos(a) * 0.28, 0.72 + (i % 2) * 0.04, Math.sin(a) * 0.22, 0.07, 0.035, { cast: false })
    }
    this._cyl(g, "#e5e7eb", -0.15, 1.0, 0.1, 0.03, 0.5, { rz: 0.7 })
    this._box(g, "#e5e7eb", -0.05, 1.2, 0.1, 0.28, 0.06, 0.16, { cast: false })
  }

  AgentOfficeScene3D.prototype._propBuilders.mast = function (env, theme) {
    const g = new THREE.Group()
    g.position.set(12.9, 0, 7.2)
    env.add(g)
    this._cyl(g, theme.wood, 0, 1.9, 0, 0.16, 3.8)
    this._cyl(g, darken(theme.wood, 0.3), 0, 2.6, 0, 0.06, 2.8, { rz: Math.PI / 2 })
    const sail = this._box(g, "#f1e5cf", 0, 2.9, 0.02, 2.4, 1.5, 0.04, { cast: false })
    sail.rotation.y = 0.12
    this._box(g, "#f8fafc", 0, 3.6, 0.05, 0.7, 0.7, 0.02, { cast: false })
    this._box(g, "#0b1224", 0, 3.6, 0.06, 0.5, 0.14, 0.01, { cast: false })
    this._box(g, "#0b1224", 0, 3.52, 0.06, 0.34, 0.08, 0.01, { cast: false })
    this._box(g, theme.accent, 0, 4.15, 0, 0.5, 0.25, 0.04, { cast: false })
  }

  AgentOfficeScene3D.prototype._propBuilders.cannons = function (env, theme) {
    for (const [x, z, ry] of [[3.1, 11.2, 0], [9.2, 11.2, 0], [15.0, 10.9, -Math.PI / 2]]) {
      const g = new THREE.Group()
      g.position.set(x, 0, z)
      g.rotation.y = ry
      env.add(g)
      this._box(g, darken(theme.wood, 0.2), 0, 0.22, 0, 1.0, 0.2, 0.55)
      this._cyl(g, "#111827", 0, 0.42, 0, 0.18, 1.25, { rz: Math.PI / 2 })
      this._cyl(g, "#374151", 0, 0.42, 0.55, 0.22, 0.1, { rz: Math.PI / 2 })
      for (const wx of [-0.35, 0.35]) this._cyl(g, darken(theme.wood, 0.3), wx, 0.18, 0, 0.2, 0.06, { rx: Math.PI / 2 })
    }
  }

  AgentOfficeScene3D.prototype._propBuilders.tombstones = function (env, theme) {
    const rand = mulberry32(1013)
    for (let i = 0; i < 9; i++) {
      const x = 4.3 + (i % 5) * 0.95 + rand() * 0.14
      const z = 10.75 + Math.floor(i / 5) * 0.55 + rand() * 0.1
      const g = new THREE.Group()
      g.position.set(x, 0, z)
      g.rotation.z = (rand() - 0.5) * 0.12
      env.add(g)
      this._box(g, "#6b7280", 0, 0.42, 0, 0.5, 0.84, 0.14)
      this._cyl(g, "#6b7280", 0, 0.84, 0, 0.25, 0.08, { rx: Math.PI / 2, ry: Math.PI / 2 })
      this._box(g, "#4b5563", 0, 0.42, 0.08, 0.28, 0.02, 0.01, { cast: false })
    }
    for (const [x, z] of [[12.8, 11.2], [14.2, 10.9]]) {
      this._box(env, "#6b7280", x, 0.4, z, 0.44, 0.8, 0.14)
      this._cyl(env, "#6b7280", x, 0.8, z, 0.22, 0.07, { rx: Math.PI / 2, ry: Math.PI / 2 })
    }
  }

  AgentOfficeScene3D.prototype._propBuilders.deadtrees = function (env, theme) {
    for (const [x, z, s] of [[2.7, 10.8, 1], [15.1, 11.2, 0.85], [0.65, 8.7, 0.65]]) {
      const g = new THREE.Group()
      g.position.set(x, 0, z)
      g.scale.setScalar(s)
      env.add(g)
      this._cyl(g, "#3f3a34", 0, 1.2, 0, 0.13, 2.4)
      for (const [a, y, l] of [[0.4, 1.9, 0.9], [2.5, 1.6, 0.8], [4.3, 2.1, 0.7], [1.4, 2.35, 0.6]]) {
        this._cyl(g, "#3f3a34", Math.cos(a) * l * 0.4, y, Math.sin(a) * l * 0.4, 0.055, l, { rz: 0.9, ry: a })
      }
    }
  }

  AgentOfficeScene3D.prototype._propBuilders.candles = function (env, theme) {
    const rand = mulberry32(66)
    for (let i = 0; i < 10; i++) {
      const x = 4.2 + rand() * 4.3, z = 7.4 + rand() * 3.0
      this._cyl(env, "#e5e7eb", x, 0.12 + rand() * 0.1, z, 0.05, 0.22 + rand() * 0.2)
      this._sphere(env, "#fbbf24", x, 0.28 + rand() * 0.12, z, 0.035, { emissive: "#fbbf24", ei: 1.6, cast: false })
    }
    const light = new THREE.PointLight("#8b5cf6", 7, 6, 2)
    light.position.set(6.5, 1.4, 8.8)
    env.add(light)
  }

  // ---------------------------------------------------------------------
  // workers: voxel people with walk / sit / idle poses
  // ---------------------------------------------------------------------

  AgentOfficeScene3D.prototype._normalizeAgents = function (list) {
    if (!Array.isArray(list)) return []
    const seen = new Set()
    const out = []
    for (const item of list) {
      if (!item || typeof item !== "object") continue
      const key = typeof item.key === "string" ? item.key : (item.key == null ? "" : String(item.key))
      if (!key || seen.has(key)) continue
      seen.add(key)
      out.push({
        key,
        agent: item.agent == null ? key : String(item.agent),
        brand: item.brand && typeof item.brand === "object" ? item.brand : { name: key, color: "" },
        status: typeof item.status === "string" && item.status ? item.status.toLowerCase() : "idle",
        sub: item.sub == null ? "" : String(item.sub),
        title: item.title == null ? "" : String(item.title),
        project: item.project == null ? "" : String(item.project),
        at: item.at, step: item.step == null ? "" : String(item.step),
        query: item.query, reply: item.reply, error: item.error,
        idle: !!item.idle,
      })
      if (out.length >= MAX_AGENTS) break
    }
    return out
  }

  AgentOfficeScene3D.prototype._workerColor = function (a) {
    const brand = a.brand || {}
    if (brand.color) return colorToHex(brand.color, "")
    const h = hashKey(a.agent || a.key) % 360
    return "hsl(" + h + " 58% 46%)"
  }

  AgentOfficeScene3D.prototype._makeWorker = function (a) {
    const T = THREE
    const group = new T.Group()
    group.name = "worker:" + a.key
    const clothing = this._workerColor(a)
    const seed = hashKey(a.key)
    const skin = SKIN[seed % SKIN.length]
    const hair = HAIR[(seed >>> 3) % HAIR.length]
    const pants = PANTS[(seed >>> 6) % PANTS.length]
    const shoe = SHOES[(seed >>> 9) % SHOES.length]
    const parts = {}

    parts.legL = new T.Group()
    parts.legL.position.set(-0.11, 0.6, 0)
    group.add(parts.legL)
    this._box(parts.legL, pants, 0, -0.27, 0, 0.14, 0.52, 0.16)
    this._box(parts.legL, shoe, 0, -0.51, 0.03, 0.16, 0.1, 0.22)
    parts.legR = new T.Group()
    parts.legR.position.set(0.11, 0.6, 0)
    group.add(parts.legR)
    this._box(parts.legR, pants, 0, -0.27, 0, 0.14, 0.52, 0.16)
    this._box(parts.legR, shoe, 0, -0.51, 0.03, 0.16, 0.1, 0.22)

    this._box(group, clothing, 0, 0.88, 0, 0.42, 0.48, 0.26)
    this._box(group, mixColor(clothing, "#ffffff", 0.18), 0, 0.9, 0.13, 0.3, 0.3, 0.02, { cast: false })
    // badge with the status colour
    const badge = this._box(group, "#ffffff", 0.13, 0.96, 0.145, 0.1, 0.07, 0.02, { cast: false })
    parts.badge = badge
    this._box(group, darken(clothing, 0.35), 0, 1.12, 0, 0.46, 0.08, 0.24)

    parts.armL = new T.Group()
    parts.armL.position.set(-0.27, 1.06, 0)
    group.add(parts.armL)
    this._box(parts.armL, clothing, 0, -0.17, 0, 0.11, 0.36, 0.13)
    this._box(parts.armL, skin, 0, -0.38, 0, 0.1, 0.09, 0.11)
    parts.armR = new T.Group()
    parts.armR.position.set(0.27, 1.06, 0)
    group.add(parts.armR)
    this._box(parts.armR, clothing, 0, -0.17, 0, 0.11, 0.36, 0.13)
    this._box(parts.armR, skin, 0, -0.38, 0, 0.1, 0.09, 0.11)

    parts.head = new T.Group()
    parts.head.position.set(0, 1.27, 0)
    group.add(parts.head)
    this._box(parts.head, skin, 0, 0.11, 0, 0.3, 0.3, 0.28)
    this._box(parts.head, hair, 0, 0.28, -0.02, 0.32, 0.09, 0.3)
    this._box(parts.head, hair, 0, 0.15, -0.135, 0.3, 0.26, 0.04)
    this._box(parts.head, "#111827", -0.07, 0.13, 0.145, 0.045, 0.045, 0.012, { cast: false })
    this._box(parts.head, "#111827", 0.07, 0.13, 0.145, 0.045, 0.045, 0.012, { cast: false })
    // a lanyard with the brand colour
    this._box(group, clothing, 0, 1.02, 0.145, 0.2, 0.05, 0.02, { cast: false })
    this._box(group, "#f8fafc", 0, 0.91, 0.15, 0.08, 0.12, 0.02, { cast: false })

    group.position.set(ENTRY[0], 0, ENTRY[1])
    group.rotation.y = 0
    // Keep the articulated graph for poses and CPU interactions. Only the
    // instance batches render; invisible objects still update matrixWorld.
    const meshes = []
    group.traverse((mesh) => { if (mesh.isMesh) meshes.push(mesh) })
    group.visible = false
    this.workerGroup.add(group)
    return { group, parts, meshes }
  }

  AgentOfficeScene3D.prototype._syncWorkerInstances = function () {
    const buckets = new Map()
    this.workerGroup.updateMatrixWorld(true)
    this._workerInverse.copy(this.workerGroup.matrixWorld).invert()
    for (const rt of this._map.values()) {
      for (const mesh of rt.meshes) {
        const badge = mesh === rt.parts.badge
        // Status badges retain their exact emissive material. Body colors
        // multiply a white standard material through the instance color.
        const key = badge ? "badge:" + mesh.material.color.getHexString() : (mesh.castShadow ? "body" : "detail")
        let bucket = buckets.get(key)
        if (!bucket) {
          bucket = { meshes: [], material: badge ? mesh.material : this._mat("#ffffff"), cast: mesh.castShadow }
          buckets.set(key, bucket)
        }
        bucket.meshes.push(mesh)
      }
    }
    for (const batch of this._workerBatches.values()) { batch.count = 0; batch.visible = false }
    for (const [key, bucket] of buckets) {
      let batch = this._workerBatches.get(key)
      if (!batch || batch.instanceMatrix.count < bucket.meshes.length) {
        const capacity = Math.max(32, 2 ** Math.ceil(Math.log2(bucket.meshes.length)))
        if (batch) { this.workerGroup.remove(batch); batch.dispose() }
        batch = new THREE.InstancedMesh(this.gBox, bucket.material, capacity)
        batch.name = "worker-batch:" + key
        batch.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
        batch.castShadow = bucket.cast
        batch.receiveShadow = true
        // Walkers and departures move every frame; stale aggregate bounds
        // must never cull their bodies or shadows.
        batch.frustumCulled = false
        this.workerGroup.add(batch)
        this._workerBatches.set(key, batch)
      }
      batch.count = bucket.meshes.length
      batch.visible = true
      for (let i = 0; i < bucket.meshes.length; i++) {
        const mesh = bucket.meshes[i]
        this._workerMatrix.multiplyMatrices(this._workerInverse, mesh.matrixWorld)
        batch.setMatrixAt(i, this._workerMatrix)
        if (!key.startsWith("badge:")) batch.setColorAt(i, mesh.material.color)
      }
      batch.instanceMatrix.needsUpdate = true
      if (batch.instanceColor) batch.instanceColor.needsUpdate = true
    }
  }

  AgentOfficeScene3D.prototype._freeSpot = function (kind, key, current) {
    const order = [kind, ...(FALLBACKS[kind] || [])]
    for (const k of [...new Set([...order, ...Object.keys(POOLS)])]) {
      const pool = POOLS[k]
      if (!pool) continue
      const start = hashKey(key) % pool.length
      for (let i = 0; i < pool.length; i++) {
        const p = pool[(start + i) % pool.length]
        if (p === current || !this._taken.has(p.id)) return p
      }
    }
    return null
  }

  AgentOfficeScene3D.prototype._takeSpot = function (rt, spot) {
    if (rt.spot && rt.spot !== spot && this._taken.get(rt.spot.id) === rt.key) this._taken.delete(rt.spot.id)
    rt.spot = spot
    rt.kind = spot ? spot.kind : "wander"
    if (spot) this._taken.set(spot.id, rt.key)
  }

  AgentOfficeScene3D.prototype._arrive = function (rt) {
    if (rt.leaving) {
      rt.mode = "stand"
      rt.route = null
      rt.walkIndex = 0
      rt.walkT = 0
      rt.group.position.set(rt.pos.x, 0, rt.pos.z)
      return
    }
    const spot = rt.spot
    if (!spot) { rt.mode = "stand"; return }
    rt.pos.x = spot.x
    rt.pos.z = spot.z
    rt.group.position.set(spot.x, 0, spot.z)
    if (spot.kind === "desk" || spot.kind === "sofa") {
      rt.mode = "sit"
      rt.group.position.y = -0.14
      rt.group.rotation.y = faceAngle(spot.face)
    } else {
      rt.mode = "stand"
      rt.group.position.y = 0
      rt.group.rotation.y = faceAngle(spot.face)
    }
    rt.arrivedAt = this._anim
    rt.route = null
    rt.walkIndex = 0
    rt.walkT = 0
    this._setPose(rt)
  }

  AgentOfficeScene3D.prototype._startRoute = function (rt, route) {
    if (!Array.isArray(route) || route.length < 2) { this._arrive(rt); return }
    rt.route = route
    rt.walkIndex = 0
    rt.walkT = 0
    rt.mode = "walk"
    rt.group.position.y = 0
  }

  AgentOfficeScene3D.prototype._setPose = function (rt) {
    const p = rt.parts
    if (!p) return
    if (rt.mode === "walk") return
    if (rt.mode === "sit") {
      p.legL.rotation.x = -Math.PI / 2
      p.legR.rotation.x = -Math.PI / 2
      p.legL.rotation.z = 0
      p.legR.rotation.z = 0
      if (rt.data.idle) {
        p.head.rotation.z = 0.32
        p.head.rotation.x = 0.16
        p.armL.rotation.set(0.12, 0, 0.18)
        p.armR.rotation.set(0.12, 0, -0.18)
      } else {
        p.head.rotation.z = 0
        p.head.rotation.x = 0
        p.armL.rotation.set(-1.02, 0, -0.12)
        p.armR.rotation.set(-1.02, 0, 0.12)
      }
      return
    }
    p.legL.rotation.x = 0
    p.legR.rotation.x = 0
    p.legL.rotation.z = 0
    p.legR.rotation.z = 0
    if (rt.data.status === "waiting") {
      p.armL.rotation.set(-0.15, 0, 0.12)
      p.armR.rotation.set(0, 0, -2.35)
      p.head.rotation.x = -0.05
    } else if (rt.data.status === "error") {
      p.armL.rotation.set(-2.5, 0, 0.2)
      p.armR.rotation.set(-2.5, 0, -0.2)
      p.head.rotation.x = 0.28
    } else {
      p.armL.rotation.set(0.06, 0, 0.06)
      p.armR.rotation.set(0.06, 0, -0.06)
      p.head.rotation.x = 0
    }
    p.head.rotation.z = 0
  }

  AgentOfficeScene3D.prototype._animate = function (rt) {
    const p = rt.parts
    if (!p) return
    const t = this._anim
    if (rt.mode === "walk") {
      const swing = Math.sin(t * 10 + rt.phase)
      p.legL.rotation.x = swing * 0.62
      p.legR.rotation.x = -swing * 0.62
      p.armL.rotation.x = -swing * 0.48
      p.armR.rotation.x = swing * 0.48
      p.armL.rotation.z = 0.04
      p.armR.rotation.z = -0.04
      p.head.rotation.z = 0
      p.head.rotation.x = 0
      rt.group.position.y = Math.abs(Math.sin(t * 10 + rt.phase)) * 0.035
      return
    }
    rt.group.position.y = rt.mode === "sit" ? -0.14 : 0
    if (rt.mode === "sit") {
      if (rt.data.idle) {
        p.head.rotation.z = 0.32 + Math.sin(t * 1.3 + rt.phase) * 0.03
        p.head.rotation.x = 0.16
        p.armL.rotation.set(0.12, 0, 0.18)
        p.armR.rotation.set(0.12, 0, -0.18)
      } else {
        const type = Math.sin(t * 8.5 + rt.phase)
        p.armL.rotation.x = -1.02 + type * 0.14
        p.armR.rotation.x = -1.02 - type * 0.14
        p.head.rotation.x = 0.02 + Math.sin(t * 2.1 + rt.phase) * 0.03
        p.head.rotation.z = 0
      }
      return
    }
    // standing: waiting waves, errors hold their head, everyone breathes
    const breathe = Math.sin(t * 1.8 + rt.phase) * 0.015
    rt.group.position.y = breathe
    if (rt.data.status === "waiting") {
      p.armR.rotation.z = -2.35 + Math.sin(t * 5.2 + rt.phase) * 0.28
      p.armR.rotation.x = -0.1
      p.armL.rotation.set(0.05, 0, 0.08)
      p.head.rotation.x = Math.sin(t * 2.2) * 0.04
    } else if (rt.data.status === "error") {
      p.armL.rotation.set(-2.5 + Math.sin(t * 2.4) * 0.05, 0, 0.2)
      p.armR.rotation.set(-2.5 + Math.sin(t * 2.4 + 1) * 0.05, 0, -0.2)
      p.head.rotation.x = 0.28
    } else {
      p.armL.rotation.set(0.06 + Math.sin(t * 1.8) * 0.03, 0, 0.06)
      p.armR.rotation.set(0.06 - Math.sin(t * 1.8) * 0.03, 0, -0.06)
      p.head.rotation.x = Math.sin(t * 1.6 + rt.phase) * 0.025
      p.head.rotation.z = 0
    }
    p.legL.rotation.x = 0
    p.legR.rotation.x = 0
  }

  AgentOfficeScene3D.prototype._walk = function (rt, dt) {
    if (!rt.route || rt.walkIndex >= rt.route.length - 1) { this._arrive(rt); return }
    const target = rt.route[rt.walkIndex + 1]
    const dx = target[0] - rt.pos.x
    const dz = target[1] - rt.pos.z
    const dist = Math.hypot(dx, dz)
    if (dist < 1e-4) { rt.walkIndex++; return }
    const max = rt.speed * dt
    if (max >= dist) {
      rt.pos.x = target[0]
      rt.pos.z = target[1]
      rt.walkIndex++
      if (rt.walkIndex >= rt.route.length - 1) { this._arrive(rt); return }
    } else {
      rt.pos.x += (dx / dist) * max
      rt.pos.z += (dz / dist) * max
    }
    rt.group.position.set(rt.pos.x, Math.abs(Math.sin(this._anim * 10 + rt.phase)) * 0.035, rt.pos.z)
    rt.group.rotation.y = Math.atan2(dx, dz)
  }

  AgentOfficeScene3D.prototype.setAgents = function (list) {
    const arr = this._normalizeAgents(list)
    this.agents = arr
    this._pending = arr
    if (!this.available || !this.scene) return this
    const present = new Set(arr.map((a) => a.key))
    // Departing workers release reservations before replacements are seated.
    for (const [key, rt] of this._map) if (!present.has(key)) this._takeSpot(rt, null)
    for (const a of arr) {
      let rt = this._map.get(a.key)
      if (!rt) {
        const kind = spotKindForStatus(a.status)
        const spot = this._freeSpot(kind, a.key, null)
        const made = this._makeWorker(a)
        rt = {
          key: a.key, data: a, group: made.group, parts: made.parts, meshes: made.meshes,
          pos: { x: ENTRY[0], z: ENTRY[1] }, spot: null, kind: null,
          route: null, walkIndex: 0, walkT: 0, speed: 2.1 + (hashKey(a.key) % 30) / 100,
          mode: "walk", phase: (hashKey(a.key) % 100) / 18, leaving: false, at: this._anim,
        }
        this._map.set(a.key, rt)
        rt.lane = ((hashKey(a.key) % 7) - 3) * 0.07
        rt.speed = 2.1 + (hashKey(a.key) % 30) / 100
        this._takeSpot(rt, spot)
        this._startRoute(rt, spot ? laneRoute(spot.route, rt.lane) : dedupeRoute([ENTRY, [ENTRY[0] + 0.25, ENTRY[1]]]))
        if (rt.parts && rt.parts.badge) {
          rt.parts.badge.material = this._mat(STATUS_COLORS[a.status] || STATUS_COLORS.idle, { emissive: STATUS_COLORS[a.status] || STATUS_COLORS.idle, ei: 0.5 })
        }
      } else {
        const wasLeaving = rt.leaving
        rt.data = a
        rt.leaving = false
        rt.group.scale.setScalar(1)
        rt.fade = 1
        // status changes pick a new kind of seat, but keep the same seat otherwise
        const kind = spotKindForStatus(a.status)
        if (wasLeaving) {
          const spot = this._freeSpot(kind, a.key, rt.spot)
          if (spot) {
            this._takeSpot(rt, spot)
            this._startRoute(rt, laneRoute(connectRoute([rt.pos.x, rt.pos.z], spot.route), rt.lane || 0))
          }
        } else if (!rt.spot || rt.spot.kind !== kind) {
          const spot = this._freeSpot(kind, a.key, rt.spot)
          if (spot && spot !== rt.spot) {
            this._takeSpot(rt, spot)
            const route = laneRoute(connectRoute([rt.pos.x, rt.pos.z], spot.route), rt.lane || 0)
            this._startRoute(rt, route)
          }
        }
        if (rt.parts && rt.parts.badge) {
          rt.parts.badge.material = this._mat(STATUS_COLORS[a.status] || STATUS_COLORS.idle, { emissive: STATUS_COLORS[a.status] || STATUS_COLORS.idle, ei: 0.5 })
        }
      }
    }
    for (const [key, rt] of this._map) {
      if (present.has(key) || rt.leaving) continue
      rt.leaving = true
      rt.data = Object.assign({}, rt.data, { status: "done", idle: false })
      const route = exitRoute([rt.pos.x, rt.pos.z])
      this._startRoute(rt, route)
      rt.exitAt = this._anim + 8
    }
    this._syncWorkerInstances()
    return this
  }

  const STATUS_COLORS = {
    thinking: "#8b6cf6", executing: "#3b82f6", replying: "#10b981",
    waiting: "#f59e0b", done: "#22a35a", error: "#ef4444", idle: "#9ca3af",
  }

  AgentOfficeScene3D.prototype._updateWorkers = function (dt) {
    const dead = []
    for (const rt of this._map.values()) {
      if (!rt.group) continue
      if (rt.mode === "walk") this._walk(rt, dt)
      this._animate(rt)
      if (rt.leaving && !rt.route && rt.mode !== "walk") {
        rt.fade = (rt.fade == null ? 1 : rt.fade) - dt * 2.2
        rt.group.scale.setScalar(Math.max(0.001, rt.fade * 0.7 + 0.3))
        if (rt.fade <= 0) dead.push(rt.key)
      }
    }
    for (const key of dead) {
      const rt = this._map.get(key)
      if (!rt) continue
      if (rt.spot && this._taken.get(rt.spot.id) === key) this._taken.delete(rt.spot.id)
      this.workerGroup.remove(rt.group)
      this._map.delete(key)
      if (this.selected === key) this.selected = null
    }
    this._syncWorkerInstances()
    if (this._ring) {
      const rt = this.selected ? this._map.get(this.selected) : null
      this._ring.visible = !!rt
      if (rt) {
        this._ring.position.set(rt.pos.x, 0.04, rt.pos.z)
        const pulse = 1 + Math.sin(this._anim * 4) * 0.06
        this._ring.scale.set(pulse, 1, pulse)
        this._ring.rotation.z = this._anim * 0.5
      }
    }
  }

  // ---------------------------------------------------------------------
  // camera, canvas, input, time and anchors
  // ---------------------------------------------------------------------

  AgentOfficeScene3D.prototype._applyCamera = function () {
    if (!this.camera) return
    const radius = 30
    const sp = Math.sin(this.polar), cp = Math.cos(this.polar)
    const x = this.target.x + radius * sp * Math.sin(this.azimuth)
    const z = this.target.z + radius * sp * Math.cos(this.azimuth)
    const y = this.target.y + radius * cp
    this.camera.position.set(x, y, z)
    this.camera.up.set(0, 1, 0)
    this.camera.lookAt(this.target)
    this.camera.zoom = this.zoom
    const aspect = this.width > 0 && this.height > 0 ? this.width / this.height : 1.5
    const span = 14.8
    this.camera.left = (-span * aspect) / 2
    this.camera.right = (span * aspect) / 2
    this.camera.top = span / 2
    this.camera.bottom = -span / 2
    this.camera.updateProjectionMatrix()
  }

  AgentOfficeScene3D.prototype.resize = function () {
    if (!this.available || !this.renderer || !this.canvas) return this
    let w = 0, h = 0
    try {
      if (this.canvas.getBoundingClientRect) {
        const r = this.canvas.getBoundingClientRect()
        w = Math.round(r.width)
        h = Math.round(r.height)
      }
      if (!w || !h) { w = this.canvas.clientWidth || 0; h = this.canvas.clientHeight || 0 }
      if (!w || !h) { w = this.width || 800; h = this.height || 600 }
    } catch (err) { w = this.width || 800; h = this.height || 600 }
    this.width = w
    this.height = h
    try {
      this.renderer.setPixelRatio(Math.min(this.dprCap, QUALITIES[this.quality].dpr, global.devicePixelRatio || 1))
      this.renderer.setSize(w, h, false)
    } catch (err) { /* keep the last size */ }
    this._applyCamera()
    return this
  }

  AgentOfficeScene3D.prototype._bind = function () {
    const canvas = this.canvas
    if (!canvas || typeof canvas.addEventListener !== "function") return
    const add = (target, type, fn, opts) => {
      target.addEventListener(type, fn, opts)
      this._listeners.push([target, type, fn, opts])
    }
    this._pointers = new Map()
    this._touchAction = canvas.style.touchAction
    canvas.style.touchAction = "none"
    this._onDown = (e) => {
      if (e.button != null && e.button !== 0) return
      if (!this._enabled || this._contextLost) return
      this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (this._pointers.size === 2) {
        const [a, b] = this._pointers.values()
        this._pinch = Math.hypot(a.x - b.x, a.y - b.y)
        this.dragged = true
      }
      this._drag = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false }
      if (this._pointers.size === 1) this.dragged = false
      if (canvas.setPointerCapture && e.pointerId != null) { try { canvas.setPointerCapture(e.pointerId) } catch (err) { /* noop */ } }
      canvas.style.cursor = "grabbing"
    }
    this._onMove = (e) => {
      if (!this._enabled || this._contextLost) return
      if (this._pointers.has(e.pointerId)) this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (this._pointers.size >= 2) {
        const [a, b] = this._pointers.values()
        const distance = Math.hypot(a.x - b.x, a.y - b.y)
        if (this._pinch > 0 && distance > 0) this.setZoom(this.zoom * distance / this._pinch)
        this._pinch = distance
        this.dragged = true
        if (this._drag) this._drag.moved = true
        return
      }
      if (!this._drag || (this._drag.id != null && e.pointerId != null && this._drag.id !== e.pointerId)) return
      const dx = e.clientX - this._drag.x
      const dy = e.clientY - this._drag.y
      this._drag.x = e.clientX
      this._drag.y = e.clientY
      if (Math.abs(dx) + Math.abs(dy) > 0) this._drag.moved = true
      this.azimuth = clamp(this.azimuth - dx * 0.007, 0.12, Math.PI / 2 - 0.12)
      this.polar = clampPolar(this.polar + dy * 0.006)
      this._applyCamera()
    }
    this._onUp = (e) => {
      if (!this._drag) return
      this.dragged = this.dragged || this._drag.moved === true
      this._pointers.delete(e.pointerId)
      this._pinch = 0
      const remaining = this._pointers.entries().next().value
      this._drag = remaining ? { id: remaining[0], x: remaining[1].x, y: remaining[1].y, moved: true } : null
      canvas.style.cursor = "grab"
      if (canvas.releasePointerCapture && e && e.pointerId != null) { try { canvas.releasePointerCapture(e.pointerId) } catch (err) { /* noop */ } }
    }
    this._onWheel = (e) => {
      if (!this._enabled || this._contextLost) return
      const dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.height : 1)
      if (!isFinite(dy)) return
      const zoom = clampZoom(this.zoom * Math.exp(-dy * 0.0012))
      if (zoom === this.zoom) return
      if (e.cancelable) e.preventDefault()
      this.zoom = zoom
      this._applyCamera()
    }
    this._onDouble = () => {
      this.azimuth = 0.82
      this.polar = 0.96
      this.zoom = 1.05
      this._applyCamera()
    }
    add(canvas, "webglcontextlost", (e) => {
      if (e.cancelable) e.preventDefault()
      this._contextLost = true
      this._stop()
    })
    add(canvas, "webglcontextrestored", () => {
      if (this.disposed) return
      this._contextLost = false
      this.error = null
      this.resize()
      this._start()
    })
    add(canvas, "pointerdown", this._onDown)
    add(canvas, "pointermove", this._onMove)
    add(canvas, "pointerup", this._onUp)
    add(canvas, "pointercancel", this._onUp)
    add(canvas, "wheel", this._onWheel, { passive: false })
    add(canvas, "dblclick", this._onDouble)
    add(canvas, "contextmenu", (e) => e.preventDefault())
    canvas.style.cursor = "grab"
    if (global.ResizeObserver && canvas) {
      try {
        this._ro = new global.ResizeObserver(() => this.resize())
        this._ro.observe(canvas)
      } catch (err) { this._ro = null }
    }
    if (global.addEventListener) {
      this._onWinResize = () => this.resize()
      global.addEventListener("resize", this._onWinResize)
      this._listeners.push([global, "resize", this._onWinResize])
    }
    if (global.document && global.document.addEventListener) {
      this._onVisibility = () => {
        this._hidden = !!global.document.hidden
        if (this._hidden) this._stop()
        else this._start()
      }
      global.document.addEventListener("visibilitychange", this._onVisibility)
      this._listeners.push([global.document, "visibilitychange", this._onVisibility])
    }
  }

  AgentOfficeScene3D.prototype._start = function () {
    if (!this.available || this.disposed || !this._enabled || this._contextLost || this._raf != null || this._hidden) return this
    if (typeof global.requestAnimationFrame !== "function") return this
    this._last = 0
    const generation = ++this._frameGeneration
    const tick = (now) => {
      if (generation !== this._frameGeneration) return
      this._raf = null
      if (!this.available || this.disposed || !this._enabled || this._contextLost || this._hidden) return
      this._raf = global.requestAnimationFrame(tick)
      if (!this._last) this._last = now
      const dt = Math.min(0.05, (now - this._last) / 1000)
      this._last = now
      this._anim += dt
      this._timeAcc += dt
      if (this._timeAcc > 25) { this._timeAcc = 0; this.refreshTime() }
      this._updateWorkers(dt)
      if (this.renderer && this.scene && this.camera) {
        try { this.renderer.render(this.scene, this.camera) }
        catch (err) {
          this.error = err instanceof Error ? err : new Error(String(err))
          this._stop()
          return
        }
      }
      if (this.onFrame) { try { this.onFrame(this.anchors()) } catch (err) { /* a broken tag must not stop the office */ } }
    }
    this._raf = global.requestAnimationFrame(tick)
    return this
  }

  AgentOfficeScene3D.prototype._stop = function () {
    this._frameGeneration++
    this._drag = null
    this._pinch = 0
    if (this.canvas && this.canvas.style) this.canvas.style.cursor = "grab"
    if (this._pointers) this._pointers.clear()
    if (this._raf != null && typeof global.cancelAnimationFrame === "function") {
      global.cancelAnimationFrame(this._raf)
    }
    this._raf = null
    return this
  }

  AgentOfficeScene3D.prototype.setSelected = function (key) {
    this.selected = key == null ? null : String(key)
    if (!this._ring && this.scene && THREE) {
      const m = this._mat("#ffffff", { emissive: this.theme.accent, ei: 1.2, rough: 0.4 })
      this._ring = new THREE.Mesh(this.gTorus, m)
      this._ring.rotation.x = -Math.PI / 2
      this._ring.position.y = 0.04
      this._ring.castShadow = false
      this._ring.receiveShadow = false
      this._ring.visible = false
      this.scene.add(this._ring)
    }
    return this
  }

  AgentOfficeScene3D.prototype.setScene = function (id) {
    if (!THEMES[id]) return this
    this.id = id
    this.theme = themeFor(id)
    if (this.available && this.scene) {
      this._buildEnvironment()
      this._applyTime()
      if (this._ring) this._ring.material = this._mat("#ffffff", { emissive: this.theme.accent, ei: 1.2, rough: 0.4 })
    }
    return this
  }

  AgentOfficeScene3D.prototype.setQuality = function (quality) {
    this.quality = QUALITIES[quality] ? quality : "high"
    if (this.available && this.renderer) {
      this._setShadowQuality()
      this.resize()
    }
    return this
  }

  AgentOfficeScene3D.prototype.setZoom = function (z) {
    this.zoom = clampZoom(z)
    this._applyCamera()
    return this
  }

  AgentOfficeScene3D.prototype.start = function () { this._enabled = true; return this._start() }
  AgentOfficeScene3D.prototype.stop = function () { this._enabled = false; return this._stop() }
  AgentOfficeScene3D.prototype.setDim = function () { return this }

  // what the pointer is over: the box around a worker's body, not the tag
  AgentOfficeScene3D.prototype.hit = function (px, py) {
    if (!this.available || !this.camera || !this._v) return ""
    const w = this.width || 1, h = this.height || 1
    let best = "", bd = 44
    for (const rt of this._map.values()) {
      if (!rt.group || rt.leaving) continue
      this._v.set(rt.pos.x, 0.95, rt.pos.z).project(this.camera)
      const x = (this._v.x + 1) * 0.5 * w, y = (1 - this._v.y) * 0.5 * h
      const d = Math.hypot(px - x, py - y)
      if (d < bd) { bd = d; best = rt.key }
    }
    return best
  }

  AgentOfficeScene3D.prototype.anchors = function () {
    const out = []
    if (!this.available || !this.camera || !this.scene || !this._v) return out
    const w = this.width || 1
    const h = this.height || 1
    for (const rt of this._map.values()) {
      if (!rt.group || rt.leaving) continue
      const y = (rt.group.position.y || 0) + 1.74
      this._v.set(rt.pos.x, y, rt.pos.z).project(this.camera)
      const x = (this._v.x + 1) * 0.5 * w
      const sy = (1 - this._v.y) * 0.5 * h
      const visible = this._v.z >= -1 && this._v.z <= 1 &&
        x > -120 && x < w + 120 && sy > -120 && sy < h + 120
      out.push({ key: rt.key, x, y: sy, visible })
    }
    return out
  }

  AgentOfficeScene3D.prototype.dispose = function () {
    if (this.disposed) return this
    this.disposed = true
    this.available = false
    this._stop()
    if (this._ro) { try { this._ro.disconnect() } catch (err) { /* noop */ } this._ro = null }
    for (const [target, type, fn, opts] of this._listeners) {
      try { target.removeEventListener(type, fn, opts) } catch (err) { /* noop */ }
    }
    this._listeners.length = 0
    if (this.canvas && this.canvas.style && this._touchAction !== undefined) this.canvas.style.touchAction = this._touchAction
    if (this._pointers) this._pointers.clear()
    if (this._workerBatches) {
      for (const batch of this._workerBatches.values()) batch.dispose()
      this._workerBatches.clear()
    }
    if (this.workerGroup) {
      this.workerGroup.clear()
      if (this.scene) this.scene.remove(this.workerGroup)
      this.workerGroup = null
    }
    this._workerMatrix = this._workerInverse = null
    this._map.clear()
    this._taken.clear()
    for (const g of this._sharedGeo) { try { g.dispose() } catch (err) { /* noop */ } }
    for (const m of this._sharedMat) { try { m.dispose() } catch (err) { /* noop */ } }
    this._sharedGeo.clear()
    this._sharedMat.clear()
    this._matCache.clear()
    this._disposeEnv()
    if (this.env && this.scene) this.scene.remove(this.env)
    this.env = null
    if (this._ring) { if (this.scene) this.scene.remove(this._ring); this._ring = null }
    this._teardown()
    this.agents = []
    return this
  }

  // ---------------------------------------------------------------------
  // statics and global export
  // ---------------------------------------------------------------------

  AgentOfficeScene3D.prototype.setTime = function (date) { return this.refreshTime(date) }

  AgentOfficeScene3D.VERSION = VERSION
  AgentOfficeScene3D.SCENES = SCENES
  AgentOfficeScene3D.SCENE_IDS = SCENE_IDS
  AgentOfficeScene3D.THEMES = THEMES
  AgentOfficeScene3D.Layout = LAYOUT
  AgentOfficeScene3D.ROOM = ROOM
  AgentOfficeScene3D.DESKS = DESKS
  AgentOfficeScene3D.SOFA = SOFA
  AgentOfficeScene3D.SPOTS = SPOTS
  AgentOfficeScene3D.BLOCKERS = BLOCKERS
  AgentOfficeScene3D.HUBS = HUBS
  AgentOfficeScene3D.STATUS_COLORS = STATUS_COLORS
  AgentOfficeScene3D.QUALITIES = QUALITIES
  AgentOfficeScene3D.MAX_AGENTS = MAX_AGENTS
  AgentOfficeScene3D.mixColor = mixColor
  AgentOfficeScene3D.colorToHex = colorToHex
  AgentOfficeScene3D.parseColor = parseColor
  AgentOfficeScene3D.lighten = lighten
  AgentOfficeScene3D.darken = darken
  AgentOfficeScene3D.timeOfDay = timeOfDay
  AgentOfficeScene3D.projectToScreen = projectToScreen
  AgentOfficeScene3D.clampZoom = clampZoom
  AgentOfficeScene3D.clampPolar = clampPolar
  AgentOfficeScene3D.wrapAzimuth = wrapAzimuth
  AgentOfficeScene3D.hashKey = hashKey
  AgentOfficeScene3D.spotKindForStatus = spotKindForStatus
  AgentOfficeScene3D.seatFor = seatFor
  AgentOfficeScene3D.assignSeats = assignSeats
  AgentOfficeScene3D.routeFor = routeFor
  AgentOfficeScene3D.laneRoute = laneRoute
  AgentOfficeScene3D.connectRoute = connectRoute
  AgentOfficeScene3D.exitRoute = exitRoute
  AgentOfficeScene3D.blockedAt = blockedAt
  AgentOfficeScene3D.routeBlocked = routeBlocked
  AgentOfficeScene3D.sampleRoute = sampleRoute
  AgentOfficeScene3D.faceAngle = faceAngle
  AgentOfficeScene3D.isSupported = function () {
    return !!(THREE && THREE.WebGLRenderer && typeof document !== "undefined")
  }
  AgentOfficeScene3D.themeFor = themeFor

  global.AgentOfficeScene3D = AgentOfficeScene3D
})(typeof globalThis !== "undefined" ? globalThis : this)
