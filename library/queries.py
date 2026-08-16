"""Definição das consultas combináveis para coleta diversificada de filmes."""

# ==========================================
# PAÍSES / REGIÕES (códigos ISO 3166-1 alpha-2 usados pelo TMDB)
# ==========================================
PAISES = {
    # América do Sul
    "BR": "Brasil",
    "AR": "Argentina",
    "CL": "Chile",
    "CO": "Colômbia",
    "PE": "Peru",
    "UY": "Uruguai",
    "VE": "Venezuela",
    "EC": "Equador",
    "BO": "Bolívia",
    "PY": "Paraguai",
    # América do Norte / Central
    "US": "EUA",
    "CA": "Canadá",
    "MX": "México",
    "CU": "Cuba",
    # Europa
    "FR": "França",
    "IT": "Itália",
    "ES": "Espanha",
    "PT": "Portugal",
    "DE": "Alemanha",
    "GB": "Reino Unido",
    "IE": "Irlanda",
    "NL": "Holanda",
    "BE": "Bélgica",
    "SE": "Suécia",
    "NO": "Noruega",
    "DK": "Dinamarca",
    "FI": "Finlândia",
    "PL": "Polônia",
    "RO": "Romênia",
    "HU": "Hungria",
    "CZ": "República Tcheca",
    "GR": "Grécia",
    "TR": "Turquia",
    "RU": "Rússia",
    "UA": "Ucrânia",
    "AT": "Áustria",
    "CH": "Suíça",
    "RS": "Sérvia",
    "HR": "Croácia",
    # Ásia
    "JP": "Japão",
    "KR": "Coreia do Sul",
    "CN": "China",
    "HK": "Hong Kong",
    "TW": "Taiwan",
    "IN": "Índia",
    "TH": "Tailândia",
    "VN": "Vietnã",
    "ID": "Indonésia",
    "PH": "Filipinas",
    "MY": "Malásia",
    "IR": "Irã",
    "IL": "Israel",
    "SA": "Arábia Saudita",
    "PK": "Paquistão",
    "BD": "Bangladesh",
    "KZ": "Cazaquistão",
    # África
    "NG": "Nigéria",
    "ZA": "África do Sul",
    "EG": "Egito",
    "SN": "Senegal",
    "MA": "Marrocos",
    "KE": "Quênia",
    "GH": "Gana",
    "TN": "Tunísia",
    "DZ": "Argélia",
    "ET": "Etiópia",
    # Oceania
    "AU": "Austrália",
    "NZ": "Nova Zelândia",
}

# ==========================================
# GÊNEROS (IDs do TMDB)
# ==========================================
GENEROS = {
    28: "Ação",
    12: "Aventura",
    16: "Animação",
    35: "Comédia",
    80: "Crime",
    99: "Documentário",
    18: "Drama",
    10751: "Família",
    14: "Fantasia",
    36: "História",
    27: "Terror",
    10402: "Música",
    9648: "Mistério",
    10749: "Romance",
    878: "Ficção Científica",
    10770: "Cinema TV",
    53: "Thriller",
    10752: "Guerra",
    37: "Faroeste",
}

# ==========================================
# DÉCADAS (via primary_release_date.gte/.lte)
# ==========================================
DECADAS = [
    {"label": "1920", "gte": "1920-01-01", "lte": "1929-12-31"},
    {"label": "1930", "gte": "1930-01-01", "lte": "1939-12-31"},
    {"label": "1940", "gte": "1940-01-01", "lte": "1949-12-31"},
    {"label": "1950", "gte": "1950-01-01", "lte": "1959-12-31"},
    {"label": "1960", "gte": "1960-01-01", "lte": "1969-12-31"},
    {"label": "1970", "gte": "1970-01-01", "lte": "1979-12-31"},
    {"label": "1980", "gte": "1980-01-01", "lte": "1989-12-31"},
    {"label": "1990", "gte": "1990-01-01", "lte": "1999-12-31"},
    {"label": "2000", "gte": "2000-01-01", "lte": "2009-12-31"},
    {"label": "2010", "gte": "2010-01-01", "lte": "2019-12-31"},
    {"label": "2020", "gte": "2020-01-01", "lte": "2029-12-31"},
]

# ==========================================
# CRITÉRIOS DE ORDENAÇÃO / QUALIDADE
# ==========================================
ORDENACOES = [
    {"label": "popularidade", "sort_by": "popularity.desc"},
    {"label": "bem avaliados", "sort_by": "vote_average.desc", "vote_count_gte": 50},
    {"label": "recentes", "sort_by": "primary_release_date.desc"},
]

# ==========================================
# GERAÇÃO DE CONSULTAS
# ==========================================
def gerar_consultas():
    """
    Gera a lista de consultas combináveis (país + gênero, país + década, etc.).

    Cada consulta é um dict:
    {
        "query_id": str único (ex: "country=BR&genre=18&decade=2000"),
        "label": str amigável (ex: "Brasil + Drama + 2000"),
        "params": dict de parâmetros para o discover/movie do TMDB,
    }
    """
    consultas = []

    # 1. País + Gênero (combinação principal de diversidade cultural)
    for codigo_pais, nome_pais in PAISES.items():
        for id_genero, nome_genero in GENEROS.items():
            query_id = f"country={codigo_pais}&genre={id_genero}"
            label = f"{nome_pais} + {nome_genero}"
            consultas.append({
                "query_id": query_id,
                "label": label,
                "params": {
                    "with_origin_country": codigo_pais,
                    "with_genres": id_genero,
                    "sort_by": "popularity.desc",
                    "vote_count.gte": 10,  # evita ruído de filmes sem votos
                },
            })

    # 2. País + Década (cobertura temporal por país)
    for codigo_pais, nome_pais in PAISES.items():
        for decada in DECADAS:
            query_id = f"country={codigo_pais}&decade={decada['label']}"
            label = f"{nome_pais} + {decada['label']}"
            consultas.append({
                "query_id": query_id,
                "label": label,
                "params": {
                    "with_origin_country": codigo_pais,
                    "primary_release_date.gte": decada["gte"],
                    "primary_release_date.lte": decada["lte"],
                    "sort_by": "popularity.desc",
                    "vote_count.gte": 10,
                },
            })

    # 3. Gênero + Década (cobertura temporal por gênero, sem restrição de país)
    for id_genero, nome_genero in GENEROS.items():
        for decada in DECADAS:
            query_id = f"genre={id_genero}&decade={decada['label']}"
            label = f"{nome_genero} + {decada['label']}"
            consultas.append({
                "query_id": query_id,
                "label": label,
                "params": {
                    "with_genres": id_genero,
                    "primary_release_date.gte": decada["gte"],
                    "primary_release_date.lte": decada["lte"],
                    "sort_by": "popularity.desc",
                    "vote_count.gte": 10,
                },
            })

    # 4. País + Critério de qualidade (bem avaliados, recentes)
    for codigo_pais, nome_pais in PAISES.items():
        for ordenacao in ORDENACOES:
            query_id = f"country={codigo_pais}&sort={ordenacao['label']}"
            label = f"{nome_pais} + {ordenacao['label']}"
            params = {
                "with_origin_country": codigo_pais,
                "sort_by": ordenacao["sort_by"],
            }
            if ordenacao.get("vote_count_gte"):
                params["vote_count.gte"] = ordenacao["vote_count_gte"]
            consultas.append({
                "query_id": query_id,
                "label": label,
                "params": params,
            })

    return consultas