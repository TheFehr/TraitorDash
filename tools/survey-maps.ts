// What the map reader of RFC 11 leaves out, per map (RFC 18, section 2): water and lava faces, static props
// and where their models are, brush entities, and what the mesh comes to. For maps that are already plain
// addon archives (`.gma`) in one directory; an old LZMA item is opened first with `xz --format=lzma -dc`.
//   bun tools/survey-maps.ts <directory>
import { readdirSync } from 'node:fs'
import * as geo from '../backend/src/services/mapgeometry'
import * as gma from '../backend/src/maps/gma'
import * as bsp from '../backend/src/maps/bsp'
const dir = process.argv[2]
if (!dir) { console.error('usage: bun tools/survey-maps.ts <directory of .gma files>'); process.exit(1) }
const rows:any[]=[]
for (const file of readdirSync(dir).filter(f=>f.endsWith('.gma'))) {
  const p=dir+'/'+file; const { src, close } = await geo.fileSource(p)
  try {
    const ents=await gma.readGmaIndex(src)
    const addonMdl=new Set(ents.filter((e:any)=>/\.mdl$/i.test(e.name)).map((e:any)=>e.name.toLowerCase()))
    for (const {name,entry} of gma.mapEntries(ents)) {
      const f = await geo.fileSource(p, entry.offset, entry.size); const h=await bsp.readHeader(f.src)
      const rd=async(i:number)=>{const l=h.lumps[i]; if(!l.length||l.compressed) return null; const b=await f.src.read(l.offset,l.length); return new DataView(b.buffer,b.byteOffset,b.byteLength)}
      const s = await bsp.extractSurfaces(f.src)
      // water faces in world model
      const [tex,faces,models]=[await rd(6),await rd(7),await rd(14)]
      let water=0, sky=0; const ff=models!.getInt32(40,true), nf=models!.getInt32(44,true)
      for(let k=ff;k<ff+nf;k++){const ti=faces!.getInt16(k*56+10,true); const fl=tex!.getInt32(ti*72+64,true); if(fl&8) water++; if(fl&4) sky++}
      // static props
      let props=0, models_=0, pakModels=0, addonModels=0, stock=0; let names:string[]=[]
      const gl=h.lumps[35]; if(gl.length){const b=await f.src.read(gl.offset,gl.length); const dv=new DataView(b.buffer,b.byteOffset,b.byteLength); const n=dv.getInt32(0,true)
        for(let i=0;i<n;i++){const o=4+i*16; const id=String.fromCharCode(dv.getUint8(o+3),dv.getUint8(o+2),dv.getUint8(o+1),dv.getUint8(o)); const fo=dv.getInt32(o+8,true), fl2=dv.getInt32(o+12,true)
          if(id==='sprp'){const sb=await f.src.read(fo,fl2); const sv=new DataView(sb.buffer,sb.byteOffset,sb.byteLength); let q=0; const dn=sv.getInt32(q,true);q+=4
            for(let k=0;k<dn;k++){names.push(Buffer.from(sb.subarray(q,q+128)).toString('latin1').replace(/\0.*/,'').toLowerCase());q+=128}
            const ln=sv.getInt32(q,true);q+=4+ln*2; props=sv.getInt32(q,true); models_=dn}}}
      // pak models
      const pak=h.lumps[40]; const pakSet=new Set<string>()
      if(pak.length>22){const tailLen=Math.min(pak.length,70000); const tb=await f.src.read(pak.offset+pak.length-tailLen,tailLen); const tv=new DataView(tb.buffer,tb.byteOffset,tb.byteLength)
        let e=-1; for(let i=tb.length-22;i>=0;i--) if(tv.getUint32(i,true)===0x06054b50){e=i;break}
        if(e>=0){const cnt=tv.getUint16(e+10,true), csz=tv.getUint32(e+12,true), cof=tv.getUint32(e+16,true)
          const cb=await f.src.read(pak.offset+cof,csz); const cv=new DataView(cb.buffer,cb.byteOffset,cb.byteLength); let q=0
          for(let i=0;i<cnt&&q+46<=cb.length;i++){ if(cv.getUint32(q,true)!==0x02014b50)break; const nl=cv.getUint16(q+28,true), xl=cv.getUint16(q+30,true), cl=cv.getUint16(q+32,true); const nm=Buffer.from(cb.subarray(q+46,q+46+nl)).toString('latin1').toLowerCase(); pakSet.add(nm); q+=46+nl+xl+cl}}}
      for(const n of names){ if(pakSet.has(n)) pakModels++; else if(addonMdl.has(n)) addonModels++; else stock++ }
      const lt=h.lumps[0]; const t=Buffer.from(await f.src.read(lt.offset,lt.length)).toString('latin1')
      const cnt=(re:RegExp)=>[...t.matchAll(re)].length
      const entProps=cnt(/"classname" "prop_(dynamic|physics|physics_override|dynamic_override|physics_multiplayer)"/g), brushEnt=cnt(/"classname" "func_(brush|wall|illusionary|breakable|detail)"/g), tele=cnt(/"classname" "(trigger_teleport|func_door|func_tracktrain)"/g)
      const g = await geo.buildGeometry(f.src,name,h.fingerprint)
      rows.push({map:name, mb:(entry.size/1e6).toFixed(0), faces:s.stats.faces, disp:s.stats.displacements, otherModelFaces:s.stats.otherModelFaces, water, sky, props, uniqueModels:models_, inPak:pakModels, inAddon:addonModels, stock, entProps, brushEnt, tri:g.ok?g.info.triangles:'FAIL', levels:g.ok?g.info.levels:'-'})
      await f.close()
    }
  } catch(e:any){ rows.push({map:file, err:e.message}) }
  await close()
}
console.table(rows)
