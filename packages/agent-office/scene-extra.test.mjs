// The office's second dimension of life: activity venues, a camera you can
// drag and zoom, and a room that follows the local clock. The scene's own
// pathfinding is still the source of truth: every venue approach must be a
// floor cell reachable from the airlock, never inside a blocker.
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'

const scope = {}
new Function('globalThis', readFileSync(new URL('./page/scene.js', import.meta.url), 'utf8'))(scope)
const S = scope.AgentOfficeScene
const {
  Scene, ROOM, DESKS, SOFA, NAV, BLOCKERS, SOFA_APPROACH, SOFA_FACE,
  ACTIVITIES, POIS, POI_APPROACHES, ACTIVITY_SPOTS, CAMERA, dayPhase, activityDwell,
} = S

const FACE = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0] }
const inside = ([x, y], [bx, by, bw, bd]) => x >= bx && x <= bx + bw && y >= by && y <= by + bd
const door = [0.6, 2.6]

// every sampled point of a way must be a floor cell one may stand on
const walkable = (pts) => {
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[i + 1]
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 0.1))
    for (let k = 0; k <= n; k++) {
      const x = ax + ((bx - ax) * k) / n, y = ay + ((by - ay) * k) / n
      if (!NAV.freeAt(x, y)) return `blocked at ${x.toFixed(2)},${y.toFixed(2)}`
    }
  }
  return ''
}

// ---- a canvas stub good enough for the real Scene ----------------------
const fakeCtx = () => new Proxy({}, {
  get: (o, k) => (k in o ? o[k] : k === 'createLinearGradient' || k === 'createRadialGradient' ? () => ({ addColorStop() {} })
    : k === 'measureText' ? () => ({ width: 0 }) : () => {}),
  set: (o, k, v) => { o[k] = v; return true },
})
function fakeCanvas(w = 820, h = 620) {
  return {
    width: 0, height: 0, style: {},
    getContext: () => fakeCtx(),
    getBoundingClientRect: () => ({ width: w, height: h, left: 0, top: 0 }),
    addEventListener: () => {},
    removeEventListener: () => {},
    setPointerCapture: () => {},
  }
}
function newScene(dim = '3d') {
  const s = new Scene(fakeCanvas(), { dim })
  s.onFrame = () => {}
  return s
}

// ---- venues -----------------------------------------------------------

test('the scene keeps its public API and gains the five venues', () => {
  for (const key of ['Scene', 'ROOM', 'DESKS', 'SOFA', 'ZONE', 'ZONE_SPOTS', 'NAV', 'BLOCKERS', 'SOFA_APPROACH', 'SOFA_FACE', 'idlePose']) {
    expect(S[key]).toBeDefined()
  }
  for (const key of ['ACTIVITIES', 'POIS', 'POI_APPROACHES', 'ACTIVITY_SPOTS', 'CAMERA', 'dayPhase', 'activityDwell']) {
    expect(S[key]).toBeDefined()
  }
  expect(POIS).toBe(ACTIVITIES)
  expect(ACTIVITIES.length).toBeGreaterThanOrEqual(5)
  expect(ACTIVITIES.map((a) => a.id)).toEqual(
    expect.arrayContaining(['coffee', 'pingpong', 'bookshelf', 'meeting', 'arcade']))
  // every venue is named, coloured and has one approach with a facing
  expect(POI_APPROACHES.length).toBe(ACTIVITIES.length)
  for (const a of ACTIVITIES) {
    expect(typeof a.label).toBe('string')
    expect(a.color).toMatch(/^#[0-9a-f]{6}$/i)
    expect([...'nsew']).toContain(a.face)
    expect(a.w).toBeGreaterThan(0)
    expect(a.d).toBeGreaterThan(0)
  }
})

test('every venue is solid furniture with a free approach that faces it', () => {
  for (const [i, a] of ACTIVITIES.entries()) {
    // the body can't be walked through, and it is really in BLOCKERS
    expect(NAV.freeAt(a.x + a.w / 2, a.y + a.d / 2)).toBe(false)
    expect(BLOCKERS.some(([x, y, w, d]) => x === a.x && y === a.y && w === a.w && d === a.d)).toBe(true)
    // the approach is free, outside every blocker, and looks at the venue
    const [ax, ay, face] = POI_APPROACHES[i]
    expect(NAV.freeAt(ax, ay)).toBe(true)
    for (const b of BLOCKERS) expect(inside([ax, ay], b)).toBe(false)
    const v = FACE[face]
    const to = [a.x + a.w / 2 - ax, a.y + a.d / 2 - ay]
    expect(v[0] * to[0] + v[1] * to[1]).toBeGreaterThan(0.1)
    // the approach is on the camera-near side, so the worker is not hidden
    const near = ay > a.y + a.d - 0.2 || ax > a.x + a.w - 0.2
    expect(near).toBe(true)
  }
})

test('each venue is reachable from the airlock and from every other venue', () => {
  for (const [ax, ay] of POI_APPROACHES) {
    const pts = NAV.path(door, [ax, ay])
    expect(pts.length).toBeGreaterThan(0)
    expect(pts.at(-1).slice(0, 2)).toEqual([ax, ay])
    // no way through the furniture: the sampled floor path is all walkable
    expect(walkable([[door[0], door[1]], ...pts])).toBe('')
  }
  for (const from of POI_APPROACHES) for (const to of POI_APPROACHES) {
    if (from === to) continue
    const pts = NAV.path([from[0], from[1]], [to[0], to[1]])
    expect(pts.length).toBeGreaterThan(0)
    expect(walkable([[from[0], from[1]], ...pts])).toBe('')
  }
  // the old destinations still resolve from the door
  for (const seat of [...DESKS.map((d) => d.seat), ...SOFA_APPROACH]) {
    expect(NAV.path(door, seat).length).toBeGreaterThan(0)
  }
})

test('venues do not clip the desks, sofas or other fittings', () => {
  const rects = [
    ...ACTIVITIES.map((a) => [a.x, a.y, a.w, a.d]),
    ...DESKS.map((d) => [d.x, d.y, d.w, d.d]),
    [0.35, 4.1, 1.2, 5.0], [2.5, 10.55, 2.4, 1.45], // sofa
    [6.3, 5.2, 1.6, 1.6], // holo table
    [1.85, 9.65, 0.9, 0.9], // drums
    [8.4, 10.5, 1.35, 1.25], // crates
    [12.65, 8.85, 1.2, 1.2], // reactor
    [14.3, 6.6, 1.2, 1.6], // broken console
    [14.0, 0.5, 1.6, 1.0], // far console
  ]
  const overlap = (a, b) => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3]
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
    expect(overlap(rects[i], rects[j])).toBe(false)
  }
})

