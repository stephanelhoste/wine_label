/* Cellar Ledger — frontend state machine
 *
 * Three screens: upload → validate → result
 * All state lives in module-level variables; nothing written to localStorage.
 */

'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
let selectedFile = null;
let currentSessionId = null;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const screens = {
  upload:   document.getElementById('screen-upload'),
  validate: document.getElementById('screen-validate'),
  result:   document.getElementById('screen-result'),
};

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

const validateForm  = document.getElementById('validate-form');
const btnDiscard    = document.getElementById('btn-discard');
const validateError = document.getElementById('validate-error');

const loadingOverlay = document.getElementById('overlay-loading');
const loadingMsg     = document.getElementById('loading-msg');

// Result fields
const rTitle       = document.getElementById('r-title');
const rAppellation = document.getElementById('r-appellation');
const rCountry     = document.getElementById('r-country');
const rRating      = document.getElementById('r-rating');
const rPrice       = document.getElementById('r-price');
const rTasting     = document.getElementById('r-tasting-notes');
const rAromas      = document.getElementById('r-aromas');
const btnNewScan   = document.getElementById('btn-new-scan');

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

// Click on drop zone
dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
});

fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) applyFile(fileInput.files[0]);
});

btnChangePhoto.addEventListener('click', (e) => {
  e.stopPropagation();
  resetUpload();
});

// Drag and drop
dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) applyFile(file);
});

btnScan.addEventListener('click', () => handleScan());

async function handleScan() {
  if (!selectedFile) return;

  showLoading('Reading label…');
  hideError(uploadError);

  const formData = new FormData();
  formData.append('file', selectedFile);

  try {
    const res = await fetch('/api/scan', { method: 'POST', body: formData });
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.detail || 'Scan failed. Please try again.');
    }

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
  validateForm['producer'].value   = extracted.producer   || '';
  validateForm['vintage'].value    = extracted.vintage    || '';
  validateForm['variety'].value    = extracted.variety    || '';
  validateForm['appellation'].value = extracted.appellation || '';
  validateForm['country'].value    = extracted.country    || '';
}

btnDiscard.addEventListener('click', () => {
  currentSessionId = null;
  resetUpload();
  showScreen('upload');
});

validateForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!currentSessionId) {
    showError(validateError, 'Session expired. Please start a new scan.');
    return;
  }

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

    if (!res.ok) {
      throw new Error(data.detail || 'Research step failed. Please try again.');
    }

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
  const vintage  = data.vintage  ? ` ${data.vintage}` : '';
  const variety  = data.variety  ? ` · ${data.variety}` : '';

  rTitle.textContent       = `${producer}${vintage}${variety}`;
  rAppellation.textContent = data.appellation || '';
  rCountry.textContent     = data.country     || '';
  rRating.textContent      = data.rating      || '—';
  rPrice.textContent       = data.price       || '—';
  rTasting.textContent     = data.tasting_notes || '';

  rAromas.innerHTML = '';
  const aromas = (data.aromas || '').split(',').map(a => a.trim()).filter(Boolean);
  aromas.forEach(aroma => {
    const tag = document.createElement('span');
    tag.className = 'aroma-tag';
    tag.textContent = aroma;
    rAromas.appendChild(tag);
  });
}

btnNewScan.addEventListener('click', () => {
  resetUpload();
  showScreen('upload');
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function showLoading(msg) {
  loadingMsg.textContent = msg;
  loadingOverlay.classList.remove('hidden');
}

function hideLoading() {
  loadingOverlay.classList.add('hidden');
}

function showError(el, msg) {
  el.textContent = msg;
  el.classList.remove('hidden');
}

function hideError(el) {
  el.textContent = '';
  el.classList.add('hidden');
}
