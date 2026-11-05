import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { useLocation, useNavigationType, useSearchParams } from "react-router-dom";

/*
 * List pages (Library, Podcasts, Folders, Home) keep their search, tab, filters and sort in the URL. These helpers
 * make leaving and coming back land you where you were: the "← Library" link returns to the last filtered URL, and
 * the scroll position comes back with it.
 */

const SEARCH = "audio.list.search:";
const SCROLL = "audio.list.scroll:";

function read(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string) {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}

/**
 * Change the URL's query in place. Builds on the live URL rather than the last render's params: the router applies
 * updates as transitions, so two quick taps (or fast typing) would otherwise undo each other.
 */
export function useUpdateParams() {
  const [, setParams] = useSearchParams();
  return useCallback(
    (change: (params: URLSearchParams) => void) => {
      const next = new URLSearchParams(window.location.search);
      change(next);
      setParams(next, { replace: true });
    },
    [setParams],
  );
}

/** Where a "back to the list" link should go: the list as it was last filtered. */
export function listHref(path: string): string {
  return path + (read(SEARCH + path) ?? "");
}

/** State for a link back to a list, so the list restores its scroll position. */
export const RESTORE = { restoreList: true };

function scroller(): HTMLElement | null {
  return document.querySelector(".main");
}

/** New pages start at the top; going back (or forward) is left to the page being returned to. */
export function useScrollTopOnNavigate() {
  const { pathname } = useLocation();
  const type = useNavigationType();
  useLayoutEffect(() => {
    if (type !== "POP") scroller()?.scrollTo({ top: 0, behavior: "instant" });
  }, [pathname, type]);
}

/**
 * Call on a list page. Remembers its URL query and scroll position, and puts the scroll back once ``ready`` (the
 * list has rendered) when you return with Back or a breadcrumb.
 */
export function useListMemory(ready: boolean) {
  const location = useLocation();
  const type = useNavigationType();
  const key = SCROLL + location.pathname + location.search;

  useEffect(() => {
    write(SEARCH + location.pathname, location.search);
  }, [location.pathname, location.search]);

  useEffect(() => {
    const el = scroller();
    if (!el) return;
    let timer = 0;
    const save = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => write(key, String(Math.round(el.scrollTop))), 120);
    };
    el.addEventListener("scroll", save, { passive: true });
    return () => {
      window.clearTimeout(timer);
      el.removeEventListener("scroll", save);
    };
  }, [key]);

  const returning = type === "POP" || !!(location.state as typeof RESTORE | null)?.restoreList;
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || !ready) return;
    restored.current = true;
    const y = Number(read(key) || 0);
    if (returning && y) scroller()?.scrollTo({ top: y, behavior: "instant" });
    // Only on arrival: later filter changes keep whatever scroll you're at.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);
}
