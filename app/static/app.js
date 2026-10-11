/* Cellar Ledger — frontend state machine
 *
 * Screens: home → upload → validate → result
 *                home → cellar (+ edit modal)
 * All state lives in module-level variables; nothing written to localStorage.
 */

'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
let selectedFile = null;
let currentSessionId = null;
let editingWine = null;   // { row, drunk, my_rating }
let currentStarRating = 0;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const screens = {
  home:     document.getElementById('screen-home'),
  upload:   document.getElementById('screen-upload'),
  validate: document.getElementById('screen-validate'),
  result:   document.getElementById('screen-result'),
  cellar:   document.getElementById('screen-cellar'),
};

// Home
document.getElementById('btn-go-scan').addEventListener('click', () => showScreen('upload'));
document.getElementById('btn-go-cellar').addEventListener('click', () => loadCellar());

// Upload
const dropZone       = document.getElementById('drop-zone');
const fileInput      = document.getElementById('file-input');
const dropIdle       = document.getElementById('drop-idle');
const dropPreview    = document.getElementById('drop-preview');
const previewImg     = document.getElementById('preview-img');
const previewName    = document.getElementById('preview-name');
const previewSize    = document.getElementById('preview-size');
const btnChangePhoto = document.getElementById('btn-change-photo');
const btnScan        = document.getElementById('btn-scan');
const uploadError    = document.getElementById('upload-error');
document.getElementById('btn-upload-back').addEventListener('click', () => { resetUpload(); showScreen('home'); });

// Validate
const validateForm  = document.getElementById('validate-form');
const validateError = document.getElementById('validate-error');
document.getElementById('btn-discard').addEventListener('click', () => { currentSessionId = null; resetUpload(); showScreen('upload'); });

// Result
document.getElementById('btn-new-scan').addEventListener('click', () => { resetUpload(); showScreen('upload'); });
document.getElementById('btn-go-cellar-from-result').addEventListener('click', () => loadCellar());

// Cellar
const cellarList  = document.getElementById('cellar-list');
const cellarEmpty = document.getElementById('cellar-empty');
const cellarCount = document.getElementById('cellar-count');
const cellarError = document.getElementById('cellar-error');
document.getElementById('btn-cellar-back').addEventListener('click', () => showScreen('home'));
document.getElementById('btn-cellar-scan').addEventListener('click', () => { resetUpload(); showScreen('upload'); });

// Loading
const loadingOverlay = document.getElementById('overlay-loading');
const loadingMsg     = document.getElementById('loading-msg');

// Modal
const modalEdit     = document.getElementById('modal-edit');
const modalTitle    = document.getElementById('modal-title');
const modalWineName = document.getElementById('modal-wine-name');
const modalError    = document.getElementById('modal-error');
const starRow       = document.getElementById('star-row');
const starLabel     = document.getElementById('star-label');
const starBtns      = Array.from(starRow.querySelectorAll('.star'));
const toggleNo      = document.getElementById('toggle-no');
const toggleYes     = document.getElementById('toggle-yes');
document.getElementById('btn-modal-close').addEventListener('click',  closeModal);
document.getElementById('btn-modal-cancel').addEventListener('click', closeModal);
document.getElementById('btn-modal-save').addEventListener('click',   saveModal);

// ── Screen navigation ─────────────────────────────────────────────────────────
function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.remove('active'));
  screens[name].classList.add('active');
  window.scrollTo(0, 0);
}

// ── Upload screen ─────────────────────────────────────────────────────────────
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function applyFile(file) {
  if (!file) return;
  if (!['image/jpeg', 'image/jpg', 'image/png'].includes(file.type)) {
    showError(uploadError, 'Please select a JPG or PNG image.');
    return;
  }
  selectedFile = file;
  hideError(uploadError);
  const reader = new FileReader();
  reader.onload = (e) => {
    previewImg.src = e.target.result;
    previewName.textContent = file.name;
    previewSize.textContent = formatBytes(file.size);
    dropIdle.classList.add('hidden');
    dropPreview.classList.remove('hidden');
    btnScan.disabled = false;
  };
  reader.readAsDataURL(file);
}

function resetUpload() {
  selectedFile = null;
  currentSessionId = null;
  fileInput.value = '';
  previewImg.src = '';
  dropIdle.classList.remove('hidden');
  dropPreview.classList.add('hidden');
  btnScan.disabled = true;
  hideError(uploadError);
}

dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
fileInput.addEventListener('change', () => { if (fileInput.files[0]) applyFile(fileInput.files[0]); });
btnChangePhoto.addEventListener('click', (e) => { e.stopPropagation(); resetUpload(); });
dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', (e) => { e.preventDefault(); dropZone.classList.remove('drag-over'); if (e.dataTransfer.files[0]) applyFile(e.dataTransfer.files[0]); });

