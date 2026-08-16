"""Ponto de entrada do coletor de biblioteca do Moovibe.

Uso:
    python -m library.run
"""

from .gui import ColetorGUI


def main():
    """Abre a interface gráfica do coletor."""
    app = ColetorGUI()
    app.mainloop()


if __name__ == "__main__":
    main()