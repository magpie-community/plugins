// Each agent's mark: its own icon, the file magpie itself shows for it
// (page/icons, copied from magpie's assets with page/agents.js). An agent
// magpie has no icon for gets its initial on its colour. A classic script:
// it sets globalThis.AgentOfficeIcons.
(() => {
  // an element with the agent's mark, size px square
  function mark(brand, size = 16) {
    const s = document.createElement("span")
    s.className = "mark"
    s.style.width = s.style.height = size + "px"
    if (brand.icon) {
      const img = document.createElement("img")
      img.src = "icons/" + brand.icon
      img.alt = ""
      img.width = img.height = size
      img.decoding = "async"
      img.draggable = false
      // a file that doesn't load falls back to the initial
      img.onerror = () => { img.remove(); letter(s, brand, size) }
      s.append(img)
    } else letter(s, brand, size)
    return s
  }

  function letter(s, brand, size) {
    s.classList.add("letter")
    s.style.background = brand.color
    s.style.fontSize = Math.round(size * 0.62) + "px"
    s.textContent = String(brand.name || "?").trim().charAt(0).toUpperCase()
  }

  globalThis.AgentOfficeIcons = { mark }
})()
