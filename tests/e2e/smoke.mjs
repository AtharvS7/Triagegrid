/* End-to-end browser smoke test — drives the real UI via installed Edge. */
import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function login(page, email) {
  await page.goto(`${BASE}/login`);
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', "password123");
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 15000 });
}

async function signOut(page) {
  await page.click('header button:has-text("Sign out")');
  await page.waitForURL((u) => u.pathname.includes("login"), { timeout: 10000 });
  // stay on /login — the original bug bounced straight back to the console
  await page.waitForTimeout(1200);
  return !page.url().includes("login") ? "bounced back" : "stayed";
}

const browser = await chromium.launch({ channel: "msedge", headless: true });

try {
  /* ── Dispatcher ─────────────────────────────────────────────────── */
  {
    const page = await browser.newPage();
    await login(page, "dispatch@triagegrid.test");
    check("dispatcher: landed on console", page.url().includes("/dispatcher"));

    await page.waitForTimeout(1500);
    const units = await page.locator("text=M-1").count();
    check("dispatcher: units visible (M-1)", units > 0, `count=${units}`);

    const ticker = await page.locator(".ticker").count();
    check("dispatcher: situation ticker present", ticker === 1);

    const where = await signOut(page);
    check("dispatcher: sign-out sticks", where === "stayed", where);
    await page.close();
  }

  /* ── Hospital ───────────────────────────────────────────────────── */
  {
    const page = await browser.newPage();
    await login(page, "hospital@triagegrid.test");
    check("hospital: landed on console", page.url().includes("/hospital"));

    await page.waitForTimeout(1500);
    const linked = await page.locator("text=Metro General Medical Center").count();
    check("hospital: facility linked + visible", linked > 0, `count=${linked}`);

    const where = await signOut(page);
    check("hospital: sign-out sticks", where === "stayed", where);
    await page.close();
  }

  /* ── Field ──────────────────────────────────────────────────────── */
  {
    const page = await browser.newPage();
    await login(page, "field@triagegrid.test");
    check("field: landed on console", page.url().includes("/field"));
    await page.waitForTimeout(1500);
    const where = await signOut(page);
    check("field: sign-out sticks", where === "stayed", where);
    await page.close();
  }

  /* ── Admin ──────────────────────────────────────────────────────── */
  {
    const page = await browser.newPage();
    await login(page, "admin@triagegrid.test");
    check("admin: landed on console", page.url().includes("/admin"));
    await page.waitForTimeout(1500);
    const audit = await page.locator("table.data").count();
    check("admin: audit table renders", audit >= 1);
    const where = await signOut(page);
    check("admin: sign-out sticks", where === "stayed", where);
    await page.close();
  }

  /* ── Citizen report + tracking ──────────────────────────────────── */
  {
    const page = await browser.newPage();
    await page.goto(`${BASE}/citizen`);
    await page.fill("textarea", "Browser smoke test incident");
    await page.click(".pin-picker"); // place pin
    await page.click('button:has-text("Submit report")');
    await page.waitForSelector("text=Report received", { timeout: 15000 });
    const code = (await page.locator("p.mono").first().textContent())?.trim();
    check("citizen: report submitted, code shown", !!code && code.length === 22, code ?? "");

    await page.goto(`${BASE}/track?code=${code}`);
    await page.waitForSelector("text=Browser smoke test incident", { timeout: 10000 });
    check("citizen: tracking lookup resolves", true);
    await page.close();
  }
} catch (err) {
  check("UNEXPECTED FAILURE", false, String(err).slice(0, 300));
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
