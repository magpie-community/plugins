import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
const scope = {}
new Function('globalThis', readFileSync(new URL('./page/scene.js', import.meta.url), 'utf8'))(scope)
const { Scene, SOFA } = scope.AgentOfficeScene
for (const dim of ['2d', '3d']) {
  test(`${dim}: sofa occupants are painted after all sofa surfaces`, () => {
    const scene = Object.create(Scene.prototype)
    scene.dim = dim
    scene.workers = new Map(SOFA.map(([x, y], slot) => [slot, { x, y, slot, kind: 'sofa', walking: false }]))
    const calls = []
    scene.box = () => calls.push('furniture')
    scene.worker = w => calls.push(w.slot)
    for (const front of [false, true]) {
      calls.length = 0
      scene.sofaLayer(front).fn()
      expect(calls.filter(x => typeof x === 'number').sort()).toEqual(front ? [5, 6] : [0, 1, 2, 3, 4])
      const firstPerson = calls.findIndex(x => typeof x === 'number')
      expect(calls.slice(firstPerson).every(x => typeof x === 'number')).toBe(true)
    }
    scene.workers.get(0).walking = true
    calls.length = 0
    scene.sofaLayer(false).fn()
    expect(calls).not.toContain(0)
  })
}
