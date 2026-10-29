import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
const scope = {}
new Function('globalThis', readFileSync(new URL('./page/scene.js', import.meta.url), 'utf8'))(scope)
const { Scene, DESKS, SOFA, SOFA_FACE } = scope.AgentOfficeScene
const V = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0] }
const dot = (a, b) => a[0] * b[0] + a[1] * b[1]

// A seat's facing must point at what its owner is meant to look at.
test('every desk seat faces its own desk, and island pairs face each other', () => {
  for (const d of DESKS) {
    const v = V[d.face]
    const mid = [d.x + d.w / 2, d.y + d.d / 2]
    const toDesk = [mid[0] - d.seat[0], mid[1] - d.seat[1]]
    expect(dot(v, toDesk)).toBeGreaterThan(0.2)
  }
  const north = DESKS[4], south = DESKS[6]
  expect(dot(V[north.face], V[south.face])).toBe(-1)
})

test('a sofa sitter faces away from the backrest', () => {
  expect(SOFA_FACE.length).toBe(SOFA.length)
  for (let i = 0; i < SOFA.length; i++) {
    const [x, y] = SOFA[i]
    const v = V[SOFA_FACE[i]]
    // left sofa: backrest at x .35-.75; front sofa: backrest at y 11.35-11.7
    const back = i < 5 ? [0.55, y] : [x, 11.5]
    expect(dot(v, [x - back[0], y - back[1]])).toBeGreaterThan(0.2)
  }
})

// The monitor's lit side and the chair's back are drawn from the facing.
const fakeCtx = () => new Proxy({}, {
  get: (o, k) => (k in o ? o[k] : k === 'createLinearGradient' ? () => ({ addColorStop() {} })
    : k === 'measureText' ? () => ({ width: 0 }) : () => {}),
  set: (o, k, v) => { o[k] = v; return true },
})
function spy(dim) {
  const s = Object.create(Scene.prototype)
  Object.assign(s, { dim, atSeat: {}, workers: new Map(), t: 0, s: 40, ox: 0, oy: 0, g: fakeCtx() })
  for (const name of ['box', 'poly', 'onFront', 'onBack', 'onLeft', 'onRight']) s[name] = () => {}
  s.depth = (x, y) => x + y
  s.P = (x, y, z = 0) => [x - y, x + y - z]
  return s
}
test('monitor screen faces the sitter and the chair back stands behind', () => {
  for (const d of DESKS) {
    const s = spy('3d')
    const faces = []
    s.onFront = () => faces.push('front')
    s.onBack = () => faces.push('back')
    const boxes = []
    s.box = (...a) => boxes.push(a)
    // the chair is a drawable of its own: run those too
    const chairKey = s.depth(d.seat[0], d.seat[1])
    const rest = s.props().filter((p) => p.k >= chairKey - 0.45 && p.k <= chairKey + 0.5)
    const props = s.props()
    const key = s.depth(d.x + d.w / 2, d.y + d.d)
    const deskProp = props.find((p) => Math.abs(p.k - key) < 1e-9)
    expect(deskProp).toBeDefined()
    deskProp.fn()
    const screenSide = faces[0]
    expect(screenSide).toBe(d.face === 's' ? 'back' : 'front')
    // chair back: a 0.1-deep slab behind the sitter, on the opposite side
    const cy = d.seat[1]
    for (const p of rest) p.fn()
    const chairBack = boxes.find(([x, y, z, w, h, hh]) => Math.abs(w - 0.56) < 1e-6 && Math.abs(h - 0.1) < 1e-6 && hh > 0.4)
    expect(chairBack).toBeDefined()
    const backY = chairBack[1]
    if (d.face === 'n') expect(backY).toBeGreaterThan(cy)
    else expect(backY).toBeLessThan(cy)
  }
})

test('a sitter facing away shows no face; facing east shows the profile', () => {
  const draw = (facing) => {
    const s = spy('3d')
    const calls = []
    for (const n of ['onFront', 'onBack', 'onLeft', 'onRight']) s[n] = (...a) => calls.push([n, a[a.length - 1]])
    const w = { key: 'k', x: 4, y: 6, kind: 'sofa', slot: 0, walking: false, facing, phase: 0, skin: '#fff', hair: '#000', pants: '#000', color: '#f00',
      a: { status: 'done', seed: 3, brand: { color: '#f00' } } }
    s.worker(w)
    return calls
  }
  // dark eye pixels only get drawn toward the camera (+y) or east (+x)
  const eyesOn = (calls) => calls.filter(([, c]) => c === '#1f2937')
  expect(eyesOn(draw('s')).length).toBe(2)
  const east = eyesOn(draw('e'))
  expect(east.length).toBe(2)
  expect(east.every(([n]) => n === 'onRight')).toBe(true)
  expect(eyesOn(draw('n')).length).toBe(0)
  expect(eyesOn(draw('w')).length).toBe(0)
})