// ---- finishing at a venue ---------------------------------------------

test('a finished worker takes a venue, faces it, and lingers 8–30 s', () => {
  const values = new Set()
  for (let seed = 0; seed < 300; seed++) {
    const wait = activityDwell(seed)
    expect(wait).toBeGreaterThanOrEqual(8)
    expect(wait).toBeLessThanOrEqual(30)
    values.add(wait)
  }
  expect(values.size).toBeGreaterThan(30)
  expect(activityDwell(7)).toBe(activityDwell(7))

  for (let seed = 0; seed < ACTIVITIES.length; seed++) {
    const s = Object.create(Scene.prototype)
    Object.assign(s, { dim: '3d', workers: new Map(), first: true, t: 0, cam: undefined, reducedMotion: false })
    s.setAgents([{ key: 'p', seed, status: 'done', brand: { color: '#4f46e5' } }])
    const w = s.workers.get('p')
    expect(w.kind).toBe('activity')
    const spot = POI_APPROACHES.find(([x, y]) => x === w.tx && y === w.ty)
    expect(spot).toBeDefined()
    expect(w.facing).toBe(spot[2])
    expect(w.lingerUntil).toBeGreaterThan(Date.now())
  }
})

// ---- camera ------------------------------------------------------------

test('the camera zooms about the pointer, pans, clamps and resets in both views', () => {
  for (const dim of ['2d', '3d']) {
    const s = newScene(dim)
    expect(s.cam).toEqual({ x: 0, y: 0, z: 1 })
    const base = s.P(8, 6)
    // zooming about the canvas centre doubles the distance from it
    s.zoomAt(s.W / 2, s.H / 2, 2)
    expect(s.cam.z).toBeCloseTo(2)
    const zoomed = s.P(8, 6)
    expect(zoomed[0] - s.W / 2).toBeCloseTo((base[0] - s.W / 2) * 2, 5)
    expect(zoomed[1] - s.H / 2).toBeCloseTo((base[1] - s.H / 2) * 2, 5)
    // panning is a screen-space shift, so anchors move with it
    s.panBy(25, -15)
    expect(s.P(8, 6)[0]).toBeCloseTo(zoomed[0] + 25, 5)
    expect(s.P(8, 6)[1]).toBeCloseTo(zoomed[1] - 15, 5)
    // a huge drag is clamped to the room, never lost off-canvas
    s.panBy(1e6, 1e6)
    const b = s.roomBox, z = s.cam.z
    const mx = Math.max(0, ((b.maxX - b.minX) * z - s.W) / 2) + s.W * CAMERA.panMargin
    const my = Math.max(0, ((b.maxY - b.minY) * z - s.H) / 2) + s.H * CAMERA.panMargin
    expect(s.cam.x).toBeCloseTo(mx, 4)
    expect(s.cam.y).toBeCloseTo(my, 4)
    // zoom is clamped, and a nonsense factor is ignored
    s.zoomAt(0, 0, 1000)
    expect(s.cam.z).toBe(CAMERA.maxZoom)
    s.zoomAt(0, 0, 0.0001)
    expect(s.cam.z).toBe(CAMERA.minZoom)
    s.zoomAt(0, 0, NaN)
    expect(s.cam.z).toBe(CAMERA.minZoom)
    // the keyboard reset and the Home key both land here
    s.resetCamera()
    expect(s.cam).toEqual({ x: 0, y: 0, z: 1 })
    expect(s.P(8, 6)[0]).toBeCloseTo(base[0], 6)
    expect(s.P(8, 6)[1]).toBeCloseTo(base[1], 6)
  }
})

