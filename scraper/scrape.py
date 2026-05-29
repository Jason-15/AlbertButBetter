"""
NYU Stern MBA Course Scraper
----------------------------
Run once per semester to produce data/courses.json.

Usage:
  pip install playwright && playwright install chromium
  python scraper/scrape.py

The browser opens in headed mode. Log in to the NYU SIS portal, click the
Fall (or Spring) tab, then click "Edit Lottery" to reach the course search
page. Press Enter in this terminal when the full course list is visible.
"""

import asyncio
import json
import re
import sys
from datetime import datetime
from pathlib import Path

from playwright.async_api import async_playwright, Page, Frame

# ── Config ────────────────────────────────────────────────────────────────────

COURSE_SEARCH_URL = (
    "https://sis.portal.nyu.edu/psp/ihprod/EMPLOYEE/EMPL/h/"
    "?tab=IS_SSS_TAB&jsconfig=IS_ED_SSS_SUMMARYLnk"
)

OUTPUT_PATH = Path("data/courses.json")

# Regex that splits on any cart-action button label that precedes a course card.
# PeopleSoft shows "Add to Cart", "Remove from Cart", or "Added" depending on
# whether the course is already in the user's lottery selections.
CART_SPLIT_RE = re.compile(
    r"(?:Add to Cart|Remove from Cart|Added(?:\s+to\s+Cart)?)\s*[-–]?\s*",
    re.I,
)

# Regex that identifies a course code anywhere in page text
CODE_RE = re.compile(r"\b([A-Z]{2,6}-[A-Z]{2}\s+\d{4}\s+\d{2,3})\b")


# ── Helpers ───────────────────────────────────────────────────────────────────

def norm_code(raw: str) -> str:
    return re.sub(r"\s+", ".", raw.strip())


def parse_time(raw: str) -> tuple[str | None, str | None]:
    m = re.search(
        r"(\d{1,2})[.:](\d{2})\s*(AM|PM)\s*[-–]\s*(\d{1,2})[.:](\d{2})\s*(AM|PM)",
        raw, re.IGNORECASE,
    )
    if not m:
        return None, None

    def to24(h, mi, ampm):
        h, mi = int(h), int(mi)
        if ampm.upper() == "PM" and h != 12:
            h += 12
        if ampm.upper() == "AM" and h == 12:
            h = 0
        return f"{h:02d}:{mi:02d}"

    return (
        to24(m.group(1), m.group(2), m.group(3)),
        to24(m.group(4), m.group(5), m.group(6)),
    )


def parse_days(raw: str) -> list[str]:
    day_map = {
        "mon": "Mon", "tue": "Tue", "wed": "Wed",
        "thu": "Thu", "fri": "Fri", "sat": "Sat", "sun": "Sun",
    }
    return [canonical for abbr, canonical in day_map.items() if abbr in raw.lower()]


# ── Frame / page discovery ────────────────────────────────────────────────────

async def click_text_in_frames(page: Page, candidates: list[str]) -> bool:
    """Click the first element matching any of the candidate text strings across all frames."""
    for frame in page.frames:
        for text in candidates:
            try:
                el = frame.get_by_role("tab", name=re.compile(text, re.I))
                if await el.count() > 0:
                    await el.first.click()
                    return True
                el = frame.get_by_role("link", name=re.compile(text, re.I))
                if await el.count() > 0:
                    await el.first.click()
                    return True
                el = frame.get_by_role("button", name=re.compile(text, re.I))
                if await el.count() > 0:
                    await el.first.click()
                    return True
            except Exception:
                pass
    return False


