"""Local Anthropic-compatible bridge backed by an officially logged-in Codex CLI.

This is deliberately a *local broker*, not an OpenAI API proxy:
  - it never reads OPENAI_API_KEY or Codex OAuth files;
  - it never forwards prompts to a third-party HTTP endpoint;
  - Codex itself owns its ChatGPT login state (run ``codex login`` once);
  - every request requires a locally configured bridge token.

Configuration (environment variables):
  EASYDEAL_CODEX_BRIDGE_TOKEN   optional long random local token
  EASYDEAL_CODEX_BRIDGE_TOKEN_FILE optional path for the local bridge token
  EASYDEAL_CODEX_BIN            optional path to codex(.exe); defaults to PATH
  EASYDEAL_CODEX_WORKSPACE      required allowed workspace directory
  EASYDEAL_CODEX_SANDBOX        read-only (default) or workspace-write
  EASYDEAL_CODEX_MODEL          optional Codex model override
  EASYDEAL_CODEX_PROXY_MODE     auto, manual, or off (diagnostic label)
  EASYDEAL_CODEX_PORT           default 51281

EasyDeal should use http://127.0.0.1:51281/v1/messages as its Anthropic base
URL. Put the bridge token in its Anthropic API-key field: normal Anthropic
clients send that as ``x-api-key``. ``X-EasyDeal-Bridge-Token`` and a Bearer
header are also accepted for custom integrations. Do not expose this service
through a LAN reverse proxy.
"""

from __future__ import annotations

import json
import os
import re
import secrets
import select
import signal
import socket
import shutil
import subprocess
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlsplit


HOST = "127.0.0.1"
PORT = int(os.environ.get("EASYDEAL_CODEX_PORT", "51281"))
_CODEX_BIN_SETTING = os.environ.get("EASYDEAL_CODEX_BIN", "").strip()
CODEX_BIN = shutil.which(_CODEX_BIN_SETTING) if _CODEX_BIN_SETTING else shutil.which("codex")
WORKSPACE = os.environ.get("EASYDEAL_CODEX_WORKSPACE", "").strip()
SANDBOX = os.environ.get("EASYDEAL_CODEX_SANDBOX", "read-only").strip()
MODEL = os.environ.get("EASYDEAL_CODEX_MODEL", "").strip()
PROXY_MODE = os.environ.get("EASYDEAL_CODEX_PROXY_MODE", "auto").strip()
# Do not silently drop earlier turns.  These are explicit safety ceilings; a
# request above either one receives a clear error rather than a partial model
# context. They can be raised for a local machine through environment vars.
MAX_BODY_BYTES = int(os.environ.get("EASYDEAL_CODEX_MAX_BODY_BYTES", "8000000"))
CODEX_CLI_MAX_INPUT_CHARS = 1_048_576
MAX_PROMPT_CHARS = min(
    int(os.environ.get("EASYDEAL_CODEX_MAX_CONTEXT_CHARS", "600000")),
    CODEX_CLI_MAX_INPUT_CHARS,
)
MAX_OUTPUT_CHARS = int(os.environ.get("EASYDEAL_CODEX_MAX_OUTPUT_CHARS", "300000"))
# EasyDeal resends the full assembled tool registry when it submits a tool
# result.  A normal session can exceed 64 once remote MCPs are attached.
# Keep a finite explicit ceiling, but do not reject that standard follow-up.
MAX_TOOL_COUNT = 256
MAX_TOOL_SCHEMA_CHARS = 500_000
# A Codex turn may legitimately spend several minutes across tool calls.  Keep
# an explicit ceiling so a truly stuck child is eventually reclaimed, but do
# not kill healthy long-running work after the old three-minute limit.
REQUEST_TIMEOUT_SECONDS = int(
    os.environ.get("EASYDEAL_CODEX_REQUEST_TIMEOUT_SECONDS", "1800")
)
BRIDGE_VERSION = "tool-map-2026-08-31-8"


class ProcessCancelled(RuntimeError):
    """The local HTTP caller disconnected while Codex was still running."""


