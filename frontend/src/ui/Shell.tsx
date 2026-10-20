import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { api } from "../lib/api";
import { navigate } from "../router";
import { Mark } from "./icons";

export function TopBar({ current, admin }: { current: "home" | "speed"; admin: boolean }) {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const f = () => setScrolled(window.scrollY > 4);
    window.addEventListener("scroll", f, { passive: true });
    return () => window.removeEventListener("scroll", f);
  }, []);
  const go = (to: string) => (e: Event) => {
    e.preventDefault();
    navigate(to);
  };
  return (
    <header class={`topbar${scrolled ? " scrolled" : ""}`}>
      <div class="topbar-inner">
        <a href="/" class="brand" onClick={go("/")}>
          <Mark />
          msync
        </a>
        <nav class="toplinks" aria-label="Main">
          {admin && <a href="/" aria-current={current === "home" ? "page" : undefined} onClick={go("/")}>Movie nights</a>}
          <a href="/speed" aria-current={current === "speed" ? "page" : undefined} onClick={go("/speed")}>Speed test</a>
        </nav>
        <span class="spacer" />
        {admin && (
          <button class="text-btn muted" onClick={async () => {
            await api.post("/api/logout");
            navigate("/login");
          }}>Sign out</button>
        )}
      </div>
    </header>
  );
}

export function Page({ current, admin, children }: { current: "home" | "speed"; admin: boolean; children: ComponentChildren }) {
  return (
    <>
      <TopBar current={current} admin={admin} />
      <main class="canvas">{children}</main>
    </>
  );
}
