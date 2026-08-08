import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEV_TITLE,
  MARK_CLASS,
  type MarkHost,
  markDevBuild,
  markVersion,
  VERSION_CLASS,
} from '../src/client/build-mark.ts';
import { fakeDoc, findByClass, textOf } from './fake-dom.ts';

/** The brand element the mark hangs on, and the document it lives in. */
function page() {
  const doc = fakeDoc();
  return { doc: doc as unknown as Document, brand: doc.createElement('strong') as unknown as MarkHost };
}

const chips = (brand: unknown) => findByClass(brand, MARK_CLASS);

// A released portal is the common case, and a badge every install carries is a badge nobody reads.
test('a released build is left exactly as it was', () => {
  const { doc, brand } = page();
  const before = doc.title;

  markDevBuild(false, brand, doc);

  assert.equal(doc.title, before);
  assert.equal(chips(brand).length, 0);
});

// The title first: a tab strip is what you read when the page is off screen, which is exactly when
// two identical portals get confused for each other.
test('a checkout names itself in the tab, not only on the page', () => {
  const { doc, brand } = page();

  markDevBuild(true, brand, doc);

  assert.equal(doc.title, DEV_TITLE);
  assert.equal(chips(brand).length, 1);
  assert.equal(textOf(chips(brand)[0]), 'dev');
});

// Called once today. A second call must not stack a second chip — that is the whole reason the
// function looks before it appends.
test('marking twice marks once', () => {
  const { doc, brand } = page();

  markDevBuild(true, brand, doc);
  markDevBuild(true, brand, doc);

  assert.equal(chips(brand).length, 1);
});

// A header the mark cannot find must not stop the title from changing: the tab is the half that
// matters, and half a mark beats none.
test('no brand still renames the tab', () => {
  const { doc } = page();

  markDevBuild(true, null, doc);

  assert.equal(doc.title, DEV_TITLE);
});

const versions = (brand: unknown) => findByClass(brand, VERSION_CLASS);

// Unlike the dev chip, this one is on every portal — it is what a bug report quotes.
test('the brand states the version it is served by', () => {
  const { doc, brand } = page();

  markVersion('0.12.0', brand, doc);

  assert.equal(versions(brand).length, 1);
  assert.equal(textOf(versions(brand)[0]), '0.12.0');
});

// A server too old to report its version leaves the brand alone: a dash beside the wordmark reads
// as a broken page, and the number is exactly the thing that must never be guessed.
test('an unreported version adds nothing', () => {
  const { doc, brand } = page();

  markVersion(undefined, brand, doc);
  markVersion('', brand, doc);

  assert.equal(versions(brand).length, 0);
});

test('marking the version twice marks once', () => {
  const { doc, brand } = page();

  markVersion('0.12.0', brand, doc);
  markVersion('0.12.0', brand, doc);

  assert.equal(versions(brand).length, 1);
});

// Both marks live on the same brand, and a checkout must still say so — the version does not
// replace the dev chip, it precedes it.
test('a checkout shows the version AND the dev chip, in that order', () => {
  const { doc, brand } = page();

  markVersion('0.12.0', brand, doc);
  markDevBuild(true, brand, doc);

  assert.equal(versions(brand).length, 1);
  assert.equal(chips(brand).length, 1);
  assert.deepEqual(
    (brand as unknown as { children: { className: string }[] }).children.map((c) => c.className),
    [VERSION_CLASS, MARK_CLASS],
  );
});
