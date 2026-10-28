import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
import uuid
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SERVER = ROOT / "server.py"


class PlannerServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp_directory = tempfile.TemporaryDirectory(prefix="daylight-test-")
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            cls.port = sock.getsockname()[1]
        cls.base_url = f"http://127.0.0.1:{cls.port}"
        cls.process = None
        cls.start_server()

    @classmethod
    def tearDownClass(cls):
        cls.stop_server()
        cls.temp_directory.cleanup()

    @classmethod
    def start_server(cls):
        environment = os.environ.copy()
        environment["HOST"] = "127.0.0.1"
        environment["PORT"] = str(cls.port)
        environment["DAYLIGHT_DATA_DIR"] = cls.temp_directory.name
        cls.process = subprocess.Popen(
            [sys.executable, str(SERVER)],
            cwd=ROOT,
            env=environment,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if cls.process.poll() is not None:
                raise RuntimeError("The Daylight test server exited before becoming ready.")
            try:
                with urllib.request.urlopen(f"{cls.base_url}/api/health", timeout=1) as response:
                    if response.status == 200:
                        return
            except (OSError, urllib.error.URLError):
                time.sleep(0.1)
        cls.stop_server()
        raise RuntimeError("The Daylight test server did not start in time.")

    @classmethod
    def stop_server(cls):
        process = getattr(cls, "process", None)
        if process and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        cls.process = None

    @classmethod
    def request_document(cls, user_id, method="GET", document=None):
        headers = {"X-User-ID": str(user_id)}
        data = None
        if document is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(document).encode("utf-8")
        request = urllib.request.Request(
            f"{cls.base_url}/api/tasks",
            data=data,
            headers=headers,
            method=method,
        )
        with urllib.request.urlopen(request, timeout=5) as response:
            return response.status, json.loads(response.read())

    def test_planner_data_and_theme_survive_server_restart(self):
        user_id = uuid.uuid4()
        document = {
            "tasks": [{
                "id": "coffee-with-maya",
                "title": "Coffee with Maya",
                "date": "2026-11-03",
                "time": "10:00",
                "category": "Personal",
                "priority": "high",
                "duration": 30,
                "reminder": 10,
                "completed": False,
            }],
            "reminderState": {"coffee-with-maya": "2026-11-03T10:00"},
            "theme": "lavender",
        }
        status, saved = self.request_document(user_id, method="PUT", document=document)
        self.assertEqual(status, 200)
        self.assertTrue(saved["saved"])

        self.stop_server()
        self.start_server()

        status, restored = self.request_document(user_id)
        self.assertEqual(status, 200)
        self.assertTrue(restored["exists"])
        self.assertEqual(restored["tasks"], document["tasks"])
        self.assertEqual(restored["reminderState"], document["reminderState"])
        self.assertEqual(restored["theme"], "lavender")

    def test_planner_data_is_isolated_by_random_browser_identity(self):
        owner_id = uuid.uuid4()
        other_id = uuid.uuid4()
        self.request_document(
            owner_id,
            method="PUT",
            document={"tasks": [], "reminderState": {}, "theme": "ocean"},
        )

        _, owner = self.request_document(owner_id)
        _, other = self.request_document(other_id)

        self.assertEqual(owner["theme"], "ocean")
        self.assertFalse(other["exists"])
        self.assertEqual(other["tasks"], [])

    def test_database_and_private_repository_files_are_not_public(self):
        for path in ("/data/daylight.sqlite3", "/server.py", "/README.md"):
            with self.subTest(path=path):
                request = urllib.request.Request(f"{self.base_url}{path}")
                with self.assertRaises(urllib.error.HTTPError) as error:
                    urllib.request.urlopen(request, timeout=5)
                self.assertEqual(error.exception.code, 404)
                error.exception.close()

        with urllib.request.urlopen(f"{self.base_url}/app.js", timeout=5) as response:
            self.assertEqual(response.status, 200)
            self.assertIn(b"initializeDatabase();", response.read())
        with urllib.request.urlopen(f"{self.base_url}/", timeout=5) as response:
            page = response.read()
            self.assertIn(b'id="theme-select"', page)
            self.assertIn(b'id="storage-status"', page)
        with urllib.request.urlopen(f"{self.base_url}/styles.css", timeout=5) as response:
            self.assertIn(b'data-theme="lavender"', response.read())

    def test_invalid_update_does_not_replace_saved_data(self):
        user_id = uuid.uuid4()
        original = {"tasks": [], "reminderState": {}, "theme": "fern"}
        self.request_document(user_id, method="PUT", document=original)
        invalid = {
            "tasks": [{
                "id": "invalid-task",
                "title": "Invalid task",
                "date": "2026-02-31",
                "time": "10:00",
                "category": "Work",
                "priority": "high",
                "duration": 30,
                "reminder": 5,
                "completed": False,
            }],
            "reminderState": {},
            "theme": "sunset",
        }
        request = urllib.request.Request(
            f"{self.base_url}/api/tasks",
            data=json.dumps(invalid).encode("utf-8"),
            headers={"X-User-ID": str(user_id), "Content-Type": "application/json"},
            method="PUT",
        )
        with self.assertRaises(urllib.error.HTTPError) as error:
            urllib.request.urlopen(request, timeout=5)
        self.assertEqual(error.exception.code, 400)
        error.exception.close()
        _, restored = self.request_document(user_id)
        self.assertEqual(restored["theme"], "fern")
        self.assertEqual(restored["tasks"], [])

    def test_database_requires_a_valid_browser_identity(self):
        request = urllib.request.Request(f"{self.base_url}/api/tasks")
        with self.assertRaises(urllib.error.HTTPError) as error:
            urllib.request.urlopen(request, timeout=5)
        self.assertEqual(error.exception.code, 401)
        error.exception.close()


if __name__ == "__main__":
    unittest.main()