async def click_edit_lottery(page: Page) -> bool:
    """
    Find and click the 'Edit Lottery' link across all frames of the page.
    Returns True if found and clicked.
    """
    for frame in page.frames:
        try:
            # Try text-based link first
            lnk = frame.get_by_role("link", name=re.compile(r"Edit Lottery", re.I))
            if await lnk.count() > 0:
                print("  Found 'Edit Lottery' link — clicking...")
                await lnk.first.click()
                return True
            # Also try button
            btn = frame.get_by_role("button", name=re.compile(r"Edit Lottery", re.I))
            if await btn.count() > 0:
                print("  Found 'Edit Lottery' button — clicking...")
                await btn.first.click()
                return True
            # Text match fallback
            el = frame.locator("text=Edit Lottery")
            if await el.count() > 0:
                print("  Found 'Edit Lottery' text — clicking...")
                await el.first.click()
                return True
        except Exception:
            pass
    return False


async def click_view_all(frame: Frame) -> bool:
    """
    Click the PeopleSoft 'View All' / 'Show All' pagination link inside the
    course-list frame so all rows are rendered before we scrape.

    PeopleSoft renders a "View All" anchor near the row count ("1-50 of 114").
    We try several approaches: role-based, text-based, then JS evaluation.
    Returns True if a View All link was found and clicked.
    """
    # Try role / text approaches first
    for locator in [
        frame.get_by_role("link", name=re.compile(r"view all", re.I)),
        frame.get_by_text(re.compile(r"view all", re.I)),
        frame.locator("a[id*='ViewAll'], a[id*='viewall'], a[id*='view_all']"),
    ]:
        try:
            if await locator.count() > 0:
                await locator.first.click()
                print("  Clicked 'View All' link.")
                return True
        except Exception:
            pass

    # JS fallback: find any anchor whose text is "View All" or "Show All"
    clicked = await frame.evaluate("""
        () => {
            const anchors = Array.from(document.querySelectorAll('a'));
            const va = anchors.find(a => /^(view|show) all$/i.test(a.textContent.trim()));
            if (va) { va.click(); return true; }
            return false;
        }
    """)
    if clicked:
        print("  Clicked 'View All' via JS fallback.")
        return True

    print("  No 'View All' link found — assuming all courses already visible.")
    return False


async def wait_for_course_frame(page: Page, timeout: int = 45, min_courses: int = 30) -> Frame | None:
    """
    Poll all frames until one has at least min_courses "Add to Cart" blocks.
    Uses Add-to-Cart block count (not raw code count) to avoid the lottery
    priority page (which has ~9 selected courses) triggering a false positive.
    """
    print(f"  Waiting for frame with ≥{min_courses} courses...", end="", flush=True)
    deadline = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < deadline:
        for frame in page.frames:
            try:
                # Count grid rows by the PeopleSoft row-ID pattern
                count = await frame.evaluate("""
                    () => {
                        let n = 0;
                        while (document.getElementById('NYU_LOT_CLS_VW$0_row_' + n)) n++;
                        return n;
                    }
                """)
                if count >= min_courses:
                    print(f" found {count} course cards!")
                    print(f"  Frame URL: {frame.url[:80]}")
                    return frame
            except Exception:
                pass
        print(".", end="", flush=True)
        await asyncio.sleep(1)
    print(" timed out.")
    return None


async def save_debug_snapshot(page: Page) -> None:
    """Dump all frame URLs and their innerHTML for diagnosis."""
    Path("data").mkdir(exist_ok=True)
    report = []
    for i, frame in enumerate(page.frames):
        try:
            url = frame.url
            html = await frame.evaluate("document.documentElement?.outerHTML ?? ''")
            text = await frame.evaluate("document.body?.innerText ?? ''")
            path = Path(f"data/debug_frame_{i}.html")
            path.write_text(html)
            report.append(f"Frame {i}: {url} | {len(text)} chars text | saved {path.name}")
        except Exception as e:
            report.append(f"Frame {i}: ERROR {e}")
    summary = "\n".join(report)
    Path("data/debug_frames.txt").write_text(summary)
    print(summary)
    print("\nHTML snapshots saved to data/debug_frame_*.html")
    print("Share data/debug_frames.txt to diagnose.")


# ── Scrape all course details ─────────────────────────────────────────────────

