import { useEffect, useState } from "react";

/** Bottom-bar panels share one visible slot, including panels in child components. */
export function usePlayerPopover(name: string) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const closeOthers = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== name) setOpen(false);
    };
    // Capture outside presses without an overlay, so the clicked control still receives them.
    const outside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || !target.closest(`[data-player-popover="${name}"]`)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("playerbar:popover", closeOthers);
    window.addEventListener("keydown", escape);
    if (open) document.addEventListener("pointerdown", outside, true);
    return () => {
      window.removeEventListener("playerbar:popover", closeOthers);
      window.removeEventListener("keydown", escape);
      document.removeEventListener("pointerdown", outside, true);
    };
  }, [name, open]);
  useEffect(() => {
    if (open) window.dispatchEvent(new CustomEvent("playerbar:popover", { detail: name }));
  }, [open, name]);
  return [open, setOpen] as const;
}
