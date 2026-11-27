// Agents' logos, re-inked so they print alike on the receipt. usage:day sends
// each in its own colours; plain greyscale left the light ones (Antigravity's
// gradient A, MiniMax's wave) pale beside the black marks. Instead each logo is
// redrawn here once, the page and the PNG then show the same picture:
// - a mark (a shape on a clear ground, or a logo usage:day calls mono) is
//   filled with the ink, keeping only its outline's alpha;
// - a tile (a square or disc that fills its own box, like Codex's or
//   WorkBuddy's) has its tones stretched, its darkest to the ink and its
//   lightest to white, so every tile has the same black-to-white range and its
//   symbol stays legible instead of filling in as one block;
// - a tile on a light ground (Codex's: a coloured mark on a white square) drops
//   the ground for the paper and inks what is drawn on it, as a mark: its
//   mid-tone mark would otherwise stretch to grey.
(function (root) {
  const INK = [26, 26, 26]
  const SIZE = 48 // the 12px logo at 3x for the PNG, and a little to spare
  const lum = (p, i) => (0.2126 * p[i] + 0.7152 * p[i + 1] + 0.0722 * p[i + 2]) / 255

  // Re-inks RGBA pixels in place; answers what it took the logo for.
  function inkPixels(p, width, height, mono) {
    const tones = []
    let x0 = width
    let y0 = height
    let x1 = -1
    let y1 = -1
    for (let i = 0; i < p.length; i += 4) {
      if (p[i + 3] < 128) continue
      tones.push(lum(p, i))
      const x = (i / 4) % width
      const y = Math.floor(i / 4 / width)
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
    if (!tones.length) return 'empty'
    const box = (x1 - x0 + 1) * (y1 - y0 + 1)
    const tile = !mono && tones.length / box > 0.75 && box / (width * height) > 0.45
    if (!tile) {
      for (let i = 0; i < p.length; i += 4) {
        if (p[i + 3] === 0) continue
        p[i] = INK[0]
        p[i + 1] = INK[1]
        p[i + 2] = INK[2]
      }
      return 'mark'
    }
    // the ground: the tile's outer ring of solid pixels
    let ring = 0
    let ringSum = 0
    for (let i = 0; i < p.length; i += 4) {
      if (p[i + 3] < 128) continue
      const x = (i / 4) % width
      const y = Math.floor(i / 4 / width)
      if (x - x0 > 1 && x1 - x > 1 && y - y0 > 1 && y1 - y > 1) continue
      ring += 1
      ringSum += lum(p, i)
    }
    if (ring && ringSum / ring > 0.8) {
      for (let i = 0; i < p.length; i += 4) {
        if (p[i + 3] === 0) continue
        if (lum(p, i) > 0.85) {
          p[i + 3] = 0
          continue
        }
        p[i] = INK[0]
        p[i + 1] = INK[1]
        p[i + 2] = INK[2]
      }
      return 'ground'
    }
    // min and max of the solid pixels: a tile's symbol is often a small share of
    // it, so percentiles would take the symbol for noise and lose it
    let lo = 1
    let hi = 0
    for (const t of tones) {
      if (t < lo) lo = t
      if (t > hi) hi = t
    }
    const span = hi - lo
    for (let i = 0; i < p.length; i += 4) {
      if (p[i + 3] === 0) continue
      // a tile of one tone has nothing to stretch: it prints as ink
      const v = span < 0.05 ? 0 : Math.min(1, Math.max(0, (lum(p, i) - lo) / span))
      p[i] = Math.round(INK[0] + (255 - INK[0]) * v)
      p[i + 1] = Math.round(INK[1] + (255 - INK[1]) * v)
      p[i + 2] = Math.round(INK[2] + (255 - INK[2]) * v)
    }
    return 'tile'
  }

  // ---- in the page: each logo redrawn once, as a PNG data: address ----
  const done = new Map() // src → inked data: address, or null if it can't be
  const pending = new Map()

  function load(src) {
    return new Promise((resolve) => {
      const img = new Image()
      img.onload = () => resolve(img)
      img.onerror = () => resolve(null)
      img.src = src
    })
  }

  async function redraw(src, mono) {
    const img = await load(src)
    if (!img) return null
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = SIZE
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    const w = img.naturalWidth || SIZE
    const h = img.naturalHeight || SIZE
    const ratio = Math.min(SIZE / w, SIZE / h)
    ctx.drawImage(img, (SIZE - w * ratio) / 2, (SIZE - h * ratio) / 2, w * ratio, h * ratio)
    try {
      const data = ctx.getImageData(0, 0, SIZE, SIZE)
      inkPixels(data.data, SIZE, SIZE, mono)
      ctx.putImageData(data, 0, 0)
      return canvas.toDataURL('image/png')
    } catch {
      return null // an engine that won't read the canvas back: style.css greys it instead
    }
  }

  // The inked picture if it's ready; otherwise starts it and calls onReady once it is.
  function inked(src, mono, onReady) {
    if (done.has(src)) return done.get(src)
    if (!pending.has(src)) {
      pending.set(src, redraw(src, mono).then((url) => {
        done.set(src, url)
        pending.delete(src)
        if (onReady) onReady()
      }))
    }
    return null
  }

  const api = { INK, inkPixels, inked }
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.TRInk = api
})(globalThis)
