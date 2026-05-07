"""
Shared AppFolio session management.

Manages cookie-based authentication for AppFolio web scraping.
Uses Playwright for interactive login (SMS MFA) and validates
saved cookies via httpx.
"""

import asyncio
import os
import sys
from pathlib import Path

import httpx
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent.parent / ".env")

APPFOLIO_VHOST = os.environ.get("APPFOLIO_VHOST", "lapm.appfolio.com")
SUPABASE_URL = os.environ.get("SUPABASE_URL") or os.environ["PUBLIC_SUPABASE_URL"]
SUPABASE_SERVICE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
COOKIE_PATH = Path.home() / ".appfolio_session"


class SessionManager:
    """Manages the full browser cookie jar for AppFolio sessions."""

    def __init__(self, vhost: str):
        self.vhost = vhost

    def load_cookies(self) -> str | None:
        """Load the full cookie header string from disk."""
        if COOKIE_PATH.exists():
            cookie = COOKIE_PATH.read_text().strip()
            return cookie if cookie else None
        return None

    def save_cookies(self, cookies: list[dict]):
        """Save browser cookies as a Cookie header string (vhost only)."""
        vhost_cookies = [c for c in cookies if self.vhost in c.get("domain", "")]
        cookie_str = "; ".join(f"{c['name']}={c['value']}" for c in vhost_cookies)
        COOKIE_PATH.write_text(cookie_str)
        print(f"Cookie jar saved to {COOKIE_PATH} ({len(vhost_cookies)} cookies)")

    def save_cookies_all(self, cookies: list[dict]):
        """Save ALL browser cookies — includes appfolio.com domain cookies."""
        relevant = [c for c in cookies if "appfolio" in c.get("domain", "")]
        cookie_str = "; ".join(f"{c['name']}={c['value']}" for c in relevant)
        COOKIE_PATH.write_text(cookie_str)
        print(f"Cookie jar saved to {COOKIE_PATH} ({len(relevant)} cookies)")

    async def test_cookies(self, cookie_header: str) -> bool:
        """Test if the saved cookies are still valid."""
        async with httpx.AsyncClient() as client:
            resp = await client.get(
                f"https://{self.vhost}/maintenance/service_requests/work_orders",
                headers={
                    "Cookie": cookie_header,
                    "Accept": "application/json",
                    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                                  "AppleWebKit/537.36 (KHTML, like Gecko) "
                                  "Chrome/142.0.0.0 Safari/537.36",
                    "X-Requested-With": "XMLHttpRequest",
                },
                follow_redirects=False,
            )
            return resp.status_code not in (302, 401, 403)

    async def login_interactive(self) -> str:
        """Launch headful browser for interactive login with SMS MFA."""
        try:
            from playwright.async_api import async_playwright
        except ImportError:
            print("Playwright not installed. Run: pip install playwright && playwright install chromium")
            sys.exit(1)

        print(f"Opening browser to login to {self.vhost}...")
        print("Complete the login (including any MFA) in the browser window.")

        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=False)
            context = await browser.new_context()
            page = await context.new_page()

            await page.goto("https://passport.appf.io/sign_in?idp_type=property&vhostless=true")

            print("Waiting for login to complete...")
            while True:
                url = page.url
                cookies = await context.cookies()

                domains = set(c.get("domain", "") for c in cookies)
                session_cookies = [c for c in cookies if c["name"] == "_property_session"]

                if self.vhost in url and not session_cookies:
                    print(f"  On {self.vhost}, waiting for session cookie...")
                    print(f"  Cookie domains seen: {domains}")
                    await asyncio.sleep(2)
                    continue

                if session_cookies:
                    print(f"  Found _property_session cookie on domain: "
                          f"{session_cookies[0].get('domain', '?')}")
                    await asyncio.sleep(2)
                    break

                await asyncio.sleep(1)

            all_cookies = await context.cookies()

            vhost_cookies = [c for c in all_cookies if self.vhost in c.get("domain", "")]
            other_cookies = [c for c in all_cookies if self.vhost not in c.get("domain", "")]
            print(f"  Captured {len(vhost_cookies)} vhost cookies, "
                  f"{len(other_cookies)} other cookies")
            print(f"  Vhost cookie names: {[c['name'] for c in vhost_cookies]}")

            await browser.close()

        self.save_cookies_all(all_cookies)
        cookie_header = self.load_cookies()
        print("Login successful!")
        return cookie_header

    async def get_valid_cookies(self) -> str:
        """Return a valid cookie header string, prompting for login if needed."""
        cookie_header = self.load_cookies()
        if cookie_header:
            print("Testing saved cookies...", end=" ")
            if await self.test_cookies(cookie_header):
                print("valid.")
                return cookie_header
            else:
                print("expired.")

        print("No valid session. Run with --login to authenticate.")
        sys.exit(1)
