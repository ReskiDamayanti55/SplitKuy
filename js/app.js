// js/app.js
// Bundle tunggal seluruh logic aplikasi (util, db, calculation, export, UI screens, router).
// Digabung jadi satu file supaya tidak ada risiko satu file script gagal termuat sementara
// yang lain berhasil (mis. cache/race saat dibuka lewat file://). Classic script (bukan ES
// module) supaya tetap jalan saat index.html dibuka langsung lewat file://.

// ===== util.js =====
// js/util.js
// Helper kecil dipakai lintas modul UI (format angka, escape HTML, dsb).
// Classic script (bukan ES module) supaya tetap jalan saat index.html dibuka
// langsung lewat file:// (browser memblokir ES module di file://).

(function () {
  function formatRupiah(amount) {
    const rounded = Math.round(amount || 0);
    const sign = rounded < 0 ? '-' : '';
    const abs = Math.abs(rounded).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    return `${sign}Rp ${abs}`;
  }

  function formatDate(isoString) {
    if (!isoString) return '-';
    const d = new Date(isoString);
    if (Number.isNaN(d.getTime())) return isoString;
    return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML;
  }

  function el(html) {
    const template = document.createElement('template');
    template.innerHTML = html.trim();
    return template.content.firstElementChild;
  }

  window.SplitkuyUtil = { formatRupiah, formatDate, escapeHtml, el };
})();

// ===== db.js =====
// js/db.js
// Wrapper IndexedDB — satu-satunya modul yang boleh menyentuh IndexedDB langsung.
// UI dan calculation engine mengakses data lewat fungsi-fungsi di modul ini.
// Classic script (bukan ES module) supaya tetap jalan saat index.html dibuka
// langsung lewat file:// (browser memblokir ES module di file://).

(function () {

const DB_NAME = 'splitkuy-db';
const DB_VERSION = 1;

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const db = event.target.result;

      if (!db.objectStoreNames.contains('sessions')) {
        db.createObjectStore('sessions', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('people')) {
        const peopleStore = db.createObjectStore('people', { keyPath: 'id' });
        peopleStore.createIndex('sessionId', 'sessionId', { unique: false });
      }
      if (!db.objectStoreNames.contains('receipts')) {
        const receiptsStore = db.createObjectStore('receipts', { keyPath: 'id' });
        receiptsStore.createIndex('sessionId', 'sessionId', { unique: false });
      }
    };

    req.onsuccess = (event) => resolve(event.target.result);
    req.onerror = (event) => reject(event.target.error);
  });
  return dbPromise;
}

function tx(storeName, mode) {
  return openDb().then((db) => db.transaction(storeName, mode).objectStore(storeName));
}

function requestToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function uuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  // fallback sederhana
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// ---------- Sessions ----------

async function createSession(name) {
  const store = await tx('sessions', 'readwrite');
  const session = {
    id: uuid(),
    name,
    createdAt: new Date().toISOString(),
    personIds: [],
  };
  await requestToPromise(store.add(session));
  return session;
}

async function getAllSessions() {
  const store = await tx('sessions', 'readonly');
  const all = await requestToPromise(store.getAll());
  return all.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

async function getSession(id) {
  const store = await tx('sessions', 'readonly');
  return requestToPromise(store.get(id));
}

async function updateSession(session) {
  const store = await tx('sessions', 'readwrite');
  await requestToPromise(store.put(session));
  return session;
}

async function deleteSession(id) {
  const people = await getPeopleBySession(id);
  const receipts = await getReceiptsBySession(id);

  const peopleStore = await tx('people', 'readwrite');
  await Promise.all(people.map((p) => requestToPromise(peopleStore.delete(p.id))));

  const receiptStore = await tx('receipts', 'readwrite');
  await Promise.all(receipts.map((r) => requestToPromise(receiptStore.delete(r.id))));

  const sessionStore = await tx('sessions', 'readwrite');
  await requestToPromise(sessionStore.delete(id));
}

// ---------- People ----------

async function addPerson(sessionId, name) {
  const person = { id: uuid(), sessionId, name };
  const store = await tx('people', 'readwrite');
  await requestToPromise(store.add(person));

  const session = await getSession(sessionId);
  session.personIds.push(person.id);
  await updateSession(session);

  return person;
}

async function getPeopleBySession(sessionId) {
  const store = await tx('people', 'readonly');
  const index = store.index('sessionId');
  return requestToPromise(index.getAll(sessionId));
}

async function updatePerson(person) {
  const store = await tx('people', 'readwrite');
  await requestToPromise(store.put(person));
  return person;
}

async function deletePerson(id, sessionId) {
  const store = await tx('people', 'readwrite');
  await requestToPromise(store.delete(id));

  const session = await getSession(sessionId);
  session.personIds = session.personIds.filter((pid) => pid !== id);
  await updateSession(session);

  // bersihkan referensi orang ini dari semua struk di sesi (payer/participant/item assignment)
  const receipts = await getReceiptsBySession(sessionId);
  for (const receipt of receipts) {
    let changed = false;
    if (receipt.participantIds.includes(id)) {
      receipt.participantIds = receipt.participantIds.filter((pid) => pid !== id);
      changed = true;
    }
    receipt.items.forEach((item) => {
      if (item.assignedPersonIds.includes(id)) {
        item.assignedPersonIds = item.assignedPersonIds.filter((pid) => pid !== id);
        changed = true;
      }
    });
    if (receipt.payerId === id) {
      receipt.payerId = receipt.participantIds[0] || null;
      changed = true;
    }
    if (changed) await updateReceipt(receipt);
  }
}

// ---------- Receipts ----------

async function createReceipt(sessionId, data) {
  const receipt = {
    id: uuid(),
    sessionId,
    name: data.name,
    date: data.date,
    payerId: data.payerId,
    participantIds: data.participantIds,
    items: data.items,
    pp1: data.pp1,
    sc: data.sc,
    discount: data.discount,
  };
  const store = await tx('receipts', 'readwrite');
  await requestToPromise(store.add(receipt));
  return receipt;
}

async function getReceiptsBySession(sessionId) {
  const store = await tx('receipts', 'readonly');
  const index = store.index('sessionId');
  return requestToPromise(index.getAll(sessionId));
}

async function getReceipt(id) {
  const store = await tx('receipts', 'readonly');
  return requestToPromise(store.get(id));
}

async function updateReceipt(receipt) {
  const store = await tx('receipts', 'readwrite');
  await requestToPromise(store.put(receipt));
  return receipt;
}

async function deleteReceipt(id) {
  const store = await tx('receipts', 'readwrite');
  await requestToPromise(store.delete(id));
}

window.SplitkuyDb = {
  uuid,
  createSession,
  getAllSessions,
  getSession,
  updateSession,
  deleteSession,
  addPerson,
  getPeopleBySession,
  updatePerson,
  deletePerson,
  createReceipt,
  getReceiptsBySession,
  getReceipt,
  updateReceipt,
  deleteReceipt,
};

})();

