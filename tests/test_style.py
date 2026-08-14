#!/usr/bin/env python3
"""Teste não-interativo para a música 'Style' - Taylor Swift"""
import sys
import os

# Adiciona o diretório atual ao path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app import (
    buscar_letra_musica,
    buscar_contexto_musica,
    obter_recomendacao_ia
)

def test_style():
    nome_musica = "Style"
    artista = "Taylor Swift"

    print(f"\n{'='*60}")
    print(f"TESTE: {nome_musica} - {artista}")
    print(f"{'='*60}\n")

    # 1. Testar letra
    print("[TESTE 1] Buscando letra...")
    letra = buscar_letra_musica(nome_musica, artista)
    if letra:
        print(f"✓ Letra encontrada ({len(letra)} chars)")
        print(f"  Preview: {letra[:100]}...")
    else:
        print("✗ Letra não encontrada")

    # 2. Testar contexto
    print("\n[TESTE 2] Buscando contexto...")
    contexto = buscar_contexto_musica(nome_musica, artista)
    if contexto and "Contexto não encontrado" not in contexto:
        print(f"✓ Contexto encontrado ({len(contexto)} chars)")
        print(f"  Preview: {contexto[:100]}...")
    else:
        print("✗ Contexto não encontrado (usando fallback)")

    # 3. Testar recomendação IA
    print("\n[TESTE 3] Obtendo recomendação IA...")
    print("  (Isso pode demorar alguns segundos...)")
    recomendacao = obter_recomendacao_ia(nome_musica, artista, letra, contexto)

    if recomendacao:
        print("\n✓ RECOMENDAÇÃO OBTIDA COM SUCESSO!")
        print(f"  Filme: {recomendacao.get('filme')}")
        print(f"  Ano: {recomendacao.get('ano')}")
        print(f"\n  Justificativa (primeiras 200 chars):")
        justificativa = recomendacao.get('justificativa', '')
        print(f"  {justificativa[:200]}...")
        print(f"\n{'='*60}")
        print("TESTE CONCLUÍDO COM SUCESSO!")
        print(f"{'='*60}")
        return 0
    else:
        print("\n✗ FALHA AO OBTER RECOMENDAÇÃO")
        print(f"{'='*60}")
        return 1

if __name__ == "__main__":
    exit_code = test_style()
    sys.exit(exit_code)