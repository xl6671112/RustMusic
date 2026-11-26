import { useSyncExternalStore } from "react";
import { useI18n } from "../i18n";
import { getAccompanimentAvailability, hasSavedAccompaniment, subscribeAccompanimentAvailability, type AccompanimentSource } from "../accompanimentAvailability";

export default function AccompanimentBadge(source: AccompanimentSource) {
  const { tr } = useI18n();
  const items = useSyncExternalStore(subscribeAccompanimentAvailability, getAccompanimentAvailability);
  if (!hasSavedAccompaniment(items, source)) return null;
  return <span data-accompaniment-badge="" title={tr("已有伴奏", "Accompaniment available")} aria-label={tr("已有伴奏", "Accompaniment available")}
    className="inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded border border-[var(--accent-soft)] bg-[var(--accent-weak)] px-0.5 text-[10px] font-semibold leading-none text-[var(--accent-strong)]">伴</span>;
}
