# Simple Sphinx Fixture

This tiny workspace exists only for automated VS Code extension-host tests.

It provides one obvious Sphinx marker at `docs/conf.py` so the extension can activate in a real test host, one Python file that the self-test diagnostic can target, and one local `.sphinx-diagnostics/latest.json` mirror so the host lane can load a static fixture contract without running real Sphinx.