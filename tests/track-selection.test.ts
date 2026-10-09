import {beforeEach,describe,expect,it,vi} from 'vitest';
import {clearTrackSelection,getTrackSelection,resetTrackField,setTrackSelection} from '../js/track-selection.js';

class Classes{items=new Set<string>();add(...x:string[]){x.forEach(v=>this.items.add(v));}remove(...x:string[]){x.forEach(v=>this.items.delete(v));}contains(x:string){return this.items.has(x);}}
class El{
  classList=new Classes();dataset:Record<string,string>={};children:any[]=[];attrs:Record<string,string>={};value='';textContent='';type='';className='';parentElement:any=null;focused=false;validity='';listeners:Record<string,Function>={};
  setAttribute(k:string,v:string){this.attrs[k]=v;}removeAttribute(k:string){delete this.attrs[k];}setCustomValidity(v:string){this.validity=v;}focus(){this.focused=true;}
  append(...xs:any[]){for(const x of xs){x.parentElement=this;this.children.push(x);}}insertAdjacentElement(_p:string,x:any){this.parentElement.append(x);}
  addEventListener(k:string,fn:Function){this.listeners[k]=fn;}click(){this.listeners.click?.();}remove(){this.parentElement.children=this.parentElement.children.filter((x:any)=>x!==this);}
  querySelector(s:string){return this.children.find(x=>'.'+x.className===s)||null;}closest(s:string){return s==='.autocomplete-group'?this.group:null;}group:any=null;
}
const track={title:'In Heaven',artist:'Japanese Breakfast',artists:['Japanese Breakfast'],album:'Psychopomp',album_id:'album-id',album_name:'Psychopomp',album_release_date:'2016-04-01',album_release_year:'2016',album_image_url:'cover.jpg',album_spotify_url:'https://open.spotify.com/album/album-id',spotify_url:'https://open.spotify.com/track/13f',spotify_uri:'spotify:track:13f',explicit:false,duration:218,provider:'spotify',provider_id:'13f',lrclib_id:42};
let input:El,parent:El,group:El;
beforeEach(()=>{parent=new El();group=new El();group.classList.add('autocomplete-group');input=new El();input.parentElement=parent;input.group=group;(globalThis as any).document={createElement:()=>new El()};});

describe('canonical track selection state',()=>{
  it('shows one accessible selected card and hides the editable input',()=>{const card=setTrackSelection(input as any,track,{changeLabel:'TROCAR',confirmedLabel:'Música confirmada'});expect(input.classList.contains('identity-confirmed')).toBe(true);expect(input.attrs['aria-hidden']).toBe('true');expect(card.children[0].children[0].textContent).toBe('In Heaven');expect(card.children[0].children[1].textContent).toContain('Japanese Breakfast · Psychopomp');expect(parent.children).toHaveLength(1);});
  it('reads canonical state from one source of truth',()=>{setTrackSelection(input as any,track);expect(getTrackSelection(input as any)).toMatchObject({title:'In Heaven',artist:'Japanese Breakfast',artists:['Japanese Breakfast'],album:'Psychopomp',album_image_url:'cover.jpg',spotify_url:'https://open.spotify.com/track/13f',provider_id:'13f'});});
  it('change removes every identity field, restores text and focus',()=>{setTrackSelection(input as any,track);parent.children[0].children[1].click();expect(getTrackSelection(input as any)).toBeNull();expect(input.value).toBe('In Heaven');expect(input.dataset).toEqual({});expect(input.focused).toBe(true);expect(parent.children).toHaveLength(0);});
  it('total reset clears value, card, classes, datasets and validity',()=>{setTrackSelection(input as any,track);input.validity='bad';resetTrackField(input as any);expect(input.value).toBe('');expect(input.dataset).toEqual({});expect(input.classList.contains('identity-confirmed')).toBe(false);expect(group.classList.contains('is-confirmed')).toBe(false);expect(input.validity).toBe('');expect(parent.children).toHaveLength(0);});
  it('does not leak state between three fields',()=>{const inputs=[input,new El(),new El()];for(const x of inputs.slice(1)){x.parentElement=new El();x.group=new El();}inputs.forEach((x,i)=>setTrackSelection(x as any,{...track,title:`Song ${i}`}));clearTrackSelection(inputs[1] as any,{preserveText:false});expect(getTrackSelection(inputs[0] as any)?.title).toBe('Song 0');expect(getTrackSelection(inputs[1] as any)).toBeNull();expect(getTrackSelection(inputs[2] as any)?.title).toBe('Song 2');});
});
