"""Ponto de entrada rápido para abrir o enriquecimento de estilo do Moovibe.

Basta abrir este arquivo no VS Code e clicar em "Run Python File" (▶).
"""

import os
import sys

# Garante que o diretório raiz do repositório esteja no sys.path,
# permitindo importar o pacote enrichment/ corretamente.
RAIZ = os.path.dirname(os.path.abspath(__file__))
if RAIZ not in sys.path:
    sys.path.insert(0, RAIZ)

from enrichment.gui import EnrichmentGUI  # noqa: E402


def main():
    app = EnrichmentGUI()
    app.mainloop()


if __name__ == "__main__":
    main()