// ===== calculation.js =====
// js/calculation.js
// Mesin kalkulasi: split item per struk + net settlement lintas semua struk dalam satu sesi.
// Lihat §6 dokumen spesifikasi.
// Classic script (bukan ES module) supaya tetap jalan saat index.html dibuka
// langsung lewat file:// (browser memblokir ES module di file://).

(function () {

function resolveAmount(field, subtotalTotal) {
  if (!field) return 0;
  return field.type === 'percent' ? subtotalTotal * (field.value / 100) : field.value;
}

/**
 * Hitung subtotal & total per orang untuk satu struk.
 * FR5: pp1, sc, diskon dibagi RATA per kepala (bukan proporsional ke besar pesanan).
 */
function calculateReceipt(receipt) {
  const participants = receipt.participantIds;
  const personSubtotal = {};
  participants.forEach((id) => (personSubtotal[id] = 0));

  receipt.items.forEach((item) => {
    const itemTotal = item.price * item.qty;
    const assignees = item.assignedPersonIds.filter((pid) => participants.includes(pid));
    if (assignees.length === 0) return;
    const share = itemTotal / assignees.length;
    assignees.forEach((pid) => {
      personSubtotal[pid] += share;
    });
  });

  const subtotalTotal = Object.values(personSubtotal).reduce((a, b) => a + b, 0);

  const pp1Amount = resolveAmount(receipt.pp1, subtotalTotal);
  const scAmount = resolveAmount(receipt.sc, subtotalTotal);
  const discountAmount = resolveAmount(receipt.discount, subtotalTotal);
  const perHeadAdjustment =
    participants.length > 0 ? (pp1Amount + scAmount - discountAmount) / participants.length : 0;

  const personTotal = {};
  participants.forEach((pid) => {
    personTotal[pid] = personSubtotal[pid] + perHeadAdjustment;
  });

  const receiptTotal = Object.values(personTotal).reduce((a, b) => a + b, 0);

  return {
    personSubtotal,
    personTotal,
    subtotalTotal,
    pp1Amount,
    scAmount,
    discountAmount,
    receiptTotal,
  };
}

/**
 * Sederhanakan hutang-piutang jadi transaksi minimal (algoritma greedy, mirip Splitwise).
 */
function simplifyDebts(netBalance) {
  const EPSILON = 0.01;
  const debtors = [];
  const creditors = [];

  Object.entries(netBalance).forEach(([id, amount]) => {
    if (amount < -EPSILON) debtors.push({ id, amount: -amount });
    else if (amount > EPSILON) creditors.push({ id, amount });
  });

  debtors.sort((a, b) => b.amount - a.amount);
  creditors.sort((a, b) => b.amount - a.amount);

  const transactions = [];
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const pay = Math.min(debtors[i].amount, creditors[j].amount);
    if (pay > EPSILON) {
      transactions.push({ from: debtors[i].id, to: creditors[j].id, amount: pay });
    }
    debtors[i].amount -= pay;
    creditors[j].amount -= pay;
    if (debtors[i].amount < EPSILON) i++;
    if (creditors[j].amount < EPSILON) j++;
  }
  return transactions;
}

/**
 * Hitung net settlement lintas semua struk dalam satu sesi.
 * Mengembalikan juga breakdown per orang (total tagihan, sudah dibayar sbg payer, saldo bersih)
 * dan hasil calculateReceipt tiap struk (dipakai UI rekap & export).
 */
function calculateSettlement(session, receipts) {
  const netBalance = {};
  const totalBill = {};
  const paidAsPayer = {};
  session.personIds.forEach((id) => {
    netBalance[id] = 0;
    totalBill[id] = 0;
    paidAsPayer[id] = 0;
  });

  const receiptResults = receipts.map((receipt) => {
    const result = calculateReceipt(receipt);

    if (receipt.payerId && netBalance.hasOwnProperty(receipt.payerId)) {
      netBalance[receipt.payerId] += result.receiptTotal;
      paidAsPayer[receipt.payerId] += result.receiptTotal;
    }

    Object.entries(result.personTotal).forEach(([pid, amount]) => {
      if (!netBalance.hasOwnProperty(pid)) return;
      netBalance[pid] -= amount;
      totalBill[pid] += amount;
    });

    return { receipt, result };
  });

  const transactions = simplifyDebts(netBalance);

  return { netBalance, totalBill, paidAsPayer, transactions, receiptResults };
}

/**
 * Kewajiban transfer per orang berdasarkan payer tiap struk (bukan hasil net/simplify).
 * Untuk tiap struk, siapa pun yang bukan payer wajib transfer sejumlah personTotal-nya
 * ke payer struk itu. Kalau satu orang muncul di beberapa struk dengan payer yang sama,
 * jumlahnya diakumulasi jadi satu baris per payer.
 *
 * Mengembalikan: { [personId]: [{ payerId, amount }, ...] }
 */
function calculatePayerObligations(receipts) {
  const obligations = {};

  receipts.forEach((receipt) => {
    const result = calculateReceipt(receipt);
    Object.entries(result.personTotal).forEach(([pid, amount]) => {
      if (pid === receipt.payerId) return; // payer tidak transfer ke dirinya sendiri
      if (!obligations[pid]) obligations[pid] = {};
      obligations[pid][receipt.payerId] = (obligations[pid][receipt.payerId] || 0) + amount;
    });
  });

  const result = {};
  Object.entries(obligations).forEach(([pid, byPayer]) => {
    result[pid] = Object.entries(byPayer).map(([payerId, amount]) => ({ payerId, amount }));
  });
  return result;
}

window.SplitkuyCalculation = {
  calculateReceipt,
  calculateSettlement,
  calculatePayerObligations,
  simplifyDebts,
  resolveAmount,
};

})();

