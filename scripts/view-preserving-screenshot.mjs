async function readPresentationState(page, locator) {
  const [pageState, scrollChain] = await Promise.all([
    page.evaluate(() => ({
      href: location.href,
      timeOrigin: performance.timeOrigin,
      navigationCount: performance.getEntriesByType("navigation").length,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      visualWidth: window.visualViewport?.width ?? null,
      visualHeight: window.visualViewport?.height ?? null,
      visualOffsetLeft: window.visualViewport?.offsetLeft ?? null,
      visualOffsetTop: window.visualViewport?.offsetTop ?? null,
      visualScale: window.visualViewport?.scale ?? null,
      devicePixelRatio: window.devicePixelRatio,
      windowX: window.scrollX,
      windowY: window.scrollY,
    })),
    locator.evaluate((node) => {
      const chain = [];
      let current = node;
      while (current) {
        if (
          current === document.scrollingElement ||
          current.scrollHeight > current.clientHeight ||
          current.scrollWidth > current.clientWidth
        ) {
          chain.push({
            tag: current.tagName,
            testId: current.getAttribute("data-testid"),
            scrollTop: current.scrollTop,
            scrollLeft: current.scrollLeft,
          });
        }
        current = current.parentElement;
      }
      return chain;
    }),
  ]);
  return { page: pageState, scrollChain };
}

function samePresentation(before, after) {
  return JSON.stringify(before) === JSON.stringify(after);
}

function sameBox(before, after, tolerance = 0.5) {
  if (!after) return false;
  return ["x", "y", "width", "height"].every(
    (key) => Math.abs(before[key] - after[key]) <= tolerance,
  );
}

export async function captureVisibleElement(page, locator, options = {}) {
  await locator.waitFor({ state: "visible" });
  await page.evaluate(() => document.fonts.ready);
  const before = await readPresentationState(page, locator);
  const box = await locator.boundingBox();
  if (!box || box.width <= 0 || box.height <= 0) {
    throw new Error("view-preserving screenshot target has no rendered box");
  }

  const viewport = { width: before.page.innerWidth, height: before.page.innerHeight };
  const tolerance = 0.5;
  if (
    box.x < -tolerance ||
    box.y < -tolerance ||
    box.x + box.width > viewport.width + tolerance ||
    box.y + box.height > viewport.height + tolerance
  ) {
    throw new Error(
      `view-preserving screenshot target is outside the current viewport: ${JSON.stringify({ box, viewport })}`,
    );
  }

  const left = Math.max(0, Math.floor(box.x));
  const top = Math.max(0, Math.floor(box.y));
  const right = Math.min(viewport.width, Math.ceil(box.x + box.width));
  const bottom = Math.min(viewport.height, Math.ceil(box.y + box.height));
  const clip = { x: left, y: top, width: right - left, height: bottom - top };
  const image = await page.screenshot({ ...options, clip });
  const [after, afterBox] = await Promise.all([
    readPresentationState(page, locator),
    locator.boundingBox(),
  ]);

  if (!samePresentation(before, after) || !sameBox(box, afterBox)) {
    throw new Error(
      `screenshot changed the current presentation: ${JSON.stringify({ before: { ...before, box }, after: { ...after, box: afterBox } })}`,
    );
  }
  return { image, box, clip, presentation: before };
}
