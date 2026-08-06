// Fake DOM faithful to what graph.js / view.js touch: createElement/createTextNode,
// className/textContent/title/style, classList, onclick, append/replaceChildren,
// addEventListener. getElementById returns a stable node per id so a view can look up
// its widget hosts. No real browser — shared by every view-level test.
export function fakeDoc() {
  const byId = new Map<string, any>();
  // The tag is RECORDED (real DOMs have one): the search view's highlighter must produce <mark>
  // ELEMENTS around matched text, and a fake that forgets the tag cannot tell that apart from a
  // string of markup pasted into textContent — the exact bug the rule against innerHTML prevents.
  const make = (tag = '') => {
    const cls = new Set<string>();
    return {
      tag,
      // className and classList are the SAME state, as in a real DOM: assigning the
      // string resets the set, classList mutations show through the string. Split
      // state here would let a class set via `className = '… on'` survive a
      // classList.remove('on') — masking exactly the toggle-off paths views rely on.
      get className() {
        return [...cls].join(' ');
      },
      set className(v: string) {
        cls.clear();
        for (const c of v.split(/\s+/)) if (c) cls.add(c);
      },
      textContent: '',
      title: '',
      value: '',
      // Style values are RECORDED, not discarded: a proportion bar encodes its meaning in
      // `width`, so a fake that swallows it lets a bar with wrong shares pass every test.
      style: {
        _s: {} as Record<string, string>,
        setProperty(k: string, v: string) {
          this._s[k] = v;
        },
        get width() {
          return this._s.width ?? '';
        },
        set width(v: string) {
          this._s.width = v;
        },
        get background() {
          return this._s.background ?? '';
        },
        set background(v: string) {
          this._s.background = v;
        },
        get marginTop() {
          return this._s.marginTop ?? '';
        },
        set marginTop(v: string) {
          this._s.marginTop = v;
        },
      },
      children: [] as any[],
      onclick: null as any,
      parent: null as any,
      // parent/remove/firstChild/lastChild are what the toast rails actually use: without
      // them the eviction path (the one that froze the tab) could not be exercised at all.
      get firstChild() {
        return this.children[0] ?? null;
      },
      get lastChild() {
        return this.children[this.children.length - 1] ?? null;
      },
      append(...n: any[]) {
        for (const c of n) {
          if (c && typeof c === 'object') c.parent = this;
          this.children.push(c);
        }
      },
      replaceChildren(...n: any[]) {
        // The nodes that go DETACH, as in a real DOM: their `parent` must become null, or a late
        // async fill would still find a parent on a node the page no longer holds — which is the
        // very case the drawer relies on to drop a stale response.
        for (const c of this.children) if (c && typeof c === 'object' && c.parent === this) c.parent = null;
        for (const c of n) {
          if (c && typeof c === 'object') c.parent = this;
        }
        this.children = n;
      },
      // A late fetch inserts its block beside the one it was read from, and reaches the parent
      // through the node itself — so both of these must exist here, and `parentElement` must be
      // NULL once the node is detached: that null is the whole staleness guard, and a fake without
      // it would let a test pass while the real drawer painted into a panel the user had replaced.
      get parentElement() {
        return this.parent;
      },
      insertBefore(node: any, ref: any) {
        if (node && typeof node === 'object') node.parent = this;
        const i = this.children.indexOf(ref);
        if (i < 0) this.children.push(node);
        else this.children.splice(i, 0, node);
        return node;
      },
      remove() {
        const p = this.parent;
        if (!p) return;
        const i = p.children.indexOf(this);
        if (i >= 0) p.children.splice(i, 1);
        this.parent = null;
      },
      // Ancestor check used by the picker's click-outside handler (mount.contains(target)).
      contains(n: any): boolean {
        return this === n || this.children.some((c: any) => c && typeof c.contains === 'function' && c.contains(n));
      },
      // Single-class selectors only — the one shape app.js uses. Anything else THROWS:
      // a silently-null unsupported selector would be indistinguishable from a real
      // 'not found', letting a test assert null vacuously against a lookup the fake
      // never understood.
      querySelector(sel: string): any {
        if (!/^\.[\w-]+$/.test(sel))
          throw new Error(`fake-dom querySelector supports only '.class' selectors, got '${sel}'`);
        return findByClass(this, sel.slice(1))[0] ?? null;
      },
      addEventListener() {},
      removeEventListener() {},
      scrollIntoView() {},
      // Attributes are RECORDED, for the same reason style values are: a row that announces
      // itself as a button to assistive tech does it through `role`, and a fake that swallows
      // setAttribute lets a view claiming to be accessible pass without being it.
      attrs: {} as Record<string, string>,
      setAttribute(k: string, v: string) {
        this.attrs[k] = String(v);
      },
      getAttribute(k: string): string | null {
        return this.attrs[k] ?? null;
      },
      // A real DOMTokenList takes MANY tokens per call; a fake that took one silently dropped
      // the rest, so `remove('wait', 'err')` cleared only the first and the test read as a bug
      // in the view instead of a gap in the fake.
      classList: {
        add: (...c: string[]) => {
          for (const k of c) cls.add(k);
        },
        remove: (...c: string[]) => {
          for (const k of c) cls.delete(k);
        },
        contains: (c: string) => cls.has(c),
        toggle: (c: string, force?: boolean) => {
          if (force === true) cls.add(c);
          else if (force === false) cls.delete(c);
          else if (cls.has(c)) cls.delete(c);
          else cls.add(c);
        },
      },
    };
  };
  // Document-level listeners are recorded so a test can dispatch synthetic events
  // (keydown/click) to the handlers the picker registers on `document`.
  const docListeners: Record<string, Array<(e: any) => void>> = {};
  return {
    createElement: (tag: string) => make(tag),
    createTextNode: (t: string) => ({ textContent: t }),
    getElementById: (id: string) => {
      let n = byId.get(id);
      if (!n) {
        n = make();
        byId.set(id, n);
      }
      return n;
    },
    addEventListener(type: string, fn: (e: any) => void) {
      (docListeners[type] ||= []).push(fn);
    },
    removeEventListener(type: string, fn: (e: any) => void) {
      docListeners[type] = (docListeners[type] || []).filter((f) => f !== fn);
    },
    _fire(type: string, event: any) {
      (docListeners[type] || []).slice().forEach((fn) => fn(event));
    },
    documentElement: { style: { overflow: '' } },
    body: { style: { overflow: '' } },
    _byId: byId,
  };
}

/** The text a user would read in a fake-DOM subtree: leaf textContent, children joined in order. */
export function textOf(n: any): string {
  const own = n.children?.length ? '' : (n.textContent ?? '');
  return own + (n.children ?? []).map(textOf).join('');
}

/** Walk a fake-DOM subtree collecting every node whose className contains `cls`. */
export function findByClass(root: any, cls: string, acc: any[] = []): any[] {
  for (const c of root.children ?? []) {
    if (typeof c.className === 'string' && c.className.split(' ').includes(cls)) acc.push(c);
    findByClass(c, cls, acc);
  }
  return acc;
}
