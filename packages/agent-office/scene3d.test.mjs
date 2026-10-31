// Tests for the standalone 3D office renderer. These run in bun without a
// DOM, WebGL or network: scene3d.js must still load and expose its pure
// helpers, and the geometry/layout/API must be sane.
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