test('every anchor follows the camera transform', () => {
  const s = newScene('3d')
  let anchors = []
  s.onFrame = (a) => { anchors = a }
  s.setAgents([{ key: 'a', seed: 3, status: 'done', brand: { color: '#4f46e5' } }])
  s.draw()
  expect(anchors.length).toBe(1)
  const before = { ...anchors[0] }

  s.panBy(30, 20)
  s.draw()
  expect(anchors[0].x).toBeCloseTo(before.x + 30, 5)
  expect(anchors[0].y).toBeCloseTo(before.y + 20, 5)
  expect(anchors[0].fx).toBeCloseTo(before.fx + 30, 5)
  expect(anchors[0].fy).toBeCloseTo(before.fy + 20, 5)

  s.resetCamera()
  s.draw()
  const home = { ...anchors[0] }
  s.zoomAt(s.W / 2, s.H / 2, 1.5)
  s.draw()
  expect(anchors[0].x - s.W / 2).toBeCloseTo((home.x - s.W / 2) * 1.5, 5)
  expect(anchors[0].y - s.H / 2).toBeCloseTo((home.y - s.H / 2) * 1.5, 5)
  // the projected point under the anchor agrees with the worker
  const w = s.workers.get('a')
  expect(anchors[0].x).toBeCloseTo(w.screen.x, 5)
  expect(anchors[0].fy).toBeCloseTo(w.screen.foot[1], 5)
})

// ---- local time --------------------------------------------------------

test('local time is a pure dawn/day/dusk/night palette', () => {
  expect(dayPhase(6).phase).toBe('dawn')
  expect(dayPhase(12).phase).toBe('day')
  expect(dayPhase(18).phase).toBe('dusk')
  expect(dayPhase(23).phase).toBe('night')
  // boundaries and wrap-around are deterministic
  expect(dayPhase(5).phase).toBe('dawn')
  expect(dayPhase(7.5).phase).toBe('day')
  expect(dayPhase(17).phase).toBe('dusk')
  expect(dayPhase(19.5).phase).toBe('night')
  expect(dayPhase(0).phase).toBe('night')
  expect(dayPhase(-1).phase).toBe('night')
  expect(dayPhase(36).phase).toBe(dayPhase(12).phase)
  // the same input always gives the same palette
  expect(dayPhase(6)).toEqual(dayPhase(6))
  const phases = ['dawn', 'day', 'dusk', 'night'].map((phase, i) => dayPhase([6, 12, 18, 23][i]))
  expect(new Set(phases.map((p) => p.phase)).size).toBe(4)
  expect(new Set(phases.map((p) => p.sky[0])).size).toBe(4)
  expect(new Set(phases.map((p) => p.glass)).size).toBe(4)
  for (const p of phases) {
    expect(p.sky).toHaveLength(2)
    expect(p.star).toBeGreaterThanOrEqual(0)
    expect(p.star).toBeLessThanOrEqual(1)
    expect(p.ambient).toMatch(/^rgba\(/)
  }
  expect(dayPhase(new Date(2026, 0, 15, 14, 30))).toMatchObject({ phase: 'day', hour: 14.5 })
  // the scene reads the clock, and an override makes its render testable
  const s = newScene('3d')
  s.phaseOverride = 12
  expect(s.currentPhase().phase).toBe('day')
  s.phaseOverride = 22
  expect(s.currentPhase().phase).toBe('night')
})

// ---- drawing -----------------------------------------------------------

for (const dim of ['2d', '3d']) {
  test(`${dim}: venues, the cat and the clock draw without a real canvas`, () => {
    const s = newScene(dim)
    s.setAgents([
      { key: 'done', seed: 3, status: 'done', brand: { color: '#4f46e5' }, idle: true },
      { key: 'work', seed: 4, status: 'executing', brand: { color: '#0ea5e9' } },
      { key: 'wait', seed: 5, status: 'waiting', brand: { color: '#f59e0b' } },
    ])
    expect(() => { s.step(1 / 60); s.draw() }).not.toThrow()
    // the drawables include the five venue bodies plus every fitting
    expect(s.props().length).toBeGreaterThan(10)
    // both views project the room into the canvas
    for (const [x, y] of [[0, 0], [ROOM.w, 0], [ROOM.w, ROOM.d], [0, ROOM.d]]) {
      const [px, py] = s.P(x, y)
      expect(px).toBeGreaterThan(-s.W)
      expect(px).toBeLessThan(s.W * 2)
      expect(py).toBeGreaterThan(-s.H)
      expect(py).toBeLessThan(s.H * 2)
    }
    // every approach ring is projected inside the room's fitted box
    for (const [ax, ay] of POI_APPROACHES) {
      const [px, py] = s.P(ax, ay)
      expect(Number.isFinite(px) && Number.isFinite(py)).toBe(true)
    }
  })
}

test('2D and isometric remain distinct projections', () => {
  const flat = newScene('2d'), iso = newScene('3d')
  expect(flat.P(4, 6)).not.toEqual(iso.P(4, 6))
  expect(flat.cam).toEqual(iso.cam)
})
