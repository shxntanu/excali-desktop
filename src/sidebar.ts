import { isWithin, parentPath, remapPath } from "./document";
import type { Entry } from "./storage";

export type SidebarOrder = Record<string, string[]>;
export type DropTarget = {
  path: string;
  position: "before" | "after" | "inside";
};

export function orderedEntries(entries: Entry[], order: SidebarOrder): Entry[] {
  const paths = order[parentPath(entries[0]?.path ?? "")] ?? [];
  const rank = (path: string) => {
    const index = paths.indexOf(path);
    return index < 0 ? paths.length : index;
  };
  return [...entries]
    .sort((a, b) => rank(a.path) - rank(b.path))
    .map((entry) => ({
      ...entry,
      children: orderedEntries(entry.children, order),
    }));
}

export function remapOrder(
  order: SidebarOrder,
  from: string,
  to: string,
): SidebarOrder {
  return Object.fromEntries(
    Object.entries(order).map(([folder, paths]) => [
      remapPath(folder, from, to),
      paths.map((path) => remapPath(path, from, to)),
    ]),
  );
}

export function dropFolder(target: DropTarget): string {
  return target.position === "inside" ? target.path : parentPath(target.path);
}

export function canDrop(entry: Entry, target: DropTarget): boolean {
  return (
    entry.path !== target.path &&
    !(entry.folder && isWithin(dropFolder(target), entry.path))
  );
}

export function placeEntry(
  order: SidebarOrder,
  entries: Entry[],
  from: string,
  to: string,
  target: DropTarget,
): SidebarOrder {
  const folder = dropFolder(target);
  const find = (items: Entry[]): Entry[] | undefined => {
    if (items[0] && parentPath(items[0].path) === folder) return items;
    for (const item of items) {
      if (item.path === folder) return item.children;
      const found = find(item.children);
      if (found) return found;
    }
  };
  const paths = (find(orderedEntries(entries, order)) ?? [])
    .map((item) => item.path)
    .filter((path) => path !== from);
  const index =
    target.position === "inside"
      ? paths.length
      : paths.indexOf(target.path) + (target.position === "after" ? 1 : 0);
  paths.splice(Math.max(0, index), 0, to);
  const next = remapOrder(order, from, to);
  const source = parentPath(from);
  if (source !== folder && next[source])
    next[source] = next[source].filter((path) => path !== to);
  return { ...next, [folder]: paths };
}
