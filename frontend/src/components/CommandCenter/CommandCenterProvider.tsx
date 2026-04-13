"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import CommandCenterModal from "./CommandCenterModal";

interface CommandCenterApi {
  open: () => void;
  close: () => void;
  isOpen: boolean;
}

const CommandCenterContext = createContext<CommandCenterApi>({
  open: () => {},
  close: () => {},
  isOpen: false,
});

export function useCommandCenter() {
  return useContext(CommandCenterContext);
}

/**
 * Infer the current operational scope from the URL. This runs per-render
 * but the result is memoized against pathname + search. Rules:
 *  - /conversations/:id → conversationId
 *  - /customers/:id or /contacts/:id → contactId
 *  - ?conversationId= / ?contactId= / ?id= fallbacks
 *  - otherwise → empty (global mode)
 */
function inferContext(pathname: string | null, search: URLSearchParams | null) {
  const ctx: { conversationId?: string; contactId?: string } = {};
  if (!pathname) return ctx;

  const convPath = pathname.match(/\/conversations\/([^/?#]+)/);
  if (convPath) ctx.conversationId = convPath[1];

  const custPath = pathname.match(/\/(?:customers|contacts)\/([^/?#]+)/);
  if (custPath) ctx.contactId = custPath[1];

  if (search) {
    const q =
      search.get("conversationId") || (pathname.startsWith("/conversations") ? search.get("id") : null);
    if (q && !ctx.conversationId) ctx.conversationId = q;
    const c = search.get("contactId");
    if (c && !ctx.contactId) ctx.contactId = c;
  }
  return ctx;
}

/**
 * Mounts the OS-level command palette and installs the global
 * Cmd/Ctrl+K listener. Drop this inside AppLayout (client tree only).
 */
export function CommandCenterProvider({ children }: { children: React.ReactNode }) {
  const { token } = useAuth();
  const pathname = usePathname();
  const search = useSearchParams();
  const [isOpen, setIsOpen] = useState(false);

  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);

  const context = useMemo(() => inferContext(pathname, search), [pathname, search]);

  useEffect(() => {
    function isTypingTarget(t: EventTarget | null) {
      if (!(t instanceof HTMLElement)) return false;
      const tag = t.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
      if (t.isContentEditable) return true;
      return false;
    }

    function onKey(e: KeyboardEvent) {
      const isMeta = e.metaKey || e.ctrlKey;
      if (!isMeta) return;
      if (e.key !== "k" && e.key !== "K") return;
      // Cmd/Ctrl+K must beat the browser address-bar shortcut even from inputs.
      e.preventDefault();
      e.stopPropagation();
      setIsOpen((v) => !v);
      // Don't block typing of the literal "k" — we only grabbed Cmd/Ctrl+K.
      void isTypingTarget;
    }
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true } as any);
  }, []);

  const api = useMemo(() => ({ open, close, isOpen }), [open, close, isOpen]);

  return (
    <CommandCenterContext.Provider value={api}>
      {children}
      {token && (
        <CommandCenterModal open={isOpen} onClose={close} token={token} context={context} />
      )}
    </CommandCenterContext.Provider>
  );
}
