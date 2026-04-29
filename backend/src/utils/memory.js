export async function safeClosePage(page) {
  if (!page) {
    return;
  }

  try {
    const isClosed = typeof page.isClosed === 'function' ? page.isClosed() : false;
    if (!isClosed) {
      await page.close();
    }
  } catch (error) {
    console.warn('[pdf] Failed to close page:', error.message);
  }
}

export async function safeCloseBrowser(browser) {
  if (!browser) {
    return;
  }

  try {
    const pages = typeof browser.pages === 'function' ? await browser.pages() : [];
    await Promise.allSettled(pages.map((page) => safeClosePage(page)));
  } catch (error) {
    console.warn('[pdf] Failed to enumerate browser pages during cleanup:', error.message);
  }

  try {
    await browser.close();
  } catch (error) {
    console.warn('[pdf] Failed to close browser:', error.message);
  }
}

export function runGarbageCollectionIfAvailable() {
  if (typeof global.gc !== 'function') {
    return false;
  }

  try {
    global.gc();
    return true;
  } catch (error) {
    console.warn('[memory] global.gc() failed:', error.message);
    return false;
  }
}
