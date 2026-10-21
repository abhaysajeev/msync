import { useState } from "preact/hooks";
import { api } from "../lib/api";
import { navigate } from "../router";
import { Mark } from "./icons";

export function Login({ onDone }: { onDone: () => void }) {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      await api.post("/api/admin/login", { password: pw });
      onDone();
      navigate("/", true);
    } catch (x: any) {
      setErr(x.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <main class="solo">
      <form class="solo-card" onSubmit={submit}>
        <div>
          <Mark size={30} />
          <h1 style={{ marginTop: "18px" }}>Sign in</h1>
        </div>
        <div class="field">
          <label for="pw">Password</label>
          <input id="pw" class="input" type="password" autoComplete="current-password" value={pw}
            onInput={(e) => setPw((e.target as HTMLInputElement).value)} autoFocus />
          {err && <span class="form-error" role="alert">{err}</span>}
        </div>
        <button class="btn primary" type="submit" disabled={busy || !pw}>{busy ? "Signing in…" : "Sign in"}</button>
      </form>
    </main>
  );
}
