import { el } from '../lib/dom.js';
import { api, ApiError, apiImageDataUrl } from '../lib/api.js';
import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { currentPosition } from '../lib/location.js';
import { dateLong } from '../lib/format.js';
import { Stepper } from '../components/Stepper.js';
import { CARD_ASPECT, canCropImages, cropImage } from '../lib/imagecrop.js';
import { iconEl } from '../lib/icons.js';

/**
 * "List your salon" — a signed-in customer applying to join.
 *
 * The application lands as pending, is invisible to customers, and grants the
 * applicant nothing. An admin approving it is what makes the salon live and
 * its author a salon owner, in that one step.
 */
export function renderApply(container, app) {
  const session = app.requireSession();
  if (!session) return;

  // An approved owner does not get a form, or a card offering a link to one.
  // They asked for "list your salon" and they already have one listed, so the
  // answer is the panel itself. Replaced rather than pushed: this route is a
  // junction, not a place, and Back should return to wherever they came from
  // instead of bouncing through here again.
  if (session.role === 'business' && session.salon && session.salon.status === 'active') {
    window.location.replace('/business');
    return;
  }

  container.innerHTML = '';
  container.append(el('h1', null, 'List your salon'));

  // Step one, before the form: a verified address. The server refuses an
  // application from an unverified one (403 EMAIL_NOT_VERIFIED), so offering
  // the form first would be twenty fields and then a refusal.
  if (session.emailVerified === false) {
    const gate = el('div', 'panel');
    gate.append(el('h2', null, 'Verify your email first'));
    gate.append(el('p', 'sub',
      `A Hasino admin reviews every application and will reach you at ${session.email || 'your address'}, `
      + 'so it has to be an address you have confirmed. Open the verification link your sign-in '
      + 'provider sent you, then come back.'));
    const again = Button({
      label: 'I have verified it — check again',
      variant: 'primary',
      onClick: async () => {
        try {
          await app.refreshSession();
          app.navigate('#/apply');
          location.reload();
        } catch {
          gate.append(el('div', 'out bad', 'Still not verified. Check your inbox and try again.'));
        }
      },
    });
    gate.append(again);
    container.append(gate);
    return;
  }

  // One salon per owner, so anyone who has already applied gets the state of
  // that application rather than a form that would only 409.
  if (session.salon) {
    const done = el('div', 'panel');
    if (session.salon.status === 'pending') {
      done.append(el('h2', null, 'Your application is under review'));
      done.append(el('span', 'pill warn', 'Pending approval'));
      done.append(el('p', 'sub',
        `${session.salon.name} is with a Hasino admin. It is not visible to customers yet, and your `
        + 'salon dashboard unlocks the moment it is approved.'));
      done.append(el('div', 'note',
        'Submitting a request does not make you a salon owner — this account is still an ordinary '
        + 'customer account, and stays one until an admin approves the request. There is nothing '
        + 'further to do here; you cannot submit a second request while this one is open.'));
      if (session.salon.submittedAt) {
        done.append(el('div', 'meta', `Submitted ${dateLong(session.salon.submittedAt, undefined)}`));
      }
    } else if (session.salon.status === 'rejected') {
      // Not a dead end: resubmitting sends it back to review, which is a way
      // to fix what was wrong rather than a way around approval.
      done.append(el('h2', null, 'Your application was not approved'));
      done.append(el('p', 'sub',
        `${session.salon.name} was turned down. Update the details below and submit again — `
        + 'it goes back to a Hasino admin for review.'));

      // Why, in the admin's own words. It was always recorded and never shown
      // to the person who needed it, which left "not approved" and no way to
      // work out what to fix.
      if (session.salon.rejectionReason) {
        const why = el('div', 'out bad');
        why.style.whiteSpace = 'pre-line';
        why.textContent = `Reason given: ${session.salon.rejectionReason}`;
        done.append(why);
      } else {
        done.append(el('div', 'note',
          'No reason was recorded. If it is not obvious what to change, contact Hasino support '
          + 'before resubmitting.'));
      }
      container.append(done);
      renderForm(container, app, session);
      return;
    } else if (session.role === 'business') {
      // An owner whose salon is not active — suspended, say. The redirect at
      // the top of this view only covers the live case, and this one still
      // needs its panel: that is where they read their bookings and fix
      // whatever put them here.
      done.append(el('h2', null, 'You already have a salon'));
      done.append(el('p', 'sub', `${session.salon.name} is ${session.salon.status}.`));
      const go = el('a', 'btn primary', 'Open your salon panel');
      go.href = '/business';
      done.append(go);
    } else {
      done.append(el('h2', null, `${session.salon.name} is ${session.salon.status}`));
      done.append(el('p', 'sub', 'Contact Hasino support if you think this is wrong.'));
    }
    container.append(done);
    return;
  }

  container.append(
    el('p', 'sub',
      'Tell us about your salon. A Hasino admin reviews every application before it goes live — '
      + 'usually a couple of days.'),
  );

  renderForm(container, app, session);
}

