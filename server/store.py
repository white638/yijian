from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Callable, TypeVar

T = TypeVar("T")


def initial_state() -> dict:
    return {
        "schema_version": 1,
        "settings": {
            "name": "",
            "onboarded": False,
            "language": "zh-CN",
            "preferences": {
                "location": "",
                "temperature": 22,
                "sensitivity": "normal",
                "notes": "",
                "excluded_ids": [],
                "blocked_pairs": [],
                "closet_scope": "all",
            },
        },
        "items": [],
        "outfits": [],
        "plans": [],
        "wear_events": [],
        "care_events": [],
        "trips": [],
        "ai": {},
        "pairings": [],
        "device_pairings": [],
        "assistant_sessions": [],
        "browser_sessions": [],
    }


class Store:
    def __init__(self, directory: Path):
        self.root = Path(directory).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.path = self.root / "wardrobe.sqlite3"
        with self._connection() as connection:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute(
                "CREATE TABLE IF NOT EXISTS workspace (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL)"
            )
            connection.execute(
                "INSERT OR IGNORE INTO workspace(id,payload) VALUES(1,?)",
                (json.dumps(initial_state(), ensure_ascii=False),),
            )

    @contextmanager
    def _connection(self):
        connection = sqlite3.connect(self.path, timeout=15)
        try:
            connection.execute("PRAGMA busy_timeout=15000")
            with connection:
                yield connection
        finally:
            connection.close()

    def read(self) -> dict:
        with self._connection() as connection:
            return json.loads(connection.execute("SELECT payload FROM workspace WHERE id=1").fetchone()[0])

    def update(self, callback: Callable[[dict], T]) -> T:
        with self._connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            state = json.loads(connection.execute("SELECT payload FROM workspace WHERE id=1").fetchone()[0])
            result = callback(state)
            connection.execute(
                "UPDATE workspace SET payload=? WHERE id=1",
                (json.dumps(state, ensure_ascii=False, allow_nan=False),),
            )
            return result
