"""Ponto de entrada rápido para abrir o coletor de biblioteca do Moovibe.

Basta abrir este arquivo no VS Code e clicar em "Run Python File" (▶).
"""

import os
import sys

# Garante que o diretório raiz do repositório esteja no sys.path,
# permitindo importar o pacote library/ corretamente.
RAIZ = os.path.dirname(os.path.abspath(__file__))
if RAIZ not in sys.path:
    sys.path.insert(0, RAIZ)

from library.gui import ColetorGUI  # noqa: E402


def main():
    app = ColetorGUI()
    app.mainloop()


if __name__ == "__main__":
    main()