// ===== export.js =====
// js/export.js
// Generate & download file .xlsx memakai SheetJS (lib/xlsx.full.min.js, dimuat via <script> global `XLSX`).
// Lihat §8 dokumen spesifikasi.
// Classic script (bukan ES module) supaya tetap jalan saat index.html dibuka
// langsung lewat file:// (browser memblokir ES module di file://).

(function () {

function formatPeopleMap(people) {
  const map = {};
  people.forEach((p) => (map[p.id] = p.name));
  return map;
}

function exportSessionToExcel(session, people, receipts, settlement, payerObligations) {
  if (typeof XLSX === 'undefined') {
    throw new Error('Library SheetJS (XLSX) belum termuat.');
  }

  const nameOf = formatPeopleMap(people);
  const wb = XLSX.utils.book_new();
  const collator = new Intl.Collator('id', { numeric: true, sensitivity: 'base' });

  // Sheet 1 — Rekap Per Orang (persis mengikuti kartu di layar Rekap: rincian struk,
  // Total, lalu baris "Transfer ke ..." per orang — bukan tabel settlement terpisah)
  const rekapRows = [['Nama', 'Keterangan', 'Jumlah (Rp)']];
  session.personIds.forEach((pid, idx) => {
    if (idx > 0) rekapRows.push([]);

    const name = nameOf[pid] || pid;
    const perReceipt = settlement.receiptResults
      .filter(({ receipt }) => receipt.participantIds.includes(pid))
      .sort((a, b) => collator.compare(a.receipt.name, b.receipt.name));
    perReceipt.forEach(({ receipt, result }) => {
      rekapRows.push([name, receipt.name, Math.round(result.personTotal[pid] || 0)]);
    });

    rekapRows.push([name, 'Total', Math.round(settlement.totalBill[pid] || 0)]);

    const obligations = (payerObligations[pid] || [])
      .slice()
      .sort((a, b) => collator.compare(nameOf[a.payerId] || '', nameOf[b.payerId] || ''));
    obligations.forEach((o) => {
      rekapRows.push([name, `Transfer ke ${nameOf[o.payerId] || o.payerId}`, Math.round(o.amount)]);
    });
  });
  const wsRekap = XLSX.utils.aoa_to_sheet(rekapRows);
  wsRekap['!cols'] = [{ wch: 20 }, { wch: 26 }, { wch: 16 }];
  XLSX.utils.book_append_sheet(wb, wsRekap, 'Rekap Per Orang');

  // Sheet 2 — Detail Per Struk
  const detailRows = [['Nama Struk', 'Item', 'Harga', 'Qty', 'Dipesan Oleh', 'Share Per Orang (Rp)']];
  settlement.receiptResults.forEach(({ receipt, result }) => {
    receipt.items.forEach((item) => {
      const assignees = item.assignedPersonIds.filter((pid) => receipt.participantIds.includes(pid));
      const share = assignees.length > 0 ? (item.price * item.qty) / assignees.length : 0;
      const assigneeNames = assignees.map((pid) => nameOf[pid] || pid).join(', ');
      detailRows.push([
        receipt.name,
        item.name,
        Math.round(item.price),
        item.qty,
        assigneeNames,
        Math.round(share),
      ]);
    });
    // baris ringkasan pajak/service/diskon per struk
    if (result.pp1Amount) detailRows.push([receipt.name, '(PP1 — dibagi rata per kepala)', '', '', '', Math.round(result.pp1Amount)]);
    if (result.scAmount) detailRows.push([receipt.name, '(Service Charge — dibagi rata per kepala)', '', '', '', Math.round(result.scAmount)]);
    if (result.discountAmount) detailRows.push([receipt.name, '(Diskon — dibagi rata per kepala)', '', '', '', -Math.round(result.discountAmount)]);
  });
  const wsDetail = XLSX.utils.aoa_to_sheet(detailRows);
  wsDetail['!cols'] = [{ wch: 20 }, { wch: 28 }, { wch: 12 }, { wch: 6 }, { wch: 28 }, { wch: 18 }];
  XLSX.utils.book_append_sheet(wb, wsDetail, 'Detail Per Struk');

  const fileName = `${sanitizeFileName(session.name)}-rekap.xlsx`;
  XLSX.writeFile(wb, fileName);
}

function sanitizeFileName(name) {
  return (name || 'splitkuy').trim().replace(/[\\/:*?"<>|]+/g, '-').slice(0, 80) || 'splitkuy';
}

window.SplitkuyExport = { exportSessionToExcel };

})();

// ===== ui/sessionList.js =====
// js/ui/sessionList.js
// Screen: Home — daftar sesi yang pernah dibuat.
// Classic script (bukan ES module) supaya tetap jalan saat index.html dibuka
// langsung lewat file:// (browser memblokir ES module di file://).

(function () {
const db = window.SplitkuyDb;
const { formatDate, escapeHtml } = window.SplitkuyUtil;

async function renderSessionList(app) {
  const sessions = await db.getAllSessions();

  app.innerHTML = `
    <header class="topbar">
      <h1>SplitKuy</h1>
    </header>
    <main class="container">
      <section class="panel">
        <h2 class="section-title">Buat Sesi Baru</h2>
        <form id="new-session-form" class="stack">
          <input type="text" id="new-session-name" placeholder="Nama sesi/acara, mis. Buka Bareng Kantor" required />
          <button type="submit" class="btn btn-primary">+ Buat Sesi</button>
        </form>
      </section>

      <section>
        <h2 class="section-title">Sesi Tersimpan</h2>
        ${
          sessions.length === 0
            ? `<div class="empty-state"><p>Belum ada sesi. Buat sesi baru untuk mulai split bill.</p></div>`
            : `<ul class="card-list" id="session-list">
                ${sessions
                  .map(
                    (s) => `
                  <li class="card" data-id="${s.id}">
                    <a class="card-link" href="#/session/${s.id}">
                      <div class="card-title">${escapeHtml(s.name)}</div>
                      <div class="card-meta">${formatDate(s.createdAt)} · ${s.personIds.length} orang</div>
                    </a>
                    <button class="btn-icon danger" data-action="delete" data-id="${s.id}" title="Hapus sesi" aria-label="Hapus sesi">🗑</button>
                  </li>`
                  )
                  .join('')}
              </ul>`
        }
      </section>
    </main>
  `;

  const form = document.getElementById('new-session-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = document.getElementById('new-session-name');
    const name = input.value.trim();
    if (!name) return;
    const session = await db.createSession(name);
    window.location.hash = `#/session/${session.id}`;
  });

  const list = document.getElementById('session-list');
  if (list) {
    list.addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-action="delete"]');
      if (!btn) return;
      const id = btn.dataset.id;
      const session = sessions.find((s) => s.id === id);
      const ok = window.confirm(`Hapus sesi "${session ? session.name : ''}"? Semua data orang & struk di dalamnya akan ikut terhapus.`);
      if (!ok) return;
      await db.deleteSession(id);
      await renderSessionList(app);
    });
  }
}