async def scrape_courses(frame: Frame) -> dict[str, dict]:
    """
    Extract all courses from the grid by reading each row's field elements directly.

    Every course row has IDs like CREDIT_SRCH$N, START_DATE_SRCH$N, etc.
    This is completely independent of button-label text, so it captures courses
    that show 'Requires Consent' (no Add-to-Cart button) as well as normal ones.
    """
    raw_rows = await frame.evaluate("""
        () => {
            const rows = [];
            let n = 0;
            while (true) {
                if (!document.getElementById('NYU_LOT_CLS_VW$0_row_' + n)) break;

                const txt = id => {
                    const el = document.getElementById(id + '$' + n);
                    return el ? el.textContent.trim() : null;
                };

                // Code + title from syllabus link (present on ALL rows including Requires Consent)
                let code = null, title = null;
                const htmlArea = document.getElementById('win0divNYU_LOT_CLS_WRK_HTMLAREA4$' + n);
                if (htmlArea) {
                    const link = htmlArea.querySelector('a[href*="syllabus"]');
                    if (link) {
                        const urlM = link.href.match(/\\/([A-Z]{2,6}-[A-Z]{2})\\.([0-9]{4})\\/([A-Z0-9]{2,3})\\/\\d+/);
                        if (urlM) code = urlM[1] + '.' + urlM[2] + '.' + urlM[3];
                        title = link.textContent.replace(/^Title\\s+/i, '').trim();
                    }
                }

                // Meeting days/times — the link text for the meetings field
                const meetEl = document.getElementById('NYU_LOT_CLS_WRK_NYU_DAYS_MEET$span$' + n);
                const meetText = meetEl ? meetEl.textContent.trim() : null;

                // Instructors — collect all instructor links in the instructors HTML area
                const instrArea = document.getElementById('win0divINSTRUCTORS2$' + n);
                const instructors = instrArea
                    ? Array.from(instrArea.querySelectorAll('a[href*="stern"]')).map(a => a.textContent.trim()).filter(Boolean)
                    : [];

                rows.push({
                    code,
                    title,
                    session:          txt('SESSIONS_SRCH'),
                    credits:          txt('CREDIT_SRCH'),
                    start_date:       txt('START_DATE_SRCH'),
                    end_date:         txt('END_DATE_SRCH'),
                    instruction_mode: txt('INSTRUCTION_SRCH'),
                    last_offered:     txt('LAST_OFFERED'),
                    meet_text:        meetText,
                    instructors,
                });
                n++;
            }
            return rows;
        }
    """)

    courses: dict[str, dict] = {}
    for row in (raw_rows or []):
        code = row.get("code")
        if not code:
            continue

        # Normalize code: "BSPA-GB.2390.01" stays as-is (already dot-separated)
        # but ensure spaces are dots just in case
        code = re.sub(r"\s+", ".", code.strip())

        meetings = []
        meet_text = row.get("meet_text") or ""
        for days_raw, time_raw in re.findall(
            r"((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:[,\s]+(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun))*)"
            r"\s+(\d{1,2}[.:]\d{2}\s*[AP]M\s*[-–]\s*\d{1,2}[.:]\d{2}\s*[AP]M)",
            meet_text, re.IGNORECASE,
        ):
            days = parse_days(days_raw)
            start, end = parse_time(time_raw)
            if days:
                meetings.append({"days": days, "start_time": start, "end_time": end})

        lo_raw = row.get("last_offered") or ""
        last_offered = [x.strip() for x in re.split(r",\s*", lo_raw) if x.strip()]

        credits_raw = row.get("credits") or ""
        try:
            credits = float(credits_raw)
        except ValueError:
            credits = None

        courses[code] = {
            "code":             code,
            "title":            row.get("title"),
            "session":          row.get("session"),
            "credits":          credits,
            "start_date":       row.get("start_date"),
            "end_date":         row.get("end_date"),
            "instruction_mode": row.get("instruction_mode"),
            "last_offered":     last_offered,
            "meetings":         meetings,
            "instructors":      row.get("instructors") or [],
            "specializations":  [],
        }

    print(f"  Parsed {len(courses)} courses from {len(raw_rows or [])} DOM rows")
    return courses


