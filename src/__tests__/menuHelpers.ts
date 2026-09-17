import { act } from "react";

/**
 * The right-click menu keeps the few common actions at the root and the rest
 * one level down. These open a submenu by name, the way a user would.
 */
export function menuItems(host: HTMLElement): HTMLButtonElement[] {
  return [...host.querySelectorAll<HTMLButtonElement>(".mm-menu-item")];
}

export function openSubmenu(host: HTMLElement, label: string): void {
  const item = menuItems(host).find((b) => b.hasAttribute("data-submenu") && b.textContent?.includes(label));
  if (!item) throw new Error(`no submenu "${label}"`);
  act(() => item.click());
}

export function back(host: HTMLElement): void {
  const b = host.querySelector<HTMLButtonElement>('.mm-menu-head button[aria-label="Back"]');
  if (b) act(() => b.click());
}

/** Every label in the menu: the root plus each submenu, opened in turn. */
export function allMenuLabels(host: HTMLElement): string[] {
  const labels = menuItems(host).map((b) => b.textContent ?? "");
  const subs = menuItems(host).filter((b) => b.hasAttribute("data-submenu")).map((b) => b.textContent ?? "");
  for (const sub of subs) {
    openSubmenu(host, sub);
    labels.push(...menuItems(host).map((b) => b.textContent ?? ""));
    back(host);
  }
  return labels;
}
