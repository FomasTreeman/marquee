/** Create an element, optionally classed and appended. The one DOM helper
 *  every screen builds itself from. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  parent?: HTMLElement,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  parent?.appendChild(node)
  return node
}
