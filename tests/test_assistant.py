"""Exercise the portable skill against the native HTTP contract."""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
from email import policy
from email.parser import BytesParser
import importlib.util
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "integrations/yijian/skills/yijian/scripts/yijian.py"


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


bridge = load("native_bridge_test", CLI)
installer = load("native_installer_test", ROOT / "scripts/install_assistant.py")


class AssistantTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.cache = Path(self.temp.name).resolve() / "credentials"
        self.token, self.code = secrets.token_urlsafe(24), secrets.token_urlsafe(12)
        self.active, self.used = False, False
        self.valid_tokens, self.verified_tokens, self.revoked_tokens = set(), set(), set()
        self.state_status, self.verify_status = 200, 200
        self.device_code = secrets.token_urlsafe(32)
        self.device_outcomes = ["pending", "approved"]
        self.client_name = "Codex"
        self.requests, self.outfits = [], []
        self.beautify_job = {"job_id": str(uuid4()), "item_id": str(uuid4()), "status": "queued"}
        self.beautify_claimed = False
        self.beautify_result_status = 200
        self.uploads = []
        self.items = [
            {
                "id": str(uuid4()),
                "name": name,
                "category": category,
                "status": "available",
                "confirmed": True,
                "ai_status": "idle",
                "image_url": "/api/images/" + "a" * 32 + "-original.jpg",
                "colors": [],
                "tags": [],
                "wear_count": 0,
            }
            for name, category in (("白色上衣", "top"), ("蓝色裤子", "bottom"), ("运动鞋", "shoes"))
        ]
        self.items[0]["confirmed"] = False
        case = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def send(self, data, status=200, image=False):
                body = data if image else json.dumps(data, ensure_ascii=False).encode()
                self.send_response(status)
                self.send_header("Content-Type", "image/jpeg" if image else "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def handle_request(self):
                raw = self.rfile.read(int(self.headers.get("Content-Length", 0)))
                content_type = self.headers.get("Content-Type", "")
                if content_type.startswith("multipart/form-data"):
                    body = BytesParser(policy=policy.default).parsebytes(
                        f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode() + raw
                    )
                else:
                    body = json.loads(raw) if raw else None
                case.requests.append((self.command, self.path, body))
                if self.path == "/api/ai/device/start" and self.command == "POST":
                    if body not in ({"client": "codex"}, {"client": "claude-code"}):
                        return self.send({}, 409)
                    case.client_name = "Codex" if body["client"] == "codex" else "Claude Code"
                    return self.send(
                        {
                            "device_code": case.device_code,
                            "user_code": "ABCD-EFGH",
                            "expires_in": 300,
                        }
                    )
                if self.path == "/api/ai/device/poll" and self.command == "POST":
                    if body != {"device_code": case.device_code}:
                        return self.send({}, 401)
                    outcome = case.device_outcomes.pop(0)
                    if outcome == 429:
                        return self.send({}, 429)
                    if outcome == "approved":
                        case.active = True
                        case.valid_tokens.add(case.token)
                        return self.send(
                            {"status": "approved", "access_token": case.token, "expires_in": 3600}
                        )
                    return self.send({"status": outcome})
                if self.path == "/api/ai/connect":
                    if not case.used and body == {"code": case.code}:
                        case.used = case.active = True
                        case.valid_tokens.add(case.token)
                        return self.send({"access_token": case.token, "expires_in": 3600})
                    return self.send({}, 401)
                authorization = self.headers.get("Authorization", "")
                token = authorization.removeprefix("Bearer ")
                if not authorization.startswith("Bearer ") or token not in case.valid_tokens:
                    return self.send({}, 401)
                if self.path == "/api/beautify/jobs" and self.command == "GET":
                    return self.send({"jobs": [case.beautify_job]})
                job_path = "/api/beautify/jobs/" + case.beautify_job["job_id"]
                if self.path == job_path + "/claim" and self.command == "POST":
                    if body != {} or case.beautify_claimed:
                        return self.send({}, 409)
                    case.beautify_claimed = True
                    return self.send(
                        {
                            "job_id": case.beautify_job["job_id"],
                            "item_id": case.beautify_job["item_id"],
                            "source_url": "https://untrusted.example/photo.jpg",
                            "prompt": "保留衣物款式，改善光线与背景。",
                            "lease_expires_at": time.time() + 900,
                        }
                    )
                if self.path.startswith(job_path + "/"):
                    if not case.beautify_claimed:
                        return self.send({}, 403)
                    if self.path == job_path + "/source" and self.command == "GET":
                        return self.send(b"fixed-original-photo", image=True)
                    if self.path == job_path + "/result" and self.command == "POST":
                        case.uploads.append({"message": body, "raw": raw, "content_type": content_type})
                        if case.beautify_result_status != 200:
                            return self.send(
                                {"detail": "sensitive server detail"}, case.beautify_result_status
                            )
                        return self.send({"job_id": case.beautify_job["job_id"], "status": "ready"})
                    if self.path == job_path + "/fail" and self.command == "POST":
                        if body != {}:
                            return self.send({}, 422)
                        return self.send({"job_id": case.beautify_job["job_id"], "status": "failed"})
                if self.path == "/api/state":
                    return self.send({"items": case.items, "wear_events": []}, case.state_status)
                if self.path == "/api/ai/connection/verify" and self.command == "POST":
                    if case.verify_status != 200:
                        return self.send({}, case.verify_status)
                    case.verified_tokens.add(token)
                    return self.send(
                        {"connected": True, "client_name": case.client_name, "expires_at": time.time() + 3600}
                    )
                if self.path == "/api/ai/settings":
                    return self.send({"provider": "codex", "configured": True, "has_key": False})
                if self.path == "/api/ai/connection" and self.command == "DELETE":
                    case.valid_tokens.discard(token)
                    case.verified_tokens.discard(token)
                    case.revoked_tokens.add(token)
                    if token == case.token:
                        case.active = False
                    return self.send({"ok": True})
                if self.path.startswith("/api/images/"):
                    return self.send(b"photo-content", image=True)
                if self.path == "/api/outfits":
                    outfit = {**body, "id": str(uuid4())}
                    case.outfits.append(outfit)
                    return self.send(outfit)
                if self.path.startswith("/api/items/") and self.command == "PATCH":
                    for item in case.items:
                        if item["id"] == self.path.rsplit("/", 1)[1]:
                            item.update(body)
                            return self.send(item)
                if self.path == "/api/redirect":
                    self.send_response(302)
                    self.send_header("Location", "/api/unexpected")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                return self.send({}, 404)

            do_GET = handle_request
            do_POST = handle_request
            do_PATCH = handle_request
            do_DELETE = handle_request

        self.http = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop)
        self.server = f"http://127.0.0.1:{self.http.server_port}/api"

    def stop(self):
        self.http.shutdown()
        self.http.server_close()
        self.thread.join(timeout=3)
        self.assertFalse(self.thread.is_alive())

    def connect(self):
        response = bridge.request(self.server, "/ai/connect", method="POST", payload={"code": self.code})
        bridge.complete_connection(self.cache, self.server, response)
        return bridge.load_token(self.cache, self.server)

    def call_main(self, *command):
        output, errors = StringIO(), StringIO()
        with (
            redirect_stdout(output),
            redirect_stderr(errors),
            patch.object(bridge.sys, "stdin", StringIO(self.code + "\n")),
        ):
            status = bridge.main(["--server", self.server, "--cache-dir", str(self.cache), *command])
        text = output.getvalue() + errors.getvalue()
        self.assertNotIn(self.token, text)
        self.assertNotIn(self.code, text)
        self.assertNotIn(self.device_code, text)
        return status, output.getvalue(), errors.getvalue()

    def existing_credentials(self):
        old = secrets.token_urlsafe(24)
        self.valid_tokens.add(old)
        bridge.store_credentials(self.cache, self.server, {"access_token": old, "expires_in": 3600})
        return old, bridge.credential_path(self.cache, self.server).read_bytes()

    def issued_response(self):
        return bridge.request(self.server, "/ai/connect", method="POST", payload={"code": self.code})

    def assert_old_credentials_preserved(self, token, content):
        self.assertEqual(content, bridge.credential_path(self.cache, self.server).read_bytes())
        self.assertEqual(token, bridge.load_token(self.cache, self.server))
        self.assertIn(token, self.valid_tokens)
        self.assertNotIn(token, self.revoked_tokens)
        self.assertNotIn(self.token, self.valid_tokens)
        self.assertIn(self.token, self.revoked_tokens)

    def run_cli(self, *command, stdin=None, expected=0):
        result = subprocess.run(
            [sys.executable, str(CLI), "--server", self.server, "--cache-dir", str(self.cache), *command],
            input=stdin,
            capture_output=True,
            text=True,
            encoding="utf-8",
            env={**os.environ, "PYTHONUTF8": "0"},
            timeout=20,
        )
        self.assertEqual(expected, result.returncode, result.stderr)
        self.assertNotIn(self.token, result.stdout + result.stderr)
        self.assertNotIn(self.code, result.stdout + result.stderr)
        return json.loads(result.stdout) if result.stdout else None

    def test_real_cli_connect_read_photo_tag_save_and_revoke(self):
        self.items[0]["name"] = "蓝色上衣 👕"
        connected = self.run_cli("connect", "--code-stdin", stdin=self.code + "\n")
        self.assertTrue(connected["connected"])
        self.assertEqual(len(self.items), connected["wardrobe_items"])
        self.assertIn(self.token, self.verified_tokens)
        saved = bridge.credential_path(self.cache, self.server)
        if sys.platform == "win32":
            self.assertNotIn(self.token, saved.read_text())
        self.assertTrue(self.run_cli("status")["configured"])
        self.assertEqual(1, self.run_cli("list", "--pending")["total"])
        output = Path(self.temp.name) / "image.jpg"
        self.run_cli("download", self.items[0]["id"], "--output", str(output))
        self.assertEqual(b"photo-content", output.read_bytes())
        labels = Path(self.temp.name) / "labels.json"
        labels.write_text(
            json.dumps({"category": "top", "name": "短袖上衣", "tags": ["圆领"]}, ensure_ascii=False),
            encoding="utf-8",
        )
        self.run_cli("tag", self.items[0]["id"], "--file", str(labels))
        self.assertFalse(self.items[0]["confirmed"])
        self.run_cli("tag", self.items[0]["id"], "--file", str(labels), "--confirm")
        self.assertTrue(self.items[0]["confirmed"])
        outfit = Path(self.temp.name) / "outfit.json"
        outfit.write_text(
            json.dumps({"name": "日常搭配", "item_ids": [item["id"] for item in self.items]}),
            encoding="utf-8",
        )
        self.run_cli("save-outfit", "--file", str(outfit))
        self.assertEqual("assistant", self.outfits[0]["source"])
        self.assertEqual(0, sum(item["wear_count"] for item in self.items))
        self.run_cli("disconnect")
        self.assertFalse(saved.exists())
        self.assertFalse(self.active)
        self.assertFalse(any("/wear" in path for _, path, _ in self.requests))

    def test_preflight_failure_does_not_issue_token_or_start_device_pairing(self):
        for command in (("connect", "--code-stdin"), ("connect",)):
            with (
                self.subTest(command=command),
                patch.object(bridge, "preflight_credentials", side_effect=bridge.BridgeError("缓存不可写")),
            ):
                status, output, error = self.call_main(*command)
                self.assertEqual(1, status)
                self.assertEqual("", output)
                self.assertIn("缓存不可写", error)
                self.assertEqual([], self.requests)
                self.assertFalse(self.active)
                self.assertFalse(self.used)

    def test_preflight_roundtrip_leaves_existing_credentials_unchanged(self):
        old, before = self.existing_credentials()
        bridge.preflight_credentials(self.cache)
        self.assertEqual(before, bridge.credential_path(self.cache, self.server).read_bytes())
        self.assertEqual(old, bridge.load_token(self.cache, self.server))
        self.assertFalse(list(self.cache.glob(".write-check-*")))
        self.assertEqual([], self.requests)

    def test_atomic_save_failure_revokes_new_token_and_preserves_old_credentials(self):
        old, before = self.existing_credentials()
        response = self.issued_response()
        with patch.object(bridge.os, "replace", side_effect=PermissionError("cache denied")):
            with self.assertRaises(PermissionError):
                bridge.complete_connection(self.cache, self.server, response)
        self.assert_old_credentials_preserved(old, before)
        self.assertFalse(list(self.cache.glob("*.tmp")))
        self.assertFalse(any(path == "/api/ai/connection/verify" for _, path, _ in self.requests))

    def test_cache_decryption_failure_revokes_new_token_and_restores_old_credentials(self):
        old, before = self.existing_credentials()
        response = self.issued_response()
        with patch.object(bridge, "load_token", side_effect=bridge.BridgeError("wrong identity")):
            with self.assertRaises(bridge.BridgeError):
                bridge.complete_connection(self.cache, self.server, response)
        self.assert_old_credentials_preserved(old, before)

    def test_unreadable_previous_cache_revokes_new_token_without_changing_the_file(self):
        old, before = self.existing_credentials()
        response = self.issued_response()
        previous = bridge.credential_path(self.cache, self.server)
        read_bytes = Path.read_bytes

        def unreadable(path):
            if path == previous:
                raise PermissionError("existing credential cannot be read")
            return read_bytes(path)

        with patch.object(Path, "read_bytes", unreadable):
            with self.assertRaises((PermissionError, bridge.BridgeError)):
                bridge.complete_connection(self.cache, self.server, response)
        self.assert_old_credentials_preserved(old, before)

    def test_state_read_failure_revokes_new_token_and_restores_old_credentials(self):
        old, before = self.existing_credentials()
        response = self.issued_response()
        self.state_status = 503
        with self.assertRaises(bridge.BridgeError):
            bridge.complete_connection(self.cache, self.server, response)
        self.assert_old_credentials_preserved(old, before)
        self.assertFalse(any(path == "/api/ai/connection/verify" for _, path, _ in self.requests))

    def test_verify_failure_revokes_new_token_and_restores_old_credentials(self):
        old, before = self.existing_credentials()
        response = self.issued_response()
        self.verify_status = 403
        with self.assertRaises(bridge.BridgeError):
            bridge.complete_connection(self.cache, self.server, response)
        self.assert_old_credentials_preserved(old, before)
        self.assertEqual(
            [("GET", "/api/state"), ("POST", "/api/ai/connection/verify"), ("DELETE", "/api/ai/connection")],
            [(method, path) for method, path, _ in self.requests[1:]],
        )

    def test_initial_verification_failure_removes_unusable_new_credentials(self):
        response = self.issued_response()
        self.verify_status = 503
        with self.assertRaises(bridge.BridgeError):
            bridge.complete_connection(self.cache, self.server, response)
        self.assertFalse(bridge.credential_path(self.cache, self.server).exists())
        self.assertFalse(self.active)
        self.assertIn(self.token, self.revoked_tokens)

    def test_failed_connection_does_not_overwrite_a_concurrent_connection(self):
        response = self.issued_response()
        concurrent = secrets.token_urlsafe(24)
        self.valid_tokens.add(concurrent)

        def replace_during_reload(cache, server):
            bridge.store_credentials(cache, server, {"access_token": concurrent, "expires_in": 3600})
            return concurrent

        with patch.object(bridge, "load_token", side_effect=replace_during_reload):
            with self.assertRaises(bridge.BridgeError):
                bridge.complete_connection(self.cache, self.server, response)
        self.assertEqual(concurrent, bridge.load_token(self.cache, self.server))
        self.assertIn(concurrent, self.valid_tokens)
        self.assertNotIn(concurrent, self.revoked_tokens)
        self.assertIn(self.token, self.revoked_tokens)

    def test_concurrent_write_before_cache_reload_is_not_rolled_back(self):
        self.existing_credentials()
        response = self.issued_response()
        concurrent = secrets.token_urlsafe(24)
        self.valid_tokens.add(concurrent)
        store = bridge.store_credentials
        concurrent_bytes = None

        def replaced_before_return(cache, server, connection):
            nonlocal concurrent_bytes
            own_bytes = store(cache, server, connection)
            store(cache, server, {"access_token": concurrent, "expires_in": 3600})
            concurrent_bytes = bridge.credential_path(cache, server).read_bytes()
            return own_bytes

        with patch.object(bridge, "store_credentials", side_effect=replaced_before_return):
            with self.assertRaises(bridge.BridgeError):
                bridge.complete_connection(self.cache, self.server, response)
        self.assertEqual(concurrent_bytes, bridge.credential_path(self.cache, self.server).read_bytes())
        self.assertEqual(concurrent, bridge.load_token(self.cache, self.server))
        self.assertIn(concurrent, self.valid_tokens)
        self.assertNotIn(concurrent, self.revoked_tokens)
        self.assertIn(self.token, self.revoked_tokens)

    def test_successful_reconnect_retires_previous_token_after_verifying_new_one(self):
        old, _ = self.existing_credentials()
        response = self.issued_response()
        result = bridge.complete_connection(self.cache, self.server, response)
        self.assertTrue(result["connected"])
        self.assertEqual(self.token, bridge.load_token(self.cache, self.server))
        self.assertIn(self.token, self.verified_tokens)
        self.assertIn(self.token, self.valid_tokens)
        self.assertNotIn(self.token, self.revoked_tokens)
        self.assertNotIn(old, self.valid_tokens)
        self.assertIn(old, self.revoked_tokens)
        self.assertEqual(
            [
                ("POST", "/api/ai/connect"),
                ("GET", "/api/state"),
                ("POST", "/api/ai/connection/verify"),
                ("DELETE", "/api/ai/connection"),
            ],
            [(method, path) for method, path, _ in self.requests],
        )
        bridge.request(self.server, "/ai/connection", token=self.token, method="DELETE")
        self.assertEqual(set(), self.valid_tokens)

    def test_connect_lock_conflict_preserves_cache_and_revokes_new_token(self):
        old, before = self.existing_credentials()
        response = self.issued_response()
        with bridge.credential_lock(self.cache, self.server):
            with self.assertRaises(bridge.BridgeError):
                bridge.complete_connection(self.cache, self.server, response)
            self.assert_old_credentials_preserved(old, before)
        self.assertEqual(
            [("POST", "/api/ai/connect"), ("DELETE", "/api/ai/connection")],
            [(method, path) for method, path, _ in self.requests],
        )
        with bridge.credential_lock(self.cache, self.server):
            self.assertEqual(before, bridge.credential_path(self.cache, self.server).read_bytes())

    def test_disconnect_lock_conflict_does_not_revoke_or_remove_credentials(self):
        old, before = self.existing_credentials()
        with bridge.credential_lock(self.cache, self.server):
            status, _, error = self.call_main("disconnect")
            self.assertEqual(1, status)
            self.assertIn("另一条连接", error)
            self.assertEqual(before, bridge.credential_path(self.cache, self.server).read_bytes())
            self.assertIn(old, self.valid_tokens)
            self.assertEqual([], self.requests)
        status, _, error = self.call_main("disconnect")
        self.assertEqual(0, status, error)
        self.assertNotIn(old, self.valid_tokens)
        self.assertFalse(bridge.credential_path(self.cache, self.server).exists())

    def test_status_verifies_access_before_reading_connection_settings(self):
        self.connect()
        self.requests.clear()
        result = self.run_cli("status")
        self.assertTrue(result["connected"])
        self.assertEqual(len(self.items), result["wardrobe_items"])
        self.assertEqual(
            [("GET", "/api/state"), ("POST", "/api/ai/connection/verify"), ("GET", "/api/ai/settings")],
            [(method, path) for method, path, _ in self.requests],
        )

    def test_device_connect_waits_for_approval_then_reads_and_verifies(self):
        with patch.object(bridge.time, "sleep"):
            status, output, error = self.call_main("connect", "--client", "claude-code")
        self.assertEqual(0, status, error)
        self.assertIn("Claude Code", output)
        self.assertIn("ABCD-EFGH", output)
        connected = json.loads(output[output.index("{\n") :])
        self.assertTrue(connected["connected"])
        self.assertEqual("Claude Code", connected["client_name"])
        self.assertEqual(self.token, bridge.load_token(self.cache, self.server))
        self.assertIn(self.token, self.verified_tokens)
        self.assertEqual(
            [
                ("POST", "/api/ai/device/start"),
                ("POST", "/api/ai/device/poll"),
                ("POST", "/api/ai/device/poll"),
                ("GET", "/api/state"),
                ("POST", "/api/ai/connection/verify"),
            ],
            [(method, path) for method, path, _ in self.requests],
        )
        self.assertEqual({"client": "claude-code"}, self.requests[0][2])

    def test_device_connect_retries_rate_limited_poll_without_starting_new_pairing(self):
        self.device_outcomes = [429, "approved"]
        with patch.object(bridge.time, "sleep"):
            status, _, error = self.call_main("connect")
        self.assertEqual(0, status, error)
        self.assertEqual(1, sum(path == "/api/ai/device/start" for _, path, _ in self.requests))
        self.assertEqual(2, sum(path == "/api/ai/device/poll" for _, path, _ in self.requests))
        self.assertIn(self.token, self.verified_tokens)

    def test_pairing_is_one_time_and_http_errors_do_not_expose_response(self):
        self.connect()
        with self.assertRaises(bridge.BridgeError):
            bridge.request(self.server, "/ai/connect", method="POST", payload={"code": self.code})
        with self.assertRaises(bridge.BridgeError):
            bridge.request(self.server, "/state", token="wrong-token")

    def test_redirects_never_forward_credentials(self):
        token = self.connect()
        with self.assertRaises(bridge.BridgeError):
            bridge.request(self.server, "/redirect", token=token)
        self.assertFalse(any(path == "/api/unexpected" for _, path, _ in self.requests))

    def test_external_and_traversal_images_are_rejected(self):
        token = self.connect()
        for address in (
            "https://elsewhere.test/api/images/" + "a" * 32 + "-original.jpg",
            "/api/images/../ai/settings",
            "/api/images/" + "a" * 32 + "-original.jpg?token=x",
        ):
            self.items[0]["image_url"] = address
            with self.assertRaises(bridge.BridgeError):
                bridge.download_item(
                    self.server, token, self.items[0]["id"], Path(self.temp.name) / "image.jpg"
                )
        self.assertFalse(any(path.startswith("/api/images") for _, path, _ in self.requests))

    def test_real_cli_beautify_claim_fixed_source_and_multipart_result(self):
        self.connect()
        self.requests.clear()
        job_id = self.beautify_job["job_id"]
        listed = self.run_cli("beautify-list")
        self.assertEqual(job_id, listed["jobs"][0]["job_id"])
        claimed = self.run_cli("beautify-claim", job_id)
        self.assertEqual(job_id, claimed["job_id"])
        self.assertIn("保留衣物", claimed["prompt"])
        original = Path(self.temp.name) / "original.jpg"
        downloaded = self.run_cli("beautify-download", job_id, "--output", str(original))
        self.assertEqual(str(original.resolve()), downloaded["path"])
        self.assertEqual(b"fixed-original-photo", original.read_bytes())
        generated = Path(self.temp.name) / "商品效果.png"
        content = b"\x89PNG\r\n\x1a\n\x00\xff\x80image-payload\r\n"
        generated.write_bytes(content)
        result = self.run_cli("beautify-submit", job_id, "--file", str(generated))
        self.assertEqual("ready", result["status"])
        self.assertEqual(
            [
                ("GET", "/api/beautify/jobs"),
                ("POST", f"/api/beautify/jobs/{job_id}/claim"),
                ("GET", f"/api/beautify/jobs/{job_id}/source"),
                ("POST", f"/api/beautify/jobs/{job_id}/result"),
            ],
            [(method, path) for method, path, _ in self.requests],
        )

        upload = self.uploads[0]
        parts = list(upload["message"].iter_parts())
        self.assertEqual(1, len(parts))
        self.assertEqual("file", parts[0].get_param("name", header="Content-Disposition"))
        self.assertEqual("beautified.png", parts[0].get_filename())
        self.assertEqual("image/png", parts[0].get_content_type())
        self.assertEqual(content, parts[0].get_payload(decode=True))
        boundary = upload["message"].get_boundary().encode()
        self.assertTrue(upload["raw"].startswith(b"--" + boundary + b"\r\n"))
        self.assertTrue(upload["raw"].endswith(b"\r\n--" + boundary + b"--\r\n"))

    def test_detailed_labels_preserve_known_materials_without_visible_evidence(self):
        self.connect()
        self.items[0].update(materials=["棉"], fit="宽松", size="M", care_notes="手洗")
        result = bridge.tag_item(
            self.server,
            self.token,
            self.items[0]["id"],
            {
                "category": "top",
                "subcategory": "T恤",
                "styles": ["极简"],
                "pattern": "纯色",
                "materials": ["聚酯纤维"],
                "fit": "",
            },
        )
        self.assertEqual(["棉"], result["materials"])
        self.assertEqual("宽松", result["fit"])
        self.assertEqual("M", result["size"])
        self.assertEqual("手洗", result["care_notes"])
        self.assertEqual("T恤", result["subcategory"])
        self.assertEqual(["极简"], result["styles"])
        result = bridge.tag_item(
            self.server,
            self.token,
            self.items[0]["id"],
            {
                "category": "top",
                "materials": ["亚麻"],
                "materials_evidence": "100% linen",
            },
        )
        self.assertEqual(["亚麻"], result["materials"])
        self.assertNotIn("materials_evidence", result)

    def test_blank_detailed_labels_preserve_existing_attributes(self):
        self.connect()
        existing = {
            "brand": "已有品牌",
            "subcategory": "T恤",
            "pattern": "纯色",
            "fit": "宽松",
            "cut": "直筒",
            "neckline": "圆领",
            "sleeve_length": "短袖",
            "length": "常规",
            "styles": ["极简"],
            "materials": ["棉"],
        }
        self.items[0].update(existing)
        for blank in ("", " \t\n "):
            with self.subTest(blank=blank):
                payload = {
                    field: [blank] if isinstance(value, list) else blank for field, value in existing.items()
                }
                result = bridge.tag_item(
                    self.server,
                    self.token,
                    self.items[0]["id"],
                    {"category": "top", **payload, "materials_evidence": "100% cotton"},
                )
                self.assertEqual(existing, {field: result[field] for field in existing})
        result = bridge.tag_item(
            self.server,
            self.token,
            self.items[0]["id"],
            {"category": "top", "brand": " 新品牌 ", "styles": [" ", " 休闲 ", ""]},
        )
        self.assertEqual("新品牌", result["brand"])
        self.assertEqual(["休闲"], result["styles"])

    def test_materials_require_nonblank_text_evidence(self):
        self.connect()
        self.items[0]["materials"] = ["棉"]
        for evidence in (None, True, 1, ["100% linen"], {"label": "100% linen"}, " \t\n "):
            with self.subTest(evidence=evidence):
                result = bridge.tag_item(
                    self.server,
                    self.token,
                    self.items[0]["id"],
                    {"category": "top", "materials": ["亚麻"], "materials_evidence": evidence},
                )
                self.assertEqual(["棉"], result["materials"])
                self.assertNotIn("materials_evidence", result)

    def test_beautify_download_preserves_existing_file_and_requires_claim(self):
        token = self.connect()
        destination = Path(self.temp.name) / "original.jpg"
        with self.assertRaises(bridge.BridgeError):
            bridge.download_beautify(self.server, token, self.beautify_job["job_id"], destination)
        self.assertFalse(destination.exists())
        self.beautify_claimed = True
        destination.write_bytes(b"existing-file")
        with self.assertRaises(FileExistsError):
            bridge.download_beautify(self.server, token, self.beautify_job["job_id"], destination)
        self.assertEqual(b"existing-file", destination.read_bytes())

    def test_beautify_fail_submits_no_private_error_details(self):
        self.connect()
        self.beautify_claimed = True
        self.requests.clear()
        result = self.run_cli("beautify-fail", self.beautify_job["job_id"])
        self.assertEqual("failed", result["status"])
        self.assertEqual({}, self.requests[0][2])

    def test_beautify_stale_result_is_reported_as_failure(self):
        self.connect()
        self.beautify_claimed = True
        self.beautify_result_status = 409
        picture = Path(self.temp.name) / "generated.jpg"
        picture.write_bytes(b"\xff\xd8\xfftest-payload")
        status, output, error = self.call_main(
            "beautify-submit", self.beautify_job["job_id"], "--file", str(picture)
        )
        self.assertEqual(1, status)
        self.assertEqual("", output)
        self.assertIn("任务状态或连接已变化", error)
        self.assertNotIn("sensitive server detail", error)

    def test_beautify_invalid_identifiers_never_make_requests(self):
        self.connect()
        self.requests.clear()
        for command in ("beautify-claim", "beautify-fail"):
            for identifier in ("../state", self.beautify_job["job_id"] + "?x=1", "https://elsewhere.test"):
                status, _, _ = self.call_main(command, identifier)
                self.assertEqual(1, status)
        self.assertEqual([], self.requests)

    def test_adopted_beautified_image_can_be_downloaded_for_recognition(self):
        token = self.connect()
        self.items[0]["image_url"] = "/api/images/" + "b" * 32 + "-beautified.jpg"
        destination = Path(self.temp.name) / "image.jpg"
        bridge.download_item(self.server, token, self.items[0]["id"], destination)
        self.assertEqual(b"photo-content", destination.read_bytes())

    def test_unknown_id_cannot_read_or_label(self):
        token = self.connect()
        with self.assertRaises(bridge.BridgeError):
            bridge.tag_item(self.server, token, str(uuid4()), {"category": "top"})
        self.assertFalse(any(method == "PATCH" for method, _, _ in self.requests))

    def test_unavailable_unconfirmed_or_unknown_items_cannot_save(self):
        token = self.connect()
        payload = {"name": "测试搭配", "item_ids": [item["id"] for item in self.items]}
        with self.assertRaises(bridge.BridgeError):
            bridge.save_outfit(self.server, token, payload)
        self.items[0]["confirmed"] = True
        for status in ("laundry", "archived"):
            self.items[0]["status"] = status
            with self.assertRaises(bridge.BridgeError):
                bridge.save_outfit(self.server, token, payload)
        self.items[0]["status"] = "available"
        self.items[0]["ai_status"] = "processing"
        with self.assertRaises(bridge.BridgeError):
            bridge.save_outfit(self.server, token, payload)
        self.items[0]["ai_status"] = "idle"
        with self.assertRaises(bridge.BridgeError):
            bridge.save_outfit(self.server, token, {**payload, "item_ids": [str(uuid4())]})
        self.assertEqual([], self.outfits)

    def test_processing_item_labels_are_not_overwritten(self):
        token = self.connect()
        self.items[0]["ai_status"] = "processing"
        with self.assertRaises(bridge.BridgeError):
            bridge.tag_item(self.server, token, self.items[0]["id"], {"category": "top"})
        self.assertFalse(any(method == "PATCH" for method, _, _ in self.requests))

    def test_expired_and_overlong_credentials_rejected(self):
        self.connect()
        with patch.object(bridge.time, "time", return_value=time.time() + 3601):
            with self.assertRaises(bridge.BridgeError):
                bridge.load_token(self.cache, self.server)
        for lifetime in (float("nan"), -1, 3601, True):
            with self.assertRaises(bridge.BridgeError):
                bridge.store_credentials(
                    self.cache, self.server, {"access_token": "x", "expires_in": lifetime}
                )


