import { render, type ComponentType } from "preact";
import { useEffect, useState } from "preact/hooks";
import { api, type Me } from "./lib/api";
import { navigate, usePath } from "./router";
import "./styles.css";
import { Join } from "./ui/Join";
import { Login } from "./ui/Login";
import { Speed } from "./ui/Speed";

// hls.js and tus-js-client are heavy; load them only on the screens that use them
function lazy<P>(load: () => Promise<ComponentType<P>>) {
  let C: ComponentType<P> | null = null;
  return (props: P) => {
    const [, set] = useState(0);
    useEffect(() => {
      if (!C) load().then((c) => { C = c; set(1); });
    }, []);
    return C ? <C {...(props as any)} /> : null;
  };
}
const Watch = lazy<{ code: string }>(() => import("./ui/Watch").then((m) => m.Watch));
const Home = lazy<{}>(() => import("./ui/Home").then((m) => m.Home));

function App() {
  const path = usePath();
  const [me, setMe] = useState<Me | null>(null);
  const refresh = () => api.get<Me>("/api/me").then(setMe).catch(() => setMe({ admin: false, guest: null }));
  useEffect(() => {
    void refresh();
  }, [path]);

  if (!me) return null;

  const room = path.match(/^\/r\/([a-z0-9]+)\/?$/);
  if (room) {
    const code = room[1];
    const inside = me.admin || (me.guest?.room === code && me.guest.status === "admitted");
    return inside ? <Watch code={code} /> : <Join code={code} onAdmitted={refresh} />;
  }
  if (path === "/speed") return <Speed admin={me.admin} />;
  if (path === "/login") return <Login onDone={refresh} />;
  if (me.admin) return <Home />;
  // a guest who wanders to / goes back to their room; anyone else signs in
  if (me.guest?.room) {
    navigate(`/r/${me.guest.room}`, true);
    return null;
  }
  return <Login onDone={refresh} />;
}

render(<App />, document.getElementById("app")!);
