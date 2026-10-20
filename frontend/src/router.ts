import { useEffect, useState } from "preact/hooks";

const EVT = "msync:navigate";

export function navigate(to: string, replace = false): void {
  if (replace) history.replaceState(null, "", to);
  else history.pushState(null, "", to);
  window.dispatchEvent(new Event(EVT));
}

export function usePath(): string {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const f = () => setPath(location.pathname);
    window.addEventListener("popstate", f);
    window.addEventListener(EVT, f);
    return () => {
      window.removeEventListener("popstate", f);
      window.removeEventListener(EVT, f);
    };
  }, []);
  return path;
}
