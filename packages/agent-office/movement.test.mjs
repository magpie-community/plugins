import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
const scope = {}
new Function('globalThis', readFileSync(new URL('./page/scene.js', import.meta.url), 'utf8'))(scope)
const { Scene, SOFA, SOFA_APPROACH, DESKS, NAV, idlePose } = scope.AgentOfficeScene
const floorSafe = (from, path) => {
  let a = from
  for (const b of path) {
    if (b[2] === undefined) {
      const n = Math.max(1, Math.ceil(Math.hypot(b[0]-a[0], b[1]-a[1])*40))
      for (let i=0;i<=n;i++) expect(NAV.freeAt(a[0]+(b[0]-a[0])*i/n,a[1]+(b[1]-a[1])*i/n)).toBe(true)
    } else {
      const slot = b[2], seat = SOFA[slot], approach = SOFA_APPROACH[slot]
      const axis = slot < 5 ? 1 : 0
      expect(a[axis]).toBeCloseTo(seat[axis])
      expect(b[axis]).toBeCloseTo(seat[axis])
      expect([seat[1-axis],approach[1-axis]]).toContain(b[1-axis])
    }
    a = b
  }
}
test('all sofa transfers use a separate aisle exit and front approach', () => {
  for (let i=0;i<SOFA.length;i++) for(let j=0;j<SOFA.length;j++) {
    if(i===j) continue
    const p=NAV.path(SOFA[i],SOFA[j])
    expect(p.length).toBeGreaterThan(2)
    expect(p[0]).toEqual([...SOFA_APPROACH[i],i])
    expect(p.at(-2)).toEqual(SOFA_APPROACH[j])
    expect(p.at(-1)).toEqual([...SOFA[j],j])
    floorSafe(SOFA[i],p)
  }
  for(const seat of SOFA) for(const desk of DESKS) {
    const p=NAV.path(seat,desk.seat.slice(0,2))
    expect(p.length).toBeGreaterThan(0)
    floorSafe(seat,p)
  }
})
test('sofa cushions and rear gaps cannot be used as a corridor', () => {
  for(const [x,y] of SOFA) expect(NAV.freeAt(x,y)).toBe(false)
  expect(NAV.freeAt(0.45,6)).toBe(false)
  expect(NAV.freeAt(3.6,11.8)).toBe(false)
  expect(NAV.path([6,4],[7,6])).toEqual([]) // solid hologram table, no direct fallback
})
test('retargeting midway through boarding exits from the same front', () => {
  for(let i=0;i<7;i++) {
    const a=SOFA[i].map((v,k)=>(v+SOFA_APPROACH[i][k])/2)
    const p=NAV.path(a,[5,3],i)
    expect(p[0]).toEqual([...SOFA_APPROACH[i],i])
    floorSafe(a,p)
    const s=Object.create(Scene.prototype)
    expect(s.sofaGroup({walking:true,kind:'seat',transit:i})).toBe(i>=5?1:0)
  }
})
test('idle gestures vary by worker, pause during walking and respect reduced motion', () => {
  const w={a:{seed:5,status:'done'},walking:false}
  const kinds=new Set()
  for(let t=0;t<100;t+=0.25) {
    const p=idlePose(w,t)
    kinds.add(p.kind)
    expect(p.amount).toBeGreaterThanOrEqual(0)
    expect(p.amount).toBeLessThanOrEqual(1)
  }
  expect([...kinds].sort()).toEqual(['doze','look','rest','stretch','swing'])
  expect(idlePose({...w,walking:true},20).kind).toBe('rest')
  expect(idlePose(w,20,true).kind).toBe('rest')
  expect(idlePose({...w,a:{seed:5,status:'executing'}},20).kind).toBe('rest')
  expect(idlePose(w,20)).not.toEqual(idlePose({...w,a:{seed:6,status:'done'}},20))
})

for (const dim of ['2d','3d']) test(`${dim}: walk to every sofa, remain seated, then leave via aisle`, () => {
  for (let slot=0;slot<7;slot++) {
    const s=Object.create(Scene.prototype)
    Object.assign(s,{dim,workers:new Map(),first:false,t:0})
    const agent={key:'person',seed:slot,status:'done',brand:{color:'#4466ff'}}
    s.setAgents([agent])
    const w=s.workers.get('person')
    const advance=()=>{
      for(let n=0;n<1800;n++) {
        s.step(1/60)
        if(w.walking && w.transit===null) expect(NAV.freeAt(w.x,w.y)).toBe(true)
      }
      expect(w.walking).toBe(false)
      expect(w.x).toBeCloseTo(w.tx)
      expect(w.y).toBeCloseTo(w.ty)
    }
    advance()
    const position=[w.x,w.y]
    s.setAgents([agent]);s.step(1/60)
    expect([w.x,w.y]).toEqual(position)
    expect(NAV.path(position,position)).toEqual([])
    s.setAgents([{...agent,status:'thinking'}])
    advance()
  }
})