class AssistantSafetyTests(unittest.TestCase):
    def test_image_upload_checks_content_and_size_before_http(self):
        with tempfile.TemporaryDirectory() as directory:
            picture = Path(directory) / "generated.png"
            for content in (b"", b"not an image", b"<svg></svg>"):
                picture.write_bytes(content)
                with self.assertRaises(bridge.BridgeError):
                    bridge.image_multipart(picture)
            picture.write_bytes(b"\x89PNG\r\n\x1a\n" + b"x" * 20)
            with patch.object(bridge, "MAX_IMAGE_UPLOAD", 16):
                with self.assertRaises(bridge.BridgeError):
                    bridge.image_multipart(picture)

    def test_image_multipart_avoids_content_boundary_collisions_and_uses_actual_type(self):
        with tempfile.TemporaryDirectory() as directory:
            picture = Path(directory) / "generated.png"
            for content, content_type, filename in (
                (b"\xff\xd8\xffjpeg", "image/jpeg", "beautified.jpg"),
                (b"RIFF\x00\x00\x00\x00WEBPpayload", "image/webp", "beautified.webp"),
                (b"\x89PNG\r\n\x1a\nyijian-" + b"a" * 48, "image/png", "beautified.png"),
            ):
                picture.write_bytes(content)
                with patch.object(bridge.secrets, "token_hex", side_effect=["a" * 48, "b" * 48]):
                    body, boundary = bridge.image_multipart(picture)
                message = BytesParser(policy=policy.default).parsebytes(
                    f"Content-Type: multipart/form-data; boundary={boundary}\r\n\r\n".encode() + body
                )
                part = list(message.iter_parts())[0]
                self.assertEqual(content, part.get_payload(decode=True))
                self.assertEqual(content_type, part.get_content_type())
                self.assertEqual(filename, part.get_filename())

    def test_server_address_constraints(self):
        self.assertEqual("http://127.0.0.1:3110/api", bridge.normalize_server("http://127.0.0.1:3110"))
        self.assertEqual("https://yijian.example/api", bridge.normalize_server("https://yijian.example/api/"))
        for server in (
            "http://example.com",
            "http://192.168.1.3",
            "https://user:secret@example.com",
            "https://example.com/api/v1",
            "https://example.com/?secret=x",
            "file:///tmp/data",
            "http://localhost:bad",
        ):
            with self.assertRaises(bridge.BridgeError):
                bridge.normalize_server(server)

    def test_payload_rejects_confirmation_source_and_extra_fields(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "payload.json"
            for payload, allowed in (
                ({"category": "top", "confirmed": True}, bridge.TAG_FIELDS),
                ({"category": "top", "size": "M"}, bridge.TAG_FIELDS),
                ({"category": "top", "care_notes": "手洗"}, bridge.TAG_FIELDS),
                ({"name": "搭配", "source": "manual"}, bridge.OUTFIT_FIELDS),
            ):
                path.write_text(json.dumps(payload), encoding="utf-8")
                with self.assertRaises(bridge.BridgeError):
                    bridge.read_payload(path, allowed)

    def test_installer_preserves_changes_and_copies_self_contained_skill(self):
        source = CLI.parents[1]
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory).resolve() / ".agents/skills/yijian"
            first = installer.install(source, target)
            self.assertTrue(first["changed"])
            self.assertTrue((target / "SKILL.md").exists())
            self.assertEqual(installer.files(source), installer.files(target))
            self.assertFalse(installer.install(source, target)["changed"])
            (target / "SKILL.md").write_text("personal edit", encoding="utf-8")
            with self.assertRaises(ValueError):
                installer.install(source, target)
            result = installer.install(source, target, replace=True)
            backup = Path(result["backup"])
            self.assertEqual(target.parent.parent / ".yijian-skill-backups", backup.parent)
            self.assertFalse(backup.is_relative_to(target.parent))
            self.assertEqual("personal edit", (backup / "SKILL.md").read_text())
            self.assertEqual(installer.files(source), installer.files(target))
            self.assertEqual([target / "SKILL.md"], list(target.parent.glob("*/SKILL.md")))
            (target / "SKILL.md").write_text("another personal edit", encoding="utf-8")
            another = Path(installer.install(source, target, replace=True)["backup"])
            self.assertNotEqual(backup, another)
            self.assertFalse(another.is_relative_to(target.parent))
            self.assertEqual("personal edit", (backup / "SKILL.md").read_text())
            self.assertEqual("another personal edit", (another / "SKILL.md").read_text())
            with self.assertRaises(ValueError):
                installer.install(source, source)

    def test_custom_installation_keeps_an_adjacent_backup(self):
        source = CLI.parents[1]
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory).resolve() / "custom-location/yijian"
            installer.install(source, target)
            (target / "SKILL.md").write_text("Custom instructions", encoding="utf-8")
            before = installer.files(target)
            backup = Path(installer.install(source, target, replace=True)["backup"])
            self.assertEqual(target.parent, backup.parent)
            self.assertNotEqual(target, backup)
            self.assertEqual(before, installer.files(backup))
            self.assertEqual(installer.files(source), installer.files(target))

    def test_installation_failure_rolls_back_the_original_skill_from_either_backup_location(self):
        source = CLI.parents[1]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            for location in (".agents/skills/yijian", "custom-location/yijian"):
                with self.subTest(location=location):
                    target = root / location
                    installer.install(source, target)
                    (target / "SKILL.md").write_text("Keep my original instructions", encoding="utf-8")
                    (target / "notes.txt").write_text("Keep my notes", encoding="utf-8")
                    before = installer.files(target)
                    rename = Path.rename
                    backups = []

                    def fail_staged_install(path, destination):
                        if path.name.startswith(".yijian-install-") and destination == target:
                            raise OSError("destination temporarily unavailable")
                        if path == target:
                            backups.append(destination)
                        return rename(path, destination)

                    with patch.object(Path, "rename", fail_staged_install):
                        with self.assertRaises(OSError):
                            installer.install(source, target, replace=True)
                    self.assertEqual(before, installer.files(target))
                    self.assertEqual(1, len(backups))
                    self.assertFalse(backups[0].exists())


