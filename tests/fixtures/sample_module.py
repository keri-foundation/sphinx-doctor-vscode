"""Sample module for TextPythonDocstringSourceMapper safe-mapping tests."""


class Calculator:
    """A simple calculator class.

    Supports basic arithmetic operations.
    """

    def add(self, a: int, b: int) -> int:
        """Add two integers.

        Returns the sum of a and b.
        """
        return a + b

    def multiply(self, a: int, b: int) -> int:
        """Multiply two integers.

        Returns the product of a and b.

        This docstring has multiple lines to test
        line-offset mapping.
        """
        return a * b