def _empty_course(code: str) -> dict:
    return {
        "code": code, "title": None, "session": None, "credits": None,
        "start_date": None, "end_date": None, "instruction_mode": None,
        "last_offered": [], "meetings": [], "instructors": [],
        "specializations": [],
    }


def parse_block(text: str) -> dict | None:
    """
    Parse one course block (text following "Add to Cart - ").
    The block starts with the course code, then pairs of label/value.
    """
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    if not lines:
        return None

    full = " ".join(lines)

    course = _empty_course("")

    # Course code
    code_m = CODE_RE.search(full)
    if not code_m:
        return None
    course["code"] = norm_code(code_m.group(1))

    # Title
    title_m = re.search(r"Title\s+(.+?)(?:\s{2,}|(?=Session|Instruction|Credits|Start|End|Last|$))", full)
    if title_m:
        course["title"] = title_m.group(1).strip()

    # Session
    session_m = re.search(r"Session\s+(.+?)(?:\s{2,}|(?=Credits|Instruction|Start|End|$))", full)
    if session_m:
        course["session"] = session_m.group(1).strip()

    # Credits
    cred_m = re.search(r"Credits\s+([\d.]+)", full)
    if cred_m:
        course["credits"] = float(cred_m.group(1))

    # Dates
    sd_m = re.search(r"Start Date\s+(\d{2}/\d{2}/\d{4})", full)
    if sd_m:
        course["start_date"] = sd_m.group(1)

    ed_m = re.search(r"End Date\s+(\d{2}/\d{2}/\d{4})", full)
    if ed_m:
        course["end_date"] = ed_m.group(1)

    # Instruction mode
    mode_m = re.search(r"Instruction Mode\s+(.+?)(?:\s{2,}|(?=Credits|Session|Start|$))", full)
    if mode_m:
        course["instruction_mode"] = mode_m.group(1).strip()

    # Last offered
    lo_m = re.search(
        r"Last Offered\s+(.+?)(?:\s{2,}|(?=Mon|Tue|Wed|Thu|Fri|Sat|Sun|Instructor|View|$))",
        full,
    )
    if lo_m:
        raw_lo = lo_m.group(1).strip()
        course["last_offered"] = [x.strip() for x in re.split(r",\s*", raw_lo) if x.strip()]

    # Meetings: "Mon,Wed 1.30 PM - 2.50 PM" or "Mon 6.00 PM - 9.00 PM"
    meeting_m = re.findall(
        r"((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:[,\s]+(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun))*)"
        r"\s+(\d{1,2}[.:]\d{2}\s*[AP]M\s*[-–]\s*\d{1,2}[.:]\d{2}\s*[AP]M)",
        full,
        re.IGNORECASE,
    )
    for days_raw, time_raw in meeting_m:
        days = parse_days(days_raw)
        start, end = parse_time(time_raw)
        if days:
            course["meetings"].append({"days": days, "start_time": start, "end_time": end})

    # Instructors
    instr_m = re.findall(r"Instructor\s+([A-Za-z][A-Za-z\s,.''\-]+?)(?=\s{2,}|Instructor|View|$)", full)
    course["instructors"] = [i.strip() for i in instr_m if i.strip()]

    return course


# ── Specialization pass ───────────────────────────────────────────────────────

SPEC_SELECT_ID = "NYU_LOT_CLS_WRK_CRSE_ATTR_VALUE"


async def extract_visible_course_codes(frame: Frame) -> list[str]:
    """
    Return course codes for all rows in the grid.
    Uses the same syllabus-URL strategy as scrape_courses, so Requires Consent
    courses and any other non-Add-to-Cart rows are included.
    """
    raw_codes = await frame.evaluate("""
        () => {
            const codes = [];
            let n = 0;
            while (true) {
                if (!document.getElementById('NYU_LOT_CLS_VW$0_row_' + n)) break;
                const htmlArea = document.getElementById('win0divNYU_LOT_CLS_WRK_HTMLAREA4$' + n);
                if (htmlArea) {
                    const link = htmlArea.querySelector('a[href*="syllabus"]');
                    if (link) {
                        const m = link.href.match(/\\/([A-Z]{2,6}-[A-Z]{2})\\.([0-9]{4})\\/([A-Z0-9]{2,3})\\/\\d+/);
                        if (m) codes.push(m[1] + '.' + m[2] + '.' + m[3]);
                    }
                }
                n++;
            }
            return codes;
        }
    """)
    return raw_codes or []


