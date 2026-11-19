// Lapisan tambahan: ganti nama kontak, ejaan nama pengirim di grup, dan hapus chat massal.
// Tidak menyentuh bundle React aplikasi — hapus tag <script> di index.html untuk mematikan fitur ini.
(() => {
  const API = '/api';
  let reloadPending = false;
  let isAdmin = false;

  const style = document.createElement('style');
  style.textContent = `
.ndn-chip{position:fixed;right:18px;bottom:18px;z-index:2147482;display:flex;align-items:center;gap:8px;
  padding:11px 16px;border:1px solid rgba(255,255,255,.35);border-radius:999px;background:#dc2626;color:#fff;
  font:700 13px/1 "Plus Jakarta Sans",system-ui,sans-serif;letter-spacing:.01em;
  box-shadow:0 12px 28px rgba(15,23,42,.45);cursor:pointer}
.ndn-chip:hover{background:#b91c1c}
.ndn-chip::before{content:\"\";width:14px;height:14px;flex:none;background:currentColor;
  -webkit-mask:url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23000' stroke-width='2' stroke-linecap='round'%3E%3Cpath d='M4 20h4l10-10-4-4L4 16v4z'/%3E%3Cpath d='M14 6l4 4'/%3E%3C/svg%3E\") center/contain no-repeat;
  mask:url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23000' stroke-width='2' stroke-linecap='round'%3E%3Cpath d='M4 20h4l10-10-4-4L4 16v4z'/%3E%3Cpath d='M14 6l4 4'/%3E%3C/svg%3E\") center/contain no-repeat}
@media (max-width:767px){.ndn-chip{bottom:92px;right:14px}}
.ndn-dlg{width:min(780px,94vw);max-height:84vh;border:0;border-radius:16px;padding:0;
  font:400 14px/1.45 "Plus Jakarta Sans",system-ui,sans-serif;color:#0f172a;box-shadow:0 24px 60px rgba(15,23,42,.32)}
.ndn-dlg::backdrop{background:rgba(15,23,42,.45)}
.ndn-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:16px 18px 10px}
.ndn-head h3{margin:0;font-size:16px;font-weight:700}
.ndn-head p{margin:2px 0 0;font-size:12px;color:#64748b}
.ndn-tools{display:flex;gap:8px;padding:0 18px 12px;align-items:center}
.ndn-tools input[type=search]{flex:1;padding:9px 11px;border:1px solid #cbd5e1;border-radius:10px;font:inherit}
.ndn-tools label{display:flex;align-items:center;gap:5px;font-size:12px;color:#475569;white-space:nowrap}
.ndn-list{margin:0;padding:0 18px 8px;max-height:48vh;overflow:auto;list-style:none}
.ndn-row{display:flex;align-items:center;gap:9px;padding:9px 0;border-bottom:1px solid #e2e8f0}
.ndn-row input[type=checkbox]{width:16px;height:16px;flex:none;accent-color:#dc2626}
.ndn-meta{flex:1;min-width:0}
.ndn-meta b{display:block;font-size:11px;font-weight:500;color:#64748b;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ndn-row>input[type=text],.ndn-senders input{width:210px;flex:none;padding:8px 10px;border:1px solid #cbd5e1;border-radius:9px;font:inherit}
.ndn-tag{flex:none;font-size:10px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:#475569;background:#f1f5f9;padding:3px 7px;border-radius:999px}
.ndn-sendersBtn{flex:none;padding:8px 10px;border:1px solid #cbd5e1;border-radius:9px;background:#fff;color:#334155;font:600 11px/1 inherit;cursor:pointer}
.ndn-sendersBtn:hover{border-color:#94a3b8}
.ndn-sendersBtn:disabled{opacity:.45;cursor:default}
.ndn-senders{flex:1 0 100%;display:grid;gap:6px;padding:8px 0 4px 25px}
.ndn-sender{display:flex;align-items:center;gap:9px}
.ndn-sender span{flex:1;min-width:0;font-size:11px;color:#64748b;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ndn-senders button{justify-self:start;padding:7px 12px;border:0;border-radius:9px;background:#0f172a;color:#fff;font:600 11px/1 inherit;cursor:pointer}
.ndn-row button.ok,.ndn-senders button.ok{background:#16a34a}
.ndn-foot{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:10px 18px 16px;font-size:12px;color:#64748b;flex-wrap:wrap}
.ndn-foot .ndn-actions{display:flex;gap:8px;align-items:center}
.ndn-foot button{padding:8px 13px;border:1px solid #cbd5e1;border-radius:9px;background:#fff;color:inherit;font:600 12px/1 inherit;cursor:pointer}
.ndn-foot button.danger{border-color:#dc2626;background:#dc2626;color:#fff}
.ndn-foot button.danger.armed{background:#7f1d1d;border-color:#7f1d1d}
.ndn-foot button:disabled{opacity:.45;cursor:default}
.ndn-empty{padding:22px 0;color:#64748b;font-size:13px}
.ndn-row.saved>input[type=text]{border-color:#16a34a}
`;
  document.head.appendChild(style);

  const request = async (path, options = {}) => {
    const res = await fetch(API + path, {
      headers: { 'content-type': 'application/json' },
      ...options,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  };

  const dialog = document.createElement('dialog');
  dialog.className = 'ndn-dlg';
  dialog.innerHTML = `
    <div class="ndn-head">
      <div>
        <h3>Nama &amp; seleksi chat</h3>
        <p>Ganti nama kontak, eja ulang nama pengirim di grup, atau hapus beberapa chat sekaligus.</p>
      </div>
    </div>
    <div class="ndn-tools">
      <input type="search" data-search placeholder="Cari nama, nomor, atau isi pesan…" autocomplete="off">
      <label><input type="checkbox" data-all> Pilih semua</label>
    </div>
    <ul class="ndn-list" data-list></ul>
    <div class="ndn-foot">
      <span data-status></span>
      <div class="ndn-actions">
        <label data-remoteWrap hidden><input type="checkbox" data-remote> dari WhatsApp juga</label>
        <button data-del class="danger" hidden>Hapus terpilih</button>
        <button data-close>Tutup</button>
      </div>
    </div>`;
  document.body.appendChild(dialog);

  const list = dialog.querySelector('[data-list]');
  const statusEl = dialog.querySelector('[data-status]');
  const searchEl = dialog.querySelector('[data-search]');
  const allEl = dialog.querySelector('[data-all]');
  const delEl = dialog.querySelector('[data-del]');
  const remoteEl = dialog.querySelector('[data-remote]');
  const remoteWrap = dialog.querySelector('[data-remoteWrap]');

  const selected = new Set();
  let chats = [];
  const rowOf = new Map();

  const fmt = (ms) =>
    ms ? new Date(ms).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: '2-digit' }) : 'tanpa pesan';

  const setStatus = (text) => {
    statusEl.textContent = text;
  };

  const updateDelete = () => {
    delEl.textContent = selected.size ? `Hapus terpilih (${selected.size})` : 'Hapus terpilih';
    delEl.disabled = !selected.size;
    delEl.classList.remove('armed');
    allEl.checked = chats.length > 0 && chats.every((c) => selected.has(c.id));
  };

  const buildRow = (chat) => {
    const row = document.createElement('li');
    row.className = 'ndn-row';

    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = selected.has(chat.id);
    check.addEventListener('change', () => {
      if (check.checked) selected.add(chat.id);
      else selected.delete(chat.id);
      updateDelete();
    });

    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 60;
    input.value = chat.name || '';
    input.placeholder = 'Nama kontak';

    const meta = document.createElement('div');
    meta.className = 'ndn-meta';
    const line = document.createElement('b');
    line.textContent = `${chat.waJid.endsWith('@lid') ? 'LID · ' : ''}${fmt(chat.lastMessageAt)}`;
    meta.append(line);

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'ndn-sendersBtn';
    saveBtn.textContent = 'Simpan';
    saveBtn.disabled = true;

    const commit = async () => {
      const name = input.value.trim();
      if (!name) return;
      saveBtn.disabled = true;
      saveBtn.textContent = '…';
      try {
        const data = await request(`/chats/${encodeURIComponent(chat.id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ name }),
        });
        chat.name = data.chat.name;
        row.classList.add('saved');
        saveBtn.textContent = 'Tersimpan';
        saveBtn.classList.add('ok');
        setStatus(`"${name}" tersimpan.`);
      } catch (err) {
        saveBtn.textContent = 'Gagal';
        setStatus(err.message);
        setTimeout(() => {
          saveBtn.textContent = 'Simpan';
          saveBtn.disabled = false;
        }, 1800);
      }
    };
    saveBtn.addEventListener('click', commit);
    input.addEventListener('input', () => {
      row.classList.remove('saved');
      saveBtn.disabled = !input.value.trim() || input.value.trim() === (chat.name || '');
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
      }
    });

    row.append(check, input, meta, saveBtn);

    if (chat.isGroup) {
      const tag = document.createElement('span');
      tag.className = 'ndn-tag';
      tag.textContent = 'grup';
      row.appendChild(tag);

      const sendersBtn = document.createElement('button');
      sendersBtn.type = 'button';
      sendersBtn.className = 'ndn-sendersBtn';
      sendersBtn.textContent = 'Pengirim';
      let panel = null;
      sendersBtn.addEventListener('click', async () => {
        if (panel) {
          panel.remove();
          panel = null;
          return;
        }
        panel = document.createElement('div');
        panel.className = 'ndn-senders';
        panel.textContent = 'Memuat pengirim…';
        row.appendChild(panel);
        try {
          const data = await request(`/chats/${encodeURIComponent(chat.id)}/senders`);
          panel.textContent = '';
          if (!data.senders.length) {
            const empty = document.createElement('span');
            empty.textContent = 'Belum ada pengirim tersimpan di grup ini.';
            panel.appendChild(empty);
            return;
          }
          const fields = data.senders.map((sender) => {
            const wrap = document.createElement('div');
            wrap.className = 'ndn-sender';
            const label = document.createElement('span');
            label.textContent = `${sender.shown || '(tanpa nama)'} · ${sender.count} pesan · ${sender.key}`;
            const field = document.createElement('input');
            field.type = 'text';
            field.maxLength = 60;
            field.value = sender.custom || '';
            field.placeholder = sender.shown || 'Nama baru';
            wrap.append(field, label);
            panel.appendChild(wrap);
            return { key: sender.key, field, original: sender.custom || '' };
          });
          const apply = document.createElement('button');
          apply.type = 'button';
          apply.textContent = 'Simpan nama pengirim';
          apply.addEventListener('click', async () => {
            const changed = fields
              .filter((f) => f.field.value.trim() !== f.original)
              .map((f) => ({ key: f.key, name: f.field.value.trim() }));
            if (!changed.length) {
              setStatus('Tidak ada perubahan nama pengirim.');
              return;
            }
            apply.disabled = true;
            apply.textContent = 'Menyimpan…';
            try {
              const res = await request(`/chats/${encodeURIComponent(chat.id)}`, {
                method: 'PATCH',
                body: JSON.stringify({ senders: changed }),
              });
              apply.textContent = 'Tersimpan';
              apply.classList.add('ok');
              setStatus(`${res.renamed} nama pengirim diperbarui.`);
              for (const f of fields) f.original = f.field.value.trim();
            } catch (err) {
              apply.textContent = 'Gagal';
              setStatus(err.message);
              setTimeout(() => {
                apply.textContent = 'Simpan nama pengirim';
                apply.disabled = false;
              }, 1800);
            }
          });
          panel.appendChild(apply);
        } catch (err) {
          panel.textContent = `Gagal memuat: ${err.message}`;
        }
      });
      row.appendChild(sendersBtn);
    }

    rowOf.set(chat.id, { check });
    return row;
  };

  const render = () => {
    const q = searchEl.value.trim().toLowerCase();
    const shown = q
      ? chats.filter(
          (c) =>
            String(c.name || '').toLowerCase().includes(q) ||
            String(c.waJid || '').toLowerCase().includes(q) ||
            String(c.lastPreview || '').toLowerCase().includes(q),
        )
      : chats;
    rowOf.clear();
    list.textContent = '';
    if (!shown.length) {
      const li = document.createElement('li');
      li.className = 'ndn-empty';
      li.textContent = 'Tidak ada chat yang cocok.';
      list.appendChild(li);
      return;
    }
    for (const chat of shown.slice(0, 200)) list.appendChild(buildRow(chat));
    updateDelete();
  };

  allEl.addEventListener('change', () => {
    const q = searchEl.value.trim().toLowerCase();
    const shown = q
      ? chats.filter(
          (c) =>
            String(c.name || '').toLowerCase().includes(q) ||
            String(c.waJid || '').toLowerCase().includes(q) ||
            String(c.lastPreview || '').toLowerCase().includes(q),
        )
      : chats;
    for (const chat of shown.slice(0, 200)) {
      if (allEl.checked) selected.add(chat.id);
      else selected.delete(chat.id);
    }
    render();
  });

  let armed = false;
  let armedTimer = null;
  delEl.addEventListener('click', async () => {
    if (!armed) {      armed = true;
      delEl.classList.add('armed');
      delEl.textContent = `Yakin? Hapus ${selected.size} chat`;
      clearTimeout(armedTimer);
      armedTimer = setTimeout(() => {
        armed = false;
        delEl.classList.remove('armed');
        updateDelete();
      }, 5000);
      return;
    }
    armed = false;
    delEl.classList.remove('armed');
    delEl.disabled = true;
    delEl.textContent = 'Menghapus…';
    try {
      const data = await request('/chats/bulk-delete', {
        method: 'POST',
        body: JSON.stringify({ ids: [...selected], remote: remoteEl.checked }),
      });
      setStatus(`${data.deleted} chat terhapus${data.failed.length ? `, ${data.failed.length} gagal` : ''}.`);
      selected.clear();
      reloadPending = true;
      dialog.close();
    } catch (err) {
      setStatus(err.message);
      updateDelete();
    }
  });

  const open = async () => {
    dialog.showModal();
    setStatus('Memuat chat…');
    try {
      const data = await request('/chats?limit=1000');
      chats = data.chats || [];
      setStatus(`${chats.length} dari ${data.total ?? chats.length} chat.`);
      searchEl.value = '';
      render();
      searchEl.focus();
    } catch (err) {
      setStatus(err.message);
    }
  };

  dialog.addEventListener('close', () => {
    if (reloadPending) location.reload();
  });
  dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
  searchEl.addEventListener('input', render);

  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'ndn-chip';
  chip.textContent = 'Nama & seleksi chat';
  chip.title = 'Ganti nama pengirim / pilih chat (Alt+N)';
  chip.addEventListener('click', open);

  const arm = async () => {
    if (chip.isConnected) return;
    let user = null;
    try {
      user = (await request('/auth/status')).user;
    } catch {
      return;
    }
    if (!user) return;
    isAdmin = user.role === 'admin';
    delEl.hidden = !isAdmin;
    remoteWrap.hidden = !isAdmin;
    document.body.append(chip);
  };

  let queued = false;
  const observer = new MutationObserver(() => {
    if (chip.isConnected || queued) return;
    queued = true;
    setTimeout(() => {
      queued = false;
      arm();
    }, 1200);
  });
  observer.observe(document.body, { childList: true, subtree: true });
  arm();

  window.addEventListener('keydown', (e) => {
    if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      open();
    }
  });
})();
