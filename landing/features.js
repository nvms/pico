const list = document.querySelector('.features')
const hover = matchMedia('(hover: hover)')
let active = null
let frame = 0
let leaveTimer

function position(item) {
  const parent = list.getBoundingClientRect()
  const row = item.getBoundingClientRect()
  list.style.setProperty('--pill-x', `${row.left - parent.left - 10}px`)
  list.style.setProperty('--pill-y', `${row.top - parent.top + 2}px`)
  list.style.setProperty('--pill-width', `${row.width + 20}px`)
  list.style.setProperty('--pill-height', `${row.height - 10}px`)
}

function enter(item) {
  if (!hover.matches) return
  clearTimeout(leaveTimer)
  cancelAnimationFrame(frame)
  active = item
  if (!list.classList.contains('features-tracking')) {
    list.classList.add('features-positioning')
    position(item)
    list.getBoundingClientRect()
    list.classList.remove('features-positioning')
    frame = requestAnimationFrame(() => list.classList.add('features-tracking'))
  } else {
    position(item)
  }
}

for (const item of list.children) {
  item.addEventListener('pointerenter', () => enter(item))
}
list.addEventListener('pointerleave', () => {
  cancelAnimationFrame(frame)
  leaveTimer = setTimeout(() => {
    active = null
    list.classList.remove('features-tracking')
  }, 100)
})
new ResizeObserver(() => {
  if (active) position(active)
}).observe(list)
