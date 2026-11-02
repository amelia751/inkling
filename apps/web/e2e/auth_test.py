"""Signing in (todo9 Phase 4): the signed-out redirect, the account menu, switching organization,
signing out, and a deep link that survives the sign-in round trip.

Needs a `workos`-mode stack, so it's skipped unless run with --workos: the API in
`INKLING_API_AUTH_MODE=workos` against WorkOS Emulate started with `--interactive` (its login
pages) and seeded with a user in two organizations (infra/workos/emulate.yaml), and the dev
server started with the API and the auth mode:

    INKLING_API_URL=http://127.0.0.1:8000 INKLING_WEB_AUTH_MODE=workos INKLING_E2E=1 \\
        pnpm exec vite --port 5199 --strictPort
    python3 e2e/auth_test.py --port 5199 --workos --email ada@example.org [--password …]

The login form is the identity provider's (Emulate's or AuthKit's), so `sign_in` fills the
first email field (and password, when one shows up) and submits; it never relies on our test ids.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from harness import launch, parse_args, sync_playwright  # noqa: E402
from playwright.sync_api import Page  # noqa: E402

results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'} {name}{f' — {detail}' if detail else ''}")


def extra_args() -> tuple[bool, str, str]:
    """--workos / --email / --password, removed from argv before the shared parser sees it."""
    workos, email, password = False, "", ""
    rest: list[str] = []
    it = iter(sys.argv[1:])
    for a in it:
        if a == "--workos":
            workos = True
        elif a == "--email":
            email = next(it, "")
        elif a == "--password":
            password = next(it, "")
        else:
            rest.append(a)
    sys.argv[1:] = rest
    return workos, email, password


def sign_in(page: Page, base: str, email: str, password: str) -> None:
    """On the identity provider's page: email, then password if asked, until we're back home."""
    page.wait_for_url(lambda u: not u.startswith(base) or "/api/auth/" in u, timeout=15000)
    field = page.locator("input[type=email], input[name=email]").first
    field.wait_for(timeout=15000)
    field.fill(email)
    page.keyboard.press("Enter")
    pw = page.locator("input[type=password]").first
    try:
        pw.wait_for(timeout=5000)
        if password:
            pw.fill(password)
        page.keyboard.press("Enter")
    except Exception:
        pass  # Emulate's interactive page signs in with the email alone
    page.wait_for_url(f"{base}/**", timeout=20000)


def open_menu(page: Page) -> None:
    page.locator("[data-testid=user-menu]").click()
    page.locator("[data-testid=user-menu-content]").wait_for(timeout=5000)


def main() -> int:
    workos, email, password = extra_args()
    if not workos:
        print("SKIP auth_test: needs a workos-mode stack (run with --workos --email <seeded user>)")
        return 0
    args = parse_args()
    if not email:
        print("FAIL --email is required with --workos")
        return 1
    base = f"http://localhost:{args.port}"
    deep = "/projects?sort=name"

    with sync_playwright() as pw:
        browser = launch(pw, args.browser, args.headed)
        ctx = browser.new_context(viewport={"width": 1440, "height": 900})
        page = ctx.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)))

        # Deep link while signed out: off to sign in with return_to, then back to the same URL.
        login_urls: list[str] = []
        page.on("request", lambda r: login_urls.append(r.url) if "/api/auth/login" in r.url else None)
        page.goto(base + deep)
        sign_in(page, base, email, password)
        check("signed-out visit goes to /api/auth/login", any("return_to=" in u for u in login_urls), ", ".join(login_urls[:1]))
        check("deep link survives login", page.url == base + deep, page.url)

        # The account menu names the person and their organization.
        page.locator("[data-testid=user-menu]").wait_for(timeout=15000)
        open_menu(page)
        menu_email = page.locator("[data-testid=user-menu-email]").inner_text()
        check("menu shows the user", menu_email.strip().lower() == email.lower(), menu_email)
        org_before = page.locator("[data-testid=user-menu-org]").inner_text()
        check("menu shows the organization", org_before.startswith("Organization "), org_before)
        page.keyboard.press("Escape")

        # Switch organization: another workspace from the session's list, then home.
        page.locator("[data-testid=workspace-switcher]").click()
        others = page.locator("[data-testid^=switch-org-]:not([aria-current=true])")
        if others.count() == 0:
            check("switch org (needs a user in two organizations)", False, "only one organization in the session")
        else:
            name = others.first.inner_text().strip()
            others.first.click()
            sign_in_needed = False
            try:
                page.wait_for_url(f"{base}/", timeout=10000)
            except Exception:
                sign_in_needed = True  # the organization asked for its own sign-in (SSO/MFA)
                sign_in(page, base, email, password)
            page.locator("[data-testid=workspace-switcher]").wait_for(timeout=15000)
            label = page.locator("[data-testid=workspace-switcher]").inner_text().strip()
            check("switch org lands home in the new workspace", label == name, f"{label} (re-sign-in: {sign_in_needed})")

        # Sign out: the cookie is gone, so the next visit is sent to sign in again.
        open_menu(page)
        page.locator("[data-testid=log-out]").click()
        page.wait_for_url(lambda u: not u.startswith(base + "/projects"), timeout=15000)
        cookies = [c["name"] for c in ctx.cookies(base) if re.search(r"_session$", c["name"])]
        check("sign out clears the session cookie", not cookies, ", ".join(cookies))
        status = page.request.get(f"{base}/api/auth/session").status
        check("session is 401 after sign out", status == 401, str(status))

        check("no page errors", not errors, "; ".join(errors[:3]))
        browser.close()

    failed = [n for n, ok, _ in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
