import json
import os
import pathlib
import aiosqlite
from contextlib import asynccontextmanager

_DB_PATH = None
_PROGRAM_PATH = pathlib.Path("data/program.json")


def db_path() -> str:
    global _DB_PATH
    if _DB_PATH is None:
        _DB_PATH = os.environ.get("DATABASE_URL", "data/state.db")
    return _DB_PATH


@asynccontextmanager
async def get_db():
    async with aiosqlite.connect(db_path()) as db:
        db.row_factory = aiosqlite.Row
        yield db


async def init_db() -> None:
    async with get_db() as db:
        await db.execute("""
            CREATE TABLE IF NOT EXISTS course_state (
                code       TEXT PRIMARY KEY,
                status     TEXT NOT NULL DEFAULT 'default',
                notes      TEXT,
                semester   TEXT DEFAULT 'fall_2026',
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        """)
        await db.execute("""
            CREATE TABLE IF NOT EXISTS app_settings (
                key   TEXT PRIMARY KEY,
                value TEXT
            )
        """)
        await db.commit()

        # Migrate: add semester column to existing DBs
        try:
            await db.execute("ALTER TABLE course_state ADD COLUMN semester TEXT DEFAULT 'fall_2026'")
            await db.commit()
        except Exception:
            pass

        # Seed required courses as planned on first run only.
        seed_key = "seeded_required_v1"
        cur = await db.execute("SELECT value FROM app_settings WHERE key = ?", (seed_key,))
        if not await cur.fetchone():
            if _PROGRAM_PATH.exists():
                program = json.loads(_PROGRAM_PATH.read_text())
                for sem in program.get("semesters", []):
                    for code in sem.get("seed_codes", []):
                        await db.execute(
                            "INSERT OR IGNORE INTO course_state (code, status) VALUES (?, 'planned')",
                            (code,),
                        )
            await db.execute("INSERT INTO app_settings (key, value) VALUES (?, '1')", (seed_key,))
            await db.commit()


async def get_all_states() -> dict[str, dict]:
    async with get_db() as db:
        async with db.execute(
            "SELECT code, status, notes, semester FROM course_state WHERE status != 'default'"
        ) as cursor:
            rows = await cursor.fetchall()
    return {
        row["code"]: {
            "status": row["status"],
            "notes": row["notes"],
            "semester": row["semester"] or "fall_2026",
        }
        for row in rows
    }


async def upsert_state(code: str, status: str | None, notes: str | None, semester: str | None = None) -> None:
    async with get_db() as db:
        await db.execute("""
            INSERT INTO course_state (code, status, notes, semester, updated_at)
            VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(code) DO UPDATE SET
                status   = COALESCE(excluded.status, status),
                notes    = COALESCE(excluded.notes, notes),
                semester = COALESCE(excluded.semester, semester),
                updated_at = CURRENT_TIMESTAMP
        """, (code, status or "default", notes, semester or "fall_2026"))
        await db.commit()


async def reset_state(code: str) -> None:
    async with get_db() as db:
        await db.execute("DELETE FROM course_state WHERE code = ?", (code,))
        await db.commit()
