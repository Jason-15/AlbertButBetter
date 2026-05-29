# NYU Stern MBA Course Planner

A personal course planning tool for the NYU Stern Focused MBA program. Browse electives, track specialization progress, detect scheduling conflicts, and build a semester-by-semester plan.

---

## What you need before starting

- A computer running macOS or Windows
- An internet connection (for the one-time setup)

No prior Python experience needed — just follow the steps below.

---

## Step 1 — Install Python

**Check if you already have it** by opening Terminal (Mac) or Command Prompt (Windows) and running:

```
python3 --version
```

If you see something like `Python 3.11.x` you're good. If you get an error:

- **Mac**: Download from [python.org/downloads](https://www.python.org/downloads/) and run the installer. Make sure to check **"Add Python to PATH"** during installation.
- **Windows**: Same link — and check **"Add Python to PATH"** on the first installer screen.

---

## Step 2 — Download the project

If you received this as a zip file, unzip it somewhere you can find it (e.g. your Desktop or Documents folder).

If you're cloning from GitHub:

```
git clone <repo-url>
cd course-decluster
```

---

## Step 3 — Open a terminal in the project folder

**Mac:**
1. Open Terminal (search "Terminal" in Spotlight)
2. Type `cd ` (with a space), then drag the project folder into the terminal window and press Enter

**Windows:**
1. Open the project folder in File Explorer
2. Click the address bar, type `cmd`, press Enter

---

## Step 4 — Install dependencies

Run this once. It downloads the libraries the app needs:

```
pip3 install -r requirements.txt
```

If `pip3` isn't found, try `pip` instead:

```
pip install -r requirements.txt
```

---

## Step 5 — Set your password

The app requires a password to log in. You set it via an environment variable each time you start the server.

**Mac / Linux** — set it inline when starting (see Step 6).

**Windows** — set it first, then start:

```
set APP_PASSWORD=yourpassword
set SESSION_SECRET=any-random-string-here
```

---

## Step 6 — Start the server

**Mac / Linux:**

```
APP_PASSWORD=yourpassword SESSION_SECRET=change-me uvicorn server.main:app --reload --port 8000
```

**Windows** (after Step 5):

```
uvicorn server.main:app --reload --port 8000
```

You should see output like:

```
INFO:     Uvicorn running on http://127.0.0.1:8000 (Press CTRL+C to quit)
```

---

## Step 7 — Open the app

Go to **[http://localhost:8000](http://localhost:8000)** in your browser.

Log in with the password you set in Step 5.

---

## Stopping the server

Press **Ctrl + C** in the terminal window.

---

## Updating course data

Course data lives in `data/courses.json`. If you need to re-scrape the NYU SIS portal for a new semester:

```
python3 scraper/scrape.py
```

This requires Playwright. Install it first:

```
pip3 install playwright
playwright install chromium
```

The scraper opens a real browser window — you'll need to log in to the NYU portal manually and follow the prompts. It runs once per semester.

---

## Deploying to Railway (optional)

If you want the app accessible from anywhere (not just your laptop):

1. Create an account at [railway.app](https://railway.app)
2. Create a new project and connect this repo
3. Add a persistent volume mounted at `/data`
4. Set these environment variables in the Railway dashboard:
   - `APP_PASSWORD` — your login password
   - `SESSION_SECRET` — any long random string
   - `DATABASE_URL` — `/data/state.db`

Railway auto-detects the `railway.toml` config and handles the rest.

---

## Troubleshooting

**"Address already in use" error on startup**

Another server process is still running. Find and kill it:

```
# Mac / Linux
lsof -i :8000
kill -9 <PID from the list>

# Windows
netstat -ano | findstr :8000
taskkill /PID <PID> /F
```

**Courses not showing after login**

Try a hard refresh: **Cmd + Shift + R** (Mac) or **Ctrl + Shift + R** (Windows).

**Forgot your password**

Restart the server with a new `APP_PASSWORD` value.

**"pip3 not found"**

Try `pip` instead of `pip3`. If neither works, Python may not be installed correctly — re-run the installer and make sure "Add to PATH" is checked.
