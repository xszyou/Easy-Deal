import ast
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PYTHON_DIR = ROOT / "python"
ENTRYPOINTS = (
    "easydeal_mcp_server.py",
    "orderguard_server.py",
    "mt5_probe.py",
    "stats_collector.py",
)


class EmbeddedPythonImportTests(unittest.TestCase):
    def test_lifecycle_imports_are_preceded_by_script_dir_bootstrap(self):
        """Every standalone entrypoint must survive embeddable-Python isolation."""
        for name in ENTRYPOINTS:
            with self.subTest(entrypoint=name):
                source = (PYTHON_DIR / name).read_text(encoding="utf-8-sig")
                tree = ast.parse(source, filename=name)
                lifecycle_line = next(
                    node.lineno
                    for node in ast.walk(tree)
                    if isinstance(node, ast.Import)
                    and any(alias.name == "mt5_lifecycle" for alias in node.names)
                )
                self.assertIn("sys.path.insert(0, _SCRIPT_DIR)", source)
                bootstrap_line = (
                    source[: source.index("sys.path.insert(0, _SCRIPT_DIR)")].count("\n")
                    + 1
                )
                self.assertLess(bootstrap_line, lifecycle_line)

    def test_runtime_setup_template_includes_bundled_python_directory(self):
        setup = (ROOT / "scripts" / "setup-python-runtime.ps1").read_text(
            encoding="utf-8"
        )
        self.assertIn(r"..\python", setup)

    def test_local_embedded_runtime_can_import_shared_modules(self):
        """Exercise the exact isolated runtime layout used by electron-builder."""
        exe = ROOT / "python-runtime" / "python.exe"
        if not exe.is_file():
            self.skipTest("bundled Python runtime is not present in this checkout")

        result = subprocess.run(
            [
                str(exe),
                "-c",
                ("import mt5_lifecycle, mt5_profile, mt5_windows; "
                 "print(mt5_lifecycle.__file__); print(mt5_profile.__file__); "
                 "print(mt5_windows.__file__)"),
            ],
            cwd=ROOT,
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("mt5_lifecycle.py", result.stdout)
        self.assertIn("mt5_profile.py", result.stdout)
        self.assertIn("mt5_windows.py", result.stdout)


if __name__ == "__main__":
    unittest.main()
