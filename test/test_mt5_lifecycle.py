import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python"))
import mt5_lifecycle as lifecycle


class FakeInfo:
    def __init__(self, install, data):
        self.path = install
        self.data_path = data


class FakeMt5:
    def __init__(self, info, initialize_result=True):
        self.info = info
        self.initialize_result = initialize_result
        self.initialize_calls = []
        self.shutdown_calls = 0

    def initialize(self, **kwargs):
        self.initialize_calls.append(kwargs)
        return self.initialize_result

    def terminal_info(self):
        return self.info

    def shutdown(self):
        self.shutdown_calls += 1

    def last_error(self):
        return (-1, "fixture")


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.install = os.path.join(self.tmp.name, "terminal")
        self.data = os.path.join(self.tmp.name, "data")
        os.makedirs(self.install)
        os.makedirs(self.data)
        Path(self.install, "terminal64.exe").write_bytes(b"fixture")
        self.env = mock.patch.dict(os.environ, {
            "EASYDEAL_MT5_INSTALL_DIR": self.install,
            "EASYDEAL_MT5_DATA_DIR": self.data,
            "EASYDEAL_MT5_LAUNCH_MODE": "standard",
            "EASYDEAL_MT5_ALLOW_LAUNCH": "0",
        }, clear=False)
        self.env.start()
        Path(self.data, "origin.txt").write_text(self.install, encoding="utf-16")

    def tearDown(self):
        self.env.stop()
        self.tmp.cleanup()

    def test_attach_only_refuses_absent_target_without_calling_sdk(self):
        fake = FakeMt5(FakeInfo(self.install, self.data))
        with mock.patch.object(lifecycle, "exact_terminal_pids", return_value=[]):
            self.assertFalse(lifecycle.initialize_checked(
                fake, path=os.path.join(self.install, "terminal64.exe")))
        self.assertEqual(fake.initialize_calls, [])
        self.assertEqual(lifecycle.LAST_ERROR, "target_terminal_not_running")

    def test_matching_install_and_data_paths_attach(self):
        fake = FakeMt5(FakeInfo(self.install, self.data))
        with mock.patch.object(lifecycle, "exact_terminal_pids", return_value=[123]), \
             mock.patch.object(lifecycle, "terminal_process_age_sec", return_value=120):
            self.assertTrue(lifecycle.initialize_checked(
                fake, path=os.path.join(self.install, "terminal64.exe")))
        self.assertEqual(len(fake.initialize_calls), 1)
        self.assertFalse(fake.initialize_calls[0]["portable"])

    def test_per_instance_config_overrides_default_environment(self):
        second = os.path.join(self.tmp.name, "second-portable")
        os.makedirs(second)
        Path(second, "terminal64.exe").write_bytes(b"fixture")
        fake = FakeMt5(FakeInfo(second, second))

        with mock.patch.object(lifecycle, "exact_terminal_pids", return_value=[456]), \
             mock.patch.object(lifecycle, "terminal_process_age_sec", return_value=120):
            self.assertTrue(lifecycle.initialize_checked(
                fake,
                path=os.path.join(second, "terminal64.exe"),
                data_dir=second,
                launch_mode="portable",
            ))

        self.assertEqual(len(fake.initialize_calls), 1)
        self.assertTrue(fake.initialize_calls[0]["portable"])
        self.assertEqual(os.environ["EASYDEAL_MT5_INSTALL_DIR"], self.install)
        self.assertEqual(os.environ["EASYDEAL_MT5_DATA_DIR"], self.data)

    def test_data_path_mismatch_fails_closed_and_shutdowns_sdk(self):
        fake = FakeMt5(FakeInfo(self.install, os.path.join(self.tmp.name, "wrong")))
        with mock.patch.object(lifecycle, "exact_terminal_pids", return_value=[123]), \
             mock.patch.object(lifecycle, "terminal_process_age_sec", return_value=120):
            self.assertFalse(lifecycle.initialize_checked(
                fake, path=os.path.join(self.install, "terminal64.exe")))
        self.assertIn("data_path_mismatch", lifecycle.LAST_ERROR)
        self.assertEqual(fake.shutdown_calls, 1)

    def test_launch_flag_blocks_background_sdk_attach(self):
        fake = FakeMt5(FakeInfo(self.install, self.data))
        with mock.patch.object(lifecycle, "launch_in_progress", return_value=True):
            self.assertFalse(lifecycle.initialize_checked(
                fake, path=os.path.join(self.install, "terminal64.exe")))
        self.assertEqual(fake.initialize_calls, [])
        self.assertEqual(lifecycle.LAST_ERROR, "launch_in_progress")

    def test_unexpected_sdk_spawn_is_terminated(self):
        fake = FakeMt5(FakeInfo(self.install, self.data))
        with mock.patch.object(lifecycle, "exact_terminal_pids", return_value=[123]), \
             mock.patch.object(lifecycle, "all_terminal_pids", side_effect=[[123], [123, 456]]), \
             mock.patch.object(lifecycle, "terminal_process_age_sec", return_value=120), \
             mock.patch.object(lifecycle, "_terminate_unexpected_pids") as terminate:
            self.assertFalse(lifecycle.initialize_checked(
                fake, path=os.path.join(self.install, "terminal64.exe")))
        terminate.assert_called_once_with([456])
        self.assertIn("unexpected_sdk_spawn", lifecycle.LAST_ERROR)

    def test_failed_initialize_spawn_is_also_terminated(self):
        fake = FakeMt5(FakeInfo(self.install, self.data), initialize_result=False)
        with mock.patch.object(lifecycle, "exact_terminal_pids", return_value=[123]), \
             mock.patch.object(lifecycle, "all_terminal_pids", side_effect=[[123], [123, 789]]), \
             mock.patch.object(lifecycle, "terminal_process_age_sec", return_value=120), \
             mock.patch.object(lifecycle, "_terminate_unexpected_pids") as terminate:
            self.assertFalse(lifecycle.initialize_checked(
                fake, path=os.path.join(self.install, "terminal64.exe")))
        terminate.assert_called_once_with([789])
        self.assertIn("unexpected_sdk_spawn", lifecycle.LAST_ERROR)


if __name__ == "__main__":
    unittest.main()