window.SplitkuyUi = window.SplitkuyUi || {};
window.SplitkuyUi.renderSessionList = renderSessionList;

})();

// ===== ui/sessionDetail.js =====
// js/ui/sessionDetail.js
// Screen: Detail Sesi — kelola daftar orang & daftar struk.
// Classic script (bukan ES module) supaya tetap jalan saat index.html dibuka
// langsung lewat file:// (browser memblokir ES module di file://).

(function () {
const db = window.SplitkuyDb;
const { formatDate, formatRupiah, escapeHtml } = window.SplitkuyUtil;
const calculation = window.SplitkuyCalculation;

async function renderSessionDetail(app, { sessionId }) {
  const session = await db.getSession(sessionId);
  if (!session) {
    app.innerHTML = `<div class="empty-state"><p>Sesi tidak ditemukan.</p><a class="btn" href="#/">Kembali ke Home</a></div>`;
    return;
  }
  const people = await db.getPeopleBySession(sessionId);
  const receipts = await db.getReceiptsBySession(sessionId);
  const nameOf = {};
  people.forEach((p) => (nameOf[p.id] = p.name));

  app.innerHTML = `
    <header class="topbar">
      <a href="#/" class="back-link" aria-label="Kembali">←</a>
      <h1>${escapeHtml(session.name)}</h1>
    </header>
    <main class="container">
      <section class="panel">
        <h2 class="section-title">Orang (${people.length})</h2>
        <form id="add-person-form" class="stack-row">
          <input type="text" id="new-person-name" placeholder="Nama orang" required />
          <button type="submit" class="btn btn-primary">+ Tambah</button>
        </form>
        ${
          people.length === 0
            ? `<p class="hint">Belum ada orang di sesi ini. Tambahkan minimal 2 orang untuk mulai split.</p>`
            : `<ul class="chip-list" id="person-list">
                ${people
                  .map(
                    (p) => `
                  <li class="chip" data-id="${p.id}">
                    <span class="chip-name" data-id="${p.id}">${escapeHtml(p.name)}</span>
                    <button class="chip-remove" data-action="delete-person" data-id="${p.id}" title="Hapus orang" aria-label="Hapus ${escapeHtml(p.name)}">×</button>
                  </li>`
                  )
                  .join('')}
              </ul>`
        }
      </section>

      <section class="panel">
        <div class="section-header">
          <h2 class="section-title">Struk (${receipts.length})</h2>
          <a class="btn btn-primary btn-sm" href="#/session/${sessionId}/receipt/new">+ Tambah Struk</a>
        </div>
        ${
          receipts.length === 0
            ? `<p class="hint">Belum ada struk. Tambahkan struk untuk mulai menghitung.</p>`
            : `<ul class="card-list" id="receipt-list">
                ${receipts
                  .map((r) => {
                    const result = calculation.calculateReceipt(r);
                    return `
                  <li class="card" data-id="${r.id}">
                    <a class="card-link" href="#/session/${sessionId}/receipt/${r.id}/edit">
                      <div class="card-title">${escapeHtml(r.name || '(Tanpa nama)')}</div>
                      <div class="card-meta">${formatDate(r.date)} · Payer: ${escapeHtml(nameOf[r.payerId] || '-')} · ${formatRupiah(result.receiptTotal)}</div>
                    </a>
                    <button class="btn-icon danger" data-action="delete-receipt" data-id="${r.id}" title="Hapus struk" aria-label="Hapus struk">🗑</button>
                  </li>`;
                  })
                  .join('')}
              </ul>`
        }
      </section>

      <a class="btn btn-secondary btn-block" href="#/session/${sessionId}/summary">📊 Lihat Rekap</a>
    </main>
  `;

  document.getElementById('add-person-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = document.getElementById('new-person-name');
    const name = input.value.trim();
    if (!name) return;
    await db.addPerson(sessionId, name);
    await renderSessionDetail(app, { sessionId });
  });

  const personList = document.getElementById('person-list');
  if (personList) {
    personList.addEventListener('click', async (e) => {
      const removeBtn = e.target.closest('button[data-action="delete-person"]');
      if (removeBtn) {
        const id = removeBtn.dataset.id;
        const person = people.find((p) => p.id === id);
        const ok = window.confirm(`Hapus "${person ? person.name : ''}" dari sesi ini? Orang ini juga akan dihapus dari struk yang sudah ada.`);
        if (!ok) return;
        await db.deletePerson(id, sessionId);
        await renderSessionDetail(app, { sessionId });
        return;
      }
      const nameSpan = e.target.closest('.chip-name');
      if (nameSpan) {
        const id = nameSpan.dataset.id;
        const person = people.find((p) => p.id === id);
        const newName = window.prompt('Ubah nama:', person ? person.name : '');
        if (newName == null) return;
        const trimmed = newName.trim();
        if (!trimmed || !person) return;
        person.name = trimmed;
        await db.updatePerson(person);
        await renderSessionDetail(app, { sessionId });
      }
    });
  }

  const receiptList = document.getElementById('receipt-list');
  if (receiptList) {
    receiptList.addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-action="delete-receipt"]');
      if (!btn) return;
      const id = btn.dataset.id;
      const receipt = receipts.find((r) => r.id === id);
      const ok = window.confirm(`Hapus struk "${receipt ? receipt.name : ''}"?`);
      if (!ok) return;
      await db.deleteReceipt(id);
      await renderSessionDetail(app, { sessionId });
    });
  }
}

window.SplitkuyUi = window.SplitkuyUi || {};
window.SplitkuyUi.renderSessionDetail = renderSessionDetail;

})();

