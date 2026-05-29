import os
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv  # type: ignore[import]

# Load .env if present (local dev)
load_dotenv()

from fastapi import FastAPI, Request
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles

from server import auth, courses, state as state_db


@asynccontextmanager
async def lifespan(app: FastAPI):
    await state_db.init_db()
    yield


app = FastAPI(lifespan=lifespan)

# Auth routes (login page + login/logout actions)
app.include_router(auth.router)

# API routes
app.include_router(courses.router)


@app.get("/")
async def root(request: Request):
    if not auth.get_session(request):
        return RedirectResponse("/login")
    return RedirectResponse("/app")


# Serve static files at /app so index.html lives at /app
app.mount("/app", StaticFiles(directory="static", html=True), name="static")