def _token_file() -> Path:
    configured = os.environ.get("EASYDEAL_CODEX_BRIDGE_TOKEN_FILE", "").strip()
    if configured:
        return Path(configured).expanduser()
    local_app_data = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    return Path(local_app_data) / "EasyDealCodexCliBridge" / "bridge.token"


def load_or_create_token() -> tuple[str, Path]:
    configured = os.environ.get("EASYDEAL_CODEX_BRIDGE_TOKEN", "").strip()
    if len(configured) >= 24:
        return configured, _token_file()
    path = _token_file()
    try:
        existing = path.read_text(encoding="utf-8").strip()
        if len(existing) >= 24:
            return existing, path
    except FileNotFoundError:
        pass
    path.parent.mkdir(parents=True, exist_ok=True)
    created = secrets.token_urlsafe(48)
    try:
        with path.open("x", encoding="utf-8") as handle:
            handle.write(created + "\n")
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass
        return created, path
    except FileExistsError:
        existing = path.read_text(encoding="utf-8").strip()
        if len(existing) >= 24:
            return existing, path
        raise RuntimeError("bridge token file exists but is invalid")


TOKEN, TOKEN_FILE = load_or_create_token()


def configuration_error() -> str | None:
    if not TOKEN or len(TOKEN) < 24:
        return "local bridge token is unavailable"
    if not CODEX_BIN or not Path(CODEX_BIN).is_file():
        return "Codex CLI was not found; set EASYDEAL_CODEX_BIN or add codex to PATH"
    if SANDBOX not in {"read-only", "workspace-write"}:
        return "EASYDEAL_CODEX_SANDBOX must be read-only or workspace-write"
    if PROXY_MODE not in {"auto", "manual", "off"}:
        return "EASYDEAL_CODEX_PROXY_MODE must be auto, manual, or off"
    if not WORKSPACE:
        return "EASYDEAL_CODEX_WORKSPACE is required"
    try:
        workspace = Path(WORKSPACE).resolve(strict=True)
    except OSError:
        return "EASYDEAL_CODEX_WORKSPACE does not exist"
    if not workspace.is_dir():
        return "EASYDEAL_CODEX_WORKSPACE must be a directory"
    return None


def text_from_content(value: Any) -> str:
    if isinstance(value, str):
        return value
    if not isinstance(value, list):
        return ""
    result: list[str] = []
    for block in value:
        if not isinstance(block, dict):
            continue
        block_type = str(block.get("type") or "")
        if block_type in {"text", "input_text", "output_text"}:
            result.append(str(block.get("text") or ""))
        elif block_type == "tool_result":
            result.append("[EasyDeal tool result]\n" + text_from_content(block.get("content")))
        elif block_type == "tool_use":
            result.append("[EasyDeal tool call already performed]\n" + json.dumps({
                "name": block.get("name"), "input": block.get("input", {}),
            }, ensure_ascii=False))
    return "\n".join(part for part in result if part)


