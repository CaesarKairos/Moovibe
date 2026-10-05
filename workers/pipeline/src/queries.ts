export type DiscoveryQuery = { id:string; label:string; params:Record<string,string|number|boolean> };

const countries: Record<string,string> = {
  BR:'Brasil', AR:'Argentina', MX:'México', CL:'Chile', CO:'Colômbia', US:'Estados Unidos', CA:'Canadá',
  GB:'Reino Unido', FR:'França', DE:'Alemanha', IT:'Itália', ES:'Espanha', PT:'Portugal', IE:'Irlanda',
  SE:'Suécia', NO:'Noruega', DK:'Dinamarca', FI:'Finlândia', PL:'Polônia', GR:'Grécia', TR:'Turquia',
  JP:'Japão', KR:'Coreia do Sul', CN:'China', HK:'Hong Kong', IN:'Índia', TH:'Tailândia', PH:'Filipinas',
  ID:'Indonésia', IR:'Irã', IL:'Israel', LB:'Líbano', EG:'Egito', ZA:'África do Sul', NG:'Nigéria',
  SN:'Senegal', KE:'Quênia', MA:'Marrocos', AU:'Austrália', NZ:'Nova Zelândia', RU:'Rússia', UA:'Ucrânia'
};
const genres: Record<number,string> = { 28:'Ação',12:'Aventura',16:'Animação',35:'Comédia',80:'Crime',99:'Documentário',18:'Drama',10751:'Família',14:'Fantasia',36:'História',27:'Terror',10402:'Música',9648:'Mistério',10749:'Romance',878:'Ficção científica',53:'Thriller',10752:'Guerra',37:'Faroeste' };
const decades = [[1920,1929],[1930,1939],[1940,1949],[1950,1959],[1960,1969],[1970,1979],[1980,1989],[1990,1999],[2000,2009],[2010,2019],[2020,2029]];
const sorts = ['vote_average.desc','popularity.desc','release_date.asc','revenue.asc'];

// Recent-release lane. Windows are declared as STATIC day counts and resolved
// at runtime by discover(), so persisted definitions — and therefore the
// discovery seed version — never contain concrete dates and never churn daily.
// Params marked lane/lookback_days/upcoming_days are reserved metadata: they
// are stripped before the TMDb request.
const recent: DiscoveryQuery[] = [
  { id:'recent-global-120', label:'Lançamentos recentes 120 dias', params:{ lane:'recent', lookback_days:120, sort_by:'primary_release_date.desc' } },
  { id:'recent-global-30', label:'Muito recentes 30 dias', params:{ lane:'recent', lookback_days:30, sort_by:'primary_release_date.desc' } },
  { id:'upcoming-global-60', label:'Em breve 60 dias', params:{ lane:'recent', upcoming_days:60, sort_by:'primary_release_date.asc' } },
  { id:'recent-popular-30', label:'Populares recentes 30 dias', params:{ lane:'recent', lookback_days:30, sort_by:'popularity.desc' } },
  { id:'newest-global', label:'Mais novos (ordem de lançamento)', params:{ lane:'recent', sort_by:'primary_release_date.desc' } }
];

export function discoveryQueries(): DiscoveryQuery[] {
  const output: DiscoveryQuery[]=[];
  for (const [code,name] of Object.entries(countries)) {
    for (const [genre,label] of Object.entries(genres)) output.push({ id:`country-${code}-genre-${genre}`, label:`${name} + ${label}`, params:{ with_origin_country:code, with_genres:genre, sort_by:'vote_average.desc', 'vote_count.gte':10 } });
    for (const [from,to] of decades) output.push({ id:`country-${code}-${from}`, label:`${name} + anos ${from}`, params:{ with_origin_country:code, 'primary_release_date.gte':`${from}-01-01`, 'primary_release_date.lte':`${to}-12-31`, sort_by:'popularity.desc' } });
  }
  for (const [genre,label] of Object.entries(genres)) for (const [from,to] of decades) output.push({ id:`genre-${genre}-${from}`, label:`${label} + anos ${from}`, params:{ with_genres:genre, 'primary_release_date.gte':`${from}-01-01`, 'primary_release_date.lte':`${to}-12-31`, sort_by:'vote_average.desc', 'vote_count.gte':5 } });
  for (const sort of sorts) output.push({ id:`global-${sort}`, label:`Global ${sort}`, params:{ sort_by:sort, 'vote_count.gte': sort==='vote_average.desc'?20:0 } });
  output.push(...recent);
  return output;
}
