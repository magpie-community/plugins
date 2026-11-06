// 浏览器替身：startBrowserHarvest / browserRefreshHarvest 的可控 fake。
// ticket 就是 fake 收割出的 authorization Cookie 值（与真实流程一致：整段
// "Basic <base64>" 票，fake.mjs 的 TICKET_A/TICKET_B）。closed/released 记录
// 收尾是否发生（取消收尾的断言用）。
export function fakeBrowserModule({ ticket } = {}) {
  const state = {
    harvests: 0,
    refreshes: 0,
    openedProfiles: [],
    refreshProfiles: [],
    closed: 0,
    released: 0,
    aborted: false,
    // 测试用例按需覆盖：harvestError 让收割失败；holdHarvest 让 promise 挂起，
    // 再用 deliverHarvest() 放行（取消收尾的时序测试用）。
    harvestError: undefined,
    refreshCookie: ticket,
  }
  let deliverHarvestNow = undefined
  const module = {
    startBrowserHarvest({ profilePath } = {}) {
      const session = { promise: undefined, abort: async () => {} }
      state.harvests++
      const profile = profilePath ?? 'fake-profile-signin'
      state.openedProfiles.push(profile)
      session.promise = new Promise((resolve, reject) => {
        session.abort = async () => {
          if (state.aborted) return
          state.aborted = true
          state.closed++
          state.released++
          reject(new Error('登录已取消'))
        }
        const deliver = () => {
          if (state.harvestError) {
            state.closed++
            state.released++
            reject(state.harvestError)
            return
          }
          resolve({
            cookie: { value: ticket, expiresMs: 0 },
            profilePath: profile,
            release: async () => { state.released++ },
            close: async () => { state.closed++ },
          })
        }
        if (state.harvestError) queueMicrotask(deliver)
        else deliverHarvestNow = deliver
      })
      session.promise.catch(() => {})
      return session
    },
    deliverHarvest() {
      deliverHarvestNow?.()
      deliverHarvestNow = undefined
    },
    async browserRefreshHarvest({ profilePath } = {}) {
      state.refreshes++
      state.refreshProfiles.push(profilePath)
      if (state.harvestError) throw state.harvestError
      if (!state.refreshCookie) throw new Error('profile 里没有移动云登录态（请先完成浏览器登录）')
      return { cookie: { value: state.refreshCookie, expiresMs: 0 }, profilePath: profilePath ?? 'fake-profile-legacy' }
    },
  }
  return { module, state }
}