btnScan.addEventListener('click', handleScan);

async function handleScan() {
  if (!selectedFile) return;
  showLoading('Reading label…');
  hideError(uploadError);
  const formData = new FormData();
  formData.append('file', selectedFile);
  try {
    const res = await fetch('/api/scan', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Scan failed.');
    currentSessionId = data.session_id;
    populateValidateForm(data.extracted);
    hideLoading();
    showScreen('validate');
  } catch (err) {
    hideLoading();
    showError(uploadError, err.message || 'Unexpected error during scan.');
  }
}

// ── Validate screen ───────────────────────────────────────────────────────────
function populateValidateForm(extracted) {
  validateForm['producer'].value    = extracted.producer    || '';
  validateForm['vintage'].value     = extracted.vintage     || '';
  validateForm['variety'].value     = extracted.variety     || '';
  validateForm['appellation'].value = extracted.appellation || '';
  validateForm['country'].value     = extracted.country     || '';
}

validateForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!currentSessionId) { showError(validateError, 'Session expired. Please start a new scan.'); return; }
  const fields = {
    producer:    validateForm['producer'].value.trim(),
    vintage:     validateForm['vintage'].value.trim(),
    variety:     validateForm['variety'].value.trim(),
    appellation: validateForm['appellation'].value.trim(),
    country:     validateForm['country'].value.trim(),
  };
  showLoading('Researching wine details…');
  hideError(validateError);
  try {
    const res = await fetch(`/api/confirm/${currentSessionId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fields),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Research step failed.');
    populateResult(data);
    hideLoading();
    showScreen('result');
  } catch (err) {
    hideLoading();
    showError(validateError, err.message || 'Unexpected error during research.');
  }
});

// ── Result screen ─────────────────────────────────────────────────────────────
function populateResult(data) {
  const producer = data.producer || 'Unknown producer';
  const vintage  = data.vintage  ? ` ${data.vintage}`  : '';
  const variety  = data.variety  ? ` · ${data.variety}` : '';
  document.getElementById('r-title').textContent       = `${producer}${vintage}${variety}`;
  document.getElementById('r-appellation').textContent = data.appellation || '';
  document.getElementById('r-country').textContent     = data.country     || '';
  document.getElementById('r-rating').textContent      = data.rating      || '—';
  document.getElementById('r-price').textContent       = data.price       || '—';
  document.getElementById('r-tasting-notes').textContent = data.tasting_notes || '';
  const aromasEl = document.getElementById('r-aromas');
  aromasEl.innerHTML = '';
  (data.aromas || '').split(',').map(a => a.trim()).filter(Boolean).forEach(aroma => {
    const tag = document.createElement('span');
    tag.className = 'aroma-tag';
    tag.textContent = aroma;
    aromasEl.appendChild(tag);
  });
}

// ── Cellar screen ─────────────────────────────────────────────────────────────
async function loadCellar() {
  showScreen('cellar');
  cellarList.innerHTML = '';
  cellarEmpty.classList.add('hidden');
  hideError(cellarError);
  showLoading('Loading your cellar…');

  try {
    const res = await fetch('/api/cellar');
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Failed to load cellar.');
    hideLoading();
    renderCellar(data.wines);
  } catch (err) {
    hideLoading();
    showError(cellarError, err.message || 'Could not load cellar.');
  }
}

function renderCellar(wines) {
  cellarList.innerHTML = '';
  if (!wines || wines.length === 0) {
    cellarEmpty.classList.remove('hidden');
    cellarCount.textContent = '';
    return;
  }
  cellarEmpty.classList.add('hidden');
  cellarCount.textContent = `${wines.length} bottle${wines.length === 1 ? '' : 's'}`;

  wines.forEach(wine => {
    const card = document.createElement('div');
    card.className = 'wine-card' + (wine.drunk === 'Yes' ? ' wine-card--drunk' : '');
    card.dataset.row = wine.row;

    const aromaHtml = (wine.aromas || '').split(',').map(a => a.trim()).filter(Boolean)
      .map(a => `<span class="aroma-tag aroma-tag--sm">${a}</span>`).join('');

    const myRatingHtml = wine.my_rating
      ? `<span class="my-rating-stars">${'★'.repeat(Number(wine.my_rating))}${'☆'.repeat(5 - Number(wine.my_rating))}</span>`
      : `<span class="my-rating-empty">Not rated</span>`;

    card.innerHTML = `
      <div class="wine-card-top">
        <div class="wine-card-info">
          <div class="wine-card-title">${wine.producer || '—'}${wine.vintage ? ' · ' + wine.vintage : ''}</div>
          <div class="wine-card-meta">${[wine.variety, wine.appellation, wine.country].filter(Boolean).join(' · ')}</div>
        </div>
        <div class="wine-card-badges">
          ${wine.drunk === 'Yes' ? '<span class="badge badge--drunk">Drunk</span>' : ''}
          ${wine.rating ? `<span class="badge badge--rating">${wine.rating}</span>` : ''}
        </div>
      </div>
      ${wine.tasting_notes ? `<p class="wine-card-notes">${wine.tasting_notes}</p>` : ''}
      ${aromaHtml ? `<div class="wine-card-aromas">${aromaHtml}</div>` : ''}
      <div class="wine-card-footer">
        <div class="wine-card-personal">
          <span class="personal-label">My rating:</span>
          ${myRatingHtml}
        </div>
        ${wine.price ? `<span class="wine-card-price">${wine.price}</span>` : ''}
        <button class="btn-edit" data-row="${wine.row}">Edit</button>
      </div>
    `;

    card.querySelector('.btn-edit').addEventListener('click', () => openModal(wine));
    cellarList.appendChild(card);
  });
}

// ── Edit Modal ────────────────────────────────────────────────────────────────
function openModal(wine) {
  editingWine = { ...wine };
  modalWineName.textContent = `${wine.producer || '—'}${wine.vintage ? ' ' + wine.vintage : ''}`;

  // Drunk toggle
  const isDrunk = wine.drunk === 'Yes';
  toggleNo.classList.toggle('active', !isDrunk);
  toggleYes.classList.toggle('active', isDrunk);

  // Stars
  currentStarRating = parseInt(wine.my_rating) || 0;
  renderStars(currentStarRating);

  hideError(modalError);
  modalEdit.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeModal() {
  modalEdit.classList.add('hidden');
  document.body.style.overflow = '';
  editingWine = null;
}

// Close on backdrop click
modalEdit.addEventListener('click', (e) => { if (e.target === modalEdit) closeModal(); });

// Drunk toggle
toggleNo.addEventListener('click',  () => { toggleNo.classList.add('active');  toggleYes.classList.remove('active'); editingWine.drunk = 'No';  });
toggleYes.addEventListener('click', () => { toggleYes.classList.add('active'); toggleNo.classList.remove('active');  editingWine.drunk = 'Yes'; });

// Stars
starBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    const val = parseInt(btn.dataset.value);
    // Click same star again to clear
    currentStarRating = currentStarRating === val ? 0 : val;
    renderStars(currentStarRating);
  });
  btn.addEventListener('mouseenter', () => renderStars(parseInt(btn.dataset.value), true));
  btn.addEventListener('mouseleave', () => renderStars(currentStarRating));
});

function renderStars(count, hover = false) {
  starBtns.forEach((btn, i) => {
    btn.classList.toggle('filled', i < count);
    btn.classList.toggle('hover', hover && i < count);
  });
  const labels = ['', 'Poor', 'Fair', 'Good', 'Very good', 'Outstanding'];
  starLabel.textContent = count > 0 ? labels[count] : 'Not rated';
}

async function saveModal() {
  if (!editingWine) return;
  hideError(modalError);

  const drunk = toggleYes.classList.contains('active') ? 'Yes' : 'No';
  const my_rating = currentStarRating > 0 ? String(currentStarRating) : '';

  try {
    const res = await fetch(`/api/cellar/${editingWine.row}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ drunk, my_rating }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Failed to save.');

    // Update the card in-place
    const card = cellarList.querySelector(`[data-row="${editingWine.row}"]`);
    if (card) {
      card.classList.toggle('wine-card--drunk', drunk === 'Yes');
      const badgesEl = card.querySelector('.wine-card-badges');
      const existingDrunk = badgesEl.querySelector('.badge--drunk');
      if (drunk === 'Yes' && !existingDrunk) {
        badgesEl.insertAdjacentHTML('afterbegin', '<span class="badge badge--drunk">Drunk</span>');
      } else if (drunk === 'No' && existingDrunk) {
        existingDrunk.remove();
      }
      const personalEl = card.querySelector('.wine-card-personal');
      const myRatingHtml = my_rating
        ? `<span class="my-rating-stars">${'★'.repeat(Number(my_rating))}${'☆'.repeat(5 - Number(my_rating))}</span>`
        : `<span class="my-rating-empty">Not rated</span>`;
      personalEl.innerHTML = `<span class="personal-label">My rating:</span> ${myRatingHtml}`;
    }
    closeModal();
  } catch (err) {
    showError(modalError, err.message || 'Could not save changes.');
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function showLoading(msg) { loadingMsg.textContent = msg; loadingOverlay.classList.remove('hidden'); }
function hideLoading()    { loadingOverlay.classList.add('hidden'); }
function showError(el, msg) { el.textContent = msg; el.classList.remove('hidden'); }
function hideError(el)      { el.textContent = ''; el.classList.add('hidden'); }
