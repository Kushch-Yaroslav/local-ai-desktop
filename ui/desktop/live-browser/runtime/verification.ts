/** Local AI Desktop: bounded scalar evidence, adapted from original browser-scenario-runner.ts. */
import type { Page } from 'playwright-core';
export async function textFit(page: Page, selector: string): Promise<number | null> {
  const target = page.locator(selector);
  if ((await target.count()) !== 1) return null;
  return target.evaluate(
    (root) => {
      if (root.closest('input,textarea,select,[contenteditable],[data-private],[data-sensitive]'))
        return null;
      const element = root as HTMLElement,
        b = element.getBoundingClientRect(),
        style = window.getComputedStyle(root);
      if (
        !b.width ||
        !b.height ||
        style.visibility !== 'visible' ||
        Number(style.opacity) === 0 ||
        !element.offsetWidth ||
        !element.offsetHeight
      )
        return null;
      let left = b.left,
        top = b.top,
        right = b.right,
        bottom = b.bottom;
      for (let e: Element | null = root; e; e = e.parentElement) {
        const s = window.getComputedStyle(e),
          r = e.getBoundingClientRect();
        if (s.visibility !== 'visible' || s.display === 'none' || Number(s.opacity) === 0)
          return null;
        if (s.transform !== 'none') {
          const m = new window.DOMMatrixReadOnly(s.transform);
          if (!m.is2D || m.b !== 0 || m.c !== 0 || m.a <= 0 || m.d <= 0) return null;
        }
        if (e !== root && ['hidden', 'clip', 'scroll', 'auto'].includes(s.overflowX)) {
          left = Math.max(left, r.left);
          right = Math.min(right, r.right);
        }
        if (e !== root && ['hidden', 'clip', 'scroll', 'auto'].includes(s.overflowY)) {
          top = Math.max(top, r.top);
          bottom = Math.min(bottom, r.bottom);
        }
      }
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node: Node | null,
        count = 0,
        texts = 0,
        violations = 0;
      while ((node = walker.nextNode()) && count++ < 300) {
        if (
          !node.textContent?.trim() ||
          node.parentElement?.closest(
            'script,style,input,textarea,select,[contenteditable],[data-private],[data-sensitive]'
          )
        )
          continue;
        const parent = node.parentElement!,
          s = window.getComputedStyle(parent);
        if (s.display === 'none' || s.visibility !== 'visible' || Number(s.opacity) === 0) continue;
        texts++;
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const r of Array.from(range.getClientRects()))
          if (
            r.width &&
            r.height &&
            (r.left < left - 1 || r.right > right + 1 || r.top < top - 1 || r.bottom > bottom + 1)
          )
            violations++;
      }
      // A bounded scan that was truncated cannot certify the remaining text.
      return count >= 300 || !texts ? null : violations;
    },
    undefined,
    { timeout: 5000 }
  );
}