// ===== ui/receiptForm.js =====
// js/ui/receiptForm.js
// Screen: Form Struk — tambah/edit struk, dengan live preview subtotal per orang.
// Classic script (bukan ES module) supaya tetap jalan saat index.html dibuka
// langsung lewat file:// (browser memblokir ES module di file://).

(function () {
const db = window.SplitkuyDb;
const calculation = window.SplitkuyCalculation;
const { formatRupiah, escapeHtml } = window.SplitkuyUtil;

function emptyItem() {
  return { id: db.uuid(), name: '', price: 0, qty: 1, assignedPersonIds: [] };
}

function toIsoDateInputValue(iso) {
  if (!iso) return new Date().toISOString().slice(0, 10);
  return iso.slice(0, 10);
}

async function renderReceiptForm(app, { sessionId, receiptId }) {
  const session = await db.getSession(sessionId);
  if (!session) {
    app.innerHTML = `<div class="empty-state"><p>Sesi tidak ditemukan.</p><a class="btn" href="#/">Kembali ke Home</a></div>`;
    return;
  }
  const people = await db.getPeopleBySession(sessionId);
  const nameOf = {};
  people.forEach((p) => (nameOf[p.id] = p.name));

  let existing = null;
  if (receiptId) {
    existing = await db.getReceipt(receiptId);
  }

  const draft = existing
    ? {
        name: existing.name,
        date: existing.date,
        payerId: existing.payerId,
        participantIds: [...existing.participantIds],
        items: existing.items.map((i) => ({ ...i, assignedPersonIds: [...i.assignedPersonIds] })),
        pp1: { ...existing.pp1 },
        sc: { ...existing.sc },
        discount: { ...existing.discount },
      }
    : {
        name: '',
        date: new Date().toISOString(),
        payerId: people[0] ? people[0].id : null,
        participantIds: people.map((p) => p.id),
        items: [],
        pp1: { type: 'percent', value: 0 },
        sc: { type: 'percent', value: 0 },
        discount: { type: 'percent', value: 0 },
      };

  let errors = [];

  function draftAsReceipt() {
    return {
      participantIds: draft.participantIds,
      items: draft.items,
      pp1: draft.pp1,
      sc: draft.sc,
      discount: draft.discount,
    };
  }

  function adjustWarningText(key) {
    const field = draft[key];
    if (field.type === 'percent' && field.value > 100) {
      return `⚠️ ${field.value}% dari subtotal itu sangat besar — kalau maksudnya nominal Rupiah, klik tombol "Rp".`;
    }
    return '';
  }

  function adjustField(field) {
    const warning = adjustWarningText(field.key);
    return `
      <div class="field-row">
        <label>${field.label}</label>
        <div class="adjust-input">
          <div class="type-toggle" data-field="${field.key}">
            <button type="button" class="toggle-btn ${draft[field.key].type === 'percent' ? 'active' : ''}" data-type="percent">%</button>
            <button type="button" class="toggle-btn ${draft[field.key].type === 'nominal' ? 'active' : ''}" data-type="nominal">Rp</button>
          </div>
          <input type="number" min="0" step="any" class="adjust-value" data-field="${field.key}" value="${draft[field.key].value}" />
        </div>
        <p class="field-warning" id="warning-${field.key}" ${warning ? '' : 'hidden'}>${warning}</p>
      </div>
    `;
  }

  function renderItemsSection() {
    if (draft.items.length === 0) {
      return `<p class="hint">Belum ada item. Tambahkan item struk di bawah.</p>`;
    }
    return draft.items
      .map(
        (item, idx) => `
      <div class="item-row" data-index="${idx}">
        <div class="item-row-top">
          <input type="text" class="item-name" data-index="${idx}" placeholder="Nama item" value="${escapeHtml(item.name)}" />
          <button type="button" class="btn-icon danger" data-action="remove-item" data-index="${idx}" title="Hapus item" aria-label="Hapus item">🗑</button>
        </div>
        <div class="item-row-fields">
          <label class="item-field-label">
            <span>Harga</span>
            <input type="number" class="item-price" data-index="${idx}" placeholder="0" min="0" step="any" value="${item.price || ''}" />
          </label>
          <label class="item-field-label">
            <span>Qty</span>
            <input type="number" class="item-qty" data-index="${idx}" placeholder="1" min="1" step="1" value="${item.qty || 1}" />
          </label>
        </div>
        <div class="item-assign">
          <span class="item-assign-label">Dipesan oleh:</span>
          <div class="assign-checkboxes">
            ${draft.participantIds
              .map(
                (pid) => `
              <label class="assign-chip">
                <input type="checkbox" class="assign-checkbox" data-index="${idx}" data-person-id="${pid}" ${item.assignedPersonIds.includes(pid) ? 'checked' : ''} />
                <span>${escapeHtml(nameOf[pid] || '?')}</span>
              </label>`
              )
              .join('')}
          </div>
        </div>
      </div>
    `
      )
      .join('');
  }

  function renderPreview() {
    if (draft.participantIds.length === 0) {
      return `<p class="hint">Pilih partisipan untuk melihat preview.</p>`;
    }
    const result = calculation.calculateReceipt(draftAsReceipt());
    return `
      <div class="preview-summary">
        <div class="preview-line"><span>Subtotal item</span><span>${formatRupiah(result.subtotalTotal)}</span></div>
        <div class="preview-line"><span>PP1</span><span>${formatRupiah(result.pp1Amount)}</span></div>
        <div class="preview-line"><span>Service Charge</span><span>${formatRupiah(result.scAmount)}</span></div>
        <div class="preview-line"><span>Diskon</span><span>-${formatRupiah(result.discountAmount)}</span></div>
        <div class="preview-line preview-total"><span>Total Struk</span><span>${formatRupiah(result.receiptTotal)}</span></div>
      </div>
      <ul class="preview-people">
        ${draft.participantIds
          .map(
            (pid) => `
          <li><span>${escapeHtml(nameOf[pid] || '?')}</span><span>${formatRupiah(result.personTotal[pid] || 0)}</span></li>`
          )
          .join('')}
      </ul>
    `;
  }

  function renderErrors() {
    if (errors.length === 0) return '';
    return `<div class="error-box">${errors.map((e) => `<div>• ${escapeHtml(e)}</div>`).join('')}</div>`;
  }

  function render() {
    app.innerHTML = `
      <header class="topbar">
        <a href="#/session/${sessionId}" class="back-link" aria-label="Kembali">←</a>
        <h1>${existing ? 'Edit Struk' : 'Struk Baru'}</h1>
      </header>
      <main class="container">
        ${people.length === 0 ? `<div class="empty-state"><p>Belum ada orang di sesi ini. Tambahkan orang dulu di halaman detail sesi.</p><a class="btn" href="#/session/${sessionId}">Kembali ke Detail Sesi</a></div>` : `
        <form id="receipt-form" class="stack">
          ${renderErrors()}

          <section class="panel">
            <div class="field-row">
              <label for="receipt-name">Nama toko / keterangan</label>
              <input type="text" id="receipt-name" value="${escapeHtml(draft.name)}" placeholder="mis. Warung Padang Sederhana" />
            </div>
            <div class="field-row">
              <label for="receipt-date">Tanggal</label>
              <input type="date" id="receipt-date" value="${toIsoDateInputValue(draft.date)}" />
            </div>
            <div class="field-row">
              <label for="payer-select">Payer (bayar duluan)</label>
              <select id="payer-select">
                ${draft.participantIds
                  .map((pid) => `<option value="${pid}" ${draft.payerId === pid ? 'selected' : ''}>${escapeHtml(nameOf[pid] || '?')}</option>`)
                  .join('')}
              </select>
            </div>
          </section>

          <section class="panel">
            <h2 class="section-title">Partisipan Struk Ini</h2>
            <div class="chip-list" id="participant-toggles">
              ${people
                .map(
                  (p) => `
                <label class="assign-chip ${draft.participantIds.includes(p.id) ? 'checked' : ''}">
                  <input type="checkbox" class="participant-checkbox" data-person-id="${p.id}" ${draft.participantIds.includes(p.id) ? 'checked' : ''} />
                  <span>${escapeHtml(p.name)}</span>
                </label>`
                )
                .join('')}
            </div>
          </section>

          <section class="panel">
            <div class="section-header">
              <h2 class="section-title">Item</h2>
              <button type="button" id="add-item-btn" class="btn btn-secondary btn-sm">+ Tambah Item</button>
            </div>
            <div id="items-container">${renderItemsSection()}</div>
          </section>

          <section class="panel">
            <h2 class="section-title">Pajak, Service Charge &amp; Diskon</h2>
            <p class="hint">Dibagi rata per kepala ke semua partisipan struk ini (bukan proporsional).</p>
            ${adjustField({ key: 'pp1', label: 'PP1 (Pajak)' })}
            ${adjustField({ key: 'sc', label: 'Service Charge' })}
            ${adjustField({ key: 'discount', label: 'Diskon' })}
          </section>

          <section class="panel">
            <h2 class="section-title">Live Preview</h2>
            <div id="preview-section">${renderPreview()}</div>
          </section>

          <button type="submit" class="btn btn-primary btn-block">Simpan Struk</button>
        </form>
        `}
      </main>
    `;

    if (people.length === 0) return;
    attachListeners();
  }

  function updatePreviewOnly() {
    const previewEl = document.getElementById('preview-section');
    if (previewEl) previewEl.innerHTML = renderPreview();
  }

  function updateAdjustWarning(key) {
    const warningEl = document.getElementById(`warning-${key}`);
    if (!warningEl) return;
    const text = adjustWarningText(key);
    warningEl.textContent = text;
    warningEl.hidden = !text;
  }

  function attachListeners() {
    const form = document.getElementById('receipt-form');

    document.getElementById('receipt-name').addEventListener('input', (e) => {
      draft.name = e.target.value;
    });
    document.getElementById('receipt-date').addEventListener('input', (e) => {
      draft.date = e.target.value ? new Date(e.target.value).toISOString() : new Date().toISOString();
    });
    document.getElementById('payer-select').addEventListener('change', (e) => {
      draft.payerId = e.target.value;
    });

    document.getElementById('participant-toggles').addEventListener('change', (e) => {
      const cb = e.target.closest('.participant-checkbox');
      if (!cb) return;
      const pid = cb.dataset.personId;
      if (cb.checked) {
        if (!draft.participantIds.includes(pid)) draft.participantIds.push(pid);
      } else {
        draft.participantIds = draft.participantIds.filter((id) => id !== pid);
        // lepaskan assignment orang ini dari semua item
        draft.items.forEach((item) => {
          item.assignedPersonIds = item.assignedPersonIds.filter((id) => id !== pid);
        });
        if (draft.payerId === pid) {
          draft.payerId = draft.participantIds[0] || null;
        }
      }
      render();
    });

    document.getElementById('add-item-btn').addEventListener('click', () => {
      draft.items.push(emptyItem());
      render();
    });

    const itemsContainer = document.getElementById('items-container');
    itemsContainer.addEventListener('click', (e) => {
      const removeBtn = e.target.closest('button[data-action="remove-item"]');
      if (!removeBtn) return;
      const idx = Number(removeBtn.dataset.index);
      draft.items.splice(idx, 1);
      render();
    });
    itemsContainer.addEventListener('input', (e) => {
      const idx = e.target.dataset.index != null ? Number(e.target.dataset.index) : null;
      if (idx == null || !draft.items[idx]) return;
      if (e.target.classList.contains('item-name')) {
        draft.items[idx].name = e.target.value;
      } else if (e.target.classList.contains('item-price')) {
        draft.items[idx].price = parseFloat(e.target.value) || 0;
        updatePreviewOnly();
      } else if (e.target.classList.contains('item-qty')) {
        draft.items[idx].qty = parseInt(e.target.value, 10) || 0;
        updatePreviewOnly();
      }
    });
    itemsContainer.addEventListener('change', (e) => {
      const cb = e.target.closest('.assign-checkbox');
      if (!cb) return;
      const idx = Number(cb.dataset.index);
      const pid = cb.dataset.personId;
      const item = draft.items[idx];
      if (!item) return;
      if (cb.checked) {
        if (!item.assignedPersonIds.includes(pid)) item.assignedPersonIds.push(pid);
      } else {
        item.assignedPersonIds = item.assignedPersonIds.filter((id) => id !== pid);
      }
      updatePreviewOnly();
    });

    ['pp1', 'sc', 'discount'].forEach((key) => {
      const toggle = form.querySelector(`.type-toggle[data-field="${key}"]`);
      toggle.addEventListener('click', (e) => {
        const btn = e.target.closest('.toggle-btn');
        if (!btn) return;
        draft[key].type = btn.dataset.type;
        render();
      });
    });
    form.querySelectorAll('.adjust-value').forEach((input) => {
      input.addEventListener('input', (e) => {
        const key = e.target.dataset.field;
        draft[key].value = parseFloat(e.target.value) || 0;
        updatePreviewOnly();
        updateAdjustWarning(key);
      });
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errors = validate();
      if (errors.length > 0) {
        render();
        window.scrollTo(0, 0);
        return;
      }
      const payload = {
        name: draft.name.trim() || '(Tanpa nama)',
        date: draft.date,
        payerId: draft.payerId,
        participantIds: draft.participantIds,
        items: draft.items.map((i) => ({ ...i, name: i.name.trim() || '(Item)' })),
        pp1: draft.pp1,
        sc: draft.sc,
        discount: draft.discount,
      };
      if (existing) {
        await db.updateReceipt({ ...existing, ...payload });
      } else {
        await db.createReceipt(sessionId, payload);
      }
      window.location.hash = `#/session/${sessionId}`;
    });
  }

  function validate() {
    const errs = [];
    if (!draft.payerId) errs.push('Pilih minimal 1 payer.');
    if (draft.participantIds.length === 0) errs.push('Pilih minimal 1 partisipan.');
    if (draft.payerId && !draft.participantIds.includes(draft.payerId)) {
      errs.push('Payer harus salah satu dari partisipan struk ini.');
    }
    if (draft.items.length === 0) errs.push('Tambahkan minimal 1 item.');
    draft.items.forEach((item, idx) => {
      const label = item.name.trim() || `Item #${idx + 1}`;
      if (!(item.price > 0)) errs.push(`Harga "${label}" harus angka positif.`);
      if (!(item.qty > 0)) errs.push(`Qty "${label}" harus angka positif.`);
      if (item.assignedPersonIds.length === 0) errs.push(`"${label}" belum di-assign ke siapa pun.`);
      const invalidAssignee = item.assignedPersonIds.some((pid) => !draft.participantIds.includes(pid));
      if (invalidAssignee) errs.push(`"${label}" di-assign ke orang yang bukan partisipan struk ini.`);
    });
    return errs;
  }

  render();
}

window.SplitkuyUi = window.SplitkuyUi || {};
window.SplitkuyUi.renderReceiptForm = renderReceiptForm;

})();

