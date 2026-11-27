// Paints the on-screen receipt onto a canvas at 3× and hands back a PNG Blob.
// Ported from dsh-token-receipt's exportReceiptPng: it walks the paper's DOM and
// draws each piece, with no foreignObject, so WebKit's sandboxed frame allows it.
// Saving and copying go through magpie.image (the frame can't download).
(function (root) {
  const EXPORT_SCALE = 3

  function paperClipPath(ctx, width, height) {
    ctx.beginPath()
    ctx.moveTo(0, 0)
    ctx.lineTo(width, 0)
    ctx.lineTo(width, height - 4)
    const count = 40
    for (let index = 0; index < count * 2; index += 1) {
      const x = width - ((index + 1) * width) / (count * 2)
      const y = index % 2 === 0 ? height : height - 4
      ctx.lineTo(x, y)
    }
    ctx.lineTo(0, height - 4)
    ctx.closePath()
  }

  function loadImage(source) {
    return new Promise((resolve, reject) => {
      const image = new Image()
      image.onload = () => resolve(image)
      image.onerror = () => reject(new Error('Image load failed'))
      image.src = source
    })
  }

  // the paper's grain, as style.css gives it
  function textureUrl(style) {
    const match = /url\(["']?(data:[^"')]+)["']?\)/.exec(style.backgroundImage || '')
    return match ? match[1] : null
  }

  function collectWrappedLines(textNode, lineHeight) {
    const range = document.createRange()
    const lines = []
    const raw = textNode.nodeValue || ''
    for (let offset = 0; offset < raw.length; ) {
      const codePoint = raw.codePointAt(offset)
      const step = codePoint > 0xffff ? 2 : 1
      range.setStart(textNode, offset)
      range.setEnd(textNode, offset + step)
      const charRect = range.getBoundingClientRect()
      const glyph = raw.slice(offset, offset + step)
      offset += step
      if (charRect.width === 0) continue
      const charMid = (charRect.top + charRect.bottom) / 2
      let line = lines[lines.length - 1]
      if (!line || Math.abs(line.mid - charMid) > lineHeight * 0.5) {
        line = { text: '', top: charRect.top, bottom: charRect.bottom, mid: charMid }
        lines.push(line)
      } else {
        line.top = Math.min(line.top, charRect.top)
        line.bottom = Math.max(line.bottom, charRect.bottom)
        line.mid = (line.top + line.bottom) / 2
      }
      line.text += glyph
    }
    return lines
  }

  // The agents' logos, as style.css shows them: grayscale(1) contrast(1.6) at
  // .9 opacity, a mono mark as it is. Per pixel on a scratch canvas, so the PNG
  // doesn't depend on ctx.filter (newer engines only).
  function grayLogo(img, size, scale, mono) {
    const px = Math.max(1, Math.round(size * scale))
    const off = document.createElement('canvas')
    off.width = off.height = px
    const o = off.getContext('2d')
    if (!o) return null
    const ratio = Math.min(px / (img.naturalWidth || px), px / (img.naturalHeight || px))
    const w = (img.naturalWidth || px) * ratio
    const h = (img.naturalHeight || px) * ratio
    o.drawImage(img, (px - w) / 2, (px - h) / 2, w, h)
    if (mono) return off
    try {
      const data = o.getImageData(0, 0, px, px)
      const p = data.data
      for (let i = 0; i < p.length; i += 4) {
        const lum = (0.2126 * p[i] + 0.7152 * p[i + 1] + 0.0722 * p[i + 2]) / 255
        const v = Math.round(Math.min(1, Math.max(0, (lum - 0.5) * 1.6 + 0.5)) * 255)
        p[i] = p[i + 1] = p[i + 2] = v
      }
      o.putImageData(data, 0, 0)
    } catch {
      /* a canvas the engine won't read back keeps the logo's own colours */
    }
    return off
  }

  function paintAgents(ctx, paperEl, originX, originY) {
    for (const el of paperEl.querySelectorAll('.tr-agent')) {
      const rect = el.getBoundingClientRect()
      if (rect.width === 0) continue
      const img = el.querySelector('img')
      const style = getComputedStyle(img || el)
      const alpha = parseFloat(style.opacity)
      ctx.save()
      ctx.globalAlpha = Number.isFinite(alpha) ? alpha : 1
      if (img && img.complete && img.naturalWidth > 0) {
        // an inked logo (page/ink.js) is drawn as it is; only the fallback is greyed here
        const asIs = img.hasAttribute('data-inked') || img.hasAttribute('data-mono')
        const logo = grayLogo(img, rect.width, EXPORT_SCALE, asIs)
        if (logo) ctx.drawImage(logo, rect.left - originX, rect.top - originY, rect.width, rect.height)
      } else if (!img) {
        // an initial's ring; its letter is text, drawn with the rest
        ctx.strokeStyle = style.color
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.arc(rect.left - originX + rect.width / 2, rect.top - originY + rect.height / 2, rect.width / 2 - 0.5, 0, Math.PI * 2)
        ctx.stroke()
      }
      ctx.restore()
    }
  }

  function paint(paperEl, logo, texture) {
    const paperRect = paperEl.getBoundingClientRect()
    const originX = paperRect.left
    const originY = paperRect.top
    const width = Math.max(1, Math.round(paperRect.width))
    const height = Math.max(1, Math.round(paperRect.height))
    const canvas = document.createElement('canvas')
    canvas.width = width * EXPORT_SCALE
    canvas.height = height * EXPORT_SCALE
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.scale(EXPORT_SCALE, EXPORT_SCALE)

    ctx.save()
    paperClipPath(ctx, width, height)
    ctx.clip()
    const paperStyle = getComputedStyle(paperEl)
    ctx.fillStyle = paperStyle.backgroundColor || '#fcfcfc'
    ctx.fillRect(0, 0, width, height)
    if (texture) {
      ctx.save()
      ctx.globalCompositeOperation = 'soft-light'
      ctx.drawImage(texture, 0, 0, width, height)
      ctx.restore()
    }
    ctx.restore()

    const logoEl = paperEl.querySelector('.tr-paper-logo')
    if (logoEl && logo && typeof Path2D === 'function') {
      const logoRect = logoEl.getBoundingClientRect()
      if (logoRect.width > 0 && logoRect.height > 0) {
        const logoStyle = getComputedStyle(logoEl)
        const alpha = parseFloat(logoStyle.opacity)
        ctx.save()
        ctx.translate(logoRect.left - originX, logoRect.top - originY)
        ctx.scale(logoRect.width / logo.viewBox, logoRect.height / logo.viewBox)
        ctx.fillStyle = logoStyle.color
        ctx.globalAlpha = Number.isFinite(alpha) ? alpha : 1
        ctx.fill(new Path2D(logo.d), logo.fillRule || 'nonzero')
        ctx.restore()
      }
    }

    for (const rule of paperEl.querySelectorAll('.tr-rule')) {
      const ruleRect = rule.getBoundingClientRect()
      const ruleStyle = getComputedStyle(rule)
      ctx.save()
      ctx.strokeStyle = ruleStyle.borderTopColor
      ctx.lineWidth = Math.max(1, parseFloat(ruleStyle.borderTopWidth) || 1)
      ctx.setLineDash([3, 3])
      ctx.beginPath()
      ctx.moveTo(ruleRect.left - originX, ruleRect.top - originY + 0.5)
      ctx.lineTo(ruleRect.right - originX, ruleRect.top - originY + 0.5)
      ctx.stroke()
      ctx.restore()
    }

    const barcode = paperEl.querySelector('.tr-barcode')
    if (barcode) {
      const barcodeRect = barcode.getBoundingClientRect()
      const barcodeStyle = getComputedStyle(barcode)
      const alpha = parseFloat(barcodeStyle.opacity)
      ctx.save()
      ctx.fillStyle = barcodeStyle.color
      ctx.globalAlpha = Number.isFinite(alpha) ? alpha : 1
      const pattern = [1, 2, 2, 2, 1, 3]
      const rightEdge = barcodeRect.right - originX
      let x = barcodeRect.left - originX
      let index = 0
      while (x < rightEdge) {
        const segment = pattern[index % pattern.length]
        if (index % 2 === 0) ctx.fillRect(x, barcodeRect.top - originY, Math.min(segment, rightEdge - x), barcodeRect.height)
        x += segment
        index += 1
      }
      ctx.restore()
    }

    paintAgents(ctx, paperEl, originX, originY)

    const walker = document.createTreeWalker(paperEl, NodeFilter.SHOW_TEXT)
    let node = walker.nextNode()
    while (node) {
      const textNode = node
      const text = (textNode.nodeValue || '').replace(/\s+/g, ' ').trim()
      const element = textNode.parentElement
      node = walker.nextNode()
      if (!text || !element || element.closest('svg') || element.closest('style')) continue
      const style = getComputedStyle(element)
      const textAlpha = parseFloat(style.opacity)
      if (style.display === 'none' || textAlpha === 0) continue
      const bounds = element.getBoundingClientRect()
      if (bounds.width === 0 || bounds.height === 0) continue
      const value = style.textTransform === 'uppercase' ? text.toUpperCase() : text
      const align = style.textAlign === 'center' ? 'center' : style.textAlign === 'right' ? 'right' : 'left'
      const x = align === 'center' ? bounds.left - originX + bounds.width / 2 : align === 'right' ? bounds.right - originX : bounds.left - originX
      const y = bounds.top - originY + bounds.height / 2
      ctx.save()
      ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
      ctx.fillStyle = style.color
      ctx.globalAlpha = Number.isFinite(textAlpha) ? textAlpha : 1
      ctx.textAlign = align
      ctx.textBaseline = 'middle'
      if ('letterSpacing' in ctx) ctx.letterSpacing = style.letterSpacing === 'normal' ? '0px' : style.letterSpacing
      let printable = value
      if (style.textOverflow === 'ellipsis' && ctx.measureText(printable).width > bounds.width) {
        while (printable.length > 1 && ctx.measureText(`${printable}…`).width > bounds.width) printable = printable.slice(0, -1)
        printable = `${printable}…`
      }
      const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2
      if (style.whiteSpace !== 'nowrap' && bounds.height > lineHeight * 1.5) {
        // group wrapped runs by vertical midpoint so mixed CJK + ASCII fonts stay on one line
        for (const line of collectWrappedLines(textNode, lineHeight)) {
          const rawLine = line.text.replace(/\s+/g, ' ').trim()
          if (!rawLine) continue
          ctx.fillText(style.textTransform === 'uppercase' ? rawLine.toUpperCase() : rawLine, x, (line.top + line.bottom) / 2 - originY)
        }
      } else {
        ctx.fillText(printable, x, y)
      }
      ctx.restore()
    }
    return canvas
  }

  function toBlob(canvas) {
    return new Promise((resolve, reject) => {
      try {
        canvas.toBlob((value) => (value ? resolve(value) : reject(new Error('empty'))), 'image/png')
      } catch (error) {
        reject(error)
      }
    })
  }

  async function exportReceiptPng(paperEl, { copy, logo }) {
    if (!paperEl) throw new Error(copy.exportNotReady)
    const currency = paperEl.dataset.currency
    const language = paperEl.lang
    const assertUnchanged = () => {
      if (!paperEl.isConnected) throw new Error(copy.exportClosed)
      if (paperEl.dataset.currency !== currency || paperEl.lang !== language) throw new Error(copy.exportChanged)
    }
    await document.fonts.ready
    assertUnchanged()
    let texture = null
    const source = textureUrl(getComputedStyle(paperEl))
    if (source) {
      try {
        texture = await loadImage(source)
      } catch {
        /* the grain is decorative */
      }
    }
    assertUnchanged()
    let canvas = paint(paperEl, logo, texture)
    if (!canvas) throw new Error(copy.exportFailed)
    let blob
    try {
      blob = await toBlob(canvas)
    } catch {
      // an SVG grain may taint the canvas in some engines: draw it again without
      canvas = paint(paperEl, logo, null)
      blob = canvas ? await toBlob(canvas).catch(() => null) : null
      if (!blob) throw new Error(copy.exportFailed)
    }
    assertUnchanged()
    return blob
  }

  root.TRExport = { exportReceiptPng }
})(globalThis)
