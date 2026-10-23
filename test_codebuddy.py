"""Offline CodeBuddy regressions. All CLI/model boundaries are mocked.

These checks must never be described as a real DeepSeek call or real debate.
"""
import contextlib
import io
import json
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest
import uuid
from unittest.mock import patch

import debate as d


def completion(answer="OFFLINE ANSWER", model=None, **changes):
    result = {
        "type": "result", "subtype": "success", "is_error": False,
        "session_id": "offline-session", "result": answer,
        "usage": {"input_tokens": 11, "output_tokens": 7},
        "total_cost_usd": 0,
        "modelUsage": {model or d.CODEBUDDY_MODEL: {"inputTokens": 11, "outputTokens": 7}},
    }
    result.update(changes)
    return result


def native_history(answer="OFFLINE ANSWER", model=None):
    """Official -p --output-format json emits raw history plus basic result."""
    result = completion(answer)
    result.pop("modelUsage")
    return [
        {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "OFFLINE"}]},
        {"type": "message", "role": "assistant", "status": "completed",
         "content": [{"type": "output_text", "text": answer}],
         "providerData": {"model": model or d.CODEBUDDY_MODEL,
                          "requestModelId": d.CODEBUDDY_MODEL}},
        result,
    ]


class CodeBuddyTests(unittest.TestCase):
    def setUp(self):
        # A forgotten mock cannot launch any installed CLI, including in failure paths.
        blocker = patch.object(d.subprocess, "Popen", side_effect=AssertionError("REAL CLI FORBIDDEN IN OFFLINE TEST"))
        self.addCleanup(blocker.stop)
        blocker.start()

    def state(self):
        return {"created": d.now(), "mode": "consensus", "topic": "OFFLINE VIRTUAL TOPIC",
                "status": "created", "materials": "OFFLINE MATERIALS", "timeout": 10,
                "agents": d.default_agents(4), "turns": []}

    @staticmethod
    def answer():
        return json.dumps({"analysis": "OFFLINE ANALYSIS", "claims": [], "audit": [],
                           "position_change": "OFFLINE CHANGE", "proposals": [],
                           "agreements": ["OFFLINE AGREEMENT"], "dissent": ["OFFLINE DISSENT"],
                           "unresolved": ["OFFLINE UNRESOLVED"], "conclusion": "OFFLINE CONCLUSION"})

    def fake_model(self, provider, prompt, timeout=10, settings=None, *args, **kwargs):
        answer = self.answer()
        return answer, native_history(answer) if provider == "codebuddy" else {"offline": True}, ""

    def test_fourth_provider_preserves_original_three_defaults(self):
        self.assertEqual(tuple(a["provider"] for a in d.default_agents(3)), ("codex", "claude", "google"))
        agents = d.default_agents(4)
        self.assertEqual(agents[3]["provider"], "codebuddy")
        self.assertEqual(agents[3]["model"], d.CODEBUDDY_MODEL)

    def test_direct_cli_json_fixed_model_tools_and_settings_isolation(self):
        with patch.object(d, "binary", return_value="OFFLINE-CLI"):
            cmd = d.cli_command("codebuddy", Path("."), {"model": d.CODEBUDDY_MODEL}, stream=True)
        self.assertIn("-p", cmd)
        self.assertEqual(cmd[cmd.index("--output-format") + 1], "json")
        self.assertEqual(cmd[cmd.index("--model") + 1], d.CODEBUDDY_MODEL)
        self.assertEqual(cmd[cmd.index("--tools") + 1], "")
        self.assertEqual(cmd[cmd.index("--permission-mode") + 1], "dontAsk")
        self.assertEqual(cmd[cmd.index("--setting-sources") + 1], "none")
        self.assertEqual(json.loads(cmd[cmd.index("--mcp-config") + 1]), {"mcpServers": {}})
        self.assertIn("--strict-mcp-config", cmd)
        self.assertTrue(json.loads(cmd[cmd.index("--settings") + 1])["disableAllHooks"])
        self.assertIn("--no-session-persistence", cmd)
        self.assertEqual(cmd[cmd.index("--max-turns") + 1], "1")
        for forbidden in ("--fallback-model", "--continue", "--resume", "--dangerously-skip-permissions"):
            self.assertNotIn(forbidden, cmd)
        self.assertNotIn("wb-openai-gateway", " ".join(cmd))

    @unittest.skipUnless(d.os.name == "nt", "Windows npm entry-point regression")
    def test_windows_npm_entry_keeps_empty_tools_argument(self):
        with tempfile.TemporaryDirectory() as temp:
            shim = Path(temp) / "codebuddy.cmd"
            entry = Path(temp) / "node_modules/@tencent-ai/codebuddy-code/bin/codebuddy"
            entry.parent.mkdir(parents=True)
            entry.write_text("OFFLINE ENTRY", encoding="utf-8")
            with patch.object(d, "binary", return_value=str(shim)), patch.object(d.shutil, "which", return_value="OFFLINE-NODE"):
                cmd = d.cli_command("codebuddy", Path(temp))
        self.assertEqual(cmd[:2], ["OFFLINE-NODE", str(entry)])
        self.assertNotIn(str(shim), cmd)
        self.assertEqual(cmd[cmd.index("--tools") + 1], "")

    def test_every_call_uses_a_fresh_ephemeral_session(self):
        with patch.object(d, "binary", return_value="OFFLINE-CLI"):
            a = d.cli_command("codebuddy", Path("."))
            b = d.cli_command("codebuddy", Path("."))
        aid, bid = a[a.index("--session-id") + 1], b[b.index("--session-id") + 1]
        self.assertNotEqual(uuid.UUID(aid), uuid.UUID(bid))

    def test_model_aliases_overrides_and_effort_are_rejected(self):
        with patch.object(d, "binary", return_value="OFFLINE-CLI"):
            for settings in ({"model": "fast-model"}, {"model": "deepseek-flash"},
                             {"model": "--model fake"}, {"model": d.CODEBUDDY_MODEL, "effort": "unsupported_xyz"}):
                with self.subTest(settings=settings), self.assertRaises(ValueError):
                    d.cli_command("codebuddy", Path("."), settings)
            cmd = d.cli_command("codebuddy", Path("."), {"model": d.CODEBUDDY_MODEL, "effort": "high"})
            self.assertIn("--effort", cmd)
            self.assertEqual(cmd[cmd.index("--effort") + 1], "high")

    def test_child_env_blocks_paid_credentials_routes_and_custom_model_files(self):
        inherited = {k: "OFFLINE_SECRET" for k in (
            "CODEBUDDY_API_KEY", "CODEBUDDY_AUTH_TOKEN", "CODEBUDDY_BASE_URL", "CODEBUDDY_CUSTOM_HEADERS",
            "CODEBUDDY_REPLAY_DIR", "WB_API_KEY", "WORKBUDDY_API_KEY", "DEEPSEEK_API_KEY",
            "ACC_PRODUCT_CONFIG", "ACC_PRODUCT_CONFIG_V2", "ACC_PRODUCT_CONFIG_V3", "ACC_PRODUCT_CONFIG_PATH",
            "NODE_OPTIONS", "OPENAI_BASE_URL", "SOME_API_KEY")}
        with patch.dict(d.os.environ, inherited, clear=True):
            env = d.safe_env()
        for key in inherited:
            self.assertNotIn(key, env, key)
        self.assertEqual(env["CODEBUDDY_DISABLE_CUSTOM_MODELS_FILE"], "1")
        self.assertEqual(env["CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS"], "1")

    def test_extracts_single_json_result_and_raw_history(self):
        for raw in (completion(), native_history()):
            with self.subTest(shape=type(raw).__name__):
                answer, original = d.extract("codebuddy", json.dumps(raw))
                self.assertEqual(answer, "OFFLINE ANSWER")
                self.assertEqual(original, raw)

    def test_requires_completed_result_and_nonempty_answer(self):
        for raw in ("NOT JSON", json.dumps({"result": "incomplete"}),
                    json.dumps(completion(type="assistant")), json.dumps(completion(answer="")),
                    json.dumps([completion(), completion()]), json.dumps([])):
            with self.subTest(raw=raw), self.assertRaises(d.ProviderError):
                d.extract("codebuddy", raw)

    def test_quota_and_auth_structured_errors_are_not_success(self):
        for fields, expected in (({"errors": ["quota exceeded"]}, "usage_limit"),
                                 ({"errors": ["not logged in"]}, "authentication"),
                                 ({"errors": ["Request failed"], "errors_info": [{"status": 429}]}, "usage_limit"),
                                 ({"errors": ["Request failed"], "errors_info": [{"status": 401}]}, "authentication")):
            with self.subTest(fields=fields):
                raw = completion(is_error=True, subtype="error_during_execution", **fields)
                with self.assertRaises(d.ProviderError) as caught:
                    d.extract("codebuddy", json.dumps(raw))
                self.assertEqual(caught.exception.category, expected)

    def test_aborted_success_and_turn_limit_are_failures(self):
        for fields in ({"terminal_reason": "aborted_streaming"}, {"terminal_reason": "aborted_tools"},
                       {"subtype": "error_max_turns", "is_error": True}):
            with self.subTest(fields=fields), self.assertRaises(d.ProviderError):
                d.extract("codebuddy", json.dumps(completion(**fields)))

    def test_native_provider_data_records_actual_model(self):
        metadata = d.execution_metadata("codebuddy", native_history(), {"model": d.CODEBUDDY_MODEL})
        self.assertTrue(metadata["model_confirmed"])
        self.assertEqual(metadata["reported_models"], [d.CODEBUDDY_MODEL])
        wrong = d.execution_metadata("codebuddy", native_history(model="different-server-model"))
        self.assertFalse(wrong["model_confirmed"])

    def test_requested_model_in_user_message_is_not_execution_proof(self):
        raw = native_history()
        raw[0]["providerData"] = {"model": d.CODEBUDDY_MODEL, "requestModelId": d.CODEBUDDY_MODEL}
        raw[1]["providerData"] = {"requestModelId": d.CODEBUDDY_MODEL}
        self.assertFalse(d.execution_metadata("codebuddy", raw)["model_confirmed"])

    def test_model_usage_metadata_keeps_usage_session_and_cost_context(self):
        metadata = d.execution_metadata("codebuddy", completion())
        self.assertTrue(metadata["model_confirmed"])
        self.assertEqual(metadata["session_id"], "offline-session")
        self.assertEqual(metadata["usage"]["input_tokens"], 11)
        self.assertEqual(metadata["reported_cost_usd"], 0)
        self.assertIn("추정", metadata["billing_note"])

    def test_missing_or_different_model_metadata_fails_without_retry(self):
        for raw in (completion(model="wrong-model"), completion(modelUsage={})):
            with self.subTest(raw=raw), patch.object(d, "cli_command", return_value=["OFFLINE-CLI"]), \
                 patch.object(d, "capture", return_value=(0, json.dumps(raw), "")) as capture, \
                 patch.object(d, "auth_status") as auth:
                with self.assertRaises(d.ProviderError) as caught:
                    d.model_call("codebuddy", "OFFLINE PROMPT")
                self.assertEqual(caught.exception.category, "model_mismatch")
                capture.assert_called_once()
                auth.assert_not_called()

    def test_direct_native_history_success_never_uses_an_auth_status_inference(self):
        with patch.object(d, "cli_command", return_value=["OFFLINE-CLI"]), \
             patch.object(d, "capture", return_value=(0, json.dumps(native_history()), "")) as capture, \
             patch.object(d, "auth_status") as auth:
            answer, raw, error = d.model_call("codebuddy", "OFFLINE PROMPT")
        self.assertEqual(answer, "OFFLINE ANSWER")
        self.assertEqual(error, "")
        auth.assert_not_called()
        capture.assert_called_once()

    def test_ui_capture_reads_native_json_array_without_sending_array_events(self):
        # Exercise the actual threaded pipe reader with an inert process. The UI
        # callback contract accepts event dictionaries, while fixed-json output
        # may be a single native-history array or pretty-printed over many lines.
        from test_engine_ui import FakeProcess
        raw = native_history()
        fixture = FakeProcess((json.dumps(raw) + "\n").encode("utf-8"))
        events = []

        def ui_event(event):
            events.append(event.get("type"))  # Deliberately the real UI contract.

        with patch.object(d, "cli_command", return_value=["OFFLINE-CLI"]), \
             patch.object(d.subprocess, "Popen", return_value=fixture) as popen:
            answer, actual, error = d.model_call("codebuddy", "OFFLINE PROMPT", timeout=5,
                                                on_event=ui_event, stop_event=threading.Event())
        self.assertEqual(answer, "OFFLINE ANSWER")
        self.assertEqual(actual, raw)
        self.assertEqual(error, "")
        self.assertEqual(events, [])
        self.assertTrue(d.execution_metadata("codebuddy", actual)["model_confirmed"])
        popen.assert_called_once()

    def test_four_agent_consensus_has_twenty_four_slots_and_blind_independent_phase(self):
        state = self.state()
        self.assertEqual([v[0] for v in d.plan("consensus", state["agents"])],
                         ["independent", "cross", "rebuttal", "alternatives", "professor", "consensus"])
        state["turns"] = [{"id": "S1A1", "stage": "independent", "name": "GPT", "answer": "UNIQUE_PEER_CLAIM"}]
        for index in range(4):
            self.assertNotIn("UNIQUE_PEER_CLAIM", d.build_prompt(state, 0, index))
            for stage_index in range(1, 6):
                prompt = d.build_prompt(state, stage_index, index)
                self.assertIn("UNIQUE_PEER_CLAIM", prompt)
                self.assertIn("S1A1", prompt)

    def test_offline_pause_resume_preserves_turns_and_six_deepseek_metadata_records(self):
        state = self.state()
        with tempfile.TemporaryDirectory() as temp, patch.object(d, "model_call", side_effect=self.fake_model) as model, \
             contextlib.redirect_stdout(io.StringIO()):
            run = Path(temp)
            d.execute(state, run, max_turns=5)
            self.assertEqual(state["status"], "paused")
            self.assertEqual(len(state["turns"]), 5)
            first_ids = [t["id"] for t in state["turns"]]
            d.execute(state, run)
            self.assertEqual(state["status"], "completed")
            self.assertEqual(len(state["turns"]), 24)
            self.assertEqual(model.call_count, 24)
            self.assertEqual([t["id"] for t in state["turns"][:5]], first_ids)
            self.assertEqual(len({t["id"] for t in state["turns"]}), 24)
            deepseek = [t for t in state["turns"] if t["provider"] == "codebuddy"]
            self.assertEqual([t["stage"] for t in deepseek], ["independent", "cross", "rebuttal", "alternatives", "professor", "consensus"])
            self.assertTrue(all(t["execution_metadata"]["model_confirmed"] for t in deepseek))
            saved = json.loads((run / "debate.json").read_text(encoding="utf-8"))
            self.assertEqual(len(saved["turns"]), 24)
            self.assertEqual(len((run / "events.jsonl").read_text(encoding="utf-8").splitlines()), 24)
            summary = (run / "summary.md").read_text(encoding="utf-8")
            for text in ("OFFLINE CONCLUSION", "OFFLINE UNRESOLVED", "OFFLINE DISSENT"):
                self.assertIn(text, summary)

    def test_timeout_and_quota_are_saved_without_automatic_retry(self):
        for error, category in ((subprocess.TimeoutExpired(["OFFLINE-CLI"], 10), "timeout"),
                                (d.ProviderError("OFFLINE quota exceeded", "usage_limit"), "usage_limit")):
            with self.subTest(category=category), tempfile.TemporaryDirectory() as temp, \
                 contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                state = self.state()
                run = Path(temp)
                with patch.object(d, "model_call", side_effect=self.fake_model):
                    d.execute(state, run, max_turns=3)
                self.assertEqual(len(state["turns"]), 3)
                with patch.object(d, "model_call", side_effect=error) as model:
                    d.execute(state, run)
                model.assert_called_once()
                self.assertEqual(state["status"], "failed")
                self.assertEqual(state["errors"][-1]["category"], category)
                self.assertEqual(state["attempts"][-1]["id"], "S1A4")
                self.assertEqual(state["attempts"][-1]["error_category"], category)
                self.assertEqual(len(state["turns"]), 3)
                self.assertFalse((run / "runner.lock").exists())

    def test_cancelled_before_probe_does_not_invoke_any_cli_boundary(self):
        event = threading.Event()
        event.set()
        with patch.object(d, "capture") as capture, patch.object(d, "capture_stream") as stream:
            with self.assertRaises(d.RunStopped):
                d.model_call("codebuddy", "OFFLINE", stop_event=event)
        capture.assert_not_called()
        stream.assert_not_called()


if __name__ == "__main__":
    unittest.main()
