/* Shared room data and navigation. Classic script and CommonJS. */
(function (global) {
  "use strict"
  function hashKey(s) { let h = 2166136261; for (const c of String(s)) h = Math.imul(h ^ c.codePointAt(0), 16777619); return h >>> 0 }
  const THEMES = {
    office: {
      id: "office", label: "Office", note: "space-station office",
      floor: "#b9814f", floorStyle: "wood", wall: "#e9dcc3", trim: "#cdb894", accent: "#2f6f73",
      desk: "#cdb894", chair: "#94704d", metal: "#1d2330", wood: "#8f5f38", sofa: "#d9735a",
      plant: "#4f8a5b", skyDay: "#2a3157", skyNight: "#1d2330", windowDay: "#e9dcc3", windowNight: "#9db4e8",
      fog: "#2f6f73", ambient: "#e9dcc3",
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
    library: {
      id: 'library', label: 'Library', note: 'twilight reading hall',
      floor: '#554438', floorStyle: 'plank', wall: '#746354', trim: '#b5a080', accent: '#4f8a5b',
      desk: '#947655', chair: '#594a40', metal: '#b5a080', wood: '#493d35', sofa: '#80434b',
      plant: '#4f8a5b', skyDay: '#88758d', skyNight: '#2a3157', windowDay: '#d9b58b', windowNight: '#9db4e8',
      fog: '#29303c', ambient: '#e9dcc3', props: [],
    },
    cyberlab: {
      id: 'cyberlab', label: 'Cyberlab', note: 'neon research cells',
      floor: '#293544', floorStyle: 'metal', wall: '#40536a', trim: '#839aac', accent: '#39ced6',
      desk: '#617b90', chair: '#344759', metal: '#839aac', wood: '#40536a', sofa: '#536584',
      plant: '#39ced6', skyDay: '#40536a', skyNight: '#1d2330', windowDay: '#8de5e8', windowNight: '#5784ac',
      fog: '#1d2330', ambient: '#c9e3ed', props: [],
    },
    greenhouse: {
      id: 'greenhouse', label: 'Greenhouse', note: 'sunlit botanical conservatory',
      floor: '#617466', floorStyle: 'stone', wall: '#91a898', trim: '#d4dfc4', accent: '#73a66a',
      desk: '#a5b18b', chair: '#526d5a', metal: '#9bafaa', wood: '#63734d', sofa: '#899a65',
      plant: '#4f8a5b', skyDay: '#b9d8df', skyNight: '#344757', windowDay: '#e4ebcb', windowNight: '#9db4e8',
      fog: '#344757', ambient: '#e4ebcb', props: [],
    },
    arctic: {
      id: 'arctic', label: 'Arctic', note: 'polar field station',
      floor: '#778e9f', floorStyle: 'metal', wall: '#a2b9c7', trim: '#d8e6eb', accent: '#e2b04a',
      desk: '#b2c4cb', chair: '#526a80', metal: '#8198ab', wood: '#637c8b', sofa: '#738eaa',
      plant: '#8aaab0', skyDay: '#d8e6eb', skyNight: '#526a80', windowDay: '#e7eff0', windowNight: '#9db4e8',
      fog: '#526a80', ambient: '#d8e6eb', props: [],
    },
    rainynight: {
      id: 'rainynight', label: 'Rainy Night', note: 'rain-soaked midnight studio',
      floor: '#536071', floorStyle: 'plank', wall: '#526173', trim: '#8294a5', accent: '#e3a85c',
      desk: '#b08a63', chair: '#6a7180', metal: '#687b8c', wood: '#765943', sofa: '#aa765a',
      plant: '#688a78', skyDay: '#101b2c', skyNight: '#101b2c', windowDay: '#7492a9', windowNight: '#7492a9',
      fog: '#101b2c', ambient: '#d7d8d2', props: [],
    },
  }
  function officeRuntime() {
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
    desk: DESKS.map((d, i) => makeSpot("desk", "desk-" + i, d.seat[0], d.seat[1], d.face, 0.552, deskRoute(d))),
    sofa: SOFA.map((s, i) => makeSpot("sofa", "sofa-" + i, s[0], s[1], SOFA_FACE[i], 0.552, routeFor("sofa", s[0], s[1], SOFA_FACE[i]))),
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
    return LAYOUT
  }
  function officeCanvas() {
    const ROOM = { w: 16, d: 12, wall: 3.1 }
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
    return { ROOM, DESKS, SOFA, SOFA_FACE, FACE, SOFA_APPROACH, ZONE, ZONE_SPOTS, ERROR_SPOTS, WANDER, DOOR, ACTIVITIES, POIS, POI_APPROACHES, ACTIVITY_SPOTS, BLOCKERS, FREE, CELL, NAV }
  }

  const CELL = 0.25
  // Exact segment/expanded-rectangle intersection; simplification cannot cut corners.
  function intersects(a, b, r, pad) {
    let lo = 0, hi = 1
    for (let axis = 0; axis < 2; axis++) {
      const min = r[axis] - pad, max = r[axis] + r[axis + 2] + pad
      const delta = b[axis] - a[axis]
      if (Math.abs(delta) < 1e-10) { if (a[axis] < min || a[axis] > max) return false; continue }
      const t0 = (min - a[axis]) / delta, t1 = (max - a[axis]) / delta
      lo = Math.max(lo, Math.min(t0, t1)); hi = Math.min(hi, Math.max(t0, t1))
      if (lo > hi) return false
    }
    return true
  }
  function navigation(layout, pad = 0.15) {
    const cache = new Map(), { room, blockers } = layout
    const freeAt = (x, z) => x >= 0.22 + pad && z >= 0.22 + pad && x <= room.w - 0.22 - pad && z <= room.d - 0.22 - pad &&
      !blockers.some(r => x >= r[0] - pad && x <= r[0] + r[2] + pad && z >= r[1] - pad && z <= r[1] + r[3] + pad)
    const clear = (a, b) => freeAt(...a) && freeAt(...b) && !blockers.some(r => intersects(a, b, r, pad))
    const w = Math.round(room.w / CELL) + 1, h = Math.round(room.d / CELL) + 1
    const points = Array.from({ length: w * h }, (_, i) => [(i % w) * CELL, Math.floor(i / w) * CELL])
    const open = points.map(p => freeAt(...p))
    function anchor(p) {
      let best = -1, distance = Infinity
      for (let i = 0; i < points.length; i++) if (open[i]) {
        const d = Math.hypot(p[0] - points[i][0], p[1] - points[i][1])
        if (d < distance && clear(p, points[i])) { best = i; distance = d }
      }
      return best
    }
    function route(from, to) {
      const key = from.join(',') + ':' + to.join(',')
      if (cache.has(key)) return cache.get(key)
      const save = path => { const value = Object.freeze(path.map(p => Object.freeze(p.slice()))); cache.set(key, value); return value }
      if (!freeAt(...from) || !freeAt(...to)) return save([])
      if (clear(from, to)) return save([from, to])
      const start = anchor(from), goal = anchor(to)
      if (start < 0 || goal < 0) return save([])
      const cost = new Float64Array(points.length).fill(Infinity), prev = new Int32Array(points.length).fill(-1)
      const closed = new Uint8Array(points.length), queue = [start]
      const heuristic = i => Math.hypot(points[i][0] - points[goal][0], points[i][1] - points[goal][1])
      cost[start] = 0
      while (queue.length) {
        let best = 0
        for (let i = 1; i < queue.length; i++) if (cost[queue[i]] + heuristic(queue[i]) < cost[queue[best]] + heuristic(queue[best])) best = i
        const current = queue[best]; queue[best] = queue[queue.length - 1]; queue.pop()
        if (closed[current]) continue
        if (current === goal) break
        closed[current] = 1
        const x = current % w, z = Math.floor(current / w)
        for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
          if ((!dx && !dz) || x + dx < 0 || x + dx >= w || z + dz < 0 || z + dz >= h) continue
          const next = current + dx + dz * w
          if (!open[next] || closed[next] || !clear(points[current], points[next])) continue
          const g = cost[current] + CELL * Math.hypot(dx, dz)
          if (g >= cost[next]) continue
          cost[next] = g; prev[next] = current; queue.push(next)
        }
      }
      if (!Number.isFinite(cost[goal])) return save([])
      const path = [to]
      for (let i = goal; i !== -1; i = prev[i]) { path.push(points[i]); if (i === start) break }
      path.push(from); path.reverse()
      const result = [from]
      for (let i = 0; i < path.length - 1;) {
        let j = path.length - 1
        while (j > i + 1 && !clear(path[i], path[j])) j--
        result.push(path[j]); i = j
      }
      return save(result)
    }
    return { CELL, pad, freeAt, clear, route }
  }

  const office = officeRuntime()
  const windows = [3.8, 8, 12.2].map(x => ({ x, y: 1.75, w: 2.1, h: 1.45 }))
  const layouts = {
    office: {
      id: 'office', room: office.ROOM, door: office.DOOR, entry: office.ENTRY,
      desks: office.DESKS, sofas: office.SOFA.map(([x, z], i) => ({ x, z, face: office.SOFA_FACE[i], approach: i < 5 ? [2.45,z] : [x,10.1] })),
      zone: office.ZONE, zoneSpots: office.ZONE_SPOTS, errorSpots: office.ERROR_SPOTS, wander: office.WANDER,
      blockers: office.BLOCKERS, windows, decor: [], cameraHint: { targetY: 0.75 },
      rugs: [[8.1, 1.45, 10.6, 2.45, '#c8bda6'], [12.3, 5.4, 4.15, 3.65, '#d9735a']],
      plants: [[.8,11.1,1.2], [15.1,10.9,1.05], [15.1,5.7,.8], [.7,3.6,.65], [2.8,3.1,.5], [13.9,11,.7]],
    },
  }
  const desk = (x, z, face = 'n') => ({ x, z, w: 1.7, d: 0.9, seat: [x + 0.85, face === 'n' ? z + 1.32 : z - 0.42], face })
  const arrangements = {
    station: [[3.2,.55], [7,.55], [11,.55], [4,3.8,'s'], [7,3.8,'s'], [11.5,3.8,'s'], [7,5.8], [11.5,5.8]],
    cafe: [[3.2,.55], [6,.55], [9,.55], [12,.55], [4,4.2], [7,3.8], [10,4.6], [13,5.5]],
    castle: [[3.2,.55], [13,.55], [6.5,4,'s'], [8.3,4,'s'], [10.1,4,'s'], [6.5,4.9], [8.3,4.9], [10.1,4.9]],
    pirate: [[3.2,.55], [6,.55], [9,.55], [12,.55], [6,5], [8,5], [10,5], [12,5]],
    graveyard: [[3.2,.55], [6.5,1.4], [9.5,.55], [12.5,1.7], [4,4.5], [7,5.2], [10,4.5], [13,5.2]],
  }
  const features = {
    station: [{ type: 'round-table', x: 9.3, z: 4.3, w: 1.5, d: 1.5, h: .76 }],
    cafe: [{ type: 'bar', x: 10.9, z: 10.7, w: 4.1, d: .65, h: 1.1 }],
    castle: [{ type: 'fireplace', x: 11, z: 10.7, w: 2.8, d: .7, h: 1.5 }],
    pirate: [{ type: 'mast', x: 8.5, z: 3.3, w: .6, d: .6, h: 2.8 }, { type: 'wheel', x: 14.2, z: 7.6, w: .7, d: .65, h: 1.2 }],
    graveyard: [{ type: 'memorial', x: 11, z: 10.7, w: 2.5, d: .7, h: 1.3 }],
  }
  for (const [id, positions] of Object.entries(arrangements)) {
    const type = { station: 'console', cafe: 'pedestal', castle: 'trestle', pirate: 'trestle', graveyard: 'sarcophagus' }[id]
    const desks = positions.map(p => ({ ...desk(...p), type }))
    const decor = [{ x: .4, z: .35, w: 2.3, d: 1.05 }, { x: 10.8, z: 8.4, w: 4.7, d: 2.1 }, { x: 15.05, z: .4, w: .6, d: 7.3 }]
    layouts[id] = {
      id, room: { w: 16, d: 12, wall: 3.2 }, door: [.6,2.6], entry: [.95,2.6], desks,
      sofas: layouts.office.sofas.map(s => ({ ...s })),
      zone: { x: 4.2, z: 7.8, w: 4.1, d: 2.6 },
      zoneSpots: Array.from({ length: 12 }, (_, i) => [4.7 + i % 4, 8.2 + Math.floor(i / 4) * .85]),
      errorSpots: [[9,9], [9,10], [9,11], [10,10]], wander: [[3,3], [6,3.3], [10.7,3.3], [3,6]],
      blockers: [...desks.map(d => [d.x,d.z,d.w,d.d]), ...office.BLOCKERS.slice(8,10),
        ...decor.map(r => [r.x,r.z,r.w,r.d]), ...features[id].map(r => [r.x,r.z,r.w,r.d])],
      windows: (id === 'castle' ? [4,8,12] : id === 'pirate' ? [4.5,11.5] : [3.8,7.8,12.2]).map(x => ({ x, y: 1.75, w: id === 'castle' ? 1.3 : 2.1, h: 1.45 })),
      decor, features: features[id], cameraHint: { targetY: .75 },
      plants: [[.8,.8,.5], [2,.8,.5], [15.3,2,.35], [15.3,4,.35], [15.3,6,.35], [14.7,9.5,.4]],
    }
  }
  // Explicit prop footprints are both navigation obstacles and decor reservations.
  // Parts use local center coordinates; every assembly has a floor support.
  const part = (color, x,y,z,w,h,d, glow = false, shape = 'box') => ({color,x,y,z,w,h,d,glow,shape})
  const ornament = (type,x,z,w,d,parts) => ({type,x,z,w,d,parts})
  const newRooms = {
    library: [[3.2,.55],[5.6,3,'s'],[7.3,3,'s'],[5.6,3.9],[7.3,3.9],[10,3,'s'],[11.7,3,'s'],[10,3.9],[11.7,3.9]],
    cyberlab: [[3.2,.55],[6.3,.6],[9.3,1.2],[12.3,.6],[3.3,5.4],[6.3,6],[9.3,5.4],[12.3,6]],
    greenhouse: [[3.2,.55],[5.3,1],[9.3,1],[11.4,1],[3.2,5.8],[5.3,5.8],[9.3,5.8],[11.4,5.8]],
    arctic: [[3.2,.55],[5.3,.55],[7.4,.55],[9.5,.55],[11.6,.55],[12.7,3.7],[12.7,6.2],[9.6,6.2]],
    rainynight: [[3.2,.55],[5.4,.55],[7.6,.55],[9.8,.55],[12,.55],[5.4,4,'s'],[7.1,4,'s'],[8.8,4,'s']],
  }
  const decorations = {library: [], cyberlab: [], greenhouse: [], arctic: [], rainynight: []}
  for (const [x,z,w,d] of [[6,.35,3,.55],[10,.35,3,.55],[15,3,.55,4]]) {
    const parts=[part('wood',w/2,1.1,d/2,w,2.2,d)]
    for(let row=0;row<4;row++) for(let col=0;col<6;col++) parts.push(part(col%2?'sofa':'trim', .12+(w-.24)*(col+.5)/6,.3+row*.48,d+.025,(w-.3)/7,.34,.05))
    decorations.library.push(ornament('book-wall',x,z,w,d+.05,parts))
  }
  decorations.library.push(
    ornament('sliding-ladder',14,1.1,.65,.65,[part('wood',.07,1,.32,.08,2,.12),part('wood',.58,1,.32,.08,2,.12),...Array.from({length:6},(_,i)=>part('trim',.325,.15+i*.32,.32,.57,.06,.16))]),
    ornament('globe',14.5,10.4,1,1,[part('wood',.5,.08,.5,.7,.16,.7),part('metal',.5,.45,.5,.08,.8,.08),part('accent',.5,1.05,.5,.7,.7,.7,false,'sphere')]),
    ornament('fireplace',.4,.4,2.1,1,[part('wood',1.05,.1,.5,2.1,.2,1),part('wall',.2,.75,.5,.4,1.5,1),part('wall',1.9,.75,.5,.4,1.5,1),part('trim',1.05,1.5,.5,2.1,.2,1),part('#efaf61',1.05,.4,.5,.7,.4,.4,true)]))
  for(const x of []) decorations.library.push(ornament('reading-lamp',x,0.55,.6,.6,[part('metal',.3,.04,.3,.5,.08,.5),part('metal',.3,.65,.3,.06,1.3,.06),part('accent',.3,1.32,.3,.6,.22,.45),part('#ffcf8a',.3,1.2,.3,.4,.03,.3,true)]))
  for(const x of [10,12.2,14.3]) decorations.cyberlab.push(ornament('server-rack',x,10.95,1.4,.88,[part('metal',.7,1,.4,1.4,2,.8),...Array.from({length:6},(_,i)=>part('wood',.7,.2+i*.3,.82,1.2,.21,.04)),part('accent',.1,1,.85,.04,1.8,.03,true)]))
  decorations.cyberlab.push(
    ornament('hologram-table',14.6,6.2,.8,1.6,[part('metal',.4,.4,.8,.7,.8,1.5),part('accent',.4,.84,.8,.8,.08,1.6),part('#39ced6',.4,1.2,.8,.65,.6,.65,true,'sphere')]),
    ornament('cable-bank',14.8,3.5,.7,2,[...Array.from({length:3},(_,i)=>part('metal',.15+i*.2,.06,1,.08,.12,2))]),
    ornament('neon-pylon',.5,.4,1.2,1,[part('metal',.6,.08,.5,1.2,.16,1),part('#d778bd',.6,1,.5,.12,1.8,.12,true)]))
  for(const [x,z] of [[12.6,4.7]]) decorations.greenhouse.push(ornament('flower-island',x,z,2.6,.8,[part('wood',1.3,.16,.4,2.6,.32,.8),...Array.from({length:5},(_,i)=>part('plant',.3+i*.5,.53,.4,.42,.42,.42,false,'sphere'))]))
  decorations.greenhouse.push(
    ornament('pond',13.9,6.5,1.6,1.6,[part('metal',.8,.13,.8,1.6,.26,1.6),part('#72b8c7',.8,.27,.8,1.35,.02,1.35,true)]),
    ornament('flower-rack',.4,.4,2,1,[part('wood',.1,.7,.5,.12,1.4,.8),part('wood',1.9,.7,.5,.12,1.4,.8),part('trim',1,.35,.5,2,.08,1),part('trim',1,1,.5,2,.08,1),part('plant',1,1.3,.5,1.6,.5,.6)]),
    ornament('watering-can',14.4,3.2,1,.8,[part('accent',.4,.3,.4,.55,.6,.55),part('metal',.8,.4,.4,.4,.12,.12),part('metal',.4,.7,.4,.12,.25,.12)]))
  decorations.arctic.push(
    ornament('heater',.4,.4,2,1.04,[part('metal',1,.5,.5,2,1,1),...Array.from({length:7},(_,i)=>part('#e2b04a',.25+i*.25,.5,1.01,.08,.65,.02,true))]),
    ornament('instrument-case',14.6,5.0,1,1,[part('wood',.5,.35,.5,1,.7,1),part('trim',.5,.72,.5,1,.08,1),part('metal',.5,.8,.5,.4,.08,.1)]),
    ornament('radio',11,11,1.5,.85,[part('metal',.75,.4,.4,1.5,.8,.8),part('accent',.4,.5,.82,.5,.25,.04,true),part('trim',1.2,1.15,.4,.04,.7,.04)]),
    ornament('recess',14,.04,1.96,3.16,[part('wall',.98,1.595,1.58,1.96,3.19,3.16)]))
  decorations.arctic.push(ornament('supply-crates',13,11,1.1,.9,[part('wood',.55,.3,.45,1.1,.6,.9),part('trim',.55,.65,.45,1.1,.06,.9),part('metal',.55,.8,.45,.5,.2,.5)]))
  decorations.greenhouse.push(ornament('potting-bench',14.5,1.2,1,1.2,[part('wood',.5,.55,.6,1,.1,1.2),part('wood',.1,.27,.2,.1,.54,.1),part('wood',.9,.27,.2,.1,.54,.1),part('wood',.1,.27,1,.1,.54,.1),part('wood',.9,.27,1,.1,.54,.1),part('plant',.5,.8,.6,.6,.4,.5)]))
  for(const z of []) {
    const frame=ornament('dome-frame',.3,z,15.4,.12,[
      part('metal',.06,1.1,.06,.12,2.2,.12),part('metal',15.34,1.1,.06,.12,2.2,.12),
      ...Array.from({length:11},(_,i)=>{
        const a=2.2+.8*Math.sin(Math.PI*i/11), b=2.2+.8*Math.sin(Math.PI*(i+1)/11)
        return {...part('trim',.06+(i+.5)*15.28/11,(a+b)/2,.06,Math.hypot(15.28/11,b-a),.08,.12),rz:Math.atan2(b-a,15.28/11)}
      }),
    ])
    frame.blockers=[[.3,z,.12,.12],[15.58,z,.12,.12]]
    decorations.greenhouse.push(frame)
  }
  decorations.rainynight.push(
    ornament('coffee-bar',.4,.4,2,1,[part('wood',1,.48,.5,2,.96,1),part('trim',1,1,.5,2,.08,1),part('metal',1,1.25,.5,.5,.45,.45),part('#ffc66f',.3,1.08,.5,.12,.12,.12,true)]),
    ornament('umbrella-stand',14.6,3.5,.7,.7,[part('metal',.35,.3,.35,.65,.6,.65),part('accent',.23,.9,.35,.08,1.2,.08),part('wood',.45,.8,.35,.08,1,.08)]),
    ornament('floor-lamp',14.7,7.4,.6,.6,[part('metal',.3,.04,.3,.6,.08,.6),part('metal',.3,.85,.3,.06,1.7,.06),part('accent',.3,1.7,.3,.55,.22,.55),part('#ffcf8a',.3,1.57,.3,.35,.06,.35,true)]),
    ornament('side-table',11,10.9,1,.7,[part('wood',.5,.36,.35,1,.08,.7),part('metal',.1,.18,.1,.08,.36,.08),part('metal',.9,.18,.6,.08,.36,.08)]),
    ornament('coffee-shelf',13,10.9,1,.7,[part('wood',.5,.38,.35,1,.76,.7),part('trim',.5,.8,.35,1,.08,.7),part('accent',.5,.95,.35,.3,.22,.3)]))
  for(const [id,positions] of Object.entries(newRooms)) {
    const desks=positions.map(p=>({...desk(...p),type:id==='library'?'trestle':id==='greenhouse'?'pedestal':'console'}))
    const props=decorations[id], decor=props.map(({x,z,w,d})=>({x,z,w,d}))
    THEMES[id].props = [...new Set(props.map(p => p.type))]
    const sofas=layouts.office.sofas.map(s=>({...s}))
    const zone={x:5.5,z:9.7,w:3.5,d:1.6}
    layouts[id]={id,room:{w:16,d:12,wall:3.2},door:[.6,2.6],entry:[.95,2.6],desks,sofas,zone,
      zoneSpots:Array.from({length:8},(_,i)=>[5.8+i%4*.85,10+Math.floor(i/4)*.8]),
      errorSpots:[[9.6,10.5],[9.6,11.3]],wander:[[2.8,2.8],[8,2.8],[2.8,7]],
      blockers:[...desks.map(d=>[d.x,d.z,d.w,d.d]),...office.BLOCKERS.slice(8,10),...props.flatMap(f=>f.blockers || [[f.x,f.z,f.w,f.d]])],
      windows:id==='rainynight'?[{x:8,y:1.6,w:14.4,h:2.6}]:windows,decor,decorations:props,features:[],plants:[],cameraHint:{targetY:.75},
      rugs:id==='library'?[[8.4,4,9.8,5.3,'#80434b']]:id==='greenhouse'?[[8,6,1.2,11,'#a5b18b'],[8,5.1,14.5,1,'#a5b18b']]:[],
    }
  }
  for (const [id, theme] of Object.entries(THEMES)) theme.layout = id

  function sofaApproach(s) {
    const face = { n: [0,-1], s: [0,1], e: [1,0], w: [-1,0] }[s.face]
    return s.approach || [s.x + face[0] * .95, s.z + face[1] * .95]
  }
  const runtimes = new Map([['office', office]])
  function runtime(id) {
    if (runtimes.has(id)) return runtimes.get(id)
    const layout = layouts[id]
    if (!layout) throw new Error('Unknown layout: ' + id)
    const nav = navigation(layout), sofas = layout.sofas
    const approach = sofas.map(sofaApproach)
    const seatIndex = p => sofas.findIndex(s => Math.hypot(s.x-p[0],s.z-p[1]) < .04)
    function path(from, to) {
      const a = seatIndex(from), b = seatIndex(to)
      const route = nav.route(a < 0 ? from : approach[a], b < 0 ? to : approach[b])
      if (!route.length) return []
      return [...(a < 0 ? [] : [from]), ...route, ...(b < 0 ? [] : [to])]
    }
    const spots = { desk: [], sofa: [], zone: [], error: [], wander: [] }
    const add = (kind, x, z, face, y) => spots[kind].push({ kind, id: kind + '-' + spots[kind].length, x, z, face, y, route: path(layout.entry, [x,z]) })
    for (const d of layout.desks) add('desk', ...d.seat, d.face, .552)
    for (const s of sofas) add('sofa', s.x,s.z,s.face,.552)
    for (const [kind, list] of [['zone',layout.zoneSpots], ['error',layout.errorSpots], ['wander',layout.wander]]) for (const p of list) add(kind,...p,'s',0)
    const result = {
      ROOM: layout.room, DESKS: layout.desks, DOOR: layout.door, ENTRY: layout.entry,
      SOFA: sofas.map(s => [s.x,s.z]), SOFA_FACE: sofas.map(s => s.face), ZONE: layout.zone,
      ZONE_SPOTS: layout.zoneSpots, ERROR_SPOTS: layout.errorSpots, WANDER: layout.wander,
      BLOCKERS: layout.blockers, SPOTS: spots, POOLS: spots, SPOT_BY_ID: new Map(Object.values(spots).flat().map(s => [s.id,s])),
      nav, path, connectRoute: (from, route) => path(from, route[route.length-1]), exitRoute: from => path(from,layout.entry),
      // A grid path already preserves clearance; arbitrary lane offsets need revalidation.
      laneRoute: route => route,
    }
    runtimes.set(id,result)
    return result
  }
  const canvasLayouts = new Map([['office', officeCanvas()]])
  function canvas(id) {
    if (canvasLayouts.has(id)) return canvasLayouts.get(id)
    const r = runtime(id), layout = layouts[id]
    const approaches = layout.sofas.map(sofaApproach)
    const seatAt = p => r.SOFA.findIndex(s => Math.hypot(s[0]-p[0],s[1]-p[1]) < .04)
    const NAV = {
      ...r.nav,
      path(from, to, transit = null) {
        if (Math.hypot(from[0]-to[0], from[1]-to[1]) < .001) return []
        const exit = Number.isInteger(transit) ? transit : seatAt(from), entry = seatAt(to)
        const route = r.nav.route(exit < 0 ? from : approaches[exit], entry < 0 ? to : approaches[entry])
        if (!route.length) return []
        return [...(exit < 0 ? [] : [[...approaches[exit],exit]]), ...route.slice(1).map(p => p.slice()), ...(entry < 0 ? [] : [[...to,entry]])]
      },
    }
    const value = { ...r, DESKS: r.DESKS.map(d => ({ ...d, y: d.z })), ZONE: { ...r.ZONE, y: r.ZONE.z },
      SOFA_APPROACH: approaches, ACTIVITIES: [], ACTIVITY_SPOTS: layout.sofas.map(s => [s.x,s.z,s.face]), NAV }
    canvasLayouts.set(id,value)
    return value
  }
  const registry = { layouts, themes: THEMES, CELL, navigation, runtime, canvas, office, officeCanvas: canvasLayouts.get('office') }
  global.AGENT_OFFICE_LAYOUTS = registry
  if (typeof module !== 'undefined' && module.exports) module.exports = registry

})(typeof globalThis !== "undefined" ? globalThis : this)