if __name__ == "__main__":
    unittest.main()


def native_assistant(tmp_path):
    from fastapi.testclient import TestClient
    from server.main import create_app

    client = TestClient(create_app(tmp_path / "native-workspace"))
    client.__enter__()
    try:
        assert client.post("/api/session", json={"code": client.app.state.bootstrap_code}).status_code == 200
        assert client.put("/api/ai/settings", json={"provider": "codex"}).status_code == 200
        code = client.post("/api/ai/connection-code").json()["code"]
        token = client.post("/api/ai/connect", json={"code": code}).json()["access_token"]
        items = []
        for category in ("top", "bottom", "shoes"):
            response = client.post(
                "/api/items", json={"category": category, "name": category, "confirmed": True}
            )
            assert response.status_code == 200
            items.append(response.json()["id"])
        return client, {"Authorization": "Bearer " + token}, items
    except BaseException:
        client.__exit__(None, None, None)
        raise


def test_native_assistant_cannot_bypass_completeness_by_claiming_manual_source(tmp_path):
    client, headers, ids = native_assistant(tmp_path)
    try:
        for source in ("manual", "assistant", "rules", "ai"):
            response = client.post(
                "/api/outfits",
                headers=headers,
                json={"name": "不完整建议", "item_ids": ids[:1], "source": source},
            )
            assert response.status_code == 422
        manual = client.post(
            "/api/outfits", json={"name": "局部组合", "item_ids": ids[:1], "source": "manual"}
        )
        assert manual.status_code == 200
        updated = client.patch(
            "/api/outfits/" + manual.json()["id"],
            headers=headers,
            json={"item_ids": ids[:1], "source": "manual"},
        )
        assert updated.status_code == 422
        complete = client.post(
            "/api/outfits", headers=headers, json={"name": "完整搭配", "item_ids": ids, "source": "assistant"}
        )
        assert complete.status_code == 200
    finally:
        client.__exit__(None, None, None)