async def scrape_specializations(frame: Frame) -> dict[str, list[str]]:
    """
    Iterate every option in the Specializations <select> by directly setting
    its value via JS and triggering PeopleSoft's onchange handler.
    The element may be hidden inside a collapsed sidebar accordion — JS bypasses that.
    """
    spec_map: dict[str, list[str]] = {}

    # Read all options directly from the DOM (ignores visibility)
    options = await frame.evaluate(f"""
        Array.from(
            document.querySelector('#{SPEC_SELECT_ID}')?.options ?? []
        ).map(o => ({{value: o.value, text: o.text.trim()}}))
    """)

    # Skip the blank "all" entry
    options = [o for o in options if o["value"].strip()]

    if not options:
        print(f"  WARNING: #{SPEC_SELECT_ID} not found or has no options.")
        await save_debug_snapshot(frame.page)
        return {}

    print(f"  Found {len(options)} specializations")

    for opt in options:
        spec_name = opt["text"]
        value = opt["value"]
        print(f"  → {spec_name}", end="", flush=True)
        try:
            # Trigger the specialization filter exactly as a user click would:
            # set the <select> value then call PeopleSoft's own submit handler,
            # which POSTs the form and reloads the iframe with the filtered list.
            await frame.evaluate(f"""
                const sel = document.querySelector('#{SPEC_SELECT_ID}');
                if (!sel) throw new Error('select not found');
                sel.value = {value!r};
                if (typeof addchg_win0 === 'function') addchg_win0(sel);
                if (typeof submitAction_win0 === 'function') submitAction_win0(sel.form, sel.id);
            """)

            # Wait for the iframe to reload with the filtered course list
            try:
                await frame.page.wait_for_load_state("networkidle", timeout=15000)
            except Exception:
                pass
            await asyncio.sleep(1)  # let the DOM settle after AJAX

            # Expand paginated results if the spec has many courses
            va = await click_view_all(frame)
            if va:
                try:
                    await frame.page.wait_for_load_state("networkidle", timeout=15000)
                except Exception:
                    pass
                await asyncio.sleep(1)

            # Read only the course codes from visible "Add to Cart" blocks.
            # Scanning the whole body catches hidden form fields that always
            # contain every course code regardless of the active filter.
            codes = await extract_visible_course_codes(frame)

            if not codes:
                # DOM might still be settling — wait and retry once
                await asyncio.sleep(2)
                codes = await extract_visible_course_codes(frame)

            spec_map[spec_name] = codes
            print(f"  ({len(codes)} courses)")

        except Exception as e:
            print(f"  ERROR: {e}")

    # Reset to "all" (blank value) so the full course list is restored
    print("  Resetting to all courses...")
    try:
        await frame.evaluate(f"""
            const sel = document.querySelector('#{SPEC_SELECT_ID}');
            if (sel) {{
                sel.value = '';
                if (typeof addchg_win0 === 'function') addchg_win0(sel);
                if (typeof submitAction_win0 === 'function') submitAction_win0(sel.form, sel.id);
            }}
        """)
        await asyncio.sleep(2)
    except Exception:
        pass

    return spec_map


# ── Main ──────────────────────────────────────────────────────────────────────

