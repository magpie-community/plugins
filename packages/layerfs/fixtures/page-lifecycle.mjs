import { pathToFileURL } from "node:url"

let releaseTrajectory
if (process.env.LAYERFS_TEST_HOLD_TRAJECTORY === "1") {
  const { SimBackend } = await import(new URL("../layerfs.mjs", import.meta.url))
  const trajectory = SimBackend.prototype.trajectory
  const gate = new Promise((resolve) => { releaseTrajectory = resolve })
  SimBackend.prototype.trajectory = async function () {
    await gate
    return trajectory.call(this)
  }
}
const { LayerfsTools } = await import(pathToFileURL(process.env.LAYERFS_TEST_INDEX).href)
const plugin = await LayerfsTools({}, { pagePort: Number(process.env.LAYERFS_TEST_PORT) })
process.on("message", async ({ id, method }) => {
  try {
    let result
    if (method === "provision" || method === "concurrent") {
      const provision = () => plugin.tool.provision.execute({
        project: "fixture",
        source: process.env.LAYERFS_TEST_SOURCE,
      }, {})
      result = method === "concurrent"
        ? await Promise.all(Array.from({ length: 20 }, provision))
        : await provision()
    } else if (method === "releaseTrajectory") {
      releaseTrajectory()
    } else if (method === "backendFailure") {
      process.env.MAGPIE_LAYERFS_NATIVE = "1"
      try {
        await plugin.tool.status.execute()
        throw new Error("native backend should be refused")
      } catch (error) {
        if (!String(error.message).includes("sim-only")) throw error
        result = { rejected: true }
      } finally {
        process.env.MAGPIE_LAYERFS_NATIVE = ""
      }
    } else if (method === "status") {
      result = await plugin.tool.status.execute()
    } else {
      throw new Error(`unknown test method ${method}`)
    }
    process.send({ id, result })
  } catch (error) {
    process.send({ id, error: String(error?.stack || error) })
  }
})
process.send({ ready: true })
