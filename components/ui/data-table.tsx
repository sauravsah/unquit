"use client";

import { AnimatePresence, motion } from "framer-motion";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "./cn";

export type Column<T> = {
  id: string;
  header: React.ReactNode;
  cell: (row: T) => React.ReactNode;
  /** Return a sortable value to make the column sortable. */
  sortValue?: (row: T) => string | number | null;
  align?: "left" | "right";
  className?: string;
  /** The title line of the mobile card. */
  primary?: boolean;
  hideOnMobile?: boolean;
};

type Sort = { id: string; dir: "asc" | "desc" } | null;

/**
 * Sortable table with a sticky header on desktop and stacked cards on mobile.
 * Rows animate when they are added, removed or re-sorted; new rows flash green.
 */
export function DataTable<T>({
  columns,
  rows,
  getRowId,
  empty,
  initialSort = null,
  maxHeight = "36rem",
  caption,
  rowClassName,
}: {
  columns: Column<T>[];
  rows: T[];
  getRowId: (row: T) => string;
  empty?: React.ReactNode;
  initialSort?: Sort;
  maxHeight?: string;
  caption?: string;
  rowClassName?: (row: T) => string | undefined;
}) {
  const [sort, setSort] = useState<Sort>(initialSort);
  const fresh = useFreshIds(rows.map(getRowId));

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.id === sort.id);
    if (!col?.sortValue) return rows;
    const get = col.sortValue;
    return [...rows].sort((a, b) => {
      const av = get(a);
      const bv = get(b);
      if (av === bv) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      const cmp = av < bv ? -1 : 1;
      return sort.dir === "asc" ? cmp : -cmp;
    });
  }, [rows, sort, columns]);

  function toggle(id: string) {
    setSort((s) => (s?.id !== id ? { id, dir: "desc" } : s.dir === "desc" ? { id, dir: "asc" } : null));
  }

  if (rows.length === 0) return <>{empty}</>;

  const primary = columns.find((c) => c.primary) ?? columns[0]!;

  return (
    <>
      {/* Desktop / tablet */}
      <div className="hidden overflow-auto md:block" style={{ maxHeight }}>
        <table className="min-w-full border-separate border-spacing-0 text-left text-sm">
          {caption ? <caption className="sr-only">{caption}</caption> : null}
          <thead>
            <tr>
              {columns.map((col) => {
                const active = sort?.id === col.id;
                return (
                  <th
                    key={col.id}
                    scope="col"
                    aria-sort={active ? (sort!.dir === "asc" ? "ascending" : "descending") : undefined}
                    className={cn(
                      "sticky top-0 z-10 whitespace-nowrap border-b border-border bg-card/95 px-5 py-2.5 text-2xs font-medium uppercase tracking-wider text-muted-foreground backdrop-blur",
                      col.align === "right" && "text-right",
                    )}
                  >
                    {col.sortValue ? (
                      <button
                        type="button"
                        onClick={() => toggle(col.id)}
                        className={cn(
                          "-mx-1 inline-flex items-center gap-1 rounded px-1 uppercase tracking-wider transition-colors hover:text-foreground",
                          active && "text-foreground",
                        )}
                      >
                        {col.header}
                        {active ? (
                          sort!.dir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />
                        ) : (
                          <ChevronsUpDown className="h-3 w-3 opacity-50" />
                        )}
                      </button>
                    ) : (
                      col.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            <AnimatePresence initial={false}>
              {sorted.map((row) => {
                const id = getRowId(row);
                return (
                  <motion.tr
                    key={id}
                    layout="position"
                    initial={{ opacity: 0, y: -6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    transition={{ type: "spring", stiffness: 420, damping: 36 }}
                    className={cn(
                      "group transition-colors hover:bg-muted/50",
                      fresh.has(id) && "animate-[row-flash_2.4s_ease-out]",
                      rowClassName?.(row),
                    )}
                  >
                    {columns.map((col) => (
                      <td
                        key={col.id}
                        className={cn(
                          "border-b border-border/70 px-5 py-3 align-top text-foreground group-last:border-b-0",
                          col.align === "right" && "text-right",
                          col.className,
                        )}
                      >
                        {col.cell(row)}
                      </td>
                    ))}
                  </motion.tr>
                );
              })}
            </AnimatePresence>
          </tbody>
        </table>
      </div>

      {/* Mobile: one card per row */}
      <ul className="divide-y divide-border md:hidden">
        <AnimatePresence initial={false}>
          {sorted.map((row) => {
            const id = getRowId(row);
            return (
              <motion.li
                key={id}
                layout="position"
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className={cn("px-4 py-3.5", fresh.has(id) && "animate-[row-flash_2.4s_ease-out]")}
              >
                <div className="text-sm font-medium text-foreground">{primary.cell(row)}</div>
                <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2">
                  {columns
                    .filter((c) => c !== primary && !c.hideOnMobile)
                    .map((col) => (
                      <div key={col.id} className="min-w-0">
                        <dt className="text-2xs uppercase tracking-wider text-muted-foreground">{col.header}</dt>
                        <dd className="mt-0.5 truncate text-sm text-foreground">{col.cell(row)}</dd>
                      </div>
                    ))}
                </dl>
              </motion.li>
            );
          })}
        </AnimatePresence>
      </ul>
    </>
  );
}

/** Ids that appeared since the first render (so live rows can be highlighted). */
function useFreshIds(ids: string[]): Set<string> {
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const key = ids.join("|");
  useEffect(() => {
    const current = key ? key.split("|") : [];
    if (seen.current === null) {
      seen.current = new Set(current);
      return;
    }
    const added = current.filter((id) => !seen.current!.has(id));
    current.forEach((id) => seen.current!.add(id));
    if (added.length) {
      setFresh(new Set(added));
      const t = setTimeout(() => setFresh(new Set()), 2500);
      return () => clearTimeout(t);
    }
  }, [key]);
  return fresh;
}
