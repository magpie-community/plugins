import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import registry from "./page/layouts.js"

const scope = { AGENT_OFFICE_LAYOUTS: registry }
new Function("globalThis", readFileSync(new URL("./page/scene3d.js", import.meta.url), "utf8"))(scope)
const Scene = scope.AgentOfficeScene3D

test("each scene binds its own layout and switches layouts", () => {
  expect(Scene.SCENE_IDS).toHaveLength(11)
  for (const id of Scene.SCENE_IDS) {
    const scene = new Scene(null, { scene: id })
    expect(scene.layoutRuntime).toBe(registry.runtime(Scene.THEMES[id].layout))
    expect(scene.layoutRuntime.ROOM).toBe(registry.layouts[Scene.THEMES[id].layout].room)
    scene.setScene(id === "office" ? "station" : "office")
    expect(scene.layoutRuntime).toBe(registry.runtime(scene.theme.layout))
  }
})

test("office desks and every spot route preserve the exported layout", () => {
  const { DESKS, SPOTS } = new Scene(null, { scene: "office" }).layoutRuntime
  expect(DESKS).toEqual(Scene.DESKS)
  for (const kind of Object.keys(Scene.SPOTS)) {
    expect(SPOTS[kind].map(spot => spot.route)).toEqual(Scene.SPOTS[kind].map(spot => spot.route))
  }
})

test("non-office reservations use distinct seats outside desk bodies", () => {
  for (const id of Scene.SCENE_IDS.filter(id => id !== "office")) {
    const scene = new Scene(null, { scene: id })
    const { DESKS, POOLS } = scene.layoutRuntime
    const count = Math.min(20, Object.values(POOLS).flat().length)
    const agents = Array.from({ length: count }, (_, i) => ({ key: `agent-${String(i).padStart(2, "0")}`, status: "thinking" }))
    const assigned = Scene.assignSeats(agents, POOLS)
    expect(Object.keys(assigned)).toHaveLength(count)
    expect(new Set(Object.values(assigned)).size).toBe(count)
    for (const agent of agents) {
      const spot = scene._freeSpot("desk", agent.key, null)
      expect(spot.id).toBe(assigned[agent.key])
      expect(DESKS.some(d => spot.x > d.x && spot.x < d.x + d.w && spot.z > d.z && spot.z < d.z + d.d)).toBe(false)
      scene._takeSpot({ key: agent.key }, spot)
    }
  }
})

test("workers follow the active layout through status changes and scene switches", () => {
  const scene = new Scene(null, { scene: "station" })
  scene.available = true
  scene.scene = {}
  scene.workerGroup = { remove() {} }
  scene._makeWorker = () => ({ group: { position: { y: 0 }, scale: { setScalar() {} } }, parts: {}, meshes: [] })
  scene._syncWorkerInstances = () => {}
  scene._buildEnvironment = () => {}
  scene._applyTime = () => {}
  scene.setAgents([{ key: "worker", status: "thinking" }])
  let worker = scene._map.get("worker")
  expect(scene.layoutRuntime.SPOTS.desk).toContain(worker.spot)
  expect(worker.route).toEqual(worker.spot.route)
  scene.setAgents([{ key: "worker", status: "waiting" }])
  expect(scene.layoutRuntime.SPOTS.zone).toContain(worker.spot)
  expect(worker.route).toEqual(scene.layoutRuntime.connectRoute([worker.pos.x, worker.pos.z], worker.spot.route))
  scene.setScene("cafe")
  worker = scene._map.get("worker")
  expect(scene.layoutRuntime.SPOTS.zone).toContain(worker.spot)
  expect(worker.route).toEqual(worker.spot.route)
  scene.setAgents([])
  expect(worker.route).toEqual(scene.layoutRuntime.exitRoute([worker.pos.x, worker.pos.z]))
})