def declared_tools(payload: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Return the exact client-declared Anthropic tools, fail-closed.

    The bridge never executes these tools.  It only turns a validated Codex
    request into Anthropic ``tool_use``; EasyDeal/Claude Code remains the tool
    executor and returns the result on the next /v1/messages request.
    """
    raw_tools = payload.get("tools") or []
    if not isinstance(raw_tools, list):
        raise ValueError("tools must be an array")
    if len(raw_tools) > MAX_TOOL_COUNT:
        raise ValueError(f"too many tools (maximum {MAX_TOOL_COUNT})")
    result: dict[str, dict[str, Any]] = {}
    schema_size = 0
    for tool in raw_tools:
        if not isinstance(tool, dict):
            raise ValueError("every tool must be an object")
        name = str(tool.get("name") or "").strip()
        if not re.fullmatch(r"[A-Za-z0-9_.:-]{1,160}", name):
            raise ValueError("tool name contains unsupported characters")
        if name in result:
            raise ValueError(f"duplicate tool name: {name}")
        schema = tool.get("input_schema", tool.get("parameters", {"type": "object"}))
        if not isinstance(schema, dict):
            raise ValueError(f"tool {name} schema must be an object")
        serialized = json.dumps(schema, ensure_ascii=False, separators=(",", ":"))
        schema_size += len(serialized)
        if schema_size > MAX_TOOL_SCHEMA_CHARS:
            raise ValueError("combined tool schemas are too large")
        result[name] = {
            "name": name,
            "description": str(tool.get("description") or "")[:4000],
            "input_schema": schema,
        }
    return result


def is_remote_tool_name(name: str) -> bool:
    """Accept legacy `mcp__remote__*` and qualified multi-target names."""
    return str(name or "").startswith("mcp__remote")


def build_prompt(payload: dict[str, Any]) -> str:
    """Convert a completed Anthropic conversation to one safe Codex turn.

    Codex owns its own local tools.  The original client's tool definitions are
    context only: they are not registered as executable capabilities here.
    This prevents an arbitrary HTTP caller from turning this bridge into a
    generic tool-execution service.
    """
    tools = declared_tools(payload)
    parts = [
        "You are the coding/model backend for an EasyDeal conversation.",
        f"The Codex-native sandbox for this broker is {SANDBOX}. Use only that "
        "sandbox and the configured workspace for Codex-native filesystem or "
        "command actions.",
    ]
    if tools:
        normalized_write_names = {
            "write", "edit", "multiedit", "notebookedit", "applypatch",
            "writefile", "editfile",
        }
        write_tools = [
            name for name in tools
            if re.sub(r"[^a-z0-9]", "", name.lower()) in normalized_write_names
            or re.sub(r"[^a-z0-9]", "", name.lower()).endswith(
                ("writefile", "editfile", "applypatch")
            )
        ]
        tool_contract = {
            "easydeal_tools": list(tools.values()),
            "required_reply_when_calling_tools": {
                "easydeal_bridge_tool_calls": [{"name": "exact declared tool name", "input": {}}],
            },
        }
        parts.extend([
            "The client owns the external EasyDeal tools below. Do NOT execute or imitate those tools yourself.",
            "When a tool is needed, reply with only the JSON object described in required_reply_when_calling_tools. Use only declared names and JSON-object inputs. After tool results arrive, continue normally or request another tool.",
            "[External tool contract]",
            json.dumps(tool_contract, ensure_ascii=False),
        ])
        if write_tools:
            parts.extend([
                "The Codex-native sandbox restriction does not change the permissions of "
                "client-declared external tools. EasyDeal/Claude Code executes those tools "
                "outside the Codex-native sandbox under the client's own permissions.",
                "The client declared these external write-capable tools: "
                + ", ".join(write_tools)
                + ". When the user requests file changes, request one of these tools through "
                "the external tool contract instead of refusing the task.",
                "Do not claim that a file, workspace, or the whole session is read-only solely "
                "because the Codex-native sandbox is read-only. Report a write as blocked only "
                "after an appropriate declared external write tool returns a real permission "
                "or filesystem error.",
            ])
        if any(is_remote_tool_name(name) for name in tools):
            parts.append(
                "For a request about the selected/remote MT5 target's current status, "
                "prefer the matching declared mcp__remote tool and use its exact name/schema."
            )
        elif "WaitForMcpServers" in tools:
            parts.append(
                "If the user needs a remote/MCP capability that is not declared yet, call "
                "WaitForMcpServers first using its declared schema. Do not invent an undeclared "
                "mcp__remote__ tool. After EasyDeal returns the wait result, re-evaluate the "
                "newly declared tools and then call the real remote tool."
            )
    else:
        parts.append("Give the best final answer or perform only Codex-native work allowed by the sandbox.")
    system = text_from_content(payload.get("system"))
    if system:
        parts.extend(["[System instructions]", system])
    for message in payload.get("messages") or []:
        if not isinstance(message, dict):
            continue
        role = str(message.get("role") or "user")
        content = text_from_content(message.get("content"))
        if content:
            parts.extend([f"[{role}]", content])
    prompt = "\n\n".join(parts).strip()
    if len(prompt) > MAX_PROMPT_CHARS:
        raise ValueError(
            f"conversation context is {len(prompt)} characters, above the configured "
            f"{MAX_PROMPT_CHARS} character limit; bridge refused to silently truncate it"
        )
    return prompt


def estimate_input_tokens(prompt: str) -> int:
    """Expose a conservative-enough usage estimate to Claude Code.

    Codex CLI does not return Anthropic token accounting.  Reporting zero made
    EasyDeal's next-turn compaction guard blind, so a long resumed conversation
    could run straight into this bridge's explicit character ceiling.  Four
    characters per token leaves roughly 20% headroom before the default 600K
    ceiling when EasyDeal uses its 120K-token fallback soft limit.
    """
    return max(1, (len(prompt) + 3) // 4)


def extract_codex_text(stdout: str) -> str:
    texts: list[str] = []
    for line in stdout.splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        item = event.get("item") if isinstance(event, dict) else None
        if isinstance(item, dict) and item.get("type") in {"agent_message", "agentMessage"}:
            text = item.get("text") or item.get("content")
            if isinstance(text, str) and text:
                texts.append(text)
        if isinstance(event, dict) and event.get("type") in {"agent_message", "agentMessage"}:
            text = event.get("text") or event.get("content")
            if isinstance(text, str) and text:
                texts.append(text)
    answer = "\n".join(dict.fromkeys(texts)).strip()
    if len(answer) > MAX_OUTPUT_CHARS:
        raise RuntimeError(
            f"Codex output is {len(answer)} characters, above the configured "
            f"{MAX_OUTPUT_CHARS} character limit; bridge refused to silently truncate it"
        )
    return answer


def extract_external_tool_calls(answer: str, tools: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    """Parse only the bridge's explicit JSON envelope, never prose guesses.

    Codex normally returns only the envelope.  Some client/system prompts can
    nevertheless make it wrap that envelope in a short sentence; tolerate that
    formatting without ever inferring a call from prose.
    """
    if not tools:
        return []
    candidate = answer.strip()
    fenced = re.fullmatch(r"```(?:json)?\s*(.*?)\s*```", candidate, flags=re.DOTALL | re.IGNORECASE)
    if fenced:
        candidate = fenced.group(1).strip()
    value: Any = None
    try:
        value = json.loads(candidate)
    except json.JSONDecodeError:
        # Find a literal envelope start, then let the JSON decoder determine
        # its exact end. This does not parse or turn arbitrary prose into a
        # tool call: the same declared-name and object-input checks remain
        # mandatory below.
        match = re.search(r'\{\s*"easydeal_bridge_tool_calls"\s*:', candidate)
        if not match:
            return []
        try:
            value, _ = json.JSONDecoder().raw_decode(candidate[match.start():])
        except json.JSONDecodeError:
            return []
    calls = value.get("easydeal_bridge_tool_calls") if isinstance(value, dict) else None
    if not isinstance(calls, list) or not calls or len(calls) > 16:
        return []
    result: list[dict[str, Any]] = []
    for call in calls:
        if not isinstance(call, dict):
            return []
        name = str(call.get("name") or "")
        arguments = call.get("input")
        if name not in tools or not isinstance(arguments, dict):
            return []
        result.append({"type": "tool_use", "id": "toolu_" + uuid.uuid4().hex,
                       "name": name, "input": arguments})
    return result


def tool_envelope_name(answer: str) -> str:
    """Return only a proposed tool name for local diagnostics, never text/input."""
    if "easydeal_bridge_tool_calls" not in answer:
        return "-"
    match = re.search(r'"name"\s*:\s*"([^"\\]{1,160})"', answer)
    return match.group(1) if match else "unreadable"


def should_wait_for_remote_mcp(payload: dict[str, Any], tools: dict[str, dict[str, Any]]) -> bool:
    """Perform EasyDeal's MCP readiness handshake before the first remote call."""
    if "WaitForMcpServers" not in tools:
        return False
    if any(is_remote_tool_name(name) for name in tools):
        return False
    messages = payload.get("messages") or []
    if not isinstance(messages, list) or not messages:
        return False
    last = messages[-1]
    if not isinstance(last, dict) or str(last.get("role") or "") != "user":
        return False
    content = last.get("content")
    # A tool-result callback must be processed by Codex; otherwise this would
    # keep asking EasyDeal to wait forever.
    if isinstance(content, list) and any(
        isinstance(block, dict) and block.get("type") == "tool_result"
        for block in content
    ):
        return False
    conversation_hint = "\n".join(
        text_from_content(message.get("content"))
        for message in messages[-8:]
        if isinstance(message, dict)
    )
    return bool(re.search(r"(?:mcp|remote|远程|mt5)", conversation_hint, re.IGNORECASE))


def terminate_process_tree(process: subprocess.Popen[bytes]) -> None:
    """Stop a timed-out Codex command together with its cmd/node descendants."""
    if process.poll() is not None:
        return
    if os.name == "nt":
        try:
            subprocess.run(
                ["taskkill.exe", "/PID", str(process.pid), "/T", "/F"],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                timeout=8, check=False,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except (OSError, subprocess.TimeoutExpired):
            pass
    else:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except (OSError, ProcessLookupError):
            pass
    if process.poll() is None:
        try:
            process.kill()
        except OSError:
            pass


def run_process(args: list[str], *, input_bytes: bytes | None = None,
                cwd: str | None = None, env: dict[str, str] | None = None,
                timeout: int, cancel_check: Callable[[], bool] | None = None,
                poll_seconds: float = 1.0) -> subprocess.CompletedProcess[bytes]:
    """Run a CLI command with bounded, process-tree-safe timeout handling."""
    kwargs: dict[str, Any] = {
        "stdin": subprocess.PIPE,
        "stdout": subprocess.PIPE,
        "stderr": subprocess.PIPE,
        "cwd": cwd,
        "env": env,
        "creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0),
    }
    if os.name != "nt":
        kwargs["start_new_session"] = True
    process = subprocess.Popen(args, **kwargs)
    deadline = time.monotonic() + timeout
    pending_input = input_bytes
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            terminate_process_tree(process)
            try:
                process.communicate(timeout=8)
            except (OSError, subprocess.TimeoutExpired):
                pass
            raise subprocess.TimeoutExpired(args, timeout)
        try:
            stdout, stderr = process.communicate(
                input=pending_input, timeout=min(poll_seconds, remaining),
            )
            return subprocess.CompletedProcess(args, process.returncode, stdout, stderr)
        except subprocess.TimeoutExpired:
            # communicate() is safe to retry after TimeoutExpired; input must
            # only be supplied on the first call.
            pending_input = None
            if cancel_check and cancel_check():
                terminate_process_tree(process)
                try:
                    process.communicate(timeout=8)
                except (OSError, subprocess.TimeoutExpired):
                    pass
                raise ProcessCancelled("local Anthropic client disconnected")


def run_codex(prompt: str, cancel_check: Callable[[], bool] | None = None) -> str:
    workspace = str(Path(WORKSPACE).resolve(strict=True))
    args = [CODEX_BIN, "exec", "--json", "--color", "never", "--sandbox", SANDBOX, "--skip-git-repo-check"]
    if MODEL:
        args.extend(["--model", MODEL])
    args.append("-")
    env = dict(os.environ)
    # The CLI's own ChatGPT login state is the only credential source.
    env.pop("OPENAI_API_KEY", None)
    env.pop("CODEX_API_KEY", None)
    result = run_process(
        args,
        input_bytes=prompt.encode("utf-8"),
        cwd=workspace,
        env=env,
        timeout=REQUEST_TIMEOUT_SECONDS,
        cancel_check=cancel_check,
    )
    if result.returncode != 0:
        detail = result.stderr.decode("utf-8", errors="replace").strip().replace("\n", " ")
        raise RuntimeError(f"Codex CLI exited {result.returncode}: {detail[:500]}")
    answer = extract_codex_text(result.stdout.decode("utf-8", errors="replace"))
    if not answer:
        raise RuntimeError(
            "Codex CLI completed successfully but produced no final agent message"
        )
    return answer


def login_status() -> dict[str, Any]:
    error = configuration_error()
    if error:
        return {"ok": False, "configured": False, "error": error}
    result = run_process([CODEX_BIN, "login", "status"], timeout=15)
    output = (result.stdout + result.stderr).decode("utf-8", errors="replace").strip()
    return {"ok": result.returncode == 0, "configured": True, "login_ok": result.returncode == 0,
            "sandbox": SANDBOX, "workspace": str(Path(WORKSPACE).resolve()),
            "model": MODEL, "proxy_mode": PROXY_MODE, "detail": output[:500]}


class Handler(BaseHTTPRequestHandler):
    server_version = "EasyDealCodexCliBridge/1"

    def log_message(self, fmt: str, *args: Any) -> None:
        # Never log prompts, bearer values or CLI output.
        print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {fmt % args}", flush=True)

    def send_json(self, status: int, value: dict[str, Any]) -> None:
        data = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("X-EasyDeal-Codex-Bridge", BRIDGE_VERSION)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def client_disconnected(self) -> bool:
        """Non-blocking check used to cancel Codex when Claude is stopped."""
        try:
            readable, _, _ = select.select([self.connection], [], [], 0)
            if not readable:
                return False
            return self.connection.recv(1, socket.MSG_PEEK) == b""
        except (OSError, ValueError):
            return True

    def authorized(self) -> bool:
        authorization = self.headers.get("Authorization", "")
        bearer = authorization[7:].strip() if authorization.lower().startswith("bearer ") else ""
        supplied_values = (
            self.headers.get("X-EasyDeal-Bridge-Token", ""),
            self.headers.get("x-api-key", ""),
            bearer,
        )
        return bool(TOKEN and any(
            value and secrets.compare_digest(value, TOKEN)
            for value in supplied_values
        ))

    def send_sse(self, event: str, value: dict[str, Any]) -> bool:
        try:
            self.wfile.write(f"event: {event}\ndata: {json.dumps(value, ensure_ascii=False)}\n\n".encode("utf-8"))
            self.wfile.flush()
            return True
        except (BrokenPipeError, ConnectionResetError):
            return False

    def send_message_response(self, content: list[dict[str, Any]], stream: bool,
                              stop_reason: str = "end_turn", input_tokens: int = 0) -> None:
        request_id = "msg_" + uuid.uuid4().hex
        result = {
            "id": request_id,
            "type": "message", "role": "assistant", "model": "codex-cli",
            "content": content,
            "stop_reason": stop_reason, "stop_sequence": None,
            "usage": {"input_tokens": max(0, int(input_tokens)), "output_tokens": 0},
        }
        if not stream:
            self.send_json(200, result)
            return
        # codex exec emits completed event records, not a token stream.  Keep
        # Anthropic SSE compatibility without pretending the upstream itself
        # is incremental.
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("X-EasyDeal-Codex-Bridge", BRIDGE_VERSION)
        self.send_header("Cache-Control", "no-cache, no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        events: list[tuple[str, dict[str, Any]]] = [
            ("message_start", {"type": "message_start", "message": {**result, "content": [], "stop_reason": None}}),
        ]
        for index, block in enumerate(content):
            if block.get("type") == "tool_use":
                events.extend([
                    ("content_block_start", {"type": "content_block_start", "index": index,
                        "content_block": {"type": "tool_use", "id": block["id"], "name": block["name"], "input": {}}}),
                    ("content_block_delta", {"type": "content_block_delta", "index": index,
                        "delta": {"type": "input_json_delta", "partial_json": json.dumps(block["input"], ensure_ascii=False)}}),
                    ("content_block_stop", {"type": "content_block_stop", "index": index}),
                ])
            else:
                events.extend([
                    ("content_block_start", {"type": "content_block_start", "index": index,
                        "content_block": {"type": "text", "text": ""}}),
                    ("content_block_delta", {"type": "content_block_delta", "index": index,
                        "delta": {"type": "text_delta", "text": str(block.get("text") or "")}}),
                    ("content_block_stop", {"type": "content_block_stop", "index": index}),
                ])
        events.extend([
            ("message_delta", {"type": "message_delta", "delta": {"stop_reason": stop_reason, "stop_sequence": None}, "usage": {"output_tokens": 0}}),
            ("message_stop", {"type": "message_stop"}),
        ])
        for event, payload in events:
            if not self.send_sse(event, payload):
                return

    def do_GET(self) -> None:
        if urlsplit(self.path).path not in {"/", "/health"}:
            self.send_json(404, {"error": "not found"})
            return
        if not self.authorized():
            self.send_json(401, {"error": "bridge_token_required"})
            return
        self.send_json(200, login_status())

    def do_HEAD(self) -> None:
        if urlsplit(self.path).path not in {"/", "/health"}:
            self.send_response(404)
        elif not self.authorized():
            self.send_response(401)
        else:
            self.send_response(200)
            self.send_header("X-EasyDeal-Codex-Bridge", BRIDGE_VERSION)
            self.send_header("Cache-Control", "no-store")
        self.end_headers()

    def do_POST(self) -> None:
        if urlsplit(self.path).path != "/v1/messages":
            self.send_json(404, {"error": "expected Anthropic /v1/messages"})
            return
        if not self.authorized():
            self.send_json(401, {"type": "error", "error": {"type": "authentication_error", "message": "bridge token required"}})
            return
        error = configuration_error()
        if error:
            self.send_json(503, {"type": "error", "error": {"type": "api_error", "message": error}})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > MAX_BODY_BYTES:
                raise ValueError("invalid request body length")
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            if not isinstance(payload, dict):
                raise ValueError("JSON object expected")
            tools = declared_tools(payload)
            if should_wait_for_remote_mcp(payload, tools):
                self.log_message("tool-map: remote MCP not ready; emitted WaitForMcpServers")
                self.send_message_response([{
                    "type": "tool_use",
                    "id": "toolu_" + uuid.uuid4().hex,
                    "name": "WaitForMcpServers",
                    "input": {},
                }], bool(payload.get("stream")), "tool_use")
                return
            started_at = time.monotonic()
            self.log_message("request start: tools=%d model=%s proxy=%s", len(tools),
                             MODEL or "default", PROXY_MODE)
            prompt = build_prompt(payload)
            input_tokens = estimate_input_tokens(prompt)
            answer = run_codex(prompt, cancel_check=self.client_disconnected)
            self.log_message("request complete: elapsed=%.1fs", time.monotonic() - started_at)
            calls = extract_external_tool_calls(answer, tools)
            if calls:
                self.log_message("tool-map: declared=%d emitted=%d", len(tools), len(calls))
                self.send_message_response(
                    calls, bool(payload.get("stream")), "tool_use", input_tokens
                )
            else:
                self.log_message("tool-map: declared=%d emitted=0 envelope=%s requested=%s declared_names=%s",
                                 len(tools), "yes" if "easydeal_bridge_tool_calls" in answer else "no",
                                 tool_envelope_name(answer), ",".join(tools))
                self.send_message_response(
                    [{"type": "text", "text": answer}], bool(payload.get("stream")),
                    "end_turn", input_tokens
                )
        except ProcessCancelled:
            self.log_message("request cancelled: local client disconnected")
            return
        except subprocess.TimeoutExpired:
            self.log_message("request failed: Codex CLI timeout")
            self.send_json(504, {"type": "error", "error": {"type": "timeout_error", "message": "Codex CLI timed out"}})
        except Exception as exc:
            # Keep prompts/tool results out of logs; the exception category is
            # sufficient to diagnose client protocol and size failures.
            self.log_message("request failed: %s: %s", type(exc).__name__, str(exc)[:600])
            self.send_json(502, {"type": "error", "error": {"type": "api_error", "message": str(exc)[:600]}})


if __name__ == "__main__":
    error = configuration_error()
    if error:
        raise SystemExit("Bridge configuration error: " + error)
    print(f"EasyDeal Codex CLI bridge listening on http://{HOST}:{PORT}", flush=True)
    print(f"Local bridge token file: {TOKEN_FILE}", flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
