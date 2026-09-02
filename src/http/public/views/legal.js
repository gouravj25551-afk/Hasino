import { el } from '../lib/dom.js';
import { Button } from '../components/Button.js';
import { back as goBack } from '../lib/router.js';
import { PRIVACY, TERMS } from '../lib/legal-content.js';

/**
 * The Terms & Conditions and Privacy Policy, rendered from lib/legal-content.js.
 *
 * One renderer for both — they are the same shape (title, last-updated, intro,
 * numbered sections of paragraph/list/lead blocks), so they read as one pair of
 * documents rather than two hand-built pages. Reached at #/terms and #/privacy,
 * and linked from the sign-in consent line.
 */
function renderDoc(container, app, doc, otherHash, otherLabel) {
  container.innerHTML = '';
  container.scrollTop = 0;
  window.scrollTo(0, 0);

  const back = Button({ label: 'Back', icon: 'chevron-left', size: 'sm', onClick: () => goBack('#/home') });
  back.classList.add('legal-back');
  container.append(back);

  const article = el('article', 'legal');

  const head = el('header', 'legal-head');
  head.append(el('h1', 'legal-title', doc.title));
  head.append(el('p', 'legal-updated', doc.updated));
  article.append(head);

  for (const text of doc.intro ?? []) article.append(el('p', 'legal-lede', text));

  for (const section of doc.sections) {
    const h = el('h2', 'legal-section-title');
    h.append(el('span', 'legal-section-n', section.n), document.createTextNode(section.title));
    article.append(h);
    for (const block of section.blocks) {
      if (block.ul) {
        const ul = el('ul', 'legal-list');
        for (const item of block.ul) ul.append(el('li', null, item));
        article.append(ul);
        continue;
      }
      const p = el('p', 'legal-p');
      if (block.lead) p.append(Object.assign(el('strong', 'legal-lead'), { textContent: block.lead + ' ' }));
      if (block.p) p.append(document.createTextNode(block.p));
      article.append(p);
    }
  }

  // A quiet cross-link to the companion document, so a reader of one can reach
  // the other without going back through sign-in.
  const foot = el('div', 'legal-foot');
  const other = el('a', 'legal-link', otherLabel);
  other.href = otherHash;
  foot.append(document.createTextNode('See also: '), other);
  article.append(foot);

  container.append(article);
}

export function renderTerms(container, app) {
  renderDoc(container, app, TERMS, '#/privacy', 'Privacy Policy');
}

export function renderPrivacy(container, app) {
  renderDoc(container, app, PRIVACY, '#/terms', 'Terms & Conditions');
}
