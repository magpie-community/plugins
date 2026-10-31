// Tests for the standalone 3D office renderer. These run in bun without a
// browser, WebGL or network. Pure helpers also work without THREE; renderer
// regressions use the bundled THREE and stub only the GPU boundary.
import { describe, expect, test } from "bun:test"
import { readFileSync, statSync } from "node:fs"
import { join } from "node:path"

const dir = import.meta.dir
const page = join(dir, "page")
const read = (file) => readFileSync(join(page, file), "utf8")

// Load the classic script the way the page does, with no THREE at all.
const scope = {}
new Function("globalThis", read("scene3d.js"))(scope)
const S = scope.AgentOfficeScene3D

describe("bundle and registry", () => {
  test("three.js is bundled locally with its MIT notice", () => {
    const file = join(page, "three.min.js")
    const size = statSync(file).size
    const src = readFileSync(file, "utf8")
    expect(size).toBeGreaterThan(600000)
    expect(size).toBeLessThan(1000000)
    expect(src.startsWith("/*! three.js")).toBe(true)
    expect(src).toContain("MIT License")
    expect(src).toContain("Copyright © 2010-2024 three.js authors")
    expect(src).toContain("globalThis.THREE=THREE")
    expect(src).not.toMatch(/(?:src|href)\s*=\s*["']https?:/)
    // the bundled revision, checked without needing a browser
    const trio = {}
    new Function("globalThis", src)(trio)
    expect(trio.THREE.REVISION).toBe("169")
  })

  test("scene3d.js carries the three.js license notice", () => {
    const src = read("scene3d.js")
    expect(src).toContain("three.js r169 is bundled in page/three.min.js under the MIT License")
    expect(src).toContain("Copyright © 2010-2024 three.js authors")
  })

  test("six scenes are registered with palettes and props", () => {
    expect(S.SCENE_IDS).toEqual(["office", "station", "cafe", "castle", "pirate", "graveyard"])
    expect(Object.keys(S.SCENES).sort()).toEqual(S.SCENE_IDS.slice().sort())
    for (const id of S.SCENE_IDS) {
      const theme = S.SCENES[id]
      expect(theme.id).toBe(id)
      expect(theme.floor).toMatch(/^#[0-9a-f]{6}$/i)
      expect(theme.wall).toMatch(/^#[0-9a-f]{6}$/i)
      expect(theme.accent).toMatch(/^#[0-9a-f]{6}$/i)
      expect(Array.isArray(theme.props)).toBe(true)
      expect(theme.props.length).toBeGreaterThan(1)
    }
    for (const prop of ["coffee", "pingpong", "bookshelf", "whiteboard", "arcade"]) {
      expect(S.SCENES.office.props).toContain(prop)
    }
  })

  test("public API is exposed", () => {
    expect(typeof S).toBe("function")
    expect(S.VERSION).toBe("1.0.0")
    for (const name of ["setAgents", "anchors", "setSelected", "resize", "dispose", "setScene", "setQuality"]) {
      expect(typeof S.prototype[name]).toBe("function")
    }
    expect(S.isSupported()).toBe(false) // bun: no document/WebGL
  })
})

describe("degraded constructor", () => {
  test("no canvas, no WebGL, no throw", () => {
    const s = new S(null, { scene: "nope", quality: "nope" })
    expect(s.available).toBe(false)
    expect(s.id).toBe("office")
    expect(s.theme).toBe(S.SCENES.office)
    expect(s.anchors()).toEqual([])
    expect(() => {
      s.setAgents([null, undefined, 3, {}, { key: "" }, { key: "a" }])
      s.setSelected("a")
      s.resize()
      s.setScene("cafe")
      s.setQuality("low")
      s.setTime(new Date(2024, 0, 1, 12))
      s.dispose()
    }).not.toThrow()
    expect(s.id).toBe("cafe")
    expect(s.quality).toBe("low")
    expect(s.disposed).toBe(true)
  })

  test("setAgents tolerates invalid lists and dedupes keys", () => {
    const s = new S()
    expect(() => s.setAgents(null)).not.toThrow()
    expect(() => s.setAgents("nope")).not.toThrow()
    s.setAgents([
      null,
      { key: "one", status: "thinking" },
      { key: "two" },
      { key: "one", status: "done" },
      { nope: true },
      { key: 42, status: "waiting" },
    ])
    expect(s.agents.map((a) => a.key)).toEqual(["one", "two", "42"])
    expect(s.agents[0].status).toBe("thinking")
    expect(s.anchors()).toEqual([])
    s.dispose()
  })
})

describe("layout and seats", () => {
  test("the layout is deterministic and inside the room", () => {
    expect(S.SPOTS.desk.length).toBe(8)
    expect(S.SPOTS.sofa.length).toBe(7)
    expect(S.SPOTS.zone.length).toBe(12)
    expect(S.SPOTS.error.length).toBe(4)
    expect(S.SPOTS.wander.length).toBe(9)
    for (const kind of Object.keys(S.SPOTS)) {
      for (const spot of S.SPOTS[kind]) {
        expect(spot.x).toBeGreaterThan(0.3)
        expect(spot.x).toBeLessThan(S.ROOM.w - 0.3)
        expect(spot.z).toBeGreaterThan(0.3)
        expect(spot.z).toBeLessThan(S.ROOM.d - 0.3)
        expect(["n", "s", "e", "w"]).toContain(spot.face)
        expect(Array.isArray(spot.route)).toBe(true)
      }
    }
    expect(S.seatFor("agent-one", "desk")).toBe(S.seatFor("agent-one", "desk"))
    expect(S.seatFor("agent-one", "desk").kind).toBe("desk")
  })

  test("statuses map to the right room area", () => {
    expect(S.spotKindForStatus("thinking")).toBe("desk")
    expect(S.spotKindForStatus("executing")).toBe("desk")
    expect(S.spotKindForStatus("replying")).toBe("desk")
    expect(S.spotKindForStatus("waiting")).toBe("zone")
    expect(S.spotKindForStatus("error")).toBe("error")
    expect(S.spotKindForStatus("done")).toBe("sofa")
    expect(S.spotKindForStatus("idle")).toBe("wander")
    expect(S.spotKindForStatus("what")).toBe("wander")
  })

  test("assignSeats never collides and follows status", () => {
    const list = []
    for (let i = 0; i < 20; i++) list.push({ key: "k" + i, status: ["thinking", "waiting", "error", "done", "idle"][i % 5] })
    const a = S.assignSeats(list)
    const b = S.assignSeats(list.slice().reverse())
    expect(a).toEqual(b)
    const ids = Object.values(a)
    expect(new Set(ids).size).toBe(ids.length)
    for (const [key, id] of Object.entries(a)) {
      const spot = S.SPOTS[S.spotKindForStatus(list.find((x) => x.key === key).status)].find((p) => p.id === id) ||
        Object.values(S.SPOTS).flat().find((p) => p.id === id)
      expect(spot).toBeTruthy()
    }
    // overflow spills over instead of stacking on one seat
    const crowd = []
    for (let i = 0; i < 14; i++) crowd.push({ key: "crowd" + i, status: "thinking" })
    const assigned = S.assignSeats(crowd)
    expect(new Set(Object.values(assigned)).size).toBe(14)
    expect(Object.keys(assigned).length).toBe(14)
  })

  test("walk paths avoid walls, desks and props", () => {
    for (const kind of ["desk", "zone", "error", "wander"]) {
      for (const spot of S.SPOTS[kind]) {
        const hit = S.routeBlocked(spot.route)
        expect(hit, `${kind} ${spot.id} blocked at ${hit && hit.x.toFixed(2)},${hit && hit.z.toFixed(2)}`).toBeNull()
      }
    }
    // sofa routes end inside the sofa, so the last step is exempt
    for (const spot of S.SPOTS.sofa) expect(S.routeBlocked(spot.route, { ignoreLast: true })).toBeNull()
    // and a route through a desk is detected
    expect(S.routeBlocked([[4.05, 3.0], [4.05, 1.0]])).not.toBeNull()
    expect(S.routeBlocked([[1.0, 2.9], [10.0, 2.9]])).toBeNull()
  })

  test("lane offsets keep the endpoints but separate aisle walkers", () => {
    const route = [[1, 1], [2, 1], [3, 2]]
    const shifted = S.laneRoute(route, 0.2)
    expect(shifted[0]).toEqual([1, 1])
    expect(shifted[shifted.length - 1]).toEqual([3, 2])
    expect(shifted[1]).not.toEqual([2, 1])
    expect(S.laneRoute(route, 0)).toEqual(route)
  })
})

describe("pure math helpers", () => {
  test("camera zoom and polar clamps", () => {
    expect(S.clampZoom(0)).toBe(0.55)
    expect(S.clampZoom(99)).toBe(3)
    expect(S.clampZoom("x")).toBe(1.05)
    expect(S.clampPolar(-1)).toBe(0.35)
    expect(S.clampPolar(9)).toBe(1.42)
    expect(S.wrapAzimuth(0)).toBe(0)
    expect(S.wrapAzimuth(Math.PI * 3)).toBeCloseTo(-Math.PI, 5)
    expect(Math.abs(S.wrapAzimuth(-Math.PI * 3))).toBeCloseTo(Math.PI, 5)
  })

  test("colour parsing and mixing", () => {
    expect(S.mixColor("#000000", "#ffffff", 0.5)).toBe("#808080")
    expect(S.mixColor("#ff0000", "#00ff00", 0)).toBe("#ff0000")
    expect(S.mixColor("#ff0000", "#00ff00", 1)).toBe("#00ff00")
    expect(S.mixColor("not-a-colour", "#ffffff", 1)).toBe("#ffffff")
    expect(S.colorToHex("hsl(0 100% 50%)")).toBe("#ff0000")
    expect(S.colorToHex("rgb(0, 128, 255)")).toBe("#0080ff")
    expect(S.colorToHex("nope", "#123456")).toBe("#123456")
    expect(S.parseColor("#abc")).toEqual([170, 187, 204])
  })

  test("local time drives sky, sun and window tints", () => {
    const noon = S.timeOfDay(new Date(2024, 0, 1, 12, 0))
    const night = S.timeOfDay(new Date(2024, 0, 1, 2, 0))
    expect(noon.dayFactor).toBeGreaterThan(0.9)
    expect(night.dayFactor).toBeLessThan(0.1)
    expect(noon.sunIntensity).toBeGreaterThan(night.sunIntensity)
    expect(noon.sky).not.toBe(night.sky)
    expect(noon.window).not.toBe(night.window)
    expect(noon.hour).toBe(12)
    expect(night.phase).toBe("night")
    expect(S.timeOfDay("not a date").label).toBeTruthy()
  })

  test("projectToScreen does the NDC -> CSS pixel math", () => {
    const project = (p) => ({ x: p.x, y: p.y, z: p.z })
    const center = S.projectToScreen({ x: 0, y: 0, z: 0 }, project, 1000, 500)
    expect(center).toEqual({ x: 500, y: 250, visible: true })
    const corner = S.projectToScreen({ x: 1, y: -1, z: 0.5 }, project, 1000, 500)
    expect(corner).toEqual({ x: 1000, y: 500, visible: true })
    const off = S.projectToScreen({ x: 0, y: 0, z: 2 }, project, 1000, 500)
    expect(off.visible).toBe(false)
    const outside = S.projectToScreen({ x: 2, y: 0, z: 0.5 }, project, 1000, 500)
    expect(outside.visible).toBe(false)
    expect(S.projectToScreen({ x: 0, y: 0, z: 0 }, { project: () => ({ x: NaN, y: 0, z: 0 }) }, 10, 10).visible).toBe(false)
    expect(S.projectToScreen(null, project, 10, 10)).toEqual({ x: 0, y: 0, visible: false })
    // a camera-like object works too
    const fakeCamera = { project: (p) => ({ x: p.x * 0.5, y: p.y * 0.5, z: 0 }) }
    expect(S.projectToScreen({ x: 0.5, y: 0.5, z: 0 }, fakeCamera, 200, 100)).toEqual({ x: 125, y: 37.5, visible: true })
  })
})

// Exercise the shipped THREE scene graph, geometry, materials and projection.
// Only the GPU boundary is stubbed; no renderer methods are bypassed.
function threeFixture({ hidden = false, failRender = false, failInit = false } = {}) {
  class Events {
    constructor() { this.listeners = new Map() }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set())
      this.listeners.get(type).add(fn)
    }
    removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn) }
    emit(type, event = {}) { for (const fn of this.listeners.get(type) || []) fn(event) }
  }
  const canvas = new Events()
  Object.assign(canvas, {
    width: 300, height: 150, clientWidth: 800, clientHeight: 600,
    style: { touchAction: "auto" },
    getContext: () => ({}),
    getBoundingClientRect() { return { width: this.clientWidth, height: this.clientHeight } },
    setPointerCapture() {}, releasePointerCapture() {},
  })
  const document = new Events()
  document.hidden = hidden
  const ctx = new Proxy({}, { get(target, key) { return target[key] || (() => {}) }, set(target, key, value) { target[key] = value; return true } })
  document.createElement = () => ({ getContext: () => ctx })
  const callbacks = new Map()
  let serial = 0
  const world = new Events()
  Object.assign(world, {
    document, devicePixelRatio: 2,
    requestAnimationFrame(fn) { const id = ++serial; callbacks.set(id, fn); return id },
    cancelAnimationFrame(id) { callbacks.delete(id) },
  })
  new Function("globalThis", read("three.min.js"))(world)
  const T = world.THREE
  class Renderer {
    constructor(options) {
      this.options = options
      this.shadowMap = {}
      this.renders = 0
      this.dpr = 1
      this.disposed = false
    }
    getContext() { if (failInit) throw new Error("init failed"); return {} }
    setPixelRatio(dpr) { this.dpr = dpr }
    setSize(w, h) { canvas.width = Math.floor(w * this.dpr); canvas.height = Math.floor(h * this.dpr) }
    render(scene, camera) {
      if (failRender) throw new Error("render failed")
      this.renders++
      scene.updateMatrixWorld(true)
      camera.updateMatrixWorld(true)
      // Mirror renderer submissions: an InstancedMesh with one material is
      // one group, regardless of instance count. Hidden pose graphs submit none.
      this.workerDrawGroups = 0
      this.workerShadowGroups = 0
      this.workerInstances = 0
      scene.getObjectByName("workers").traverseVisible((object) => {
        if (!object.isMesh || (object.isInstancedMesh && object.count === 0)) return
        const groups = Array.isArray(object.material) ? object.geometry.groups.length : 1
        this.workerDrawGroups += groups
        if (object.castShadow) this.workerShadowGroups += groups
        this.workerInstances += object.isInstancedMesh ? object.count : 1
      })
    }
    dispose() { this.disposed = true }
    forceContextLoss() { this.lost = true }
  }
  world.THREE = { ...T, WebGLRenderer: Renderer }
  new Function("globalThis", "document", read("scene3d.js"))(world, document)
  const scene = new world.AgentOfficeScene3D(canvas)
  const frame = (now = 1000) => {
    const queued = [...callbacks.values()]
    callbacks.clear()
    for (const fn of queued) fn(now)
  }
  return { scene, canvas, document, callbacks, frame, T, world }
}

function requireThree(fixture) {
  expect(fixture.scene.error).toBeNull()
  expect(fixture.scene.available).toBe(true)
  expect(fixture.scene.env.children.length).toBeGreaterThan(10)
  return fixture
}

describe("THREE renderer path", () => {
  test("visibility resumes only an enabled renderer, including a queued stale frame", () => {
    const f = requireThree(threeFixture())
    let labels = 0
    f.scene.onFrame = () => labels++
    f.frame()
    expect(labels).toBe(1)
    const stale = [...f.callbacks.values()][0]
    f.scene.stop()
    f.document.hidden = true
    f.document.emit("visibilitychange")
    f.document.hidden = false
    f.document.emit("visibilitychange")
    stale(1100)
    expect(f.callbacks.size).toBe(0)
    expect(labels).toBe(1)
    f.scene.start()
    stale(1200)
    expect(f.callbacks.size).toBe(1)
    f.document.hidden = true
    f.document.emit("visibilitychange")
    expect(f.callbacks.size).toBe(0)
    f.document.hidden = false
    f.document.emit("visibilitychange")
    expect(f.callbacks.size).toBe(1)
    f.scene.dispose()
    f.document.emit("visibilitychange")
    expect(f.callbacks.size).toBe(0)
  })

  test("initial hidden state and hidden resizes preserve CSS dimensions at DPR two", () => {
    const f = requireThree(threeFixture({ hidden: true }))
    expect(f.callbacks.size).toBe(0)
    expect(f.canvas.width).toBe(1600)
    f.canvas.clientWidth = f.canvas.clientHeight = 0
    for (let i = 0; i < 8; i++) f.scene.resize()
    expect([f.scene.width, f.scene.height]).toEqual([800, 600])
    expect([f.canvas.width, f.canvas.height]).toEqual([1600, 1200])
    f.scene.setQuality("low")
    expect([f.canvas.width, f.canvas.height]).toEqual([800, 600])
    expect(f.scene.renderer.options.antialias).toBe(true)
    expect(f.scene._lights.sun.shadow.mapSize.x).toBe(512)
    f.canvas.clientWidth = 640
    f.canvas.clientHeight = 480
    f.scene.setQuality("high")
    expect([f.canvas.width, f.canvas.height]).toEqual([1280, 960])
    expect(f.scene._lights.sun.shadow.mapSize.x).toBe(2048)
    f.scene.dispose()
  })

  test("context loss suspends frames and restoration respects an intervening mode switch", () => {
    const f = requireThree(threeFixture())
    let prevented = false
    f.canvas.emit("webglcontextlost", { cancelable: true, preventDefault() { prevented = true } })
    expect(prevented).toBe(true)
    expect(f.callbacks.size).toBe(0)
    f.canvas.emit("webglcontextrestored")
    expect(f.callbacks.size).toBe(1)
    f.frame()
    expect(f.scene.renderer.renders).toBe(1)
    f.canvas.emit("webglcontextlost", { cancelable: false })
    f.scene.stop()
    f.canvas.emit("webglcontextrestored")
    expect(f.callbacks.size).toBe(0)
    const renderer = f.scene.renderer
    f.scene.dispose()
    expect(renderer.disposed).toBe(true)
    expect([...f.canvas.listeners.values()].every((set) => set.size === 0)).toBe(true)
    expect(f.canvas.style.touchAction).toBe("auto")
  })

  test("GPU initialization and rendering failures release resources or stop scheduling", () => {
    const failed = threeFixture({ failInit: true })
    expect(failed.scene.available).toBe(false)
    expect(failed.scene.error.message).toBe("init failed")
    expect(failed.callbacks.size).toBe(0)
    expect(failed.scene.disposed).toBe(true)
    const f = requireThree(threeFixture({ failRender: true }))
    f.frame()
    expect(f.scene.error.message).toBe("render failed")
    expect(f.callbacks.size).toBe(0)
    f.scene.dispose()
  })

  test("worker draw groups stay bounded for 32 articulated workers and retain colors and shadows", () => {
    const f = requireThree(threeFixture())
    const statuses = Object.keys(S.STATUS_COLORS)
    const crowd = Array.from({ length: 32 }, (_, i) => ({ key: `batch-${i}`, status: statuses[i % statuses.length], brand: { color: i % 2 ? "#ff2200" : "#2255ff" } }))
    f.scene.setAgents(crowd.slice(0, 1))
    f.frame(1000)
    expect(f.scene.renderer.workerDrawGroups).toBe(3)
    expect(f.scene.renderer.workerInstances).toBe(19)
    const only = f.scene._map.get("batch-0")
    const onlyBody = new f.T.Vector3(only.pos.x, 0.95, only.pos.z).project(f.scene.camera)
    expect(f.scene.hit((onlyBody.x + 1) * f.scene.width / 2, (1 - onlyBody.y) * f.scene.height / 2)).toBe("batch-0")
    expect(f.scene.anchors().map((a) => a.key)).toEqual(["batch-0"])
    f.scene.setAgents([{ ...crowd[0], status: "error" }])
    expect(f.scene._workerBatches.get("badge:" + new f.T.Color(S.STATUS_COLORS.thinking).getHexString()).count).toBe(0)
    const errorBadge = f.scene._workerBatches.get("badge:" + new f.T.Color(S.STATUS_COLORS.error).getHexString())
    expect(errorBadge.count).toBe(1)
    expect(errorBadge.material.emissive.getHexString()).toBe(new f.T.Color(S.STATUS_COLORS.error).getHexString())
    f.scene.setAgents(crowd)
    f.frame(1100)
    expect(f.scene.renderer.workerDrawGroups).toBe(2 + statuses.length)
    expect(f.scene.renderer.workerDrawGroups).toBeLessThan(10)
    expect(f.scene.renderer.workerShadowGroups).toBe(1)
    expect(f.scene.renderer.workerInstances).toBe(32 * 19)
    const matrix = new f.T.Matrix4(), color = new f.T.Color()
    const offsets = new Map()
    for (const rt of f.scene._map.values()) {
      expect(rt.group.visible).toBe(false)
      for (const mesh of rt.meshes) {
        const badge = mesh === rt.parts.badge
        const key = badge ? "badge:" + mesh.material.color.getHexString() : (mesh.castShadow ? "body" : "detail")
        const index = offsets.get(key) || 0
        offsets.set(key, index + 1)
        const batch = f.scene._workerBatches.get(key)
        expect(batch.isInstancedMesh).toBe(true)
        expect(batch.receiveShadow).toBe(mesh.receiveShadow)
        expect(batch.castShadow).toBe(mesh.castShadow)
        batch.getMatrixAt(index, matrix)
        matrix.elements.forEach((v, i) => expect(v).toBeCloseTo(mesh.matrixWorld.elements[i], 5))
        if (badge) {
          expect(batch.material).toBe(mesh.material)
          expect(batch.material.emissive.getHexString()).toBe(mesh.material.color.getHexString())
          expect(batch.material.emissiveIntensity).toBe(0.5)
        } else {
          expect(batch.material.color.getHexString()).toBe("ffffff")
          batch.getColorAt(index, color)
          expect(color.r).toBeCloseTo(mesh.material.color.r, 6)
          expect(color.g).toBeCloseTo(mesh.material.color.g, 6)
          expect(color.b).toBeCloseTo(mesh.material.color.b, 6)
        }
      }
    }
    const rt = f.scene._map.get("batch-0")
    const body = f.scene._workerBatches.get("body")
    const before = Array.from(body.instanceMatrix.array.slice(0, 16))
    const legBefore = rt.parts.legL.rotation.x
    const version = body.instanceMatrix.version
    f.frame(1200)
    expect(Array.from(body.instanceMatrix.array.slice(0, 16))).not.toEqual(before)
    expect(rt.parts.legL.rotation.x).not.toBe(legBefore)
    expect(body.instanceMatrix.version).toBeGreaterThan(version)
    body.getMatrixAt(0, matrix)
    matrix.elements.forEach((v, i) => expect(v).toBeCloseTo(rt.meshes[0].matrixWorld.elements[i], 5))
    expect(f.scene.anchors().length).toBe(32)
    const projected = new f.T.Vector3(rt.pos.x, 0.95, rt.pos.z).project(f.scene.camera)
    expect(f.scene.hit((projected.x + 1) * f.scene.width / 2, (1 - projected.y) * f.scene.height / 2)).toBeTruthy()
    f.scene.dispose()
  })

  test("instance capacity grows for overlapping crowds and all instance resources dispose once", () => {
    const f = requireThree(threeFixture())
    const crowd = (prefix) => Array.from({ length: 32 }, (_, i) => ({ key: `${prefix}-${i}`, status: "waiting" }))
    f.scene.setAgents(crowd("old"))
    const replaced = f.scene._workerBatches.get("body")
    let replacementDisposals = 0
    replaced.addEventListener("dispose", () => replacementDisposals++)
    f.scene.setAgents(crowd("new"))
    expect(replacementDisposals).toBe(1)
    f.frame()
    expect(f.scene.renderer.workerInstances).toBe(64 * 19)
    expect(f.scene.renderer.workerDrawGroups).toBe(3)
    for (let i = 0; i < 500; i++) f.scene._updateWorkers(0.05)
    f.frame(1100)
    expect(f.scene.renderer.workerInstances).toBe(32 * 19)
    f.scene.setAgents([])
    for (let i = 0; i < 500; i++) f.scene._updateWorkers(0.05)
    f.frame(1200)
    expect(f.scene.renderer.workerDrawGroups).toBe(0)
    const resources = [...f.scene._workerBatches.values(), ...f.scene._sharedGeo, ...f.scene._sharedMat]
    const disposed = new Map(resources.map((r) => [r, 0]))
    for (const resource of resources) resource.addEventListener("dispose", () => disposed.set(resource, disposed.get(resource) + 1))
    const group = f.scene.workerGroup
    f.scene.dispose()
    f.scene.dispose()
    expect([...disposed.values()].every((count) => count === 1)).toBe(true)
    expect(group.children.length).toBe(0)
    expect(group.parent).toBeNull()
    expect(f.scene._workerBatches.size).toBe(0)
    expect(f.scene.workerGroup).toBeNull()
    expect(f.callbacks.size).toBe(0)
  })

  test("32 workers receive distinct spots, walk to them, change status and leave", () => {
    const f = requireThree(threeFixture())
    const agents = Array.from({ length: 32 }, (_, i) => ({ key: `worker-${i}`, status: "executing" }))
    f.scene.setAgents(agents)
    expect(f.scene._map.size).toBe(32)
    expect(f.scene._taken.size).toBe(32)
    expect([...f.scene._map.values()].every((rt) => rt.spot && rt.group.children.length > 10)).toBe(true)
    for (let i = 0; i < 400; i++) f.scene._updateWorkers(0.05)
    const workers = [...f.scene._map.values()]
    expect(workers.every((rt) => rt.mode !== "walk")).toBe(true)
    expect(new Set(workers.map((rt) => `${rt.pos.x},${rt.pos.z}`)).size).toBe(32)
    expect(workers.every((rt) => rt.pos.x !== S.Layout.ENTRY[0] || rt.pos.z !== S.Layout.ENTRY[1])).toBe(true)
    f.scene.setAgents([{ key: "worker-0", status: "error" }])
    expect(f.scene._map.get("worker-0").spot.kind).toBe("error")
    expect(f.scene._taken.size).toBe(1)
    for (let i = 0; i < 500; i++) f.scene._updateWorkers(0.05)
    expect(f.scene._map.size).toBe(1)
    expect(f.scene._taken.size).toBe(1)
    f.frame()
    expect(f.scene.anchors().map((a) => a.key)).toEqual(["worker-0"])
    f.scene.dispose()
    expect(f.scene._sharedGeo.size).toBe(0)
    expect(f.scene._envTex.size).toBe(0)
  })

  test("a full crowd can be replaced before departing workers finish leaving", () => {
    const f = requireThree(threeFixture())
    const crowd = (prefix) => Array.from({ length: 32 }, (_, i) => ({ key: `${prefix}-${i}`, status: "waiting" }))
    f.scene.setAgents(crowd("old"))
    for (let i = 0; i < 400; i++) f.scene._updateWorkers(0.05)
    f.scene.setAgents(crowd("new"))
    expect(f.scene._taken.size).toBe(32)
    const active = [...f.scene._map.values()].filter((rt) => !rt.leaving)
    expect(active.length).toBe(32)
    expect(active.every((rt) => rt.spot)).toBe(true)
    for (let i = 0; i < 500; i++) f.scene._updateWorkers(0.05)
    expect(f.scene._map.size).toBe(32)
    expect([...f.scene._map.values()].every((rt) => rt.mode !== "walk")).toBe(true)
    f.scene.dispose()
  })

  test("six THREE environments keep decorations off seats and walking routes", () => {
    const f = requireThree(threeFixture())
    for (const id of S.SCENE_IDS) {
      const previous = f.scene.env
      f.scene.setScene(id)
      expect(previous.parent).toBeNull()
      expect(f.scene.env.children.length).toBeGreaterThan(10)
      for (const prop of S.SCENES[id].props) {
        const group = f.scene.env.getObjectByName("props:" + prop)
        expect(group.children.length).toBeGreaterThan(0)
        expect(group.children.every((object) => object.visible), `${id} retains ${prop}`).toBe(true)
      }
      f.scene.env.updateMatrixWorld(true)
      let checked = 0
      f.scene.env.traverse((object) => {
        if (!object.userData.decoration || !object.visible) return
        const bounds = new f.T.Box3()
        object.traverse((mesh) => {
          if (!mesh.isMesh) return
          const b = new f.T.Box3().setFromObject(mesh)
          if (b.max.y > 0.06 && b.min.y < 1.7) bounds.union(b)
        })
        checked++
        for (const pool of Object.values(S.SPOTS)) for (const spot of pool) {
          for (let i = 1; i < spot.route.length; i++) {
            const a = spot.route[i - 1], b = spot.route[i]
            const n = Math.max(1, Math.ceil(Math.hypot(a[0] - b[0], a[1] - b[1]) / 0.1))
            for (let j = 0; j <= n; j++) {
              const x = a[0] + (b[0] - a[0]) * j / n, z = a[1] + (b[1] - a[1]) * j / n
              const hit = x > bounds.min.x - 0.3 && x < bounds.max.x + 0.3 && z > bounds.min.z - 0.3 && z < bounds.max.z + 0.3
              if (hit) throw new Error(`${id} decoration intersects ${spot.id} route at ${x},${z}`)
            }
          }
        }
      })
      expect(checked).toBeGreaterThan(4)
    }
    f.scene.dispose()
  })

  test("wheel consumes scrolling only when the active renderer can change zoom", () => {
    const f = requireThree(threeFixture())
    let prevented = 0
    const wheel = { deltaY: -100, deltaMode: 0, cancelable: true, preventDefault() { prevented++ } }
    f.scene.stop()
    f.canvas.emit("wheel", wheel)
    expect(prevented).toBe(0)
    f.scene.start().setZoom(3)
    f.canvas.emit("wheel", wheel)
    expect(prevented).toBe(0)
    f.canvas.emit("wheel", { ...wheel, deltaY: 100 })
    expect(prevented).toBe(1)
    expect(f.scene.zoom).toBeLessThan(3)
    f.scene.dispose()
  })

  test("touch pinch zooms, single pointers orbit within the open walls, and cancellation resets", () => {
    const f = requireThree(threeFixture())
    const pointer = (pointerId, clientX, clientY = 100) => ({ pointerId, clientX, clientY, button: 0 })
    f.canvas.emit("pointerdown", pointer(1, 100))
    f.canvas.emit("pointerdown", pointer(2, 200))
    f.canvas.emit("pointermove", pointer(2, 300))
    expect(f.scene.zoom).toBeCloseTo(2.1)
    expect(f.scene.dragged).toBe(true)
    f.canvas.emit("pointerup", pointer(2, 300))
    f.canvas.emit("pointermove", pointer(1, 10000))
    expect(f.scene.azimuth).toBeGreaterThan(0)
    expect(f.scene.azimuth).toBeLessThan(Math.PI / 2)
    f.canvas.emit("pointermove", pointer(1, -10000))
    expect(f.scene.azimuth).toBeGreaterThan(0)
    expect(f.scene.azimuth).toBeLessThan(Math.PI / 2)
    f.canvas.emit("pointercancel", pointer(1, -10000))
    expect(f.scene._pointers.size).toBe(0)
    expect(f.scene._drag).toBeNull()
    f.scene.dispose()
  })
})