async def main():
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=False, slow_mo=50)
        context = await browser.new_context()
        page = await context.new_page()

        print(f"Opening: {COURSE_SEARCH_URL}")
        await page.goto(COURSE_SEARCH_URL)

        print("\n" + "=" * 60)
        print("ACTION REQUIRED:")
        print("  1. Log in to the NYU SIS portal")
        print("  2. Wait until you see the enrollment dashboard (Summer/Fall tabs visible)")
        print("  3. Press Enter here — the scraper will click Fall 2026 + Edit Lottery")
        print("=" * 60)
        input("\nPress Enter once you are logged in and see the enrollment dashboard...")

        # Give the page a moment to settle
        await asyncio.sleep(1)

        print("\n[Step 1] Clicking 'Fall 2026' tab...")
        clicked_fall = await click_text_in_frames(page, ["Fall 2026", "Fall 26", "Fall"])
        if clicked_fall:
            print("  Clicked Fall tab — waiting for page to settle...")
            await asyncio.sleep(2)
        else:
            print("  Could not find Fall tab automatically. Please click it manually.")
            input("  Press Enter once the Fall tab is selected...")
            await asyncio.sleep(1)

        print("\n[Step 2] Clicking 'Edit Lottery'...")
        clicked = await click_edit_lottery(page)
        if not clicked:
            print("  Could not find 'Edit Lottery' automatically.")
            print("  Please click it manually in the browser now.")
            input("  Press Enter after the course list has fully loaded...")

        print("\n[Step 3] Waiting for modal to load...")
        await asyncio.sleep(2)

        print("\n[Step 4] Clicking 'Continue' if present...")
        clicked_continue = await click_text_in_frames(page, ["Continue"])
        if clicked_continue:
            print("  Clicked Continue — waiting...")
            await asyncio.sleep(2)
        else:
            print("  No 'Continue' button found — skipping.")

        print("\n[Step 5] Clicking 'Back to Search' if present...")
        clicked_back = await click_text_in_frames(page, ["Back to Search", "Search"])
        if clicked_back:
            print("  Clicked 'Back to Search' — waiting for full list to load...")
            await asyncio.sleep(4)
        else:
            print("  No 'Back to Search' button found — skipping.")

        print("\n[Step 6] Waiting for full course list in a frame (≥30 cards)...")
        frame = await wait_for_course_frame(page, timeout=45)

        if frame is None:
            print("\nERROR: Course content never appeared. Saving debug snapshot...")
            await save_debug_snapshot(page)
            await browser.close()
            sys.exit(1)

        # Extra wait to ensure all courses are rendered
        await asyncio.sleep(2)

        print("\n[Pass 1a] Expanding full list (View All)...")
        view_all_clicked = await click_view_all(frame)
        if view_all_clicked:
            print("  Waiting for all rows to render...")
            await frame.page.wait_for_load_state("networkidle", timeout=20000)
            await asyncio.sleep(2)
            # Re-count after expansion
            count_after = await frame.evaluate("""
                () => { let n=0; while(document.getElementById('NYU_LOT_CLS_VW$0_row_'+n)) n++; return n; }
            """)
            print(f"  Course count after View All: {count_after}")

        print("\n[Pass 1b] Scraping course details...")
        courses = await scrape_courses(frame)
        print(f"  Parsed {len(courses)} courses")

        if not courses:
            print("\nERROR: Frame found but no courses parsed. Saving debug snapshot...")
            await save_debug_snapshot(page)
            await browser.close()
            sys.exit(1)

        print("\n[Pass 2] Scraping specialization membership...")
        spec_map = await scrape_specializations(frame)

        # Merge specs into courses
        for spec_name, codes in spec_map.items():
            for code in codes:
                if code in courses:
                    if spec_name not in courses[code]["specializations"]:
                        courses[code]["specializations"].append(spec_name)

        all_specs = sorted(spec_map.keys())
        output = {
            "scraped_at": datetime.now().isoformat(),
            "specializations": all_specs,
            "courses": list(courses.values()),
        }

        OUTPUT_PATH.write_text(json.dumps(output, indent=2, ensure_ascii=False))
        print(f"\n✓ Wrote {len(courses)} courses → {OUTPUT_PATH}")
        print(f"  Specializations: {len(all_specs)}")

        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