/**
 * The application itself, shared by a first submission and a resubmission.
 *
 * One form with every field on it asked for a salon's name, address, menu,
 * hours, photos and description in a single scroll, which reads as work rather
 * than as setup — and the first sign that anything was wrong was a 400 after
 * you had filled in all of it.
 *
 * Six steps now, over exactly the same fields and exactly the same request.
 * Nothing about ApplyInput changed: the payload assembled at the end is
 * byte-for-byte the one this form always sent. What changed is that the two
 * things the server actually rejects — a missing name, a missing address or
 * city — are caught on the step that asks for them, and that there is a review
 * screen before anything is sent.
 */
function renderForm(container, app, session) {
  const panel = el('div', 'panel');

  const name = Input({ label: 'Salon name', placeholder: 'Sharp & Co' });

  /**
   * Who is applying — pre-filled from the account they signed in with.
   *
   * The email is shown and cannot be typed. It is the address the admin will
   * reply to and the one this request is tied to, and it comes from the
   * verified session: asking for it again would be a second answer to a
   * question already answered, and a field where somebody could name an inbox
   * that is not theirs. The server ignores any email in the body for exactly
   * that reason.
   *
   * The name and number are editable because they are contact details rather
   * than identity — Google supplies a name and no number at all, and the admin
   * reviewing this needs a person to ring, not just a shop.
   */
  const ownerName = Input({ label: 'Your name', placeholder: 'Priya Sharma' });
  ownerName.input.value = session?.name ?? '';
  const ownerPhone = Input({ label: 'Your phone number', type: 'tel', placeholder: '+919876543210' });
  ownerPhone.input.value = session?.phone ?? '';

  const ownerEmail = el('label', 'field');
  ownerEmail.append(el('span', null, 'Your email'));
  const emailShown = el('div', 'review-value');
  emailShown.style.cssText = 'padding:10px 0; font-weight:var(--weight-semibold)';
  emailShown.textContent = session?.email ?? 'the address you signed in with';
  ownerEmail.append(emailShown);
  ownerEmail.append(el('div', 'meta', 'From the account you signed in with. This is where a Hasino admin will reply.'));
  const address = Input({ label: 'Address', placeholder: '12 MG Road, Indiranagar' });
  const city = Input({ label: 'City', placeholder: 'Bengaluru' });
  const area = Input({ label: 'Area (optional)', placeholder: 'Indiranagar' });
  // No latitude/longitude fields. The server geocodes the address, and the
  // button below is for an owner standing in their own shop — both beat asking
  // anyone to type two decimal numbers they cannot check.
  let coords = null;
  const phone = Input({ label: 'Salon phone', type: 'tel', placeholder: '+91 98765 43210' });
  const openAt = Input({ label: 'Opens at', type: 'time' });
  const closeAt = Input({ label: 'Closes at', type: 'time' });
  openAt.input.value = '10:00';
  closeAt.input.value = '20:00';
  const photos = Input({ label: 'More photo URLs (one per line)' });

  /**
   * The storefront photo, uploaded rather than linked.
   *
   * This step used to say "paste image links for now — direct uploads are
   * coming", which asked a barber to find an image host before they could
   * apply and made the photo an admin is judging depend on a third party
   * staying up. The bytes now go to Hasino before the salon exists:
   * PUT /api/salons/apply/image stages them against the applicant, and the
   * submission moves them onto the salon it creates.
   *
   * Framed through the same dialog the salon panel and the admin use, so what
   * is uploaded is already the card's 16:10 and already under the size cap —
   * which is what a straight-from-the-phone photo usually is not.
   *
   * The preview is the image fetched back from the server, not the local file:
   * a preview drawn from what was picked looks identical whether or not the
   * upload landed, and the one failure worth seeing is the one where it did
   * not.
   */
  const coverPanel = el('div');
  const coverFrame = el('div', 'apply-cover-frame');
  const coverImg = el('img');
  coverImg.alt = 'Your storefront photo';
  coverImg.style.display = 'none';
  const coverEmpty = el('div', 'meta', 'No photo yet');
  coverFrame.append(coverImg, coverEmpty);

  const coverFile = el('input');
  coverFile.type = 'file';
  coverFile.accept = 'image/jpeg,image/png,image/webp';
  coverFile.style.display = 'none';

  const coverStatus = el('div');
  /** True once the server has a photo staged for this applicant. */
  let coverStaged = false;

  const paintCover = (dataUrl) => {
    coverStaged = Boolean(dataUrl);
    if (dataUrl) {
      coverImg.src = dataUrl;
      coverImg.style.display = 'block';
      coverEmpty.style.display = 'none';
    } else {
      coverImg.removeAttribute('src');
      coverImg.style.display = 'none';
      coverEmpty.style.display = 'block';
    }
    coverPick.textContent = dataUrl ? 'Replace photo' : 'Upload a photo';
    coverRemove.style.display = dataUrl ? 'inline-flex' : 'none';
  };

  const coverPick = Button({ label: 'Upload a photo', variant: 'primary', size: 'sm' });
  const coverRemove = Button({ label: 'Remove', size: 'sm' });
  coverRemove.style.display = 'none';

  coverPick.onclick = () => coverFile.click();
  coverFile.onchange = async () => {
    const chosen = coverFile.files?.[0];
    // Cleared first, so choosing the same file again after a cancel or a
    // failure still fires this.
    coverFile.value = '';
    if (!chosen) return;
    coverStatus.innerHTML = '';

    let toUpload = chosen;
    if (canCropImages()) {
      const framed = await cropImage(chosen, { aspect: CARD_ASPECT, title: 'Frame your storefront photo' });
      if (!framed) return;                 // backed out of the resize dialog
      toUpload = framed;
    }

    coverPick.setLoading(true);
    try {
      await api('/api/salons/apply/image', {
        method: 'PUT',
        body: toUpload,
        headers: { 'content-type': toUpload.type },
      });
      // Back from the server, so the preview is proof the upload landed.
      paintCover(await apiImageDataUrl('/api/salons/apply/image'));
      coverStatus.append(el('div', 'out ok', 'Photo uploaded. It is sent with your request.'));
    } catch (err) {
      coverStatus.append(el('div', 'out bad', err.message || 'Could not upload that photo'));
    } finally {
      coverPick.setLoading(false);
    }
  };

  coverRemove.onclick = async () => {
    coverStatus.innerHTML = '';
    coverRemove.setLoading(true);
    try {
      await api('/api/salons/apply/image', { method: 'DELETE' });
      paintCover(null);
    } catch (err) {
      coverStatus.append(el('div', 'out bad', err.message || 'Could not remove that photo'));
    } finally {
      coverRemove.setLoading(false);
    }
  };

  const coverActions = el('div', 'row');
  coverActions.append(coverPick, coverRemove);
  coverPanel.append(coverFrame, coverActions, coverFile, coverStatus);
  coverPanel.append(el('div', 'note',
    'JPEG, PNG or WebP, up to 2 MB. You can move and zoom it inside the card frame before it is '
    + 'saved. A wide shot of the storefront or the chairs works best — it is what a Hasino admin '
    + 'looks at first.'));

  paintCover(null);
  // A photo staged on an earlier visit is still there; show it rather than
  // asking for it twice.
  apiImageDataUrl('/api/salons/apply/image')
    .then((url) => { if (url) paintCover(url); })
    .catch(() => { /* nothing staged, or not reachable — the empty state is right */ });
  const description = Input({ label: 'About your salon', placeholder: 'Two chairs, open since 2019…' });

  const pinNote = el('div', 'note',
    'We find your salon on the map from the address above. If you are at the salon now, '
    + 'this pins it exactly.');
  const locate = Button({
    label: 'Pin my exact location',
    icon: 'pin',
    size: 'sm',
    onClick: async () => {
      locate.disabled = true;
      locate.textContent = 'Locating…';
      try {
        coords = await currentPosition();
        pinNote.textContent = `Pinned to your current position (${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)}).`;
        locate.textContent = 'Pinned';
      } catch (err) {
        coords = null;
        // Not a failure worth blocking on: without a pin the address is
        // geocoded, which is what most applicants will rely on anyway.
        pinNote.textContent = `${err.message} We will locate your salon from the address instead.`;
        locate.disabled = false;
        locate.textContent = 'Pin my exact location';
      }
    },
  });

  // ---- the menu ----
  // Picked from the same catalogue every salon's menu is built from, so an
  // approved salon is immediately bookable instead of being live with nothing
  // to sell. The owner can change any of it later in their dashboard.
  const menu = el('div');
  const chosen = new Map();   // serviceId -> { price, durationMin }
  menu.append(el('div', 'note', 'Loading the service list…'));

  api('/api/services').then(({ services }) => {
    menu.innerHTML = '';
    const list = el('div', 'list');
    for (const svc of services) {
      const row = el('div', 'item');
      const tick = el('input');
      tick.type = 'checkbox';
      const price = el('input');
      price.type = 'number';
      price.min = '0';
      price.placeholder = '₹';
      price.style.maxWidth = '110px';
      price.disabled = true;
      const mins = el('input');
      mins.type = 'number';
      mins.min = '5';
      mins.value = '30';
      mins.style.maxWidth = '90px';
      mins.disabled = true;

      const sync = () => {
        price.disabled = !tick.checked;
        mins.disabled = !tick.checked;
        if (!tick.checked) return chosen.delete(svc.id);
        chosen.set(svc.id, {
          // Rupees in the form, paise on the wire — everything that touches
          // money in this system is an integer number of paise.
          price: Math.round(Number(price.value || 0) * 100),
          durationMin: Number(mins.value || 30),
        });
      };
      tick.onchange = sync;
      price.oninput = sync;
      mins.oninput = sync;

      row.append(tick);
      row.append(el('div', 'grow', svc.name));
      row.append(el('span', 'meta', svc.category));
      row.append(price, el('span', 'meta', 'min'), mins);
      list.append(row);
    }
    menu.append(list);
  }).catch(() => {
    menu.innerHTML = '';
    menu.append(el('div', 'note',
      'Could not load the service list. You can submit without it and set your menu up after approval.'));
  });

  /** A step's body: a heading, a line of context, then its fields. */
  const step = (title, hint, ...nodes) => {
    const box = el('div');
    box.append(el('h2', null, title));
    if (hint) box.append(el('p', 'sub', hint));
    for (const n of nodes) box.append(n);
    return box;
  };

  const infoGrid = el('div', 'grid two');
  infoGrid.append(name, phone);
  const ownerGrid = el('div', 'grid two');
  ownerGrid.append(ownerName, ownerPhone);
  const locGrid = el('div', 'grid two');
  locGrid.append(address, city, area);
  const hoursGrid = el('div', 'grid two');
  hoursGrid.append(openAt, closeAt);

  const reviewBox = el('div');

  const steps = [
    {
      label: 'Salon',
      node: step('About your salon', 'The name customers will see, and how to reach you.',
        infoGrid, description,
        el('h3', null, 'About you'), ownerGrid, ownerEmail),
      // The server rejects a blank name with BAD_NAME, and a malformed number
      // with BAD_PHONE. Catching both here means the applicant is told on the
      // step that asked, not after five more.
      validate: () =>
        !name.input.value.trim() ? 'Your salon needs a name.'
          : ownerPhone.input.value.trim() && !/^\+[1-9]\d{7,14}$/.test(ownerPhone.input.value.trim())
            ? 'Your phone number needs the country code, like +919876543210.'
            : null,
    },
    {
      label: 'Location',
      node: step('Where you are', 'Customers search by city and area, so this is how they find you.',
        locGrid, locate, pinNote),
      validate: () =>
        !address.input.value.trim() ? 'An address is required.'
          : !city.input.value.trim() ? 'A city is required.'
            : null,
    },
    {
      label: 'Services',
      node: step('Your services',
        'Tick what you offer and set your prices in rupees. You can change these any time once your salon is live.',
        menu),
    },
    {
      label: 'Timings',
      node: step('Opening hours',
        'Applied to all seven days for now — you can set different hours per day in your dashboard once approved.',
        hoursGrid),
    },
    {
      label: 'Photos',
      node: step('Photos and description',
        'A Hasino admin reads this to decide whether to approve you, so a real storefront photo '
        + 'makes the difference.',
        coverPanel, photos),
    },
    {
      label: 'Review',
      node: step('Review & submit', 'Check this over. Nothing is sent until you submit.', reviewBox),
    },
  ];

  const stepper = Stepper(steps.map((s) => s.label), 0);
  panel.append(stepper);

  const host = el('div');
  panel.append(host);

  const out = el('div');
  const nav = el('div', 'row');
  nav.style.cssText = 'margin-top:var(--space-6); justify-content:space-between';

  let index = 0;

  const back = Button({ label: '← Back', onClick: () => go(index - 1) });
  const next = Button({ label: 'Continue →', variant: 'primary', onClick: () => {
    const problem = steps[index].validate?.();
    if (problem) {
      out.innerHTML = '';
      out.append(el('div', 'out bad', problem));
      return;
    }
    go(index + 1);
  } });

  const submit = Button({
    label: 'Submit application',
    variant: 'primary',
    onClick: async () => {
      out.innerHTML = '';
      submit.setLoading(true);
      try {
        await api('/api/salons/apply', {
          method: 'POST',
          body: JSON.stringify({
            name: name.input.value.trim(),
            address: address.input.value.trim(),
            city: city.input.value.trim(),
            area: area.input.value.trim() || null,
            // Omitted when there is no pin — the server geocodes the address.
            ...(coords ? { lat: coords.lat, lng: coords.lng } : {}),
            phone: phone.input.value.trim() || null,
            // The applicant's own contact details. No email: the server takes
            // that from the verified session and ignores anything sent here.
            ownerName: ownerName.input.value.trim() || null,
            ownerPhone: ownerPhone.input.value.trim() || null,
            openAt: openAt.input.value || null,
            closeAt: closeAt.input.value || null,
            description: description.input.value.trim() || null,
            // No coverUrl: the storefront photo was uploaded before this was
            // submitted and applyForSalon claims it onto the salon it creates.
            photoUrls: photos.input.value.split('\n').map((u) => u.trim()).filter(Boolean),
            services: [...chosen.entries()].map(([serviceId, v]) => ({ serviceId, ...v })),
          }),
        });
        await app.refreshSession().catch(() => {});
        container.innerHTML = '';
        container.append(submittedPanel());
      } catch (err) {
        const message =
          err instanceof ApiError && err.code === 'ALREADY_OWNS_SALON'
            ? 'You already have a salon on Hasino.'
            : err.message;
        out.append(el('div', 'out bad', message));
        submit.setLoading(false);
      }
    },
  });

  nav.append(back, next, submit);
  panel.append(out, nav);

  /** What the applicant is about to send, in the words they typed. */
  function drawReview() {
    reviewBox.innerHTML = '';
    const fact = (label, value) => {
      const row = el('div', 'review-fact');
      row.append(el('div', 'review-label', label));
      row.append(el('div', 'review-value', value || '—'));
      return row;
    };
    reviewBox.append(fact('Salon', name.input.value.trim()));
    // Who the admin will be replying to, so it is checkable before sending.
    reviewBox.append(fact('You', [ownerName.input.value.trim(), session?.email, ownerPhone.input.value.trim()]
      .filter(Boolean).join(' · ')));
    reviewBox.append(fact('Where', [address.input.value.trim(), area.input.value.trim(), city.input.value.trim()]
      .filter(Boolean).join(', ')));
    reviewBox.append(fact('Hours', `${openAt.input.value || '—'} to ${closeAt.input.value || '—'}, every day`));
    reviewBox.append(fact('Services', chosen.size ? `${chosen.size} selected` : 'none yet — you can add them after approval'));
    reviewBox.append(fact('Photos', [coverStaged ? 'storefront photo uploaded' : null,
      photos.input.value.split('\n').filter((u) => u.trim()).length
        ? `${photos.input.value.split('\n').filter((u) => u.trim()).length} more linked`
        : null].filter(Boolean).join(', ') || 'none'));
    reviewBox.append(
      el('div', 'note',
        'A Hasino admin reviews every request — usually a couple of days. Nothing is visible to '
        + 'customers until it is approved, and your account stays an ordinary customer account '
        + 'until then: submitting this grants no salon access by itself.'),
    );
  }

  function go(to) {
    index = Math.max(0, Math.min(steps.length - 1, to));
    const last = index === steps.length - 1;
    if (last) drawReview();

    stepper.update(index);
    host.replaceChildren(steps[index].node);
    out.innerHTML = '';

    back.style.display = index === 0 ? 'none' : '';
    next.style.display = last ? 'none' : '';
    submit.style.display = last ? '' : 'none';

    // The step's heading, not the top of the document: the applicant is
    // partway down a form and the next question is what they want in view.
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  go(0);
  container.append(panel);
}

/** The "we have it, here is what happens next" screen. */
function submittedPanel() {
  const done = el('div', 'panel');
  const doneIcon = el('div', 'empty-icon');
  doneIcon.append(iconEl('check', { size: 24 }));
  done.append(doneIcon);
  done.append(el('h1', null, 'Application received'));
  done.append(el('p', 'sub',
    'A Hasino admin will review it. Nothing is visible to customers until it is approved — '
    + 'once it is, your salon dashboard unlocks and you can set up services and timings. '
    + 'We will email you at the address you signed in with.'));

  // What happens next, as steps rather than a paragraph: an applicant who has
  // just finished six of them should be told where they are in the process,
  // not left with "we will be in touch".
  const nextUp = el('ol', 'next-steps');
  for (const [title, detail] of [
    ['Under review', 'A Hasino admin reads your application. Usually a couple of days.'],
    ['You hear from us', 'We email you at the address you signed in with, either way.'],
    ['Your dashboard unlocks', 'Set your menu, hours and photos, and start taking bookings.'],
  ]) {
    const li = el('li');
    li.append(el('div', 'next-title', title));
    li.append(el('div', 'meta', detail));
    nextUp.append(li);
  }
  done.append(nextUp);

  const go = el('a', 'btn primary', 'Back to Hasino');
  go.href = '#/home';
  done.append(go);
  return done;
}
