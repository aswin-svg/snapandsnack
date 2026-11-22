(() => {
  const backupKey = editorId => 'snapandsnacks:editor:' + editorId;

  function readBackup(key) {
    try {
      return JSON.parse(localStorage.getItem(key));
    } catch {
      return null;
    }
  }

  const saved = document.querySelector('[data-editor-saved]');
  if (saved?.dataset.revision) {
    const key = backupKey(saved.dataset.editorSaved);
    if (readBackup(key)?.revision === saved.dataset.revision) {
      try { localStorage.removeItem(key); } catch {}
    }
  }

  const form = document.getElementById('post-form');
  if (!form) return;

  const key = backupKey(form.dataset.editorId);
  const names = ['title', 'category', 'tags', 'metaTitle', 'metaDescription', 'content'];
  const fields = () => Object.fromEntries(names.map(name => [name, form.elements.namedItem(name).value]));
  const initial = JSON.stringify(fields());
  const status = document.getElementById('editor-save-status');
  const recovery = document.getElementById('editor-recovery');
  const featured = document.getElementById('featured-image');
  const image = document.getElementById('editor-share-image');
  const originalImage = image.getAttribute('src');
  const featureStatus = document.getElementById('featured-image-status');
  const revisionField = form.elements.namedItem('backupRevision');
  const localTime = timestamp => new Date(timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const stored = readBackup(key);
  let pending = stored?.fields && typeof stored.revision === 'string' && Number.isFinite(stored.timestamp) ? stored : null;
  let lastBackup = '';
  let timer;

  function updateShareText() {
    const values = fields();
    document.getElementById('editor-share-title').textContent = values.metaTitle.trim() || values.title.trim() || 'Post title';
    document.getElementById('editor-share-description').textContent = values.metaDescription.trim() ||
      values.content.trim().slice(0, 150).replace(/\n/g, ' ');
  }

  function saveBackup() {
    clearTimeout(timer);
    if (pending) return;
    const values = fields();
    const hasFiles = featured.files.length > 0 || document.querySelector('#inline-img-inputs input[type="file"]') !== null;
    if (!hasFiles && JSON.stringify(values) === initial && !lastBackup) return;
    const snapshot = JSON.stringify({ fields: values, hasFiles });
    if (snapshot === lastBackup) return;
    const timestamp = Date.now();
    const revision = globalThis.crypto?.randomUUID?.() || timestamp + '-' + Math.random().toString(36).slice(2);
    try {
      localStorage.setItem(key, JSON.stringify({ fields: values, hasFiles, timestamp, revision }));
      lastBackup = snapshot;
      revisionField.value = revision;
      status.textContent = 'Text backed up in this browser at ' + localTime(timestamp) + '. Save to update the site.';
    } catch {
      status.textContent = 'Browser backup unavailable. Use Save as draft to keep your changes.';
    }
  }

  function scheduleBackup() {
    if (pending) return;
    clearTimeout(timer);
    status.textContent = 'Backing up text in this browser…';
    timer = setTimeout(saveBackup, 400);
  }

  if (pending && JSON.stringify(pending.fields) === initial && !pending.hasFiles) {
    try { localStorage.removeItem(key); } catch {}
    pending = null;
  }
  if (pending) {
    document.getElementById('editor-recovery-message').textContent =
      'This browser has unsaved text from ' + localTime(pending.timestamp) + '. Restore it or discard the backup to start editing.';
    recovery.hidden = false;
    status.textContent = 'Choose what to do with the browser backup.';
  }
  document.getElementById('editor-restore').addEventListener('click', () => {
    if (!pending) return;
    const backup = pending;
    for (const name of names) {
      if (typeof backup.fields[name] !== 'string') continue;
      form.elements.namedItem(name).value = name === 'content' && backup.hasFiles
        ? backup.fields[name].replace(/\[image:\s*inline_image_\d+\]/g, '')
        : backup.fields[name];
    }
    revisionField.value = backup.revision;
    pending = null;
    recovery.hidden = true;
    updateShareText();
    saveBackup();
    if (backup.hasFiles) {
      status.textContent = 'Text restored. Reattach any photos that were selected before you left.';
    }
    form.elements.namedItem('title').focus();
  });
  document.getElementById('editor-discard').addEventListener('click', () => {
    if (readBackup(key)?.revision === pending?.revision) {
      try { localStorage.removeItem(key); } catch {}
    }
    pending = null;
    recovery.hidden = true;
    status.textContent = 'Browser backup discarded.';
    saveBackup();
    form.elements.namedItem('title').focus();
  });

  featured.addEventListener('change', () => {
    const file = featured.files[0];
    image.src = originalImage;
    featureStatus.textContent = '';
    if (!file) return;
    featureStatus.textContent = file.name + ' will be uploaded when you save.';
    const reader = new FileReader();
    reader.addEventListener('load', () => {
      if (featured.files[0] === file) image.src = reader.result;
    });
    reader.readAsDataURL(file);
  });
  form.addEventListener('input', () => {
    updateShareText();
    scheduleBackup();
  });
  form.addEventListener('change', scheduleBackup);
  form.addEventListener('submit', event => {
    if (pending) {
      event.preventDefault();
      document.getElementById('editor-restore').focus();
      return;
    }
    saveBackup();
  });
  window.addEventListener('pagehide', saveBackup);
  updateShareText();
})();
