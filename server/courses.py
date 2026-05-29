import json
import pathlib
from functools import lru_cache
from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel

from server.auth import require_auth
from server import state as state_db

router = APIRouter()

COURSES_PATH  = pathlib.Path("data/courses.json")
PROGRAM_PATH  = pathlib.Path("data/program.json")


@lru_cache(maxsize=1)
def load_courses_json() -> dict:
    if not COURSES_PATH.exists():
        return {"scraped_at": None, "specializations": [], "courses": []}
    return json.loads(COURSES_PATH.read_text())


@lru_cache(maxsize=1)
def load_program() -> dict:
    if not PROGRAM_PATH.exists():
        return {"semesters": []}
    return json.loads(PROGRAM_PATH.read_text())


def _required_prefixes() -> set[str]:
    program = load_program()
    prefixes: set[str] = set()
    for sem in program.get("semesters", []):
        for p in sem.get("required_prefixes", []):
            prefixes.add(p)
    return prefixes


@router.get("/api/program")
async def get_program(_: dict = Depends(require_auth)):
    return load_program()


@router.get("/api/courses")
async def get_courses(_: dict = Depends(require_auth)):
    data = load_courses_json()
    db_states = await state_db.get_all_states()
    req_prefixes = _required_prefixes()

    courses = []
    for course in data["courses"]:
        c = dict(course)
        state = db_states.get(c["code"], {})
        c["status"] = state.get("status", "default")
        c["notes"] = state.get("notes")
        c["required"] = any(c["code"].startswith(p) for p in req_prefixes)
        # Semester: DB value wins (user may have assigned to spring), else fall_2026
        c["semester"] = state.get("semester", "fall_2026")
        # Tag courses historically offered in spring
        last_offered = c.get("last_offered") or []
        c["also_spring"] = any("Spring" in lo for lo in last_offered)
        courses.append(c)

    # Inject prior (already-completed) courses — always planned, hidden from browser
    program = load_program()
    for pc in program.get("prior_courses", []):
        c = dict(pc)
        c["status"] = "planned"
        c["prior"] = True
        c["required"] = False
        c["notes"] = None
        c["also_spring"] = False
        courses.append(c)

    # Inject spring core courses — always planned, shown in spring panel not browser
    for sem in program.get("semesters", []):
        if sem.get("id") != "spring_2027":
            continue
        for cc in sem.get("core_courses", []):
            c = dict(cc)
            c["status"] = "planned"
            c["spring_core"] = True
            c["required"] = True
            c["semester"] = "spring_2027"
            c["notes"] = None
            c["also_spring"] = False
            courses.append(c)

    return {
        "scraped_at": data.get("scraped_at"),
        "specializations": data.get("specializations", []),
        "courses": courses,
        "program": load_program(),
    }


class StateUpdate(BaseModel):
    status: str | None = None
    notes: str | None = None
    semester: str | None = None


@router.patch("/api/courses/{code:path}")
async def update_course_state(
    code: str,
    body: StateUpdate,
    _: dict = Depends(require_auth),
):
    await state_db.upsert_state(code, body.status, body.notes, body.semester)
    return {"ok": True}


@router.delete("/api/courses/{code:path}/state")
async def reset_course_state(code: str, _: dict = Depends(require_auth)):
    await state_db.reset_state(code)
    return {"ok": True}
