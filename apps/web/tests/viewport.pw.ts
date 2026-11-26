import { expect, test, type Page } from "@playwright/test";

// Every layout rule below is checked on every page at every size.
const VIEWPORTS = [
  { name: "Galaxy Fold (folded)", width: 344, height: 882, touch: true },
  { name: "iPhone SE", width: 375, height: 667, touch: true },
  { name: "iPhone 15 Pro", width: 393, height: 852, touch: true },
  { name: "Pixel 7", width: 412, height: 915, touch: true },
  { name: "iPhone 15 Pro landscape", width: 852, height: 393, touch: true },
  { name: "iPad Mini", width: 768, height: 1024, touch: true },
  { name: "iPad Pro 11 landscape", width: 1194, height: 834, touch: true },
  { name: "Laptop", width: 1280, height: 800, touch: false },
  { name: "Desktop 1080p", width: 1920, height: 1080, touch: false },
  { name: "Ultrawide", width: 2560, height: 1080, touch: false },
] as const;

const PAGES = [
  { name: "launches", hash: "#/", ready: "h1" },
  { name: "create", hash: "#/create", ready: "input[name=name]" },
  // An address the Portal has no record of: the page must still lay out its message correctly.
  { name: "launcher", hash: "#/launcher/0x000000000000000000000000000000000000dead", ready: "[data-testid=unknown-launcher]" },
] as const;

const PHONE_MAX = 767;
const MIN_TOUCH_TARGET = 44;
// Controls a finger has to hit. Links inside a sentence are text, not controls.
const CONTROLS = "button, select, input, a.button, a.brand, a.card, .nav a, .tabbar a, .links a";

async function open(page: Page, hash: string, ready: string) {
  await page.goto(`/${hash}`);
  await page.locator(ready).first().waitFor({ state: "visible", timeout: 30_000 });
}

for (const viewport of VIEWPORTS) {
  test.describe(`${viewport.name} ${viewport.width}x${viewport.height}`, () => {
    test.use({
      viewport: { width: viewport.width, height: viewport.height },
      hasTouch: viewport.touch,
      isMobile: viewport.touch && viewport.width <= PHONE_MAX,
    });
    const phone = viewport.width <= PHONE_MAX;

    for (const target of PAGES) {
      test(`${target.name}: layout fits`, async ({ page }) => {
        await open(page, target.hash, target.ready);

        // 1. Nothing makes the page scroll sideways.
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow, "horizontal overflow in px").toBeLessThanOrEqual(0);

        // 2. Phones get the phone layout; everything wider gets the desktop one. Never both.
        await expect(page.getByTestId("mobile-shell")).toHaveCount(phone ? 1 : 0);
        await expect(page.getByTestId("desktop-shell")).toHaveCount(phone ? 0 : 1);
        await expect(page.getByTestId(phone ? "mobile-nav" : "desktop-nav")).toBeVisible();

        // 3. The background canvas covers the whole viewport and takes no input.
        const backdrop = page.getByTestId("backdrop");
        const box = await backdrop.boundingBox();
        expect(box).not.toBeNull();
        expect(Math.round(box!.width)).toBe(viewport.width);
        expect(Math.round(box!.height)).toBe(viewport.height);
        await expect(backdrop).toHaveCSS("pointer-events", "none");

        // 4. Every visible control is inside the viewport, and big enough for a finger on touch screens.
        const controls = await page.locator(CONTROLS).evaluateAll((elements) =>
          elements
            .filter((element) => {
              const style = getComputedStyle(element);
              const rect = element.getBoundingClientRect();
              return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
            })
            .map((element) => {
              const rect = element.getBoundingClientRect();
              return {
                label: (element.textContent ?? "").trim().slice(0, 30) || element.getAttribute("name") || element.tagName,
                left: rect.left,
                right: rect.right,
                height: rect.height,
              };
            }),
        );
        expect(controls.length).toBeGreaterThan(0);
        for (const control of controls) {
          expect(control.left, `"${control.label}" starts off-screen`).toBeGreaterThanOrEqual(-0.5);
          expect(control.right, `"${control.label}" ends off-screen`).toBeLessThanOrEqual(viewport.width + 0.5);
          if (viewport.touch) {
            expect(control.height, `"${control.label}" is too small to tap`).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET - 0.5);
          }
        }

        // 5. No text block is wider than the screen.
        const widest = await page.evaluate(() => {
          let max = 0;
          for (const element of document.querySelectorAll("main h1, main h2, main p, main li, main label, main dd")) {
            max = Math.max(max, element.getBoundingClientRect().right);
          }
          return max;
        });
        expect(widest, "text runs past the right edge").toBeLessThanOrEqual(viewport.width + 0.5);

        // 6. On phones, the fixed tab bar never covers the end of the page.
        if (phone) {
          await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
          const gap = await page.evaluate(() => {
            const main = document.querySelector("main")!;
            const last = main.lastElementChild!.getBoundingClientRect();
            const bar = document.querySelector("[data-testid=mobile-nav]")!.getBoundingClientRect();
            return bar.top - last.bottom;
          });
          expect(gap, "the tab bar overlaps the last block").toBeGreaterThanOrEqual(0);
        }
      });
    }
  });
}
