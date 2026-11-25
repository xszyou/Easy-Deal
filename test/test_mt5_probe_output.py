import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PROBE = ROOT / "python" / "mt5_probe.py"


class Mt5ProbeOutputTests(unittest.TestCase):
    def test_non_ascii_result_is_complete_utf8_json(self):
        """Electron decodes stdout as UTF-8 and kills the terminal on a parse failure."""
        with tempfile.TemporaryDirectory() as tmp:
            stubs = Path(tmp) / "stubs"
            install = Path(tmp) / "mt5"
            stubs.mkdir()
            install.mkdir()
            (stubs / "MetaTrader5.py").write_text("", encoding="utf-8")
            (install / "terminal64.exe").write_bytes(b"fixture")
            env = {
                **os.environ,
                "PYTHONPATH": str(stubs),
                # Stand-in for an ANSI code page that cannot encode the result.
                "PYTHONIOENCODING": "ascii",
                "EASYDEAL_MT5_INSTALL_DIR": str(install),
                "EASYDEAL_DATA_DIR": tmp,
            }
            env.pop("EASYDEAL_USER_DATA_DIR", None)
            result = subprocess.run(
                [sys.executable, str(PROBE)],
                env=env,
                capture_output=True,
                timeout=30,
                check=False,
            )
        self.assertEqual(result.returncode, 0, result.stderr.decode("utf-8", "replace"))
        out = json.loads(result.stdout.decode("utf-8"))
        self.assertEqual(out["skipped"], "not_running")
        self.assertIn("实例未启动", out["init_error"])


if __name__ == "__main__":
    unittest.main()
