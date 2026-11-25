import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "python" / "easydeal_codex_cli_bridge.py"


def load_bridge(workspace: str):
    env = {
        "EASYDEAL_CODEX_BRIDGE_TOKEN": "test-token-that-is-definitely-long-enough-1234",
        "EASYDEAL_CODEX_WORKSPACE": workspace,
    }
    with mock.patch.dict(os.environ, env, clear=False):
        spec = importlib.util.spec_from_file_location("easydeal_codex_cli_bridge_test", SCRIPT)
        module = importlib.util.module_from_spec(spec)
        assert spec and spec.loader
        spec.loader.exec_module(module)
        return module


class CodexCliBridgeProtocolTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.bridge = load_bridge(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_extracts_codex_jsonl_agent_message(self):
        stdout = "\n".join([
            json.dumps({"type": "thread.started", "thread_id": "x"}),
            json.dumps({"type": "item.completed", "item": {
                "type": "agent_message", "text": "pong"
            }}),
        ])
        self.assertEqual(self.bridge.extract_codex_text(stdout), "pong")

    def test_empty_codex_output_is_not_disguised_as_success(self):
        completed = self.bridge.subprocess.CompletedProcess(
            ["codex"], 0,
            (json.dumps({"type": "thread.started", "thread_id": "x"}) + "\n").encode(),
            b"",
        )
        with mock.patch.object(self.bridge, "run_process", return_value=completed):
            with self.assertRaisesRegex(RuntimeError, "no final agent message"):
                self.bridge.run_codex("hello")

    def test_only_declared_tools_can_be_emitted(self):
        tools = {"get_status": {"name": "get_status", "input_schema": {"type": "object"}}}
        good = json.dumps({
            "easydeal_bridge_tool_calls": [{"name": "get_status", "input": {}}]
        })
        bad = json.dumps({
            "easydeal_bridge_tool_calls": [{"name": "delete_everything", "input": {}}]
        })
        self.assertEqual(self.bridge.extract_external_tool_calls(good, tools)[0]["name"], "get_status")
        self.assertEqual(self.bridge.extract_external_tool_calls(bad, tools), [])

    def test_qualified_remote_tools_are_treated_as_ready(self):
        payload = {
            "tools": [
                {"name": "WaitForMcpServers", "input_schema": {"type": "object"}},
                {"name": "mcp__remote_EZDL_AAAA_1111__get_status",
                 "input_schema": {"type": "object"}},
            ],
            "messages": [{"role": "user", "content": "检查远程 MT5"}],
        }
        tools = self.bridge.declared_tools(payload)
        self.assertFalse(self.bridge.should_wait_for_remote_mcp(payload, tools))
        self.assertIn(
            "prefer the matching declared mcp__remote tool",
            self.bridge.build_prompt(payload),
        )

    def test_prompt_refuses_silent_context_truncation(self):
        old_limit = self.bridge.MAX_PROMPT_CHARS
        self.bridge.MAX_PROMPT_CHARS = 20
        try:
            with self.assertRaisesRegex(ValueError, "refused to silently truncate"):
                self.bridge.build_prompt({"messages": [{"role": "user", "content": "x" * 100}]})
        finally:
            self.bridge.MAX_PROMPT_CHARS = old_limit

    def test_bridge_limit_never_exceeds_codex_cli_hard_limit(self):
        self.assertLessEqual(
            self.bridge.MAX_PROMPT_CHARS,
            self.bridge.CODEX_CLI_MAX_INPUT_CHARS,
        )

    def test_prompt_size_is_reported_as_an_input_token_estimate(self):
        self.assertEqual(self.bridge.estimate_input_tokens("x" * 400), 100)
        self.assertEqual(self.bridge.estimate_input_tokens("x"), 1)

    def test_prompt_separates_native_read_only_from_external_write_tools(self):
        prompt = self.bridge.build_prompt({
            "tools": [
                {"name": "Read", "input_schema": {"type": "object"}},
                {"name": "Write", "input_schema": {"type": "object"}},
                {"name": "Edit", "input_schema": {"type": "object"}},
            ],
            "messages": [{"role": "user", "content": "update the strategy document"}],
        })
        self.assertIn("Codex-native sandbox for this broker is read-only", prompt)
        self.assertIn("external write-capable tools: Write, Edit", prompt)
        self.assertIn("EasyDeal/Claude Code executes those tools", prompt)
        self.assertIn("Do not claim that a file, workspace, or the whole session is read-only", prompt)
        self.assertIn("returns a real permission or filesystem error", prompt)

    def test_prompt_does_not_advertise_undeclared_write_tools(self):
        prompt = self.bridge.build_prompt({
            "tools": [{"name": "Read", "input_schema": {"type": "object"}}],
            "messages": [{"role": "user", "content": "inspect only"}],
        })
        self.assertNotIn("external write-capable tools", prompt)

    def test_manual_model_is_forwarded_to_codex_exec(self):
        old_model = self.bridge.MODEL
        self.bridge.MODEL = "gpt-manual-test"
        completed = self.bridge.subprocess.CompletedProcess(
            ["codex"], 0,
            (json.dumps({"type": "item.completed", "item": {
                "type": "agent_message", "text": "ok"
            }}) + "\n").encode(), b"",
        )
        try:
            with mock.patch.object(self.bridge, "run_process", return_value=completed) as runner:
                self.assertEqual(self.bridge.run_codex("hello"), "ok")
            args = runner.call_args.args[0]
            self.assertIn("--model", args)
            self.assertEqual(args[args.index("--model") + 1], "gpt-manual-test")
        finally:
            self.bridge.MODEL = old_model

    def test_client_disconnect_requests_process_tree_cleanup(self):
        process = mock.Mock()
        process.communicate.side_effect = [
            self.bridge.subprocess.TimeoutExpired(["codex"], 1),
            (b"", b""),
        ]
        with mock.patch.object(self.bridge.subprocess, "Popen", return_value=process), \
                mock.patch.object(self.bridge, "terminate_process_tree") as terminate:
            with self.assertRaises(self.bridge.ProcessCancelled):
                self.bridge.run_process(
                    ["codex"], timeout=10, poll_seconds=0.01,
                    cancel_check=lambda: True,
                )
        terminate.assert_called_once_with(process)


if __name__ == "__main__":
    unittest.main()
