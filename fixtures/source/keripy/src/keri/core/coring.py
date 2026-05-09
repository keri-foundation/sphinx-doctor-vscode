# fixtures/source/keripy/src/keri/core/coring.py

"""Synthetic coring fixture for Sphinx Doctor source mapping tests."""


class Number:
    """
    Number docstring line 1.
    Number docstring line 2.
    Number docstring line 3.
    Number docstring line 4.
    Number docstring line 5.
    Number docstring line 6.
    """

    def __init__(self) -> None:
        """
        Constructor docstring line 1.
        Constructor docstring line 2.
        """
        self.value = 0

    @property
    def label(self) -> str:
        """Property docstring line 1."""
        return "number"


class Tholder:
    """
    Tholder docstring line 1.
    Tholder docstring line 2.
    Tholder docstring line 3.
    """

    def __init__(self) -> None:
        self.kind = "demo"


async def async_helper() -> str:
    """Async helper docstring line 1."""
    return "ok"