// ===== ui/summary.js =====
// js/ui/summary.js
// Screen: Rekap Sesi — total per orang (expandable per struk, dengan kewajiban transfer
// ke payer tiap struk yang diikuti) + export Excel.
// Classic script (bukan ES module) supaya tetap jalan saat index.html dibuka
// langsung lewat file:// (browser memblokir ES module di file://).

(function () {
const db = window.SplitkuyDb;
const calculation = window.SplitkuyCalculation;
const exportExcel = window.SplitkuyExport;
const { formatRupiah, formatDate, escapeHtml } = window.SplitkuyUtil;

async function renderSummary(app, { sessionId }) {
  const session = await db.getSession(sessionId);
  if (!session) {
    app.innerHTML = `<div class="empty-state"><p>Sesi tidak ditemukan.</p><a class="btn" href="#/">Kembali ke Home</a></div>`;
    return;
  }
  const people = await db.getPeopleBySession(sessionId);
  const receipts = await db.getReceiptsBySession(sessionId);
  const nameOf = {};
  people.forEach((p) => (nameOf[p.id] = p.name));

  if (people.length === 0 || receipts.length === 0) {
    app.innerHTML = `
      <header class="topbar">
        <a href="#/session/${sessionId}" class="back-link" aria-label="Kembali">←</a>
        <h1>Rekap — ${escapeHtml(session.name)}</h1>
      </header>
      <main class="container">
        <div class="empty-state"><p>Belum cukup data untuk rekap. Pastikan ada orang dan minimal 1 struk.</p></div>
      </main>
    `;
    return;
  }

  const settlement = calculation.calculateSettlement(session, receipts);
  const payerObligations = calculation.calculatePayerObligations(receipts);
  const collator = new Intl.Collator('id', { numeric: true, sensitivity: 'base' });

  app.innerHTML = `
    <header class="topbar">
      <a href="#/session/${sessionId}" class="back-link" aria-label="Kembali">←</a>
      <h1>Rekap — ${escapeHtml(session.name)}</h1>
    </header>
    <main class="container">
      <section class="panel">
        <h2 class="section-title">Total Per Orang</h2>
        <ul class="summary-people" id="summary-people">
          ${session.personIds
            .map((pid) => {
              const perReceipt = settlement.receiptResults
                .filter(({ receipt }) => receipt.participantIds.includes(pid))
                .sort((a, b) => collator.compare(a.receipt.name, b.receipt.name));
              const myObligations = (payerObligations[pid] || []).sort((a, b) =>
                collator.compare(nameOf[a.payerId] || '', nameOf[b.payerId] || '')
              );
              return `
              <li class="summary-person" data-id="${pid}">
                <button type="button" class="summary-person-toggle" data-id="${pid}">
                  <span class="summary-person-name">${escapeHtml(nameOf[pid] || '?')}</span>
                  <span class="summary-person-total">${formatRupiah(settlement.totalBill[pid] || 0)}</span>
                  <span class="chevron">▾</span>
                </button>
                <div class="summary-person-detail" id="detail-${pid}" hidden>
                  ${
                    perReceipt.length === 0
                      ? `<p class="hint">Tidak ikut struk manapun.</p>`
                      : `<ul class="detail-list">
                        ${perReceipt
                          .map(
                            ({ receipt, result }) => `
                          <li><span>${escapeHtml(receipt.name)}</span><span>${formatRupiah(result.personTotal[pid] || 0)}</span></li>`
                          )
                          .join('')}
                      </ul>`
                  }
                  <div class="detail-line"><span>Total</span><span>${formatRupiah(settlement.totalBill[pid] || 0)}</span></div>
                  ${myObligations
                    .map(
                      (o) => `
                  <div class="detail-line"><span>Transfer ke ${escapeHtml(nameOf[o.payerId] || o.payerId)}</span><span class="negative">${formatRupiah(o.amount)}</span></div>`
                    )
                    .join('')}
                </div>
              </li>`;
            })
            .join('')}
        </ul>
      </section>

      <button type="button" id="export-btn" class="btn btn-primary btn-block">⬇ Export Excel</button>
      <p class="hint" id="export-status" role="status"></p>
    </main>
  `;

  document.getElementById('summary-people').addEventListener('click', (e) => {
    const toggle = e.target.closest('.summary-person-toggle');
    if (!toggle) return;
    const id = toggle.dataset.id;
    const detail = document.getElementById(`detail-${id}`);
    const isHidden = detail.hasAttribute('hidden');
    if (isHidden) detail.removeAttribute('hidden');
    else detail.setAttribute('hidden', '');
    toggle.classList.toggle('expanded', isHidden);
  });

  document.getElementById('export-btn').addEventListener('click', () => {
    const statusEl = document.getElementById('export-status');
    try {
      exportExcel.exportSessionToExcel(session, people, receipts, settlement, payerObligations);
      statusEl.textContent = `File Excel berhasil dibuat: ${formatDate(new Date().toISOString())}.`;
    } catch (err) {
      console.error(err);
      statusEl.textContent = `Gagal export: ${err.message || err}`;
    }
  });
}

window.SplitkuyUi = window.SplitkuyUi || {};
window.SplitkuyUi.renderSummary = renderSummary;

})();

