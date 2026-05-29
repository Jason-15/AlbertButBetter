import os
from fastapi import APIRouter, Request, Form, HTTPException
from fastapi.responses import HTMLResponse, RedirectResponse
from itsdangerous import URLSafeSerializer, BadSignature

router = APIRouter()

SESSION_KEY = "session"
_signer: URLSafeSerializer | None = None


def get_signer() -> URLSafeSerializer:
    global _signer
    if _signer is None:
        secret = os.environ.get("SESSION_SECRET", "dev-secret-change-in-prod")
        _signer = URLSafeSerializer(secret, salt="session")
    return _signer


def set_session(response, user: str = "user") -> None:
    token = get_signer().dumps({"u": user})
    response.set_cookie(
        SESSION_KEY,
        token,
        httponly=True,
        samesite="lax",
        secure=os.environ.get("RAILWAY_ENVIRONMENT") is not None,
    )


def clear_session(response) -> None:
    response.delete_cookie(SESSION_KEY)


def get_session(request: Request) -> dict | None:
    token = request.cookies.get(SESSION_KEY)
    if not token:
        return None
    try:
        return get_signer().loads(token)
    except BadSignature:
        return None


def require_auth(request: Request) -> dict:
    session = get_session(request)
    if not session:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return session


@router.post("/auth/login")
async def login(request: Request, password: str = Form(...)):
    expected = os.environ.get("APP_PASSWORD", "")
    if not expected:
        raise HTTPException(status_code=500, detail="APP_PASSWORD not configured")
    if password != expected:
        # Re-render login with error
        html = _login_html(error="Incorrect password")
        return HTMLResponse(html, status_code=401)
    response = RedirectResponse("/", status_code=303)
    set_session(response)
    return response


@router.get("/auth/logout")
async def logout():
    response = RedirectResponse("/login", status_code=303)
    clear_session(response)
    return response


@router.get("/login", response_class=HTMLResponse)
async def login_page(request: Request):
    if get_session(request):
        return RedirectResponse("/")
    return HTMLResponse(_login_html())


def _login_html(error: str = "") -> str:
    error_html = f'<p class="error">{error}</p>' if error else ""
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Course Planner — Login</title>
  <style>
    *, *::before, *::after {{ box-sizing: border-box; }}
    body {{
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #0f172a;
      font-family: system-ui, sans-serif;
    }}
    .card {{
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 12px;
      padding: 2.5rem 2rem;
      width: 100%;
      max-width: 380px;
    }}
    h1 {{
      margin: 0 0 0.25rem;
      font-size: 1.4rem;
      color: #f1f5f9;
      font-weight: 700;
    }}
    p.subtitle {{
      margin: 0 0 1.75rem;
      font-size: 0.85rem;
      color: #94a3b8;
    }}
    label {{
      display: block;
      font-size: 0.8rem;
      font-weight: 600;
      color: #94a3b8;
      margin-bottom: 0.4rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }}
    input[type=password] {{
      width: 100%;
      padding: 0.65rem 0.9rem;
      background: #0f172a;
      border: 1px solid #334155;
      border-radius: 8px;
      color: #f1f5f9;
      font-size: 1rem;
      outline: none;
      transition: border-color 0.15s;
    }}
    input[type=password]:focus {{ border-color: #6366f1; }}
    button {{
      margin-top: 1.25rem;
      width: 100%;
      padding: 0.75rem;
      background: #6366f1;
      color: #fff;
      font-size: 0.95rem;
      font-weight: 600;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      transition: background 0.15s;
    }}
    button:hover {{ background: #4f46e5; }}
    .error {{
      margin-top: 0.75rem;
      font-size: 0.85rem;
      color: #f87171;
      text-align: center;
    }}
  </style>
</head>
<body>
  <div class="card">
    <h1>Course Planner</h1>
    <p class="subtitle">NYU Stern MBA</p>
    <form method="post" action="/auth/login">
      <label for="password">Password</label>
      <input type="password" id="password" name="password" autofocus autocomplete="current-password">
      <button type="submit">Sign in</button>
    </form>
    {error_html}
  </div>
</body>
</html>"""
