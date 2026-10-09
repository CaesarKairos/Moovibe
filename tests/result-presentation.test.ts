import {describe,expect,it} from 'vitest';
import {POSTER_CROP_POSITIONS,buildMediaSlots} from '../js/result-presentation.js';

describe('editorial result media',()=>{
  const poster='/poster.jpg';
  it.each([[3,3,0],[2,2,1],[1,1,2],[0,0,3]])('%i stills produce %i real frames and %i poster crops',(count,real,crops)=>{const slots=buildMediaSlots(['/a','/b','/c'].slice(0,count),poster);expect(slots).toHaveLength(3);expect(slots.filter(x=>x.source==='still')).toHaveLength(real);expect(slots.filter(x=>x.source==='poster-crop')).toHaveLength(crops);expect(new Set(slots.filter(x=>x.source==='still').map(x=>x.src)).size).toBe(real);});
  it('uses stable, distinct poster positions without random values',()=>{expect(POSTER_CROP_POSITIONS).toEqual(['44% 18%','50% 50%','56% 82%']);expect(buildMediaSlots([],poster).map(x=>x.position)).toEqual(POSTER_CROP_POSITIONS);expect(buildMediaSlots([],poster)).toEqual(buildMediaSlots([],poster));});
});
