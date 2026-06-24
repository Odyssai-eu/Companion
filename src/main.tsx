import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import App from "./App";
import { PiTerminalHost } from "./components/chat/PiTerminalHost";
import { AuthProvider } from "./hooks/useAuth";
import { PiSessionProvider } from "./hooks/usePiSession";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <PiSessionProvider>
          <App />
          {/* Persistent Pi (omp) terminal — lives outside <Routes> so the
           *  ttyd session survives navigation. See usePiSession. */}
          <PiTerminalHost />
        </PiSessionProvider>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
