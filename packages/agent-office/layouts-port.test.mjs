import { expect, test } from "bun:test"
import registry from "./page/layouts.js"

const ids = ["office", "station", "cafe", "castle", "pirate", "graveyard", "library", "cyberlab", "greenhouse", "arctic", "rainynight"]

test("office layout matches upstream furniture and locations", () => {
  const office = registry.layouts.office
  expect(office.desks).toEqual([
    { x: 3.2, z: 0.55, w: 1.7, d: 0.9, seat: [4.05, 1.95], face: "n" },
    { x: 5.9, z: 0.55, w: 1.7, d: 0.9, seat: [6.75, 1.95], face: "n" },
    { x: 8.6, z: 0.55, w: 1.7, d: 0.9, seat: [9.45, 1.95], face: "n" },
    { x: 11.3, z: 0.55, w: 1.7, d: 0.9, seat: [12.15, 1.95], face: "n" },
    { x: 10.6, z: 4.6, w: 1.6, d: 0.8, seat: [11.4, 4], face: "s", island: true },
    { x: 12.4, z: 4.6, w: 1.6, d: 0.8, seat: [13.2, 4], face: "s", island: true },
    { x: 10.6, z: 5.4, w: 1.6, d: 0.8, seat: [11.4, 6.75], face: "n", island: true },
    { x: 12.4, z: 5.4, w: 1.6, d: 0.8, seat: [13.2, 6.75], face: "n", island: true },
  ])
  expect(office.sofas.map(({ x, z, face }) => [x, z, face])).toEqual([
    [1.1, 4.84, "e"], [1.1, 5.72, "e"], [1.1, 6.6, "e"], [1.1, 7.48, "e"], [1.1, 8.36, "e"], [3.1, 10.95, "n"], [4.3, 10.95, "n"],
  ])
  expect(office.zone).toEqual({ x: 4.2, z: 7.2, w: 4.4, d: 3.4 })
  expect(office.door).toEqual([0.6, 2.6])
})

test("each theme has a valid layout and a clear door", () => {
  expect(Object.keys(registry.themes).sort()).toEqual([...ids].sort())
  for (const id of ids) {
    const layout = registry.layouts[registry.themes[id].layout]
    expect(layout).toBeDefined()
    expect(layout.desks.length).toBeGreaterThan(0)
    const { room, zone, door } = layout
    expect([room.w, room.d, zone.x, zone.z, zone.w, zone.d, ...door].every(Number.isFinite)).toBe(true)
    expect(zone.x >= 0 && zone.z >= 0 && zone.w > 0 && zone.d > 0 && zone.x + zone.w <= room.w && zone.z + zone.d <= room.d).toBe(true)
    expect(door.length === 2 && door[0] >= 0 && door[0] <= room.w && door[1] >= 0 && door[1] <= room.d).toBe(true)
    const furniture = [...layout.desks.map(({ x, z, w, d }) => [x, z, w, d]), ...layout.blockers.slice(layout.desks.length, layout.desks.length + 2)]
    for (const [x, z, w, d] of furniture) {
      expect(door[0] >= x && door[0] <= x + w && door[1] >= z && door[1] <= z + d).toBe(false)
    }
  }
})