// ===== router + bootstrap =====
// Classic script (bukan ES module) supaya tetap jalan saat index.html dibuka
// langsung lewat file:// (browser memblokir ES module di file://).

(function () {
const { renderSessionList, renderSessionDetail, renderReceiptForm, renderSummary } = window.SplitkuyUi;

const app = document.getElementById('app');

function parseHash() {
  const hash = window.location.hash.replace(/^#\/?/, '');
  const parts = hash.split('/').filter(Boolean);
  return parts;
}

async function router() {
  const parts = parseHash();
  window.scrollTo(0, 0);

  try {
    if (parts.length === 0) {
      await renderSessionList(app);
      return;
    }

    if (parts[0] === 'session' && parts[1]) {
      const sessionId = parts[1];

      if (parts[2] === 'receipt' && parts[3] === 'new') {
        await renderReceiptForm(app, { sessionId, receiptId: null });
        return;
      }
      if (parts[2] === 'receipt' && parts[3] && parts[4] === 'edit') {
        await renderReceiptForm(app, { sessionId, receiptId: parts[3] });
        return;
      }
      if (parts[2] === 'summary') {
        await renderSummary(app, { sessionId });
        return;
      }
      if (!parts[2]) {
        await renderSessionDetail(app, { sessionId });
        return;
      }
    }

    // fallback: rute tidak dikenal
    app.innerHTML = `<div class="empty-state"><p>Halaman tidak ditemukan.</p><a class="btn" href="#/">Kembali ke Home</a></div>`;
  } catch (err) {
    console.error(err);
    app.innerHTML = `<div class="empty-state"><p>Terjadi kesalahan: ${escapeHtml(err.message || String(err))}</p><a class="btn" href="#/">Kembali ke Home</a></div>`;
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

window.addEventListener('hashchange', router);
window.addEventListener('DOMContentLoaded', router);
router();

// ---------- Service worker registration ----------
// Diabaikan otomatis saat dibuka lewat file:// (SW butuh http/https), sw.js hanya
// aktif setelah aplikasi dijalankan lewat server/hosting.
if ('serviceWorker' in navigator && window.location.protocol !== 'file:') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => {
      console.warn('Gagal mendaftarkan service worker:', err);
    });
  });
}

// ---------- Install App banner ----------
// Browser tidak selalu menampilkan prompt install secara otomatis (Chrome punya
// heuristik engagement sendiri, dan iOS Safari tidak pernah menyediakan prompt
// otomatis sama sekali) — jadi kita sediakan tombol/instruksi install sendiri.
(function setupInstallBanner() {
  const DISMISS_KEY = 'splitkuy-install-dismissed';
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;

  function isStandalone() {
    return (
      window.matchMedia('(display-mode: standalone)').matches ||
      window.navigator.standalone === true
    );
  }

  if (isStandalone()) return; // sudah ter-install, tidak perlu tawarkan lagi
  let dismissed = false;
  try {
    dismissed = localStorage.getItem(DISMISS_KEY) === '1';
  } catch (e) {
    // localStorage bisa gagal (mode private dsb) — anggap belum di-dismiss
  }
  if (dismissed) return;

  let deferredPrompt = null;
  let banner = null;

  function ensureBanner() {
    if (banner) return banner;
    banner = document.createElement('div');
    banner.className = 'install-banner';
    banner.hidden = true;
    banner.innerHTML = `
      <span class="install-banner-text"></span>
      <button type="button" class="install-banner-btn" hidden>Install</button>
      <button type="button" class="install-banner-close" aria-label="Tutup">×</button>
    `;
    document.body.appendChild(banner);

    banner.querySelector('.install-banner-close').addEventListener('click', () => {
      banner.hidden = true;
      try {
        localStorage.setItem(DISMISS_KEY, '1');
      } catch (e) {
        // abaikan kalau localStorage tidak tersedia
      }
    });

    banner.querySelector('.install-banner-btn').addEventListener('click', async () => {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      deferredPrompt = null;
      banner.hidden = true;
    });

    return banner;
  }

  function showBanner(text, withInstallButton) {
    const el = ensureBanner();
    el.querySelector('.install-banner-text').textContent = text;
    el.querySelector('.install-banner-btn').hidden = !withInstallButton;
    el.hidden = false;
  }

  // Chrome/Edge/Android: tangkap event bawaan, tampilkan tombol "Install" kita sendiri.
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredPrompt = event;
    showBanner('Install SplitKuy ke HP/laptop kamu biar gampang dibuka.', true);
  });

  window.addEventListener('appinstalled', () => {
    if (banner) banner.hidden = true;
    deferredPrompt = null;
  });

  // iOS Safari: tidak ada beforeinstallprompt sama sekali, kasih instruksi manual.
  if (isIos) {
    showBanner('Tap tombol Share (kotak + panah ke atas), lalu pilih "Add to Home Screen" untuk install.', false);
  }
})();

})();