def test_native_assistant_respects_exclusions_pairs_and_closet_scope(tmp_path):
    client, headers, ids = native_assistant(tmp_path)
    try:
        outfit = {"name": "已选搭配", "item_ids": ids, "source": "manual"}
        saved = client.post("/api/outfits", json=outfit).json()
        for preferences in (
            {"excluded_ids": [ids[0]]},
            {"excluded_ids": [], "blocked_pairs": [ids[:2]]},
            {"blocked_pairs": [], "closet_scope": "其他衣橱"},
        ):
            assert client.patch("/api/settings", json={"preferences": preferences}).status_code == 200
            assert client.post("/api/outfits", headers=headers, json=outfit).status_code == 409
            assert (
                client.patch("/api/outfits/" + saved["id"], headers=headers, json=outfit).status_code == 409
            )
        assert client.patch("/api/settings", json={"preferences": {"closet_scope": "all"}}).status_code == 200
        assert client.post("/api/outfits", headers=headers, json=outfit).status_code == 200
    finally:
        client.__exit__(None, None, None)


def test_native_assistant_rejects_unconfirmed_or_unavailable_garments(tmp_path):
    client, headers, ids = native_assistant(tmp_path)
    try:
        outfit = {"name": "待验证搭配", "item_ids": ids, "source": "manual"}
        for state in ({"confirmed": False}, {"confirmed": True, "status": "laundry"}, {"status": "archived"}):
            assert client.patch("/api/items/" + ids[0], json=state).status_code == 200
            assert client.post("/api/outfits", headers=headers, json=outfit).status_code == 409
        assert client.patch("/api/items/" + ids[0], json={"status": "available"}).status_code == 200
        assert client.post("/api/outfits", headers=headers, json=outfit).status_code == 200
    finally:
        client.__exit__(None, None, None)


def test_native_assistant_cannot_create_browser_cookie_or_change_model_settings(tmp_path):
    from fastapi.testclient import TestClient

    client, headers, _ = native_assistant(tmp_path)
    try:
        with TestClient(client.app) as assistant:
            denied = assistant.post("/api/session", headers=headers, json={})
            assert denied.status_code == 401
            assert "set-cookie" not in denied.headers
            assert assistant.get("/api/state", headers=headers).status_code == 200
            assert (
                assistant.put("/api/ai/settings", headers=headers, json={"provider": "none"}).status_code
                == 403
            )
    finally:
        client.__exit__(None, None, None)
